// Settings: profile, appearance, providers, tools, vault, agent defaults, network & security.

import { el, icon, toast, askText, confirmBox, modal, fetchModels } from '../ui.js';
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
        ui.panel.append(el('div', { class: 'lbl', style: { marginTop: '18px' } }, 'OPENAI-COMPATIBLE PROVIDERS & GATEWAYS (Agnes AI, OpenRouter, Groq, LM Studio, vLLM, llama.cpp…)'));
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
              { label: 'Agnes AI', name: 'Agnes AI', baseUrl: 'https://apihub.agnes-ai.com/v1', models: 'agnes-2.0-flash' },
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
            const modelsIn = el('input', { class: 'input', placeholder: 'agnes-2.0-flash, … (optional)', style: { width: '100%' } });
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
              fld('Models', modelsIn, 'Comma-separated. Needed only when the endpoint has no /models list (e.g. Agnes AI); otherwise leave blank to auto-discover.'));
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

        // the tool belt
        const groups = [['files', 'FILES'], ['git', 'GIT'], ['system', 'SYSTEM'], ['web', 'WEB'], ['maps', 'MAPS & LOCAL'], ['utility', 'EVERYDAY UTILITIES'], ['vault', 'KNOWLEDGE BASE'], ['apps', 'AIOS APPS'], ['mail', 'MAIL'], ['custom', 'AI-FORGED TOOLS']];
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
