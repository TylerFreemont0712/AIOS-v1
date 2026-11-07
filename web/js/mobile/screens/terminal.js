// Terminal — a real shell on the box, from a phone.
//
// Not xterm.js. The vendored emulator is 289KB and assumes a keyboard, a mouse and a
// window that does not get eaten by a soft keyboard; on a phone it is unusable in
// practice. This is a plain log pane plus a text field, which is what the job actually
// is away from a desk: `systemctl restart`, `git pull`, `df -h`, read the answer.
//
// ANSI escapes are stripped rather than interpreted. Colour would mean reimplementing
// a terminal; what matters here is that `ls --color` does not print gibberish.

import { wsSend, onWS } from '../../api.js';
import { el, fill, icon, toast, ICONS, empty, toBottom, atBottom, buzz } from '../ui.js';

// CSI/OSC sequences, plus the lone control characters that survive them.
const ANSI = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[@-Z\\-_]|\x1B\[[0-?]*[ -/]*[@-~]|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// Keys a phone keyboard cannot send but a shell constantly needs.
const KEYS = [
  ['Tab', '\t'], ['^C', '\x03'], ['^D', '\x04'], ['↑', '\x1b[A'], ['↓', '\x1b[B'],
  ['^L', '\x0c'], ['^Z', '\x1a'], ['Esc', '\x1b'], ['|', '|'], ['~', '~'], ['/', '/'], ['-', '-'],
];

export default async function terminalScreen({ host, ui }) {
  const id = 'm' + Math.random().toString(36).slice(2, 10);
  let ready = false;
  let closed = false;

  const out = el('pre', { class: 'm-term-out' });
  const scroll = el('div', { class: 'm-scroll m-term-scroll' }, out);

  const input = el('input', {
    class: 'm-term-input', type: 'text', placeholder: 'command',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
    autocomplete: 'off', enterkeyhint: 'send',
  });

  const keyRow = el('div', { class: 'm-keys' }, ...KEYS.map(([label, seq]) => el('button', {
    class: 'm-key',
    // pointerdown, not click: a click blurs the text field first, which on iOS
    // dismisses the keyboard and makes every special key cost two taps.
    onpointerdown: (e) => { e.preventDefault(); send(seq); buzz(6); },
  }, label)));

  const bar = el('div', { class: 'm-term-bar' },
    input,
    el('button', { class: 'm-send', 'aria-label': 'Run', onclick: runLine }, el('span', { html: ICONS.send })));

  host.append(scroll, keyRow, bar);

  ui.setTitle('Terminal', 'connecting…');
  ui.setActions(
    ui.action('trash', 'Clear', () => { out.textContent = ''; }),
    ui.action('refresh', 'Restart shell', restart),
  );

  // ---------- io ----------

  function write(text) {
    const stick = atBottom(scroll);
    out.append(document.createTextNode(String(text).replace(ANSI, '')));
    // A long-running command must not grow the DOM without bound. Trim from the front
    // once the buffer is large; scrollback beyond this is not readable on a phone anyway.
    if (out.childNodes.length > 400) {
      while (out.childNodes.length > 300) out.firstChild.remove();
    }
    if (stick) toBottom(scroll);
  }

  const send = (data) => { if (ready && !closed) wsSend({ t: 'term.in', id, data }); };

  function runLine() {
    const line = input.value;
    if (!ready) return toast('Shell is not ready yet', 'err');
    send(line + '\n');
    input.value = '';
    input.focus();       // keep the keyboard up between commands
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runLine(); }
  });

  // ---------- lifecycle ----------

  const offOut = onWS('term.out', (m) => { if (m.id === id) write(m.data); });
  const offReady = onWS('term.ready', (m) => {
    if (m.id !== id) return;
    ready = true;
    ui.setTitle('Terminal', m.pty ? 'pty' : 'pipe (no resize)');
  });
  const offExit = onWS('term.exit', (m) => {
    if (m.id !== id) return;
    ready = false;
    write(`\n[exited${m.code !== undefined ? ' with code ' + m.code : ''}]\n`);
    ui.setTitle('Terminal', 'exited — tap ↻ to restart');
  });

  function open() {
    // Column count is a guess sized to the pane; the shell only uses it for wrapping,
    // and a phone in portrait is around 45 columns at this font size.
    wsSend({ t: 'term.open', id, cols: 60, rows: 24 });
  }

  function restart() {
    wsSend({ t: 'term.close', id });
    ready = false;
    out.textContent = '';
    ui.setTitle('Terminal', 'connecting…');
    setTimeout(open, 150);
  }

  open();

  return {
    unmount() {
      closed = true;
      offOut(); offReady(); offExit();
      // Leaving the screen must kill the PTY. A phone that navigates away and locks
      // would otherwise leave a login shell running on the box indefinitely.
      wsSend({ t: 'term.close', id });
    },
  };
}
