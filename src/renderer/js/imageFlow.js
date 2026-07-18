// Image-generation flow helpers, kept free of DOM/state so they can be unit
// tested. Two problems they solve:
//
// 1. Chat models that *know about* images but can't emit them in a text-only
//    request (e.g. Gemini via OpenRouter with a generated image earlier in the
//    chat) answer an image request with a bare placeholder token like
//    "<image>" instead of text. The chat flow detects that and re-routes the
//    turn to the configured image model.
// 2. Mistyped model IDs surface as raw provider errors mid-chat; pointing at
//    the right settings screen turns a dead end into a fix.

/** A response that is nothing but image-placeholder tokens and whitespace. */
const IMAGE_PLACEHOLDER_RE = /^(?:\s*(?:<image>|\[image\]|<img\s*\/?>))+\s*$/i;

export function isImagePlaceholder(text) {
  return IMAGE_PLACEHOLDER_RE.test(text ?? '');
}

/**
 * What the chat flow should do with a finished assistant message.
 *   'strip'   — real image(s) arrived alongside a placeholder echo; drop the text
 *   'reroute' — no image came back but image generation is enabled; re-run the
 *               turn against the image model
 *   'hint'    — placeholder but nothing to re-route to; tell the user why
 *   'none'    — a normal response
 */
export function imageFollowupAction(text, { hasImages = false, imageGenEnabled = false, alreadyRerouted = false } = {}) {
  if (!isImagePlaceholder(text)) return 'none';
  if (hasImages) return 'strip';
  if (imageGenEnabled && !alreadyRerouted) return 'reroute';
  return 'hint';
}

export const IMAGE_HINT_MESSAGE =
  'The chat model tried to answer with an image it cannot produce here. ' +
  'Enable Image Generation in Settings and use the 🎨 button, or rephrase your request.';

/** Append a where-to-fix-it pointer to unknown-model provider errors. */
export function decorateModelError(message, { imageTurn = false } = {}) {
  if (/not a valid model|model.{0,20}not.{0,10}(?:found|exist)|unknown model/i.test(message ?? '')) {
    const where = imageTurn ? 'Image Model in Settings → Image Generation' : 'model in Settings → API';
    return `${message} — check the ${where}.`;
  }
  return message;
}
