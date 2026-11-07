// Money — the ledger, phone-shaped.
//
// Four views behind one segmented control, in the order the errands actually happen:
//   Main      where you stand — the numbers, stacked and large enough to read at a glance
//   Log       put something in, templates first
//   Recent    what went in
//   Capture   photograph a receipt (the original /m screen, mounted whole)
//
// Log leads with TEMPLATES rather than a blank form, because the blank form is the
// slow path: a stream of income whose payer, category and currency never change and
// whose figure always does is one tap plus one number, and typing the other four
// fields every time is how a ledger stops being kept. The backend already models all
// three template shapes (fixed, hourly rate, open amount) — see finance.logPreset.

import { get, post, patch, del } from '../../api.js';
import { el, fill, icon, toast, sheet, confirmSheet, ICONS, money, compactMoney, relTime, dayLabel, loading, empty, errorBox, pullToRefresh, buzz } from '../ui.js';
import { mount as mountCapture } from '../receipts.js';

const VIEWS = [
  { id: 'main', label: 'Main' },
  { id: 'log', label: 'Log' },
  { id: 'recent', label: 'Recent' },
  { id: 'capture', label: 'Capture' },
];

// What a rate is quoted per. 'flat' is a plain amount with no work attached.
const UNIT_LABEL = { flat: '', hour: '/hr', minute: '/min' };
const UNIT_NOUN = { hour: 'hours', minute: 'minutes' };

export default async function moneyScreen({ host, params, ui }) {
  let view = VIEWS.some(v => v.id === params.view) ? params.view
    : params.capture ? 'capture' : 'main';
  let captureHandle = null;
  let settings = null;          // { base, rates, codes }

  const seg = el('div', { class: 'm-seg' });
  const body = el('div', { class: 'm-viewhost' });
  host.append(seg, body);
  ui.setTitle('Money');

  const cur = () => settings?.base || 'JPY';

  /** Amount in `currency`, expressed in the base currency for comparison. */
  const toBase = (amount, currency) => {
    const rate = settings?.rates?.[String(currency || '').toUpperCase()];
    return Number(amount || 0) * (Number(rate) || 1);
  };

  function renderSeg() {
    fill(seg, ...VIEWS.map(v => el('button', {
      class: 'm-seg-b' + (view === v.id ? ' is-on' : ''),
      onclick: () => show(v.id),
    }, v.label)));
  }

  function teardown() {
    if (captureHandle) { captureHandle.unmount(); captureHandle = null; }
    fill(body);
  }

  function show(id) {
    if (id === view && body.children.length) return;
    teardown();
    view = id;
    renderSeg();
    ui.setActions();
    ({ main: showMain, log: showLog, recent: showRecent, capture: showCapture }[id] || showMain)();
  }

  async function ensureSettings() {
    if (!settings) settings = await get('/finance/settings').catch(() => ({ base: 'JPY', rates: { JPY: 1 }, codes: ['JPY'] }));
    return settings;
  }

  // ================================================================= MAIN

  async function showMain() {
    const scroll = el('div', { class: 'm-scroll' });
    fill(body, scroll);
    ui.setActions(ui.action('refresh', 'Refresh', () => loadMain(scroll)));
    pullToRefresh(scroll, () => loadMain(scroll));
    await loadMain(scroll);
  }

  async function loadMain(scroll) {
    if (!scroll.querySelector('.m-bignum')) fill(scroll, loading());
    try {
      const ov = await get('/finance/overview');
      settings = ov.settings || settings;
      fill(scroll, ...mainSections(ov));
    } catch (e) {
      fill(scroll, errorBox(e, () => loadMain(scroll)));
    }
  }

  /**
   * Stacked, not tiled. Home already has the three-across row; the point of this
   * screen is to be able to read the figures without squinting, so each one gets a
   * full-width row with the number set large and its context on the line beneath.
   */
  function mainSections(ov) {
    const c = ov.summary?.currency || cur();
    const s = ov.summary || {};
    const out = [];

    const bigRow = (label, value, sub, cls = '') => el('div', { class: 'm-bignum ' + cls },
      el('div', { class: 'm-bignum-l' }, label),
      el('div', { class: 'm-bignum-v' }, value),
      sub ? el('div', { class: 'm-bignum-s' }, sub) : null);

    // ---- this month ----
    const days = s.days || 30;
    const elapsed = Math.min(days, new Date().getDate());
    out.push(el('section', { class: 'm-section' },
      el('h2', { class: 'm-section-title' }, new Date().toLocaleDateString([], { month: 'long', year: 'numeric' })),
      el('div', { class: 'm-bignums' },
        bigRow('Earned', money(s.earned, c),
          s.sideEarned ? `${money(s.sideEarned, c)} of it side work` : null, 'is-in'),
        bigRow('Spent', money(s.spent, c),
          s.avgSpendPerDay ? `${money(Math.round(s.avgSpendPerDay), c)} a day over ${elapsed} days` : null, 'is-out'),
        // savingsRate and the goal pcts arrive from the server ALREADY as percentages
        // (finance.js rounds `x / y * 100`), so scaling them again here read "10000%
        // of what came in" on a month with no spending — caught in a screenshot, not
        // by a test, which is why there is now an assertion for it.
        bigRow('Net', money(s.net, c),
          s.savingsRate != null ? `${Math.round(s.savingsRate)}% of what came in` : null,
          (s.net || 0) < 0 ? 'is-out' : 'is-in')),
    ));

    // ---- goal ----
    const g = ov.goal;
    if (g && (g.minGoal > 0 || g.majorGoal > 0)) {
      const target = g.majorGoal || g.minGoal;
      const pct = Math.max(0, Math.min(1, (g.progress || 0) / (target || 1)));
      out.push(el('section', { class: 'm-section' },
        el('h2', { class: 'm-section-title' }, 'Goal'),
        el('div', { class: 'm-boxcard' },
          el('div', { class: 'm-goal-row' },
            el('span', { class: 'm-goal-now' }, money(g.progress, g.currency || c)),
            el('span', { class: 'm-goal-of' }, `of ${money(target, g.currency || c)}`)),
          bar(pct, pct >= 1 ? 'is-ok' : ''),
          g.minGoal > 0 && g.majorGoal > 0
            ? el('div', { class: 'm-note' }, `Minimum ${money(g.minGoal, g.currency || c)}${g.minPct != null ? ` · ${Math.round(g.minPct)}%` : ''}`)
            : null)));
    }

    // ---- expected income not yet paid ----
    const p = ov.pending;
    if (p?.open?.count) {
      out.push(el('section', { class: 'm-section' },
        el('div', { class: 'm-section-head' },
          el('h2', { class: 'm-section-title' }, 'Expected, not yet paid'),
          el('button', { class: 'm-link', onclick: () => openPending() }, 'Settle')),
        el('div', { class: 'm-boxcard' },
          el('div', { class: 'm-bignum-v is-pending' }, money(p.open.total, p.currency || c)),
          el('div', { class: 'm-note' },
            `${p.open.count} estimate${p.open.count === 1 ? '' : 's'}`
            + (p.groups?.length ? ` · ${p.groups.map(x => x.payer).join(', ')}` : '')),
          el('div', { class: 'm-note m-faint' }, 'Not counted as money until a payout is entered.'))));
    }

    // ---- budgets ----
    if (ov.budgets?.items?.length) {
      out.push(el('section', { class: 'm-section' },
        el('h2', { class: 'm-section-title' }, 'Budgets'),
        el('div', { class: 'm-bars' }, ...ov.budgets.items.slice(0, 8).map(b => {
          const pct = b.limit ? Math.min(1, (b.spent || 0) / b.limit) : 0;
          const over = (b.spent || 0) > (b.limit || 0);
          return el('div', { class: 'm-barrow' },
            el('div', { class: 'm-barrow-top' },
              el('span', { class: 'm-barrow-l' }, b.category),
              el('span', { class: 'm-barrow-v' + (over ? ' is-out' : '') },
                `${compactMoney(b.spent, ov.budgets.currency || c)} / ${compactMoney(b.limit, ov.budgets.currency || c)}`)),
            bar(pct, over ? 'is-over' : ''));
        }))));
    }

    // ---- where it went ----
    if (ov.categories?.items?.length) {
      const top = ov.categories.items.slice(0, 6);
      const max = Math.max(...top.map(i => i.total || 0), 1);
      out.push(el('section', { class: 'm-section' },
        el('h2', { class: 'm-section-title' }, 'Where it went'),
        el('div', { class: 'm-bars' }, ...top.map(i => el('div', { class: 'm-barrow' },
          el('div', { class: 'm-barrow-top' },
            el('span', { class: 'm-barrow-l' }, i.category || i.name || '—'),
            el('span', { class: 'm-barrow-v' }, money(i.total, ov.categories.currency || c))),
          bar((i.total || 0) / max))))));
    }

    // ---- where it came from ----
    if (ov.income?.items?.length) {
      const top = ov.income.items.slice(0, 6);
      const max = Math.max(...top.map(i => i.total || 0), 1);
      out.push(el('section', { class: 'm-section' },
        el('h2', { class: 'm-section-title' }, 'Where it came from'),
        el('div', { class: 'm-bars' }, ...top.map(i => el('div', { class: 'm-barrow' },
          el('div', { class: 'm-barrow-top' },
            el('span', { class: 'm-barrow-l' }, i.category || i.merchant || i.name || '—'),
            el('span', { class: 'm-barrow-v is-in' }, money(i.total, ov.income.currency || c))),
          bar((i.total || 0) / max, 'is-in'))))));
    }

    // ---- year to date ----
    const y = ov.ytd;
    if (y && (y.earned || y.spent)) {
      out.push(el('section', { class: 'm-section' },
        el('h2', { class: 'm-section-title' }, `${y.year} so far`),
        el('div', { class: 'm-boxcard' },
          row('Earned', money(y.earned, y.currency || c), 'is-in'),
          row('Spent', money(y.spent, y.currency || c)),
          row('Net', money(y.net, y.currency || c), (y.net || 0) < 0 ? 'is-out' : 'is-in'),
          y.hours ? row('Hours logged', `${y.hours}h`) : null,
          y.effectiveRate ? row('Effective rate', `${money(Math.round(y.effectiveRate), y.currency || c)}/hr`) : null,
          y.projectedEarned ? row('On track for', money(Math.round(y.projectedEarned), y.currency || c), 'is-faint') : null)));
    }

    // ---- recent ----
    if (ov.recent?.length) {
      out.push(el('section', { class: 'm-section' },
        el('div', { class: 'm-section-head' },
          el('h2', { class: 'm-section-title' }, 'Latest'),
          el('button', { class: 'm-link', onclick: () => show('recent') }, 'All')),
        el('div', { class: 'm-rows' }, ...ov.recent.slice(0, 5).map(txnRow))));
    }

    if (out.length === 1 && !s.earned && !s.spent) {
      out.push(empty('Nothing logged this month', 'Use Log to add something, or Capture to photograph a receipt.'));
    }
    return out;
  }

  const bar = (pct, cls = '') => el('div', { class: 'm-bar' },
    el('div', { class: 'm-bar-fill ' + cls, style: { width: `${Math.max(0, Math.min(1, pct)) * 100}%` } }));

  const row = (k, v, cls = '') => el('div', { class: 'm-boxrow' },
    el('span', { class: 'm-boxrow-l' }, k),
    el('span', { class: 'm-boxrow-v ' + cls }, v));

  // ---- settling estimates ----

  async function openPending() {
    sheet('Expected income', async (sheetBody, close) => {
      fill(sheetBody, loading());
      let list;
      try { list = (await get('/finance/pending')).items || []; }
      catch (e) { return fill(sheetBody, errorBox(e)); }
      const open = list.filter(i => i.status === 'open');
      if (!open.length) return fill(sheetBody, empty('Nothing outstanding'));

      fill(sheetBody,
        el('p', { class: 'm-sheet-text' },
          'These are guesses, and none of them count as money yet. Enter what actually arrived.'),
        el('div', { class: 'm-rows' }, ...open.map(i => el('button', {
          class: 'm-row m-row-tap',
          onclick: () => { close(); settleOne(i); },
        },
          el('div', { class: 'm-grow' },
            el('div', { class: 'm-row-t' }, i.merchant || i.category),
            el('div', { class: 'm-row-m' }, [
              i.note, dayLabel(i.date), i.units && i.unit !== 'item' ? `${i.units}${i.unit === 'hour' ? 'h' : 'm'}` : null,
            ].filter(Boolean).join(' · '))),
          el('div', { class: 'm-row-amt is-pending' }, money(i.amount, i.currency))))));
    });
  }

  function settleOne(item) {
    sheet(`Paid by ${item.merchant || item.category}`, (sheetBody, close) => {
      const amount = el('input', { class: 'm-input m-amount', type: 'number', inputmode: 'decimal', step: 'any' });
      amount.value = item.amount;
      const curSel = currencySelect(item.currency);
      const date = el('input', { class: 'm-input', type: 'date' });
      date.value = new Date().toISOString().slice(0, 10);

      sheetBody.append(
        el('p', { class: 'm-sheet-text' },
          `Estimated ${money(item.amount, item.currency)} on ${dayLabel(item.date)}. What actually arrived?`),
        el('div', { class: 'm-amount-row' }, curSel, amount),
        el('label', { class: 'm-field' }, el('span', { class: 'm-field-l' }, 'Paid on'), date),
        el('div', { class: 'm-actions' },
          el('button', { class: 'm-btn is-ghost is-danger', onclick: async () => {
            if (!await confirmSheet('Write this off?', 'It never arrived, and it stops being expected.', { ok: 'Write off', danger: true })) return;
            try { await post('/finance/pending/void', { ids: [item.id] }); close(); toast('Written off'); show('main'); }
            catch (e) { toast(e.message, 'err'); }
          } }, 'Never came'),
          el('button', { class: 'm-btn is-primary', onclick: async () => {
            try {
              await post('/finance/pending/settle', {
                ids: [item.id], amount: Number(amount.value), currency: curSel.value, date: date.value,
              });
              buzz(); close(); toast('Settled', 'ok'); show('main');
            } catch (e) { toast(e.message, 'err'); }
          } }, 'Log the payment')),
      );
    });
  }

  // ================================================================= LOG

  async function showLog() {
    const scroll = el('div', { class: 'm-scroll' });
    fill(body, scroll, loading());
    ui.setActions(ui.action('plus', 'New template', () => editTemplate(null)));

    let cats, presets;
    try {
      await ensureSettings();
      [cats, presets] = await Promise.all([
        get('/finance/categories'),
        get('/finance/presets').catch(() => []),
      ]);
    } catch (e) { return fill(scroll, errorBox(e, showLog)); }

    fill(scroll,
      templatesSection(presets, cats),
      manualSection(cats),
    );
  }

  /**
   * Templates, first and largest.
   *
   * The shape of the tap depends on what the template already knows, which is the
   * whole reason they are worth having: an hourly rate wants the hours, an open
   * amount wants the figure, and a fixed amount wants nothing at all.
   */
  function templatesSection(presets, cats) {
    const cards = presets.map(p => {
      const rate = p.amount > 0
        ? `${money(p.amount, p.currency)}${UNIT_LABEL[p.payUnit] || ''}`
        : 'amount each time';
      return el('div', { class: 'm-tpl' + (p.kind === 'income' ? ' is-in' : ' is-out') },
        el('button', { class: 'm-tpl-main', onclick: () => useTemplate(p) },
          el('div', { class: 'm-tpl-name' }, p.name),
          el('div', { class: 'm-tpl-meta' }, [
            rate,
            p.category,
            p.isEstimate ? 'estimate' : null,
          ].filter(Boolean).join(' · '))),
        el('button', { class: 'm-tpl-edit', 'aria-label': `Edit ${p.name}`, onclick: () => editTemplate(p, cats) },
          el('span', { html: ICONS.edit })));
    });

    return el('section', { class: 'm-section' },
      el('div', { class: 'm-section-head' },
        el('h2', { class: 'm-section-title' }, 'Templates'),
        el('button', { class: 'm-link', onclick: () => editTemplate(null, cats) }, 'New')),
      cards.length ? el('div', { class: 'm-tpls' }, ...cards)
        : el('div', { class: 'm-boxcard' },
          el('p', { class: 'm-note' },
            'A template remembers the payer, category and currency so logging is one tap and one number. '
            + 'Worth making for anything that repeats.'),
          el('button', { class: 'm-btn is-primary m-full', onclick: () => editTemplate(null, cats) }, 'Make one')),
    );
  }

  /** Log a template — asking only for whatever it does not already know. */
  function useTemplate(p) {
    const hourly = p.payUnit === 'hour' || p.payUnit === 'minute';
    const needsAmount = p.asksAmount;

    // Nothing to ask: a fixed flat amount is a single tap.
    if (!hourly && !needsAmount) {
      return sheet(p.name, (b, close) => {
        const count = el('input', { class: 'm-input m-amount', type: 'number', inputmode: 'numeric', min: '1' });
        count.value = '1';
        b.append(
          el('p', { class: 'm-sheet-text' }, `${money(p.amount, p.currency)} · ${p.category}`),
          el('label', { class: 'm-field' }, el('span', { class: 'm-field-l' }, 'How many'), count),
          logButtons(p, close, () => ({ count: Number(count.value) || 1 })),
        );
      });
    }

    sheet(p.name, (b, close) => {
      const units = el('input', { class: 'm-input m-amount', type: 'number', inputmode: 'decimal', step: '0.25', min: '0' });
      const amount = el('input', { class: 'm-input m-amount', type: 'number', inputmode: 'decimal', step: 'any', min: '0' });
      const total = el('div', { class: 'm-tpl-total' });
      const date = el('input', { class: 'm-input', type: 'date' });
      date.value = new Date().toISOString().slice(0, 10);

      const recompute = () => {
        if (hourly && p.amount > 0) {
          const u = Number(units.value) || 0;
          const t = p.amount * u;
          total.textContent = u ? `= ${money(t, p.currency)}` : '';
          // A foreign-currency rate is worth showing in the base too — "$65/hr" means
          // little at a glance when the ledger is in yen.
          if (u && p.currency !== cur()) {
            total.textContent += `  ≈ ${money(Math.round(toBase(t, p.currency)), cur())}`;
          }
        } else if (needsAmount) {
          const a = Number(amount.value) || 0;
          total.textContent = a && p.currency !== cur()
            ? `≈ ${money(Math.round(toBase(a, p.currency)), cur())}` : '';
        }
      };
      units.addEventListener('input', recompute);
      amount.addEventListener('input', recompute);

      b.append(el('p', { class: 'm-sheet-text' }, [
        p.amount > 0 ? `${money(p.amount, p.currency)}${UNIT_LABEL[p.payUnit] || ''}` : null,
        p.merchant || p.name, p.category,
      ].filter(Boolean).join(' · ')));

      if (hourly) {
        b.append(el('label', { class: 'm-field' },
          el('span', { class: 'm-field-l' }, UNIT_NOUN[p.payUnit] || 'units'), units));
      }
      if (needsAmount) {
        b.append(el('label', { class: 'm-field' },
          el('span', { class: 'm-field-l' }, `Amount (${p.currency})`), amount));
      }
      b.append(total, el('label', { class: 'm-field' }, el('span', { class: 'm-field-l' }, 'Date'), date));

      // An income template that is normally a guess can still be logged as real money
      // the day it actually lands, so the choice is offered rather than assumed.
      let asEstimate = !!p.isEstimate;
      if (p.kind === 'income') {
        const t = toggle('Log as an estimate (想定)', asEstimate, (v) => { asEstimate = v; });
        b.append(t);
      }

      b.append(logButtons(p, close, () => ({
        units: hourly ? Number(units.value) || 0 : 1,
        amount: needsAmount ? Number(amount.value) : undefined,
        date: date.value,
        estimate: p.kind === 'income' ? asEstimate : undefined,
      })));

      setTimeout(() => (hourly ? units : amount).focus(), 80);
    });
  }

  const logButtons = (p, close, payload) => el('div', { class: 'm-actions' },
    el('button', { class: 'm-btn', onclick: close }, 'Cancel'),
    el('button', { class: 'm-btn is-primary', onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = 'Logging…';
      try {
        const r = await post(`/finance/presets/${p.id}/log`, payload());
        buzz();
        toast(r.estimate ? 'Logged as expected income' : 'Logged', 'ok');
        close();
        show(r.estimate ? 'main' : 'recent');
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false; btn.textContent = 'Log it';
      }
    } }, 'Log it'));

  // ---- creating / editing a template ----

  async function editTemplate(p, cats) {
    if (!cats) cats = await get('/finance/categories').catch(() => ({ income: [], expense: [] }));
    await ensureSettings();
    const isNew = !p;
    const st = {
      kind: p?.kind || 'income',
      payUnit: p?.payUnit || 'flat',
      isEstimate: !!p?.isEstimate,
      isMainJob: !!p?.isMainJob,
    };

    sheet(isNew ? 'New template' : p.name, (b, close) => {
      const name = el('input', { class: 'm-input', type: 'text', placeholder: 'Micro1' });
      const amount = el('input', { class: 'm-input', type: 'number', inputmode: 'decimal', step: 'any', min: '0', placeholder: 'blank = ask each time' });
      const merchant = el('input', { class: 'm-input', type: 'text' });
      const note = el('input', { class: 'm-input', type: 'text', placeholder: 'optional' });
      const curSel = currencySelect(p?.currency || cur());
      const catSel = el('select', { class: 'm-input' });
      if (p) { name.value = p.name; if (p.amount > 0) amount.value = p.amount; merchant.value = p.merchant || ''; note.value = p.note || ''; }

      const fillCats = () => {
        const list = st.kind === 'income' ? cats.income : cats.expense;
        fill(catSel, ...list.map(c => el('option', { value: c, selected: c === p?.category ? '' : null }, c)));
      };
      fillCats();

      const kindSeg = segmented([['income', 'Income'], ['expense', 'Expense']], st.kind, (k) => {
        st.kind = k; fillCats(); incomeOnly.style.display = k === 'income' ? '' : 'none';
      });
      const unitSeg = segmented([['flat', 'Flat'], ['hour', 'Per hour'], ['minute', 'Per minute']], st.payUnit, (u) => {
        st.payUnit = u;
        amountLabel.textContent = u === 'flat' ? 'Amount' : `Rate ${UNIT_LABEL[u]}`;
      });
      const amountLabel = el('span', { class: 'm-field-l' }, st.payUnit === 'flat' ? 'Amount' : `Rate ${UNIT_LABEL[st.payUnit]}`);

      const estToggle = toggle('Usually an estimate (想定)', st.isEstimate, (v) => { st.isEstimate = v; });
      const mainToggle = toggle('This is the main job', st.isMainJob, (v) => { st.isMainJob = v; });
      const incomeOnly = el('div', { style: { display: st.kind === 'income' ? '' : 'none' } }, estToggle, mainToggle);

      b.append(
        el('label', { class: 'm-field' }, el('span', { class: 'm-field-l' }, 'Name'), name),
        kindSeg,
        unitSeg,
        el('label', { class: 'm-field' }, amountLabel,
          el('div', { class: 'm-amount-row' }, curSel, amount)),
        el('p', { class: 'm-note' }, 'Leave the amount blank and the template will ask for it each time — right for anything whose figure changes.'),
        el('label', { class: 'm-field' }, el('span', { class: 'm-field-l' }, 'Category'), catSel),
        el('label', { class: 'm-field' }, el('span', { class: 'm-field-l' }, 'Payer / merchant'), merchant),
        el('p', { class: 'm-note' }, 'Blank uses the template name.'),
        el('label', { class: 'm-field' }, el('span', { class: 'm-field-l' }, 'Note'), note),
        incomeOnly,
        el('div', { class: 'm-actions' },
          !isNew ? el('button', { class: 'm-btn is-ghost is-danger', onclick: async () => {
            if (!await confirmSheet('Delete template?', p.name, { ok: 'Delete', danger: true })) return;
            try { await del(`/finance/presets/${p.id}`); close(); toast('Deleted'); showLog(); }
            catch (e) { toast(e.message, 'err'); }
          } }, 'Delete') : el('button', { class: 'm-btn', onclick: close }, 'Cancel'),
          el('button', { class: 'm-btn is-primary', onclick: async () => {
            const payload = {
              name: name.value.trim(),
              amount: amount.value === '' ? null : Number(amount.value),
              currency: curSel.value, kind: st.kind, category: catSel.value,
              payUnit: st.payUnit, merchant: merchant.value.trim(), note: note.value.trim(),
              isEstimate: st.kind === 'income' ? st.isEstimate : false,
              isMainJob: st.kind === 'income' ? st.isMainJob : false,
            };
            try {
              if (isNew) await post('/finance/presets', payload);
              else await patch(`/finance/presets/${p.id}`, payload);
              buzz(); close(); toast('Saved', 'ok'); showLog();
            } catch (e) { toast(e.message, 'err'); }
          } }, 'Save')),
      );
      if (isNew) setTimeout(() => name.focus(), 80);
    });
  }

  // ---- manual entry ----

  function manualSection(cats) {
    const st = { kind: 'expense', unit: '' };

    const amount = el('input', { class: 'm-input m-amount', type: 'number', inputmode: 'decimal', step: 'any', placeholder: '0', enterkeyhint: 'done' });
    const curSel = currencySelect(cur());
    const merchant = el('input', { class: 'm-input', type: 'text', placeholder: 'Merchant' });
    const note = el('input', { class: 'm-input', type: 'text', placeholder: 'Note (optional)' });
    const date = el('input', { class: 'm-input', type: 'date' });
    date.value = new Date().toISOString().slice(0, 10);
    const units = el('input', { class: 'm-input', type: 'number', inputmode: 'decimal', step: '0.25', min: '0', placeholder: '0' });
    const conv = el('div', { class: 'm-conv' });

    const catSel = el('select', { class: 'm-input' });
    const fillCats = () => fill(catSel, ...(st.kind === 'income' ? cats.income : cats.expense).map(c => el('option', { value: c }, c)));
    fillCats();

    const merchantLabel = el('span', { class: 'm-field-l' }, 'Merchant');
    // Hours only make sense against income here — an expense with hours attached is a
    // different idea (time spent), and the ledger does not model it.
    const unitsField = el('label', { class: 'm-field', style: { display: 'none' } },
      el('span', { class: 'm-field-l' }, 'Hours worked (optional)'), units);
    let asEstimate = false;
    const estToggle = toggle('Log as an estimate (想定)', false, (v) => { asEstimate = v; });
    estToggle.style.display = 'none';

    const kindSeg = segmented([['expense', 'Expense'], ['income', 'Income']], st.kind, (k) => {
      st.kind = k;
      fillCats();
      merchantLabel.textContent = k === 'income' ? 'Payer' : 'Merchant';
      merchant.placeholder = k === 'income' ? 'Payer' : 'Merchant';
      unitsField.style.display = k === 'income' ? '' : 'none';
      estToggle.style.display = k === 'income' ? '' : 'none';
    });

    // A foreign amount is meaningless at a glance against a yen ledger, so show the
    // conversion the server is going to apply, live.
    const showConv = () => {
      const a = Number(amount.value) || 0;
      const code = curSel.value;
      conv.textContent = a && code !== cur() ? `≈ ${money(Math.round(toBase(a, code)), cur())}` : '';
    };
    amount.addEventListener('input', showConv);
    curSel.addEventListener('change', showConv);

    const submit = el('button', { class: 'm-btn-big is-primary', onclick: save }, 'Log it');

    async function save() {
      const amt = Number(amount.value);
      if (!Number.isFinite(amt) || amt <= 0) return toast('Enter an amount', 'err');
      submit.disabled = true; submit.textContent = 'Saving…';
      const u = Number(units.value) || 0;
      const payload = {
        kind: st.kind, amount: amt, currency: curSel.value,
        category: catSel.value, merchant: merchant.value.trim(),
        note: note.value.trim(), date: date.value,
        ...(st.kind === 'income' && u > 0 ? { units: u, unit: 'hour' } : {}),
      };
      try {
        if (st.kind === 'income' && asEstimate) await post('/finance/pending', payload);
        else await post('/finance/txns', payload);
        buzz();
        toast(asEstimate && st.kind === 'income' ? 'Logged as expected' : 'Logged', 'ok');
        amount.value = ''; merchant.value = ''; note.value = ''; units.value = ''; conv.textContent = '';
        show(asEstimate && st.kind === 'income' ? 'main' : 'recent');
      } catch (e) {
        toast(e.message, 'err');
      } finally { submit.disabled = false; submit.textContent = 'Log it'; }
    }

    return el('section', { class: 'm-section' },
      el('h2', { class: 'm-section-title' }, 'Or enter one by hand'),
      el('div', { class: 'm-form' },
        kindSeg,
        el('div', { class: 'm-amount-row' }, curSel, amount),
        conv,
        el('label', { class: 'm-field' }, el('span', { class: 'm-field-l' }, 'Category'), catSel),
        el('label', { class: 'm-field' }, merchantLabel, merchant),
        unitsField,
        el('label', { class: 'm-field' }, el('span', { class: 'm-field-l' }, 'Date'), date),
        el('label', { class: 'm-field' }, el('span', { class: 'm-field-l' }, 'Note'), note),
        estToggle,
        submit));
  }

  // ---- small shared controls ----

  function currencySelect(selected) {
    const codes = settings?.codes?.length ? settings.codes : [cur()];
    const s = el('select', { class: 'm-input m-cur' },
      ...codes.map(c => el('option', { value: c, selected: c === selected ? '' : null }, c)));
    s.value = selected || cur();
    return s;
  }

  function segmented(options, current, onPick) {
    const wrap = el('div', { class: 'm-seg m-seg-sm' });
    fill(wrap, ...options.map(([v, label]) => el('button', {
      class: 'm-seg-b' + (v === current ? ' is-on' : ''),
      onclick: (e) => {
        for (const b of wrap.children) b.classList.remove('is-on');
        e.currentTarget.classList.add('is-on');
        onPick(v);
      },
    }, label)));
    return wrap;
  }

  function toggle(label, on, onChange) {
    const box = el('button', {
      class: 'm-toggle' + (on ? ' is-on' : ''),
      onclick: (e) => {
        const next = !e.currentTarget.classList.contains('is-on');
        e.currentTarget.classList.toggle('is-on', next);
        onChange(next);
      },
    }, el('span', { class: 'm-toggle-box' }, el('span', { html: ICONS.check })),
      el('span', { class: 'm-toggle-l' }, label));
    return box;
  }

  // ================================================================= RECENT

  async function showRecent() {
    const scroll = el('div', { class: 'm-scroll' });
    fill(body, scroll);
    ui.setActions(ui.action('refresh', 'Refresh', () => loadRecent(scroll)));
    pullToRefresh(scroll, () => loadRecent(scroll));
    await loadRecent(scroll);
  }

  async function loadRecent(scroll) {
    fill(scroll, loading());
    try {
      const [ov, txns] = await Promise.all([get('/finance/overview'), get('/finance/txns?limit=40')]);
      settings = ov.settings || settings;
      const c = ov.summary?.currency || cur();
      const items = txns.items || [];

      // Grouped by day: a flat list of thirty rows with a date on each reads as noise,
      // and the question being asked is almost always "what did I spend on Tuesday".
      const byDay = new Map();
      for (const t of items) {
        if (!byDay.has(t.date)) byDay.set(t.date, []);
        byDay.get(t.date).push(t);
      }

      fill(scroll,
        el('div', { class: 'm-stats m-stats-wide' },
          statCard('Spent', compactMoney(ov.summary?.spent, c), 'is-out'),
          statCard('Earned', compactMoney(ov.summary?.earned, c), 'is-in'),
          statCard('Net', compactMoney(ov.summary?.net, c), (ov.summary?.net || 0) < 0 ? 'is-out' : 'is-in')),
        !items.length
          ? empty('Nothing logged this month', 'Use Log to add something.')
          : el('div', {}, ...[...byDay.entries()].map(([date, rows]) => el('section', { class: 'm-daygroup' },
            el('div', { class: 'm-dayhead' },
              el('span', {}, dayLabel(date)),
              el('span', { class: 'm-dayhead-sum' },
                compactMoney(rows.filter(r => r.kind === 'expense').reduce((a, r) => a + (r.amountBase || r.amount || 0), 0), c))),
            el('div', { class: 'm-rows' }, ...rows.map(txnRow))))),
      );
    } catch (e) {
      fill(scroll, errorBox(e, () => loadRecent(scroll)));
    }
  }

  const statCard = (label, value, cls) => el('div', { class: 'm-stat ' + cls },
    el('div', { class: 'm-stat-v' }, value),
    el('div', { class: 'm-stat-l' }, label));

  function txnRow(t) {
    const income = t.kind === 'income';
    return el('button', { class: 'm-row m-row-tap', onclick: () => showTxn(t) },
      el('div', { class: 'm-grow' },
        el('div', { class: 'm-row-t' }, t.merchant || t.note || t.category || 'Untitled'),
        el('div', { class: 'm-row-m' }, [
          t.category,
          t.units && t.unit === 'hour' ? `${t.units}h` : null,
          t.note && t.note !== t.merchant ? t.note : null,
        ].filter(Boolean).join(' · '))),
      el('div', { class: 'm-row-amt ' + (income ? 'is-in' : 'is-out') },
        (income ? '+' : '') + money(t.amount, t.currency || cur())));
  }

  function showTxn(t) {
    sheet(t.merchant || t.category || 'Transaction', (b) => {
      const r = (k, v) => v ? el('div', { class: 'm-prop-f' },
        el('span', { class: 'm-prop-fl' }, k), el('span', { class: 'm-prop-fv' }, String(v))) : null;
      b.append(el('div', { class: 'm-prop-fs' },
        r('Amount', money(t.amount, t.currency || cur())),
        t.currency && t.currency !== cur() ? r('In ' + cur(), money(Math.round(t.amountBase || toBase(t.amount, t.currency)), cur())) : null,
        r('Type', t.kind),
        r('Category', t.category),
        r(t.kind === 'income' ? 'Payer' : 'Merchant', t.merchant),
        t.units && t.unit === 'hour' ? r('Hours', `${t.units}h`) : null,
        t.units && t.unit === 'hour' && t.amount ? r('Rate', `${money(t.amount / t.units, t.currency || cur())}/hr`) : null,
        r('Date', t.date),
        r('Note', t.note),
        r('Source', t.source),
        r('Logged', relTime(t.createdAt))),
        el('div', { class: 'm-actions' },
          el('button', { class: 'm-btn is-ghost is-danger', onclick: async () => {
            if (!await confirmSheet('Delete this row?', money(t.amount, t.currency || cur()), { ok: 'Delete', danger: true })) return;
            try { await del(`/finance/txns/${t.id}`); toast('Deleted'); document.querySelector('.m-sheet-wrap')?.click(); show('recent'); }
            catch (e) { toast(e.message, 'err'); }
          } }, 'Delete')));
    });
  }

  // ================================================================= CAPTURE

  function showCapture() {
    // receipts.js owns its own scroller and re-renders its whole subtree, so it gets a
    // plain host and is left alone.
    const holder = el('div', { class: 'm-capture-host' });
    fill(body, holder);
    captureHandle = mountCapture(holder);
  }

  // ---------- boot ----------

  renderSeg();
  show(view);

  return { unmount: teardown };
}
