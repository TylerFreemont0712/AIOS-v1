// Settings — the phone's half of the hub's configuration.
//
// Not a mirror of the desktop's Settings app (95KB, twelve tabs). What belongs here is
// what you would change *because* you are on a phone: remote access, the theme, which
// model answers, and the pairing state of this device.
//
// Remote access is first because it is the thing that makes every other screen
// reachable, and because its failure modes need explaining rather than a red dot.

import { get, put, post } from '../../api.js';
import { el, fill, icon, toast, sheet, confirmSheet, ICONS, loading, empty, errorBox, relTime, pullToRefresh, buzz } from '../ui.js';
import { THEMES, applyPalette } from '../../themes.js';
import { qrSvg } from '../qr.js';

export default async function settingsScreen({ host, ui, state }) {
  const scroll = el('div', { class: 'm-scroll' });
  host.append(scroll);

  ui.setTitle('Settings');
  ui.setActions(ui.action('refresh', 'Refresh', load));
  pullToRefresh(scroll, load);

  const remoteBox = el('section', { class: 'm-section' });
  const themeBox = el('section', { class: 'm-section' });
  const modelBox = el('section', { class: 'm-section' });
  const ocrBox = el('section', { class: 'm-section' });
  const deviceBox = el('section', { class: 'm-section' });
  const aboutBox = el('section', { class: 'm-section' });

  // ---------- remote access ----------

  function renderRemote(r) {
    if (!r) return fill(remoteBox);

    const rows = [];
    const row = (label, value, cls = '') => rows.push(el('div', { class: 'm-boxrow' },
      el('span', { class: 'm-boxrow-l' }, label),
      el('span', { class: 'm-boxrow-v ' + cls }, value)));

    row('Transport', 'Tailscale');
    row('Installed', r.installed ? r.version.replace(/^tailscale\s*/i, '') || 'yes' : 'no', r.installed ? 'is-ok' : 'is-warn');
    if (r.installed) row('Tailnet', r.loggedIn ? (r.tailnet || 'joined') : 'not joined', r.loggedIn ? 'is-ok' : 'is-warn');
    if (r.self?.dnsName) row('This box', r.self.dnsName);
    row('HTTPS', r.serve.on ? 'on' : 'off', r.serve.on ? 'is-ok' : 'is-warn');

    // The consequence, spelled out. "HTTPS off" means nothing on its own; "no
    // microphone" is the thing the user actually notices and would otherwise file as
    // a bug in the voice stack.
    const micNote = r.serve.on
      ? 'Microphone and Add to Home Screen work on this address.'
      : 'Without HTTPS the phone microphone does not exist (not denied — absent), and Home-screen install is unreliable.';

    const actions = [];
    if (r.installed && r.loggedIn) {
      actions.push(el('button', {
        class: 'm-btn ' + (r.serve.on ? '' : 'is-primary'),
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = r.serve.on ? 'Turning off…' : 'Turning on… (fetching a certificate)';
          try {
            const next = await post('/remote/serve', { on: !r.serve.on });
            renderRemote(next);
            toast(next.serve.on ? 'HTTPS on' : 'HTTPS off', 'ok');
          } catch (err) {
            toast(err.message, 'err');
            btn.disabled = false;
            btn.textContent = r.serve.on ? 'Turn HTTPS off' : 'Turn HTTPS on';
          }
        },
      }, r.serve.on ? 'Turn HTTPS off' : 'Turn HTTPS on'));
    }

    if (r.pairing?.length) {
      actions.push(el('button', { class: 'm-btn', onclick: () => showPairing(r) }, 'Pair another device'));
    }

    fill(remoteBox,
      el('h2', { class: 'm-section-title' }, 'Away from home'),
      el('div', { class: 'm-boxcard' }, ...rows,
        el('p', { class: 'm-note' }, micNote),
        r.hint ? el('div', { class: 'm-hintbox' },
          el('div', {}, r.hint),
          r.hintCmd ? el('code', { class: 'm-code' }, r.hintCmd) : null) : null,
        actions.length ? el('div', { class: 'm-actions' }, ...actions) : null),
    );
  }

  /**
   * A QR code for the pairing link, because the alternative is typing an 18-byte
   * base64url token on a phone keyboard. Rendered locally — the link contains the
   * token, so handing it to an external QR service would be handing away the hub.
   */
  function showPairing(r) {
    sheet('Pair a device', (body) => {
      const best = r.pairing[0];
      body.append(
        el('p', { class: 'm-sheet-text' },
          'Scan this on the other device. It carries the pairing token, so there is nothing to type.'),
        el('div', { class: 'm-qr', html: qrSvg(best.url) }),
        el('div', { class: 'm-qr-label' }, best.label + (best.secure ? ' · HTTPS' : ' · plain http')),
        el('button', {
          class: 'm-btn', onclick: async () => {
            try { await navigator.clipboard.writeText(best.url); toast('Link copied', 'ok'); }
            catch { toast('Could not copy — long-press the code instead', 'err'); }
          },
        }, 'Copy link'),
        r.pairing.length > 1 ? el('div', { class: 'm-menu' }, ...r.pairing.slice(1).map(p =>
          el('div', { class: 'm-menu-row' },
            el('div', { class: 'm-grow' },
              el('div', { class: 'm-menu-t' }, p.label),
              el('div', { class: 'm-menu-d' }, p.url.replace(/\?token=.*/, '?token=…')))))) : null,
      );
    });
  }

  // ---------- theme ----------

  function renderTheme(cfg) {
    const cur = cfg?.appearance?.theme || 'system';
    fill(themeBox,
      el('h2', { class: 'm-section-title' }, 'Theme'),
      el('div', { class: 'm-themes' }, ...THEMES.map(t => el('button', {
        class: 'm-theme' + (t.name === cur ? ' is-on' : ''),
        onclick: async () => {
          // Paint first: waiting for the round trip makes the tap feel broken.
          applyPalette({ ...cfg.appearance, theme: t.name });
          for (const b of themeBox.querySelectorAll('.m-theme')) b.classList.remove('is-on');
          themeBox.querySelector(`[data-theme="${t.name}"]`)?.classList.add('is-on');
          try {
            cfg.appearance = (await put('/config', { appearance: { theme: t.name } })).appearance;
            const dark = applyPalette(cfg.appearance);
            document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#262624' : '#efede4');
          } catch (e) { toast(e.message, 'err'); }
        },
        'data-theme': t.name,
      },
        el('span', { class: 'm-theme-sw', style: { background: t.preview[0], borderColor: t.preview[2] } },
          el('span', { class: 'm-theme-dot', style: { background: t.preview[2] } })),
        el('span', { class: 'm-theme-n' }, t.label)))),
    );
  }

  // ---------- model ----------

  function renderModels(cfg, models) {
    const cur = cfg?.defaults?.chatModel || '';
    fill(modelBox,
      el('h2', { class: 'm-section-title' }, 'Default chat model'),
      !models.length
        ? el('div', { class: 'm-boxcard' }, el('p', { class: 'm-note' },
          'No models reachable. Start the local llama-server, or add an API key from the desktop.'))
        : el('div', { class: 'm-menu' }, ...models.filter(m => m.kind !== 'ocr').slice(0, 12).map(m => {
          const ref = m.ref || `${m.provider}:${m.model}`;
          return el('button', {
            class: 'm-menu-row' + (ref === cur ? ' is-on' : ''),
            onclick: async () => {
              try {
                await put('/config', { defaults: { chatModel: ref } });
                cfg.defaults.chatModel = ref;
                renderModels(cfg, models);
                toast('Default model set', 'ok');
              } catch (e) { toast(e.message, 'err'); }
            },
          },
            el('div', { class: 'm-grow' },
              el('div', { class: 'm-menu-t' }, m.name || m.model || ref),
              el('div', { class: 'm-menu-d' }, m.detail || m.provider || '')));
        })),
    );
  }

  // ---------- reading receipts ----------
  //
  // Deliberately NOT the one-tap list the chat model gets above.
  //
  // This is the one model choice that quietly changes what the app *produces* rather than
  // how it sounds. A dedicated transcriber returns the paper line by line; a general chat
  // model asked the same thing writes an essay about the receipt — "### 🇯🇵 日本語原文 …
  // **[Item List - Partial Transcription]**" — with every total right and every product
  // name gone. That reads as the scanner getting worse, not as a setting being wrong, so
  // it is worth being hard to change by accident: the picker offers transcribers only,
  // and it asks before it switches.
  function renderOcr(cfg, models) {
    const readers = models.filter(m => m.kind === 'ocr');
    const cur = cfg?.finance?.ocrModel || '';
    const reading = readers.find(m => m.ref === cur);
    const structurer = cfg?.finance?.ocrTextModel || '';

    const choose = () => sheet('Receipt reader', (body, close) => {
      if (!readers.length) {
        return body.append(empty('No transcribers installed',
          'Receipt reading needs a model tagged `ocr` with a projector beside it.'));
      }
      body.append(el('div', { class: 'm-menu' }, ...readers.map(m => el('button', {
        class: 'm-menu-row' + (m.ref === cur ? ' is-on' : ''),
        onclick: async () => {
          if (m.ref === cur) return close();
          if (!await confirmSheet('Change the receipt reader?',
            `Receipts will be read by ${m.name}. The current one, ${reading?.name || cur || 'none'}, has been measured against your own archive — only change this if you are testing a reader.`,
            { ok: 'Change reader' })) return;
          try {
            await put('/config', { finance: { ocrModel: m.ref } });
            cfg.finance = { ...(cfg.finance || {}), ocrModel: m.ref };
            close();
            renderOcr(cfg, models);
            toast('Receipt reader set', 'ok');
          } catch (e) { toast(e.message, 'err'); }
        },
      },
        el('div', { class: 'm-grow' },
          el('div', { class: 'm-menu-t' }, m.name || m.model),
          el('div', { class: 'm-menu-d' }, m.detail || 'local'))))));
    });

    fill(ocrBox,
      el('h2', { class: 'm-section-title' }, 'Reading receipts'),
      // Stacked rather than the label/value rows the other cards use: these values are
      // model filenames, and `gemma4-e4b-iq4xs-turbo-text` right-aligned on a 390px phone
      // runs straight off the screen — the same clipping the tailnet name suffers above.
      el('div', { class: 'm-boxcard' },
        el('div', { class: 'm-menu-t' + (reading ? '' : ' is-warn') },
          reading?.name || (cur ? cur.split(':').pop() : 'not set')),
        el('div', { class: 'm-menu-d' }, 'reads the paper' + (reading?.detail ? ` · ${reading.detail}` : '')),
        el('div', { class: 'm-menu-t', style: { marginTop: '12px' } },
          structurer ? structurer.split(':').pop() : 'chat default'),
        el('div', { class: 'm-menu-d' }, 'turns the transcription into lines'),
        el('p', { class: 'm-note' },
          'Two jobs, two models: a reader that answers questions transcribes badly, and a '
          + 'transcriber cannot tell you what it read.'),
        el('div', { class: 'm-actions' },
          el('button', { class: 'm-btn is-ghost', onclick: choose }, 'Change reader'))),
    );
  }

  // ---------- this device ----------

  function renderDevice(r) {
    fill(deviceBox,
      el('h2', { class: 'm-section-title' }, 'This device'),
      el('div', { class: 'm-boxcard' },
        el('div', { class: 'm-boxrow' },
          el('span', { class: 'm-boxrow-l' }, 'Connected via'),
          el('span', { class: 'm-boxrow-v' }, r?.source || '—')),
        el('div', { class: 'm-boxrow' },
          el('span', { class: 'm-boxrow-l' }, 'Secure context'),
          el('span', { class: 'm-boxrow-v ' + (window.isSecureContext ? 'is-ok' : 'is-warn') },
            window.isSecureContext ? 'yes' : 'no')),
        el('div', { class: 'm-boxrow' },
          el('span', { class: 'm-boxrow-l' }, 'Microphone'),
          el('span', { class: 'm-boxrow-v ' + (navigator.mediaDevices?.getUserMedia ? 'is-ok' : 'is-warn') },
            navigator.mediaDevices?.getUserMedia ? 'available' : 'absent')),
        el('div', { class: 'm-actions' },
          el('button', {
            class: 'm-btn is-ghost is-danger',
            onclick: async () => {
              if (!await confirmSheet('Unpair this device?', 'You will need the pairing link or token to get back in.', { ok: 'Unpair', danger: true })) return;
              localStorage.removeItem('aios.token');
              location.reload();
            },
          }, 'Unpair this device'))),
    );
  }

  function renderAbout(status) {
    if (!status) return fill(aboutBox);
    fill(aboutBox,
      el('h2', { class: 'm-section-title' }, 'About'),
      el('div', { class: 'm-boxcard' },
        ...[['Host', status.host], ['Version', status.version], ['Node', status.node],
          ['Uptime', `${Math.floor(status.uptime / 3600)}h ${Math.floor((status.uptime % 3600) / 60)}m`]]
          .map(([k, v]) => el('div', { class: 'm-boxrow' },
            el('span', { class: 'm-boxrow-l' }, k),
            el('span', { class: 'm-boxrow-v' }, String(v ?? '—'))))),
    );
  }

  // ---------- load ----------

  async function load() {
    fill(scroll, loading());
    const [cfgR, remoteR, modelsR, statusR] = await Promise.allSettled([
      get('/config'), get('/remote/status'), get('/models'), get('/status'),
    ]);
    const cfg = cfgR.status === 'fulfilled' ? cfgR.value : null;
    const remote = remoteR.status === 'fulfilled' ? remoteR.value : null;
    const modelsRaw = modelsR.status === 'fulfilled' ? modelsR.value : [];
    const models = Array.isArray(modelsRaw) ? modelsRaw : (modelsRaw.models || []);
    const status = statusR.status === 'fulfilled' ? statusR.value : null;

    fill(scroll, remoteBox, themeBox, modelBox, ocrBox, deviceBox, aboutBox);
    pullToRefresh(scroll, load);

    renderRemote(remote);
    if (cfg) { renderTheme(cfg); renderModels(cfg, models); renderOcr(cfg, models); }
    renderDevice(remote);
    renderAbout(status);
  }

  await load();
  return { unmount() { } };
}
