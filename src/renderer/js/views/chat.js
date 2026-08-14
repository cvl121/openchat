// Chat view: message list, streaming generation, swipes, editing, history,
// search, and export.

import { el, clear, uuid, nowISO, formatTime, toast, modal, confirmDialog, escapeHtml, formatUSD, formatModelPricing } from '../util.js';
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
import { estimateTokens } from '../util.js';
import { avatar, streamingDots } from '../components.js';
import { imageFollowupAction, decorateModelError, IMAGE_HINT_MESSAGE } from '../imageFlow.js';

const ASSISTANT_NAME = ASSISTANT_CHARACTER.card.data.name;

let cb = {}; // { renderSidebar, navigate, editCharacter }
let streamingMsgEl = null; // content element receiving chunks
// Unsent input, kept per conversation so switching away and back never loses
// a draft (and never leaks one into another conversation). In-memory only.
const chatDrafts = new Map(); // convKey -> {value, selStart, selEnd}
let renderedDraftKey = null; // conversation the live #chat-input belongs to
// Whether the view is anchored to the newest message. Distinct from a "near
// bottom" proximity check: an attachment image finishing its async load can
// grow a message by hundreds of pixels, leaving the viewport far from the
// bottom even though the user never scrolled away — intent has to be tracked,
// not inferred from distance. Cleared only by the user scrolling up.
let followingBottom = true;
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
let imageMode = false; // 🎨 toggle: while on, Send routes prompts to the image model
let impersonating = false; // an impersonate draft is being generated
let pendingAttachments = []; // uploads staged in the input bar, sent with the next message
const resolvedUploads = new Map(); // upload file -> {kind, dataURL?|text?} for prompt building

let renderQueued = false;

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
          streamingMsgEl.innerHTML = renderMarkdown(msg.mes);
          scrollToBottom(false);
        }
      });
    }
  });
  window.tavern.on('llm:done', async ({ requestId, finishReason }) => {
    const run = state.runs.get(requestId);
    if (!run) return;
    setNotice(run.charName, run.file, { finishReason: finishReason ?? null });
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
      return;
    } else if (action === 'hint') {
      setNotice(run.charName, run.file, { error: IMAGE_HINT_MESSAGE });
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
      // Remove empty failed responses; restore swipe view if it was a swipe attempt
      if (msg.swipes && msg.swipes.length > 1) {
        msg.swipes.pop();
        msg.swipe_id = msg.swipes.length - 1;
        msg.mes = msg.swipes[msg.swipe_id];
      } else {
        chat.messages.splice(chat.messages.indexOf(msg), 1);
      }
    }
  }
  // The cost estimate rides on the message itself, so persisting it costs no
  // extra writes (the append below carries it). Token counts are estimates;
  // dollar figures appear only when the model's pricing is known (OpenRouter).
  if (!failed && msg && chat.messages.includes(msg) && msg.mes.trim() && state.settings.showCostEstimates) {
    const outTokens = estimateTokens(msg.mes);
    const pricing = knownModelPricing(run.provider, run.model);
    msg.extra = msg.extra ?? {};
    msg.extra.cost = {
      model: run.model,
      inTokens: run.promptTokens ?? 0,
      outTokens,
      ...(pricing ? { usd: ((run.promptTokens ?? 0) * pricing.inPerM + outTokens * pricing.outPerM) / 1e6 } : {}),
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
  if (onScreen) {
    renderChat();
    void maybeCompressChat(); // background; re-renders when done
  }
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
  const placeholder = (chat.messages.find((m) => m.is_user)?.mes ?? '').slice(0, 64);
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
              'Write a title of at most six words for this conversation. Reply with only the title — no quotes, no trailing punctuation.',
          },
          { role: 'user', content: transcript },
        ],
        config
      )
    )
      ?.trim()
      .replace(/^["'“]+|["'”]+$/g, '')
      .slice(0, 64);
    if (!text) return;
    if (chat.metadata.title && chat.metadata.title !== placeholder) return; // renamed mid-flight
    await renameConversation(chat.file, text);
  } catch (err) {
    devLog('INFO', `auto-title skipped: ${err.message}`); // placeholder title remains
  }
}

// ---------------------------------------------------------------------------
// Chat compression: once a chat outgrows the threshold, summarize the older
// messages with one cheap non-streaming call so every following turn stops
// resending the full history.

const COMPRESS_KEEP_RECENT = 16; // newest messages always sent verbatim
let compressing = false;

async function maybeCompressChat() {
  const cfg = state.settings.chatCompression;
  if (!cfg?.enabled || compressing || isCurrentChatGenerating()) return;
  const chat = state.currentChat;
  if (!chat || !state.selectedCharacter) return;
  const threshold = Math.max(20, cfg.afterMessages ?? 60);
  const start = Math.min(chat.metadata.summary?.upToIndex ?? 0, chat.messages.length);
  if (chat.messages.length - start <= threshold) return;
  const end = chat.messages.length - COMPRESS_KEEP_RECENT;
  if (end <= start) return;

  compressing = true;
  const chatRef = chat;
  try {
    const slice = chat.messages.slice(start, end);
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
    const config = apiConfig(chat.metadata.model);
    config.params.max_tokens = Math.min(1024, config.params.max_tokens || 1024);
    devLog('INFO', `compressing ${slice.length} older messages (threshold ${threshold})…`);
    const text = (await window.tavern.llm.complete(request, config))?.trim();
    if (!text) return;
    if (state.currentChat !== chatRef) return; // user switched chats mid-flight
    if (runForChat(chatRef)) return; // a generation started meanwhile — don't clobber its rewrite
    chatRef.metadata.summary = { text, upToIndex: end };
    await persistChat();
    devLog('INFO', `compressed ${end - start} messages into a ~${estimateTokens(text)}-token summary`);
    if (state.view === 'chat' && !isCurrentChatGenerating()) renderChat();
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
async function persistChatMetadata(chat) {
  if (!chat || !state.selectedCharacter) return;
  await window.tavern.chats.rewrite(
    state.selectedCharacter.card.data.name,
    chat.file,
    chat.metadata,
    chat.messages.filter((m) => !newMessages.has(m)).map(({ __streaming, ...m }) => m)
  );
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
  if (chats.length) {
    await loadChat(chats[0].file); // reuses a live run's chat, clears unread
  } else {
    await newChat({ render: false });
    renderChat({ scrollBottom: true });
  }
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
  state.view = 'chat';
  state.selectedCharacter = ASSISTANT_CHARACTER;
  pendingAttachments = [];
  await loadChat(file);
}

export async function deleteConversation(file) {
  // Drop the run from the registry BEFORE aborting: with the run already
  // gone, the aborted llm:error event no-ops instead of persisting into
  // (and thereby resurrecting) the deleted file.
  const run = runFor(ASSISTANT_NAME, file);
  if (run) {
    state.runs.delete(run.requestId);
    window.tavern.llm.stop(run.requestId);
  }
  clearUnread(ASSISTANT_NAME, file);
  chatDrafts.delete(convKey(ASSISTANT_NAME, file));
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
  await window.tavern.chats.rewrite(
    ASSISTANT_NAME,
    file,
    chat.metadata,
    chat.messages.filter((m) => !newMessages.has(m)).map(({ __streaming, ...m }) => m)
  );
  await refreshConversations();
  if (state.currentChat?.file === file && state.view === 'chat') renderChat();
}

// ---------------------------------------------------------------------------

export async function newChat({ render = true } = {}) {
  const character = state.selectedCharacter;
  if (!character) return;
  const data = character.card.data;
  state.currentChat = await window.tavern.chats.create(data.name, userName());
  state.undoStack = [];
  pendingAttachments = [];
  if (isChatMode()) await refreshConversations();

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
    state.currentChat.messages.push(greeting);
    await persistChat();
  }
  if (render) renderChat({ scrollBottom: true });
}

export async function loadChat(file) {
  const charName = state.selectedCharacter.card.data.name;
  // A mid-stream run keeps its chat live in memory — reuse it so the reply
  // keeps streaming in place instead of loading the stale on-disk copy.
  const run = runFor(charName, file);
  state.currentChat = run ? run.chat : await window.tavern.chats.load(charName, file);
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
  const prevInput = document.getElementById('chat-input');
  let draft = prevInput
    ? {
        value: prevInput.value,
        focused: document.activeElement === prevInput,
        selStart: prevInput.selectionStart,
        selEnd: prevInput.selectionEnd,
      }
    : null;
  // Same conversation: carry the live draft across the rebuild. Different
  // conversation: stash the old draft under its own key and pull this
  // conversation's stored draft instead.
  const draftKey =
    state.currentChat && state.selectedCharacter
      ? convKey(state.selectedCharacter.card.data.name, state.currentChat.file)
      : null;
  if (renderedDraftKey !== draftKey) {
    if (renderedDraftKey != null && draft) {
      if (draft.value) chatDrafts.set(renderedDraftKey, draft);
      else chatDrafts.delete(renderedDraftKey);
    }
    draft = draftKey ? (chatDrafts.get(draftKey) ?? null) : null;
  }
  renderedDraftKey = draftKey;

  clear(main);

  if (!state.selectedCharacter) {
    main.append(
      isChatMode()
        ? el(
            'div',
            { class: 'empty-state' },
            el('h2', {}, 'Welcome to OpenChat'),
            el('p', {}, 'Start a conversation with the assistant, or add an API key in Settings first.'),
            el('button', { class: 'btn btn-primary', onclick: () => enterChatMode() }, '+ New Chat')
          )
        : el(
            'div',
            { class: 'empty-state' },
            el('h2', {}, 'Welcome to OpenChat'),
            el('p', {}, 'Select a character from the sidebar, or create a new one to start chatting.'),
            el('button', { class: 'btn btn-primary', onclick: () => cb.editCharacter?.(null) }, '+ New Character')
          )
    );
    return;
  }

  const data = state.selectedCharacter.card.data;
  const config = apiConfig(state.currentChat?.metadata?.model);
  const notice = currentNotice();
  const chatTitle = isChatMode()
    ? state.currentChat?.metadata?.title || 'New conversation'
    : data.name;

  const allMessages = state.currentChat?.messages ?? [];
  // Estimate what actually gets sent: summary stands in for compressed messages
  const compressedCount = Math.min(state.currentChat?.metadata?.summary?.upToIndex ?? 0, allMessages.length);
  const costTotal = state.settings.showCostEstimates
    ? allMessages.reduce((sum, m) => sum + (m.extra?.cost?.usd ?? 0), 0)
    : 0;
  const tokenEstimate = estimateTokens(
    allMessages.slice(compressedCount).map((m) => m.mes).join(' ') +
      (state.currentChat?.metadata?.summary?.text ?? '') +
      (data.description ?? '')
  );
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
          `${allMessages.length} messages · ~${tokenEstimate.toLocaleString()} tokens`,
          compressedCount > 0
            ? el(
                'span',
                {
                  class: 'meta-link',
                  title: 'View or edit the compressed-history summary',
                  onclick: () => openSummaryEditor(),
                },
                ` · ${compressedCount} compressed`
              )
            : null,
          notice.trimmed > 0 ? ` · ${notice.trimmed} oldest not sent (context full)` : null,
          costTotal > 0 ? ` · ~${formatUSD(costTotal)}` : null
        )
      ),
      el(
        'button',
        {
          class: 'model-chip',
          title: `${PROVIDERS[config.provider].label} · ${config.model} — click to switch models`,
          'aria-label': 'Switch model',
          onclick: () => openModelSwitcher(),
        },
        config.model || 'Choose model…'
      ),
      el('button', {
        class: `btn-icon${state.currentChat?.metadata?.authorsNote?.text ? ' active' : ''}`,
        title: isChatMode() ? 'Instructions for this conversation' : "Author's note for this chat",
        'aria-label': isChatMode() ? 'Conversation instructions' : "Author's note",
        onclick: () => openAuthorsNote(),
      }, '📝'),
      el('button', { class: 'btn-icon', title: 'Search (⌘F)', 'aria-label': 'Search', onclick: () => openSearch() }, '🔍'),
      el('button', { class: 'btn-icon', title: 'Chat history (⌘⇧H)', 'aria-label': 'Chat history', onclick: () => openHistory() }, '🕘'),
      el('button', { class: 'btn-icon', title: 'Export this chat', 'aria-label': 'Export this chat', onclick: () => exportCurrentChat() }, '⬆'),
      el('button', { class: 'btn-icon', title: 'New chat (⌘N)', 'aria-label': 'New chat', onclick: () => newChat() }, '＋')
    )
  );

  // Nothing configured yet: point straight at Settings instead of failing on send
  if (PROVIDERS[config.provider].requiresKey && !config.apiKey) {
    root.append(
      el(
        'div',
        { class: 'notice-banner' },
        el('span', {}, `Add your ${PROVIDERS[config.provider].label} API key to start chatting.`),
        el('button', { class: 'btn btn-primary btn-small', onclick: () => cb.openSettings?.('api') }, 'Open Settings')
      )
    );
  } else if (PROVIDERS[config.provider].requiresBaseURL && !config.baseURL) {
    root.append(
      el(
        'div',
        { class: 'notice-banner' },
        el('span', {}, 'Set the server URL for your custom provider to start chatting.'),
        el('button', { class: 'btn btn-primary btn-small', onclick: () => cb.openSettings?.('api') }, 'Open Settings')
      )
    );
  }

  const messagesEl = el('div', { id: 'messages' });
  const messages = state.currentChat?.messages ?? [];
  messages.forEach((msg, index) => messagesEl.append(messageEl(msg, index)));
  if (notice.error) {
    messagesEl.append(
      el(
        'div',
        { class: 'error-banner' },
        el('span', {}, notice.error),
        el('button', { class: 'btn btn-primary btn-small', onclick: () => retryLast() }, 'Retry'),
        el('button', { class: 'btn btn-small', onclick: () => { setNotice(data.name, state.currentChat.file, { error: null }); renderChat(); } }, 'Dismiss')
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
        el('span', {}, `Response hit the Max Response Tokens limit (${config.params.max_tokens.toLocaleString()}).`),
        el('button', { class: 'btn btn-primary btn-small', onclick: () => continueLast() }, 'Continue'),
        el('button', { class: 'btn btn-small', onclick: () => cb.openSettings?.('generation') }, 'Raise Limit'),
        el('button', { class: 'btn btn-small', onclick: () => { setNotice(data.name, state.currentChat.file, { finishReason: null }); renderChat(); } }, 'Dismiss')
      )
    );
  }
  root.append(messagesEl);

  // Floating scroll-to-bottom button for long chats
  const scrollBtn = el(
    'button',
    { id: 'scroll-bottom-btn', title: 'Jump to latest', onclick: () => scrollToBottom(true) },
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
  messagesEl.addEventListener('wheel', (e) => {
    if (e.deltaY < 0) followingBottom = false;
  }, { passive: true });
  messagesEl.addEventListener('scroll', () => {
    const distance = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    scrollBtn.classList.toggle('visible', distance > 300);
    if (messagesEl.scrollTop < lastScrollTop) followingBottom = false;
    else if (distance < 2) followingBottom = true;
    lastScrollTop = messagesEl.scrollTop;
  });
  // While following the newest message, any growth in a message re-anchors
  // the view: streamed text, attachment images finishing their async load,
  // and content-visibility re-estimating offscreen sizes all land here.
  messagesResizeObserver?.disconnect();
  messagesResizeObserver = new ResizeObserver(() => {
    if (followingBottom) scrollToBottom(true);
  });
  for (const child of messagesEl.children) messagesResizeObserver.observe(child, { box: 'border-box' });

  // Input bar — auto-grows with content up to a max height
  const input = el('textarea', {
    id: 'chat-input',
    placeholder: imageMode ? 'Describe an image to generate…' : `Message ${data.name}…`,
    rows: 1,
  });
  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight + 2, 280)}px`;
  };
  input.addEventListener('input', autoGrow);
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
        toast(`Could not attach ${file.name}: ${err.message}`, 'error');
      }
    }
    if (staged) renderChat();
  });

  const sendBtn = isCurrentChatGenerating()
    ? el('button', { class: 'btn btn-danger', onclick: () => stopGeneration() }, 'Stop')
    : el('button', { class: 'btn btn-primary', disabled: impersonating, onclick: () => sendMessage() }, 'Send');
  const attachBtn = el(
    'button',
    { class: 'btn-icon attach-btn', title: 'Attach images or files', 'aria-label': 'Attach images or files', onclick: () => attachFiles() },
    '📎'
  );
  const impersonateBtn = !isChatMode()
    ? el(
        'button',
        {
          class: `btn-icon attach-btn${impersonating ? ' active' : ''}`,
          title: `Impersonate — let the AI write ${userName()}'s next message into the input`,
          'aria-label': 'Impersonate: write my next message',
          disabled: isCurrentChatGenerating() || impersonating,
          onclick: () => impersonate(),
        },
        impersonating ? '…' : '👤'
      )
    : null;
  const imageGen = state.settings.imageGen ?? {};
  if (!imageGen.enabled) imageMode = false;
  const imageBtn = imageGen.enabled
    ? el(
        'button',
        {
          class: `btn-icon attach-btn img-toggle${imageMode ? ' active' : ''}`,
          'aria-label': imageMode ? 'Image mode on — switch back to the chat model' : 'Switch to image mode',
          title: imageMode
            ? `Image mode — messages generate images with ${imageApiConfig().model}. Click to switch back to the chat model.`
            : `Switch to image mode (${imageApiConfig().model})`,
          onclick: () => {
            imageMode = !imageMode;
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
              title: 'Remove',
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
  root.append(el('div', { id: 'chat-input-bar' }, attachBtn, imageBtn, impersonateBtn, input, sendBtn));
  // Live token estimate for the draft, alongside the key hints
  const draftTokens = el('span', { id: 'draft-tokens' });
  const updateDraftTokens = () => {
    draftTokens.textContent = input.value.trim() ? `~${estimateTokens(input.value).toLocaleString()} tokens` : '';
  };
  input.addEventListener('input', updateDraftTokens);
  root.append(
    el(
      'div',
      { class: 'input-hint' },
      el('span', {},
        state.settings.sendOnEnter ? 'Enter to send · Shift+Enter for newline · Esc to stop' : '⌘Enter to send · Esc to stop'),
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
    if (dest) toast(`Saved to ${dest}`, 'ok');
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
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
        el('button', { class: 'btn btn-primary', onclick: () => saveAttachmentToDisk(a) }, 'Save Image…')
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
              title: `${a.name} — click to view`,
              onclick: () => openImageViewer(a),
              // Images load after the scroll position is set and grow the
              // message under the viewport — re-anchor unless the user
              // deliberately scrolled away.
            }),
            el('button', {
              class: 'btn-icon img-save-btn',
              title: 'Save image (defaults to Downloads)',
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

function messageEl(msg, index) {
  const isUser = !!msg.is_user;
  const persona = activePersona();
  const av = isUser
    ? avatar(personaAvatarURL(persona), msg.name, 34)
    : avatar(avatarURL(state.selectedCharacter), msg.name, 34);

  const content = el('div', { class: 'msg-content' });
  if (msg.__streaming && !msg.mes) {
    content.append(streamingDots());
  } else {
    content.innerHTML = renderMarkdown(msg.mes);
  }
  if (msg.__streaming) {
    streamingMsgEl = content;
    content.setAttribute('aria-live', 'polite');
  }
  content.addEventListener('dblclick', () => {
    if (!msg.__streaming && !isCurrentChatGenerating()) editMessage(msg, index);
  });

  const isLastAssistant = !isUser && index === lastAssistantIndex();
  const actions = el(
    'div',
    { class: 'msg-actions' },
    el('button', { class: 'btn-icon', title: 'Copy', 'aria-label': 'Copy message', onclick: () => { navigator.clipboard.writeText(msg.mes); toast('Copied'); } }, '⧉'),
    el('button', { class: 'btn-icon', title: 'Edit', 'aria-label': 'Edit message', onclick: () => editMessage(msg, index) }, '✎'),
    isLastAssistant
      ? el('button', { class: 'btn-icon', title: 'Regenerate (⌘R)', 'aria-label': 'Regenerate response', onclick: () => regenerateLast() }, '↻')
      : null,
    isLastAssistant && msg.mes.trim()
      ? el('button', { class: 'btn-icon', title: 'Continue this response', 'aria-label': 'Continue this response', onclick: () => continueLast() }, '⤻')
      : null,
    el('button', { class: 'btn-icon', title: 'Branch a new chat from here', 'aria-label': 'Branch a new chat from here', onclick: () => branchFrom(index) }, '⑂'),
    el('button', { class: 'btn-icon', title: 'Delete', 'aria-label': 'Delete message', onclick: () => deleteMessage(index) }, '🗑')
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
          ? `~${msg.extra.cost.inTokens.toLocaleString()} in → ${msg.extra.cost.outTokens.toLocaleString()} out tokens` +
            (msg.extra.cost.usd != null ? ` · ~${formatUSD(msg.extra.cost.usd)}` : '') +
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
        el('button', { class: 'btn-icon', title: 'Previous response', 'aria-label': 'Previous response', disabled: current <= 1, onclick: () => swipeAt(index, -1) }, '‹'),
        el('span', {}, `${current} / ${count}`),
        el('button', {
          class: 'btn-icon',
          title: count > current ? 'Next response' : 'Generate alternative',
          'aria-label': count > current ? 'Next response' : 'Generate alternative',
          disabled: !canGenerate && current >= count,
          onclick: () => swipeAt(index, 1),
        }, '›')
      )
    );
  }

  return el('div', { class: `msg${isUser ? ' user' : ''}`, dataset: { index } }, av, body);
}

function lastAssistantIndex() {
  const messages = state.currentChat?.messages ?? [];
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

const ATTACH_FILTERS = [
  { name: 'Images & text files', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'txt', 'md', 'csv', 'log', 'json', 'xml', 'yaml', 'yml', 'html', 'css', 'js', 'ts', 'py', 'pdf'] },
  { name: 'All files', extensions: ['*'] },
];

/** Attachments the model can't read (PDF etc.) are sent as a filename mention only — say so. */
function warnUnreadableAttachment(attachment) {
  if (attachment?.kind === 'file') {
    toast(`${attachment.name}: the model will see the filename only — this file type isn't readable yet`);
  }
}

async function attachFiles() {
  const files = await window.tavern.dialog.openFile({ multi: true, filters: ATTACH_FILTERS });
  let staged = 0;
  for (const path of files) {
    try {
      const attachment = await window.tavern.files.importUpload(path);
      pendingAttachments.push(attachment);
      warnUnreadableAttachment(attachment);
      staged++;
    } catch (err) {
      toast(`Could not attach file: ${err.message}`, 'error');
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
    toast(`Could not attach ${file.name || 'file'}: ${err.message}`, 'error');
  }
}

/**
 * Copy history messages, resolving upload attachments into prompt-ready data
 * (images → data URLs, text files → contents). Cached per upload file.
 */
async function resolveAttachments(messages) {
  const out = [];
  for (const m of messages) {
    const attachments = m.extra?.attachments;
    if (!attachments?.length) {
      out.push(m);
      continue;
    }
    const resolved = [];
    for (const a of attachments) {
      let data = resolvedUploads.get(a.file);
      if (!data) {
        try {
          data = await window.tavern.files.readUpload(a.file);
        } catch {
          data = { kind: a.kind }; // missing file → name-only mention
        }
        resolvedUploads.set(a.file, data);
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
  // Explicit request or the 🎨 toggle — either routes this turn to the image model
  const useImage = (asImage || imageMode) && !!state.settings.imageGen?.enabled;
  const input = document.getElementById('chat-input');
  const text = input?.value.trim() ?? '';
  const attachments = pendingAttachments;
  const lastIsUser = state.currentChat.messages.at(-1)?.is_user;
  if (useImage && !text && !attachments.length) {
    toast('Describe the image you want to generate', 'error');
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
    state.currentChat.messages.push(userMsg);
    pendingAttachments = [];
    // Chat mode: title the conversation after its first message
    if (isChatMode() && !state.currentChat.metadata.title && text) {
      state.currentChat.metadata.title = text.slice(0, 64);
      await persistChat();
      await refreshConversations();
    } else {
      await appendToChat(userMsg);
    }
    if (input) input.value = '';
  }
  // 🎨 routes this turn to the dedicated image provider/model
  await generateResponse(useImage ? { configOverride: imageApiConfig() } : {});
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
} = {}) {
  if (!chat || !character || runForChat(chat)) return; // one run per conversation
  const charName = character.card.data.name;
  const config = configOverride ?? apiConfig(chat.metadata.model);
  const foreground = () => chat === state.currentChat && state.view === 'chat';
  setNotice(charName, chat.file, { error: null, finishReason: null, configOverride });

  if (PROVIDERS[config.provider].requiresKey && !config.apiKey) {
    setNotice(charName, chat.file, { error: `No API key set for ${PROVIDERS[config.provider].label}. Add one in Settings → API.` });
    if (foreground()) renderChat();
    return;
  }
  if (PROVIDERS[config.provider].requiresBaseURL && !config.baseURL) {
    setNotice(charName, chat.file, { error: 'No server URL set for the custom provider. Add one in Settings → API.' });
    if (foreground()) renderChat();
    return;
  }
  if (!configOverride) recordRecentModel(config);
  config.params.context_size = await resolveContextSize(config);

  // Compressed messages are represented by their summary, not resent verbatim
  const summary = chat.metadata.summary?.text ?? '';
  const summaryStart = Math.min(chat.metadata.summary?.upToIndex ?? 0, chat.messages.length);
  const fullHistory = historyUpTo === null ? chat.messages : chat.messages.slice(0, historyUpTo);
  const history = fullHistory.slice(Math.min(summaryStart, fullHistory.length));
  const chatHistory = await resolveAttachments(history.filter((m) => !m.__streaming));
  const stats = {};
  const prompt = buildMessages({
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
  const trimmed = stats.trimmedCount ?? 0;
  setNotice(charName, chat.file, { trimmed });

  let msg = intoMessage;
  if (!msg) {
    msg = { name: charName, is_user: false, send_date: nowISO(), mes: '' };
    chat.messages.push(msg);
    newMessages.add(msg);
  }
  msg.__streaming = true;

  const requestId = uuid();
  const run = {
    requestId,
    character,
    charName,
    file: chat.file,
    chat,
    msg,
    configOverride,
    // For the post-reply cost estimate
    provider: config.provider,
    model: config.model,
    promptTokens: stats.promptTokens ?? 0,
  };
  state.runs.set(requestId, run);
  devLog('REQ', `${config.provider}/${config.model} · ${prompt.length} messages · ~${stats.promptTokens} tokens${trimmed ? ` · ${trimmed} trimmed` : ''} · ${JSON.stringify(prompt.at(-1))?.slice(0, 300)}`);
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
  if (run) window.tavern.llm.stop(run.requestId);
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

export async function regenerateLast() {
  if (isCurrentChatGenerating()) return;
  const idx = lastAssistantIndex();
  if (idx < 0) return;
  pushUndo();
  const msg = state.currentChat.messages[idx];
  msg.mes = '';
  if (msg.swipes) msg.swipes[msg.swipe_id ?? 0] = '';
  msg.send_date = nowISO();
  await generateResponse({ historyUpTo: idx, intoMessage: msg });
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
  msg.mes = msg.mes.replace(/\s+$/, ''); // no trailing whitespace in a prefill
  if (msg.swipes) msg.swipes[msg.swipe_id ?? 0] = msg.mes;
  await generateResponse({ historyUpTo: idx + 1, intoMessage: msg });
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
    msg.swipes.push('');
    msg.swipe_id = msg.swipes.length - 1;
    msg.mes = '';
    msg.send_date = nowISO();
    await generateResponse({ historyUpTo: idx, intoMessage: msg });
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
  const textarea = el('textarea', { rows: 6 }, msg.mes);
  const save = async () => {
    pushUndo();
    msg.mes = textarea.value;
    if (msg.swipes) msg.swipes[msg.swipe_id ?? 0] = textarea.value;
    await persistChat();
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
      el('button', { class: 'btn btn-small', onclick: () => renderChat() }, 'Cancel'),
      msg.is_user
        ? el(
            'button',
            {
              class: 'btn btn-small',
              title: rewinds
                ? 'Save the edit, remove the messages after it, and regenerate the response (⌘Z undoes)'
                : 'Save the edit and regenerate the response',
              onclick: async () => {
                await save();
                if (lastIsReplyToThis) {
                  await regenerateLast();
                } else {
                  if (rewinds) {
                    // Same undo snapshot as the edit itself (save() pushed it)
                    state.currentChat.messages.splice(index + 1);
                    await persistChat();
                  }
                  await generateResponse();
                }
              },
            },
            'Save & Regenerate'
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
        'Save'
      )
    )
  );
  textarea.focus();
}

async function deleteMessage(index) {
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
    toast('Undone');
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
    ...(src.metadata.title ? { title: `${src.metadata.title} (branch)` } : {}),
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
  toast('Branched into a new chat — the original is in History');
}

/**
 * Impersonate: ask the model to write the user's next message, placed into
 * the input for review rather than sent directly.
 */
async function impersonate() {
  if (isCurrentChatGenerating() || impersonating || !state.currentChat || !state.selectedCharacter) return;
  const config = apiConfig(state.currentChat.metadata?.model);
  config.params.context_size = await resolveContextSize(config);
  const character = state.selectedCharacter.card.data;
  const name = userName();
  const summary = state.currentChat.metadata.summary?.text ?? '';
  const summaryStart = Math.min(state.currentChat.metadata.summary?.upToIndex ?? 0, state.currentChat.messages.length);
  const chatHistory = await resolveAttachments(
    state.currentChat.messages.slice(summaryStart).filter((m) => !m.__streaming)
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
  impersonating = true;
  renderChat();
  try {
    const text = (await window.tavern.llm.complete(prompt, config))?.trim();
    impersonating = false;
    if (state.currentChat !== chatRef) return; // switched away — don't drop the draft into another chat
    renderChat();
    const input = document.getElementById('chat-input');
    if (input && text) {
      input.value = text;
      input.dispatchEvent(new Event('input'));
      input.focus();
    }
  } catch (err) {
    impersonating = false;
    if (state.currentChat === chatRef) renderChat();
    toast(`Impersonate failed: ${err.message}`, 'error');
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
    placeholder: chatty
      ? 'e.g. "Answer in Spanish. I\'m a beginner programmer — explain code line by line."'
      : 'e.g. "Focus on the heist plan. Keep the pacing tense. No time skips."',
  }, current.text ?? '');
  const depthInput = el('input', { type: 'number', min: 0, max: 20, value: current.depth ?? 4, style: { maxWidth: '80px' } });
  const content = el(
    'div',
    {},
    el('h2', {}, chatty ? 'Conversation Instructions' : "Author's Note"),
    el('p', { class: 'hint', style: { marginBottom: '10px' } },
      chatty
        ? 'Extra instructions for this conversation only, injected near the end of the prompt where the model pays the most attention.'
        : 'Guidance for this chat only, injected near the end of the prompt where the model pays the most attention. Supports {{char}} and {{user}}.'),
    textarea,
    chatty
      ? null
      : el('div', { class: 'form-inline', style: { marginTop: '10px' } },
          el('label', { style: { margin: 0 } }, 'Insertion depth (messages from the end)'), depthInput),
    el(
      'div',
      { class: 'modal-actions' },
      el('button', { class: 'btn', onclick: () => overlay.close() }, 'Cancel'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const text = textarea.value.trim();
          const depth = Math.max(0, Math.min(20, parseInt(depthInput.value, 10) || 4));
          if (text) chat.metadata.authorsNote = { text, depth };
          else delete chat.metadata.authorsNote;
          await persistChat();
          overlay.close();
          renderChat();
          toast(text ? "Author's note saved" : "Author's note cleared", 'ok');
        },
      }, 'Save')
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
    el('h2', {}, 'Compressed History'),
    el('p', { class: 'hint', style: { marginBottom: '10px' } },
      `The oldest ${Math.min(summary.upToIndex ?? 0, chat.messages.length)} messages are sent as this summary instead of verbatim. ` +
        'Edit it to correct what the model remembers, or clear it to resend the full history.'),
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
          toast('Summary cleared — the full history will be sent again', 'ok');
        },
      }, 'Clear Summary'),
      el('div', { class: 'form-inline' },
        el('button', { class: 'btn', onclick: () => overlay.close() }, 'Cancel'),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const text = textarea.value.trim();
            if (text) chat.metadata.summary = { ...summary, text };
            else delete chat.metadata.summary;
            await persistChatMetadata(chat);
            overlay.close();
            renderChat();
            toast('Summary updated', 'ok');
          },
        }, 'Save'))
    )
  );
  const overlay = modal(content, { width: 620 });
}

/** Quick model switcher on the toolbar model chip. */
function openModelSwitcher() {
  const s = state.settings;
  const content = el('div', {}, el('h2', {}, 'Model'));
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
    toast(`Switched to ${model}`, 'ok');
  };
  const row = (provider, model, sub) =>
    el(
      'div',
      { class: 'list-row', onclick: () => pick(provider, model) },
      el('div', { class: 'list-main' },
        el('div', { class: 'list-title' }, model),
        el('div', { class: 'list-sub' }, sub ?? PROVIDERS[provider].label))
    );

  const recents = (s.recentModels ?? []).filter(
    (r) => PROVIDERS[r.provider] && !(r.provider === s.activeAPI && r.model === apiConfig().model)
  );
  const filter = el('input', { type: 'text', placeholder: 'Search models…' });
  let available = [];
  const renderList = () => {
    clear(results);
    const q = filter.value.trim().toLowerCase();
    if (!q && recents.length) {
      results.append(el('div', { class: 'hint', style: { margin: '6px 0' } }, 'Recent'));
      for (const r of recents.slice(0, 5)) results.append(row(r.provider, r.model));
    }
    const matches = available.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q));
    if (available.length) {
      results.append(el('div', { class: 'hint', style: { margin: '6px 0' } }, `${PROVIDERS[s.activeAPI].label} models`));
      for (const m of matches.slice(0, 30)) {
        const parts = [];
        if (m.name && m.name !== m.id) parts.push(m.name);
        if (m.context) parts.push(`${m.context.toLocaleString()} ctx`);
        const price = formatModelPricing(m.pricing);
        if (price) parts.push(price);
        results.append(row(s.activeAPI, m.id, parts.join(' · ') || undefined));
      }
      if (!matches.length) results.append(el('p', { class: 'hint' }, 'No matching models.'));
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
      results.append(el('p', { class: 'hint', style: { color: 'var(--danger)' } }, `Could not load models: ${err.message}`));
    });
  content.append(
    el('div', { class: 'form-inline' }, filter),
    results,
    el('div', { class: 'modal-actions' },
      el('button', { class: 'btn', onclick: () => { overlay.close(); cb.openSettings?.('api'); } }, 'Open API Settings…'))
  );
  const overlay = modal(content, { width: 520 });
  renderList();
  filter.focus();
}

/** Ctrl+Tab / Ctrl+Shift+Tab: cycle conversations (chat mode) or characters (role play). */
export async function cycleConversation(dir) {
  if (state.view !== 'chat') return;
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
      el('h2', {}, 'Chat History'),
      el('button', {
        class: 'btn btn-small',
        title: 'Import a SillyTavern or OpenChat .jsonl chat file',
        onclick: async () => {
          if (await importChatFile(charName)) overlay.close();
        },
      }, 'Import Chat…')
    )
  );
  const list = el('div', { class: 'search-results' });
  if (!chats.length) list.append(el('p', { style: { color: 'var(--text-dim)' } }, 'No previous chats.'));
  for (const chatInfo of chats) {
    const isCurrent = chatInfo.file === state.currentChat?.file;
    list.append(
      el(
        'div',
        { class: 'list-row' },
        el(
          'div',
          { class: 'list-main', onclick: async () => { overlay.close(); await loadChat(chatInfo.file); } },
          el('div', { class: 'list-title' }, `${new Date(chatInfo.metadata.create_date ?? chatInfo.mtime).toLocaleString()}${isCurrent ? ' · current' : ''}`),
          el('div', { class: 'list-sub' }, `${chatInfo.messageCount} messages · ${chatInfo.preview}`)
        ),
        el('button', { class: 'btn-icon', title: 'Export as Markdown', 'aria-label': 'Export as Markdown', onclick: () => exportChat(charName, chatInfo.file, 'markdown') }, 'MD'),
        el('button', { class: 'btn-icon', title: 'Export as JSONL', 'aria-label': 'Export as JSONL', onclick: () => exportChat(charName, chatInfo.file, 'jsonl') }, '{}'),
        el('button', {
          class: 'btn-icon',
          title: 'Delete chat',
          'aria-label': 'Delete chat',
          onclick: async () => {
            const ok = await confirmDialog('Delete this chat?');
            if (!ok) return;
            // Drop the run before aborting so the aborted event can't
            // persist into (and resurrect) the deleted file
            const run = runFor(charName, chatInfo.file);
            if (run) {
              state.runs.delete(run.requestId);
              window.tavern.llm.stop(run.requestId);
            }
            clearUnread(charName, chatInfo.file);
            await window.tavern.chats.delete(charName, chatInfo.file);
            if (isChatMode()) await refreshConversations();
            overlay.close();
            if (isCurrent) {
              const remaining = await window.tavern.chats.list(charName);
              if (remaining.length) await loadChat(remaining[0].file);
              else await newChat();
            }
            toast('Chat deleted');
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
    if (saved) toast('Chat exported', 'ok');
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
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
    el('h2', {}, 'Export Chat'),
    el(
      'div',
      { class: 'modal-actions', style: { justifyContent: 'flex-start' } },
      el('button', { class: 'btn btn-primary', onclick: () => { overlay.close(); exportChat(charName, file, 'markdown'); } }, 'Markdown'),
      el('button', { class: 'btn btn-primary', onclick: () => { overlay.close(); exportChat(charName, file, 'jsonl'); } }, 'JSONL'),
      el('button', {
        class: 'btn',
        onclick: () => {
          navigator.clipboard.writeText(
            state.currentChat.messages.map((m) => `${m.name}: ${m.mes}`).join('\n\n')
          );
          overlay.close();
          toast('Chat copied to clipboard', 'ok');
        },
      }, 'Copy as Text')
    )
  );
  const overlay = modal(content, { width: 420 });
}

/** Import a SillyTavern/OpenChat JSONL chat file for the current character. */
async function importChatFile(charName) {
  const files = await window.tavern.dialog.openFile({
    filters: [{ name: 'Chat JSONL', extensions: ['jsonl'] }],
  });
  if (!files?.[0]) return false;
  try {
    const file = await window.tavern.chats.import(charName, files[0]);
    toast('Chat imported', 'ok');
    if (isChatMode()) await refreshConversations();
    await loadChat(file);
    return true;
  } catch (err) {
    toast(`Import failed: ${err.message}`, 'error');
    return false;
  }
}

export function openSearch(initialQuery = '', initialScope = 'current') {
  const content = el('div', {}, el('h2', {}, 'Search'));
  const input = el('input', { type: 'text', placeholder: 'Search messages…', value: initialQuery });
  const scope = el(
    'select',
    { style: { width: 'auto' } },
    el('option', { value: 'current' }, 'This conversation'),
    el('option', { value: 'all' }, 'All chats')
  );
  scope.value = initialScope;
  const results = el('div', { class: 'search-results' });
  content.append(el('div', { class: 'form-inline' }, input, scope), results);
  const overlay = modal(content, { width: 620 });

  async function run() {
    const q = input.value.trim();
    clear(results);
    if (q.length < 2) return;
    if (scope.value === 'current' && state.currentChat) {
      const matches = [];
      state.currentChat.messages.forEach((m, index) => {
        if ((m.mes ?? '').toLowerCase().includes(q.toLowerCase())) matches.push({ m, index });
      });
      if (!matches.length) results.append(el('p', { style: { color: 'var(--text-dim)' } }, 'No matches.'));
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
      if (!hits.length) results.append(el('p', { style: { color: 'var(--text-dim)' } }, 'No matches.'));
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

function searchRow(title, text, q, onclick) {
  const snippet = el('div', { class: 'list-sub search-snippet' });
  const safe = escapeHtml(text.slice(0, 200));
  const safeQ = escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  snippet.innerHTML = safe.replace(new RegExp(`(${safeQ})`, 'gi'), '<mark>$1</mark>');
  return el(
    'div',
    { class: 'list-row', onclick },
    el('div', { class: 'list-main' }, el('div', { class: 'list-title' }, title), snippet)
  );
}

function jumpToMessage(index) {
  const target = document.querySelector(`#messages [data-index="${index}"]`);
  if (target) {
    target.scrollIntoView({ block: 'center' });
    target.style.outline = '2px solid var(--accent)';
    target.style.borderRadius = '12px';
    setTimeout(() => {
      target.style.outline = '';
      target.style.borderRadius = '';
    }, 1600);
  }
}
