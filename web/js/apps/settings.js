// Settings: profile, appearance, providers, tools, vault, agent defaults, network & security.

import { el, icon, toast, askText, confirmBox, modal, fetchModels, modelPicker, prettyModel } from '../ui.js';
import { get, put, post, del } from '../api.js';
import { state, refreshConfig, refreshStatus, on } from '../state.js';
import { applyAppearance, THEMES } from '../main.js';

const ACCENTS = ['#d97757', '#b3552f', '#5a8a6e', '#5f7fb3', '#8a6fb3', '#b3567d', '#a8842f', '#5f9ea0'];
const WALLPAPERS = ['aurora', 'mesh', 'grid', 'flat', 'synthwave', 'matrix'];

export default {
  id: 'settings', title: 'Settings', icon: 'settings', width: 900, height: 640,

  mount(body, opts, win) {
    const S = { tab: opts.tab || 'appearance' };
    const ui = {};

    const tabs = [
      ['appearance', 'Appearance', 'sun'],
      ['providers', 'AI Providers', 'cpu'],
      ['chat', 'Chat', 'chat'],
      ['tools', 'Tools', 'wrench'],
      ['vault', 'Vault', 'vault'],
      ['github', 'GitHub', 'github'],
      ['mail', 'Mail & Alerts', 'send'],
      ['agent', 'Agent', 'agent'],
      ['finance', 'Finances', 'graph'],
      ['voice', 'Voice', 'mic'],
      ['network', 'Network & Security', 'network'],
      ['profile', 'Profile', 'user'],
      ['about', 'About', 'sparkle'],
    ];

    ui.nav = el('div', { class: 'set-nav' });
    ui.panel = el('div', { class: 'set-panel' });
    body.append(el('div', { class: 'set-cols' }, ui.nav, ui.panel));

    function renderNav() {
      ui.nav.innerHTML = '';
      for (const [id, label, ic] of tabs) {
        ui.nav.append(el('div', {
          class: 'side-item' + (S.tab === id ? ' sel' : ''),
          onclick: () => { S.tab = id; renderNav(); renderPanel(); },
        }, icon(ic), label));
      }
    }

    async function save(patch, msg = 'saved') {
      try {
        state.config = await put('/config', patch);
        toast(msg, 'ok');
        return true;
      } catch (e) { toast(e.message, 'err'); return false; }
    }

    const row = (name, sub, ctl) => el('div', { class: 'set-row' },
      el('div', { class: 'set-info' }, el('div', { class: 'set-name' }, name), sub && el('div', { class: 'set-sub' }, sub)),
      el('div', { class: 'set-ctl' }, ctl));

    const switchBtn = (on, fn) => el('button', { class: 'switch' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(on), onclick: () => fn(!on) });

    /**
     * MCP servers.
     *
     * An MCP server is somebody else's process publishing tools over a standard protocol.
     * Adding one never starts it — Connect does, because spawning a program is a thing the
     * user should ask for explicitly. Each server's tools then appear in the belt below
     * under their own group, and the agent activates that group with load_tools when a
     * task needs it, so they cost nothing on turns that don't.
     */
    async function renderMcp() {
      ui.panel.append(el('div', { class: 'lbl', style: { marginTop: '18px' } }, 'MCP SERVERS'));
      let data = null;
      try { data = await get('/mcp'); } catch (e) { toast(e.message, 'err'); }
      if (!data) return;

      const DOT = { up: 'up', starting: 'warn', down: 'err', stopped: 'warn', idle: '', off: '' };
      const act = async (fn, okMsg) => {
        try { await fn(); if (okMsg) toast(okMsg, 'ok'); }
        catch (e) { toast(e.message, 'err'); }
        renderPanel();
      };

      for (const s of data.servers) {
        const ctl = el('div', { class: 'row' });
        if (s.status === 'up') {
          ctl.append(el('span', { class: 'chip', title: s.tools.map(t => `${t.name}${t.readOnly ? '' : ' (write)'}`).join('\n') || 'none' },
            `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}`));
          ctl.append(el('button', { class: 'btn sm ghost', title: 'Call a tool by hand to check it really works', onclick: () => tryTool(s) }, icon('play'), 'Try'));
          ctl.append(el('button', { class: 'btn sm ghost', onclick: () => act(() => post(`/mcp/servers/${s.id}/disconnect`, {})) }, 'Disconnect'));
        } else {
          ctl.append(el('button', {
            class: 'btn sm' + (s.enabled ? ' primary' : ''), disabled: !s.enabled,
            onclick: () => act(() => post(`/mcp/servers/${s.id}/connect`, {}), `${s.name} connected`),
          }, s.status === 'starting' ? 'Connecting…' : 'Connect'));
        }
        ctl.append(el('button', { class: 'btn sm ghost', title: 'Edit', onclick: () => editServer(s, data.presets) }, icon('edit')));
        ctl.append(el('button', {
          class: 'btn sm ghost danger', title: 'Remove this server',
          onclick: async () => {
            if (!await confirmBox(`Remove ${s.name}?`, 'Its tools leave the agent\'s belt. The program itself is not touched.', 'Remove')) return;
            act(() => del(`/mcp/servers/${s.id}`), 'removed');
          },
        }, icon('trash')));
        ctl.append(switchBtn(s.enabled, (next) => act(() => post('/mcp/servers', { id: s.id, enabled: next }),
          `${s.name} ${next ? 'enabled — hit Connect' : 'disabled'}`)));

        const what = s.transport === 'http' ? s.url : [s.command, ...(s.args || [])].join(' ');
        const sub = s.status === 'up'
          ? `${s.serverInfo?.name || s.transport}${s.serverInfo?.version ? ` ${s.serverInfo.version}` : ''} · tools are called ${s.id}_… and live in the “${s.group}” group`
          : s.error || what;
        ui.panel.append(row(
          el('span', { class: 'row', style: { gap: '7px' } },
            el('span', { class: 'pdot ' + (DOT[s.status] ?? '') }),
            el('span', { style: s.enabled ? {} : { opacity: .5 } }, s.name),
            s.status === 'down' ? el('span', { class: 'chip', style: { color: 'var(--err)' } }, 'failed') : null),
          sub, ctl));

        // the server's own stderr — where a broken command actually explains itself
        if (s.status === 'down' && s.log) {
          ui.panel.append(el('pre', {
            class: 'mono',
            style: { fontSize: '11px', whiteSpace: 'pre-wrap', maxHeight: '120px', overflowY: 'auto', margin: '0 0 8px', padding: '8px 10px', background: 'var(--code-bg)', borderRadius: '8px', color: 'var(--muted)' },
          }, s.log.slice(-1200)));
        }
      }

      if (!data.servers.length) {
        ui.panel.append(el('div', { class: 'desc', style: { marginTop: '-2px' } },
          'None yet. An MCP server is a small program that publishes tools — driving Godot, a browser, a database. Add one and its tools join the agent’s belt beside the built-ins.'));
      }
      ui.panel.append(row('Add a server', 'From a preset, or configure the command yourself',
        el('button', { class: 'btn sm primary', onclick: () => editServer(null, data.presets) }, icon('plus'), 'Add MCP server')));
    }

    /** Call one tool by hand — connecting proves the handshake, this proves it works. */
    async function tryTool(s) {
      if (!s.tools.length) return toast('this server published no tools', 'err');
      const pick = el('select', { class: 'input select' }, ...s.tools.map(t => el('option', { value: t.remoteName }, `${t.remoteName}${t.readOnly ? '' : '  (write)'}`)));
      const argsIn = el('textarea', { class: 'input mono', rows: 4, placeholder: '{ }' }, '{}');
      const out = el('pre', {
        class: 'mono',
        style: { fontSize: '11.5px', whiteSpace: 'pre-wrap', maxHeight: '38vh', overflowY: 'auto', background: 'var(--code-bg)', padding: '10px', borderRadius: '8px', margin: 0 },
      }, 'pick a tool, give it arguments, and run it');
      modal({
        title: `Try ${s.name}`, sub: 'Runs against the real server, exactly as the agent would.', wide: true,
        body: el('div', { class: 'col', style: { gap: '8px', marginTop: '6px' } },
          pick, el('div', { class: 'lbl' }, 'ARGUMENTS (JSON)'), argsIn, out),
        actions: [
          {
            label: 'Run', kind: 'primary', onpick: async () => {
              let args;
              try { args = JSON.parse(argsIn.value.trim() || '{}'); }
              catch (e) { out.textContent = `those arguments are not valid JSON — ${e.message}`; return false; }
              out.textContent = 'running…';
              try {
                const r = await post(`/mcp/servers/${s.id}/call`, { tool: `${s.id}_${pick.value}`, args });
                out.textContent = r.output || '(nothing returned)';
              } catch (e) { out.textContent = 'failed: ' + e.message; }
              return false;                       // keep the dialog open for another go
            },
          },
          { label: 'Close', value: null },
        ],
      });
    }

    /** Create or edit one server. Presets fill the fields; nothing about them is special. */
    async function editServer(existing, presets = []) {
      const f = {
        id: el('input', { class: 'input mono', value: existing?.id || '', placeholder: 'godot', disabled: !!existing, style: { width: '150px' } }),
        name: el('input', { class: 'input', value: existing?.name || '', placeholder: 'Godot', style: { width: '190px' } }),
        command: el('input', { class: 'input mono', value: existing?.command || '', placeholder: 'node', style: { width: '100%' } }),
        args: el('textarea', { class: 'input mono', rows: 3, placeholder: 'one argument per line\n/path/to/godot-mcp/build/index.js' }),
        cwd: el('input', { class: 'input mono', value: existing?.cwd || '', placeholder: 'optional working directory', style: { width: '100%' } }),
        env: el('textarea', { class: 'input mono', rows: 3, placeholder: 'KEY=value, one per line' }),
        url: el('input', { class: 'input mono', value: existing?.url || '', placeholder: 'https://example.com/mcp', style: { width: '100%' } }),
      };
      f.args.value = (existing?.args || []).join('\n');
      // Values were never sent to the browser — show the names so they can be kept or
      // replaced, and leave a blank value meaning "keep whatever is stored".
      f.env.value = (existing?.envKeys || []).map(k => `${k}=`).join('\n');

      let transport = existing?.transport || 'stdio';
      const stdioBox = el('div', { class: 'col', style: { gap: '8px' } });
      const httpBox = el('div', { class: 'col', style: { gap: '8px' } });
      const lbl = (t) => el('div', { class: 'lbl' }, t);
      stdioBox.append(lbl('COMMAND'), f.command, lbl('ARGUMENTS'), f.args, lbl('WORKING DIRECTORY'), f.cwd, lbl('ENVIRONMENT'), f.env);
      httpBox.append(lbl('URL'), f.url);
      const syncTransport = () => {
        stdioBox.style.display = transport === 'stdio' ? '' : 'none';
        httpBox.style.display = transport === 'http' ? '' : 'none';
      };
      const seg = el('div', { class: 'seg' }, ...[['stdio', 'Local program'], ['http', 'Remote URL']].map(([v, l]) => el('button', {
        class: 'seg-btn' + (transport === v ? ' on' : ''),
        onclick: (e) => {
          transport = v; syncTransport();
          for (const b of seg.querySelectorAll('.seg-btn')) b.classList.remove('on');
          e.currentTarget.classList.add('on');
        },
      }, l)));
      syncTransport();

      const presetSel = el('select', { class: 'input select' },
        el('option', { value: '' }, 'Start from a preset…'),
        ...presets.map((p, i) => el('option', { value: String(i) }, p.name)));
      const presetHint = el('div', { class: 'desc', style: { marginTop: '-2px' } }, '');
      presetSel.addEventListener('change', () => {
        const p = presets[Number(presetSel.value)];
        if (!p) return;
        f.id.value = p.id; f.name.value = p.name;
        f.command.value = p.command || ''; f.args.value = (p.args || []).join('\n');
        f.url.value = p.url || '';
        f.env.value = Object.entries(p.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
        transport = p.transport || 'stdio'; syncTransport();
        for (const b of seg.querySelectorAll('.seg-btn')) b.classList.toggle('on', b.textContent === (transport === 'http' ? 'Remote URL' : 'Local program'));
        presetHint.textContent = p.hint || '';
      });

      const ok = await modal({
        title: existing ? `Edit ${existing.name}` : 'Add an MCP server',
        sub: 'Its tools are named <id>_<tool> and grouped as mcp:<id>, so two servers can both publish a “search” without colliding.',
        wide: true,
        body: el('div', { class: 'col', style: { gap: '9px', marginTop: '6px' } },
          existing ? null : presetSel, existing ? null : presetHint,
          el('div', { class: 'row', style: { gap: '10px' } },
            el('label', { class: 'col', style: { gap: '3px' } }, el('span', { class: 'lbl' }, 'ID'), f.id),
            el('label', { class: 'col', style: { gap: '3px' } }, el('span', { class: 'lbl' }, 'NAME'), f.name)),
          seg, stdioBox, httpBox),
        actions: [{ label: 'Cancel', value: null }, { label: existing ? 'Save' : 'Add', kind: 'primary', value: true }],
      });
      if (!ok) return;

      const lines = (t) => String(t.value || '').split('\n').map(s => s.trim()).filter(Boolean);
      const env = {};
      for (const line of lines(f.env)) {
        const i = line.indexOf('=');
        if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      try {
        await post('/mcp/servers', {
          id: (existing?.id || f.id.value).trim().toLowerCase(),
          name: f.name.value.trim(), transport,
          command: f.command.value.trim(), args: lines(f.args), cwd: f.cwd.value.trim(),
          url: f.url.value.trim(), env,
          enabled: existing ? existing.enabled : true,
        });
        toast(existing ? 'saved — reconnect to pick it up' : 'added — hit Connect to start it', 'ok');
        renderPanel();
      } catch (e) { toast(e.message, 'err'); }
    }

    /**
     * Voice.
     *
     * Two kinds of setting live on this page and they are deliberately separated.
     * The engine settings (which models, which voice, how long to keep them loaded)
     * are server-side and shared by every device on the LAN. The playback habits
     * (read replies aloud, hands-free, send on dictation) are per-browser, because
     * "read everything out loud" is a reasonable answer on the laptop in the study
     * and a terrible one on the phone in a meeting.
     */
    async function renderVoice(c) {
      const V = await import('../voice.js');
      ui.panel.append(el('h2', {}, 'Voice'),
        el('div', { class: 'desc' }, 'Speak to AIOS and have it answer out loud. Both models run on this machine — no audio leaves it.'));

      let st;
      try { st = await V.voiceStatus({ fresh: true }); }
      catch (e) { ui.panel.append(el('div', { class: 'set-sub' }, 'could not read voice status: ' + e.message)); return; }

      // --- installation ---
      const dot = (ok) => el('span', { class: 'pdot ' + (ok ? 'up' : 'warn') });
      const statusBox = el('div', { class: 'set-block' },
        el('div', { class: 'row', style: { gap: '14px', flexWrap: 'wrap' } },
          el('span', { class: 'row', style: { gap: '6px' } }, dot(st.stt?.ok), 'Listening · ', el('code', {}, st.stt?.model || '—')),
          el('span', { class: 'row', style: { gap: '6px' } }, dot(st.tts?.ok), 'Speaking · ', el('code', {}, st.tts?.voice || '—')),
          el('span', { class: 'row', style: { gap: '6px' } }, dot(st.running), st.running ? 'models loaded' : 'idle')),
        !st.installed ? el('div', { class: 'set-sub', style: { marginTop: '8px' } },
          'Not installed. Run ', el('code', {}, 'npm run voice'), ' in the AIOS folder — about 1.5GB, a few minutes.') : null,
        st.lastError ? el('div', { class: 'set-sub', style: { marginTop: '8px', color: 'var(--err)' } }, st.lastError) : null);
      ui.panel.append(statusBox);

      // The single most confusing failure this feature has: the mic is missing on
      // the LAN address and present on localhost, with no error either way.
      const micIssue = V.micProblem();
      if (micIssue) {
        ui.panel.append(el('div', { class: 'set-block', style: { borderColor: 'var(--warn)' } },
          el('div', { class: 'set-name' }, 'This browser will not give AIOS a microphone'),
          el('div', { class: 'set-sub' }, micIssue)));
      }

      ui.panel.append(row('Voice enabled', 'Turn the whole feature off, buttons and all',
        switchBtn(c.voice?.enabled !== false, async (on) => { await save({ voice: { enabled: on } }); V.invalidateVoiceStatus(); renderPanel(); })));

      if (!st.installed) return;

      // --- listening ---
      ui.panel.append(el('div', { class: 'lbl', style: { marginTop: '18px' } }, 'LISTENING'));

      const sttSel = el('select', { class: 'input sm', onchange: async () => { await save({ voice: { stt: { model: sttSel.value } } }); V.invalidateVoiceStatus(); renderPanel(); } },
        ...[['tiny', 'tiny — fastest, least accurate'], ['base', 'base — ~0.7s an utterance'],
        ['small', 'small — ~1.9s, much better on names and Japanese'], ['medium', 'medium — slowest, best']]
          .map(([v, l]) => el('option', { value: v, selected: (c.voice?.stt?.model || 'small') === v }, l)));
      ui.panel.append(row('Speech model', 'Whisper size. Cost barely changes with how long you speak — it is one window either way. Switching needs the model downloaded: `npm run voice -- --stt base`.', sttSel));

      // The streaming transducer. When it is installed it owns the live text and the
      // whisper-rerun partials below are irrelevant, so the two are presented as one
      // choice rather than two that quietly override each other.
      if (st.stt?.streamInstalled) {
        const streamOn = el('input', { type: 'checkbox', checked: st.stt?.streaming !== false });
        streamOn.addEventListener('change', async () => {
          await save({ voice: { stt: { streaming: streamOn.checked } } });
          V.invalidateVoiceStatus();
          renderPanel();
        });
        ui.panel.append(row('Words as you speak',
          'A streaming recogniser that emits text while you are still talking, and notices when your'
          + ' sentence ends. Whisper cannot do this — it reads a fixed 30-second window, so a two-second'
          + ' phrase costs it the same as a ten-second one. What it hears is feedback only: rougher, upper-case,'
          + ' unpunctuated, and replaced by the full-quality pass the moment you stop.',
          streamOn));
      }

      // Live partials: a second, smaller model re-reads the utterance about once a
      // second while you speak. It has to finish inside that interval, which is the
      // whole reason it is not the accurate one. Only reachable when the streaming
      // recogniser is off or absent — otherwise it is dead configuration.
      const PARTIALS = [['', 'Off'], ['tiny', 'tiny — fastest'], ['base', 'base — recommended'], ['small', 'small — same as final']];
      const partialSel = el('select', { class: 'input sm' },
        ...PARTIALS.map(([v, l]) => el('option', { value: v, selected: (c.voice?.stt?.partialModel ?? 'base') === v }, l)));
      partialSel.addEventListener('change', async () => {
        await save({ voice: { stt: { partialModel: partialSel.value } } });
        V.invalidateVoiceStatus();
        renderPanel();
      });
      if (!st.stt?.streaming) {
        ui.panel.append(row('Live text while you speak',
          st.stt?.partial
            ? 'Words appear as you talk, from a quicker and rougher model. It is feedback only — what actually gets used is still the full-quality pass when you stop, so a partial being wrong costs nothing.'
            : 'Off, or the chosen model is not downloaded. `npm run voice -- --stt base` fetches one.',
          partialSel));
      }

      const LANGS = [['', 'Detect automatically'], ['en', 'English'], ['ja', '日本語'], ['zh', '中文'], ['ko', '한국어'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch']];
      const langSel = el('select', { class: 'input sm', onchange: async () => { await save({ voice: { stt: { language: langSel.value } } }); V.invalidateVoiceStatus(); } },
        ...LANGS.map(([v, l]) => el('option', { value: v, selected: (c.voice?.stt?.language || '') === v }, l)));
      ui.panel.append(row('Spoken language', 'Auto-detection is unreliable on short clips — pin it if you always speak one language', langSel));

      // Whisper takes a vocabulary hint and it is the difference between "Lawson" and
      // "it lost in". Most of the list builds itself from the ledger; this is for the
      // names it cannot know — platforms, people, projects.
      const hintTa = el('textarea', {
        class: 'input', rows: 2, placeholder: 'Micro1, Outlier, DataAnnotation, …',
        style: { width: '100%', fontSize: '12.5px' },
      });
      hintTa.value = c.voice?.stt?.prompt || '';
      const hintInfo = el('div', { class: 'set-sub', style: { marginTop: '6px' } }, 'building…');
      const showVocab = () => get('/voice/vocabulary')
        .then(r => { hintInfo.textContent = `Whisper is primed with: ${r.prompt || '(nothing yet)'}`; })
        .catch(() => { hintInfo.textContent = ''; });
      showVocab();
      ui.panel.append(el('div', { class: 'set-block' },
        el('div', { class: 'set-name' }, 'Words to listen for'),
        el('div', { class: 'set-sub' },
          'Names the model would otherwise guess at — platforms, people, products. Your merchants and categories are added automatically. Comma-separated; keep it short, a long hint makes whisper quote it back at you.'),
        hintTa,
        el('div', { class: 'row', style: { marginTop: '6px' } },
          el('button', {
            class: 'btn sm primary',
            onclick: async () => { await save({ voice: { stt: { prompt: hintTa.value } } }, 'vocabulary saved'); V.invalidateVoiceStatus(); showVocab(); },
          }, 'Save')),
        hintInfo));

      // --- speaking ---
      ui.panel.append(el('div', { class: 'lbl', style: { marginTop: '18px' } }, 'SPEAKING'));

      // Voice names are Kokoro's own: <language><gender>_<name>. Spelling that out
      // beats 54 opaque identifiers in a dropdown.
      const GENDER = { f: 'female', m: 'male' };
      const REGION = { a: 'American', b: 'British', e: 'Spanish', f: 'French', h: 'Hindi', i: 'Italian', j: 'Japanese', p: 'Portuguese', z: 'Chinese' };
      const voiceLabel = (v) => {
        const m = /^([a-z])([fm])_(.+)$/.exec(v);
        if (!m) return v;
        const name = m[3][0].toUpperCase() + m[3].slice(1);
        return `${name} — ${REGION[m[1]] || m[1]} ${GENDER[m[2]] || ''}`.trim();
      };
      let current = c.voice?.tts?.voice || 'af_heart';

      // Kokoro ships 54 voices and they are NOT equally good — the model card grades
      // them, and the difference between an A and a D is the difference between a
      // voice you would leave on and one you would mute. These are the ones worth
      // hearing, in the order worth hearing them, with a word about how each sounds
      // so the choice is not 54 coin flips.
      // Kokoro ships 54 and they are NOT equally good — nor equally suitable for an
      // assistant. The whispery close-mic ones (af_nicole) are technically fine and
      // sound like an ASMR channel, which is not what you want reading your budget
      // back at you; they stay in the full list below, out of the shortlist.
      const PICKS = [
        ['af_heart', 'Warm, natural, unhurried. The best of them.'],
        ['af_bella', 'More expressive and animated than Heart.'],
        ['af_kore', 'Crisp and matter-of-fact. Good for numbers.'],
        ['af_aoede', 'Bright and even, lighter than Heart.'],
        ['bf_emma', 'British, calm — good for long answers.'],
        ['bf_isabella', 'British, warmer and rounder.'],
        ['am_fenrir', 'Male, steady and low.'],
        ['am_michael', 'Male, neutral and plain.'],
        ['am_puck', 'Male, brighter and quicker.'],
        ['bm_george', 'British male, measured.'],
        ['bm_lewis', 'British male, deeper and slower.'],
        ['jf_alpha', '日本語 female — reads kanji properly.'],
        ['jm_kumo', '日本語 male.'],
      ];

      // Preview in the voice's OWN language — a Japanese voice reading an English
      // sentence tells you nothing about how it will sound. Keyed off the base voice,
      // since a blend spec looks like "af_heart+bf_emma".
      const sampleFor = (spec) => {
        const base = String(spec || '').split('+')[0];
        if (base.startsWith('j')) return '今月の食費は、あと一万二千円残っています。';
        if (base.startsWith('z')) return '本月的食品预算还剩一万二千日元。';
        return 'Your grocery budget has twelve thousand yen left, with nine days to go.';
      };

      const preview = async (v) => {
        try {
          const meta = await V.previewVoice(sampleFor(v), { voice: v });
          // A CJK voice that fell back to espeak reads kanji as "Chinese letter" —
          // it is obviously broken to listen to and impossible to attribute.
          if (/^(ja|cmn|zh)/.test(meta.lang) && !meta.g2p.startsWith('misaki')) {
            toast(`${voiceLabel(v)} is speaking through espeak — run: ${st.home}/venv/bin/pip install "misaki[ja]"`, 'warn');
          }
        } catch (e) { toast(e.message, 'err'); }
      };

      const gallery = el('div', { class: 'voice-gallery' });
      const paintGallery = () => {
        const base = current.split('+')[0];
        gallery.replaceChildren(...PICKS
          .filter(([v]) => !st.tts?.voices?.length || st.tts.voices.includes(v))
          .map(([v, blurb]) => el('button', {
            class: 'voice-chip' + (base === v ? ' on' : ''), type: 'button',
            title: 'Select and play a sample',
            onclick: async () => {
              // Picking from the gallery changes the BASE voice; any blend partner
              // set below survives it.
              current = blendState.second ? `${v}+${blendState.second}` : v;
              voiceSel.value = v;
              paintGallery();
              fillSecond(st.tts?.voices || [v]);
              await save({ voice: { tts: { voice: current } } });
              V.invalidateVoiceStatus();
              preview(current);
            },
          },
            el('span', { class: 'voice-chip-name' }, voiceLabel(v)),
            el('span', { class: 'voice-chip-blurb' }, blurb),
            el('span', { class: 'voice-chip-play' }, icon('play')))));
      };
      const voiceSel = el('select', { class: 'input sm', style: { maxWidth: '230px' } });
      const fillVoices = (list) => {
        voiceSel.replaceChildren(...list.map(v => el('option', { value: v, selected: current.split('+')[0] === v }, voiceLabel(v))));
        voiceCount.textContent = `${list.length} installed — the shortlist above is the pick of them`;
      };
      const voiceCount = el('div', { class: 'set-sub' }, 'loading voices…');
      voiceSel.addEventListener('change', async () => {
        current = blendState.second ? `${voiceSel.value}+${blendState.second}` : voiceSel.value;
        paintGallery();
        await save({ voice: { tts: { voice: current } } });
        V.invalidateVoiceStatus();
        preview(current);
      });

      ui.panel.append(
        el('div', { class: 'set-row set-row-stack' },
          el('div', { class: 'set-info' },
            el('div', { class: 'set-name' }, 'Voice'),
            el('div', { class: 'set-sub' }, 'Click one to select it and hear it straight away.')),
          gallery),
        el('div', { class: 'set-row' },
          el('div', { class: 'set-info' }, el('div', { class: 'set-name' }, 'Every voice'), voiceCount),
          el('div', { class: 'set-ctl' }, voiceSel)));
      paintGallery();

      // The list is cached server-side after the first read, but the cache lives with
      // the data directory — on a fresh one this is the call that fills it, and it is
      // worth the ~1s worker spawn rather than showing a dropdown with one entry.
      if (st.tts?.voices?.length) fillVoices(st.tts.voices);
      else {
        fillVoices([current]);
        voiceCount.textContent = 'loading voices…';
        get('/voice/voices')
          .then(r => { if (r.voices?.length) { st.tts.voices = r.voices; fillVoices(r.voices); paintGallery(); } })
          .catch(() => { voiceCount.textContent = 'could not list voices'; });
      }

      const speedVal = el('span', { class: 'set-sub', style: { minWidth: '34px', fontFamily: 'var(--mono)' } }, String(c.voice?.tts?.speed ?? 1));
      const speed = el('input', {
        type: 'range', min: '0.6', max: '1.6', step: '0.05', value: String(c.voice?.tts?.speed ?? 1), style: { width: '150px' },
        oninput: () => { speedVal.textContent = speed.value; },
        onchange: async () => { await save({ voice: { tts: { speed: Number(speed.value) } } }); V.invalidateVoiceStatus(); },
      });
      ui.panel.append(row('Speaking rate', 'Kokoro accepts 0.5–2.0; past about 1.4 it starts to slur', el('div', { class: 'row' }, speed, speedVal)));

      // --- a voice nobody else has ---
      // Kokoro addresses a voice by an embedding, not a name, so two can be averaged
      // into a real third one. This is the only way to get something unique out of a
      // fixed model, and it costs one array operation per utterance.
      const blendState = { second: (c.voice?.tts?.voice || '').split('+')[1] || '', amount: c.voice?.tts?.blend ?? 0.5 };
      const secondSel = el('select', { class: 'input sm', style: { maxWidth: '190px' } });
      const fillSecond = (list) => secondSel.replaceChildren(
        el('option', { value: '' }, 'None — single voice'),
        ...list.filter(v => v !== current.split('+')[0]).map(v => el('option', { value: v, selected: blendState.second === v }, voiceLabel(v))));
      const blendVal = el('span', { class: 'set-sub', style: { minWidth: '52px', fontFamily: 'var(--mono)' } }, '');
      const blendRange = el('input', {
        type: 'range', min: '0', max: '1', step: '0.05', value: String(blendState.amount), style: { width: '150px' },
      });
      const paintBlend = () => {
        const base = current.split('+')[0];
        const pct = Math.round(Number(blendRange.value) * 100);
        blendVal.textContent = blendState.second ? `${pct}/${100 - pct}` : '—';
        blendRange.disabled = !blendState.second;
        blendRow.style.opacity = blendState.second ? '1' : '.55';
        void base;
      };
      const applyBlend = async () => {
        const base = current.split('+')[0];
        current = blendState.second ? `${base}+${blendState.second}` : base;
        await save({ voice: { tts: { voice: current, blend: Number(blendRange.value) } } });
        V.invalidateVoiceStatus();
        paintBlend();
        preview(current);
      };
      secondSel.addEventListener('change', () => { blendState.second = secondSel.value; applyBlend(); });
      blendRange.addEventListener('input', paintBlend);
      blendRange.addEventListener('change', applyBlend);
      const blendRow = el('div', { class: 'row' }, blendRange, blendVal);
      ui.panel.append(
        el('div', { class: 'set-row' },
          el('div', { class: 'set-info' },
            el('div', { class: 'set-name' }, 'Blend with a second voice'),
            el('div', { class: 'set-sub' }, 'Averages the two voice embeddings into one that is not in the list. Subtle at the edges, a genuinely different speaker in the middle.')),
          el('div', { class: 'set-ctl' }, secondSel)),
        row('Blend amount', 'How much of the first voice', blendRow));
      fillSecond(st.tts?.voices?.length ? st.tts.voices : [current.split('+')[0]]);
      paintBlend();

      const pitchVal = el('span', { class: 'set-sub', style: { minWidth: '40px', fontFamily: 'var(--mono)' } }, String(c.voice?.tts?.pitch ?? 1));
      const pitch = el('input', {
        type: 'range', min: '0.75', max: '1.3', step: '0.01', value: String(c.voice?.tts?.pitch ?? 1), style: { width: '150px' },
        oninput: () => { pitchVal.textContent = Number(pitch.value).toFixed(2); },
        onchange: async () => { await save({ voice: { tts: { pitch: Number(pitch.value) } } }); V.invalidateVoiceStatus(); preview(current); },
      });
      ui.panel.append(row('Pitch',
        'Shifts the voice up or down. The speaking rate is compensated so the sentence takes roughly as long as before — roughly, because the model\'s own rate control is not quite linear, so a lower pitch also reads a little quicker. Small moves go a long way; past ±20% it starts to sound processed.',
        el('div', { class: 'row' }, pitch, pitchVal)));

      ui.panel.append(row('Try it', 'Plays a sentence with the current voice, blend, pitch and speed',
        el('button', { class: 'btn sm', onclick: () => preview(current) }, icon('play'), 'Preview')));

      // --- this device ---
      ui.panel.append(el('div', { class: 'lbl', style: { marginTop: '18px' } }, 'ON THIS DEVICE'),
        el('div', { class: 'set-sub', style: { marginBottom: '8px' } }, 'Stored in this browser, not on the server — each device decides for itself.'));

      const p = V.prefs();

      // One control with three positions rather than an "aloud" switch and a "mute"
      // switch, which between them could be set to contradict each other. "Never" is
      // a first-class answer: voice becomes a dictation-only input method, the
      // speaker buttons disappear, and the speech model is never even loaded.
      const speechSeg = el('div', { class: 'seg' }, ...[
        ['auto', 'Always'], ['ask', 'When I ask'], ['off', 'Never'],
      ].map(([v, label]) => el('button', {
        class: 'seg-btn' + (p.speech === v ? ' on' : ''),
        onclick: () => { V.setPrefs({ speech: v }); if (v !== 'auto') V.stopSpeaking(); renderPanel(); },
      }, label)));
      ui.panel.append(row('Spoken replies',
        p.speech === 'off'
          ? 'Muted. The microphone still works — this is voice input only.'
          : p.speech === 'auto'
            ? 'Every chat answer is read aloud as it arrives.'
            : 'Silent until you press the speaker on a message.',
        speechSeg));

      // MEASURED, not guessed: at 1100ms a normal 0.9s mid-sentence pause ended the
      // recording and the rest of the sentence was never captured — which is
      // indistinguishable from the model mishearing you. See scripts/voice-bench.mjs.
      const PAUSES = [[1200, 'Snappy'], [1500, 'Natural'], [2000, 'Patient'], [2600, 'Very patient']];
      const curPause = p.silenceMs || 1500;
      const pauseSeg = el('div', { class: 'seg' }, ...PAUSES.map(([ms, label]) => el('button', {
        class: 'seg-btn' + (curPause === ms ? ' on' : ''),
        title: `${(ms / 1000).toFixed(1)}s of quiet ends your turn`,
        onclick: () => { V.setPrefs({ silenceMs: ms }); renderPanel(); },
      }, label)));
      ui.panel.append(row('How long a pause ends your turn',
        `${(curPause / 1000).toFixed(1)}s. Too short and it cuts you off while you are still thinking — which reads as the model mishearing you, not as a timing problem. Too long and every answer waits.`,
        pauseSeg));

      const devSwitch = (name, sub, key) => row(name, sub, switchBtn(p[key], (on) => { V.setPrefs({ [key]: on }); renderPanel(); }));
      ui.panel.append(
        devSwitch('Hands-free in Voice mode', 'Send when you stop talking, then listen again — instead of tapping each turn', 'handsFree'),
        devSwitch('Audio cues', 'Short tones when the microphone opens and closes, so you can tell listening from thinking without looking', 'cues'),
        devSwitch('Send dictation immediately', 'The composer mic normally leaves the text for you to check first', 'dictateSend'),
      );

      // --- resources ---
      ui.panel.append(el('div', { class: 'lbl', style: { marginTop: '18px' } }, 'RESOURCES'));
      const idle = el('input', {
        class: 'input sm', type: 'number', min: '0', max: '240', style: { width: '80px' },
        value: String(c.voice?.idleMinutes ?? 15),
        onchange: async () => { await save({ voice: { idleMinutes: Math.max(0, Number(idle.value) || 0) } }); V.invalidateVoiceStatus(); },
      });
      ui.panel.append(row('Unload after (minutes)', 'The two models hold ~1.2GB. 0 keeps them resident, which is the right answer only if nothing else on this box wants the memory.', idle));

      ui.panel.append(row('Models',
        st.running ? 'Loaded and ready'
          : p.speech === 'off' ? 'Loaded on first use — only the listening model, while replies are muted'
            : 'Loaded on first use',
        el('div', { class: 'row' },
          el('button', { class: 'btn sm', onclick: async () => { try { await post('/voice/warm', { stt: true, tts: p.speech !== 'off' }); toast('models loaded', 'ok'); } catch (e) { toast(e.message, 'err'); } V.invalidateVoiceStatus(); renderPanel(); } }, 'Load now'),
          el('button', { class: 'btn sm ghost', onclick: async () => { try { await post('/voice/stop', {}); toast('released'); } catch (e) { toast(e.message, 'err'); } V.invalidateVoiceStatus(); renderPanel(); } }, 'Unload'))));
    }

    async function renderPanel() {
      const c = state.config;
      ui.panel.innerHTML = '';
      if (!c) { ui.panel.append(el('div', { class: 'empty' }, 'config unavailable')); return; }

      if (S.tab === 'appearance') {
        ui.panel.append(el('h2', {}, 'Appearance'), el('div', { class: 'desc' }, 'Make it yours — everything applies instantly.'));

        const gallery = el('div', { class: 'theme-gallery' }, ...THEMES.map(t => {
          const cardEl = el('button', { class: 'theme-card' + (c.appearance.theme === t.name ? ' on' : '') },
            el('div', { class: 'theme-swatch', style: { background: t.preview[0] } },
              el('span', { class: 'ts-bar', style: { background: t.preview[1] } }),
              el('span', { class: 'ts-dot', style: { background: t.preview[2] } })),
            el('div', { class: 'theme-name' }, t.label));
          cardEl.addEventListener('click', async () => {
            const patch = { theme: t.name, accent: t.accent };
            c.appearance.theme = t.name; c.appearance.accent = t.accent;
            if (t.wallpaper) { c.appearance.wallpaper = t.wallpaper; patch.wallpaper = t.wallpaper; }
            else if (['matrix', 'synthwave'].includes(c.appearance.wallpaper)) { c.appearance.wallpaper = 'aurora'; patch.wallpaper = 'aurora'; }
            applyAppearance();
            await save({ appearance: patch });
            renderPanel();
          });
          return cardEl;
        }));
        ui.panel.append(row('Theme', 'Pick a full palette — the accent and wallpaper below still override it', gallery));

        const swatches = el('div', { class: 'swatches' }, ...ACCENTS.map(color =>
          el('button', {
            class: 'swatch' + (c.appearance.accent === color ? ' on' : ''), style: { background: color },
            onclick: async () => { c.appearance.accent = color; applyAppearance(); await save({ appearance: { accent: color } }); renderPanel(); },
          })));
        const custom = el('input', { type: 'color', value: c.appearance.accent, style: { width: '26px', height: '26px', border: 'none', background: 'none', cursor: 'pointer' } });
        custom.addEventListener('change', async () => { c.appearance.accent = custom.value; applyAppearance(); await save({ appearance: { accent: custom.value } }); });
        swatches.append(custom);
        ui.panel.append(row('Accent color', 'Used for highlights, buttons, and glow', swatches));

        const walls = el('div', { class: 'row' }, ...WALLPAPERS.map(w => {
          const th = el('div', { class: 'wp-thumb' + (c.appearance.wallpaper === w ? ' on' : ''), title: w });
          const inner = el('div', { style: { width: '100%', height: '100%' } });
          inner.id = 'wp-mini-' + w; inner.className = 'wp-' + w;
          inner.style.position = 'relative';
          th.append(inner);
          th.addEventListener('click', async () => { c.appearance.wallpaper = w; applyAppearance(); await save({ appearance: { wallpaper: w } }); renderPanel(); });
          return th;
        }));
        ui.panel.append(row('Wallpaper', 'Desktop background style', walls));
      }

      if (S.tab === 'providers') {
        ui.panel.append(el('h2', {}, 'AI Providers'), el('div', { class: 'desc' }, 'Cloud and local models both work — mix them freely per app.'));

        // Anthropic
        const anthKey = el('input', { class: 'input', type: 'password', placeholder: c.providers.anthropic.hasKey ? '•••••••• (key set)' : 'sk-ant-…', style: { width: '210px' } });
        const anthBtn = el('button', {
          class: 'btn sm primary', onclick: async () => {
            if (!anthKey.value.trim()) return;
            if (await save({ providers: { anthropic: { apiKey: anthKey.value.trim() } } }, 'Anthropic key saved')) { anthKey.value = ''; fetchModels(true); refreshStatus(); renderPanel(); }
          },
        }, 'Save');
        const anthClear = c.providers.anthropic.hasKey ? el('button', {
          class: 'btn sm ghost danger', onclick: async () => { await save({ providers: { anthropic: { apiKey: null } } }, 'key removed'); fetchModels(true); renderPanel(); },
        }, 'remove') : null;
        ui.panel.append(row('Anthropic API key',
          c.providers.anthropic.hasKey ? 'Configured — Claude models available' : 'console.anthropic.com → API keys',
          el('div', { class: 'row' }, anthKey, anthBtn, anthClear)));

        // Ollama
        const olUrl = el('input', { class: 'input', value: c.providers.ollama.baseUrl, style: { width: '230px' } });
        const olBtn = el('button', {
          class: 'btn sm', onclick: async () => {
            if (await save({ providers: { ollama: { baseUrl: olUrl.value.trim() } } })) { fetchModels(true); refreshStatus(); renderPanel(); }
          },
        }, 'Save');
        const olStatus = state.status?.providers?.ollama;
        ui.panel.append(row('Ollama',
          olStatus?.up ? `Running — ${olStatus.models} local models` : 'Not reachable. Install from ollama.com, then `ollama pull qwen3` etc.',
          el('div', { class: 'row' }, olUrl, olBtn)));

        // Custom OpenAI-compatible providers & gateways
        ui.panel.append(el('div', { class: 'lbl', style: { marginTop: '18px' } }, 'OPENAI-COMPATIBLE PROVIDERS & GATEWAYS (OpenRouter, Groq, LM Studio, vLLM, llama.cpp…)'));
        for (const p of c.providers.custom) {
          const meta = p.baseUrl + (p.models?.length ? ` · ${p.models.join(', ')}` : '');
          ui.panel.append(row(p.name, meta, el('button', {
            class: 'btn sm ghost danger', onclick: async () => {
              await save({ providers: { custom: c.providers.custom.filter(x => x.id !== p.id) } }, 'removed');
              fetchModels(true); renderPanel();
            },
          }, 'remove')));
        }
        const addBtn = el('button', {
          class: 'btn sm', onclick: async () => {
            // known OpenAI-compatible gateways — pick one to auto-fill, or Custom
            const PRESETS = [
              { label: 'Custom / other…' },
              { label: 'OpenRouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
              { label: 'Groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
              { label: 'Together AI', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1' },
              { label: 'DeepInfra', name: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai' },
              { label: 'Fireworks AI', name: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1' },
              { label: 'OpenAI', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
              { label: 'LM Studio (local)', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
            ];
            const nameIn = el('input', { class: 'input', placeholder: 'My provider', style: { width: '100%' } });
            const urlIn = el('input', { class: 'input', placeholder: 'https://…/v1', style: { width: '100%' } });
            const keyIn = el('input', { class: 'input', type: 'password', placeholder: 'Bearer key — blank if none', style: { width: '100%' } });
            const modelsIn = el('input', { class: 'input', placeholder: 'model-id, … (optional)', style: { width: '100%' } });
            const preset = el('select', {
              class: 'input select', style: { width: '100%' },
              onchange: () => { const pr = PRESETS[preset.selectedIndex] || {}; nameIn.value = pr.name || ''; urlIn.value = pr.baseUrl || ''; modelsIn.value = pr.models || ''; },
            }, ...PRESETS.map(pr => el('option', {}, pr.label)));
            const fld = (lbl, ctl, hint) => el('div', { style: { marginBottom: '10px' } },
              el('div', { class: 'lbl', style: { marginBottom: '4px' } }, lbl), ctl,
              hint && el('div', { class: 'desc', style: { marginTop: '3px' } }, hint));
            const body = el('div', { style: { marginTop: '6px', minWidth: '400px' } },
              fld('Preset', preset, 'Pick a known gateway to auto-fill, or choose Custom.'),
              fld('Name', nameIn),
              fld('Base URL', urlIn, 'The OpenAI-compatible endpoint, usually ending in /v1.'),
              fld('API key', keyIn),
              fld('Models', modelsIn, 'Comma-separated. Needed only when the endpoint serves no /models list; otherwise leave blank to auto-discover.'));
            const res = await modal({
              title: 'Connect an AI provider', wide: true, body,
              actions: [
                { label: 'Cancel', value: null },
                {
                  label: 'Add', kind: 'primary', onpick: (close) => {
                    const name = nameIn.value.trim(), baseUrl = urlIn.value.trim();
                    if (!name || !baseUrl) { toast('Name and Base URL are required', 'err'); return false; }
                    close({ name, baseUrl, apiKey: keyIn.value.trim(), models: modelsIn.value.split(',').map(s => s.trim()).filter(Boolean) });
                  },
                },
              ],
            });
            if (!res) return;
            await save({ providers: { custom: [...c.providers.custom, { id: '', ...res }] } }, 'provider added');
            fetchModels(true); refreshStatus(); renderPanel();
          },
        }, icon('plus'), 'Add provider');
        ui.panel.append(el('div', { style: { marginTop: '10px' } }, addBtn));

        // ---- managed llama.cpp: profiles + the desktop launcher ----
        if (c.llm?.managed !== false) {
          ui.panel.append(el('div', { class: 'lbl', style: { marginTop: '22px' } }, 'LOCAL LLAMA.CPP (AIOS-managed)'));
          let ls = null;
          try { ls = await get('/llm/status'); } catch { }
          const profiles = ls?.profiles || ['big', 'tiny'];
          const cur = ls?.running ? ls.profile : (ls?.foreign ? 'foreign' : '');
          const profSeg = el('div', { class: 'seg' }, ...profiles.map(p => el('button', {
            class: 'seg-btn' + (cur === p ? ' on' : ''),
            onclick: async (ev) => {
              const b = ev.target; const prev = b.textContent; b.disabled = true; b.textContent = 'loading…';
              try { await post('/llm/profile', { profile: p }); toast(`switched to ${p} — may take a minute`, 'ok'); }
              catch (e) { toast(e.message, 'err'); }
              b.disabled = false; b.textContent = prev; refreshStatus(); renderPanel();
            },
          }, p)));
          ui.panel.append(row(
            el('span', { class: 'row' }, el('span', { class: 'pdot ' + (ls?.running ? 'up' : ls?.foreign ? 'warn' : 'off') }), 'Active profile'),
            ls?.running ? `${ls.profile} on :${ls.port}${ls.gpu ? ` · GPU ${ls.gpu.freeMB}MB free` : ''}`
              : ls?.foreign ? 'running unmanaged (started outside AIOS — switching a profile takes it over)'
                : 'stopped — pick a profile to start it',
            profSeg));
          ui.panel.append(row('Launcher app',
            'Open the desktop GUI for Whisper, MusicGen, and manual llama.cpp tuning. AIOS manages the text model itself, so use the launcher\'s llama tab only when experimenting.',
            el('button', {
              class: 'btn sm', onclick: async () => {
                try { await post('/llm/launcher', {}); toast('launcher opening on your desktop', 'ok'); }
                catch (e) { toast(e.message, 'err'); }
              },
            }, icon('external'), 'Open launcher')));
        }

        // ---- sampling: everything the harness can reasonably set on a request ----
        ui.panel.append(el('div', { class: 'lbl', style: { marginTop: '22px' } }, 'SAMPLING (all models — blank = provider default)'));
        const sm = c.sampling || {};
        const numField = (key, { min, max, step, width = 90 }) => {
          const inp = el('input', { class: 'input', type: 'number', min, max, step, style: { width: width + 'px' }, placeholder: 'default' });
          if (sm[key] !== null && sm[key] !== undefined && sm[key] !== '') inp.value = sm[key];
          inp.addEventListener('change', () => {
            const v = inp.value.trim() === '' ? null : Number(inp.value);
            save({ sampling: { [key]: v } }, v === null ? `${key} → provider default` : `${key} = ${v}`);
          });
          return inp;
        };
        ui.panel.append(row('Temperature', 'Randomness. 0 = deterministic-ish, higher = more creative (Anthropic caps at 1)', numField('temperature', { min: 0, max: 2, step: 0.05 })));
        ui.panel.append(row('Top-p', 'Nucleus sampling — keep tokens covering this probability mass (0–1)', numField('top_p', { min: 0, max: 1, step: 0.01 })));
        ui.panel.append(row('Top-k', 'Only the k most likely tokens (Anthropic, Ollama, llama.cpp)', numField('top_k', { min: 1, max: 400, step: 1 })));
        ui.panel.append(row('Presence penalty', 'Discourage reusing tokens that already appeared (-2 to 2, OpenAI-compat + Ollama)', numField('presence_penalty', { min: -2, max: 2, step: 0.1 })));
        ui.panel.append(row('Frequency penalty', 'Discourage frequent tokens proportionally (-2 to 2, OpenAI-compat + Ollama)', numField('frequency_penalty', { min: -2, max: 2, step: 0.1 })));
        ui.panel.append(row('Repeat penalty', 'llama.cpp/Ollama repetition penalty (~1.0–1.3)', numField('repeat_penalty', { min: 0.5, max: 2, step: 0.05 })));
        ui.panel.append(row('Seed', 'Fixed seed for reproducible outputs (where supported)', numField('seed', { min: 0, max: 2147483647, step: 1, width: 130 })));
        const stopInp = el('input', { class: 'input', value: (sm.stop || []).join(', '), placeholder: 'e.g. ###, END', style: { width: '230px' } });
        stopInp.addEventListener('change', () => save({ sampling: { stop: stopInp.value.split(',').map(s => s.trim()).filter(Boolean).slice(0, 4) } }, 'stop sequences saved'));
        ui.panel.append(row('Stop sequences', 'Up to 4, comma-separated — generation halts when one appears', stopInp));
      }

      if (S.tab === 'tools') {
        ui.panel.append(el('h2', {}, 'Tools'),
          el('div', { class: 'desc' }, 'Everything the agent can do, and the services behind it. Disabled tools disappear from the model entirely; write tools still go through the approval mode.'));

        let info = null;
        try { info = await get('/tools'); } catch { }
        if (!info) { ui.panel.append(el('div', { class: 'empty' }, 'tools unavailable — is the server up?')); return; }

        // web search backend
        ui.panel.append(el('div', { class: 'lbl' }, 'WEB SEARCH'));
        const sx = info.searxng || {};
        const sxInput = el('input', { class: 'input', value: c.tools?.searxng?.url || '', placeholder: 'http://127.0.0.1:8890', style: { width: '210px' } });
        const sxSave = el('button', {
          class: 'btn sm', onclick: async () => {
            if (await save({ tools: { searxng: { url: sxInput.value.trim() } } }, 'search endpoint saved')) renderPanel();
          },
        }, 'Save');
        ui.panel.append(row(
          el('span', { class: 'row' }, el('span', { class: 'pdot ' + (sx.up ? 'up' : 'warn') }), 'SearXNG'),
          sx.up ? 'Metasearch is up — web_search aggregates real engines through it'
            : 'Not answering — web_search falls back to DuckDuckGo. Start the bundled instance with “npm run searxng” (needs Docker).',
          el('div', { class: 'row' }, sxInput, sxSave)));

        const testBtn = el('button', {
          class: 'btn sm', onclick: async () => {
            testBtn.disabled = true;
            const q = await askText({ title: 'Test web search', placeholder: 'query…', value: 'searxng metasearch', ok: 'Search' });
            if (q) {
              try {
                const r = await post('/tools/test-search', { query: q });
                modal({
                  title: 'web_search result', sub: r.ok ? 'exactly what the agent would see' : 'the search failed', wide: true,
                  body: el('pre', { class: 'mono', style: { fontSize: '11.5px', whiteSpace: 'pre-wrap', maxHeight: '46vh', overflowY: 'auto', background: 'var(--code-bg)', padding: '12px', borderRadius: '8px' } }, r.output || '(empty)'),
                  actions: [{ label: 'Close', kind: 'primary' }],
                });
              } catch (e) { toast(e.message, 'err'); }
            }
            testBtn.disabled = false;
          },
        }, icon('search'), 'Test search');
        ui.panel.append(row('Try it', 'Runs the web_search tool exactly as the agent would', testBtn));

        // maps & directions
        ui.panel.append(el('div', { class: 'lbl', style: { marginTop: '18px' } }, 'MAPS & DIRECTIONS'));
        const maps = c.tools?.maps || {};
        const unitSeg = el('div', { class: 'seg' }, ...[['metric', 'Metric'], ['imperial', 'Imperial']].map(([v, l]) => el('button', {
          class: 'seg-btn' + ((maps.units || 'metric') === v ? ' on' : ''),
          onclick: async () => { if (await save({ tools: { maps: { units: v } } })) renderPanel(); },
        }, l)));
        ui.panel.append(row('Units', 'For directions & nearby places. Free via OpenStreetMap — driving, walking and cycling need no key.', unitSeg));

        const gk = el('input', { class: 'input', type: 'password', value: '', placeholder: maps.hasGoogleKey ? '•••••• (key set)' : 'optional — enables transit', style: { width: '210px' } });
        const gkSave = el('button', {
          class: 'btn sm', onclick: async () => {
            const v = gk.value.trim(); if (!v) return;
            if (await save({ tools: { maps: { googleKey: v } } }, 'Google key saved')) renderPanel();
          },
        }, 'Save');
        const gkCtl = el('div', { class: 'row' }, gk, gkSave);
        if (maps.hasGoogleKey) gkCtl.append(el('button', {
          class: 'btn sm ghost danger', onclick: async () => { if (await save({ tools: { maps: { googleKey: null } } }, 'key cleared')) renderPanel(); },
        }, 'Clear'));
        ui.panel.append(row('Google Directions key', 'Optional. Adds train/bus (transit) directions and exact walking/cycling times; driving works without it.', gkCtl));

        await renderMcp();

        // the tool belt — plus one section per connected MCP server, discovered from the
        // catalogue rather than hard-coded, so a newly added server appears by itself
        const mcpGroups = [...new Set(info.tools.filter(t => t.mcp).map(t => t.group))]
          .sort().map(g => [g, `MCP · ${g.slice(4).toUpperCase()}`]);
        const groups = [['files', 'FILES'], ['git', 'GIT'], ['system', 'SYSTEM'], ['web', 'WEB'], ['maps', 'MAPS & LOCAL'], ['utility', 'EVERYDAY UTILITIES'], ['vault', 'KNOWLEDGE BASE'], ['apps', 'AIOS APPS'], ['mail', 'MAIL'], ['custom', 'AI-FORGED TOOLS'], ...mcpGroups];
        for (const [gid, glabel] of groups) {
          const list = info.tools.filter(t => t.group === gid);
          if (!list.length) continue;
          ui.panel.append(el('div', { class: 'lbl', style: { marginTop: '18px' } }, glabel));
          for (const t of list) {
            const ctl = el('div', { class: 'row' });
            if (t.custom) {
              if (t.lastError) ctl.append(el('span', { class: 'chip', title: t.lastError, style: { color: 'var(--danger, #d33)' } }, 'error'));
              ctl.append(el('span', { class: 'chip', title: 'Times this tool has run' }, `${t.runs || 0} runs`));
              ctl.append(el('button', {
                class: 'btn sm ghost danger', title: 'Delete this AI-created tool',
                onclick: async () => {
                  if (!await confirmBox(`Delete ${t.name}?`, 'The agent created this tool; it can recreate it later if needed.', 'Delete')) return;
                  try { await del('/tools/custom/' + encodeURIComponent(t.name)); toast('deleted', 'ok'); renderPanel(); }
                  catch (e) { toast(e.message, 'err'); }
                },
              }, icon('trash')));
            }
            if (t.write) ctl.append(el('span', { class: 'chip', title: 'Subject to the approval mode' }, 'write'));
            ctl.append(switchBtn(t.enabled, async (next) => {
              if (!next && t.core && !await confirmBox(`Disable ${t.name}?`, 'This is a core tool — the agent will struggle without it.', 'Disable')) return;
              const disabled = new Set(info.tools.filter(x => !x.enabled).map(x => x.name));
              next ? disabled.delete(t.name) : disabled.add(t.name);
              if (await save({ tools: { disabled: [...disabled] } }, `${t.name} ${next ? 'enabled' : 'disabled'}`)) renderPanel();
            }));
            ui.panel.append(row(el('span', { class: 'mono', style: t.enabled ? {} : { opacity: .5 } }, t.name), t.description, ctl));
          }
        }
      }


      if (S.tab === 'vault') {
        ui.panel.append(el('h2', {}, 'Obsidian Vault'), el('div', { class: 'desc' }, 'AIOS works directly on your vault folder — the same files Obsidian opens.'));
        const path = el('input', { class: 'input', value: c.vault.path || '', placeholder: '/home/you/Documents/MyVault', style: { width: '280px' } });
        ui.panel.append(row('Vault path', 'Absolute path to the vault folder', el('div', { class: 'row' }, path,
          el('button', { class: 'btn sm primary', onclick: async () => { try { await post('/vault/path', { path: path.value.trim(), create: false }); await refreshConfig(); toast('vault connected', 'ok'); renderPanel(); } catch (e) { toast(e.message, 'err'); } } }, 'Connect'),
          el('button', { class: 'btn sm', onclick: async () => { try { await post('/vault/path', { path: path.value.trim(), create: true }); await refreshConfig(); toast('vault created', 'ok'); renderPanel(); } catch (e) { toast(e.message, 'err'); } } }, 'Create'))));

        const wiki = el('input', { class: 'input', value: c.vault.wikiFolder, style: { width: '160px' } });
        wiki.addEventListener('change', () => save({ vault: { wikiFolder: wiki.value.trim() || 'AI Wiki' } }));
        ui.panel.append(row('AI wiki folder', 'Where generated notes land', wiki));

        const daily = el('input', { class: 'input', value: c.vault.dailyFolder, style: { width: '160px' } });
        daily.addEventListener('change', () => save({ vault: { dailyFolder: daily.value.trim() || 'Daily' } }));
        ui.panel.append(row('Daily notes folder', 'Quick captures append here', daily));

        ui.panel.append(el('div', { class: 'lbl', style: { marginTop: '18px' } }, 'AUTONOMY'));
        ui.panel.append(row('Auto-approve wiki upkeep', 'Agent writes inside the wiki folder, daily log, and generated maps skip the approval gate',
          switchBtn(c.vault.autoApprove !== false, async (next) => { if (await save({ vault: { autoApprove: next } }, `wiki auto-approve ${next ? 'on' : 'off'}`)) renderPanel(); })));
        ui.panel.append(row('Auto-export research', 'Finished deep-research reports are saved into the wiki and indexed automatically',
          switchBtn(c.vault.autoExport !== false, async (next) => { if (await save({ vault: { autoExport: next } }, `research auto-export ${next ? 'on' : 'off'}`)) renderPanel(); })));
      }

      if (S.tab === 'github') {
        ui.panel.append(el('h2', {}, 'GitHub'),
          el('div', { class: 'desc' }, 'Powers the GitHub app (profile, repos, PRs, publish, clone). AIOS borrows the gh CLI\'s login automatically — a token here overrides it.'));

        let st = null;
        try { st = await get('/github/status'); } catch (e) { st = { configured: false, hint: e.message }; }
        ui.panel.append(row(
          el('span', { class: 'row' }, el('span', { class: 'pdot ' + (st?.configured ? 'up' : 'warn') }), 'Connection'),
          st?.configured
            ? `Signed in as @${st.user.login}${st.via === 'gh-cli' ? ' — borrowed from the gh CLI (no token stored in AIOS)' : ' — using the token below'}`
            : (st?.hint || 'Not connected. Run `gh auth login` in a terminal, or paste a token below.'),
          el('button', { class: 'btn sm', onclick: () => renderPanel() }, icon('refresh'), 'Re-check')));

        const tok = el('input', { class: 'input', type: 'password', placeholder: c.github?.hasToken ? '•••••••• (token set)' : 'ghp_… / github_pat_… (optional)', style: { width: '230px' } });
        const tokSave = el('button', {
          class: 'btn sm', onclick: async () => {
            if (tok.value.trim() && await save({ github: { token: tok.value.trim() } }, 'token saved')) { tok.value = ''; renderPanel(); }
          },
        }, 'Save');
        const tokClear = c.github?.hasToken ? el('button', {
          class: 'btn sm ghost danger',
          onclick: async () => { if (await save({ github: { token: null } }, 'token removed')) renderPanel(); },
        }, 'remove') : null;
        ui.panel.append(row('Personal access token', 'Needs repo scope (classic PAT) or fine-grained repo permissions. Stored server-side, never shown again.',
          el('div', { class: 'row' }, tok, tokSave, tokClear)));

        ui.panel.append(el('div', { class: 'muted small', style: { marginTop: '14px', lineHeight: 1.6 } },
          'The agent also uses this machine\'s git + gh CLI through its git tools and bash — pushes and PRs happen only when you ask.'));
      }

      if (S.tab === 'mail') {
        ui.panel.append(el('h2', {}, 'Mail & Alerts'),
          el('div', { class: 'desc' }, 'AIOS reads your inbox over IMAP (read-only — nothing gets marked as seen), and the AI flags what actually needs you. Important mail shows on Home and can ping Discord. Gmail/Outlook with 2FA need an app password.'));

        const m = c.mail || {};
        const host = el('input', { class: 'input', value: m.host || '', placeholder: 'imap.gmail.com', style: { width: '190px' } });
        const port = el('input', { class: 'input', type: 'number', value: m.port || 993, style: { width: '80px' } });
        const user = el('input', { class: 'input', value: m.user || '', placeholder: 'you@gmail.com', style: { width: '210px' } });
        const pass = el('input', { class: 'input', type: 'password', placeholder: m.hasPassword ? '•••••• (saved)' : 'app password', style: { width: '170px' } });
        for (const [inp, key] of [[host, 'host'], [user, 'user']]) inp.addEventListener('change', () => save({ mail: { [key]: inp.value.trim() } }));
        port.addEventListener('change', () => save({ mail: { port: +port.value || 993 } }));
        const passBtn = el('button', { class: 'btn sm', onclick: async () => { if (pass.value && await save({ mail: { password: pass.value } }, 'password saved')) { pass.value = ''; renderPanel(); } } }, 'Save');
        ui.panel.append(row('IMAP server', 'Host and port (993 = TLS)', el('div', { class: 'row' }, host, port)));
        ui.panel.append(row('Account', 'Login (usually the address itself)', user));
        ui.panel.append(row('Password', 'Stored locally in data/config.json, never shown again', el('div', { class: 'row' }, pass, passBtn)));

        const lookback = el('input', { class: 'input', type: 'number', min: 1, max: 14, value: m.lookbackDays || 3, style: { width: '80px' } });
        lookback.addEventListener('change', () => save({ mail: { lookbackDays: Math.max(1, Math.min(14, +lookback.value || 3)) } }));
        ui.panel.append(row('Look back', 'Days of mail to consider per scan', lookback));

        const interval = el('input', { class: 'input', type: 'number', min: 0, max: 720, value: m.scanIntervalMin || 0, style: { width: '80px' } });
        interval.addEventListener('change', () => save({ mail: { scanIntervalMin: Math.max(0, +interval.value || 0), enabled: (+interval.value || 0) > 0 } }));
        ui.panel.append(row('Auto-scan every (min)', '0 = manual only. Uses the default chat model to triage new mail', interval));

        const scanBtn = el('button', {
          class: 'btn sm primary', onclick: async () => {
            scanBtn.disabled = true; scanBtn.textContent = 'scanning…';
            try { const r = await post('/mail/scan', {}); toast(`scanned ${r.scanned}, ${r.important} important (${r.classifiedBy})`, 'ok'); }
            catch (e) { toast(e.message, 'err'); }
            scanBtn.disabled = false; scanBtn.textContent = 'Scan now';
          },
        }, 'Scan now');
        ui.panel.append(row('Try it', 'Fetch + triage recent mail right now', scanBtn));

        ui.panel.append(el('div', { class: 'lbl', style: { marginTop: '22px' } }, 'DISCORD NOTIFICATIONS'));
        const hook = el('input', { class: 'input', type: 'password', placeholder: c.notify?.hasDiscordWebhook ? '•••••• (saved)' : 'https://discord.com/api/webhooks/…', style: { width: '280px' } });
        const hookBtn = el('button', { class: 'btn sm', onclick: async () => { if (hook.value && await save({ notify: { discordWebhook: hook.value.trim() } }, 'webhook saved')) { hook.value = ''; renderPanel(); } } }, 'Save');
        const hookTest = el('button', {
          class: 'btn sm ghost', onclick: async () => {
            try { await post('/notify/test', {}); toast('sent — check Discord', 'ok'); } catch (e) { toast(e.message, 'err'); }
          },
        }, 'Test');
        ui.panel.append(row('Webhook URL', 'Server settings → Integrations → Webhooks → copy URL', el('div', { class: 'row' }, hook, hookBtn, hookTest)));
        ui.panel.append(row('Ping on important mail', 'Send a Discord digest when a scan finds new important messages',
          switchBtn(c.notify?.onImportantMail !== false, async (next) => { if (await save({ notify: { onImportantMail: next } })) renderPanel(); })));

        // ---- sender rules: the inbox's learned ratings ----
        ui.panel.append(el('div', { class: 'lbl', style: { marginTop: '22px' } }, 'SENDER RULES'),
          el('div', { class: 'set-sub', style: { marginBottom: '8px' } },
            '⚡ starred senders are fast-tracked to the top of the Home inbox · ⊘ muted senders never appear. Rate senders from the inbox rows/modal; dismissing one sender 3× auto-mutes it.'));
        let rules = [];
        try { rules = await get('/mail/senders'); } catch { }
        if (!rules.length) ui.panel.append(el('div', { class: 'muted small' }, 'no sender rules yet'));
        for (const r of rules) {
          ui.panel.append(row(
            el('span', { class: 'mono', style: { fontSize: '12px' } }, `${r.rule === 'star' ? '⚡' : '⊘'} ${r.key}`),
            `${r.rule === 'star' ? 'fast-tracked' : 'muted'}${r.kind === 'domain' ? ' (whole domain)' : ''}${r.via === 'auto' ? ' · auto (dismissed 3×)' : ''}`,
            el('button', {
              class: 'btn sm ghost danger', title: 'Remove this rule',
              onclick: async () => {
                try { await post('/mail/sender', { from: r.key.startsWith('@') ? 'x' + r.key : r.key, rule: 'clear', kind: r.kind }); toast('rule removed', 'ok'); renderPanel(); }
                catch (e) { toast(e.message, 'err'); }
              },
            }, icon('trash'))));
        }
      }

      if (S.tab === 'chat') {
        ui.panel.append(el('h2', {}, 'Chat'), el('div', { class: 'desc' }, 'Defaults for new chats, the shared base system prompt, and what the AI learns about you.'));

        ui.panel.append(row('Tools by default', 'New chats can call read-only tools (web search, your notes, inbox, planner) so answers stay current. Each chat has its own toggle too.',
          switchBtn(c.defaults.chatTools !== false, async (v) => { await save({ defaults: { chatTools: v } }); renderPanel(); })));

        ui.panel.append(row('Confirm before writing',
          'Say "I made 50000 through Uber Eats today" and you get a card — amount, category, date, all editable — with a Confirm button, instead of a ledger row appearing. Turn it off and the assistant writes directly, which is faster and occasionally wrong in a way you find out about weeks later.',
          switchBtn(c.defaults.confirmActions !== false, async (v) => { await save({ defaults: { confirmActions: v } }); renderPanel(); })));

        const baseTa = el('textarea', { class: 'input', rows: 8, style: { width: '100%', fontFamily: 'var(--mono)', fontSize: '12.5px' } }, '');
        baseTa.value = c.defaults.chatSystem || '';
        const baseSave = el('button', { class: 'btn sm primary', onclick: () => save({ defaults: { chatSystem: baseTa.value } }) }, 'Save base prompt');
        ui.panel.append(el('div', { class: 'set-block' },
          el('div', { class: 'set-name' }, 'Base system prompt'),
          el('div', { class: 'set-sub' }, 'Prepended to every chat (each chat\'s own "system" instructions stack on top). {name} and {date} are filled in automatically. Keep the "search before answering time-sensitive questions" guidance to stop the model guessing at current events.'),
          baseTa, el('div', { class: 'row', style: { marginTop: '6px' } }, baseSave)));

        // --- personality profile the AI maintains about you ---
        ui.panel.append(el('h2', { style: { marginTop: '22px' } }, 'Your profile'), el('div', { class: 'desc' }, 'The AI learns your communication style and stable preferences from your messages, keeps a note in your Second Brain, and adapts to you. Edit it any time — the AI builds on your changes.'));
        ui.panel.append(row('Learn my style', 'Periodically updates your profile from recent chats (runs quietly in the background)',
          switchBtn(c.profile?.enabled !== false, async (v) => { await save({ profile: { enabled: v } }); renderPanel(); })));
        ui.panel.append(row('Use it in prompts', 'Injects a condensed version of your profile into chat and agent so replies fit you',
          switchBtn(c.profile?.inject !== false, async (v) => { await save({ profile: { inject: v } }); renderPanel(); })));

        const profTa = el('textarea', { class: 'input', rows: 10, style: { width: '100%', fontSize: '12.5px' } }, '');
        const profMeta = el('div', { class: 'set-sub' }, 'loading…');
        (async () => {
          try {
            const p = await get('/profile');
            profTa.value = p.text || '';
            profMeta.textContent = p.updatedAt ? `Last updated ${new Date(p.updatedAt).toLocaleString()}${p.notePath ? ` · vault: ${p.notePath}` : ''}` : 'No profile yet — chat a bit and it will fill in, or write your own.';
          } catch { profMeta.textContent = 'could not load profile'; }
        })();
        const profSave = el('button', { class: 'btn sm primary', onclick: async () => { try { await put('/profile', { text: profTa.value }); toast('profile saved', 'ok'); } catch (e) { toast(e.message, 'err'); } } }, 'Save profile');
        const profLearn = el('button', { class: 'btn sm', onclick: async () => { profMeta.textContent = 'learning from your recent chats…'; try { const p = await post('/profile/learn', { modelRef: c.defaults.chatModel }); profTa.value = p.text || profTa.value; profMeta.textContent = p.updatedAt ? `Updated ${new Date(p.updatedAt).toLocaleString()}` : 'no change'; toast('profile updated', 'ok'); } catch (e) { toast(e.message, 'err'); } } }, icon('sparkle'), 'Regenerate now');
        ui.panel.append(el('div', { class: 'set-block' },
          el('div', { class: 'set-name' }, 'What the AI knows about you'), profMeta,
          profTa, el('div', { class: 'row', style: { marginTop: '6px', gap: '8px' } }, profSave, profLearn)));
      }

      if (S.tab === 'finance') {
        ui.panel.append(
          el('h2', {}, 'Finances'),
          el('div', { class: 'desc' }, 'Which model does each job, and the currency everything is compared in.'));

        const fin = c.finance || {};

        // --- models ---
        // Three jobs, three settings, because the requirements differ: only
        // receipt reading needs vision. The recommendation still points all three
        // at one model — see server/finance.js modelOptions().
        const recBox = el('div', { class: 'set-block' }, el('div', { class: 'set-sub' }, 'checking your models…'));
        ui.panel.append(recBox);

        const JOBS = [
          ['ocrModel', 'Reading receipts', 'Turns a photograph into merchant, date and line items. This one must be vision-capable — a text-only model cannot see the image.', true],
          ['itemModel', 'Naming products', 'Decides that "明治おいしい牛乳" is Milk. Wants strict JSON and comfortable Japanese.'],
          ['recapModel', 'Monthly write-ups', 'Writes the short account of each month you read back later. Wants readable prose.'],
        ];

        let visionRefs = new Set();
        const pickers = {};
        for (const [key, name, sub, needsVision] of JOBS) {
          const warn = el('div', { class: 'set-sub', style: { color: 'var(--warn)', marginTop: '4px' } });
          const sync = (ref) => {
            warn.textContent = needsVision && ref
              && visionRefs.size && ref.startsWith('local:') && !visionRefs.has(ref)
              ? 'This local model has no projector paired with it, so it cannot read images. Pair one in Settings → Models, or pick a vision model.'
              : '';
          };
          const p = modelPicker({
            value: fin[key] || '', allowEmpty: true, placeholder: 'chat default',
            onchange: async (ref) => { await save({ finance: { [key]: ref } }); sync(ref); },
          });
          pickers[key] = { picker: p, sync };
          ui.panel.append(el('div', { class: 'set-row' },
            el('div', { class: 'set-info' },
              el('div', { class: 'set-name' }, name),
              el('div', { class: 'set-sub' }, sub),
              warn),
            el('div', { class: 'set-ctl' }, p)));
          sync(fin[key] || '');
        }
        ui.panel.append(el('div', { class: 'set-sub', style: { marginTop: '-4px' } },
          `Left unset, each falls back to the chat default (${prettyModel(c.defaults?.chatModel) || 'none chosen'}).`));

        (async () => {
          try {
            const o = await get('/finance/models');
            visionRefs = new Set(o.vision.map(v => v.ref));
            for (const [key] of JOBS) pickers[key].sync(fin[key] || '');
            recBox.innerHTML = '';
            if (!o.recommended) {
              recBox.append(el('div', { class: 'set-name' }, 'No vision model available'),
                el('div', { class: 'set-sub' }, o.note || 'Receipt reading needs a model paired with a projector.'));
              return;
            }
            const r = o.recommended;
            const already = [...JOBS].every(([k]) => (fin[k] || '') === r[k]);
            recBox.append(
              el('div', { class: 'set-name' }, already ? 'Recommended setup — in use' : 'Recommended setup'),
              el('div', { class: 'set-sub' }, r.why),
              already ? null : el('div', { class: 'row', style: { marginTop: '8px' } },
                el('button', {
                  class: 'btn sm primary',
                  onclick: async () => {
                    if (await save({ finance: { ocrModel: r.ocrModel, itemModel: r.itemModel, recapModel: r.recapModel } },
                      'finance models set')) renderPanel();
                  },
                }, icon('sparkle'), `Use ${prettyModel(r.ocrModel)} for all three`)));
          } catch (e) {
            recBox.innerHTML = '';
            recBox.append(el('div', { class: 'set-sub' }, `could not check models: ${e.message}`));
          }
        })();

        // --- how hard the scanner tries ---
        //
        // All three are trades of GPU seconds against how often a scan needs correcting by
        // hand, and the right point on that curve depends on the machine and the receipts,
        // so it is a setting rather than a constant. Defaults are the measured ones.
        ui.panel.append(el('h2', { style: { marginTop: '22px' } }, 'Reading receipts'),
          el('div', { class: 'desc' },
            'Each scan scores itself out of 100 — the arithmetic, the fields that are printed on every receipt, and how much of the basket it recognises. These decide what happens when that score is low.'));

        const numRow = (key, label, sub, { min, max, step = 1, suffix = '' }) => {
          const inp = el('input', {
            class: 'input sm', type: 'number', min, max, step,
            value: fin[key] ?? '', style: { width: '80px' },
          });
          const commit = async () => {
            const v = Number(inp.value);
            if (!Number.isFinite(v) || v < min || v > max) { inp.value = fin[key] ?? ''; return toast(`${label} must be between ${min} and ${max}`, 'err'); }
            if (await save({ finance: { [key]: v } })) fin[key] = v;
          };
          inp.addEventListener('change', commit);
          return row(label, sub, el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
            inp, suffix ? el('span', { class: 'set-sub' }, suffix) : null));
        };

        ui.panel.append(
          numRow('ocrMinConfidence', 'Read it again below', 'A photo the model could not make anything of is turned and tried again until it scores at least this. A reading it clearly managed is never re-read — the same picture at the same settings gives the same answer, so a second look would only cost you the wait.', { min: 0, max: 100, step: 5, suffix: '/ 100' }),
          numRow('ocrMaxAttempts', 'Most passes per photo', 'The ceiling on that. Each pass is roughly fifteen seconds of GPU.', { min: 1, max: 3, suffix: 'passes' }),
          numRow('ocrTiles', 'Bands for a long receipt', 'A till receipt several times taller than it is wide gets downscaled before the model reads it, and the product names are the first thing to go. Above 1, a long one is read in this many overlapping horizontal bands and stitched back together, so the small print is read at its own size. Costs one pass per band; set 1 to read every photo whole.', { min: 0, max: 4, suffix: 'bands' }));

        // --- currency ---
        ui.panel.append(el('h2', { style: { marginTop: '22px' } }, 'Currency'),
          el('div', { class: 'desc' },
            'Every total is converted into the base currency when it is written, so a mixed-currency month adds up correctly. Changing a rate affects future entries only — past ones keep the rate they were recorded at.'));

        const baseIn = el('input', { class: 'input', value: fin.baseCurrency || 'JPY', maxlength: 3, style: { width: '90px', textTransform: 'uppercase' } });
        ui.panel.append(row('Base currency', 'The currency the app thinks in.',
          el('div', { class: 'row', style: { gap: '8px' } }, baseIn,
            el('button', {
              class: 'btn sm primary',
              onclick: async () => {
                const v = baseIn.value.trim().toUpperCase();
                if (!/^[A-Z]{3}$/.test(v)) return toast('Use a three-letter code like JPY', 'err');
                if (await save({ finance: { baseCurrency: v } }, 'base currency set')) renderPanel();
              },
            }, 'Set'))));

        const ratesBox = el('div', { class: 'set-block' }, el('div', { class: 'set-sub' }, 'loading rates…'));
        ui.panel.append(ratesBox);
        (async () => {
          try {
            const s = await get('/finance/settings');
            ratesBox.innerHTML = '';
            ratesBox.append(
              el('div', { class: 'set-name' }, `Exchange rates (units of ${s.base} per 1)`),
              el('div', { class: 'set-sub' }, 'These start from a built-in table and are approximate. Correct any you actually use.'));
            const inputs = {};
            const grid = el('div', { class: 'fin-rate-grid' });
            for (const code of s.codes) {
              if (code === s.base) continue;
              const inp = el('input', { class: 'input sm', type: 'number', step: 'any', value: s.rates[code] });
              inputs[code] = inp;
              grid.append(el('label', { class: 'fin-rate' }, el('span', {}, code), inp));
            }
            ratesBox.append(grid, el('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } },
              el('button', {
                class: 'btn sm primary',
                onclick: async () => {
                  const rates = {};
                  for (const [code, inp] of Object.entries(inputs)) {
                    const v = Number(inp.value);
                    if (Number.isFinite(v) && v > 0) rates[code] = v;
                  }
                  await save({ finance: { rates } }, 'rates saved');
                },
              }, 'Save rates'),
              el('button', {
                class: 'btn sm', onclick: async () => {
                  const code = (await askText({ title: 'Add a currency', placeholder: 'e.g. KRW', ok: 'Add' }) || '').trim().toUpperCase();
                  if (!/^[A-Z]{3}$/.test(code)) return;
                  await save({ finance: { rates: { [code]: 1 } } }, `${code} added — set its rate`);
                  renderPanel();
                },
              }, icon('plus'), 'Add currency')));
          } catch (e) {
            ratesBox.innerHTML = '';
            ratesBox.append(el('div', { class: 'set-sub' }, `could not load rates: ${e.message}`));
          }
        })();
      }

      if (S.tab === 'voice') { await renderVoice(c); }

      if (S.tab === 'agent') {
        ui.panel.append(el('h2', {}, 'Agent defaults'), el('div', { class: 'desc' }, 'How new agent sessions behave. Each session can override these.'));
        const modeSeg = el('div', { class: 'seg' }, ...[['read', 'Read-only'], ['edits', 'Approve edits'], ['auto', 'Full auto']].map(([v, label]) =>
          el('button', {
            class: 'seg-btn' + (c.defaults.agentMode === v ? ' on' : ''),
            onclick: async () => { await save({ defaults: { agentMode: v } }); renderPanel(); },
          }, label)));
        ui.panel.append(row('Default approval mode', '"Approve edits" asks before writes and commands', modeSeg));

        const turns = el('input', { class: 'input', type: 'number', value: c.agent.maxTurns, min: 4, max: 200, style: { width: '90px' } });
        turns.addEventListener('change', () => save({ agent: { maxTurns: Math.max(4, Math.min(200, +turns.value || 40)) } }));
        ui.panel.append(row('Max turns per request', 'Tool-use loop budget before the agent pauses', turns));

        const tmo = el('input', { class: 'input', type: 'number', value: c.agent.bashTimeoutMs / 1000, min: 5, max: 300, style: { width: '90px' } });
        tmo.addEventListener('change', () => save({ agent: { bashTimeoutMs: Math.max(5, Math.min(300, +tmo.value || 60)) * 1000 } }));
        ui.panel.append(row('Command timeout (s)', 'Default kill timer for bash tool calls', tmo));

        const ctxTok = el('input', { class: 'input', type: 'number', value: c.defaults.contextTokens ?? 32000, min: 4000, max: 200000, step: 1000, style: { width: '110px' } });
        ctxTok.addEventListener('change', () => save({ defaults: { contextTokens: Math.max(4000, Math.min(200000, +ctxTok.value || 32000)) } }));
        ui.panel.append(row('Context window (tokens)', 'Your local model\'s context size — AIOS keeps chat + agent prompts under it (reserving room for the reply) so long sessions never overflow. Anthropic uses its own large window.', ctxTok));

        const scSeg = el('div', { class: 'seg' }, ...[['off', 'Off'], ['syntax', 'Syntax gate'], ['review', 'Gate + review']].map(([v, label]) =>
          el('button', {
            class: 'seg-btn' + ((c.agent.selfCheck || 'review') === v ? ' on' : ''),
            onclick: async () => { await save({ agent: { selfCheck: v } }); renderPanel(); },
          }, label)));
        ui.panel.append(row('Code self-check', 'Syntax-checks every file the agent writes; "review" also re-checks when it finishes and bounces failures back until clean — strong guardrail for small local models', scSeg));

        if ((c.agent.selfCheck || 'review') === 'review') {
          const rounds = el('input', { class: 'input', type: 'number', value: c.agent.maxFixRounds ?? 2, min: 1, max: 5, style: { width: '90px' } });
          rounds.addEventListener('change', () => save({ agent: { maxFixRounds: Math.max(1, Math.min(5, +rounds.value || 2)) } }));
          ui.panel.append(row('Max auto-fix rounds', 'How many times the review may send problems back per request', rounds));
        }

        ui.panel.append(row('Run project tests', 'After a clean self-check, runs the project\'s own test command (package.json test script, pytest, Makefile, cargo, go — or a "verify: <cmd>" line in .aios/instructions.md) and sends failures back to the agent',
          switchBtn(c.agent.runTests !== 'off', async (v) => { await save({ agent: { runTests: v ? 'review' : 'off' } }); renderPanel(); })));

        ui.panel.append(row('Life context in chat & agent', 'Injects a live brief of your planner (events, birthdays, tasks), important mail, and weather into every chat/agent message — so "what\'s going on tomorrow?" just works',
          switchBtn(c.defaults.appContext !== false, async (v) => { await save({ defaults: { appContext: v } }); renderPanel(); })));

        ui.panel.append(row('Coding playbooks', 'Injects best-practice guides (skills/*.md) matched to the project\'s stack into the agent prompt; the rest stay available via the skill tool',
          switchBtn(c.agent.skills !== false, async (v) => { await save({ agent: { skills: v } }); renderPanel(); })));

        ui.panel.append(row('Project memory', 'The agent keeps persistent notes in <project>/.aios/memory/ — recalled at session start, updated at the end of substantial runs, with lessons learned from its own mistakes',
          switchBtn(c.agent.memory !== false, async (v) => { await save({ agent: { memory: v } }); renderPanel(); })));
      }

      if (S.tab === 'network') {
        ui.panel.append(el('h2', {}, 'Network & Security'), el('div', { class: 'desc' }, 'AIOS binds to your LAN so every machine in the house can use it.'));

        let statusData = state.status;
        try { statusData = await get('/status'); } catch { }
        const urls = statusData?.urls || [];
        ui.panel.append(row('Addresses', 'Open these from other machines on your network',
          el('div', { class: 'col', style: { alignItems: 'flex-end' } }, ...urls.map(u => el('code', { class: 'mono small' }, u)))));

        const authSeg = el('div', { class: 'seg' }, ...[['never', 'Open'], ['lan', 'Token for LAN'], ['always', 'Token always']].map(([v, label]) =>
          el('button', {
            class: 'seg-btn' + (c.auth.required === v ? ' on' : ''),
            onclick: async () => { await save({ auth: { required: v } }); renderPanel(); },
          }, label)));
        ui.panel.append(row('Access control', 'Localhost is always allowed in "Token for LAN" mode', authSeg));

        const revealBtn = el('button', {
          class: 'btn sm', onclick: async () => {
            try {
              const t = await get('/config/token');
              revealBtn.replaceWith(el('div', { class: 'col', style: { alignItems: 'flex-end' } },
                el('code', { class: 'mono small' }, t.token),
                ...(t.urls || []).slice(1).map(u => el('code', { class: 'mono small', style: { userSelect: 'all' } }, u))));
            } catch (e) { toast('token is only revealed on localhost', 'err'); }
          },
        }, icon('key'), 'Reveal pairing token');
        ui.panel.append(row('Pairing token', 'Share with your other devices (or use the LAN link with ?token=…)', revealBtn));

        ui.panel.append(row('Rotate token', 'Invalidates all paired devices', el('button', {
          class: 'btn sm danger', onclick: async () => {
            if (!await confirmBox('Rotate pairing token?', 'Other devices will need the new token.', 'Rotate')) return;
            await save({ auth: { regenerateToken: true } }, 'token rotated');
            renderPanel();
          },
        }, 'Rotate')));
      }

      if (S.tab === 'profile') {
        ui.panel.append(el('h2', {}, 'Profile'), el('div', { class: 'desc' }, 'Used in greetings and agent context.'));
        const name = el('input', { class: 'input', value: c.user.name, style: { width: '200px' } });
        name.addEventListener('change', () => save({ user: { name: name.value.trim() } }));
        ui.panel.append(row('Display name', 'What AIOS calls you', name));

        const root = el('input', { class: 'input', value: c.projectsRoot, style: { width: '280px' } });
        root.addEventListener('change', () => save({ projectsRoot: root.value.trim() }));
        ui.panel.append(row('Projects root', 'New projects are created inside this folder', root));

        const email = el('input', { class: 'input', value: c.user.email || '', placeholder: 'you@example.com', style: { width: '200px' } });
        email.addEventListener('change', () => save({ user: { email: email.value.trim() } }));
        ui.panel.append(row('Email', 'Used as the git commit identity when a repo has none set', email));

        // ---- home location (default origin for directions / nearby places) ----
        ui.panel.append(el('div', { class: 'lbl', style: { marginTop: '18px' } }, 'HOME'));
        const home = c.user?.home || {};
        const hplace = el('input', { class: 'input', placeholder: 'address or place, e.g. Takatsuki', style: { width: '190px' } });
        const hresults = el('div', { class: 'col', style: { gap: '4px' } });
        const hfind = el('button', {
          class: 'btn sm', onclick: async () => {
            const q = hplace.value.trim();
            if (!q) return;
            hfind.disabled = true;
            hresults.innerHTML = '';
            try {
              const hits = await get('/weather/geocode?q=' + encodeURIComponent(q));
              if (!hits.length) hresults.append(el('div', { class: 'muted small' }, 'no places found — try another spelling'));
              for (const hit of hits) hresults.append(el('button', {
                class: 'btn sm ghost', style: { justifyContent: 'flex-start' },
                onclick: async () => {
                  const label = hit.name + (hit.detail ? `, ${hit.detail.split(',')[0]}` : '');
                  if (await save({ user: { home: { lat: hit.lat, lon: hit.lon, place: label } } }, 'home saved')) { hresults.innerHTML = ''; renderPanel(); }
                },
              }, `${hit.name} — ${hit.detail}`));
            } catch (e) { toast(e.message, 'err'); }
            hfind.disabled = false;
          },
        }, icon('search'), 'Find');
        hplace.addEventListener('keydown', (e) => { if (e.key === 'Enter') hfind.click(); });
        ui.panel.append(row('Home location',
          home.place ? `"my house" resolves to ${home.place}` : 'Default origin for directions and reference point for nearby-place searches. Falls back to your weather location below.',
          el('div', { class: 'col', style: { gap: '6px' } }, el('div', { class: 'row' }, hplace, hfind), hresults)));

        // ---- weather location (Home widget) ----
        ui.panel.append(el('div', { class: 'lbl', style: { marginTop: '18px' } }, 'WEATHER'));
        const w = c.weather || {};
        const place = el('input', { class: 'input', placeholder: 'city, e.g. Tokyo', style: { width: '190px' } });
        const results = el('div', { class: 'col', style: { gap: '4px' } });
        const find = el('button', {
          class: 'btn sm', onclick: async () => {
            const q = place.value.trim();
            if (!q) return;
            find.disabled = true;
            results.innerHTML = '';
            try {
              const hits = await get('/weather/geocode?q=' + encodeURIComponent(q));
              if (!hits.length) results.append(el('div', { class: 'muted small' }, 'no places found — try another spelling'));
              for (const hit of hits) results.append(el('button', {
                class: 'btn sm ghost', style: { justifyContent: 'flex-start' },
                onclick: async () => {
                  const label = hit.name + (hit.detail ? `, ${hit.detail.split(',')[0]}` : '');
                  if (await save({ weather: { lat: hit.lat, lon: hit.lon, place: label } }, 'location saved')) { results.innerHTML = ''; renderPanel(); }
                },
              }, `${hit.name} — ${hit.detail}`));
            } catch (e) { toast(e.message, 'err'); }
            find.disabled = false;
          },
        }, icon('search'), 'Find');
        place.addEventListener('keydown', (e) => { if (e.key === 'Enter') find.click(); });
        ui.panel.append(row('Location',
          w.place ? `The Home weather widget shows ${w.place}` : 'Powers the weather widget on Home (Open-Meteo — free, no key)',
          el('div', { class: 'col', style: { gap: '6px' } }, el('div', { class: 'row' }, place, find), results)));

        const unitSeg = el('div', { class: 'seg' }, ...[['c', '°C'], ['f', '°F']].map(([v, l]) => el('button', {
          class: 'seg-btn' + ((w.units || 'c') === v ? ' on' : ''),
          onclick: async () => { if (await save({ weather: { units: v } })) renderPanel(); },
        }, l)));
        ui.panel.append(row('Units', null, unitSeg));
      }

      if (S.tab === 'about') {
        let s = state.status;
        try { s = await get('/status'); } catch { }
        ui.panel.append(el('h2', {}, 'About AIOS'), el('div', { class: 'desc' }, 'Your personal AI operating hub.'));
        const kv = (k, v) => row(k, null, el('span', { class: 'mono small' }, String(v ?? '—')));
        ui.panel.append(
          kv('Version', s?.version),
          kv('Host', s?.host),
          kv('Platform', s?.platform),
          kv('Node', s?.node),
          kv('Uptime', s ? Math.floor(s.uptime / 60) + ' min' : '—'),
          kv('Data directory', s?.dataDir),
        );
        ui.panel.append(el('div', { class: 'muted small', style: { marginTop: '16px', lineHeight: 1.6 } },
          'Tip: AIOS is registered as a project in its own hub — point the Agent at "OS" and it can improve itself.'));
      }
    }

    renderNav();
    renderPanel();
    this.reopen = (w, o) => { if (o?.tab) { S.tab = o.tab; renderNav(); renderPanel(); } };
  },
};
