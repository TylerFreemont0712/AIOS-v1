// Money — the ledger, phone-shaped.
//
// Three views behind one segmented control, because on a phone these are three
// different errands rather than three panels of one dashboard:
//   Capture   photograph a receipt (the original /m screen, mounted whole)
//   Recent    what has actually been logged
//   Log       type one in by hand, for the times there is no receipt
//
// Capture is the default: it is the thing you do standing in a shop, and it is the
// one that is genuinely awkward anywhere but a phone.

import { get, post } from '../../api.js';
import { el, fill, icon, toast, sheet, money, compactMoney, relTime, dayLabel, loading, empty, errorBox, pullToRefresh, buzz } from '../ui.js';
import { mount as mountCapture, refresh as refreshCapture } from '../receipts.js';

export default async function moneyScreen({ host, params, ui }) {
  let view = params.view === 'recent' ? 'recent' : params.view === 'log' ? 'log' : 'capture';
  let captureHandle = null;
  let settings = null;

  const seg = el('div', { class: 'm-seg' });
  const body = el('div', { class: 'm-viewhost' });
  host.append(seg, body);

  ui.setTitle('Money');

  const VIEWS = [
    { id: 'capture', label: 'Capture' },
    { id: 'recent', label: 'Recent' },
    { id: 'log', label: 'Log' },
  ];

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
    if (id === 'capture') showCapture();
    else if (id === 'recent') showRecent();
    else showLog();
  }

  // ---------- capture ----------

  function showCapture() {
    ui.setActions();
    // receipts.js owns its own scroller and re-renders its whole subtree, so it gets a
    // plain host and is left alone.
    const holder = el('div', { class: 'm-capture-host' });
    fill(body, holder);
    captureHandle = mountCapture(holder);
  }

  // ---------- recent ----------

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
      const [ov, txns] = await Promise.all([
        get('/finance/overview'),
        get('/finance/txns?limit=40'),
      ]);
      settings = ov.settings;
      const cur = ov.summary?.currency || ov.settings?.base || 'JPY';
      const items = txns.items || [];

      // Group by day: a flat list of thirty rows with a date on each reads as noise,
      // and the question being asked is almost always "what did I spend on Tuesday".
      const byDay = new Map();
      for (const t of items) {
        if (!byDay.has(t.date)) byDay.set(t.date, []);
        byDay.get(t.date).push(t);
      }

      fill(scroll,
        el('div', { class: 'm-stats m-stats-wide' },
          statCard('Spent', compactMoney(ov.summary?.spent, cur), 'is-out'),
          statCard('Earned', compactMoney(ov.summary?.earned, cur), 'is-in'),
          statCard('Net', compactMoney(ov.summary?.net, cur), (ov.summary?.net || 0) < 0 ? 'is-out' : 'is-in')),
        !items.length
          ? empty('Nothing logged this month', 'Capture a receipt, or log one by hand.')
          : el('div', {}, ...[...byDay.entries()].map(([date, rows]) => el('section', { class: 'm-daygroup' },
            el('div', { class: 'm-dayhead' },
              el('span', {}, dayLabel(date)),
              el('span', { class: 'm-dayhead-sum' },
                compactMoney(rows.filter(r => r.kind === 'expense').reduce((a, r) => a + (r.amountBase || r.amount || 0), 0), cur))),
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
        el('div', { class: 'm-row-m' }, [t.category, t.note && t.note !== t.merchant ? t.note : null].filter(Boolean).join(' · '))),
      el('div', { class: 'm-row-amt ' + (income ? 'is-in' : 'is-out') },
        (income ? '+' : '') + money(t.amount, t.currency || 'JPY')));
  }

  function showTxn(t) {
    sheet(t.merchant || t.category || 'Transaction', (b) => {
      const row = (k, v) => v ? el('div', { class: 'm-prop-f' },
        el('span', { class: 'm-prop-fl' }, k), el('span', { class: 'm-prop-fv' }, String(v))) : null;
      b.append(el('div', { class: 'm-prop-fs' },
        row('Amount', money(t.amount, t.currency || 'JPY')),
        row('Type', t.kind),
        row('Category', t.category),
        row('Merchant', t.merchant),
        row('Date', t.date),
        row('Note', t.note),
        row('Source', t.source),
        row('Logged', relTime(t.createdAt))));
    });
  }

  // ---------- log by hand ----------

  async function showLog() {
    ui.setActions();
    const scroll = el('div', { class: 'm-scroll' });
    fill(body, scroll, loading());

    let cats = { income: [], expense: [] };
    let presets = [];
    try {
      [cats, presets] = await Promise.all([
        get('/finance/categories'),
        get('/finance/presets').catch(() => []),
      ]);
      if (!settings) settings = (await get('/finance/settings').catch(() => null)) || { base: 'JPY' };
    } catch (e) {
      return fill(scroll, errorBox(e, () => showLog()));
    }

    const st = { kind: 'expense', currency: settings?.base || 'JPY' };

    const amount = el('input', { class: 'm-input m-amount', type: 'number', inputmode: 'decimal', placeholder: '0', enterkeyhint: 'done' });
    const merchant = el('input', { class: 'm-input', type: 'text', placeholder: 'Merchant or payer' });
    const note = el('input', { class: 'm-input', type: 'text', placeholder: 'Note (optional)' });
    const date = el('input', { class: 'm-input', type: 'date' });
    date.value = new Date().toISOString().slice(0, 10);

    const catSel = el('select', { class: 'm-input' });
    const fillCats = () => fill(catSel, ...(st.kind === 'income' ? cats.income : cats.expense).map(c => el('option', { value: c }, c)));
    fillCats();

    const merchantLabel = el('span', { class: 'm-field-l' }, 'Merchant');
    const kindSeg = el('div', { class: 'm-seg m-seg-sm' },
      ...[['expense', 'Expense'], ['income', 'Income']].map(([k, label]) => el('button', {
        class: 'm-seg-b' + (st.kind === k ? ' is-on' : ''),
        onclick: (e) => {
          st.kind = k;
          for (const b of kindSeg.children) b.classList.toggle('is-on', b === e.currentTarget);
          fillCats();
          // The label is the only thing that reads differently for income, and a
          // frozen "Merchant" over a payer field is the kind of small lie that makes
          // people distrust the form.
          merchantLabel.textContent = k === 'income' ? 'Payer' : 'Merchant';
          merchant.placeholder = k === 'income' ? 'Payer' : 'Merchant';
        },
      }, label)));

    const submit = el('button', { class: 'm-btn-big is-primary', onclick: save }, 'Log it');

    async function save() {
      const amt = Number(amount.value);
      if (!Number.isFinite(amt) || amt <= 0) return toast('Enter an amount', 'err');
      submit.disabled = true;
      submit.textContent = 'Saving…';
      try {
        await post('/finance/txns', {
          kind: st.kind, amount: amt, currency: st.currency,
          category: catSel.value, merchant: merchant.value.trim(),
          note: note.value.trim(), date: date.value,
        });
        buzz();
        toast('Logged', 'ok');
        amount.value = ''; merchant.value = ''; note.value = '';
        show('recent');
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        submit.disabled = false;
        submit.textContent = 'Log it';
      }
    }

    const field = (label, node) => el('label', { class: 'm-field' }, el('span', { class: 'm-field-l' }, label), node);

    fill(scroll,
      el('div', { class: 'm-form' },
        kindSeg,
        el('div', { class: 'm-amount-row' },
          el('span', { class: 'm-amount-cur' }, st.currency),
          amount),
        field('Category', catSel),
        el('label', { class: 'm-field' }, merchantLabel, merchant),
        field('Date', date),
        field('Note', note),
        submit),
      presets.length ? el('section', { class: 'm-section' },
        el('h2', { class: 'm-section-title' }, 'Presets'),
        el('div', { class: 'm-chips' }, ...presets.map(p => el('button', {
          class: 'm-chip', onclick: async () => {
            try { await post(`/finance/presets/${p.id}/log`, {}); buzz(); toast(`Logged ${p.name}`, 'ok'); show('recent'); }
            catch (e) { toast(e.message, 'err'); }
          },
        }, `${p.name} · ${money(p.amount, p.currency)}`)))) : null,
    );

    setTimeout(() => amount.focus(), 80);
  }

  // ---------- boot ----------

  renderSeg();
  show(params.capture ? 'capture' : view);

  return { unmount: teardown };
}
