// Shared client state: config, project list, active project. Apps subscribe via bus.

import { get } from './api.js';

export const state = {
  config: null,
  projects: [],
  project: null,     // active project object
  status: null,      // /api/status payload
};

export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => { bus.addEventListener(name, fn); return () => bus.removeEventListener(name, fn); };

export async function refreshConfig() {
  state.config = await get('/config');
  emit('config', state.config);
  return state.config;
}

export async function refreshProjects() {
  state.projects = await get('/projects');
  const savedId = localStorage.getItem('aios.project');
  if (!state.project || !state.projects.find(p => p.id === state.project.id)) {
    state.project = state.projects.find(p => p.id === savedId) || state.projects[0] || null;
  } else {
    state.project = state.projects.find(p => p.id === state.project.id);
  }
  emit('projects', state.projects);
  return state.projects;
}

export function setProject(id) {
  const p = state.projects.find(x => x.id === id);
  if (!p) return;
  state.project = p;
  localStorage.setItem('aios.project', id);
  emit('project', p);
}

export async function refreshStatus() {
  try { state.status = await get('/status'); emit('status', state.status); } catch { }
  return state.status;
}
