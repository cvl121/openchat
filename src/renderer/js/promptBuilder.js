// Assembles character card data, world info, and chat history into an LLM
// messages array. Assembly order:
//   system prompt → description → personality → scenario → persona →
//   character book entries → world info → few-shot examples → chat history →
//   reminder prompt → post-history instructions

import { replaceTemplateVars, estimateTokens } from './util.js';

function keywordMatches(entry, recentText) {
  const caseSensitive = entry.case_sensitive ?? false;
  const haystack = caseSensitive ? recentText : recentText.toLowerCase();
  return (entry.keys ?? []).some((key) => {
    const needle = caseSensitive ? key : key.toLowerCase();
    return needle && haystack.includes(needle);
  });
}

/**
 * Build the full message array for an LLM API call.
 * When contextSize > 0, oldest history messages are dropped so the prompt
 * plus the model's response fits the context window (rough chars/4 estimate).
 * Pass a `stats` object to receive { promptTokens, trimmedCount }.
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

  // 6. Character book (embedded lore): constant entries + keyword-triggered
  const book = character.character_book;
  if (book?.entries?.length) {
    const scanDepth = book.scan_depth ?? 10;
    const recentText = chatHistory
      .slice(-scanDepth)
      .map((m) => m.mes ?? '')
      .join(' ');
    const entries = [...book.entries].sort(
      (a, b) => (a.insertion_order ?? 100) - (b.insertion_order ?? 100)
    );
    for (const entry of entries) {
      if (entry.enabled === false) continue;
      if (entry.constant || keywordMatches(entry, recentText)) {
        systemContent += `\n\n${vars(entry.content)}`;
      }
    }
  }

  // 7–8. World info: constant entries, then keyword-triggered (scan last 10 messages)
  const recentText = chatHistory
    .slice(-10)
    .map((m) => m.mes ?? '')
    .join(' ');
  const enabled = worldInfoEntries.filter((e) => e.enabled !== false);
  const byOrder = (a, b) => (a.insertion_order ?? 100) - (b.insertion_order ?? 100);
  for (const entry of enabled.filter((e) => e.constant).sort(byOrder)) {
    systemContent += `\n\n${vars(entry.content)}`;
  }
  for (const entry of enabled
    .filter((e) => !e.constant && keywordMatches(e, recentText))
    .sort(byOrder)) {
    systemContent += `\n\n${vars(entry.content)}`;
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
    if (content || images.length) {
      history.push({
        role: message.is_user ? 'user' : 'assistant',
        content,
        ...(images.length ? { images } : {}),
      });
    }
  }
  const reminder = reminderPrompt ? vars(reminderPrompt) : '';
  const postInstructions = vars(character.post_history_instructions);
  let trimmedCount = 0;
  if (contextSize > 0) {
    const fixedTokens =
      messages.reduce((sum, m) => sum + estimateTokens(m.content), 0) +
      estimateTokens(reminder) +
      estimateTokens(postInstructions);
    let budget = contextSize - maxResponseTokens - fixedTokens;
    const kept = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const cost = estimateTokens(history[i].content);
      if (kept.length && budget < cost) break;
      budget -= cost;
      kept.unshift(history[i]);
    }
    trimmedCount = history.length - kept.length;
    history = kept;
  }
  messages.push(...history);

  // 12. Reminder prompt near the end (reinforces style in long chats)
  if (reminder) {
    messages.push({ role: 'system', content: reminder });
  }

  // 13. Post-history instructions
  if (postInstructions) {
    messages.push({ role: 'system', content: postInstructions });
  }

  stats.trimmedCount = trimmedCount;
  stats.promptTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
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
