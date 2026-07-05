// Small DOM + misc helpers shared across views.

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

export function relativeDate(iso) {
  const date = new Date(iso);
  if (isNaN(date)) return '';
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function formatTime(iso) {
  const date = new Date(iso);
  if (isNaN(date)) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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

/** Rough token estimate (chars / 4). */
export function estimateTokens(text) {
  return Math.ceil((text ?? '').length / 4);
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

/** Modal helper: returns the overlay element; close via overlay.remove(). */
export function modal(contentNode, { width = 520, onClose } = {}) {
  const overlay = el('div', { class: 'modal-overlay' });
  const box = el('div', { class: 'modal-box', style: { maxWidth: `${width}px` } }, contentNode);
  overlay.append(box);
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', escHandler);
    onClose?.();
  };
  const escHandler = (e) => {
    if (e.key === 'Escape') close();
  };
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', escHandler);
  document.body.append(overlay);
  overlay.close = close;
  return overlay;
}

/** Single-line text prompt. Resolves to the entered string, or null on cancel. */
export function promptDialog(message, { value = '', confirmLabel = 'Save', placeholder = '' } = {}) {
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
        el('button', { class: 'btn', onclick: () => done(null) }, 'Cancel'),
        el('button', { class: 'btn btn-primary', onclick: () => done(input.value) }, confirmLabel)
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

export function confirmDialog(message, { confirmLabel = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    const content = el(
      'div',
      {},
      el('p', { class: 'confirm-message' }, message),
      el(
        'div',
        { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'),
        el('button', { class: danger ? 'btn btn-danger' : 'btn btn-primary', onclick: () => done(true) }, confirmLabel)
      )
    );
    const overlay = modal(content, { width: 400, onClose: () => resolve(false) });
    function done(result) {
      resolve(result); // a later resolve(false) from onClose is a no-op
      overlay.close();
    }
  });
}
