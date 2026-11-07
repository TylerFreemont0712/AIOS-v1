// Markdown for the phone shell.
//
// The desktop's web/js/markdown.js does the same job, but it imports the desktop
// ui.js — pulling 24KB of menus and modals the phone never renders, and breaking the
// rule that /m shares nothing with the desktop shell. This is the same three vendored
// libraries (marked + DOMPurify + highlight.js) with a phone-shaped wrapper.
//
// Sanitising is not optional. Everything passed through here is model output, and it
// is assigned with innerHTML into a page holding a live pairing token.

import { marked, DOMPurify, hljs } from '../../vendor/md.js';

marked.setOptions({ gfm: true, breaks: true });

const PURIFY = {
  ADD_ATTR: ['class'],
  // No form controls: a chat bubble that can render an <input> is a phishing surface
  // inside the app's own origin, and nothing legitimate needs one.
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'style'],
};

/** Markdown → sanitized HTML string. Safe to assign to innerHTML. */
export function renderMarkdown(text) {
  let html;
  try { html = marked.parse(text || ''); }
  catch { html = escapeHtml(text || '').replace(/\n/g, '<br>'); }
  return DOMPurify.sanitize(html, PURIFY);
}

export const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Highlight code blocks and give each a copy button.
 *
 * Separate from renderMarkdown because it needs a live element, and because on a phone
 * it is worth skipping for a long transcript: highlightAuto over fifty blocks during a
 * scroll is the kind of thing that drops frames. Callers apply it to what is visible.
 */
export function enhanceCode(root) {
  for (const pre of root.querySelectorAll('pre:not([data-enhanced])')) {
    pre.dataset.enhanced = '1';
    const code = pre.querySelector('code');
    if (!code) continue;
    const lang = (/language-(\w+)/.exec(code.className || '') || [])[1] || '';
    if (lang && hljs.getLanguage(lang)) {
      try { code.innerHTML = hljs.highlight(code.textContent, { language: lang }).value; } catch { }
    }
    const bar = document.createElement('div');
    bar.className = 'm-code-bar';
    const name = document.createElement('span');
    name.textContent = lang || 'code';
    const copy = document.createElement('button');
    copy.className = 'm-code-copy';
    copy.textContent = 'copy';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code.textContent); copy.textContent = 'copied'; }
      catch { copy.textContent = 'failed'; }
      setTimeout(() => { copy.textContent = 'copy'; }, 1200);
    });
    bar.append(name, copy);
    pre.prepend(bar);
  }
}
