// Terminal: xterm.js wired to a server-side PTY over the shared WebSocket.
// Multiple windows allowed — each gets its own PTY.

import { el, toast, menu, icon } from '../ui.js';
import { wsSend, onWS } from '../api.js';
import { state } from '../state.js';

let seq = 0;

export default {
  id: 'terminal', title: 'Terminal', icon: 'terminal', width: 860, height: 540, single: false,

  mount(body, opts, win) {
    const id = 'term_' + Date.now() + '_' + (seq++);
    const S = win.termState = { id, offs: [], term: null, fit: null, opened: false };

    const cwdLabel = el('span', { class: 'muted small mono' }, '');
    const head = el('div', { class: 'pane-head', style: { minHeight: '38px', padding: '5px 12px' } },
      el('span', { class: 'ttl' }, 'Terminal'),
      cwdLabel,
      el('span', { class: 'grow' }),
      el('button', { class: 'btn sm ghost', title: 'Restart shell', onclick: () => restart() }, icon('refresh')));
    const wrap = el('div', { class: 'term-wrap' });
    body.append(head, wrap);

    const term = new window.Terminal({
      fontFamily: 'ui-monospace, "Cascadia Code", Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: '#1a1917', foreground: '#e8e3d8', cursor: '#d97757',
        selectionBackground: '#d9775766',
        black: '#1a1917', brightBlack: '#6b675e',
        red: '#e0655a', brightRed: '#ef8378',
        green: '#7fb069', brightGreen: '#9dc98a',
        yellow: '#d9a441', brightYellow: '#eec06a',
        blue: '#6c9bd1', brightBlue: '#8fb8e8',
        magenta: '#b58dc9', brightMagenta: '#d0abe3',
        cyan: '#6fb3a8', brightCyan: '#8fd0c5',
        white: '#e8e3d8', brightWhite: '#f7f4ec',
      },
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(wrap);
    S.term = term; S.fit = fit;

    const projPath = opts.cwd || state.project?.path;
    cwdLabel.textContent = projPath || '~';

    function openPty() {
      fit.fit();
      wsSend({ t: 'term.open', id, cols: term.cols, rows: term.rows, cwd: projPath });
    }
    function restart() { term.reset(); openPty(); }

    S.offs.push(onWS('term.ready', (m) => {
      if (m.id !== id) return;
      S.opened = true;
      if (!m.pty) term.writeln('\x1b[33m(fallback mode: no native PTY — resize disabled)\x1b[0m');
    }));
    S.offs.push(onWS('term.out', (m) => { if (m.id === id) term.write(m.data); }));
    S.offs.push(onWS('term.exit', (m) => {
      if (m.id !== id) return;
      term.writeln(`\r\n\x1b[90m[process exited ${m.code}] — press Enter to restart\x1b[0m`);
      S.opened = false;
    }));

    term.onData(d => {
      if (!S.opened && (d === '\r' || d === '\n')) { restart(); return; }
      wsSend({ t: 'term.in', id, data: d });
    });
    term.onResize(({ cols, rows }) => wsSend({ t: 'term.resize', id, cols, rows }));

    // refit on window resize / maximize
    const doFit = () => { try { fit.fit(); } catch { } };
    S.resizeObs = new ResizeObserver(doFit);
    S.resizeObs.observe(wrap);

    // reconnect PTY when the websocket comes back
    const onWsUp = (e) => { if (e.detail.up && !S.opened) restart(); };
    document.addEventListener('aios:ws', onWsUp);
    S.offs.push(() => document.removeEventListener('aios:ws', onWsUp));

    setTimeout(() => { openPty(); term.focus(); }, 60);
  },

  resized(win) { try { win.termState?.fit?.fit(); } catch { } },

  unmount(win) {
    const S = win.termState;
    if (!S) return;
    wsSend({ t: 'term.close', id: S.id });
    S.resizeObs?.disconnect();
    S.offs.forEach(off => off());
    S.term?.dispose();
  },
};
