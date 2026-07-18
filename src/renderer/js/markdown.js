// Tavern-flavored markdown renderer:
// "quoted text" (also 「…」/『…』/“…”) gets the dialogue color, *italic* gets the action color,
// *"quoted in asterisks"* gets italic + dialogue color, narrative text uses
// the base color. Plus headers, bold, code, blockquotes, lists, and rules.
//
// All input is HTML-escaped before any markup is generated.

import { escapeHtml } from './util.js';

function renderInline(text) {
  const codeSpans = [];
  let out = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    codeSpans.push(code);
    return `\x00${codeSpans.length - 1}\x00`;
  });

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

  out = out.replace(/\x00(\d+)\x00/g, (_m, i) => `<code>${codeSpans[+i]}</code>`);
  return out;
}

export function renderMarkdown(raw) {
  if (!raw) return '';
  const lines = escapeHtml(raw.replace(/\r\n/g, '\n')).split('\n');
  const html = [];
  let inCode = false;
  let codeLines = [];
  let listType = null; // 'ul' | 'ol'
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        html.push(`<pre><code>${codeLines.join('\n')}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trim();
    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
    const ordered = trimmed.match(/^\d+[.)]\s+(.*)$/);

    if (!trimmed) {
      flushParagraph();
      flushList();
    } else if (heading) {
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
    } else if (bullet) {
      flushParagraph();
      if (listType !== 'ul') {
        flushList();
        html.push('<ul>');
        listType = 'ul';
      }
      html.push(`<li>${renderInline(bullet[1])}</li>`);
    } else if (ordered) {
      flushParagraph();
      if (listType !== 'ol') {
        flushList();
        html.push('<ol>');
        listType = 'ol';
      }
      html.push(`<li>${renderInline(ordered[1])}</li>`);
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  if (inCode && codeLines.length) html.push(`<pre><code>${codeLines.join('\n')}</code></pre>`);
  flushParagraph();
  flushList();
  return html.join('\n');
}
