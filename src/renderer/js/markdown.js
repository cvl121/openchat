// Tavern-flavored markdown renderer:
// "quoted text" (also 「…」/『…』/“…”) gets the dialogue color, *italic* gets the action color,
// *"quoted in asterisks"* gets italic + dialogue color, narrative text uses
// the base color. Plus headers, bold, strikethrough, links, code (with
// lightweight syntax highlighting and a copy button), tables, blockquotes,
// nested lists, and rules.
//
// All input is HTML-escaped before any markup is generated. Links are limited
// to http(s) and open through the main process (misc:openExternal); CSP blocks
// inline handlers, so clicks are handled by one delegated listener below.

import { escapeHtml } from './util.js';
import { t } from '../../shared/i18n.js';

// Values interpolated into single-quoted attributes; input is already
// entity-escaped, so only quotes need handling here.
const attrEscape = (s) => s.replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Code blocks are un-escaped for tokenizing, then re-escaped per token.
const unescapeEntities = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function renderInline(text) {
  const saved = [];
  const protect = (html) => {
    saved.push(html);
    return `\x00${saved.length - 1}\x00`;
  };

  let out = text.replace(/`([^`\n]+)`/g, (_m, code) => protect(`<code>${code}</code>`));

  // [label](url) — the regex itself restricts schemes to http(s)
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) =>
    protect(`<a class='md-link' href='${attrEscape(url)}'>${label}</a>`)
  );

  // Bare-URL autolink
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s\x00]+)/g, (m, pre, url) => {
    // A URL ends at any escaped <, >, or quote
    for (const stop of ['&lt;', '&gt;', '&quot;', '&#39;']) {
      const i = url.indexOf(stop);
      if (i !== -1) url = url.slice(0, i);
    }
    let trail = '';
    const stripped = url.replace(/[.,;:!?]+$/, '');
    trail = url.slice(stripped.length);
    url = stripped;
    if (url.endsWith(')') && !url.includes('(')) {
      url = url.slice(0, -1);
      trail = `)${trail}`;
    }
    if (!/^https?:\/\/[^/\s]+\.[^\s]/.test(url)) return m;
    return `${pre}${protect(`<a class='md-link' href='${attrEscape(url)}'>${url}</a>`)}${trail}`;
  });

  out = out.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  // *"quoted dialogue in asterisks"* → italic dialogue (SillyTavern convention)
  out = out.replace(/\*("[^"*\n]+")\*/g, "<em class='md-quote'>$1</em>");
  // Bold
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // Italic single-asterisk = action/emote text
  out = out.replace(/\*([^*\n]+)\*/g, "<em class='md-action'>$1</em>");
  // Plain quoted text = dialogue (single-quoted attrs so this regex can't match them)
  out = out.replace(/"([^"\n]*[^"\s][^"\n]*)"/g, '<span class=\'md-quote\'>"$1"</span>');
  // CJK dialogue quoting: 「…」/『…』 (Japanese) and “…” (Chinese/curly)
  out = out.replace(/「[^」\n]+」|『[^』\n]+』|“[^”\n]+”/g, "<span class='md-quote'>$&</span>");

  out = out.replace(/\x00(\d+)\x00/g, (_m, i) => saved[+i]);
  return out;
}

// ---------------------------------------------------------------------------
// Syntax highlighting — a deliberately tiny tokenizer, no dependencies.

const KEYWORDS = {
  javascript:
    'const let var function return if else for while do break continue new class extends super import export from default try catch finally throw switch case async await yield typeof instanceof in of null undefined true false this static delete void interface type enum implements public private protected readonly',
  python:
    'def return if elif else for while break continue import from as class try except finally raise with lambda pass yield global nonlocal assert del not and or in is None True False async await self match case',
  json: 'true false null',
  bash: 'if then elif else fi for while until do done case esac function in select time echo exit return local export source set unset read declare readonly shift trap',
  css: '',
};

const LANG_ALIASES = {
  js: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript',
  typescript: 'javascript', node: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', python3: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  htm: 'html', xhtml: 'html', svg: 'html',
};

const LANG_CONFIG = {
  javascript: { lineComment: '//', blockComment: ['/*', '*/'], strings: `'"\`` },
  python: { lineComment: '#', strings: `'"` },
  json: { strings: '"' },
  bash: { lineComment: '#', strings: `'"` },
  css: { blockComment: ['/*', '*/'], strings: `'"` },
};

function normalizeLang(lang) {
  if (!lang) return '';
  const l = lang.toLowerCase();
  if (!/^[a-z0-9+#-]+$/.test(l)) return '';
  return LANG_ALIASES[l] ?? l;
}

const tok = (type, text) => `<span class='tok-${type}'>${escapeHtml(text)}</span>`;

function highlightMarkup(code) {
  const out = [];
  const re = /(<!--[\s\S]*?(?:-->|$))|(<\/?[a-zA-Z][^<>]*>?)/g;
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    out.push(escapeHtml(code.slice(last, m.index)));
    out.push(m[1] ? tok('comment', m[1]) : tok('keyword', m[2]));
    last = m.index + m[0].length;
  }
  out.push(escapeHtml(code.slice(last)));
  return out.join('');
}

function highlightCode(code, lang) {
  if (lang === 'html' || lang === 'xml') return highlightMarkup(code);
  const cfg = LANG_CONFIG[lang];
  if (!cfg) return escapeHtml(code);
  const keywords = new Set((KEYWORDS[lang] ?? '').split(' ').filter(Boolean));
  const out = [];
  let plain = '';
  const flushPlain = () => {
    if (plain) {
      out.push(escapeHtml(plain));
      plain = '';
    }
  };
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (cfg.lineComment && code.startsWith(cfg.lineComment, i)) {
      flushPlain();
      let end = code.indexOf('\n', i);
      if (end === -1) end = code.length;
      out.push(tok('comment', code.slice(i, end)));
      i = end;
    } else if (cfg.blockComment && code.startsWith(cfg.blockComment[0], i)) {
      flushPlain();
      let end = code.indexOf(cfg.blockComment[1], i + cfg.blockComment[0].length);
      end = end === -1 ? code.length : end + cfg.blockComment[1].length;
      out.push(tok('comment', code.slice(i, end)));
      i = end;
    } else if (cfg.strings?.includes(ch)) {
      flushPlain();
      let j = i + 1;
      while (j < code.length && code[j] !== ch && (ch === '`' || code[j] !== '\n')) {
        if (code[j] === '\\') j++;
        j++;
      }
      j = Math.min(j + 1, code.length);
      out.push(tok('string', code.slice(i, j)));
      i = j;
    } else if (/\d/.test(ch) && !/[\w$]/.test(code[i - 1] ?? '')) {
      flushPlain();
      let j = i;
      while (j < code.length && /[\w.]/.test(code[j])) j++;
      out.push(tok('number', code.slice(i, j)));
      i = j;
    } else if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < code.length && /[\w$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      if (keywords.has(word)) {
        flushPlain();
        out.push(tok('keyword', word));
      } else {
        plain += word;
      }
      i = j;
    } else {
      plain += ch;
      i++;
    }
  }
  flushPlain();
  return out.join('');
}

// ---------------------------------------------------------------------------
// Tables

const isTableSeparator = (s) => s.includes('|') && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(s);

const splitRow = (s) =>
  s.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

const parseAligns = (sep) =>
  splitRow(sep).map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return " class='md-center'";
    if (right) return " class='md-right'";
    return '';
  });

export function renderMarkdown(raw) {
  if (!raw) return '';
  const lines = escapeHtml(raw.replace(/\r\n/g, '\n')).split('\n');
  const html = [];
  let inCode = false;
  let codeLines = [];
  let codeLang = '';
  let listStack = []; // [{type: 'ul'|'ol', indent}]
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
      paragraph = [];
    }
  };
  const flushList = (toIndent = -1) => {
    while (listStack.length && listStack[listStack.length - 1].indent > toIndent) {
      html.push(`</${listStack.pop().type}>`);
    }
  };
  const emitCodeBlock = () => {
    const code = unescapeEntities(codeLines.join('\n'));
    const lang = normalizeLang(codeLang);
    const body = lang ? highlightCode(code, lang) : escapeHtml(code);
    html.push(
      `<div class='md-code'>` +
        `<div class='md-code-head'><span class='md-code-lang'>${lang}</span>` +
        `<button class='md-code-copy' type='button' aria-label='${t('chat.copyCode')}'>${t('common.copy')}</button></div>` +
        `<pre><code${lang ? ` class='md-lang-${lang}'` : ''}>${body}</code></pre></div>`
    );
    codeLines = [];
    codeLang = '';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      if (inCode) {
        emitCodeBlock();
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        codeLang = line.trim().slice(3).trim();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trim();
    const next = (lines[i + 1] ?? '').trim();

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    // GFM pipe table: a header row followed by a |---|---| separator
    if (trimmed.includes('|') && isTableSeparator(next)) {
      flushParagraph();
      flushList();
      const aligns = parseAligns(next);
      const cellsHtml = (cells, tag) =>
        cells.map((c, j) => `<${tag}${aligns[j] ?? ''}>${renderInline(c)}</${tag}>`).join('');
      const rows = [`<tr>${cellsHtml(splitRow(trimmed), 'th')}</tr>`];
      i++; // consume the separator
      while (i + 1 < lines.length && lines[i + 1].trim().includes('|') && !lines[i + 1].trim().startsWith('```')) {
        i++;
        rows.push(`<tr>${cellsHtml(splitRow(lines[i].trim()), 'td')}</tr>`);
      }
      html.push(`<div class='md-table-wrap'><table class='md-table'>${rows.join('')}</table></div>`);
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const ordered = line.match(/^(\s*)\d+[.)]\s+(.*)$/);

    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
    } else if (/^(-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
      flushParagraph();
      flushList();
      html.push('<hr>');
    } else if (trimmed.startsWith('&gt;')) {
      flushParagraph();
      flushList();
      html.push(`<blockquote>${renderInline(trimmed.replace(/^&gt;\s?/, ''))}</blockquote>`);
    } else if (bullet || ordered) {
      flushParagraph();
      const [, spaces, content] = bullet ?? ordered;
      const type = bullet ? 'ul' : 'ol';
      const indent = spaces.length;
      flushList(indent);
      const top = listStack[listStack.length - 1];
      if (!top || indent > top.indent) {
        html.push(`<${type}>`);
        listStack.push({ type, indent });
      } else if (top.type !== type) {
        html.push(`</${top.type}>`);
        listStack.pop();
        html.push(`<${type}>`);
        listStack.push({ type, indent });
      }
      html.push(`<li>${renderInline(content)}</li>`);
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  if (inCode && codeLines.length) emitCodeBlock();
  flushParagraph();
  flushList();
  return html.join('\n');
}

// ---------------------------------------------------------------------------
// One delegated listener for link opens and code copies (CSP forbids inline
// handlers). Guarded so importing this module in Node tests is harmless.

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const link = e.target?.closest?.('a.md-link');
    if (link) {
      e.preventDefault();
      const href = link.getAttribute('href') ?? '';
      if (/^https?:\/\//i.test(href)) window.tavern?.misc?.openExternal?.(href);
      return;
    }
    const btn = e.target?.closest?.('button.md-code-copy');
    if (btn) {
      const code = btn.closest('.md-code')?.querySelector('code');
      if (!code) return;
      navigator.clipboard?.writeText?.(code.textContent ?? '');
      btn.textContent = t('common.copied');
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = t('common.copy');
        btn.classList.remove('copied');
      }, 1500);
    }
  });
}
