// Chat view: message list, streaming generation, swipes, editing, history,
// search, and export.

import { el, clear, uuid, nowISO, formatTime, toast, modal, confirmDialog, escapeHtml, formatUSD, formatModelPricing, estimateTokens, IS_MAC } from '../util.js';
import { renderMarkdown } from '../markdown.js';
import { buildMessages, applicableWorldEntries } from '../promptBuilder.js';
import {
  state,
  apiConfig,
  activePersona,
  userName,
  avatarURL,
  personaAvatarURL,
  devLog,
  pushUndo,
  popUndo,
  scheduleSettingsSave,
  PROVIDERS,
  isChatMode,
  chatSystemPrompt,
  ASSISTANT_CHARACTER,
  DEFAULT_COMPRESSION_PROMPT,
  imageApiConfig,
  convKey,
  runFor,
  runForChat,
  isCurrentChatGenerating,
  markUnread,
  clearUnread,
  isUnread,
  rememberModelContext,
  knownModelContext,
  rememberModelPricing,
  knownModelPricing,
} from '../state.js';
import { avatar, streamingDots, iconBtn } from '../components.js';
import { imageFollowupAction, decorateModelError, imageHintMessage } from '../imageFlow.js';
import { t, currentLocale } from '../../../shared/i18n.js';
import { foldText, truncateChars } from '../../../shared/text.js';

const ASSISTANT_NAME = ASSISTANT_CHARACTER.card.data.name;

let cb = {}; // { renderSidebar, navigate, editCharacter }
let streamingMsgEl = null; // content element receiving chunks
// Unsent input, kept per conversation so switching away and back never loses
// a draft (and never leaks one into another conversation). In-memory only.
const chatDrafts = new Map(); // convKey -> {value, selStart, selEnd}
let renderedDraftKey = null; // conversation the live #chat-input belongs to
function stashDraft(key, input) {
  if (input.value) chatDrafts.set(key, { value: input.value, selStart: input.selectionStart, selEnd: input.selectionEnd });
  else chatDrafts.delete(key);
}
// Whether the view is anchored to the newest message. Distinct from a "near
// bottom" proximity check: an attachment image finishing its async load can
// grow a message by hundreds of pixels, leaving the viewport far from the
// bottom even though the user never scrolled away — intent has to be tracked,
// not inferred from distance. Cleared only by the user scrolling up.
let followingBottom = true;
// Windowed message rendering (huge-chat support): how many of the newest
// messages get DOM nodes up front, and how many more per scroll-up expansion.
const RENDER_WINDOW = 150;
const RENDER_BATCH = 150;
let renderWindowStart = Infinity; // first rendered index; shrinks as the user scrolls up
let renderWindowConv = null; // window resets when the conversation changes
let messagesResizeObserver = null; // re-anchors on message growth while following
// Stop reasons that mean "truncated by the max-tokens limit" per provider
const LENGTH_REASONS = new Set(['length', 'max_tokens', 'MAX_TOKENS']);
const newMessages = new WeakSet(); // messages not yet on disk → append instead of rewrite
const reroutedMessages = new WeakSet(); // placeholder responses already re-routed to the image model — never loop

// Per-conversation notices (error banner, finish reason, trimmed count, 🎨
// config for Retry), keyed by convKey. A background run's error must not
// bleed into the conversation on screen; it surfaces when its own
// conversation is opened.
const chatNotices = new Map(); // convKey -> {error, finishReason, trimmed, configOverride}

function setNotice(charName, file, patch) {
  const key = convKey(charName, file);
  chatNotices.set(key, { ...(chatNotices.get(key) ?? {}), ...patch });
}

function currentNotice() {
  if (!state.currentChat || !state.selectedCharacter) return {};
  return chatNotices.get(convKey(state.selectedCharacter.card.data.name, state.currentChat.file)) ?? {};
}
// 🎨 toggle, per conversation: while on, Send routes prompts to the image model
const imageModes = new Map(); // convKey -> true
function currentConvKey() {
  if (!state.currentChat || !state.selectedCharacter) return null;
  return convKey(state.selectedCharacter.card.data.name, state.currentChat.file);
}
function isImageMode() {
  const key = currentConvKey();
  return key != null && imageModes.get(key) === true;
}
let impersonatingKey = null; // convKey whose impersonate draft is being generated
// Keyboard-shortcut hints: ⌘ on macOS, Ctrl+ elsewhere (mirrors sidebar.js)
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
// Monotonic selection token: async chat/character switches bail out when a
// newer selection started while they were awaiting.
let selectionSeq = 0;
/** An inline message edit is open — a full renderChat() would discard it. */
function inlineEditOpen() {
  return !!document.querySelector('#messages .msg-edit-area');
}
/** Update the toolbar title without a rebuild (used while an edit is open). */
function updateChatTitleInPlace(title) {
  const titleEl = document.querySelector('#chat-root .chat-title');
  if (!titleEl) return;
  for (const node of titleEl.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      node.textContent = title;
      return;
    }
  }
}
let pendingAttachments = []; // uploads staged in the input bar, sent with the next message
// Prompt-ready upload contents, LRU-capped: image entries are base64 data
// URLs that can run tens of MB each, so an unbounded cache leaks memory over
// a long session. Map iteration order doubles as recency (see resolveAttachments).
const resolvedUploads = new Map(); // upload file -> {kind, dataURL?|text?} for prompt building
const RESOLVED_UPLOADS_MAX = 32;

let renderQueued = false;

// renderChat rebuilds the full message list on every interaction, but most
// messages are unchanged between rebuilds — cache their rendered markdown and
// token estimate per message object so long chats don't re-run the parser
// (and the CJK token scan) for every message on every click.
let renderCache = new WeakMap(); // msg -> { mes, html?, tokens? }

/** Cached HTML embeds localized text (code copy-buttons) — drop it on locale change. */
export function clearRenderCache() {
  renderCache = new WeakMap();
}

function cacheFor(msg) {
  let entry = renderCache.get(msg);
  if (!entry || entry.mes !== msg.mes) {
    entry = { mes: msg.mes };
    renderCache.set(msg, entry);
  }
  return entry;
}

// Placeholder heights for offscreen messages (content-visibility: auto).
// A flat 90px placeholder made the scrollbar stutter on long chats: each
// message scrolled into view for the first time snapped from 90px to its
// real height, scrollHeight jumped, and the thumb fought scroll anchoring.
// Estimating from the text length lands close enough that the correction is
// a few pixels, and measured heights are remembered across re-renders.
const MSG_CHROME_PX = 60; // header + bubble padding + gap
let heightModel = { charsPerLine: 100, linePx: 21.7 };
function updateHeightModel(main) {
  const fontPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chat-font-size')) || 14;
  // .msg is capped at 880px; minus avatar, gap, bubble padding and #messages padding
  const width = Math.min(880, (main?.clientWidth || 880) - 36) - 34 - 10 - 26;
  heightModel = { charsPerLine: Math.max(20, width / (fontPx * 0.46)), linePx: fontPx * 1.55 };
}
function estimateHeight(msg) {
  const measured = cacheFor(msg).height;
  if (measured) return measured;
  let lines = 0;
  for (const para of String(msg.mes ?? '').split('\n')) {
    lines += Math.max(1, Math.ceil(para.length / heightModel.charsPerLine));
  }
  const images = msg.extra?.attachments?.length ? 160 : 0;
  return Math.round(Math.max(1, lines) * heightModel.linePx + MSG_CHROME_PX + images);
}

// Reasoning-model thinking, per message, session-only (never persisted).
// Keyed weakly so deleted messages release their (possibly large) thought text.
const reasoningText = new WeakMap();
// Messages whose thinking block the user toggled by hand mid-stream; their
// choice wins over the auto open-while-thinking/close-on-reply behavior.
const thinkingToggled = new WeakSet();

/**
 * Collapsible thinking block shown above a reasoning model's reply. Open while
 * the model is still thinking with no visible content yet — this is what makes
 * a long GLM/R1 thinking phase look alive instead of hung.
 */
function thinkingHTML(msg) {
  const text = reasoningText.get(msg);
  if (!text || state.settings.showThinking === false) return '';
  const open = msg.__streaming && !msg.mes;
  const label = t('chat.thinking', { tokens: estimateTokens(text).toLocaleString() });
  return (
    `<details class="thinking-block"${open ? ' open' : ''}>` +
    `<summary>💭 ${escapeHtml(label)}</summary>` +
    `<div class="thinking-text">${escapeHtml(text)}</div></details>`
  );
}

/**
 * Repaint the streaming message. The thinking block is updated IN PLACE, not
 * rebuilt: replacing its DOM every frame would eat real clicks on the summary
 * (mousedown and mouseup must land on the same node for the click — and the
 * <details> toggle — to fire, and a press spans several frames) and would
 * reset the disclosure state and inner scroll position. Only the markdown
 * body after the block is replaced per frame.
 */
function repaintStreaming(msg) {
  const block = streamingMsgEl.querySelector(':scope > .thinking-block');
  const text = reasoningText.get(msg);
  if (!block || !text || state.settings.showThinking === false) {
    // First paint, no thinking, or thinking hidden: plain full render
    streamingMsgEl.innerHTML = renderedMarkdown(msg);
    return;
  }
  // Auto-open while thinking with no reply yet, auto-close once the reply
  // starts; a manual toggle wins for the rest of the stream.
  if (!thinkingToggled.has(msg)) block.open = !msg.mes;
  block.querySelector('summary').textContent =
    `💭 ${t('chat.thinking', { tokens: estimateTokens(text).toLocaleString() })}`;
  const textEl = block.querySelector('.thinking-text');
  // Follow the newest text unless the user scrolled up (the message list's
  // contract); a closed block skips this and the reopen handler catches up.
  const follow = textEl.scrollTop + textEl.clientHeight >= textEl.scrollHeight - 4;
  textEl.textContent = text;
  if (block.open && follow) textEl.scrollTop = textEl.scrollHeight;
  while (block.nextSibling) block.nextSibling.remove();
  block.insertAdjacentHTML('afterend', renderedBody(msg));
}

function renderedBody(msg) {
  const entry = cacheFor(msg);
  return (entry.html ??= renderMarkdown(msg.mes));
}

function renderedMarkdown(msg) {
  return thinkingHTML(msg) + renderedBody(msg);
}

function messageTokens(msg) {
  const entry = cacheFor(msg);
  return (entry.tokens ??= estimateTokens(msg.mes));
}

export function initChat(callbacks) {
  cb = callbacks;
  // Chunks can arrive far faster than 60fps; re-rendering markdown per token
  // is O(n²) over a long response. Coalesce to one render per animation frame.
  window.tavern.on('llm:chunk', ({ requestId, text }) => {
    const run = state.runs.get(requestId);
    if (!run) return;
    const msg = run.msg;
    msg.mes += text;
    if (msg.swipes) msg.swipes[msg.swipe_id ?? 0] = msg.mes;
    // Background conversations accumulate text only; no DOM to update
    if (run.chat !== state.currentChat) return;
    if (!renderQueued && streamingMsgEl) {
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        // The user may have switched conversations during the frame
        if (state.runs.has(requestId) && run.chat === state.currentChat && streamingMsgEl) {
          repaintStreaming(msg);
          scrollToBottom(false);
        }
      });
    }
  });
  // Reasoning-model thinking: accumulate per message and repaint the open
  // thinking block with the same frame-coalescing as content chunks.
  window.tavern.on('llm:reasoning', ({ requestId, text }) => {
    const run = state.runs.get(requestId);
    if (!run) return;
    const msg = run.msg;
    reasoningText.set(msg, (reasoningText.get(msg) ?? '') + text);
    if (run.chat !== state.currentChat) return;
    // Hidden thinking still accumulates (for the budget-exhausted notice),
    // but the streaming dots stay up instead of an empty repaint.
    if (state.settings.showThinking === false) return;
    if (!renderQueued && streamingMsgEl) {
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        if (state.runs.has(requestId) && run.chat === state.currentChat && streamingMsgEl) {
          repaintStreaming(msg);
          scrollToBottom(false);
        }
      });
    }
  });
  window.tavern.on('llm:done', async ({ requestId, finishReason, usage }) => {
    const run = state.runs.get(requestId);
    if (!run) return;
    if (usage) run.usage = usage; // provider-reported token counts, when available
    setNotice(run.charName, run.file, { finishReason: finishReason ?? null });
    // A reasoning model that hit max-tokens with no visible reply spent the
    // whole budget thinking — the message keeps its thinking block for this
    // session, but this notice explains what happened and how to fix it.
    if (LENGTH_REASONS.has(finishReason) && !run.msg?.mes.trim() && reasoningText.get(run.msg)) {
      setNotice(run.charName, run.file, { error: t('chat.thinkingExhausted') });
    }
    if (LENGTH_REASONS.has(finishReason)) {
      devLog('INFO', `response truncated by max-tokens limit (finish_reason: ${finishReason})`);
    }
    // Image-capable chat models asked for an image in a text-only request
    // answer with a bare "<image>" placeholder instead of text. Strip the
    // token when a real image also arrived; otherwise re-run the turn against
    // the configured image model so the user gets what they asked for.
    const msg = run.msg;
    const action = imageFollowupAction(msg?.mes, {
      hasImages: !!msg?.extra?.attachments?.length,
      imageGenEnabled: !!state.settings.imageGen?.enabled,
      alreadyRerouted: msg ? reroutedMessages.has(msg) : false,
    });
    if (action !== 'none') devLog('INFO', `image placeholder response ("${msg.mes.trim()}") → ${action}`);
    if (action === 'strip') {
      msg.mes = '';
      if (msg.swipes) msg.swipes[msg.swipe_id ?? 0] = '';
    } else if (action === 'reroute') {
      reroutedMessages.add(msg);
      msg.mes = '';
      if (msg.swipes) msg.swipes[msg.swipe_id ?? 0] = '';
      const idx = run.chat.messages.indexOf(msg);
      state.runs.delete(requestId);
      await generateResponse({
        historyUpTo: idx,
        intoMessage: msg,
        configOverride: imageApiConfig(),
        chat: run.chat,
        character: run.character,
      });
      // The reroute may have bailed before sending (e.g. no image key):
      // nothing will ever finish this message, so clear the phantom
      // streaming state and drop the empty placeholder ourselves.
      if (msg.__streaming && !runForChat(run.chat)) {
        delete msg.__streaming;
        newMessages.delete(msg);
        const at = run.chat.messages.indexOf(msg);
        if (!msg.mes.trim() && at !== -1) run.chat.messages.splice(at, 1);
        await persistChatFor(run.charName, run.chat);
        if (run.chat === state.currentChat && state.view === 'chat') renderChat();
        else cb.renderSidebar?.();
      }
      return;
    } else if (action === 'hint') {
      setNotice(run.charName, run.file, { error: imageHintMessage() });
    }
    await finishGeneration(run);
  });
  window.tavern.on('llm:error', async ({ requestId, error, aborted }) => {
    const run = state.runs.get(requestId);
    if (!run) return;
    devLog('ERR', error);
    if (!aborted) {
      setNotice(run.charName, run.file, {
        error: decorateModelError(error, { imageTurn: !!run.configOverride }),
      });
    }
    await finishGeneration(run, { failed: !aborted });
  });
  // Image outputs from image-capable models: persist to uploads/ and attach
  window.tavern.on('llm:image', async ({ requestId, dataURL }) => {
    const run = state.runs.get(requestId);
    if (!run) return;
    const msg = run.msg;
    if (!msg || msg.is_user) return;
    try {
      const saved = await window.tavern.files.saveUpload('generated', dataURL);
      msg.extra = msg.extra ?? {};
      (msg.extra.attachments ??= []).push({ file: saved.file, name: saved.name, mime: saved.mime, kind: 'image' });
      // The done event may have already persisted the message without this image
      if (!state.runs.has(requestId)) await persistChatFor(run.charName, run.chat);
      if (run.chat === state.currentChat && state.view === 'chat') renderChat();
    } catch (err) {
      devLog('ERR', `Could not save generated image: ${err.message}`);
    }
  });
  // A reply that finished while the window was hidden marked even the
  // on-screen conversation unread; the window becoming visible is the read.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || state.view !== 'chat' || !state.currentChat || !state.selectedCharacter) return;
    const charName = state.selectedCharacter.card.data.name;
    if (isUnread(charName, state.currentChat.file)) {
      clearUnread(charName, state.currentChat.file);
      cb.renderSidebar?.();
    }
  });
}

async function finishGeneration(run, { failed = false } = {}) {
  // Both the llm:error push event and the rejected llm:send invoke can land
  // here for the same request — only the first one does the work.
  if (!state.runs.has(run.requestId)) return;
  state.runs.delete(run.requestId);
  const chat = run.chat;
  const msg = run.msg;
  let wasNew = false;
  if (msg) {
    delete msg.__streaming;
    wasNew = newMessages.has(msg);
    newMessages.delete(msg);
    if (!msg.mes.trim() && failed) {
      // Empty failed response: undo whatever this run did to the message.
      // A swipe attempt pushed a new slot — pop it and show the previous
      // one; a regenerate/continue cleared existing text — put it back;
      // a brand-new reply has nothing to keep — drop it.
      if (run.pushedSwipe && msg.swipes && msg.swipes.length > 1) {
        msg.swipes.pop();
        msg.swipe_id = msg.swipes.length - 1;
        msg.mes = msg.swipes[msg.swipe_id];
      } else if (run.prevMes != null) {
        msg.mes = run.prevMes;
        if (msg.swipes) msg.swipes[msg.swipe_id ?? 0] = run.prevMes;
        if (run.prevDate) msg.send_date = run.prevDate;
      } else {
        const at = chat.messages.indexOf(msg);
        if (at !== -1) chat.messages.splice(at, 1);
      }
    }
  }
  // The cost estimate rides on the message itself, so persisting it costs no
  // extra writes (the append below carries it). Token counts are exact when
  // the provider reported usage, chars/4 estimates otherwise. Dollars come
  // from the provider's own charge when reported (OpenRouter), else from
  // reference pricing with approximate cache discounts.
  if (!failed && msg && chat.messages.includes(msg) && msg.mes.trim() && state.settings.showCostEstimates) {
    const usage = run.usage ?? {};
    const inTokens = usage.inTokens ?? run.promptTokens ?? 0;
    const outTokens = usage.outTokens ?? estimateTokens(msg.mes);
    const cached = usage.cachedTokens ?? 0;
    const cacheWrite = usage.cacheWriteTokens ?? 0;
    const pricing = knownModelPricing(run.provider, run.model);
    let usd;
    let exact = false;
    if (usage.costUSD != null) {
      usd = usage.costUSD;
      exact = true;
    } else if (pricing) {
      // Approximate cache rates vs. the base input price: Anthropic reads
      // 0.1× / writes 1.25×, OpenAI cached 0.5×, Gemini cached 0.25×
      const readMult = { claude: 0.1, openai: 0.5, gemini: 0.25 }[run.provider] ?? 1;
      const writeMult = run.provider === 'claude' ? 1.25 : 1;
      const freshIn = Math.max(0, inTokens - cached - cacheWrite);
      usd =
        ((freshIn + cached * readMult + cacheWrite * writeMult) * pricing.inPerM +
          outTokens * pricing.outPerM) /
        1e6;
    }
    msg.extra = msg.extra ?? {};
    msg.extra.cost = {
      model: run.model,
      inTokens,
      outTokens,
      ...(cached ? { cachedTokens: cached } : {}),
      ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
      ...(usd != null ? { usd } : {}),
      ...(exact ? { exact: true } : {}),
    };
  }
  // Persist with the run's own refs — the chat may be backgrounded by now.
  // Brand-new messages append (O(message)); anything that mutated an
  // existing message (regenerate, swipe) rewrites the file.
  if (msg && wasNew) {
    if (chat.messages.includes(msg)) await appendToChatFor(run.charName, chat, msg);
  } else {
    await persistChatFor(run.charName, chat);
  }
  const onScreen = chat === state.currentChat && state.view === 'chat';
  // Only a reply the user could actually see counts as read — a hidden
  // window marks even the on-screen conversation unread.
  const seen = onScreen && !document.hidden;
  if (!seen && !failed && msg && chat.messages.includes(msg) && msg.mes.trim()) {
    markUnread(run.charName, run.file);
  }
  if (isChatMode()) await refreshConversations(); // re-renders the sidebar
  else cb.renderSidebar?.();
  if (onScreen) renderChat();
  // Compress backgrounded conversations too — long chats are then already
  // compact when the user returns. Re-renders only if the chat is on-screen.
  void maybeCompressChat(chat, run.charName);
  if (!failed) void maybeAutoTitle(run); // background; renames when done
}

/**
 * Replace the crude first-message-slice title with a short model-written one
 * after the first exchange of a chat-mode conversation. Never overwrites a
 * manual rename: it only runs while the title is still the auto placeholder,
 * and re-checks after the call returns.
 */
async function maybeAutoTitle(run) {
  if (run.charName !== ASSISTANT_NAME) return;
  const chat = run.chat;
  if (chat.messages.length !== 2) return; // exactly the first user turn + first reply
  const placeholder = truncateChars(chat.messages.find((m) => m.is_user)?.mes ?? '', 64);
  if (chat.metadata.title && chat.metadata.title !== placeholder) return;
  const config = apiConfig(chat.metadata.model);
  if (PROVIDERS[config.provider].requiresKey && !config.apiKey) return;
  config.params.max_tokens = 24;
  const transcript = chat.messages
    .map((m) => `${m.is_user ? 'User' : 'Assistant'}: ${m.mes.slice(0, 500)}`)
    .join('\n');
  try {
    const text = (
      await window.tavern.llm.complete(
        [
          {
            role: 'system',
            content:
              "Write a title of at most six words for this conversation, in the conversation's own language. Reply with only the title — no quotes, no trailing punctuation.",
          },
          { role: 'user', content: transcript },
        ],
        config
      )
    )
      ?.trim()
      .replace(/^["'“]+|["'”]+$/g, '');
    if (!text) return;
    if (chat.metadata.title && chat.metadata.title !== placeholder) return; // renamed mid-flight
    await renameConversation(chat.file, truncateChars(text, 64));
  } catch (err) {
    devLog('INFO', `auto-title skipped: ${err.message}`); // placeholder title remains
  }
}

// ---------------------------------------------------------------------------
// Chat compression: once a chat outgrows the threshold, summarize the older
// messages with one cheap non-streaming call so every following turn stops
// resending the full history.

const COMPRESS_KEEP_RECENT = 16; // newest messages always sent verbatim
const COMPRESS_CONTEXT_FRACTION = 0.5; // also compress when the backlog outgrows this share of the context
const COMPRESS_MIN_BATCH = 4; // never spin up a call to fold fewer messages than this
// The transcript itself must fit the summarizer (it IS the chat model): cap
// each pass at this share of its context; a bigger backlog — e.g. a freshly
// imported SillyTavern chat with no summary yet — folds in over successive
// replies, one batch at a time.
const COMPRESS_INPUT_FRACTION = 0.4;
const COMPRESS_INPUT_FALLBACK_TOKENS = 8192; // when the context size is unknown/unlimited
let compressing = false;

async function maybeCompressChat(chat, charName) {
  const cfg = state.settings.chatCompression;
  if (!cfg?.enabled || compressing || !chat || !charName) return;
  if (runForChat(chat)) return; // never race the chat's own generation
  const threshold = Math.max(20, cfg.afterMessages ?? 60);
  const start = Math.min(chat.metadata.summary?.upToIndex ?? 0, chat.messages.length);
  const config = apiConfig(chat.metadata.model);
  // Message count alone under-triggers on long messages: a handful of big
  // turns can fill a small context and start silently trimming. Also compress
  // once the compressible backlog outgrows half the model's context window
  // (known from the model-list cache; the manual setting is the fallback).
  const p = config.params;
  const autoCtx = (p.context_size_auto ?? true) ? knownModelContext(config.provider, config.model) : 0;
  const contextSize = autoCtx > 0 ? autoCtx : p.context_size;
  const end = chat.messages.length - COMPRESS_KEEP_RECENT;
  if (end - start < COMPRESS_MIN_BATCH) return;
  // Measure only the compressible region: the recent tail is always sent
  // verbatim, so counting it would keep re-triggering a pointless tiny
  // compression every turn once the tail alone exceeds the budget.
  const backlogTokens = chat.messages
    .slice(start, end)
    .reduce((sum, m) => sum + messageTokens(m), 0);
  const overTokenBudget = contextSize > 0 && backlogTokens > contextSize * COMPRESS_CONTEXT_FRACTION;
  if (chat.messages.length - start <= threshold && !overTokenBudget) return;

  compressing = true;
  const chatRef = chat;
  try {
    // Cap the transcript to what the summarizer can actually read
    const inputBudget =
      contextSize > 0
        ? Math.max(2048, Math.floor(contextSize * COMPRESS_INPUT_FRACTION))
        : COMPRESS_INPUT_FALLBACK_TOKENS;
    let batchEnd = start;
    for (let used = 0; batchEnd < end; batchEnd++) {
      const cost = messageTokens(chat.messages[batchEnd]);
      if (batchEnd > start && used + cost > inputBudget) break;
      used += cost;
    }
    const slice = chat.messages.slice(start, batchEnd);
    const prior = chat.metadata.summary?.text;
    const transcript = slice.map((m) => `${m.name}: ${m.mes}`).join('\n\n');
    const request = [
      { role: 'system', content: cfg.prompt?.trim() || DEFAULT_COMPRESSION_PROMPT },
      {
        role: 'user',
        content:
          (prior ? `Existing summary of even earlier messages (fold it into the new summary):\n${prior}\n\n` : '') +
          `Conversation to summarize:\n\n${transcript}`,
      },
    ];
    config.params.max_tokens = Math.min(1024, config.params.max_tokens || 1024);
    devLog('INFO', `compressing ${slice.length}/${end - start} older messages (${overTokenBudget ? `~${backlogTokens}-token backlog > ${Math.round(COMPRESS_CONTEXT_FRACTION * 100)}% of ${contextSize}-token context` : `threshold ${threshold}`})…`);
    const text = (await window.tavern.llm.complete(request, config))?.trim();
    if (!text) return;
    // If the user reopened this conversation mid-flight, state.currentChat is
    // a FRESH object loaded from disk — write the summary to the live object,
    // not the stale chatRef, or the persist would clobber newer messages.
    const reopened =
      state.currentChat !== chatRef &&
      state.currentChat?.file === chatRef.file &&
      state.selectedCharacter?.card.data.name === charName;
    const target = reopened ? state.currentChat : chatRef;
    if (runForChat(target)) return; // a generation started meanwhile — don't clobber its rewrite
    if (target.messages.length < batchEnd) return; // messages were deleted meanwhile
    target.metadata.summary = { text, upToIndex: batchEnd };
    await persistChatMetadataFor(charName, target);
    devLog('INFO', `compressed ${batchEnd - start} messages into a ~${estimateTokens(text)}-token summary`);
    // Never rebuild over an open inline edit — the new count shows on the
    // next render (the edit's save/cancel triggers one).
    if (target === state.currentChat && state.view === 'chat' && !isCurrentChatGenerating() && !inlineEditOpen()) renderChat();
  } catch (err) {
    devLog('ERR', `chat compression failed: ${err.message}`);
  } finally {
    compressing = false;
  }
}

/**
 * Persist a metadata change without disturbing streaming state: messages
 * pending append (an in-flight reply) stay out of the rewrite so the
 * finishing run's append can't duplicate them.
 */
async function persistChatMetadataFor(charName, chat) {
  await window.tavern.chats.rewrite(
    charName,
    chat.file,
    chat.metadata,
    chat.messages.filter((m) => !newMessages.has(m)).map(({ __streaming, ...m }) => m)
  );
}

async function persistChatMetadata(chat) {
  if (!chat || !state.selectedCharacter) return;
  await persistChatMetadataFor(state.selectedCharacter.card.data.name, chat);
}

/**
 * Drop everything held in memory for a chat that is being deleted. The run is
 * removed from the registry BEFORE aborting: with the run already gone, the
 * aborted llm:error event no-ops instead of persisting into (and thereby
 * resurrecting) the deleted file.
 */
function forgetChat(charName, file) {
  const run = runFor(charName, file);
  if (run) {
    state.runs.delete(run.requestId);
    window.tavern.llm.stop(run.requestId);
  }
  clearUnread(charName, file);
  chatDrafts.delete(convKey(charName, file));
  chatNotices.delete(convKey(charName, file));
}

async function persistChatFor(charName, chat) {
  if (!chat) return;
  const clean = chat.messages.map(({ __streaming, ...m }) => m);
  await window.tavern.chats.rewrite(charName, chat.file, chat.metadata, clean);
}

async function persistChat() {
  if (!state.currentChat || !state.selectedCharacter) return;
  await persistChatFor(state.selectedCharacter.card.data.name, state.currentChat);
}

async function appendToChatFor(charName, chat, msg) {
  const { __streaming, ...clean } = msg;
  await window.tavern.chats.append(charName, chat.file, clean);
}

async function appendToChat(msg) {
  if (!state.currentChat || !state.selectedCharacter) return;
  await appendToChatFor(state.selectedCharacter.card.data.name, state.currentChat, msg);
}

// ---------------------------------------------------------------------------
// Character / chat selection

export async function selectCharacter(character) {
  const token = ++selectionSeq;
  state.selectedCharacter = character;
  state.view = 'chat';
  state.undoStack = [];
  pendingAttachments = [];
  // O(1) session restore on next launch
  if (!character.virtual) {
    state.settings.lastCharacterFilename = character.filename;
    scheduleSettingsSave();
  }
  const charName = character.card.data.name;
  const chats = await window.tavern.chats.list(charName);
  if (token !== selectionSeq) return; // a newer selection took over meanwhile
  if (chats.length) {
    await loadChat(chats[0].file, token); // reuses a live run's chat, clears unread
  } else {
    await newChat({ render: false, token });
    if (token !== selectionSeq) return;
    renderChat({ scrollBottom: true });
  }
  if (token !== selectionSeq) return;
  cb.renderSidebar?.();
}

// --- Chat mode: conversations with the built-in assistant ------------------

/** Enter chat mode: select the virtual assistant and its latest conversation. */
export async function enterChatMode() {
  await selectCharacter(ASSISTANT_CHARACTER);
  await refreshConversations();
}

export async function refreshConversations() {
  if (!isChatMode()) return;
  state.conversations = await window.tavern.chats.list(ASSISTANT_NAME);
  cb.renderSidebar?.();
}

export async function selectConversation(file) {
  const token = ++selectionSeq;
  state.view = 'chat';
  state.selectedCharacter = ASSISTANT_CHARACTER;
  pendingAttachments = [];
  await loadChat(file, token);
}

export async function deleteConversation(file) {
  forgetChat(ASSISTANT_NAME, file);
  const pins = state.settings.pinnedConversations;
  if (pins?.includes(file)) {
    state.settings.pinnedConversations = pins.filter((f) => f !== file);
    scheduleSettingsSave();
  }
  await window.tavern.chats.delete(ASSISTANT_NAME, file);
  await refreshConversations();
  if (state.currentChat?.file === file) {
    if (state.conversations.length) await selectConversation(state.conversations[0].file);
    else await newChat();
  }
}

export async function renameConversation(file, title) {
  // Prefer the live in-memory chat (current or mid-stream run) so a later
  // rewrite from the run doesn't clobber the rename with stale metadata.
  const run = runFor(ASSISTANT_NAME, file);
  const chat =
    state.currentChat?.file === file
      ? state.currentChat
      : run?.chat ?? (await window.tavern.chats.load(ASSISTANT_NAME, file));
  chat.metadata.title = title;
  // Messages pending append (a streaming reply) are not on disk yet — leave
  // them out of the rewrite or the finishing run would append a duplicate.
  await persistChatMetadataFor(ASSISTANT_NAME, chat);
  await refreshConversations();
  if (state.currentChat?.file === file && state.view === 'chat') {
    // An open inline edit must survive the rename: patch the header only
    if (inlineEditOpen()) updateChatTitleInPlace(title);
    else renderChat();
  }
}

// ---------------------------------------------------------------------------

export async function newChat({ render = true, token = ++selectionSeq } = {}) {
  const character = state.selectedCharacter;
  if (!character) return;
  const data = character.card.data;
  const created = await window.tavern.chats.create(data.name, userName());
  if (token !== selectionSeq) return; // user switched elsewhere while the file was created
  state.currentChat = created;
  state.undoStack = [];
  pendingAttachments = [];
  if (isChatMode()) await refreshConversations();
  if (token !== selectionSeq) return;

  // Greeting message with alternate greetings as swipes
  if (data.first_mes) {
    const swipes = [data.first_mes, ...(data.alternate_greetings ?? [])];
    const greeting = {
      name: data.name,
      is_user: false,
      send_date: nowISO(),
      mes: data.first_mes,
      ...(swipes.length > 1 ? { swipes, swipe_id: 0 } : {}),
    };
    created.messages.push(greeting);
    await persistChatFor(data.name, created);
    if (token !== selectionSeq) return;
  }
  if (render) renderChat({ scrollBottom: true });
}

export async function loadChat(file, token = ++selectionSeq) {
  const charName = state.selectedCharacter.card.data.name;
  // A mid-stream run keeps its chat live in memory — reuse it so the reply
  // keeps streaming in place instead of loading the stale on-disk copy.
  const run = runFor(charName, file);
  const loaded = run ? run.chat : await window.tavern.chats.load(charName, file);
  if (token !== selectionSeq) return; // a newer selection took over meanwhile
  state.currentChat = loaded;
  state.undoStack = [];
  clearUnread(charName, file);
  renderChat({ scrollBottom: true });
  cb.renderSidebar?.();
}

// ---------------------------------------------------------------------------
// Rendering

export function renderChat({ scrollBottom = false } = {}) {
  const main = document.getElementById('main');
  // Reset before the rebuild: a stale element from a previously viewed
  // streaming chat must never receive another conversation's chunks.
  // messageEl re-assigns it when the current chat has a streaming message.
  streamingMsgEl = null;

  // Carry the user's draft, cursor, and scroll position across the rebuild —
  // a render must never eat text typed while a response was streaming, nor
  // yank the view to the bottom while reading older messages.
  const prevMessages = document.getElementById('messages');
  let prevScroll = null;
  if (prevMessages) {
    const top = prevMessages.scrollTop;
    prevScroll = { top, anchorIndex: null, anchorOffset: 0 };
    // Anchor the restore to the first visible message, not a pixel offset:
    // content-visibility only estimates offscreen heights on a rebuild, so a
    // raw scrollTop gets clamped against the too-small scrollHeight and the
    // view lands near the top of long chats. First message whose TOP is
    // inside the viewport: positioning by its top keeps its own height
    // estimate out of the equation, so it can't drift when the real height
    // replaces the 90px placeholder.
    for (const child of prevMessages.children) {
      if (child.dataset?.index != null && child.offsetTop >= top) {
        prevScroll.anchorIndex = child.dataset.index;
        prevScroll.anchorOffset = child.offsetTop - top;
        break;
      }
    }
  }
  // Drafts live in chatDrafts (updated on every keystroke), not in the DOM:
  // another view (settings, characters) clears #main, so by the time the
  // user comes back there is no previous textarea to read the text from.
  // Snapshot the live textarea here anyway so the cursor position is fresh.
  const prevInput = document.getElementById('chat-input');
  if (prevInput && renderedDraftKey != null) stashDraft(renderedDraftKey, prevInput);
  const draftKey =
    state.currentChat && state.selectedCharacter
      ? convKey(state.selectedCharacter.card.data.name, state.currentChat.file)
      : null;
  renderedDraftKey = draftKey;
  const draft = draftKey ? (chatDrafts.get(draftKey) ?? null) : null;

  clear(main);

  if (!state.selectedCharacter) {
    main.append(
      isChatMode()
        ? el(
            'div',
            { class: 'empty-state' },
            el('h2', {}, t('chat.welcome')),
            el('p', {}, t('chat.welcomeChat')),
            el('button', { class: 'btn btn-primary', onclick: () => enterChatMode() }, t('sidebar.newChat'))
          )
        : el(
            'div',
            { class: 'empty-state' },
            el('h2', {}, t('chat.welcome')),
            el('p', {}, t('chat.welcomeStory')),
            el('button', { class: 'btn btn-primary', onclick: () => cb.editCharacter?.(null) }, t('sidebar.newCharacter'))
          )
    );
    return;
  }

  const data = state.selectedCharacter.card.data;
  const config = apiConfig(state.currentChat?.metadata?.model);
  const notice = currentNotice();
  const chatTitle = isChatMode()
    ? state.currentChat?.metadata?.title || t('sidebar.newConversation')
    : data.name;

  const allMessages = state.currentChat?.messages ?? [];
  // Estimate what actually gets sent: summary stands in for compressed messages
  const compressedCount = Math.min(state.currentChat?.metadata?.summary?.upToIndex ?? 0, allMessages.length);
  const costTotal = state.settings.showCostEstimates
    ? allMessages.reduce((sum, m) => sum + (m.extra?.cost?.usd ?? 0), 0)
    : 0;
  // Per-message sums hit the render cache; joining every message into one
  // string would allocate O(chat size) on every rebuild.
  const tokenEstimate =
    allMessages.slice(compressedCount).reduce((sum, m) => sum + messageTokens(m), 0) +
    estimateTokens((state.currentChat?.metadata?.summary?.text ?? '') + (data.description ?? ''));
  const root = el('div', { id: 'chat-root' });
  root.append(
    el(
      'div',
      { class: 'chat-toolbar' },
      el(
        'div',
        { class: 'chat-title' },
        avatar(avatarURL(state.selectedCharacter), data.name, 28),
        chatTitle,
        el(
          'span',
          { class: 'chat-meta' },
          t('chat.meta', { count: allMessages.length, tokens: tokenEstimate.toLocaleString() }),
          compressedCount > 0
            ? el(
                'span',
                {
                  class: 'meta-link',
                  role: 'button',
                  tabindex: 0,
                  title: t('chat.compressedTitle'),
                  onclick: () => openSummaryEditor(),
                  onkeydown: (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openSummaryEditor();
                    }
                  },
                },
                t('chat.compressedCount', { count: compressedCount })
              )
            : null,
          notice.trimmed > 0 ? t('chat.trimmedNotice', { count: notice.trimmed }) : null,
          costTotal > 0 ? ` · ~${formatUSD(costTotal)}` : null
        )
      ),
      el(
        'button',
        {
          class: 'model-chip',
          title: t('chat.modelChipTitle', { provider: PROVIDERS[config.provider].label, model: config.model }),
          'aria-label': t('chat.switchModel'),
          onclick: () => openModelSwitcher(),
        },
        config.model || t('chat.chooseModel')
      ),
      iconBtn({
        class: `btn-icon${state.currentChat?.metadata?.authorsNote?.text ? ' active' : ''}`,
        title: isChatMode() ? t('chat.instructionsTitle') : t('chat.authorsNoteTitle'),
        'aria-label': isChatMode() ? t('chat.instructionsAria') : t('chat.authorsNoteAria'),
        onclick: () => openAuthorsNote(), label: t('label.note'),
      }, '📝'),
      iconBtn({ class: 'btn-icon', title: t('chat.searchTitle', { mod: MOD }), 'aria-label': t('chat.search'), label: t('label.search'), onclick: () => openSearch() }, '🔍'),
      iconBtn({ class: 'btn-icon', title: t('chat.historyTitle', { mod: MOD }), 'aria-label': t('chat.history'), label: t('label.history'), onclick: () => openHistory() }, '🕘'),
      iconBtn({ class: 'btn-icon', title: t('chat.exportThisChat'), 'aria-label': t('chat.exportThisChat'), label: t('label.export'), onclick: () => exportCurrentChat() }, '⬆'),
      iconBtn({ class: 'btn-icon', title: t('chat.newChatTitle', { mod: MOD }), 'aria-label': t('chat.newChat'), label: t('label.new'), onclick: () => newChat() }, '＋')
    )
  );

  // Nothing configured yet: point straight at Settings instead of failing on send
  if (PROVIDERS[config.provider].requiresKey && !config.apiKey) {
    root.append(
      el(
        'div',
        { class: 'notice-banner' },
        el('span', {}, t('chat.addKeyBanner', { label: PROVIDERS[config.provider].label })),
        el('button', { class: 'btn btn-primary btn-small', onclick: () => cb.openSettings?.('api') }, t('chat.openSettings'))
      )
    );
  }

  const messagesEl = el('div', { id: 'messages' });
  const messages = state.currentChat?.messages ?? [];
  // Per-message context computed once: activePersona scans the persona list
  // and lastAssistantIndex scans the tail — O(n²) over a long chat otherwise
  const msgPersona = activePersona();
  const lastAssistant = lastAssistantIndex();
  updateHeightModel(main);
  // Windowed rendering: only the newest RENDER_WINDOW messages get DOM nodes;
  // scrolling near the top prepends earlier batches seamlessly (see the
  // scroll listener below). Data — search, token estimates, prompts — always
  // uses the full array; only DOM construction is windowed. The window floor
  // persists per conversation so re-renders keep whatever the user expanded.
  const conv = state.currentChat ? convKey(data.name, state.currentChat.file) : null;
  if (conv !== renderWindowConv) {
    renderWindowConv = conv;
    renderWindowStart = Infinity;
  }
  renderWindowStart = Math.min(renderWindowStart, Math.max(0, messages.length - RENDER_WINDOW));
  for (let index = renderWindowStart; index < messages.length; index++) {
    messagesEl.append(messageEl(messages[index], index, msgPersona, lastAssistant));
  }
  if (!messages.length && state.currentChat) {
    messagesEl.append(el('div', { class: 'empty-chat-hint hint', style: { textAlign: 'center', margin: 'auto', opacity: 0.7 } }, t('chat.emptyChatHint')));
  }
  if (notice.error) {
    messagesEl.append(
      el(
        'div',
        { class: 'error-banner' },
        el('span', {}, notice.error),
        el('button', { class: 'btn btn-primary btn-small', onclick: () => retryLast() }, t('chat.retry')),
        el('button', { class: 'btn btn-small', onclick: () => { setNotice(data.name, state.currentChat.file, { error: null }); renderChat(); } }, t('common.dismiss'))
      )
    );
  }
  // The provider stopped mid-response at the max-tokens limit — say so,
  // instead of letting the text look mysteriously cut off.
  if (!isCurrentChatGenerating() && LENGTH_REASONS.has(notice.finishReason) && lastAssistantIndex() === messages.length - 1 && messages.length) {
    messagesEl.append(
      el(
        'div',
        { class: 'notice-banner' },
        el('span', {}, t('chat.limitBanner', { limit: config.params.max_tokens.toLocaleString() })),
        el('button', { class: 'btn btn-primary btn-small', onclick: () => continueLast() }, t('chat.continue')),
        el('button', { class: 'btn btn-small', onclick: () => cb.openSettings?.('generation') }, t('chat.raiseLimit')),
        el('button', { class: 'btn btn-small', onclick: () => { setNotice(data.name, state.currentChat.file, { finishReason: null }); renderChat(); } }, t('common.dismiss'))
      )
    );
  }
  root.append(messagesEl);

  // Floating scroll-to-bottom button for long chats
  const scrollBtn = el(
    'button',
    { id: 'scroll-bottom-btn', title: t('chat.jumpToLatest'), 'aria-label': t('chat.jumpToLatest'), onclick: () => scrollToBottom(true) },
    '↓'
  );
  root.append(scrollBtn);
  // Intent tracking, not proximity: our own scrolls only ever move DOWN to
  // the bottom, so any upward movement is the user — unfollow immediately,
  // with no distance threshold (one slow wheel notch is enough; the old
  // 160px "near bottom" zone made streaming chunks yank slow scrollers back
  // to the bottom until they scrolled fast enough to escape it). Re-follow
  // only when the user themselves reaches the bottom.
  let lastScrollTop = messagesEl.scrollTop;
  let expandUp = null; // assigned below, after the resize observer exists
  messagesEl.addEventListener('wheel', (e) => {
    if (e.deltaY < 0) followingBottom = false;
  }, { passive: true });
  messagesEl.addEventListener('scroll', () => {
    const distance = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    scrollBtn.classList.toggle('visible', distance > 300);
    if (messagesEl.scrollTop < lastScrollTop) followingBottom = false;
    else if (distance < 2) followingBottom = true;
    lastScrollTop = messagesEl.scrollTop;
    if (messagesEl.scrollTop < 400) expandUp?.();
  });
  // While following the newest message, any growth in a message re-anchors
  // the view: streamed text, attachment images finishing their async load,
  // and content-visibility re-estimating offscreen sizes all land here.
  messagesResizeObserver?.disconnect();
  // Coalesced to one scroll write per frame, and skipped when already at the
  // bottom: scrollTop writes change which messages are visible, which changes
  // content-visibility size estimates, which fires resizes — an unthrottled
  // callback turns that into a resize↔scroll feedback loop on long chats.
  let resizeScrollQueued = false;
  messagesResizeObserver = new ResizeObserver((entries) => {
    // Remember real heights so the next render's placeholders are exact.
    // Skipped (offscreen) messages report their placeholder size — ignore.
    for (const entry of entries) {
      const node = entry.target;
      const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      if (h > 0 && node.checkVisibility?.({ contentVisibilityAuto: true })) {
        const msg = msgForNode.get(node);
        if (msg && !msg.__streaming) {
          cacheFor(msg).height = h;
          node.style.containIntrinsicSize = `auto ${Math.round(h)}px`;
        }
      }
    }
    if (!followingBottom || resizeScrollQueued) return;
    resizeScrollQueued = true;
    requestAnimationFrame(() => {
      resizeScrollQueued = false;
      if (!followingBottom) return;
      if (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight > 1) scrollToBottom(true);
    });
  });
  for (const child of messagesEl.children) messagesResizeObserver.observe(child, { box: 'border-box' });

  // Seamless upward expansion: prepend the previous batch of messages when
  // the user scrolls near the top, keeping the viewport anchored on what they
  // were reading. No full re-render — existing nodes (and any in-progress
  // stream) are untouched.
  let expandingUp = false;
  expandUp = () => {
    if (expandingUp || renderWindowStart <= 0) return;
    expandingUp = true;
    const from = Math.max(0, renderWindowStart - RENDER_BATCH);
    const prevHeight = messagesEl.scrollHeight;
    const frag = document.createDocumentFragment();
    for (let i = from; i < renderWindowStart; i++) {
      frag.append(messageEl(messages[i], i, msgPersona, lastAssistant));
    }
    messagesEl.prepend(frag);
    for (let node = messagesEl.firstElementChild, n = renderWindowStart - from; node && n > 0; node = node.nextElementSibling, n--) {
      messagesResizeObserver.observe(node, { box: 'border-box' });
    }
    renderWindowStart = from;
    messagesEl.scrollTop += messagesEl.scrollHeight - prevHeight;
    lastScrollTop = messagesEl.scrollTop;
    expandingUp = false;
  };

  // Input bar — auto-grows with content from a user-resizable base height
  // (drag the handle above the bar; double-click resets)
  const input = el('textarea', {
    id: 'chat-input',
    placeholder: isImageMode() ? t('chat.imagePlaceholder') : t('chat.messagePlaceholder', { name: data.name }),
    rows: 1,
  });
  const baseInputHeight = () =>
    Math.max(38, Math.min(state.settings.chatInputHeight ?? 38, Math.round(window.innerHeight * 0.5)));
  const autoGrow = () => {
    const base = baseInputHeight();
    input.style.height = 'auto';
    input.style.height = `${Math.min(Math.max(input.scrollHeight + 2, base), Math.max(280, base))}px`;
  };
  input.addEventListener('input', autoGrow);
  input.addEventListener('input', () => { if (draftKey) stashDraft(draftKey, input); });
  const inputResizer = el('div', { id: 'input-resizer', title: t('chat.resizeInputTitle') });
  inputResizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = input.getBoundingClientRect().height;
    const move = (ev) => {
      state.settings.chatInputHeight = Math.round(
        Math.max(38, Math.min(startH + (startY - ev.clientY), window.innerHeight * 0.5))
      );
      autoGrow();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      scheduleSettingsSave();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  inputResizer.addEventListener('dblclick', () => {
    state.settings.chatInputHeight = 38;
    scheduleSettingsSave();
    autoGrow();
  });
  input.addEventListener('keydown', (e) => {
    // Never send while an IME composition is active (CJK input confirms
    // conversions with Enter; keyCode 229 covers older Chromium quirks)
    if (e.key === 'Enter' && (e.isComposing || e.keyCode === 229)) return;
    const sendKey = state.settings.sendOnEnter
      ? e.key === 'Enter' && !e.shiftKey
      : e.key === 'Enter' && (e.metaKey || e.ctrlKey);
    if (sendKey) {
      e.preventDefault();
      sendMessage();
      return;
    }
    // ArrowUp in an empty input edits your last message (standard chat idiom)
    if (e.key === 'ArrowUp' && !input.value && !isCurrentChatGenerating()) {
      const messages = state.currentChat?.messages ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].is_user) {
          e.preventDefault();
          editMessage(messages[i], i);
          return;
        }
      }
    }
  });

  // Pasted images become attachments
  input.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    for (const file of files) await stageFileObject(file);
    renderChat();
  });
  // Dropped files (anywhere on the chat) become attachments
  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', async (e) => {
    e.preventDefault();
    let staged = 0;
    for (const file of e.dataTransfer.files) {
      const path = window.tavern.misc?.pathForFile?.(file);
      try {
        if (path) {
          const attachment = await window.tavern.files.importUpload(path);
          pendingAttachments.push(attachment);
          warnUnreadableAttachment(attachment);
        } else {
          await stageFileObject(file);
        }
        staged++;
      } catch (err) {
        toast(t('chat.couldNotAttach', { name: file.name, msg: err.message }), 'error');
      }
    }
    if (staged) renderChat();
  });

  // Only the conversation whose draft is being impersonated has Send held;
  // the toggle itself is single-flight (one impersonation at a time).
  const impersonatingHere = impersonatingKey != null && impersonatingKey === draftKey;
  const sendBtn = isCurrentChatGenerating()
    ? el('button', { class: 'btn btn-danger', onclick: () => stopGeneration() }, t('chat.stop'))
    : el('button', { class: 'btn btn-primary', disabled: impersonatingHere, onclick: () => sendMessage() }, t('chat.send'));
  const attachBtn = iconBtn({ class: 'btn-icon attach-btn', title: t('chat.attachTitle'), 'aria-label': t('chat.attachTitle'), label: t('label.attach'), onclick: () => attachFiles() },
    '📎'
  );
  const impersonateBtn = !isChatMode()
    ? iconBtn({
          class: `btn-icon attach-btn${impersonatingHere ? ' active' : ''}`,
          title: t('chat.impersonateTitle', { name: userName() }),
          'aria-label': t('chat.impersonateAria'),
          label: t('label.impersonate'),
          disabled: isCurrentChatGenerating() || impersonatingKey != null,
          onclick: () => impersonate(),
        },
        impersonatingHere ? '…' : '👤'
      )
    : null;
  const imageGen = state.settings.imageGen ?? {};
  if (!imageGen.enabled) imageModes.clear();
  const imageMode = isImageMode();
  const imageBtn = imageGen.enabled
    ? iconBtn({
          class: `btn-icon attach-btn img-toggle${imageMode ? ' active' : ''}`,
          'aria-label': imageMode ? t('chat.imageModeOnAria') : t('chat.imageModeOffAria'),
          title: imageMode
            ? t('chat.imageModeOnTitle', { model: imageApiConfig().model })
            : t('chat.imageModeOffTitle', { model: imageApiConfig().model }),
          label: t('label.image'),
          onclick: () => {
            if (draftKey == null) return;
            if (imageModes.get(draftKey)) imageModes.delete(draftKey);
            else imageModes.set(draftKey, true);
            renderChat();
          },
        },
        '🎨'
      )
    : null;

  if (pendingAttachments.length) {
    root.append(
      el(
        'div',
        { id: 'attachment-chips' },
        pendingAttachments.map((a, i) =>
          el(
            'span',
            { class: 'attachment-chip' },
            a.kind === 'image' ? '🖼 ' : '📄 ',
            a.name,
            el('button', {
              class: 'chip-remove',
              title: t('chat.remove'),
              'aria-label': `${t('chat.remove')} ${a.name}`,
              onclick: () => {
                pendingAttachments.splice(i, 1);
                renderChat();
              },
            }, '×')
          )
        )
      )
    );
  }
  root.append(inputResizer, el('div', { id: 'chat-input-bar' }, attachBtn, imageBtn, impersonateBtn, input, sendBtn));
  // Live token estimate for the draft, alongside the key hints
  const draftTokens = el('span', { id: 'draft-tokens' });
  const updateDraftTokens = () => {
    draftTokens.textContent = input.value.trim()
      ? t('chat.draftTokens', { count: estimateTokens(input.value).toLocaleString() })
      : '';
  };
  input.addEventListener('input', updateDraftTokens);
  root.append(
    el(
      'div',
      { class: 'input-hint' },
      el('span', {}, state.settings.sendOnEnter ? t('chat.hintEnter') : t('chat.hintMetaEnter', { mod: MOD })),
      draftTokens
    )
  );

  main.append(root);
  if (draft?.value) input.value = draft.value;
  autoGrow();
  updateDraftTokens();
  // Restore scroll unless explicitly jumping (chat switch) or the user was
  // already following the bottom.
  if (scrollBottom || !prevScroll || followingBottom) {
    scrollToBottom(true);
    // Right after a rebuild, layout keeps settling for a few frames (image
    // decode, content-visibility estimates). Hold the anchor while it does;
    // a user scrolling away flips followingBottom and stops the pinning.
    const settle = (frames) => {
      if (frames <= 0 || !followingBottom) return;
      scrollToBottom(true);
      requestAnimationFrame(() => settle(frames - 1));
    };
    requestAnimationFrame(() => settle(12));
  } else {
    const anchorEl =
      prevScroll.anchorIndex != null
        ? messagesEl.querySelector(`[data-index="${prevScroll.anchorIndex}"]`)
        : null;
    const restore = () => {
      messagesEl.scrollTop = anchorEl
        ? anchorEl.offsetTop - prevScroll.anchorOffset
        : prevScroll.top;
    };
    restore();
    followingBottom = false;
    // Re-apply while content-visibility height estimates settle, same as the
    // bottom-anchored path; a user scroll to the bottom flips followingBottom
    // and stops the hold.
    const settleAnchor = (frames) => {
      if (frames <= 0 || followingBottom) return;
      restore();
      requestAnimationFrame(() => settleAnchor(frames - 1));
    };
    requestAnimationFrame(() => settleAnchor(12));
  }
  if (!isCurrentChatGenerating()) {
    input.focus();
    if (draft?.value) {
      input.setSelectionRange(draft.selStart ?? input.value.length, draft.selEnd ?? input.value.length);
    }
  }
}

function uploadURL(file) {
  return `tavern://data/uploads/${encodeURIComponent(file)}`;
}

/** Save an upload to disk; the dialog defaults to the Downloads folder. */
async function saveAttachmentToDisk(a) {
  try {
    const dest = await window.tavern.files.exportUpload(a.file);
    if (dest) toast(t('chat.savedTo', { dest }), 'ok');
  } catch (err) {
    toast(t('chat.saveFailed', { msg: err.message }), 'error');
  }
}

function openImageViewer(a) {
  modal(
    el(
      'div',
      { class: 'image-viewer-box' },
      el('img', { class: 'image-viewer', src: uploadURL(a.file), alt: a.name }),
      el(
        'div',
        { class: 'modal-actions', style: { alignItems: 'center', justifyContent: 'space-between' } },
        el('span', { class: 'hint' }, a.name),
        el('button', { class: 'btn btn-primary', onclick: () => saveAttachmentToDisk(a) }, t('chat.saveImage'))
      )
    ),
    { width: 900 }
  );
}

function attachmentStrip(msg) {
  const attachments = msg.extra?.attachments ?? [];
  if (!attachments.length) return null;
  return el(
    'div',
    { class: 'msg-attachments' },
    attachments.map((a) =>
      a.kind === 'image'
        ? el(
            'div',
            { class: 'msg-attachment-frame' },
            el('img', {
              class: 'msg-attachment-img',
              src: uploadURL(a.file),
              alt: a.name,
              title: t('chat.attachmentView', { name: a.name }),
              onclick: () => openImageViewer(a),
              // Lazy: a chat with hundreds of generated images must not fetch
              // and decode them all on open. Images load after the scroll
              // position is set and grow the message under the viewport — the
              // resize observer re-anchors unless the user scrolled away.
              loading: 'lazy',
              decoding: 'async',
            }),
            iconBtn({
              class: 'btn-icon img-save-btn',
              title: t('chat.saveImageTitle'),
              'aria-label': t('chat.saveImage'),
          label: t('label.save'),
              onclick: (e) => {
                e.stopPropagation();
                saveAttachmentToDisk(a);
              },
            }, '⬇')
          )
        : el('span', { class: 'attachment-chip' }, '📄 ', a.name)
    )
  );
}

function messageEl(msg, index, persona = activePersona(), lastAssistant = lastAssistantIndex()) {
  const isUser = !!msg.is_user;
  const av = isUser
    ? avatar(personaAvatarURL(persona), msg.name, 34)
    : avatar(avatarURL(state.selectedCharacter), msg.name, 34);

  const content = el('div', { class: 'msg-content' });
  if (msg.__streaming && !msg.mes) {
    content.append(streamingDots());
  } else {
    content.innerHTML = renderedMarkdown(msg);
  }
  if (msg.__streaming) {
    streamingMsgEl = content;
    content.setAttribute('aria-live', 'polite');
    // Delegated (the block is rebuilt every repaint frame): a manual toggle
    // makes the user's open/closed choice stick for the rest of the stream.
    content.addEventListener('click', (e) => {
      if (!e.target.closest('.thinking-block > summary')) return;
      thinkingToggled.add(msg);
      // Reopening mid-stream should resume at the live tail, not the top
      // (closed <details> zero out their text's scroll state). rAF: the
      // toggle's default action lands after this event, and a repaint may
      // swap the element in between — re-query the live one.
      requestAnimationFrame(() => {
        const text = content.querySelector('.thinking-block[open] > .thinking-text');
        if (text) text.scrollTop = text.scrollHeight;
      });
    });
  }
  content.addEventListener('dblclick', () => {
    if (!msg.__streaming && !isCurrentChatGenerating()) editMessage(msg, index);
  });

  const isLastAssistant = !isUser && index === lastAssistant;
  const actions = el(
    'div',
    { class: 'msg-actions' },
    iconBtn({ class: 'btn-icon', title: t('common.copy'), 'aria-label': t('chat.copyMessage'), label: t('label.copy'), onclick: () => { navigator.clipboard.writeText(msg.mes); toast(t('common.copied')); } }, '⧉'),
    iconBtn({ class: 'btn-icon', title: t('chat.edit'), 'aria-label': t('chat.editMessage'), label: t('label.edit'), onclick: () => editMessage(msg, index) }, '✎'),
    isLastAssistant
      ? iconBtn({ class: 'btn-icon', title: t('chat.regenerateTitle', { mod: MOD }), 'aria-label': t('chat.regenerateAria'), label: t('label.regenerate'), onclick: () => regenerateLast() }, '↻')
      : null,
    isLastAssistant && msg.mes.trim()
      ? iconBtn({ class: 'btn-icon', title: t('chat.continueResponse'), 'aria-label': t('chat.continueResponse'), label: t('label.cont'), onclick: () => continueLast() }, '⤻')
      : null,
    iconBtn({ class: 'btn-icon', title: t('chat.branch'), 'aria-label': t('chat.branch'), label: t('label.branch'), onclick: () => branchFrom(index) }, '⑂'),
    // No delete on the message still being streamed into — the run owns it
    msg.__streaming
      ? null
      : iconBtn({ class: 'btn-icon', title: t('common.delete'), 'aria-label': t('chat.deleteMessage'), label: t('label.delete'), onclick: () => deleteMessage(index) }, '🗑')
  );

  const body = el(
    'div',
    { class: 'msg-body' },
    el(
      'div',
      { class: 'msg-header' },
      el('span', { class: 'msg-name' }, msg.name),
      el('span', {
        class: 'msg-time',
        title: msg.extra?.cost
          ? t('chat.costTooltip', {
              inTokens: msg.extra.cost.inTokens.toLocaleString(),
              outTokens: msg.extra.cost.outTokens.toLocaleString(),
            }) +
            (msg.extra.cost.cachedTokens
              ? ` · ${t('chat.costCachedTooltip', { cached: msg.extra.cost.cachedTokens.toLocaleString() })}`
              : '') +
            (msg.extra.cost.usd != null
              ? ` · ${msg.extra.cost.exact ? '' : '~'}${formatUSD(msg.extra.cost.usd)}`
              : '') +
            (msg.extra.cost.model ? ` · ${msg.extra.cost.model}` : '')
          : undefined,
      }, formatTime(msg.send_date)),
      actions
    ),
    attachmentStrip(msg),
    content
  );

  // Swipe bar: the last assistant message can view and generate alternatives;
  // older messages with stored swipes can still be paged through.
  const canGenerate = isLastAssistant;
  if (!isUser && !msg.__streaming && !isCurrentChatGenerating() && (canGenerate || (msg.swipes?.length ?? 0) > 1)) {
    const count = msg.swipes?.length ?? 1;
    const current = (msg.swipe_id ?? 0) + 1;
    body.append(
      el(
        'div',
        { class: 'swipe-bar' },
        iconBtn({ class: 'btn-icon', title: t('chat.prevResponse'), 'aria-label': t('chat.prevResponse'), label: t('label.prev'), disabled: current <= 1, onclick: () => swipeAt(index, -1) }, '‹'),
        el('span', {}, `${current} / ${count}`),
        iconBtn({
          class: 'btn-icon',
          title: count > current ? t('chat.nextResponse') : t('chat.generateAlternative'),
          'aria-label': count > current ? t('chat.nextResponse') : t('chat.generateAlternative'),
          label: t('label.next'),
          disabled: !canGenerate && current >= count,
          onclick: () => swipeAt(index, 1),
        }, '›')
      )
    );
  }

  const node = el('div', { class: `msg${isUser ? ' user' : ''}`, dataset: { index } }, av, body);
  node.style.containIntrinsicSize = `auto ${estimateHeight(msg)}px`;
  msgForNode.set(node, msg);
  return node;
}
const msgForNode = new WeakMap(); // .msg element -> message, for height measurement

function lastAssistantIndex(chat = state.currentChat) {
  const messages = chat?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!messages[i].is_user && !messages[i].is_system) return i;
  }
  return -1;
}

function scrollToBottom(force) {
  const elMessages = document.getElementById('messages');
  if (!elMessages) return;
  // Non-forced calls (streaming chunks) follow the user's intent, never
  // their proximity — a user who scrolled up stays where they are
  if (force || followingBottom) {
    elMessages.scrollTop = elMessages.scrollHeight;
    followingBottom = true;
  }
}

// ---------------------------------------------------------------------------
// Attachments

const attachFilters = () => [
  { name: t('chat.filterImagesText'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'txt', 'md', 'csv', 'log', 'json', 'xml', 'yaml', 'yml', 'html', 'css', 'js', 'ts', 'py', 'pdf'] },
  { name: t('chat.filterAll'), extensions: ['*'] },
];

/** Attachments the model can't read (PDF etc.) are sent as a filename mention only — say so. */
function warnUnreadableAttachment(attachment) {
  if (attachment?.kind === 'file') {
    toast(t('chat.unreadableAttachment', { name: attachment.name }));
  }
}

async function attachFiles() {
  const files = await window.tavern.dialog.openFile({ multi: true, filters: attachFilters() });
  let staged = 0;
  for (const path of files) {
    try {
      const attachment = await window.tavern.files.importUpload(path);
      pendingAttachments.push(attachment);
      warnUnreadableAttachment(attachment);
      staged++;
    } catch (err) {
      toast(t('chat.couldNotAttachFile', { msg: err.message }), 'error');
    }
  }
  if (staged) renderChat();
}

/** Stage a File object (paste / browser-style drop) by reading it as a data URL. */
async function stageFileObject(file) {
  const dataURL = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
  try {
    pendingAttachments.push(await window.tavern.files.saveUpload(file.name || 'pasted.png', dataURL));
  } catch (err) {
    toast(t('chat.couldNotAttach', { name: file.name || 'file', msg: err.message }), 'error');
  }
}

/**
 * Copy history messages, resolving upload attachments into prompt-ready data
 * (images → data URLs, text files → contents). Cached per upload file.
 * Messages that cannot survive context trimming skip resolution entirely:
 * reading and base64-encoding images that will be dropped costs disk reads,
 * IPC copies, and LRU churn on every send. Twice the window is a conservative
 * bound — attachments only ever ADD tokens, so anything past it is trimmed
 * either way.
 */
async function resolveAttachments(messages, contextSize = 0) {
  let cutoff = 0; // oldest index whose attachments still get resolved
  if (contextSize > 0) {
    let tokens = 0;
    cutoff = messages.length;
    while (cutoff > 0 && tokens < contextSize * 2) {
      tokens += estimateTokens(messages[cutoff - 1].mes ?? '');
      cutoff--;
    }
  }
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const attachments = m.extra?.attachments;
    if (!attachments?.length || i < cutoff) {
      out.push(m);
      continue;
    }
    const resolved = [];
    for (const a of attachments) {
      let data = resolvedUploads.get(a.file);
      if (data) {
        resolvedUploads.delete(a.file); // re-insert below to mark most-recently-used
      } else {
        try {
          data = await window.tavern.files.readUpload(a.file);
        } catch {
          data = { kind: a.kind }; // missing file → name-only mention
        }
      }
      resolvedUploads.set(a.file, data);
      if (resolvedUploads.size > RESOLVED_UPLOADS_MAX) {
        resolvedUploads.delete(resolvedUploads.keys().next().value); // evict least-recently-used
      }
      resolved.push({ ...a, ...data });
    }
    out.push({ ...m, _attachments: resolved });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sending & generation

export async function sendMessage({ asImage = false } = {}) {
  if (isCurrentChatGenerating() || !state.selectedCharacter || !state.currentChat) return;
  // Pin the conversation now: every await below is a chance for the user to
  // switch chats, and the reply must land where the message was sent.
  const chat = state.currentChat;
  const character = state.selectedCharacter;
  const charName = character.card.data.name;
  const key = convKey(charName, chat.file);
  // Explicit request or the 🎨 toggle — either routes this turn to the image model
  const useImage = (asImage || imageModes.get(key) === true) && !!state.settings.imageGen?.enabled;
  const input = document.getElementById('chat-input');
  const text = input?.value.trim() ?? '';
  const attachments = pendingAttachments;
  const lastIsUser = chat.messages.at(-1)?.is_user;
  if (useImage && !text && !attachments.length) {
    toast(t('chat.describeImage'), 'error');
    return;
  }
  // Empty input only allowed to continue after a user msg
  if (!text && !attachments.length && !lastIsUser) return;

  if (text || attachments.length) {
    pushUndo();
    const userMsg = {
      name: userName(),
      is_user: true,
      send_date: nowISO(),
      mes: text,
      ...(attachments.length ? { extra: { attachments } } : {}),
    };
    chat.messages.push(userMsg);
    pendingAttachments = [];
    if (input) input.value = '';
    chatDrafts.delete(key);
    // Chat mode: title the conversation after its first message
    if (isChatMode() && !chat.metadata.title && text) {
      chat.metadata.title = truncateChars(text, 64);
      await persistChatFor(charName, chat);
      await refreshConversations();
    } else {
      await appendToChatFor(charName, chat, userMsg);
    }
  }
  // 🎨 routes this turn to the dedicated image provider/model
  await generateResponse({ chat, character, ...(useImage ? { configOverride: imageApiConfig() } : {}) });
}

// Models whose pricing was looked up but not found this session, so an
// unpriced model (custom server) doesn't refetch the list on every send
const pricingChecked = new Set(); // "provider|model"

/**
 * Effective context size for this request. Auto mode uses the model's
 * advertised max context; the first send with an unknown model fetches the
 * provider's model list once and the answer is cached (0 = the provider
 * doesn't report one), so later sends resolve synchronously. Falls back to
 * the manual context_size, where 0 means unlimited. The same fetch also
 * caches the model's pricing for cost estimates.
 */
async function resolveContextSize(config) {
  const p = config.params;
  const key = `${config.provider}|${config.model}`;
  let known = knownModelContext(config.provider, config.model);
  const needContext = p.context_size_auto && known === undefined;
  const needPricing =
    state.settings.showCostEstimates &&
    !knownModelPricing(config.provider, config.model) &&
    !pricingChecked.has(key);
  if (needContext || needPricing) {
    try {
      const models = await window.tavern.llm.models(config);
      const found = models.find((m) => m.id === config.model);
      if (found || known === undefined) {
        known = found?.context ?? 0;
        rememberModelContext(config.provider, config.model, known);
      }
      if (found?.pricing) rememberModelPricing(config.provider, config.model, found.pricing);
      pricingChecked.add(key);
    } catch {
      known = known ?? 0; // offline / unlistable server — retry next send, use manual for now
    }
  }
  if (!p.context_size_auto) return p.context_size;
  return known > 0 ? known : p.context_size;
}

async function generateResponse({
  historyUpTo = null,
  intoMessage = null,
  configOverride = null,
  chat = state.currentChat,
  character = state.selectedCharacter,
  // Failed-run cleanup hints (see finishGeneration): the swipe slot this
  // run pushed, or the text it cleared from an existing message.
  pushedSwipe = false,
  prevMes = null,
  prevDate = null,
} = {}) {
  if (!chat || !character || runForChat(chat)) return; // one run per conversation
  const charName = character.card.data.name;
  const config = configOverride ?? apiConfig(chat.metadata.model);
  const foreground = () => chat === state.currentChat && state.view === 'chat';
  setNotice(charName, chat.file, { error: null, finishReason: null, configOverride });

  if (PROVIDERS[config.provider].requiresKey && !config.apiKey) {
    setNotice(charName, chat.file, { error: t('chat.noKeyError', { label: PROVIDERS[config.provider].label }) });
    if (foreground()) renderChat();
    return;
  }
  // Register the run BEFORE the first await: a second Send (double-click,
  // Enter twice) during context/attachment resolution must see the chat as
  // busy, or two replies race into the same conversation.
  const requestId = uuid();
  const run = {
    requestId,
    character,
    charName,
    file: chat.file,
    chat,
    msg: intoMessage,
    configOverride,
    pushedSwipe,
    prevMes,
    prevDate,
    provider: config.provider,
    model: config.model,
    promptTokens: 0,
  };
  state.runs.set(requestId, run);
  let prompt;
  let stats;
  try {
    if (!configOverride) recordRecentModel(config);
    config.params.context_size = await resolveContextSize(config);

    // Compressed messages are represented by their summary, not resent verbatim
    const summary = chat.metadata.summary?.text ?? '';
    const summaryStart = Math.min(chat.metadata.summary?.upToIndex ?? 0, chat.messages.length);
    const fullHistory = historyUpTo === null ? chat.messages : chat.messages.slice(0, historyUpTo);
    const history = fullHistory.slice(Math.min(summaryStart, fullHistory.length));
    const chatHistory = await resolveAttachments(history.filter((m) => !m.__streaming), config.params.context_size);
    stats = {};
    prompt = buildMessages({
      character: character.card.data,
      chatHistory,
      userName: userName(),
      // Chat mode: plain assistant prompt, no role-play scaffolding
      systemPromptOverride: isChatMode() ? chatSystemPrompt() : state.settings.systemPromptOverride,
      worldInfoEntries: isChatMode() ? [] : applicableWorldEntries(state.worlds, character.filename),
      persona: activePersona(),
      reminderPrompt: isChatMode() ? '' : state.settings.reminderPrompt,
      authorsNote: chat.metadata.authorsNote?.text ?? '',
      authorsNoteDepth: chat.metadata.authorsNote?.depth ?? 4,
      summary,
      contextSize: config.params.context_size,
      maxResponseTokens: config.params.max_tokens,
      stats,
    });
  } catch (err) {
    // Nothing was sent: unregister the placeholder run so the chat isn't
    // stuck "generating", and report instead of throwing into a click handler
    state.runs.delete(requestId);
    devLog('ERR', err.message);
    setNotice(charName, chat.file, { error: decorateModelError(err.message, { imageTurn: !!configOverride }) });
    if (foreground()) renderChat();
    return;
  }
  // The chat may have been deleted or the run stopped while resolving
  if (!state.runs.has(requestId)) return;
  const trimmed = stats.trimmedCount ?? 0;
  setNotice(charName, chat.file, { trimmed });
  if (stats.loreDropped) {
    devLog('WARN', `${stats.loreDropped} triggered lore entries dropped — over the lore token budget for this ${config.params.context_size}-token context`);
  }
  if (stats.overflowTokens) {
    devLog('WARN', `prompt exceeds the context window by ~${stats.overflowTokens} tokens even after trimming — the card, lore, and newest message alone don't fit`);
  }

  let msg = intoMessage;
  if (!msg) {
    msg = { name: charName, is_user: false, send_date: nowISO(), mes: '' };
    chat.messages.push(msg);
    newMessages.add(msg);
  }
  msg.__streaming = true;
  reasoningText.delete(msg); // a fresh attempt starts its thinking from scratch
  run.msg = msg;
  run.promptTokens = stats.promptTokens ?? 0; // for the post-reply cost estimate
  // Guarded here (not just inside devLog): stringifying the last message
  // would serialize any attached images' multi-MB data URLs on every send,
  // even with developer mode off.
  if (state.settings.developerMode) {
    const { images, ...lastMsg } = prompt.at(-1) ?? {};
    const imageNote = images?.length ? `[${images.length} image(s)] ` : '';
    devLog('REQ', `${config.provider}/${config.model} · ${prompt.length} messages · ~${stats.promptTokens} tokens${trimmed ? ` · ${trimmed} trimmed` : ''} · ${imageNote}${JSON.stringify(lastMsg)?.slice(0, 300)}`);
  }
  // A fresh send jumps to the new message; continuations (regenerate,
  // continue, image reroute) keep whatever position the user is at.
  if (foreground()) renderChat({ scrollBottom: !intoMessage });
  cb.renderSidebar?.(); // processing dots on the conversation row

  try {
    await window.tavern.llm.send(requestId, prompt, config);
    devLog('RES', `completed · ${msg.mes.length} chars`);
  } catch (err) {
    devLog('ERR', err.message);
    setNotice(charName, chat.file, { error: decorateModelError(err.message, { imageTurn: !!configOverride }) });
    await finishGeneration(run, { failed: true });
  }
}

/** Stop the given conversation's in-flight generation (default: the one on screen). */
export function stopGeneration(chat = state.currentChat) {
  const run = runForChat(chat);
  if (!run) return;
  if (!run.msg) {
    // Still resolving context/attachments — nothing was sent yet, so just
    // unregister; generateResponse notices and bails before sending.
    state.runs.delete(run.requestId);
    if (chat === state.currentChat && state.view === 'chat') renderChat();
    cb.renderSidebar?.();
    return;
  }
  window.tavern.llm.stop(run.requestId);
}

/** Retry after a failed generation (error-banner button). */
async function retryLast() {
  if (isCurrentChatGenerating()) return;
  const notice = currentNotice();
  if (state.currentChat && state.selectedCharacter) {
    setNotice(state.selectedCharacter.card.data.name, state.currentChat.file, { error: null });
  }
  // A failed 🎨 turn retries against the image model, not the chat model
  const configOverride = notice.configOverride ?? undefined;
  const messages = state.currentChat?.messages ?? [];
  if (messages.at(-1)?.is_user) await generateResponse({ configOverride });
  else await regenerateLast();
}

export async function regenerateLast({ chat = state.currentChat, character = state.selectedCharacter } = {}) {
  if (!chat || !character || runForChat(chat)) return;
  const idx = lastAssistantIndex(chat);
  if (idx < 0) return;
  if (chat === state.currentChat) pushUndo();
  const msg = chat.messages[idx];
  const prevMes = msg.mes;
  const prevDate = msg.send_date;
  msg.mes = '';
  if (msg.swipes) msg.swipes[msg.swipe_id ?? 0] = '';
  msg.send_date = nowISO();
  await generateResponse({ historyUpTo: idx, intoMessage: msg, chat, character, prevMes, prevDate });
}

/**
 * Resume a response that was truncated by the max-tokens limit: the partial
 * assistant message is sent as the last turn (a prefill for models that
 * support it) and new tokens are appended to it in place.
 */
async function continueLast() {
  if (isCurrentChatGenerating()) return;
  const idx = lastAssistantIndex();
  if (idx < 0) return;
  pushUndo();
  const msg = state.currentChat.messages[idx];
  const prevMes = msg.mes;
  msg.mes = msg.mes.replace(/\s+$/, ''); // no trailing whitespace in a prefill
  if (msg.swipes) msg.swipes[msg.swipe_id ?? 0] = msg.mes;
  await generateResponse({ historyUpTo: idx + 1, intoMessage: msg, prevMes });
}

async function swipeAt(idx, direction) {
  if (idx < 0 || isCurrentChatGenerating()) return;
  const msg = state.currentChat.messages[idx];
  if (!msg || msg.is_user) return;
  if (!msg.swipes) {
    msg.swipes = [msg.mes];
    msg.swipe_id = 0;
  }
  const target = (msg.swipe_id ?? 0) + direction;
  if (target < 0) return;
  if (target < msg.swipes.length) {
    msg.swipe_id = target;
    msg.mes = msg.swipes[target];
    await persistChat();
    renderChat();
  } else if (idx === lastAssistantIndex()) {
    // Generate a brand-new alternative (only the last message can grow)
    pushUndo();
    const prevDate = msg.send_date;
    msg.swipes.push('');
    msg.swipe_id = msg.swipes.length - 1;
    msg.mes = '';
    msg.send_date = nowISO();
    await generateResponse({ historyUpTo: idx, intoMessage: msg, pushedSwipe: true, prevDate });
  }
}

// ---------------------------------------------------------------------------
// Editing / deleting / undo

function editMessage(msg, index) {
  // No edits while this chat streams: a save's rewrite would race the
  // finishing run's append and duplicate the reply on disk
  if (isCurrentChatGenerating()) return;
  const messagesEl = document.getElementById('messages');
  const msgEl = messagesEl?.querySelector(`[data-index="${index}"] .msg-body`);
  if (!msgEl) return;
  clear(msgEl);
  // Pin the conversation: the handlers below await, and the user may switch
  // chats meanwhile — the save and the regenerated reply belong here.
  const chat = state.currentChat;
  const character = state.selectedCharacter;
  const charName = character.card.data.name;
  const textarea = el('textarea', { rows: 6 }, msg.mes);
  const save = async () => {
    if (chat === state.currentChat) pushUndo();
    msg.mes = textarea.value;
    if (msg.swipes) msg.swipes[msg.swipe_id ?? 0] = textarea.value;
    await persistChatFor(charName, chat);
  };
  // Editing a user message can re-run the reply from that point: the reply
  // to the latest message regenerates in place (keeping its swipes); editing
  // an older message first rewinds the conversation to it, so the edited
  // message becomes the newest and the fresh response follows it.
  const messages = state.currentChat?.messages ?? [];
  const lastIsReplyToThis =
    msg.is_user && index === messages.length - 2 && !messages.at(-1)?.is_user;
  const rewinds = msg.is_user && !lastIsReplyToThis && index < messages.length - 1;
  msgEl.append(
    el('div', { class: 'msg-edit-area' }, textarea),
    el(
      'div',
      { class: 'msg-edit-actions' },
      el('button', { class: 'btn btn-small', onclick: () => renderChat() }, t('common.cancel')),
      msg.is_user
        ? el(
            'button',
            {
              class: 'btn btn-small',
              title: rewinds ? t('chat.saveRegenRewindTitle', { mod: MOD }) : t('chat.saveRegenTitle'),
              onclick: async () => {
                if (runForChat(chat)) return;
                await save();
                if (lastIsReplyToThis) {
                  await regenerateLast({ chat, character });
                } else {
                  if (rewinds) {
                    // Same undo snapshot as the edit itself (save() pushed it)
                    chat.messages.splice(index + 1);
                    await persistChatFor(charName, chat);
                  }
                  await generateResponse({ chat, character });
                }
              },
            },
            t('chat.saveRegenerate')
          )
        : null,
      el(
        'button',
        {
          class: 'btn btn-primary btn-small',
          onclick: async () => {
            await save();
            renderChat();
          },
        },
        t('common.save')
      )
    )
  );
  textarea.focus();
}

async function deleteMessage(index) {
  // Same rule as editMessage/swipeAt: no array mutation while this chat
  // streams — the run's append/rewrite would race the delete on disk
  if (isCurrentChatGenerating() || !state.currentChat) return;
  pushUndo();
  state.currentChat.messages.splice(index, 1);
  await persistChat();
  renderChat();
}

export async function chatUndo() {
  // Undo swaps the messages array for a snapshot clone — never while a run
  // is streaming into the live array.
  if (isCurrentChatGenerating()) return;
  if (popUndo()) {
    await persistChat();
    renderChat();
    toast(t('chat.undone'));
  }
}

/** Copy messages 0..index into a fresh chat file and switch to it. */
async function branchFrom(index) {
  if (isCurrentChatGenerating() || !state.currentChat || !state.selectedCharacter) return;
  const charName = state.selectedCharacter.card.data.name;
  const src = state.currentChat;
  const branch = await window.tavern.chats.create(charName, userName());
  const messages = src.messages.slice(0, index + 1).map(({ __streaming, ...m }) => m);
  const metadata = {
    ...branch.metadata,
    ...(src.metadata.title ? { title: `${src.metadata.title}${t('chat.branchSuffix')}` } : {}),
    branchedFrom: { file: src.file, index },
  };
  // Branches never inherit the source's compression summary — the copied
  // messages are all present verbatim.
  delete metadata.summary;
  await window.tavern.chats.rewrite(charName, branch.file, metadata, messages);
  state.currentChat = { file: branch.file, metadata, messages };
  state.undoStack = [];
  if (isChatMode()) await refreshConversations();
  renderChat({ scrollBottom: true });
  toast(t('chat.branched'));
}

/**
 * Impersonate: ask the model to write the user's next message, placed into
 * the input for review rather than sent directly.
 */
async function impersonate() {
  if (isCurrentChatGenerating() || impersonatingKey != null || !state.currentChat || !state.selectedCharacter) return;
  const key = currentConvKey();
  const config = apiConfig(state.currentChat.metadata?.model);
  config.params.context_size = await resolveContextSize(config);
  const character = state.selectedCharacter.card.data;
  const name = userName();
  const summary = state.currentChat.metadata.summary?.text ?? '';
  const summaryStart = Math.min(state.currentChat.metadata.summary?.upToIndex ?? 0, state.currentChat.messages.length);
  const chatHistory = await resolveAttachments(
    state.currentChat.messages.slice(summaryStart).filter((m) => !m.__streaming),
    config.params.context_size
  );
  const prompt = buildMessages({
    character,
    chatHistory,
    userName: name,
    systemPromptOverride: isChatMode() ? chatSystemPrompt() : state.settings.systemPromptOverride,
    worldInfoEntries: isChatMode() ? [] : applicableWorldEntries(state.worlds, state.selectedCharacter.filename),
    persona: activePersona(),
    summary,
    contextSize: config.params.context_size,
    maxResponseTokens: config.params.max_tokens,
  });
  prompt.push({
    role: 'system',
    content: `Write ${name}'s next message in this conversation, from ${name}'s perspective and in ${name}'s voice. Reply with only the message text — no quotation wrapper, no name prefix.`,
  });
  const chatRef = state.currentChat;
  impersonatingKey = key;
  renderChat();
  try {
    const text = (await window.tavern.llm.complete(prompt, config))?.trim();
    impersonatingKey = null;
    if (state.currentChat !== chatRef) {
      // Switched away — park the draft in that conversation's own draft slot
      if (text) chatDrafts.set(key, { value: text, selStart: text.length, selEnd: text.length });
      return;
    }
    renderChat();
    const input = document.getElementById('chat-input');
    if (input && text) {
      input.value = text;
      input.dispatchEvent(new Event('input'));
      input.focus();
    }
  } catch (err) {
    impersonatingKey = null;
    if (state.currentChat === chatRef) renderChat();
    toast(t('chat.impersonateFailed', { msg: err.message }), 'error');
  }
}

/** Per-chat Author's Note: a style/direction note injected near the end of the prompt.
 *  Chat mode presents the same mechanism as per-conversation instructions. */
function openAuthorsNote() {
  const chat = state.currentChat;
  if (!chat) return;
  const chatty = isChatMode();
  const current = chat.metadata.authorsNote ?? { text: '', depth: 4 };
  const textarea = el('textarea', {
    rows: 5,
    placeholder: chatty ? t('chat.instructionsPlaceholder') : t('chat.authorsNotePlaceholder'),
  }, current.text ?? '');
  const depthInput = el('input', { type: 'number', min: 0, max: 20, value: current.depth ?? 4, style: { maxWidth: '80px' } });
  const content = el(
    'div',
    {},
    el('h2', {}, chatty ? t('chat.conversationInstructions') : t('chat.authorsNote')),
    el('p', { class: 'hint', style: { marginBottom: '10px' } },
      chatty ? t('chat.instructionsHint') : t('chat.authorsNoteHint')),
    textarea,
    chatty
      ? null
      : el('div', { class: 'form-inline', style: { marginTop: '10px' } },
          el('label', { style: { margin: 0 } }, t('chat.insertionDepth')), depthInput),
    el(
      'div',
      { class: 'modal-actions' },
      el('button', { class: 'btn', onclick: () => overlay.close() }, t('common.cancel')),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const text = textarea.value.trim();
          const depth = Math.max(0, Math.min(20, parseInt(depthInput.value, 10) || 4));
          if (text) chat.metadata.authorsNote = { text, depth };
          else delete chat.metadata.authorsNote;
          await persistChatMetadata(chat); // metadata-only: never rewrites a streaming reply
          overlay.close();
          renderChat();
          toast(text ? t('chat.authorsNoteSaved') : t('chat.authorsNoteCleared'), 'ok');
        },
      }, t('common.save'))
    )
  );
  const overlay = modal(content, { width: 540 });
  textarea.focus();
}

/** View, edit, or clear the running summary that stands in for compressed history. */
function openSummaryEditor() {
  const chat = state.currentChat;
  const summary = chat?.metadata?.summary;
  if (!chat || !summary) return;
  const textarea = el('textarea', { rows: 12 }, summary.text ?? '');
  const content = el(
    'div',
    {},
    el('h2', {}, t('chat.compressedHistory')),
    el('p', { class: 'hint', style: { marginBottom: '10px' } },
      t('chat.summaryHint', { count: Math.min(summary.upToIndex ?? 0, chat.messages.length) })),
    textarea,
    el(
      'div',
      { class: 'modal-actions', style: { justifyContent: 'space-between' } },
      el('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          delete chat.metadata.summary;
          await persistChatMetadata(chat);
          overlay.close();
          renderChat();
          toast(t('chat.summaryCleared'), 'ok');
        },
      }, t('chat.clearSummary')),
      el('div', { class: 'form-inline' },
        el('button', { class: 'btn', onclick: () => overlay.close() }, t('common.cancel')),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const text = textarea.value.trim();
            if (text) chat.metadata.summary = { ...summary, text };
            else delete chat.metadata.summary;
            await persistChatMetadata(chat);
            overlay.close();
            renderChat();
            toast(t('chat.summaryUpdated'), 'ok');
          },
        }, t('common.save')))
    )
  );
  const overlay = modal(content, { width: 620 });
}

/** Quick model switcher on the toolbar model chip. */
function openModelSwitcher() {
  const s = state.settings;
  const content = el('div', {}, el('h2', {}, t('chat.model')));
  const results = el('div', { class: 'search-results' });
  const pick = (provider, model) => {
    s.activeAPI = provider;
    s.models = s.models ?? {};
    s.models[provider] = model;
    // The fetched list knows the model's max context/pricing — keep both
    const picked = available.find((m) => m.id === model);
    if (picked) {
      rememberModelContext(provider, model, picked.context ?? 0);
      if (picked.pricing) rememberModelPricing(provider, model, picked.pricing);
    }
    // Each conversation remembers its model; new conversations use the global
    if (state.currentChat) {
      state.currentChat.metadata.model = { provider, model };
      void persistChatMetadata(state.currentChat);
    }
    scheduleSettingsSave();
    overlay.close();
    renderChat();
    toast(t('chat.switchedTo', { model }), 'ok');
  };
  const row = (provider, model, sub) =>
    el(
      'div',
      { class: 'list-row', role: 'option', tabindex: 0, onclick: () => pick(provider, model), onkeydown: activateOnEnter(() => pick(provider, model)) },
      el('div', { class: 'list-main' },
        el('div', { class: 'list-title' }, model),
        el('div', { class: 'list-sub' }, sub ?? PROVIDERS[provider].label))
    );

  const recents = (s.recentModels ?? []).filter(
    (r) => PROVIDERS[r.provider] && !(r.provider === s.activeAPI && r.model === apiConfig().model)
  );
  const filter = el('input', { type: 'text', placeholder: t('chat.searchModels') });
  let available = [];
  const renderList = () => {
    clear(results);
    const q = filter.value.trim().toLowerCase();
    if (!q && recents.length) {
      results.append(el('div', { class: 'hint', style: { margin: '6px 0' } }, t('chat.recent')));
      for (const r of recents.slice(0, 5)) results.append(row(r.provider, r.model));
    }
    const matches = available.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q));
    if (available.length) {
      results.append(el('div', { class: 'hint', style: { margin: '6px 0' } }, t('chat.providerModels', { label: PROVIDERS[s.activeAPI].label })));
      for (const m of matches.slice(0, 30)) {
        const parts = [];
        if (m.name && m.name !== m.id) parts.push(m.name);
        if (m.context) parts.push(t('chat.ctxTokens', { count: m.context.toLocaleString() }));
        const price = formatModelPricing(m.pricing);
        if (price) parts.push(price);
        results.append(row(s.activeAPI, m.id, parts.join(' · ') || undefined));
      }
      if (!matches.length) results.append(el('p', { class: 'hint' }, t('chat.noMatchingModels')));
    }
  };
  filter.addEventListener('input', renderList);
  window.tavern.llm
    .models(apiConfig())
    .then((models) => {
      available = models;
      renderList();
    })
    .catch((err) => {
      results.append(el('p', { class: 'hint', style: { color: 'var(--danger)' } }, t('chat.couldNotLoadModels', { msg: err.message })));
    });
  content.append(
    el('div', { class: 'form-inline' }, filter),
    results,
    el('div', { class: 'modal-actions' },
      el('button', { class: 'btn', onclick: () => { overlay.close(); cb.openSettings?.('api'); } }, t('chat.openAPISettings')))
  );
  const overlay = modal(content, { width: 520 });
  renderList();
  filter.focus();
}

/** Ctrl+Tab / Ctrl+Shift+Tab: cycle conversations (chat mode) or characters (role play). */
export async function cycleConversation(dir) {
  if (state.view !== 'chat') return;
  try {
    if (isChatMode()) {
      const list = state.conversations;
      if (list.length < 2) return;
      const idx = list.findIndex((c) => c.file === state.currentChat?.file);
      const next = list[(idx + dir + list.length) % list.length];
      if (next && next.file !== state.currentChat?.file) await selectConversation(next.file);
    } else {
      const list = state.characters;
      if (list.length < 2) return;
      const idx = list.findIndex((c) => c.filename === state.selectedCharacter?.filename);
      const next = list[((idx < 0 ? 0 : idx) + dir + list.length) % list.length];
      if (next && next.filename !== state.selectedCharacter?.filename) await selectCharacter(next);
    }
  } catch (err) {
    // Fired from a keyboard shortcut with nobody awaiting it — surface the failure
    devLog('ERR', `could not switch conversation: ${err.message}`);
    toast(err.message, 'error');
  }
}

/** Remember the chat model of each send for the quick switcher. */
function recordRecentModel(config) {
  const s = state.settings;
  const entry = { provider: config.provider, model: config.model };
  const list = (s.recentModels ?? []).filter((r) => !(r.provider === entry.provider && r.model === entry.model));
  list.unshift(entry);
  s.recentModels = list.slice(0, 8);
  scheduleSettingsSave();
}

// ---------------------------------------------------------------------------
// History & search modals

export async function openHistory() {
  if (!state.selectedCharacter) return;
  const charName = state.selectedCharacter.card.data.name;
  const chats = await window.tavern.chats.list(charName);
  const content = el(
    'div',
    {},
    el(
      'div',
      { class: 'form-inline', style: { justifyContent: 'space-between' } },
      el('h2', {}, t('chat.chatHistory')),
      el('button', {
        class: 'btn btn-small',
        title: t('chat.importChatTitle'),
        onclick: async () => {
          if (await importChatFile(charName)) overlay.close();
        },
      }, t('chat.importChat'))
    )
  );
  const list = el('div', { class: 'search-results' });
  if (!chats.length) list.append(el('p', { style: { color: 'var(--text-dim)' } }, t('chat.noPreviousChats')));
  for (const chatInfo of chats) {
    const isCurrent = chatInfo.file === state.currentChat?.file;
    const open = async () => { overlay.close(); await loadChat(chatInfo.file); };
    list.append(
      el(
        'div',
        { class: 'list-row', role: 'button', tabindex: 0, onkeydown: activateOnEnter(open) },
        el(
          'div',
          { class: 'list-main', onclick: open },
          el('div', { class: 'list-title' }, `${new Date(chatInfo.metadata.create_date ?? chatInfo.mtime).toLocaleString(currentLocale())}${isCurrent ? t('chat.currentMarker') : ''}`),
          el('div', { class: 'list-sub' }, `${t('common.nMessages', { count: chatInfo.messageCount })} · ${chatInfo.preview}`)
        ),
        iconBtn({ class: 'btn-icon', title: t('sidebar.exportMarkdown'), 'aria-label': t('sidebar.exportMarkdown'), label: t('label.markdown'), onclick: () => exportChat(charName, chatInfo.file, 'markdown') }, 'MD'),
        iconBtn({ class: 'btn-icon', title: t('sidebar.exportJSONL'), 'aria-label': t('sidebar.exportJSONL'), label: t('label.jsonl'), onclick: () => exportChat(charName, chatInfo.file, 'jsonl') }, '{}'),
        iconBtn({
          class: 'btn-icon',
          title: t('chat.deleteChat'),
          'aria-label': t('chat.deleteChat'),
          label: t('label.delete'),
          onclick: async () => {
            const ok = await confirmDialog(t('chat.deleteChatConfirm'));
            if (!ok) return;
            forgetChat(charName, chatInfo.file);
            await window.tavern.chats.delete(charName, chatInfo.file);
            if (isChatMode()) await refreshConversations();
            overlay.close();
            if (isCurrent) {
              const remaining = await window.tavern.chats.list(charName);
              if (remaining.length) await loadChat(remaining[0].file);
              else await newChat();
            }
            toast(t('chat.chatDeleted'));
          },
        }, '🗑')
      )
    );
  }
  content.append(list);
  const overlay = modal(content, { width: 580 });
}

async function exportChat(charName, file, format) {
  try {
    const saved = await window.tavern.chats.export(charName, file, format);
    if (saved) toast(t('chat.chatExported'), 'ok');
  } catch (err) {
    toast(t('common.exportFailed', { msg: err.message }), 'error');
  }
}

/** Export the open chat from the toolbar (history modal covers older chats). */
function exportCurrentChat() {
  if (!state.currentChat || !state.selectedCharacter) return;
  const charName = state.selectedCharacter.card.data.name;
  const file = state.currentChat.file;
  const content = el(
    'div',
    {},
    el('h2', {}, t('chat.exportChat')),
    el(
      'div',
      { class: 'modal-actions', style: { justifyContent: 'flex-start' } },
      el('button', { class: 'btn btn-primary', onclick: () => { overlay.close(); exportChat(charName, file, 'markdown'); } }, t('chat.exportMarkdown')),
      el('button', { class: 'btn btn-primary', onclick: () => { overlay.close(); exportChat(charName, file, 'jsonl'); } }, t('chat.exportJSONL')),
      el('button', {
        class: 'btn',
        onclick: () => {
          navigator.clipboard.writeText(
            state.currentChat.messages.map((m) => `${m.name}: ${m.mes}`).join('\n\n')
          );
          overlay.close();
          toast(t('chat.copiedToClipboard'), 'ok');
        },
      }, t('chat.copyAsText'))
    )
  );
  const overlay = modal(content, { width: 420 });
}

/** Import a SillyTavern/OpenChat JSONL chat file for the current character. */
async function importChatFile(charName) {
  const files = await window.tavern.dialog.openFile({
    filters: [{ name: t('chat.filterChatJSONL'), extensions: ['jsonl'] }],
  });
  if (!files?.[0]) return false;
  try {
    const { file, badLines } = await window.tavern.chats.import(charName, files[0]);
    toast(badLines ? t('chat.chatImportedSkipped', { count: badLines }) : t('chat.chatImported'), badLines ? 'info' : 'ok');
    if (isChatMode()) await refreshConversations();
    await loadChat(file);
    return true;
  } catch (err) {
    toast(t('common.importFailed', { msg: err.message }), 'error');
    return false;
  }
}

export function openSearch(initialQuery = '', initialScope = 'current') {
  const content = el('div', {}, el('h2', {}, t('chat.search')));
  const input = el('input', { type: 'text', placeholder: t('chat.searchMessages'), value: initialQuery });
  const scope = el(
    'select',
    { style: { width: 'auto' } },
    el('option', { value: 'current' }, t('chat.scopeCurrent')),
    el('option', { value: 'all' }, t('chat.scopeAll'))
  );
  scope.value = initialScope;
  const results = el('div', { class: 'search-results' });
  content.append(el('div', { class: 'form-inline' }, input, scope), results);
  const overlay = modal(content, { width: 620 });

  // Query token: a slow global search that resolves after the user typed
  // more must not paint stale rows over the newer query's results.
  let querySeq = 0;
  async function run() {
    const mine = ++querySeq;
    const q = input.value.trim();
    clear(results);
    if (q.length < 2) return;
    if (scope.value === 'current' && state.currentChat) {
      const matches = [];
      const folded = foldText(q);
      const messages = state.currentChat.messages;
      // Same cap as global search: a common word in a huge chat would
      // otherwise build thousands of result rows in one synchronous pass
      for (let index = 0; index < messages.length && matches.length < 200; index++) {
        const m = messages[index];
        if (foldText(m.mes ?? '').includes(folded)) matches.push({ m, index });
      }
      if (!matches.length) results.append(el('p', { style: { color: 'var(--text-dim)' } }, t('common.noMatches')));
      for (const { m, index } of matches) {
        results.append(
          searchRow(m.name, m.mes, q, () => {
            overlay.close();
            jumpToMessage(index);
          })
        );
      }
    } else {
      const charName = state.selectedCharacter?.card.data.name ?? null;
      // Chat mode: "all chats" means all assistant conversations
      const scopeName = isChatMode() ? ASSISTANT_NAME : scope.value === 'all' ? null : charName;
      const hits = await window.tavern.chats.search(q, scopeName);
      if (mine !== querySeq) return; // superseded by a newer query
      if (!hits.length) results.append(el('p', { style: { color: 'var(--text-dim)' } }, t('common.noMatches')));
      for (const hit of hits) {
        results.append(
          searchRow(`${hit.characterName} · ${hit.name}`, hit.snippet, q, async () => {
            overlay.close();
            if (isChatMode()) {
              await selectConversation(hit.file);
              jumpToMessage(hit.index);
              return;
            }
            const character = state.characters.find((c) => c.card.data.name === hit.characterName);
            if (character) {
              if (state.selectedCharacter?.filename !== character.filename) {
                state.selectedCharacter = character;
                cb.renderSidebar?.();
              }
              await loadChat(hit.file);
              jumpToMessage(hit.index);
            }
          })
        );
      }
    }
  }
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  scope.addEventListener('change', run);
  if (initialQuery) run();
  input.focus();
}

/** Enter/Space on a focusable non-button row activates it like a click. */
function activateOnEnter(fn) {
  return (e) => {
    if (e.target !== e.currentTarget) return; // buttons inside the row handle their own keys
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };
}

function searchRow(title, text, q, onclick) {
  const snippet = el('div', { class: 'list-sub search-snippet' });
  // Highlight on the RAW text and escape each segment separately: matching
  // against escaped HTML would let a query like "amp" hit inside "&amp;".
  const raw = text.slice(0, 200);
  const pattern = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  snippet.innerHTML = raw
    .split(pattern)
    .map((part, i) => (i % 2 === 1 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)))
    .join('');
  return el(
    'div',
    { class: 'list-row', role: 'button', tabindex: 0, onclick, onkeydown: activateOnEnter(onclick) },
    el('div', { class: 'list-main' }, el('div', { class: 'list-title' }, title), snippet)
  );
}

function jumpToMessage(index) {
  let target = document.querySelector(`#messages [data-index="${index}"]`);
  if (!target && index >= 0 && index < renderWindowStart) {
    // The hit is above the rendered window (windowed rendering) — widen the
    // window to include it, with some context above, then re-render.
    renderWindowStart = Math.max(0, index - 20);
    renderChat();
    target = document.querySelector(`#messages [data-index="${index}"]`);
  }
  if (target) {
    // The post-render settle loop pins the view to the bottom while following;
    // a search jump is an explicit navigation — stop following first or the
    // pin can yank the target back down before the scroll lands.
    followingBottom = false;
    target.scrollIntoView({ block: 'center' });
    // content-visibility resolves real heights only as regions come into
    // view: the first jump into a far part of a long chat lands on estimated
    // coordinates, then everything above re-sizes and shifts the target.
    // Re-align after layout settles (twice — estimates can cascade).
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        target.scrollIntoView({ block: 'center' });
        setTimeout(() => target.scrollIntoView({ block: 'center' }), 120);
      })
    );
    target.style.outline = '2px solid var(--accent)';
    target.style.borderRadius = '12px';
    setTimeout(() => {
      target.style.outline = '';
      target.style.borderRadius = '';
    }, 1600);
  }
}
