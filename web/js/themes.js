// The theme registry, shared by the desktop shell (main.js) and the phone shell
// (mobile/receipts.js). It lives on its own so the two cannot drift apart — a
// phone rendering in the light palette while the desktop is dark is jarring, and
// duplicating the table here was how that would happen.
//
// Palette values themselves live in css/theme.css; this file only names them and
// records which are dark. Add a palette block there plus an entry here to ship a
// new theme.

export const THEMES = [
  { name: 'system', label: 'System', dark: null, accent: '#d97757', preview: ['#efede4', '#30302e', '#d97757'] },
  { name: 'light', label: 'Light', dark: false, accent: '#d97757', preview: ['#efede4', '#fdfcf9', '#d97757'] },
  { name: 'dark', label: 'Dark', dark: true, accent: '#d97757', preview: ['#262624', '#383836', '#d97757'] },
  { name: 'matrix', label: 'Matrix', dark: true, accent: '#33ff77', wallpaper: 'matrix', preview: ['#000600', '#0a1e11', '#33ff77'] },
  { name: 'nord', label: 'Nord', dark: true, accent: '#88c0d0', preview: ['#2e3440', '#3b4252', '#88c0d0'] },
  { name: 'dracula', label: 'Dracula', dark: true, accent: '#bd93f9', preview: ['#282a36', '#44475a', '#bd93f9'] },
  { name: 'rose', label: 'Rosé Pine', dark: true, accent: '#ebbcba', preview: ['#191724', '#26233a', '#ebbcba'] },
  { name: 'synthwave', label: 'Synthwave', dark: true, accent: '#ff3ca8', wallpaper: 'synthwave', preview: ['#190b2e', '#2c1550', '#ff3ca8'] },
  { name: 'solarized', label: 'Solarized', dark: false, accent: '#268bd2', preview: ['#fdf6e3', '#eee8d5', '#268bd2'] },
];

export const themeByName = (n) => THEMES.find(t => t.name === n) || THEMES[0];

/** Put the palette on <html>. Returns whether the resolved palette is dark, which
 *  callers use to pick a matching icon or status-bar colour. Deliberately does NOT
 *  touch the wallpaper — that is a desktop-only concern. */
export function applyPalette(appearance = {}) {
  const t = themeByName(appearance.theme || 'system');
  const sysDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = t.name === 'system' ? sysDark : !!t.dark;
  const root = document.documentElement;
  root.dataset.theme = t.name === 'system' ? (sysDark ? 'dark' : 'light') : t.name;
  root.dataset.mode = dark ? 'dark' : 'light';
  root.style.setProperty('--accent', appearance.accent || t.accent || '#d97757');
  return dark;
}
