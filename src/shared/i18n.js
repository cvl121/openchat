// Tiny i18n runtime shared by the renderer (all UI strings) and the main
// process (menu labels, user-facing error messages). No framework: locale
// dictionaries are flat {key: string} maps with {param} placeholders, English
// is the fallback for any missing key, and an unknown key renders as itself so
// a missed translation is visible instead of fatal.

import { en } from './locales/en.js';
import { es } from './locales/es.js';
import { zhCN } from './locales/zh-CN.js';
import { ja } from './locales/ja.js';

export const LOCALES = { en, es, 'zh-CN': zhCN, ja };

// Native-language names for the settings picker (never translated).
export const LOCALE_LABELS = { en: 'English', es: 'Español', 'zh-CN': '中文（简体）', ja: '日本語' };

let current = 'en';
let dict = en;

/**
 * Map the settings value ('system' | locale code) plus a BCP-47 system tag
 * (navigator.language / app.getLocale()) onto a supported locale.
 */
export function resolveLocale(setting, systemTag = '') {
  if (setting && setting !== 'system' && LOCALES[setting]) return setting;
  const tag = String(systemTag).toLowerCase();
  if (tag.startsWith('es')) return 'es';
  if (tag.startsWith('zh')) return 'zh-CN';
  if (tag.startsWith('ja')) return 'ja';
  return 'en';
}

export function setLocale(code) {
  current = LOCALES[code] ? code : 'en';
  dict = LOCALES[current];
}

export function currentLocale() {
  return current;
}

export function t(key, params) {
  let s = dict[key] ?? en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}
