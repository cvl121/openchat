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

test('markdown links render as anchors, http(s) only', () => {
  const html = renderMarkdown('See [the docs](https://example.com/docs) here');
  assert.match(html, /<a class='md-link' href='https:\/\/example\.com\/docs'>the docs<\/a>/);
  // Non-http schemes stay literal text
  const bad = renderMarkdown('[click](javascript:alert(1))');
  assert.doesNotMatch(bad, /<a /);
});

test('bare URLs autolink and keep query entities escaped', () => {
  const html = renderMarkdown('visit https://example.com/a?b=1&c=2 today');
  assert.match(html, /<a class='md-link' href='https:\/\/example\.com\/a\?b=1&amp;c=2'>/);
  // Trailing punctuation is not part of the link
  const trail = renderMarkdown('go to https://example.com.');
  assert.match(trail, /href='https:\/\/example\.com'/);
  assert.doesNotMatch(trail, /href='https:\/\/example\.com\.'/);
});

test('links cannot break out of the href attribute', () => {
  const html = renderMarkdown("[x](https://e.com/'onclick='alert(1))");
  assert.doesNotMatch(html, /onclick='alert/);
  assert.match(html, /&#39;onclick=&#39;/);
});

test('strikethrough', () => {
  assert.match(renderMarkdown('~~gone~~'), /<s>gone<\/s>/);
});

test('pipe tables render with scroll wrapper and alignment classes', () => {
  const html = renderMarkdown('| Name | Score |\n|:---|---:|\n| Ann | 3 |\n| Bo | 12 |');
  assert.match(html, /<div class='md-table-wrap'><table class='md-table'>/);
  assert.match(html, /<th>Name<\/th><th class='md-right'>Score<\/th>/);
  assert.match(html, /<td>Ann<\/td><td class='md-right'>3<\/td>/);
  assert.match(html, /<td>Bo<\/td>/);
});

test('lines with pipes but no separator are not tables', () => {
  const html = renderMarkdown('either | or');
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /<p>either \| or<\/p>/);
});

test('nested lists indent into nested elements', () => {
  const html = renderMarkdown('- top\n  - inner\n- top2');
  assert.match(html, /<ul>\n<li>top<\/li>\n<ul>\n<li>inner<\/li>\n<\/ul>\n<li>top2<\/li>\n<\/ul>/);
});

test('fenced code with language gets highlighting and language class', () => {
  const html = renderMarkdown('```js\nconst x = 42 // answer\n```');
  assert.match(html, /<code class='md-lang-javascript'>/);
  assert.match(html, /<span class='tok-keyword'>const<\/span>/);
  assert.match(html, /<span class='tok-number'>42<\/span>/);
  assert.match(html, /<span class='tok-comment'>\/\/ answer<\/span>/);
});

test('python and json highlighting', () => {
  const py = renderMarkdown('```python\ndef f():\n    return None  # noop\n```');
  assert.match(py, /<span class='tok-keyword'>def<\/span>/);
  assert.match(py, /<span class='tok-comment'># noop<\/span>/);
  const json = renderMarkdown('```json\n{"a": true, "n": 1.5}\n```');
  assert.match(json, /<span class='tok-string'>"a"<\/span>/);
  assert.match(json, /<span class='tok-keyword'>true<\/span>/);
});

test('highlighting is XSS-safe', () => {
  const html = renderMarkdown('```html\n<img src=x onerror=alert(1)>\n```');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  const js = renderMarkdown('```js\nconst s = "</code><img src=x onerror=alert(1)>"\n```');
  assert.doesNotMatch(js, /<img/);
});

test('unknown languages fall back to escaped plain text', () => {
  const html = renderMarkdown('```brainfuck\n<+++>\n```');
  assert.match(html, /&lt;\+\+\+&gt;/);
  assert.doesNotMatch(html, /tok-/);
});

test('code blocks carry a copy button', () => {
  const html = renderMarkdown('```\nhello\n```');
  assert.match(html, /<button class='md-code-copy' type='button' aria-label='Copy code'>Copy<\/button>/);
  assert.match(html, /<span class='md-code-lang'><\/span>/);
});
