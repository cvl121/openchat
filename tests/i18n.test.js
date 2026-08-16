// i18n runtime + locale-file integrity: key parity across locales, placeholder
// preservation, interpolation, fallback, and locale resolution.

import test from 'node:test';
import assert from 'node:assert/strict';
import { t, setLocale, currentLocale, resolveLocale, LOCALES, LOCALE_LABELS } from '../src/shared/i18n.js';
import { en } from '../src/shared/locales/en.js';
import { foldText, truncateChars } from '../src/shared/text.js';

// The default locale can leak across test files (node --test shares the
// process per file, but be safe within this one).
test.afterEach(() => setLocale('en'));

test('every locale has exactly the keys of en', () => {
  const enKeys = Object.keys(en);
  for (const [code, dict] of Object.entries(LOCALES)) {
    const keys = Object.keys(dict);
    assert.deepEqual(keys.sort(), [...enKeys].sort(), `key set mismatch in ${code}`);
  }
});

test('placeholders in en appear in every translation', () => {
  for (const [key, value] of Object.entries(en)) {
    const params = value.match(/\{[a-zA-Z]+\}/g) ?? [];
    for (const [code, dict] of Object.entries(LOCALES)) {
      for (const p of params) {
        assert.ok(dict[key].includes(p), `${code}:${key} is missing placeholder ${p}`);
      }
    }
  }
});

test('t(): interpolation, fallback to en, unknown key renders as itself', () => {
  setLocale('en');
  assert.equal(t('chat.switchedTo', { model: 'gpt-4o' }), 'Switched to gpt-4o');
  assert.equal(t('no.such.key'), 'no.such.key');
  setLocale('es');
  assert.equal(currentLocale(), 'es');
  assert.notEqual(t('common.cancel'), 'Cancel'); // actually translated
  setLocale('nope');
  assert.equal(currentLocale(), 'en'); // unknown locale falls back
});

test('resolveLocale: explicit setting wins, system tag maps, default en', () => {
  assert.equal(resolveLocale('ja', 'en-US'), 'ja');
  assert.equal(resolveLocale('system', 'es-MX'), 'es');
  assert.equal(resolveLocale('system', 'zh-Hant-TW'), 'zh-CN');
  assert.equal(resolveLocale('system', 'ja-JP'), 'ja');
  assert.equal(resolveLocale('system', 'de-DE'), 'en');
  assert.equal(resolveLocale(undefined, ''), 'en');
  assert.equal(resolveLocale('xx', 'ja'), 'ja'); // unsupported setting → system
});

test('every supported locale has a native label', () => {
  for (const code of Object.keys(LOCALES)) {
    assert.ok(LOCALE_LABELS[code], `missing label for ${code}`);
  }
});

test('foldText: accent/case folding is length-preserving; kana untouched', () => {
  assert.equal(foldText('José ÁRBOL'), 'jose arbol');
  assert.equal(foldText('José').length, 'José'.length);
  assert.ok(foldText('así se hace').includes(foldText('ASI')));
  assert.equal(foldText('ばば'), 'ばば'); // no dakuten stripping
  assert.equal(foldText('日本語テスト'), '日本語テスト');
});

test('truncateChars: never splits surrogate pairs', () => {
  const s = '𠀋𠀋𠀋'; // plane-2 Han, 2 UTF-16 units each
  assert.equal(truncateChars(s, 2), '𠀋𠀋');
  assert.equal(truncateChars('abc', 10), 'abc');
  assert.equal(truncateChars('', 5), '');
});
