// Small DOM + misc helpers shared across views.

import { t, currentLocale } from '../../shared/i18n.js';

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (value !== null && value !== undefined && value !== false) {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function uuid() {
  return crypto.randomUUID();
}

export function nowISO() {
  return new Date().toISOString();
}

// One formatter per locale — Intl constructors are expensive per call
let rtfCache = { locale: null, rtf: null };

export function relativeDate(iso) {
  const date = new Date(iso);
  if (isNaN(date)) return '';
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('dates.now');
  if (rtfCache.locale !== currentLocale()) {
    rtfCache = {
      locale: currentLocale(),
      rtf: new Intl.RelativeTimeFormat(currentLocale(), { numeric: 'always', style: 'narrow' }),
    };
  }
  if (mins < 60) return rtfCache.rtf.format(-mins, 'minute');
  const hours = Math.floor(mins / 60);
  if (hours < 24) return rtfCache.rtf.format(-hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 7) return rtfCache.rtf.format(-days, 'day');
  return date.toLocaleDateString(currentLocale());
}

// toLocaleTimeString builds a fresh Intl formatter per call — measurable when
// a long chat renders one timestamp per message (relativeDate caches likewise)
let timeFmtCache = null;

export function formatTime(iso) {
  const date = new Date(iso);
  if (isNaN(date)) return '';
  if (timeFmtCache?.locale !== currentLocale()) {
    timeFmtCache = {
      locale: currentLocale(),
      fmt: new Intl.DateTimeFormat(currentLocale(), { hour: 'numeric', minute: '2-digit' }),
    };
  }
  return timeFmtCache.fmt.format(date);
}

/** Replace {{char}} / {{user}} template variables (SillyTavern convention). */
export function replaceTemplateVars(text, charName, userName) {
  if (!text) return '';
  return text
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/<BOT>/g, charName)
    .replace(/<USER>/g, userName);
}

// CJK codepoints (Han, kana, Hangul, full-width forms, plane-2 ideographs).
// These tokenize at roughly one token per character, unlike Latin-ish text at
// ~4 characters per token — a single chars/4 heuristic underestimates CJK
// chats ~4x, which matters because this estimate drives context-window
// trimming in promptBuilder, not just the UI counters.
const CJK_RE =
  // Hangul Jamo & syllables, CJK radicals/kana/Han/Yi, compat ideographs & forms,
  // full-width forms, plane-2 Han
  /[\u1100-\u11FF\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u{20000}-\u{2FA1F}]/gu;

/** Flatten markdown to plain text for one-line previews and title fallbacks. */
export function stripMarkdown(text) {
  return (text ?? '')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\s]+|[*_~]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "$1.25 in · $5.00 out /M", "free", or null when pricing is unknown. */
export function formatModelPricing(pricing) {
  if (!pricing) return null;
  if (!pricing.inPerM && !pricing.outPerM) return 'free';
  const fmt = (v) => (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toPrecision(2)}`);
  return `${fmt(pricing.inPerM)} in · ${fmt(pricing.outPerM)} out /M`;
}

/** "$0.0031" below a cent, "$1.24" above. */
export function formatUSD(usd) {
  return usd >= 0.1 ? `$${usd.toFixed(2)}` : `$${usd.toPrecision(2)}`;
}

/** Rough token estimate: CJK chars count as 1 token, everything else as 1/4. */
export function estimateTokens(text) {
  const s = text ?? '';
  const cjk = (s.match(CJK_RE) ?? []).length;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

let toastTimer = null;
export function toast(message, kind = 'info') {
  let node = document.getElementById('toast');
  if (!node) {
    node = el('div', { id: 'toast' });
    document.body.append(node);
  }
  node.textContent = message;
  node.className = `toast-${kind} visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('visible'), 3200);
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/** Modal helper: returns the overlay element; close via overlay.remove(). */
export function modal(contentNode, { width = 520, onClose } = {}) {
  const overlay = el('div', { class: 'modal-overlay' });
  const box = el(
    'div',
    { class: 'modal-box', role: 'dialog', 'aria-modal': 'true', tabindex: '-1', style: { maxWidth: `${width}px` } },
    contentNode
  );
  overlay.append(box);
  const prevFocus = document.activeElement;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', keyHandler);
    if (prevFocus instanceof HTMLElement && document.contains(prevFocus)) prevFocus.focus();
    onClose?.();
  };
  const keyHandler = (e) => {
    if (e.key === 'Escape') {
      close();
      return;
    }
    // Keep Tab focus inside the dialog
    if (e.key !== 'Tab' || !document.contains(box)) return;
    const focusables = box.querySelectorAll(FOCUSABLE);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', keyHandler);
  document.body.append(overlay);
  if (!box.contains(document.activeElement)) box.focus();
  overlay.close = close;
  return overlay;
}

/** Single-line text prompt. Resolves to the entered string, or null on cancel. */
export function promptDialog(message, { value = '', confirmLabel = null, placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value, placeholder });
    const content = el(
      'div',
      {},
      el('p', { class: 'confirm-message' }, message),
      input,
      el(
        'div',
        { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => done(null) }, t('common.cancel')),
        el('button', { class: 'btn btn-primary', onclick: () => done(input.value) }, confirmLabel ?? t('common.save'))
      )
    );
    const overlay = modal(content, { width: 420, onClose: () => resolve(null) });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value);
    });
    input.focus();
    input.select();
    function done(result) {
      resolve(result);
      overlay.close();
    }
  });
}

export function confirmDialog(message, { confirmLabel = null, danger = true } = {}) {
  return new Promise((resolve) => {
    const content = el(
      'div',
      {},
      el('p', { class: 'confirm-message' }, message),
      el(
        'div',
        { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => done(false) }, t('common.cancel')),
        el('button', { class: danger ? 'btn btn-danger' : 'btn btn-primary', onclick: () => done(true) }, confirmLabel ?? t('common.delete'))
      )
    );
    const overlay = modal(content, { width: 400, onClose: () => resolve(false) });
    function done(result) {
      resolve(result); // a later resolve(false) from onClose is a no-op
      overlay.close();
    }
  });
}
