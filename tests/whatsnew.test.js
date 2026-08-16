import test from 'node:test';
import assert from 'node:assert/strict';
import { WHATS_NEW, notesSince } from '../src/shared/whatsnew.js';
import { compareVersions } from '../src/shared/version.js';

test('every entry has a version and non-empty English items', () => {
  for (const entry of WHATS_NEW) {
    assert.match(entry.version, /^\d+\.\d+(\.\d+)?$/, `bad version: ${entry.version}`);
    assert.ok(Array.isArray(entry.items.en) && entry.items.en.length, `no en items for ${entry.version}`);
    for (const items of Object.values(entry.items)) {
      assert.ok(items.every((s) => typeof s === 'string' && s.trim()), `blank item in ${entry.version}`);
    }
  }
});

test('entries are unique per version', () => {
  const versions = WHATS_NEW.map((e) => e.version);
  assert.equal(new Set(versions).size, versions.length);
});

test('notesSince returns only versions in (lastSeen, current], newest first', () => {
  const notes = notesSince('0.8.0', '0.9.0');
  assert.ok(notes.length >= 1);
  assert.equal(notes[0].version, '0.9.0');
  for (const n of notes) {
    assert.ok(compareVersions(n.version, '0.8.0') > 0);
    assert.ok(compareVersions(n.version, '0.9.0') <= 0);
  }
  for (let i = 1; i < notes.length; i++) {
    assert.ok(compareVersions(notes[i - 1].version, notes[i].version) > 0);
  }
});

test('notesSince is empty when already on the latest seen version', () => {
  assert.deepEqual(notesSince('0.9.0', '0.9.0'), []);
  assert.deepEqual(notesSince('9.9.9', '0.9.0'), []);
});

test('notesSince resolves the requested locale and falls back to English', () => {
  const [ja] = notesSince('0.8.0', '0.9.0', 'ja');
  assert.deepEqual(ja.items, WHATS_NEW.find((e) => e.version === '0.9.0').items.ja);
  const [unknown] = notesSince('0.8.0', '0.9.0', 'fr');
  assert.deepEqual(unknown.items, WHATS_NEW.find((e) => e.version === '0.9.0').items.en);
});
