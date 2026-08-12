import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, evaluateRelease, checkForUpdate, RELEASES_API } from '../src/main/updates.js';

test('compareVersions: numeric segment ordering, not lexicographic', () => {
  assert.equal(compareVersions('1.2.0', '1.10.0'), -1);
  assert.equal(compareVersions('1.10.0', '1.2.0'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('v1.1.0', '1.0.9'), 1); // tag-style v prefix
  assert.equal(compareVersions('', '1.0.0'), -1); // malformed input never crashes
});

test('evaluateRelease: newer release is reported with version and URL', () => {
  const update = evaluateRelease(
    { tag_name: 'v1.1.0', html_url: 'https://example.com/release' },
    { currentVersion: '1.0.0' }
  );
  assert.deepEqual(update, { version: '1.1.0', url: 'https://example.com/release' });
});

test('evaluateRelease: same or older release is not an update', () => {
  assert.equal(evaluateRelease({ tag_name: 'v1.0.0' }, { currentVersion: '1.0.0' }), null);
  assert.equal(evaluateRelease({ tag_name: 'v0.9.0' }, { currentVersion: '1.0.0' }), null);
});

test('evaluateRelease: a skipped version stays silent, but newer ones do not', () => {
  const opts = { currentVersion: '1.0.0', skippedVersion: '1.1.0' };
  assert.equal(evaluateRelease({ tag_name: 'v1.1.0' }, opts), null);
  assert.equal(evaluateRelease({ tag_name: 'v1.2.0' }, opts)?.version, '1.2.0');
});

test('evaluateRelease: drafts, prereleases, and missing tags are ignored', () => {
  assert.equal(evaluateRelease({ tag_name: 'v9.0.0', draft: true }, { currentVersion: '1.0.0' }), null);
  assert.equal(evaluateRelease({ tag_name: 'v9.0.0', prerelease: true }, { currentVersion: '1.0.0' }), null);
  assert.equal(evaluateRelease({}, { currentVersion: '1.0.0' }), null);
  assert.equal(evaluateRelease(null, { currentVersion: '1.0.0' }), null);
});

test('checkForUpdate: fetches the releases API and evaluates the payload', async () => {
  let requested = null;
  const fetchImpl = async (url) => {
    requested = url;
    return { ok: true, json: async () => ({ tag_name: 'v2.0.0', html_url: 'https://example.com/v2' }) };
  };
  const update = await checkForUpdate({ currentVersion: '1.0.0', fetchImpl });
  assert.equal(requested, RELEASES_API);
  assert.deepEqual(update, { version: '2.0.0', url: 'https://example.com/v2' });
});

test('checkForUpdate: returns null when up to date, throws on HTTP errors', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ tag_name: 'v1.0.0' }) });
  assert.equal(await checkForUpdate({ currentVersion: '1.0.0', fetchImpl: ok }), null);

  const rateLimited = async () => ({ ok: false, status: 403 });
  await assert.rejects(
    checkForUpdate({ currentVersion: '1.0.0', fetchImpl: rateLimited }),
    /HTTP 403/
  );
});
