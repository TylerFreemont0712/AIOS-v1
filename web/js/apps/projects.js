// Projects hub: register existing folders, create new ones, jump into
// agent/files/terminal, favorite, annotate.

import { el, icon, toast, menu, modal, askText, confirmBox, timeAgo } from '../ui.js';
import { get, post, patch, del } from '../api.js';
import { state, refreshProjects, setProject, on } from '../state.js';
import { openApp } from '../wm.js';

export default {
  id: 'projects', title: 'Projects', icon: 'projects', width: 900, height: 620,

  mount(body, opts, win) {
    const ui = {};
    win._offs = [on('projects', () => render())];

    const head = el('div', { class: 'pane-head' },
      el('span', { class: 'ttl' }, 'Projects'),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn sm', onclick: registerExisting }, icon('folder'), 'Register existing'),
      el('button', { class: 'btn sm primary', onclick: createNew }, icon('plus'), 'New project'));
    ui.grid = el('div', { class: 'projects-wrap' });
    body.append(el('div', { class: 'main-pane' }, head, ui.grid));

    async function render() {
      const projects = state.projects;
      ui.grid.innerHTML = '';
      if (!projects.length) {
        ui.grid.append(el('div', { class: 'empty' },
          el('div', { class: 'big' }, 'No projects yet'),
          'Register a folder you already have, or create a fresh one.',
          el('div', { class: 'row' },
            el('button', { class: 'btn', onclick: registerExisting }, 'Register existing'),
            el('button', { class: 'btn primary', onclick: createNew }, 'New project'))));
        return;
      }
      const grid = el('div', { class: 'projects-grid' });
      for (const p of projects) grid.append(card(p));
      ui.grid.append(grid);
    }

    function card(p) {
      const gitChip = p.git
        ? el('span', { class: 'chip' }, icon('git'), `${p.git.branch}${p.git.dirty ? ` · ${p.git.dirty} dirty` : ''}`)
        : el('span', { class: 'chip' }, 'no git');
      const active = state.project?.id === p.id;
      const c = el('div', { class: 'proj-card' + (p.exists ? '' : ' missing') },
        el('div', { class: 'p-name' }, p.favorite ? el('span', { class: 'fav' }, '★') : null, p.name,
          active ? el('span', { class: 'chip accent', style: { marginLeft: 'auto' } }, 'active') : null),
        el('div', { class: 'p-path' }, p.path),
        el('div', { class: 'p-meta' }, gitChip, el('span', { class: 'chip' }, timeAgo(p.lastOpenedAt))),
        p.notes ? el('div', { class: 'muted small' }, p.notes) : null,
        el('div', { class: 'p-actions' },
          el('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); use(p); openApp('agent'); } }, icon('agent'), 'Agent'),
          el('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); use(p); openApp('files', { root: p.id }); } }, icon('files'), 'Files'),
          el('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); use(p); openApp('terminal', { cwd: p.path }); } }, icon('terminal'), 'Shell')),
      );
      c.addEventListener('click', () => use(p));
      c.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        menu(e.clientX, e.clientY, [
          { label: p.favorite ? 'Unfavorite' : 'Favorite', icon: 'star', onclick: async () => { await patch('/projects/' + p.id, { favorite: !p.favorite }); refreshProjects(); } },
          { label: 'Edit notes', icon: 'edit', onclick: async () => {
            const n = await askText({ title: 'Project notes', value: p.notes || '', multiline: true, ok: 'Save' });
            if (n !== null) { await patch('/projects/' + p.id, { notes: n }); refreshProjects(); }
          } },
          { label: 'Rename', icon: 'edit', onclick: async () => {
            const n = await askText({ title: 'Rename project', value: p.name, ok: 'Rename' });
            if (n) { await patch('/projects/' + p.id, { name: n }); refreshProjects(); }
          } },
          '-',
          { label: 'Remove from hub', icon: 'trash', danger: true, onclick: async () => {
            if (!await confirmBox('Remove from hub?', 'Only the registry entry is removed — files on disk are untouched.', 'Remove')) return;
            await del('/projects/' + p.id);
            refreshProjects();
          } },
        ]);
      });
      return c;
    }

    async function use(p) {
      setProject(p.id);
      patch('/projects/' + p.id, { touch: true }).then(refreshProjects).catch(() => { });
    }

    async function registerExisting() {
      const path = await askText({
        title: 'Register a project',
        sub: 'Absolute path to an existing folder on this machine.',
        placeholder: '/home/you/code/my-project', ok: 'Register',
      });
      if (!path) return;
      try { await post('/projects/register', { path }); await refreshProjects(); toast('registered', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    }

    async function createNew() {
      const name = await askText({
        title: 'New project',
        sub: `Creates ${state.config?.projectsRoot || '…'}/<name> with a README and git init.`,
        placeholder: 'project-name', ok: 'Create',
      });
      if (!name) return;
      try {
        const p = await post('/projects', { name });
        await refreshProjects();
        setProject(p.id);
        toast('created ' + p.path, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }

    render();
  },

  unmount(win) { win._offs?.forEach(off => off()); },
};
