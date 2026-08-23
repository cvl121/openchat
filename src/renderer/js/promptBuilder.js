// Assembles character card data, world info, and chat history into an LLM
// messages array. Assembly order:
//   system prompt → description → personality → scenario → persona →
//   constant lore (character book + world info) → few-shot examples →
//   summary → keyword-triggered lore → chat history →
//   reminder prompt → post-history instructions
//
// Constant lore lives in the leading system message; keyword-triggered lore
// gets its own system message after the summary. Keeping the per-turn-variable
// parts out of the leading message leaves a byte-identical prefix across
// turns, which is what provider prompt caching keys on — and it puts the
// triggered lore closer to the live conversation, where models weight it more.

import { replaceTemplateVars, estimateTokens } from './util.js';
import { isImagePlaceholder } from './imageFlow.js';

// Extra turns a triggered lore entry stays active after its keywords scroll
// out of scan range (per-entry `sticky` overrides). Hysteresis keeps mid-scene
// lore from vanishing the moment its keyword ages out, and stabilizes the
// prompt across turns for provider caching.
const DEFAULT_STICKY = 2;
// Triggered lore may fill at most this share of the context window; overflow
// is dropped lowest-priority-first so lore can never crowd out live history.
const LORE_BUDGET_FRACTION = 0.25;
// Rough per-image token cost — attached images are far from free, and
// counting them as zero lets multimodal prompts overflow the window.
export const IMAGE_TOKENS = 1000;

/** Prompt cost of one message: text plus any attached images. */
function tokensOf(m) {
  return estimateTokens(m.content) + (m.images?.length ?? 0) * IMAGE_TOKENS;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whole-word regex for a keyword, memoized per needle — books can carry
 * thousands of keys and this runs on every send. \b is only meaningful next
 * to ASCII word characters, so it is applied per edge — keys with CJK or
 * punctuation edges fall back to plain substring matching on that edge (a
 * fully-CJK key degrades to exact substring, which is right for CJK).
 */
const wordReCache = new Map();
function wordRe(needle) {
  let re = wordReCache.get(needle);
  if (!re) {
    const lead = /^[A-Za-z0-9_]/.test(needle) ? '\\b' : '';
    const trail = /[A-Za-z0-9_]$/.test(needle) ? '\\b' : '';
    re = new RegExp(lead + escapeRe(needle) + trail);
    if (wordReCache.size < 10000) wordReCache.set(needle, re);
  }
  return re;
}

/** scan = {raw, lower} — lowered once per scan text, not once per entry. */
function keywordMatches(entry, scan) {
  const caseSensitive = entry.case_sensitive ?? false;
  const whole = (entry.match_whole_words ?? entry.extensions?.match_whole_words) === true;
  const haystack = caseSensitive ? scan.raw : scan.lower;
  const hit = (key) => {
    const needle = caseSensitive ? key : key.toLowerCase();
    if (!needle) return false;
    return whole ? wordRe(needle).test(haystack) : haystack.includes(needle);
  };
  if (!(entry.keys ?? []).some(hit)) return false;
  // Selective entries (SillyTavern) additionally require a secondary keyword
  const secondary = entry.secondary_keys ?? entry.keysecondary ?? [];
  if (entry.selective && secondary.length) {
    return secondary.some(hit);
  }
  return true;
}

/**
 * Build the full message array for an LLM API call.
 * When contextSize > 0, oldest history messages are dropped so the prompt
 * plus the model's response fits the context window (rough chars/4 estimate),
 * and triggered lore competes under a budget (LORE_BUDGET_FRACTION).
 * Pass a `stats` object to receive
 * { promptTokens, trimmedCount, loreDropped, overflowTokens }.
 * @returns [{role: 'system'|'user'|'assistant', content}]
 */
export function buildMessages({
  character, // TavernCardV2 .data
  chatHistory, // [{name, is_user, is_system, mes, ...}]
  userName,
  systemPromptOverride = '',
  worldInfoEntries = [],
  persona = null,
  reminderPrompt = '',
  authorsNote = '', // per-chat note injected `authorsNoteDepth` messages from the end
  authorsNoteDepth = 4,
  summary = '', // compressed earlier conversation (chatHistory should already exclude it)
  contextSize = 0, // 0 = no trimming
  maxResponseTokens = 0,
  stats = {},
}) {
  const charName = character.name;
  const vars = (text) => replaceTemplateVars(text ?? '', charName, userName);
  const messages = [];

  // 1. System prompt
  const sysPrompt = vars(systemPromptOverride || character.system_prompt);
  let systemContent = sysPrompt || `You are ${charName}.`;

  // 2–4. Description, personality, scenario
  const description = vars(character.description);
  if (description) systemContent += `\n\n${charName}'s description: ${description}`;
  const personality = vars(character.personality);
  if (personality) systemContent += `\n${charName}'s personality: ${personality}`;
  const scenario = vars(character.scenario);
  if (scenario) systemContent += `\nScenario: ${scenario}`;

  // 5. Persona description
  if (persona?.description) {
    systemContent += `\n\n${userName}'s description: ${persona.description}`;
  }

  // Keyword scans read the recent messages plus the compression summary —
  // entities that only appear by name in compressed history are still live
  // conversation state, so their lore must keep triggering.
  const scanCache = new Map();
  const scanText = (depth) => {
    if (!scanCache.has(depth)) {
      const raw =
        (summary ? `${summary} ` : '') +
        chatHistory
          .slice(-depth)
          .map((m) => m.mes ?? '')
          .join(' ');
      scanCache.set(depth, { raw, lower: raw.toLowerCase() });
    }
    return scanCache.get(depth);
  };
  // Sticky widens the scan window per entry: a keyword last seen up to
  // `sticky` messages beyond the base depth still keeps the entry active.
  const scanDepthFor = (entry, base) =>
    base + Math.max(0, entry.sticky ?? entry.extensions?.sticky ?? DEFAULT_STICKY);
  const triggeredLore = [];

  // 6. Character book (embedded lore): constant entries stay in the leading
  // system message; keyword-triggered ones are collected for later injection.
  const book = character.character_book;
  if (book?.entries?.length) {
    const baseDepth = book.scan_depth ?? 10;
    const entries = [...book.entries].sort(
      (a, b) => (a.insertion_order ?? 100) - (b.insertion_order ?? 100)
    );
    for (const entry of entries) {
      if (entry.enabled === false) continue;
      if (entry.constant) systemContent += `\n\n${vars(entry.content)}`;
      else if (keywordMatches(entry, scanText(scanDepthFor(entry, baseDepth)))) {
        triggeredLore.push(vars(entry.content));
      }
    }
  }

  // 7–8. World info: same split — constant entries here, triggered ones collected
  const enabled = worldInfoEntries.filter((e) => e.enabled !== false);
  const byOrder = (a, b) => (a.insertion_order ?? 100) - (b.insertion_order ?? 100);
  for (const entry of enabled.filter((e) => e.constant).sort(byOrder)) {
    systemContent += `\n\n${vars(entry.content)}`;
  }
  for (const entry of enabled
    .filter((e) => !e.constant && keywordMatches(e, scanText(scanDepthFor(e, 10))))
    .sort(byOrder)) {
    triggeredLore.push(vars(entry.content));
  }

  messages.push({ role: 'system', content: systemContent });

  // 9. Example messages as few-shot
  const mesExample = vars(character.mes_example);
  if (mesExample) {
    messages.push(...parseExampleMessages(mesExample, charName, userName));
  }

  // 9b. Compressed earlier conversation (chat compression feature)
  if (summary) {
    messages.push({
      role: 'system',
      content: `Summary of the conversation so far (older messages were compressed to save context):\n${vars(summary)}`,
    });
  }

  // 9c. Keyword-triggered lore, after the summary (which changes rarely) and
  // right before the history it relates to. Capped at a share of the context
  // window: entries are admitted in insertion order (character book first),
  // and one that doesn't fit is skipped so smaller lower-priority entries can
  // still use the remaining budget.
  let loreDropped = 0;
  if (triggeredLore.length) {
    let keptLore = triggeredLore;
    if (contextSize > 0) {
      let loreBudget = Math.floor(contextSize * LORE_BUDGET_FRACTION);
      keptLore = [];
      for (const content of triggeredLore) {
        const cost = estimateTokens(content);
        if (cost > loreBudget) {
          loreDropped++;
          continue;
        }
        loreBudget -= cost;
        keptLore.push(content);
      }
    }
    if (keptLore.length) {
      messages.push({
        role: 'system',
        content: `Relevant world information:\n\n${keptLore.join('\n\n')}`,
      });
    }
  }

  // 10–11. Chat history (skip system/meta messages), trimmed to the context
  // window. Fixed parts (system prompt, examples, reminder, post-history) are
  // always kept; the oldest history messages are dropped first, and the most
  // recent message is kept no matter what.
  let history = [];
  for (const message of chatHistory) {
    if (message.is_system) continue;
    let content = vars(message.mes);
    // Resolved attachments (see chat.js): images ride along as data URLs for
    // multimodal providers; text files are inlined; other files by name only.
    const images = [];
    for (const a of message._attachments ?? []) {
      if (a.kind === 'image' && a.dataURL) images.push(a.dataURL);
      else if (a.kind === 'text' && a.text != null) content += `\n\n[Attached file: ${a.name}]\n${a.text}`;
      else content += `\n\n[Attached file: ${a.name}]`;
    }
    // A bare "<image>" with no actual image is a failed image turn (a model
    // placeholder token). Resending it teaches the next model to answer the
    // same way — drop it from the prompt.
    if (!images.length && isImagePlaceholder(content)) continue;
    if (content || images.length) {
      history.push({
        role: message.is_user ? 'user' : 'assistant',
        content,
        ...(images.length ? { images } : {}),
      });
    }
  }
  const reminder = reminderPrompt ? vars(reminderPrompt) : '';
  const note = authorsNote ? vars(authorsNote) : '';
  const postInstructions = vars(character.post_history_instructions);
  let trimmedCount = 0;
  let overflowTokens = 0;
  if (contextSize > 0) {
    const fixedTokens =
      messages.reduce((sum, m) => sum + tokensOf(m), 0) +
      estimateTokens(reminder) +
      estimateTokens(note) +
      estimateTokens(postInstructions);
    let budget = contextSize - maxResponseTokens - fixedTokens;
    const kept = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const cost = tokensOf(history[i]);
      if (kept.length && budget < cost) break;
      budget -= cost;
      kept.unshift(history[i]);
    }
    trimmedCount = history.length - kept.length;
    history = kept;
    // Negative leftover means the fixed parts plus the newest message alone
    // exceed the window — the request will likely be rejected or truncated.
    if (budget < 0) overflowTokens = -budget;
  }
  messages.push(...history);

  // 11b. Author's note: injected N messages from the end (SillyTavern convention)
  if (note) {
    const depth = Math.max(0, Math.min(authorsNoteDepth ?? 4, history.length));
    messages.splice(messages.length - depth, 0, { role: 'system', content: note });
  }

  // 12. Reminder prompt near the end (reinforces style in long chats)
  if (reminder) {
    messages.push({ role: 'system', content: reminder });
  }

  // 13. Post-history instructions
  if (postInstructions) {
    messages.push({ role: 'system', content: postInstructions });
  }

  stats.trimmedCount = trimmedCount;
  stats.loreDropped = loreDropped;
  stats.overflowTokens = overflowTokens;
  stats.promptTokens = messages.reduce((sum, m) => sum + tokensOf(m), 0);
  return messages;
}

/** Parse SillyTavern-format example dialogue ("<START>", "{{user}}: ...", "{{char}}: ...") */
export function parseExampleMessages(example, charName, userName) {
  const messages = [];
  const lines = example
    .replaceAll('<START>', '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const userPrefixes = [`${userName}:`, '{{user}}:'];
    const charPrefixes = [`${charName}:`, '{{char}}:'];
    const userPrefix = userPrefixes.find((p) => line.startsWith(p));
    const charPrefix = charPrefixes.find((p) => line.startsWith(p));
    if (userPrefix) {
      messages.push({ role: 'user', content: line.slice(userPrefix.length).trim() });
    } else if (charPrefix) {
      messages.push({ role: 'assistant', content: line.slice(charPrefix.length).trim() });
    }
  }
  return messages;
}

/** Collect world info entries that apply to a character (global books + assigned books). */
export function applicableWorldEntries(worldBooks, characterFilename) {
  const entries = [];
  for (const book of worldBooks) {
    if (book.global || (book.assignedCharacters ?? []).includes(characterFilename)) {
      entries.push(...(book.entries ?? []));
    }
  }
  return entries;
}
