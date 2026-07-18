import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, replaceTemplateVars } from '../src/renderer/js/util.js';

test('estimateTokens: Latin text at ~4 chars per token', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens('abc'), 1); // rounds up
});

test('estimateTokens: CJK counts ~1 token per character', () => {
  assert.equal(estimateTokens('こんにちは'), 5); // 5 kana
  assert.equal(estimateTokens('你好世界'), 4); // 4 hanzi
  assert.equal(estimateTokens('안녕하세요'), 5); // 5 hangul syllables
});

test('estimateTokens: mixed text counts each script at its own rate', () => {
  // 4 hanzi (4) + 8 latin chars incl. spaces (2)
  assert.equal(estimateTokens('你好世界 abcdefg'), 4 + 2);
  // CJK punctuation and full-width forms count as CJK
  assert.equal(estimateTokens('「あ」'), 3);
});

test('replaceTemplateVars swaps char and user', () => {
  assert.equal(replaceTemplateVars('{{char}} meets {{user}}', 'Alice', 'Bob'), 'Alice meets Bob');
});
