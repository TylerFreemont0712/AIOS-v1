// Markdown rendering: marked + highlight.js + DOMPurify, with [[wikilink]] support
// and copy buttons on code blocks. LLM output is untrusted → always sanitized.

import { marked, DOMPurify, hljs } from '../vendor/md.js';
import { el } from './ui.js';

marked.setOptions({ gfm: true, breaks: true });

const wikilinkExt = {
  name: 'wikilink',
  level: 'inline',
  start(src) { return src.indexOf('[['); },
  tokenizer(src) {
    const m = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/.exec(src);
    if (m) return { type: 'wikilink', raw: m[0], target: m[1].trim(), label: (m[2] || m[1]).trim() };
  },
  renderer(tok) {
    return `<a class="wikilink" data-wikilink="${escapeAttr(tok.target)}">${escapeHtml(tok.label)}</a>`;
  },
};
marked.use({ extensions: [wikilinkExt] });

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;');

/**
 * Render markdown into a sanitized element.
 * opts.onWikilink(target) — makes [[links]] clickable.
 */
export function renderMd(text, opts = {}) {
  const root = el('div', { class: 'md' });
  root.innerHTML = DOMPurify.sanitize(marked.parse(text || ''), {
    ADD_ATTR: ['data-wikilink', 'class'],
    FORBID_TAGS: ['style', 'form', 'input', 'button'],
  });

  for (const pre of root.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (!code) continue;
    const langMatch = /language-(\w+)/.exec(code.className || '');
    const lang = langMatch?.[1] || '';
    if (lang && hljs.getLanguage(lang)) {
      try { code.innerHTML = hljs.highlight(code.textContent, { language: lang }).value; } catch { }
    } else if (code.textContent.length < 8000) {
      try { const r = hljs.highlightAuto(code.textContent, ['javascript', 'python', 'bash', 'json']); if (r.relevance > 5) code.innerHTML = r.value; } catch { }
    }
    const bar = el('div', { class: 'code-bar' },
      el('span', {}, lang || 'code'),
      el('button', {
        class: 'code-copy', onclick: (e) => {
          navigator.clipboard.writeText(code.textContent);
          e.target.textContent = 'copied';
          setTimeout(() => e.target.textContent = 'copy', 1200);
        },
      }, 'copy'));
    pre.prepend(bar);
  }

  if (opts.onWikilink) {
    for (const a of root.querySelectorAll('[data-wikilink]')) {
      a.addEventListener('click', () => opts.onWikilink(a.dataset.wikilink));
    }
  }
  for (const a of root.querySelectorAll('a[href]')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  return root;
}
