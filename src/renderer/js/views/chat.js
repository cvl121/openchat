// Chat view: message list, streaming generation, swipes, editing, history,
// search, and export.

import { el, clear, uuid, nowISO, formatTime, toast, modal, confirmDialog, escapeHtml } from '../util.js';
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
} from '../state.js';
import { estimateTokens } from '../util.js';
import { avatar, streamingDots } from '../components.js';

const ASSISTANT_NAME = ASSISTANT_CHARACTER.card.data.name;

let cb = {}; // { renderSidebar, navigate, editCharacter }
let streamingMsgEl = null; // content element receiving chunks
let lastError = null;
let lastTrimmed = 0; // messages dropped from the last prompt to fit the context window
let lastFinishReason = null; // provider stop reason for the last response
// Stop reasons that mean "truncated by the max-tokens limit" per provider
const LENGTH_REASONS = new Set(['length', 'max_tokens', 'MAX_TOKENS']);
const newMessages = new WeakSet(); // messages not yet on disk → append instead of rewrite
let pendingAttachments = []; // uploads staged in the input bar, sent with the next message
const resolvedUploads = new Map(); // upload file -> {kind, dataURL?|text?} for prompt building

let renderQueued = false;

export function initChat(callbacks) {
  cb = callbacks;
  // Chunks can arrive far faster than 60fps; re-rendering markdown per token
  // is O(n²) over a long response. Coalesce to one render per animation frame.
  window.tavern.on('llm:chunk', ({ requestId, text }) => {
    if (requestId !== state.activeRequestId) return;
    const msg = streamingMessage();
    if (!msg) return;
    msg.mes += text;
    if (msg.swipes) msg.swipes[msg.swipe_id ?? 0] = msg.mes;
    if (!renderQueued && streamingMsgEl) {
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        const current = streamingMessage();
        if (current && streamingMsgEl) {
          streamingMsgEl.innerHTML = renderMarkdown(current.mes);
          scrollToBottom(false);
        }
      });
    }
  });
  window.tavern.on('llm:done', async ({ requestId, finishReason }) => {
    if (requestId !== state.activeRequestId) return;
    lastFinishReason = finishReason ?? null;
    if (LENGTH_REASONS.has(lastFinishReason)) {
      devLog('INFO', `response truncated by max-tokens limit (finish_reason: ${lastFinishReason})`);
    }
    await finishGeneration();
  });
  window.tavern.on('llm:error', async ({ requestId, error, aborted }) => {
    if (requestId !== state.activeRequestId) return;
    devLog('ERR', error);
    if (!aborted) lastError = error;
    await finishGeneration({ failed: !aborted });
  });
  // Image outputs from image-capable models: persist to uploads/ and attach
  window.tavern.on('llm:image', async ({ requestId, dataURL }) => {
    if (requestId !== state.activeRequestId) return;
    const msg = streamingMessage() ?? state.currentChat?.messages.at(-1);
    if (!msg || msg.is_user) return;
    try {
      const saved = await window.tavern.files.saveUpload('generated', dataURL);
      msg.extra = msg.extra ?? {};
      (msg.extra.attachments ??= []).push({ file: saved.file, name: saved.name, mime: saved.mime, kind: 'image' });
      // The done event may have already persisted the message without this image
      if (!state.generating) await persistChat();
      renderChat();
    } catch (err) {
      devLog('ERR', `Could not save generated image: ${err.message}`);
    }
  });
}

function streamingMessage() {
  return state.currentChat?.messages.find((m) => m.__streaming);
}

async function finishGeneration({ failed = false } = {}) {
  // Both the llm:error push event and the rejected llm:send invoke can land
  // here for the same request — only the first one does the work.
  if (!state.generating) return;
  const chat = state.currentChat;
  const msg = streamingMessage();
  state.generating = false;
  state.activeRequestId = null;
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
  if (chat && state.selectedCharacter) {
    // Brand-new messages append (O(message)); anything that mutated an
    // existing message (regenerate, swipe) rewrites the file.
    if (msg && wasNew) {
      if (chat.messages.includes(msg)) await appendToChat(msg);
    } else {
      await persistChat();
    }
  }
  if (isChatMode()) await refreshConversations();
  renderChat();
  void maybeCompressChat(); // background; re-renders when done
}

// ---------------------------------------------------------------------------
// Chat compression: once a chat outgrows the threshold, summarize the older
// messages with one cheap non-streaming call so every following turn stops
// resending the full history.

const COMPRESS_KEEP_RECENT = 16; // newest messages always sent verbatim
let compressing = false;

async function maybeCompressChat() {
  const cfg = state.settings.chatCompression;
  if (!cfg?.enabled || compressing || state.generating) return;
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
    const config = apiConfig();
    config.params.max_tokens = Math.min(1024, config.params.max_tokens || 1024);
    devLog('INFO', `compressing ${slice.length} older messages (threshold ${threshold})…`);
    const text = (await window.tavern.llm.complete(request, config))?.trim();
    if (!text) return;
    if (state.currentChat !== chatRef) return; // user switched chats mid-flight
    chatRef.metadata.summary = { text, upToIndex: end };
    await persistChat();
    devLog('INFO', `compressed ${end - start} messages into a ~${estimateTokens(text)}-token summary`);
    if (state.view === 'chat' && !state.generating) renderChat();
  } catch (err) {
    devLog('ERR', `chat compression failed: ${err.message}`);
  } finally {
    compressing = false;
  }
}

async function persistChat() {
  const chat = state.currentChat;
  if (!chat || !state.selectedCharacter) return;
  const clean = chat.messages.map(({ __streaming, ...m }) => m);
  await window.tavern.chats.rewrite(
    state.selectedCharacter.card.data.name,
    chat.file,
    chat.metadata,
    clean
  );
}

async function appendToChat(msg) {
  const chat = state.currentChat;
  if (!chat || !state.selectedCharacter) return;
  const { __streaming, ...clean } = msg;
  await window.tavern.chats.append(state.selectedCharacter.card.data.name, chat.file, clean);
}

// ---------------------------------------------------------------------------
// Character / chat selection

export async function selectCharacter(character) {
  if (state.generating) stopGeneration();
  state.selectedCharacter = character;
  state.view = 'chat';
  state.undoStack = [];
  lastError = null;
  lastFinishReason = null;
  lastTrimmed = 0;
  pendingAttachments = [];
  // O(1) session restore on next launch
  if (!character.virtual) {
    state.settings.lastCharacterFilename = character.filename;
    scheduleSettingsSave();
  }
  const charName = character.card.data.name;
  const chats = await window.tavern.chats.list(charName);
  if (chats.length) {
    state.currentChat = await window.tavern.chats.load(charName, chats[0].file);
  } else {
    await newChat({ render: false });
  }
  renderChat({ scrollBottom: true });
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
  if (state.generating) stopGeneration();
  state.view = 'chat';
  state.selectedCharacter = ASSISTANT_CHARACTER;
  pendingAttachments = [];
  await loadChat(file);
  cb.renderSidebar?.();
}

export async function deleteConversation(file) {
  await window.tavern.chats.delete(ASSISTANT_NAME, file);
  await refreshConversations();
  if (state.currentChat?.file === file) {
    if (state.conversations.length) await selectConversation(state.conversations[0].file);
    else await newChat();
  }
}

export async function renameConversation(file, title) {
  const chat =
    state.currentChat?.file === file
      ? state.currentChat
      : await window.tavern.chats.load(ASSISTANT_NAME, file);
  chat.metadata.title = title;
  await window.tavern.chats.rewrite(
    ASSISTANT_NAME,
    file,
    chat.metadata,
    chat.messages.map(({ __streaming, ...m }) => m)
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
  lastError = null;
  lastFinishReason = null;
  lastTrimmed = 0;
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
  state.currentChat = await window.tavern.chats.load(charName, file);
  state.undoStack = [];
  lastError = null;
  lastFinishReason = null;
  lastTrimmed = 0;
  renderChat({ scrollBottom: true });
}

// ---------------------------------------------------------------------------
// Rendering

export function renderChat({ scrollBottom = false } = {}) {
  const main = document.getElementById('main');

  // Carry the user's draft, cursor, and scroll position across the rebuild —
  // a render must never eat text typed while a response was streaming, nor
  // yank the view to the bottom while reading older messages.
  const prevMessages = document.getElementById('messages');
  const prevScroll = prevMessages
    ? {
        top: prevMessages.scrollTop,
        nearBottom:
          prevMessages.scrollHeight - prevMessages.scrollTop - prevMessages.clientHeight < 160,
      }
    : null;
  const prevInput = document.getElementById('chat-input');
  const draft = prevInput
    ? {
        value: prevInput.value,
        focused: document.activeElement === prevInput,
        selStart: prevInput.selectionStart,
        selEnd: prevInput.selectionEnd,
      }
    : null;

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
  const config = apiConfig();
  const chatTitle = isChatMode()
    ? state.currentChat?.metadata?.title || 'New conversation'
    : data.name;

  const allMessages = state.currentChat?.messages ?? [];
  // Estimate what actually gets sent: summary stands in for compressed messages
  const compressedCount = Math.min(state.currentChat?.metadata?.summary?.upToIndex ?? 0, allMessages.length);
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
          `${allMessages.length} messages · ~${tokenEstimate.toLocaleString()} tokens` +
            (compressedCount > 0 ? ` · ${compressedCount} compressed` : '') +
            (lastTrimmed > 0 ? ` · ${lastTrimmed} oldest not sent (context full)` : '')
        )
      ),
      el(
        'button',
        {
          class: 'model-chip',
          title: `${PROVIDERS[config.provider].label} · ${config.model} — click to change`,
          onclick: () => cb.openSettings?.('api'),
        },
        config.model
      ),
      el('button', { class: 'btn-icon', title: 'Search (⌘F)', onclick: () => openSearch() }, '🔍'),
      el('button', { class: 'btn-icon', title: 'Chat history (⌘⇧H)', onclick: () => openHistory() }, '🕘'),
      el('button', { class: 'btn-icon', title: 'New chat (⌘N)', onclick: () => newChat() }, '＋')
    )
  );

  const messagesEl = el('div', { id: 'messages' });
  const messages = state.currentChat?.messages ?? [];
  messages.forEach((msg, index) => messagesEl.append(messageEl(msg, index)));
  if (lastError) {
    messagesEl.append(
      el(
        'div',
        { class: 'error-banner' },
        el('span', {}, lastError),
        el('button', { class: 'btn btn-primary btn-small', onclick: () => retryLast() }, 'Retry'),
        el('button', { class: 'btn btn-small', onclick: () => { lastError = null; renderChat(); } }, 'Dismiss')
      )
    );
  }
  // The provider stopped mid-response at the max-tokens limit — say so,
  // instead of letting the text look mysteriously cut off.
  if (!state.generating && LENGTH_REASONS.has(lastFinishReason) && lastAssistantIndex() === messages.length - 1 && messages.length) {
    messagesEl.append(
      el(
        'div',
        { class: 'notice-banner' },
        el('span', {}, `Response hit the Max Response Tokens limit (${config.params.max_tokens.toLocaleString()}).`),
        el('button', { class: 'btn btn-primary btn-small', onclick: () => continueLast() }, 'Continue'),
        el('button', { class: 'btn btn-small', onclick: () => cb.openSettings?.('generation') }, 'Raise Limit'),
        el('button', { class: 'btn btn-small', onclick: () => { lastFinishReason = null; renderChat(); } }, 'Dismiss')
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
  messagesEl.addEventListener('scroll', () => {
    const away = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight > 300;
    scrollBtn.classList.toggle('visible', away);
  });

  // Input bar — auto-grows with content up to a max height
  const input = el('textarea', {
    id: 'chat-input',
    placeholder: `Message ${data.name}…`,
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
    if (e.key === 'ArrowUp' && !input.value && !state.generating) {
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
        if (path) pendingAttachments.push(await window.tavern.files.importUpload(path));
        else await stageFileObject(file);
        staged++;
      } catch (err) {
        toast(`Could not attach ${file.name}: ${err.message}`, 'error');
      }
    }
    if (staged) renderChat();
  });

  const sendBtn = state.generating
    ? el('button', { class: 'btn btn-danger', onclick: () => stopGeneration() }, 'Stop')
    : el('button', { class: 'btn btn-primary', onclick: () => sendMessage() }, 'Send');
  const attachBtn = el(
    'button',
    { class: 'btn-icon attach-btn', title: 'Attach images or files', onclick: () => attachFiles() },
    '📎'
  );
  const imageGen = state.settings.imageGen ?? {};
  const imageBtn = imageGen.enabled
    ? el(
        'button',
        {
          class: 'btn-icon attach-btn',
          title: `Generate an image from this prompt (${imageApiConfig().model})`,
          onclick: () => sendMessage({ asImage: true }),
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
  root.append(el('div', { id: 'chat-input-bar' }, attachBtn, imageBtn, input, sendBtn));
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
  if (scrollBottom || !prevScroll || prevScroll.nearBottom) scrollToBottom(true);
  else messagesEl.scrollTop = prevScroll.top;
  if (!state.generating) {
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
  if (msg.__streaming) streamingMsgEl = content;
  content.addEventListener('dblclick', () => {
    if (!msg.__streaming && !state.generating) editMessage(msg, index);
  });

  const actions = el(
    'div',
    { class: 'msg-actions' },
    el('button', { class: 'btn-icon', title: 'Copy', onclick: () => { navigator.clipboard.writeText(msg.mes); toast('Copied'); } }, '⧉'),
    el('button', { class: 'btn-icon', title: 'Edit', onclick: () => editMessage(msg, index) }, '✎'),
    !isUser && index === lastAssistantIndex()
      ? el('button', { class: 'btn-icon', title: 'Regenerate (⌘R)', onclick: () => regenerateLast() }, '↻')
      : null,
    el('button', { class: 'btn-icon', title: 'Delete', onclick: () => deleteMessage(index) }, '🗑')
  );

  const body = el(
    'div',
    { class: 'msg-body' },
    el(
      'div',
      { class: 'msg-header' },
      el('span', { class: 'msg-name' }, msg.name),
      el('span', { class: 'msg-time' }, formatTime(msg.send_date)),
      actions
    ),
    attachmentStrip(msg),
    content
  );

  // Swipe bar on the last assistant message with swipes (or generative potential)
  if (!isUser && index === lastAssistantIndex() && !msg.__streaming && !state.generating) {
    const count = msg.swipes?.length ?? 1;
    const current = (msg.swipe_id ?? 0) + 1;
    body.append(
      el(
        'div',
        { class: 'swipe-bar' },
        el('button', { class: 'btn-icon', title: 'Previous response', disabled: current <= 1, onclick: () => swipe(-1) }, '‹'),
        el('span', {}, `${current} / ${count}`),
        el('button', { class: 'btn-icon', title: count > current ? 'Next response' : 'Generate alternative', onclick: () => swipe(1) }, '›')
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
  const nearBottom = elMessages.scrollHeight - elMessages.scrollTop - elMessages.clientHeight < 160;
  if (force || nearBottom) elMessages.scrollTop = elMessages.scrollHeight;
}

// ---------------------------------------------------------------------------
// Attachments

const ATTACH_FILTERS = [
  { name: 'Images & text files', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'txt', 'md', 'csv', 'log', 'json', 'xml', 'yaml', 'yml', 'html', 'css', 'js', 'ts', 'py', 'pdf'] },
  { name: 'All files', extensions: ['*'] },
];

async function attachFiles() {
  const files = await window.tavern.dialog.openFile({ multi: true, filters: ATTACH_FILTERS });
  let staged = 0;
  for (const path of files) {
    try {
      pendingAttachments.push(await window.tavern.files.importUpload(path));
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
  if (state.generating || !state.selectedCharacter || !state.currentChat) return;
  const input = document.getElementById('chat-input');
  const text = input?.value.trim() ?? '';
  const attachments = pendingAttachments;
  const lastIsUser = state.currentChat.messages.at(-1)?.is_user;
  if (asImage && !text && !attachments.length) {
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
  await generateResponse(asImage ? { configOverride: imageApiConfig() } : {});
}

async function generateResponse({ historyUpTo = null, intoMessage = null, configOverride = null } = {}) {
  const character = state.selectedCharacter;
  const chat = state.currentChat;
  const config = configOverride ?? apiConfig();
  lastError = null;
  lastFinishReason = null;

  if (PROVIDERS[config.provider].requiresKey && !config.apiKey) {
    lastError = `No API key set for ${PROVIDERS[config.provider].label}. Add one in Settings → API.`;
    renderChat();
    return;
  }

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
    summary,
    contextSize: config.params.context_size,
    maxResponseTokens: config.params.max_tokens,
    stats,
  });
  lastTrimmed = stats.trimmedCount ?? 0;

  let msg = intoMessage;
  if (!msg) {
    msg = { name: character.card.data.name, is_user: false, send_date: nowISO(), mes: '' };
    chat.messages.push(msg);
    newMessages.add(msg);
  }
  msg.__streaming = true;

  state.generating = true;
  state.activeRequestId = uuid();
  devLog('REQ', `${config.provider}/${config.model} · ${prompt.length} messages · ~${stats.promptTokens} tokens${lastTrimmed ? ` · ${lastTrimmed} trimmed` : ''} · ${JSON.stringify(prompt.at(-1))?.slice(0, 300)}`);
  renderChat({ scrollBottom: true });

  try {
    await window.tavern.llm.send(state.activeRequestId, prompt, config);
    devLog('RES', `completed · ${msg.mes.length} chars`);
  } catch (err) {
    devLog('ERR', err.message);
    lastError = err.message;
    await finishGeneration({ failed: true });
  }
}

export function stopGeneration() {
  if (!state.activeRequestId) return;
  window.tavern.llm.stop(state.activeRequestId);
}

/** Retry after a failed generation (error-banner button). */
async function retryLast() {
  if (state.generating) return;
  lastError = null;
  const messages = state.currentChat?.messages ?? [];
  if (messages.at(-1)?.is_user) await generateResponse();
  else await regenerateLast();
}

export async function regenerateLast() {
  if (state.generating) return;
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
  if (state.generating) return;
  const idx = lastAssistantIndex();
  if (idx < 0) return;
  pushUndo();
  const msg = state.currentChat.messages[idx];
  msg.mes = msg.mes.replace(/\s+$/, ''); // no trailing whitespace in a prefill
  if (msg.swipes) msg.swipes[msg.swipe_id ?? 0] = msg.mes;
  await generateResponse({ historyUpTo: idx + 1, intoMessage: msg });
}

async function swipe(direction) {
  const idx = lastAssistantIndex();
  if (idx < 0 || state.generating) return;
  const msg = state.currentChat.messages[idx];
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
  } else {
    // Generate a brand-new alternative
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
  const messagesEl = document.getElementById('messages');
  const msgEl = messagesEl?.querySelector(`[data-index="${index}"] .msg-body`);
  if (!msgEl) return;
  clear(msgEl);
  const textarea = el('textarea', { rows: 6 }, msg.mes);
  msgEl.append(
    el('div', { class: 'msg-edit-area' }, textarea),
    el(
      'div',
      { class: 'msg-edit-actions' },
      el('button', { class: 'btn btn-small', onclick: () => renderChat() }, 'Cancel'),
      el(
        'button',
        {
          class: 'btn btn-primary btn-small',
          onclick: async () => {
            pushUndo();
            msg.mes = textarea.value;
            if (msg.swipes) msg.swipes[msg.swipe_id ?? 0] = textarea.value;
            await persistChat();
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
  if (popUndo()) {
    await persistChat();
    renderChat();
    toast('Undone');
  }
}

// ---------------------------------------------------------------------------
// History & search modals

export async function openHistory() {
  if (!state.selectedCharacter) return;
  const charName = state.selectedCharacter.card.data.name;
  const chats = await window.tavern.chats.list(charName);
  const content = el('div', {}, el('h2', {}, 'Chat History'));
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
        el('button', { class: 'btn-icon', title: 'Export as Markdown', onclick: () => exportChat(charName, chatInfo.file, 'markdown') }, 'MD'),
        el('button', { class: 'btn-icon', title: 'Export as JSONL', onclick: () => exportChat(charName, chatInfo.file, 'jsonl') }, '{}'),
        el('button', {
          class: 'btn-icon',
          title: 'Delete chat',
          onclick: async () => {
            const ok = await confirmDialog('Delete this chat?');
            if (!ok) return;
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

export function openSearch(initialQuery = '') {
  const content = el('div', {}, el('h2', {}, 'Search'));
  const input = el('input', { type: 'text', placeholder: 'Search messages…', value: initialQuery });
  const scope = el(
    'select',
    { style: { width: 'auto' } },
    el('option', { value: 'current' }, 'This conversation'),
    el('option', { value: 'all' }, 'All chats')
  );
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
