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
    version: '0.9.1',
    items: {
      en: [
        'After each update, this What’s New dialog now summarizes the changes.',
        'Editing a character no longer drops hidden card data (SillyTavern extensions, V3 extras) when saving.',
        'OpenAI reasoning models (o-series, GPT-5) now work through the Custom provider when pointed at api.openai.com.',
        'Windows: the installer now has a proper app icon.',
      ],
      es: [
        'Después de cada actualización, este diálogo de novedades resume los cambios.',
        'Editar un personaje ya no elimina datos ocultos de la tarjeta (extensiones de SillyTavern, extras V3) al guardar.',
        'Los modelos de razonamiento de OpenAI (serie o, GPT-5) ahora funcionan con el proveedor personalizado apuntando a api.openai.com.',
        'Windows: el instalador ahora tiene un icono adecuado.',
      ],
      'zh-CN': [
        '每次更新后，这个“新功能”对话框会总结变更内容。',
        '编辑角色时不再丢失卡片中的隐藏数据（SillyTavern 扩展、V3 附加字段）。',
        'OpenAI 推理模型（o 系列、GPT-5）现在可通过指向 api.openai.com 的自定义服务商使用。',
        'Windows：安装程序现在有了正确的应用图标。',
      ],
      ja: [
        'アップデート後に、この「新機能」ダイアログが変更点をまとめて表示します。',
        'キャラクター編集時に、カードの非表示データ（SillyTavern 拡張、V3 の追加フィールド）が保存で失われなくなりました。',
        'OpenAI の推論モデル（o シリーズ、GPT-5）が、api.openai.com を指すカスタムプロバイダー経由でも動作するようになりました。',
        'Windows：インストーラーに正しいアプリアイコンが付きました。',
      ],
    },
  },
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
