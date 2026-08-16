// Shared UI widgets.

import { el } from './util.js';

/** Avatar image with fallback to colored initials. */
export function avatar(url, name, size = 36) {
  if (url) {
    const img = el('img', {
      class: 'avatar',
      src: url,
      width: size,
      height: size,
      alt: name ?? '',
    });
    img.addEventListener('error', () => img.replaceWith(initialsAvatar(name, size)));
    return img;
  }
  return initialsAvatar(name, size);
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

export function streamingDots() {
  return el('span', { class: 'streaming-dots' }, el('span'), el('span'), el('span'));
}
