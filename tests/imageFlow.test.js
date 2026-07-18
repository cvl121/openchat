// The image-generation chat flow: placeholder detection, re-route decisions,
// and error decoration. These guard the two real-world failure modes:
// a chat model answering an image request with a literal "<image>" token,
// and a mistyped image-model ID surfacing as a bare provider error.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isImagePlaceholder,
  imageFollowupAction,
  decorateModelError,
  IMAGE_HINT_MESSAGE,
} from '../src/renderer/js/imageFlow.js';

test('isImagePlaceholder: bare placeholder tokens in any casing or repetition', () => {
  assert.equal(isImagePlaceholder('<image>'), true);
  assert.equal(isImagePlaceholder('  <image>\n'), true);
  assert.equal(isImagePlaceholder('<IMAGE>'), true);
  assert.equal(isImagePlaceholder('<image><image>'), true);
  assert.equal(isImagePlaceholder('[image]'), true);
  assert.equal(isImagePlaceholder('<img>'), true);
  assert.equal(isImagePlaceholder('<img/>'), true);
});

test('isImagePlaceholder: real content is never a placeholder', () => {
  assert.equal(isImagePlaceholder(''), false);
  assert.equal(isImagePlaceholder(null), false);
  assert.equal(isImagePlaceholder(undefined), false);
  assert.equal(isImagePlaceholder('Here is your image: <image>'), false);
  assert.equal(isImagePlaceholder('<image> A red apple on a table.'), false);
  assert.equal(isImagePlaceholder('An image of a cat'), false);
  assert.equal(isImagePlaceholder('![image](https://example.com/x.png)'), false);
});

test('imageFollowupAction: normal responses pass through', () => {
  assert.equal(imageFollowupAction('Hello!', { imageGenEnabled: true }), 'none');
  assert.equal(imageFollowupAction('', { imageGenEnabled: true }), 'none');
});

test('imageFollowupAction: placeholder with a real image attached → strip', () => {
  assert.equal(
    imageFollowupAction('<image>', { hasImages: true, imageGenEnabled: true }),
    'strip'
  );
  // strip wins even when a re-route would otherwise be possible
  assert.equal(
    imageFollowupAction('<image>', { hasImages: true, imageGenEnabled: false }),
    'strip'
  );
});

test('imageFollowupAction: placeholder without image → reroute when enabled, once', () => {
  assert.equal(imageFollowupAction('<image>', { imageGenEnabled: true }), 'reroute');
  assert.equal(
    imageFollowupAction('<image>', { imageGenEnabled: true, alreadyRerouted: true }),
    'hint'
  );
  assert.equal(imageFollowupAction('<image>', { imageGenEnabled: false }), 'hint');
});

test('hint message tells the user what to do', () => {
  assert.match(IMAGE_HINT_MESSAGE, /Image Generation/);
  assert.match(IMAGE_HINT_MESSAGE, /🎨/);
});

test('decorateModelError: unknown-model errors point at the right settings', () => {
  const openrouterMsg = 'OpenRouter error (400): gemini-3.1-image is not a valid model ID';
  assert.match(
    decorateModelError(openrouterMsg, { imageTurn: true }),
    /Image Model in Settings → Image Generation/
  );
  assert.match(decorateModelError(openrouterMsg, { imageTurn: false }), /Settings → API/);
  assert.match(decorateModelError('The model `x` does not exist'), /Settings → API/);
  assert.match(decorateModelError('Error: model not found'), /Settings → API/);
});

test('decorateModelError: other errors are untouched', () => {
  assert.equal(decorateModelError('Invalid API key', { imageTurn: true }), 'Invalid API key');
  assert.equal(decorateModelError('rate limit exceeded'), 'rate limit exceeded');
});
