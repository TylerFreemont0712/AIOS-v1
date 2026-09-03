// Notes — read the second brain from a phone, and add to it.
//
// Read-first by design. Composing a long note on a phone keyboard is miserable and
// the vault is edited properly at a desk; what is actually wanted out of the house is
// looking something up, and capturing a thought into today's daily note before it
// evaporates.

import { get, post } from '../../api.js';
import { el, fill, icon, toast, sheet, askSheet, ICONS, loading, empty, errorBox, relTime, debounce, pullToRefresh, buzz } from '../ui.js';
import { renderMarkdown, enhanceCode } from '../md.js';

/** Drop a leading YAML frontmatter block — it renders as a stray table on a phone. */
const stripFrontmatter = (t) => String(t || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

export default async function notesScreen({ host, ui }) {
  let notes = [];
  let mode = 'list';       // 'list' | 'note'

  const search = el('input', {
    class: 'm-search', type: 'search', placeholder: 'Search notes…',
    autocapitalize: 'off', autocorrect: 'off', enterkeyhint: 'search',
  });
  const searchBar = el('div', { class: 'm-searchbar' }, el('span', { class: 'm-search-i', html: ICONS.search }), search);
  const scroll = el('div', { class: 'm-scroll' });
  host.append(searchBar, scroll);

  ui.setTitle('Notes');
  setListActions();

  function setListActions() {
    ui.setLeft();
    ui.setActions(
      ui.action('plus', 'Capture to daily note', captureToDaily),
      ui.action('refresh', 'Refresh', () => loadList()),
    );
  }

  // ---------- list ----------

  const noteRow = (n) => el('button', { class: 'm-row m-row-tap', onclick: () => openNote(n.path) },
    el('span', { class: 'm-row-i', html: ICONS.note }),
    el('div', { class: 'm-grow' },
      el('div', { class: 'm-row-t' }, n.title || n.path),
      el('div', { class: 'm-row-m' }, [n.folder, relTime(new Date(n.mtime).toISOString())].filter(Boolean).join(' · ')),
      n.excerpt ? el('div', { class: 'm-row-x' }, n.excerpt.slice(0, 140)) : null));

  function renderList() {
    if (!notes.length) return fill(scroll, empty('No notes', search.value ? 'Nothing matched that search.' : 'The vault is empty.'));
    fill(scroll, el('div', { class: 'm-rows' }, ...notes.map(noteRow)));
  }

  async function loadList(q = '') {
    fill(scroll, loading());
    try {
      notes = await get(q ? `/vault/search?q=${encodeURIComponent(q)}&limit=40` : '/vault/notes?limit=40');
      if (!Array.isArray(notes)) notes = [];
      renderList();
    } catch (e) {
      fill(scroll, errorBox(e, () => loadList(q)));
    }
  }

  const doSearch = debounce((q) => loadList(q.trim()), 280);
  search.addEventListener('input', () => doSearch(search.value));
  search.addEventListener('search', () => loadList(search.value.trim()));

  // ---------- one note ----------

  async function openNote(path) {
    mode = 'note';
    searchBar.style.display = 'none';
    fill(scroll, loading());
    ui.setLeft(el('button', { class: 'm-head-btn', 'aria-label': 'Back', onclick: backToList }, el('span', { html: ICONS.back })));
    ui.setActions(ui.action('spark', 'Ask about this note', () => askAbout(path)));

    try {
      const n = await get('/vault/note?path=' + encodeURIComponent(path));
      // The endpoint returns { path, content } — the title and folder are the path's.
      const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      ui.setTitle(path.split('/').pop().replace(/\.md$/, ''), folder);
      const article = el('article', { class: 'm-md' });
      article.innerHTML = renderMarkdown(stripFrontmatter(n.content || ''));
      enhanceCode(article);
      // [[wikilinks]] survive the render as plain text; make the ones that resolve
      // tappable so the vault is navigable rather than a set of dead ends.
      wireWikilinks(article);
      fill(scroll, article);
      scroll.scrollTop = 0;
    } catch (e) {
      fill(scroll, errorBox(e, () => openNote(path)));
    }
  }

  function wireWikilinks(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walker.nextNode()) {
      if (/\[\[[^\]]+\]\]/.test(walker.currentNode.nodeValue)) hits.push(walker.currentNode);
    }
    for (const node of hits) {
      const parts = node.nodeValue.split(/(\[\[[^\]]+\]\])/g);
      const out = document.createDocumentFragment();
      for (const part of parts) {
        const m = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/.exec(part);
        if (!m) { out.append(document.createTextNode(part)); continue; }
        const target = m[1].trim();
        out.append(el('a', {
          class: 'm-wikilink',
          onclick: async () => {
            try {
              const r = await get('/vault/resolve?name=' + encodeURIComponent(target));
              if (r?.path) openNote(r.path);
              else toast(`No note called "${target}"`, 'err');
            } catch { toast(`No note called "${target}"`, 'err'); }
          },
        }, (m[2] || m[1]).trim()));
      }
      node.replaceWith(out);
    }
  }

  function backToList() {
    mode = 'list';
    searchBar.style.display = '';
    ui.setTitle('Notes');
    setListActions();
    renderList();
  }

  // ---------- capture ----------

  async function captureToDaily() {
    const text = await askSheet('Add to today’s note', { placeholder: 'What’s on your mind?', ok: 'Add', multiline: true });
    if (!text) return;
    try {
      await post('/vault/daily', { text });
      buzz();
      toast('Added to today’s note', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function askAbout(path) {
    const q = await askSheet('Ask about this note', { placeholder: 'Your question', ok: 'Ask' });
    if (!q) return;
    toast('Thinking…');
    // vault.ask streams over the socket; on a phone the useful shape is one answer in
    // a sheet rather than a live transcript, so it is collected and shown at the end.
    const { wsSend, sub } = await import('../../api.js');
    const reqId = 'm' + Math.random().toString(36).slice(2, 10);
    let buf = '';
    const s = sheet('Answer', (body) => body.append(loading('Reading your notes…')));
    // The server wraps every event as { t:'vault.ai', reqId, ev } — the payload is ev.
    const off = sub(`vaultai:${reqId}`, ({ ev }) => {
      if (!ev) return;
      if (ev.type === 'delta') buf += ev.delta || '';
      else if (ev.type === 'error') { off(); fill(s.body, errorBox(ev.message)); }
      else if (ev.type === 'done') {
        off();
        const a = el('article', { class: 'm-md' });
        a.innerHTML = renderMarkdown(buf || ev.text || 'No answer.');
        enhanceCode(a);
        fill(s.body, a);
      }
    });
    // askVault searches the whole vault for itself; it takes no path.
    wsSend({ t: 'vault.ask', reqId, question: q });
  }

  await loadList();
  return { unmount() { } };
}
