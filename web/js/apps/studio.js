// Studio v3: a generation cockpit for the local ComfyUI with selectable
// workflows — txt2img, img2img (remix a source at a chosen denoise), and pure
// ESRGAN upscale. Inputs live on the LEFT; the render lands big on the RIGHT
// with a history strip. AIOS handles the 8GB VRAM dance (LLM ⇄ tiny swap) and
// even boots ComfyUI itself when it's down. Node-graph surgery (LoRA stacks,
// ControlNet…) stays in ComfyUI proper via the ↗ link.

import { el, icon, toast, confirmBox } from '../ui.js';
import { get, post, sub, mediaUrl, uploadFile } from '../api.js';
import { state } from '../state.js';

const KINDS = [['txt2img', 'Text → Image'], ['img2img', 'Image → Image'], ['upscale', 'Upscale']];

const SIZES = [['1024x1024', 'square 1024'], ['896x1152', 'portrait 896×1152'], ['1152x896', 'landscape 1152×896'], ['768x768', 'square 768 (fast)']];

// Style presets — Animagine's official guidance: subject tags first, QUALITY TAGS AT THE END.
const STYLES = {
  anime: {
    label: 'anime', pre: '', post: ', anime key visual, clean lineart, cel shading, vibrant colors, masterpiece, high score, great score, absurdres',
    neg: 'photorealistic, photo, 3d render, realistic, live action, ',
  },
  none: { label: 'no style', pre: '', post: '', neg: '' },
  painterly: { label: 'painterly', pre: '', post: ', digital painting, expressive brush strokes, rich lighting, masterpiece, best quality', neg: 'photo, flat colors, ' },
  photo: { label: 'photo', pre: '', post: ', professional photograph, natural lighting, sharp focus, 50mm', neg: 'illustration, anime, painting, cartoon, ' },
};

// Positive starters — picked to teach the tag order (subject → details → scene).
const POS_TEMPLATES = {
  '': 'prompt template…',
  portrait: '1girl, solo, looking at viewer, upper body, detailed eyes, gentle smile, soft lighting',
  landscape: 'no humans, scenery, wide shot, mountains, dramatic clouds, god rays, highly detailed background',
  chibi: '1girl, chibi, full body, simple background, pastel colors, happy',
  'dark fantasy': '1girl, dark fantasy, glowing eyes, flowing cloak, dramatic rim lighting, ruins background, embers',
  'retro 90s': '1girl, retro artstyle, 1990s (style), film grain, city pop, sunset',
  mecha: 'no humans, mecha, giant robot, science fiction, battle damage, dynamic angle, sparks',
  'cozy slice-of-life': '1girl, indoors, cafe, warm lighting, steam, reading, plants, cozy atmosphere',
};

const NEG_TEMPLATES = {
  animagine: 'lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, fewer digits, cropped, worst quality, low quality, low score, bad score, average score, signature, watermark, username, blurry',
  standard: 'blurry, low quality, watermark, text, extra limbs, bad anatomy',
  strict: 'lowres, bad anatomy, bad hands, missing fingers, extra digits, jpeg artifacts, cropped, worst quality, low quality, signature, watermark, username, blurry, artist name, censored, deformed',
  minimal: 'lowres, worst quality',
};

// Where the ↗ button lands: the LoRA Manager, not the bare node graph.
const COMFY_OPEN_PATH = '/loras';

// ComfyUI binds LAN-wide now, but its configured URL says 127.0.0.1 — rewrite
// to wherever the user is browsing from so the ↗ link works off-machine too.
// `path` picks which UI the link lands on: '/loras' is the LoRA Manager page
// (custom_nodes/comfyui-lora-manager), '/' the stock node graph. Both are
// served by the same :8188 process — the manager links back to the graph.
const comfyHref = (u, path = COMFY_OPEN_PATH) => {
  try {
    const url = new URL(u);
    if (['127.0.0.1', 'localhost', '0.0.0.0'].includes(url.hostname)) url.hostname = location.hostname;
    url.pathname = path;
    return url.href;
  } catch { return u; }
};

export default {
  id: 'studio', title: 'Studio', icon: 'image', width: 1240, height: 760,

  mount(body, opts, win) {
    const S = win.studioState = { status: null, checkpoints: [], upscalers: [], jobs: [], unsub: null, busy: false, hero: null, kind: 'txt2img', source: null };
    const ui = {};
    body.classList.add('col');

    // ---------- header: status + server lifecycle ----------
    ui.comfyChip = el('span', { class: 'chip' }, '…');
    ui.llmChip = el('button', { class: 'btn sm ghost git-chip', title: 'Toggle Studio mode (tiny CPU LLM ⇄ big GPU LLM)', onclick: () => toggleStudio() });
    ui.startBtn = el('button', { class: 'btn sm primary', style: { display: 'none' }, title: 'Start the ComfyUI server (AIOS-managed)', onclick: () => serverAction('start') }, icon('play'), 'Start ComfyUI');
    ui.freeBtn = el('button', { class: 'btn sm ghost', style: { display: 'none' }, title: 'Unload models / free VRAM without stopping ComfyUI', onclick: () => serverAction('free') }, 'Free VRAM');
    ui.stopBtn = el('button', { class: 'btn sm ghost danger', style: { display: 'none' }, title: 'Stop the ComfyUI server', onclick: () => serverAction('stop') }, icon('stop'), 'Stop');
    ui.head = el('div', { class: 'pane-head' },
      el('span', { class: 'ttl row', style: { gap: '7px' } }, icon('image'), 'Studio'),
      ui.comfyChip, ui.llmChip,
      el('span', { class: 'grow' }),
      ui.startBtn, ui.freeBtn, ui.stopBtn,
      el('button', { class: 'btn sm ghost', title: 'Refresh', onclick: () => refresh() }, icon('refresh')),
      ui.openComfy = el('a', { class: 'btn sm ghost', href: '#', target: '_blank', rel: 'noreferrer', title: 'Open ComfyUI in LoRA Manager mode (the node graph is one click away, in its menu)' }, 'ComfyUI ', icon('external')));

    async function serverAction(kind) {
      const btn = kind === 'start' ? ui.startBtn : kind === 'stop' ? ui.stopBtn : ui.freeBtn;
      if (kind === 'stop' && !await confirmBox('Stop ComfyUI?', 'Running generations are killed.', 'Stop')) return;
      const prev = btn.innerHTML;
      btn.disabled = true; btn.innerHTML = ''; btn.append(el('span', { class: 'spinner' }), kind === 'start' ? ' starting…' : '');
      try {
        const r = await post('/comfy/' + kind, {});
        toast(kind === 'start' ? `ComfyUI up (${((r.ms || 0) / 1000).toFixed(0)}s)` : kind === 'stop' ? 'ComfyUI stopped' : `VRAM freed — ${r.gpu?.freeMB ?? '?'}MB free`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
      btn.disabled = false; btn.innerHTML = prev;
      refresh();
    }

    async function toggleStudio() {
      const llm = S.status?.llm || {};
      const goingOn = llm.profile !== 'tiny';
      const what = goingOn
        ? 'Switch llama.cpp to the tiny CPU model? Chat/agent get slower but the whole GPU frees up for rendering.'
        : 'Switch back to the big GPU model? ComfyUI unloads first; the big model takes a minute to load.';
      if (!await confirmBox('Studio mode', what, goingOn ? 'Free the GPU' : 'Back to big', 'primary')) return;
      ui.llmChip.disabled = true;
      ui.llmChip.innerHTML = '';
      ui.llmChip.append(el('span', { class: 'spinner' }));
      try {
        await post('/comfy/studio', { on: goingOn });
        toast(goingOn ? 'tiny CPU model live — GPU is free' : 'big model back', 'ok');
      } catch (e) { toast(e.message, 'err'); }
      ui.llmChip.disabled = false;
      refresh();
    }

    // ---------- left column: inputs ----------
    ui.ckpt = el('select', { class: 'input select', onchange: () => paintPlan() });
    ui.speed = el('select', { class: 'input select', title: 'Quality uses the finetune\'s own sampling; Lightning LoRA is much faster but can shred complex backgrounds on finetunes', onchange: () => paintPlan() },
      ...[['quality', 'quality'], ['lora8', '⚡ fast (8-step LoRA)'], ['lora4', '⚡ fastest (4-step LoRA)']].map(([v, l]) => el('option', { value: v }, l)));
    ui.plan = el('div', { class: 'studio-plan muted small' }, '…');
    const speedArgs = () => ({ steps: ui.speed.value === 'lora4' ? 4 : 8, accel: ui.speed.value.startsWith('lora') ? 'lora' : 'quality' });

    ui.style = el('select', { class: 'input select', title: 'Style preset — wraps your prompt' },
      ...Object.entries(STYLES).map(([v, s]) => el('option', { value: v }, s.label)));
    ui.posTmpl = el('select', {
      class: 'input select', title: 'Insert a starter prompt',
      onchange: () => {
        const t = POS_TEMPLATES[ui.posTmpl.value];
        if (!t || !ui.posTmpl.value) return;
        ui.prompt.value = ui.prompt.value.trim() ? ui.prompt.value.replace(/,?\s*$/, ', ') + t : t;
        ui.posTmpl.value = '';
        ui.prompt.focus();
      },
    }, ...Object.entries(POS_TEMPLATES).map(([v, t]) => el('option', { value: v }, v || t)));

    ui.prompt = el('textarea', { class: 'input', rows: 4, placeholder: 'Tags or plain words… (tag order: subject → details → scene; quality tags are added by the style)' });

    ui.idea = el('input', { class: 'input', placeholder: 'or describe an idea: "shy witch, rainy rooftop, neon"…', style: { flex: '1' } });
    ui.expand = el('button', { class: 'btn sm', title: 'Let the LLM turn the idea into a full tag prompt + negative', onclick: () => expandIdea() }, icon('sparkle'), 'Generate prompt');
    ui.idea.addEventListener('keydown', (e) => { if (e.key === 'Enter') expandIdea(); });

    ui.negTmpl = el('select', {
      class: 'input select sm', title: 'Negative prompt template',
      onchange: () => { if (NEG_TEMPLATES[ui.negTmpl.value]) ui.negative.value = NEG_TEMPLATES[ui.negTmpl.value]; },
    }, ...Object.keys(NEG_TEMPLATES).map(k => el('option', { value: k }, 'negative: ' + k)));
    ui.negative = el('textarea', { class: 'input', rows: 2 });
    ui.negative.value = NEG_TEMPLATES.animagine;

    ui.size = el('select', { class: 'input select' }, ...SIZES.map(([v, l]) => el('option', { value: v }, l)));
    ui.count = el('select', { class: 'input select' }, ...[1, 2, 4].map(n => el('option', { value: String(n) }, n + ' image' + (n > 1 ? 's' : ''))));
    ui.seed = el('input', { class: 'input', placeholder: 'seed (blank = random)', style: { width: '140px' } });
    ui.hires = el('input', { type: 'checkbox' });
    ui.go = el('button', { class: 'btn primary', style: { width: '100%' }, onclick: () => generate() }, icon('sparkle'), 'Generate');
    ui.progress = el('div', { class: 'studio-progress', style: { display: 'none' } },
      ui.progressBar = el('div', { class: 'studio-progress-bar' }),
      ui.progressText = el('span', { class: 'muted small' }, ''));

    // ----- workflow selector + the img2img / upscale extras -----
    ui.kindSeg = el('div', { class: 'seg studio-kind' }, ...KINDS.map(([v, l]) =>
      el('button', { class: 'seg-btn' + (v === S.kind ? ' on' : ''), dataset: { kind: v }, onclick: () => setKind(v) }, l)));

    ui.srcImg = el('img', { class: 'studio-src-img', style: { display: 'none' } });
    ui.srcEmpty = el('span', { class: 'muted small' }, 'no source yet');
    ui.srcUse = el('button', { class: 'btn sm', title: 'Use the render shown on the right as the source', onclick: () => useHeroAsSource() }, 'Use render →');
    ui.srcFile = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, onchange: () => uploadSource() });
    ui.srcUpload = el('button', { class: 'btn sm ghost', onclick: () => ui.srcFile.click() }, icon('paperclip'), 'Upload…');
    ui.srcClear = el('button', { class: 'btn sm ghost', title: 'Clear source', onclick: () => setSource(null) }, icon('x'));

    ui.denoise = el('input', { type: 'range', min: '20', max: '90', step: '5', value: '55', style: { flex: '1' }, oninput: () => paintDenoise() });
    ui.denoiseVal = el('span', { class: 'small', style: { width: '38px', textAlign: 'right' } }, '0.55');

    ui.upModel = el('select', { class: 'input select' });
    ui.scaleSeg = el('div', { class: 'seg' }, ...[['2', '2×'], ['4', '4×']].map(([v, l]) => {
      const b = el('button', { class: 'seg-btn' + (v === '4' ? ' on' : ''), dataset: { scale: v } }, l);
      b.onclick = () => { for (const x of ui.scaleSeg.children) x.classList.toggle('on', x === b); };
      return b;
    }));
    const chosenScale = () => Number([...ui.scaleSeg.children].find(b => b.classList.contains('on'))?.dataset.scale || 4);

    const lbl = (t) => el('div', { class: 'studio-lbl' }, t);
    const sec = ui.sec = {};
    sec.source = el('div', { class: 'col', style: { gap: '7px' } },
      lbl('SOURCE IMAGE'),
      el('div', { class: 'studio-src' },
        el('div', { class: 'studio-src-box' }, ui.srcImg, ui.srcEmpty),
        el('div', { class: 'col', style: { gap: '6px', justifyContent: 'center' } }, ui.srcUse, ui.srcUpload, ui.srcClear)),
      ui.srcFile);
    sec.model = el('div', { class: 'col', style: { gap: '7px' } },
      lbl('MODEL'),
      el('div', { class: 'row', style: { gap: '6px' } }, ui.ckpt, ui.speed),
      ui.plan);
    sec.prompt = el('div', { class: 'col', style: { gap: '7px' } },
      lbl('PROMPT'),
      el('div', { class: 'row', style: { gap: '6px' } }, ui.style, ui.posTmpl),
      ui.prompt,
      el('div', { class: 'row', style: { gap: '6px' } }, ui.idea, ui.expand));
    sec.negative = el('div', { class: 'col', style: { gap: '7px' } },
      lbl('NEGATIVE'),
      ui.negTmpl, ui.negative);
    sec.denoise = el('div', { class: 'col', style: { gap: '7px' } },
      lbl('REMIX STRENGTH'),
      el('div', { class: 'row', style: { gap: '8px' } }, ui.denoise, ui.denoiseVal),
      ui.denoiseHint = el('div', { class: 'muted small', style: { padding: '0 2px' } }, ''));
    sec.upscale = el('div', { class: 'col', style: { gap: '7px' } },
      lbl('UPSCALER'),
      el('div', { class: 'row', style: { gap: '6px' } }, ui.upModel, ui.scaleSeg),
      el('div', { class: 'muted small', style: { padding: '0 2px' } }, 'pixel-space ESRGAN — no prompt needed, seconds per image'));
    sec.output = el('div', { class: 'col', style: { gap: '7px' } },
      lbl('OUTPUT'),
      el('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, ui.size, ui.count, ui.seed),
      ui.hiresRow = el('label', { class: 'row small muted', style: { gap: '6px', padding: '2px 0' } }, ui.hires, 'hi-res 2-pass (×1.45 — sharper detail, ~2× time)'));

    ui.left = el('div', { class: 'studio-left' },
      ui.kindSeg,
      sec.source, sec.model, sec.prompt, sec.negative, sec.denoise, sec.upscale, sec.output,
      ui.go, ui.progress);

    function setKind(v) {
      S.kind = v;
      for (const b of ui.kindSeg.children) b.classList.toggle('on', b.dataset.kind === v);
      applyKind();
    }
    function applyKind() {
      const k = S.kind;
      sec.source.style.display = k === 'txt2img' ? 'none' : '';
      sec.model.style.display = k === 'upscale' ? 'none' : '';
      sec.prompt.style.display = k === 'upscale' ? 'none' : '';
      sec.negative.style.display = k === 'upscale' ? 'none' : '';
      sec.denoise.style.display = k === 'img2img' ? '' : 'none';
      sec.upscale.style.display = k === 'upscale' ? '' : 'none';
      sec.output.style.display = k === 'upscale' ? 'none' : '';
      ui.hiresRow.style.display = k === 'txt2img' ? '' : 'none';
      ui.go.innerHTML = '';
      ui.go.append(icon('sparkle'), k === 'img2img' ? 'Remix' : k === 'upscale' ? 'Upscale' : 'Generate');
      paintDenoise();
    }
    function paintDenoise() {
      const d = Number(ui.denoise.value) / 100;
      ui.denoiseVal.textContent = d.toFixed(2);
      ui.denoiseHint.textContent = d <= 0.35 ? 'subtle — keeps composition and colors'
        : d <= 0.6 ? 'balanced — restyles while following the source'
        : 'strong — the source becomes a loose reference';
    }

    // ----- source handling -----
    function setSource(ref, url) {
      S.source = ref ? { ref, url } : null;
      ui.srcImg.style.display = S.source ? '' : 'none';
      ui.srcEmpty.style.display = S.source ? 'none' : '';
      if (S.source) ui.srcImg.src = S.source.url;
    }
    function useHeroAsSource() {
      if (!S.hero) { toast('no render selected — generate something first or upload', 'err'); return; }
      setSource(S.hero, mediaUrl('/comfy/image/' + S.hero));
      toast('source set from the current render', 'ok');
    }
    async function uploadSource() {
      const f = ui.srcFile.files?.[0];
      ui.srcFile.value = '';
      if (!f) return;
      try {
        const meta = await uploadFile(f);
        setSource('upload:' + meta.id, mediaUrl('/uploads/' + meta.id));
        toast('source uploaded', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }

    // ---------- right column: output ----------
    ui.heroImg = el('img', { class: 'studio-hero-img', style: { display: 'none' } });
    ui.heroEmpty = el('div', { class: 'empty', style: { minHeight: '200px' } }, 'renders land here');
    ui.heroMeta = el('div', { class: 'studio-hero-meta muted small' });
    ui.hero = el('a', { class: 'studio-hero', href: '#', target: '_blank', rel: 'noreferrer', title: 'Open full size in a new tab' }, ui.heroImg, ui.heroEmpty);
    ui.strip = el('div', { class: 'studio-strip' });
    ui.right = el('div', { class: 'studio-right' }, ui.hero, ui.heroMeta, ui.strip);

    body.append(ui.head, el('div', { class: 'studio-cols' }, ui.left, ui.right));
    ui.prompt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate(); });

    // ---------- data ----------

    async function refresh() {
      try { S.status = await get('/comfy/status'); } catch (e) { S.status = { up: false, error: e.message }; }
      paintStatus();
      if (S.status.up) {
        try { S.checkpoints = await get('/comfy/checkpoints'); } catch { S.checkpoints = []; }
        const prev = ui.ckpt.value;
        ui.ckpt.innerHTML = '';
        for (const c of S.checkpoints) ui.ckpt.append(el('option', { value: c }, c.replace(/\.(safetensors|ckpt)$/, '')));
        if (S.checkpoints.includes(prev)) ui.ckpt.value = prev;
        else { const anime = S.checkpoints.find(c => /animagine|illustrious|noob|pony/i.test(c)); if (anime) ui.ckpt.value = anime; }
        if (!S.checkpoints.length) ui.ckpt.append(el('option', { value: '' }, 'no checkpoints — see comfyui-plan.md'));
        paintPlan();
        try { S.upscalers = await get('/comfy/upscalers'); } catch { S.upscalers = []; }
        const prevUp = ui.upModel.value;
        ui.upModel.innerHTML = '';
        for (const u of S.upscalers) ui.upModel.append(el('option', { value: u }, u.replace(/\.(pth|safetensors)$/, '')));
        if (S.upscalers.includes(prevUp)) ui.upModel.value = prevUp;
        else { const anime = S.upscalers.find(u => /animesharp/i.test(u)); if (anime) ui.upModel.value = anime; }
        if (!S.upscalers.length) ui.upModel.append(el('option', { value: '' }, 'no upscale models installed'));
      }
      try { S.jobs = await get('/comfy/jobs'); } catch { S.jobs = []; }
      paintOutput();
    }

    function paintStatus() {
      const st = S.status || {};
      ui.comfyChip.textContent = st.up ? `comfy up · ${st.vramFreeMB || '?'}MB free` : 'comfy down';
      ui.comfyChip.style.color = st.up ? 'var(--ok)' : 'var(--err)';
      ui.comfyChip.title = st.up ? `${st.url}${st.proc?.managed ? ' (AIOS-managed)' : st.proc?.foreign ? ' (started elsewhere)' : ''}` : 'not running — hit Start (or just Generate: it auto-starts)';
      const llm = st.llm || {};
      ui.llmChip.innerHTML = '';
      ui.llmChip.append(icon('cpu'), llm.running ? ` LLM: ${llm.profile}` : llm.foreign ? ' LLM: unmanaged' : ' LLM: off');
      ui.llmChip.classList.toggle('dirty', llm.profile === 'tiny');
      ui.openComfy.href = comfyHref(st.url || 'http://127.0.0.1:8188');
      ui.startBtn.style.display = st.up ? 'none' : '';
      ui.freeBtn.style.display = st.up ? '' : 'none';
      ui.stopBtn.style.display = st.up ? '' : 'none';
      ui.go.disabled = S.busy;
    }

    // show exactly which workflow the Generate button will run
    async function paintPlan() {
      if (!ui.ckpt.value) { ui.plan.textContent = ''; return; }
      try {
        const sp = speedArgs();
        const p = await get(`/comfy/plan?checkpoint=${encodeURIComponent(ui.ckpt.value)}&steps=${sp.steps}&accel=${sp.accel}`);
        const bits = {
          lightning: `Lightning checkpoint · ${p.steps} steps · cfg ${p.cfg} (fast by nature)`,
          'finetune+lightning-lora': `+ ${p.lora?.replace('.safetensors', '')} · ${p.steps} steps · cfg ${p.cfg} — fast, may glitch busy backgrounds`,
          'standard-sdxl': `native sampling · ${p.steps} steps · cfg ${p.cfg} · euler_a — best quality, ~40s`,
        };
        ui.plan.textContent = '⚙ ' + (bits[p.mode] || `${p.steps} steps · cfg ${p.cfg}`);
      } catch { ui.plan.textContent = ''; }
    }

    // ---------- prompt generator ----------

    async function expandIdea() {
      const idea = ui.idea.value.trim();
      if (!idea) { toast('type an idea first', 'err'); return; }
      const prev = ui.expand.innerHTML;
      ui.expand.disabled = true; ui.expand.innerHTML = ''; ui.expand.append(el('span', { class: 'spinner' }));
      try {
        const r = await post('/comfy/expand', { idea, style: ui.style.value });
        ui.prompt.value = r.prompt;
        if (r.negative) ui.negative.value = r.negative;
        toast('prompt generated — edit freely', 'ok');
      } catch (e) { toast(e.message, 'err'); }
      ui.expand.disabled = false; ui.expand.innerHTML = prev;
    }

    // ---------- generation ----------

    async function generate() {
      const raw = ui.prompt.value.trim();
      if (S.kind !== 'upscale' && !raw) { ui.prompt.focus(); return; }
      if (S.kind !== 'txt2img' && !S.source) { toast('pick a source image first (Use render → or Upload)', 'err'); return; }
      if (S.busy) return;
      const style = STYLES[ui.style.value] || STYLES.none;
      const [width, height] = ui.size.value.split('x').map(Number);
      S.busy = true;
      ui.go.disabled = true;
      ui.progress.style.display = '';
      setProgress(0, 1, S.status?.up ? 'submitting…' : 'booting ComfyUI…');
      const payload = S.kind === 'upscale'
        ? { kind: 'upscale', sourceImage: S.source.ref, upscaleModel: ui.upModel.value || undefined, scale: chosenScale() }
        : {
          kind: S.kind,
          prompt: (style.pre + raw).replace(/,\s*$/, '') + style.post,
          negative: style.neg + ui.negative.value.trim(),
          checkpoint: ui.ckpt.value, width, height,
          ...speedArgs(), count: Number(ui.count.value),
          seed: ui.seed.value.trim() ? Number(ui.seed.value) : undefined,
          ...(S.kind === 'img2img'
            ? { sourceImage: S.source.ref, denoise: Number(ui.denoise.value) / 100 }
            : { hires: ui.hires.checked }),
        };
      let job;
      try {
        job = await post('/comfy/generate', payload);
      } catch (e) {
        toast(e.message, 'err');
        S.busy = false; ui.go.disabled = false; ui.progress.style.display = 'none';
        refresh();
        return;
      }
      S.unsub?.();
      S.unsub = sub('comfy:' + job.id, ({ ev }) => {
        if (ev.type === 'status') setProgress(0, 1, ev.status.replace(/-/g, ' ') + (ev.detail ? ` — ${ev.detail}` : ''));
        else if (ev.type === 'progress') setProgress(ev.value, ev.max, `step ${ev.value}/${ev.max}`);
        else if (ev.type === 'done') {
          setProgress(1, 1, 'done');
          S.hero = ev.images?.[0] || null;
          finish();
          toast(`${ev.images.length} image${ev.images.length > 1 ? 's' : ''} ready`, 'ok');
        } else if (ev.type === 'error') { finish(); toast(ev.message, 'err'); }
      });
      function finish() {
        S.unsub?.(); S.unsub = null;
        S.busy = false; ui.go.disabled = false;
        setTimeout(() => { ui.progress.style.display = 'none'; }, 1200);
        refresh();
      }
    }

    function setProgress(v, max, text) {
      ui.progressBar.style.width = Math.round((v / Math.max(max, 1)) * 100) + '%';
      ui.progressText.textContent = text;
    }

    // ---------- output pane ----------

    function jobOf(name) { return S.jobs.find(j => j.images?.includes(name)); }

    function setHero(name) {
      S.hero = name;
      if (!name) {
        ui.heroImg.style.display = 'none';
        ui.heroEmpty.style.display = '';
        ui.heroMeta.textContent = '';
        ui.hero.removeAttribute('href');
        return;
      }
      ui.heroImg.src = mediaUrl('/comfy/image/' + name);
      ui.heroImg.style.display = '';
      ui.heroEmpty.style.display = 'none';
      ui.hero.href = mediaUrl('/comfy/image/' + name);
      const j = jobOf(name);
      const kindBit = j?.kind === 'img2img' ? ` · img2img d${j.denoise}` : j?.kind === 'upscale' ? ` · upscale ${j.scale || 4}×` : '';
      ui.heroMeta.textContent = j
        ? (j.kind === 'upscale'
          ? `upscaled ${j.sourceImage || ''}${kindBit} · ${(j.upscaleModel || '').replace(/\.(pth|safetensors)$/, '')}`
          : `${j.prompt.slice(0, 110)}${j.prompt.length > 110 ? '…' : ''}  ·  seed ${j.seed} · ${j.steps} steps · ${j.width}×${j.height}${j.hires ? ' · hi-res' : ''}${j.lora ? ' · +lightning-lora' : ''}${kindBit}`)
        : '';
      for (const t of ui.strip.children) t.classList.toggle('on', t.dataset.name === name);
    }

    function paintOutput() {
      ui.strip.innerHTML = '';
      const images = S.jobs.filter(j => j.images?.length).flatMap(j => j.images);
      for (const name of images.slice(0, 60)) {
        ui.strip.append(el('button', {
          class: 'studio-thumb-sm', dataset: { name },
          title: jobOf(name)?.prompt.slice(0, 160) || name,
          onclick: () => setHero(name),
        }, el('img', { src: mediaUrl('/comfy/image/' + name), loading: 'lazy' })));
      }
      if (!images.length) ui.strip.append(el('div', { class: 'muted small', style: { padding: '6px' } },
        S.status?.up ? 'no renders yet' : 'ComfyUI is down — Generate will boot it automatically'));
      setHero(S.hero && images.includes(S.hero) ? S.hero : images[0] || null);
    }

    applyKind();
    refresh();
  },

  unmount(win) { win.studioState?.unsub?.(); },
};
