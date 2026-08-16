// Curated per-release notes for the What's New dialog, shown once after the
// app first launches on a new version.
//
// Release checklist: add an entry at the TOP for every release, before
// bumping package.json. Keep items user-facing — what someone would notice
// or should try, not internals. `en` is required; other locales are optional
// and fall back to English.
import { compareVersions } from './version.js';

export const WHATS_NEW = [
  {
    version: '0.9.0',
    items: {
      en: [
        'The entire UI now speaks English, Spanish, Simplified Chinese, and Japanese — switch in the settings.',
        'Generate images with the 🎨 button, powered by a dedicated image model.',
        'Long chats stay fast: older messages are summarized automatically in the background.',
      ],
      es: [
        'La interfaz ahora está disponible en inglés, español, chino simplificado y japonés — cámbialo en los ajustes.',
        'Genera imágenes con el botón 🎨, con un modelo de imagen dedicado.',
        'Los chats largos siguen siendo rápidos: los mensajes antiguos se resumen automáticamente en segundo plano.',
      ],
      'zh-CN': [
        '界面现已支持英语、西班牙语、简体中文和日语，可在设置中切换。',
        '使用 🎨 按钮生成图片，由专用图像模型驱动。',
        '长对话保持流畅：较早的消息会在后台自动压缩为摘要。',
      ],
      ja: [
        'UI が英語・スペイン語・簡体字中国語・日本語に対応しました。設定から切り替えられます。',
        '🎨 ボタンで専用の画像モデルによる画像生成ができます。',
        '長いチャットも快適に：古いメッセージはバックグラウンドで自動的に要約されます。',
      ],
    },
  },
];

/**
 * Notes for every version newer than `lastSeen` up to and including
 * `current`, newest first, with items resolved for `locale` (English
 * fallback). Returns [{ version, items: [string] }].
 */
export function notesSince(lastSeen, current, locale = 'en') {
  return WHATS_NEW.filter(
    (e) => compareVersions(e.version, lastSeen) > 0 && compareVersions(e.version, current) <= 0
  )
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((e) => ({ version: e.version, items: e.items[locale] ?? e.items.en }))
    .filter((e) => e.items?.length);
}
