// Shared UI widgets.

import { el, clear } from './util.js';

/** Avatar image with fallback to colored initials. */
export function avatar(url, name, size = 36) {
  if (url) {
    const img = el('img', {
      class: 'avatar',
      src: url,
      width: size,
      height: size,
      alt: name ?? '',
      // The src is often the full multi-MB character PNG; a big library
      // would otherwise fetch and decode every card the moment a grid renders
      loading: 'lazy',
      decoding: 'async',
    });
    img.addEventListener('error', () => img.replaceWith(initialsAvatar(name, size)));
    img.addEventListener('load', () => {
      // Characters created without a picture carry a 1×1 placeholder PNG —
      // show a neutral silhouette instead of a blank circle
      if (img.naturalWidth < 8) img.replaceWith(placeholderAvatar(size));
    });
    return img;
  }
  return initialsAvatar(name, size);
}

/** Greyed-out person silhouette for characters with no real image. */
function placeholderAvatar(size) {
  const div = el('div', {
    class: 'avatar-placeholder',
    style: { width: `${size}px`, height: `${size}px` },
  });
  div.innerHTML =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
  return div;
}

function initialsAvatar(name, size) {
  const initials = (name ?? '?')
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return el(
    'div',
    {
      class: 'avatar-fallback',
      style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px` },
    },
    initials
  );
}

/** Labeled slider + numeric input bound to a getter/setter. */
export function sliderRow(label, { min, max, step, get, set, hint, softMax = false }) {
  // softMax: the slider tops out at `max` but the number input accepts
  // anything above it (e.g. context sizes beyond the slider's range)
  const slider = el('input', { type: 'range', min, max, step, value: Math.min(max, get()) });
  const num = el('input', { type: 'number', min, ...(softMax ? {} : { max }), step, value: get() });
  slider.addEventListener('input', () => {
    num.value = slider.value;
    set(parseFloat(slider.value));
  });
  num.addEventListener('change', () => {
    let v = Math.max(min, parseFloat(num.value) || 0);
    if (!softMax) v = Math.min(max, v);
    num.value = v;
    slider.value = Math.min(max, v);
    set(v);
  });
  return el(
    'div',
    { class: 'form-row' },
    el('label', {}, label),
    el('div', { class: 'slider-row' }, slider, num),
    hint ? el('div', { class: 'hint' }, hint) : null
  );
}

export function checkboxRow(label, { get, set, hint }) {
  const box = el('input', { type: 'checkbox' });
  box.checked = get();
  box.addEventListener('change', () => set(box.checked));
  return el(
    'div',
    { class: 'form-row' },
    el('label', { class: 'form-inline', style: { cursor: 'pointer' } }, box, label),
    hint ? el('div', { class: 'hint' }, hint) : null
  );
}

export function textRow(label, { get, set, placeholder = '', hint }) {
  const input = el('input', { type: 'text', value: get() ?? '', placeholder });
  input.addEventListener('input', () => set(input.value));
  return el(
    'div',
    { class: 'form-row' },
    el('label', {}, label),
    input,
    hint ? el('div', { class: 'hint' }, hint) : null
  );
}

export function textareaRow(label, { get, set, placeholder = '', rows = 4, hint }) {
  const input = el('textarea', { rows, placeholder }, get() ?? '');
  input.addEventListener('input', () => set(input.value));
  return el(
    'div',
    { class: 'form-row' },
    el('label', {}, label),
    input,
    hint ? el('div', { class: 'hint' }, hint) : null
  );
}

export function selectRow(label, { options, get, set, hint }) {
  const select = el(
    'select',
    {},
    options.map(([value, text]) => el('option', { value, selected: get() === value }, text))
  );
  select.addEventListener('change', () => set(select.value));
  return el(
    'div',
    { class: 'form-row' },
    el('label', {}, label),
    select,
    hint ? el('div', { class: 'hint' }, hint) : null
  );
}

/**
 * Text input with a styled, scrollable suggestion menu — an in-app
 * replacement for <input list> + <datalist>, whose native popup can't be
 * themed and handles long model lists poorly. Items: { value, sub? }.
 * The menu opens on focus, filters on every space-separated term as you
 * type, and supports ArrowUp/Down, Enter, and Escape.
 * Returns { root, input, setItems }.
 */
export function combobox({ value = '', placeholder = '', emptyText = '', onChange }) {
  const input = el('input', { type: 'text', value, placeholder, autocomplete: 'off', spellcheck: 'false' });
  const menu = el('div', { class: 'combo-menu', hidden: true });
  const root = el('div', { class: 'combo' }, input, menu);
  let items = [];
  let rows = [];
  let matches = [];
  let hilite = -1;
  let open = false;
  let lastQuery = '';

  const close = () => {
    open = false;
    menu.hidden = true;
  };
  const setHilite = (i, scroll = true) => {
    rows[hilite]?.classList.remove('hilite');
    hilite = i;
    if (hilite >= 0) {
      rows[hilite].classList.add('hilite');
      if (scroll) rows[hilite].scrollIntoView({ block: 'nearest' });
    }
  };
  const pick = (v) => {
    input.value = v;
    onChange?.(v);
    close();
  };
  // Opening shows the full list (query '') so the current value never
  // filters everything else out; typing then narrows it down.
  const renderMenu = (query) => {
    lastQuery = query;
    clear(menu);
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    matches = items.filter((it) => {
      const hay = `${it.value} ${it.sub ?? ''}`.toLowerCase();
      return terms.every((term) => hay.includes(term));
    });
    hilite = -1;
    rows = matches.map((it) => {
      const row = el(
        'div',
        { class: 'combo-item' },
        el('div', { class: 'combo-title' }, it.value),
        it.sub ? el('div', { class: 'combo-sub' }, it.sub) : null
      );
      // preventDefault keeps the input focused so blur doesn't kill the click
      row.addEventListener('pointerdown', (e) => e.preventDefault());
      row.addEventListener('click', () => pick(it.value));
      return row;
    });
    if (rows.length) menu.append(...rows);
    else menu.append(el('div', { class: 'combo-empty' }, emptyText));
  };
  const openMenu = () => {
    if (!items.length) return; // nothing to browse (yet) — no menu, no false "no matches"
    open = true;
    menu.hidden = false;
    renderMenu('');
    // Start at the current value so the list opens "where you are"
    const current = matches.findIndex((it) => it.value === input.value.trim());
    if (current >= 0) setHilite(current);
  };

  input.addEventListener('focus', openMenu);
  input.addEventListener('click', () => {
    if (!open) openMenu();
  });
  input.addEventListener('blur', close);
  input.addEventListener('input', () => {
    onChange?.(input.value);
    if (!items.length) return;
    open = true;
    menu.hidden = false;
    renderMenu(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return openMenu();
      if (!matches.length) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setHilite((hilite + delta + matches.length) % matches.length);
    } else if (e.key === 'Enter') {
      if (open && hilite >= 0) {
        e.preventDefault();
        pick(matches[hilite].value);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.stopPropagation();
        close();
      }
    }
  });

  return {
    root,
    input,
    setItems(list) {
      items = list;
      if (open) renderMenu(lastQuery);
      // List arrived while the field was focused (e.g. models finished
      // loading after a click) — open now instead of requiring a re-click
      else if (document.activeElement === input) openMenu();
    },
  };
}

export function streamingDots() {
  return el('span', { class: 'streaming-dots' }, el('span'), el('span'), el('span'));
}
