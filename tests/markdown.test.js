import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/renderer/js/markdown.js';

test('escapes HTML in input', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('quoted text gets dialogue styling', () => {
  const html = renderMarkdown('She said "hello there" softly.');
  assert.match(html, /<span class='md-quote'>"hello there"<\/span>/);
});

test('CJK quotes get dialogue styling', () => {
  assert.match(renderMarkdown('彼女は「こんにちは」と言った。'), /<span class='md-quote'>「こんにちは」<\/span>/);
  assert.match(renderMarkdown('『二重かぎ括弧』も対話。'), /<span class='md-quote'>『二重かぎ括弧』<\/span>/);
  assert.match(renderMarkdown('她说：“你好。”'), /<span class='md-quote'>“你好。”<\/span>/);
  // Unpaired brackets stay plain
  assert.doesNotMatch(renderMarkdown('片方だけ「の括弧'), /md-quote/);
});

test('single asterisk italic is action text', () => {
  const html = renderMarkdown('*walks to the door*');
  assert.match(html, /<em class='md-action'>walks to the door<\/em>/);
});

test('asterisk-quoted is italic dialogue', () => {
  const html = renderMarkdown('*"whispered words"*');
  // Inner quote span nesting is fine — both carry the dialogue color
  assert.match(html, /<em class='md-quote'>.*"whispered words".*<\/em>/);
});

test('bold, headers, code, blockquote, lists, hr', () => {
  assert.match(renderMarkdown('**bold**'), /<strong>bold<\/strong>/);
  assert.match(renderMarkdown('## Title'), /<h2>Title<\/h2>/);
  assert.match(renderMarkdown('`code`'), /<code>code<\/code>/);
  assert.match(renderMarkdown('> quoted'), /<blockquote>quoted<\/blockquote>/);
  assert.match(renderMarkdown('- item'), /<ul>\n<li>item<\/li>\n<\/ul>/);
  assert.match(renderMarkdown('1. first'), /<ol>\n<li>first<\/li>\n<\/ol>/);
  assert.match(renderMarkdown('---'), /<hr>/);
});

test('fenced code blocks preserve content without inline formatting', () => {
  const html = renderMarkdown('```\n*not italic* "not quote"\n```');
  assert.match(html, /<pre><code>\*not italic\* "not quote"<\/code><\/pre>/);
});

test('inline code protects content from formatting', () => {
  const html = renderMarkdown('use `*args*` here');
  assert.match(html, /<code>\*args\*<\/code>/);
  assert.doesNotMatch(html, /md-action/);
});

test('plain numbers are untouched', () => {
  const html = renderMarkdown('there are 3 things and 7 others');
  assert.match(html, /there are 3 things and 7 others/);
});

test('paragraphs and line breaks', () => {
  const html = renderMarkdown('line one\nline two\n\nnew paragraph');
  assert.match(html, /<p>line one<br>line two<\/p>/);
  assert.match(html, /<p>new paragraph<\/p>/);
});
