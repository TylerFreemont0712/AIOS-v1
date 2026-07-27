// Finances — earnings, expenses, budgets, goals, receipt capture, and a history
// you can actually read a year later.
//
// Replaces the three separate Earnings / Expenses / Charts panels of the older
// PyQt app. Five tabs share one period selector, so changing the month re-scopes
// everything at once instead of each panel keeping its own idea of "now".
//
// The tab order is deliberate: Overview answers "where am I", History answers
// "how did it go" (the thing a ledger is worst at), Ledger is the raw rows, Plan
// holds the setup you touch monthly at most, Receipts is capture. Anything you
// look at daily comes before anything you configure once.

import { el, icon, toast, modal, confirmBox, menu, debounce } from '../ui.js';
import { get, post, patch, put, del, uploadFile, mediaUrl } from '../api.js';
import { IMAGE_ACCEPT } from '../imageprep.js';
import {
  groupedBars, donut, legend, areaLine, rankedBars, meter, calendarHeat, sparkbars,
  pricePoints, palette, fmtNum,
} from '../charts.js';

const TABS = [
  ['overview', 'Overview'],
  ['history', 'History'],
  ['items', 'Items'],
  ['ledger', 'Ledger'],
  ['plan', 'Plan'],
  ['receipts', 'Receipts'],
];

const ITEM_SORTS = [
  ['recent', 'Recently bought'],
  ['most', 'Bought most'],
  ['spend', 'Most spent on'],
  ['saving', 'Biggest saving available'],
  ['name', 'Name'],
];

const RANGES = [
  ['this-month', 'This month'],
  ['last-month', 'Last month'],
  ['30d', 'Last 30 days'],
  ['this-year', 'This year'],
  ['all', 'All time'],
];

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const todayStr = () => new Date().toISOString().slice(0, 10);
const monthStr = (d = new Date()) => d.toISOString().slice(0, 7);
const prettyMonth = (m) => `${MONTH_NAMES[Number(String(m).slice(5, 7)) - 1] || '?'} ${String(m).slice(0, 4)}`;

export default {
  id: 'finance', title: 'Finances', icon: 'briefcase',

  mount(body, opts, win) {
    const S = win.financeState = {
      tab: opts?.tab && TABS.some(t => t[0] === opts.tab) ? opts.tab : 'overview',
      range: 'this-month',
      month: monthStr(),
      year: String(new Date().getFullYear()),
      currency: 'JPY',
      categories: { income: [], expense: [] },
      data: null, ledger: null, yearData: null, receipts: null, recap: null, calendar: null,
      itemsData: null, itemSearch: '', itemCategory: '', itemSort: 'recent',
      search: '', kindFilter: '', busy: false,
    };

    // ---------- chrome ----------
    const sub = el('span', { class: 'fin-scope' }, '');

    const rangeSel = el('select', {
      class: 'input sm', title: 'Period',
      onchange: () => { S.range = rangeSel.value; if (S.range) monthInput.value = ''; refresh(); },
    }, el('option', { value: '' }, 'Custom month'), RANGES.map(([v, label]) => el('option', { value: v }, label)));
    rangeSel.value = S.range;

    const monthInput = el('input', {
      class: 'input sm fin-month', type: 'month', title: 'Jump to a specific month',
      onchange: () => { if (monthInput.value) { S.month = monthInput.value; S.range = ''; rangeSel.value = ''; refresh(); } },
    });

    const head = el('div', { class: 'pane-head fin-head' },
      el('div', { class: 'ttl' }, 'Finances'), sub,
      el('span', { class: 'grow' }),
      rangeSel, monthInput,
      el('button', { class: 'btn sm', title: 'Photograph a receipt and read it with the local model', onclick: () => openReceiptFlow() },
        icon('sparkle'), 'Scan'),
      el('button', { class: 'btn sm primary', onclick: () => openTxnEditor() }, icon('plus'), 'Add'),
    );

    const tabStrip = el('div', { class: 'seg fin-tabs' }, TABS.map(([id, label]) =>
      el('button', {
        class: 'seg-btn' + (S.tab === id ? ' on' : ''), dataset: { tab: id },
        onclick: () => { S.tab = id; paintTabs(); refresh(); },
      }, label)));

    const content = el('div', { class: 'fin-body' });
    body.append(el('div', { class: 'main-pane' }, head, tabStrip, content));

    const paintTabs = () => {
      for (const b of tabStrip.querySelectorAll('.seg-btn')) b.classList.toggle('on', b.dataset.tab === S.tab);
    };

    // ---------- data ----------
    const scope = () => (S.range ? { range: S.range } : { month: S.month });
    const qs = (extra = {}) => new URLSearchParams({ ...scope(), ...extra }).toString();
    const money = (n) => `${S.currency} ${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    const compact = (n) => `${S.currency} ${fmtNum(n)}`;

    async function refresh() {
      if (S.busy) return;
      S.busy = true;
      content.classList.add('is-loading');
      try {
        if (S.tab === 'history') {
          S.yearData = await get(`/finance/year?year=${encodeURIComponent(S.year)}`);
          S.currency = S.yearData.currency || S.currency;
        } else if (S.tab === 'items') {
          await loadItems();
        } else {
          S.data = await get(`/finance/overview?${qs()}`);
          S.currency = S.data.settings?.base || S.currency;
          if (!S.categories.expense.length) S.categories = await get('/finance/categories');
          const r = S.data.summary.range;
          sub.textContent = S.range === 'all' ? 'all time' : `${r.start} → ${r.end}`;
          if (S.tab === 'overview' && !S.range) {
            S.calendar = await get(`/finance/calendar?month=${S.month}`);
          } else if (S.tab === 'overview') {
            S.calendar = await get(`/finance/calendar?${qs()}`);
          }
          if (S.tab === 'ledger') await loadLedger();
          if (S.tab === 'receipts') S.receipts = await get('/finance/receipts?limit=30');
        }
        if (S.tab === 'history') sub.textContent = S.year;
        if (S.tab === 'items') {
          const n = S.itemsData?.items.length || 0;
          sub.textContent = `${n} tracked item${n === 1 ? '' : 's'}`;
        }
        render();
      } catch (e) {
        content.innerHTML = '';
        content.append(el('div', { class: 'fin-error' }, icon('x'), el('span', {}, e.message)));
      } finally {
        S.busy = false;
        content.classList.remove('is-loading');
      }
    }

    async function loadLedger() {
      const extra = { limit: 300 };
      if (S.search) extra.search = S.search;
      if (S.kindFilter) extra.kind = S.kindFilter;
      S.ledger = await get(`/finance/txns?${qs(extra)}`);
    }

    function render() {
      content.innerHTML = '';
      const view = {
        overview: renderOverview, history: renderHistory, items: renderItems,
        ledger: renderLedger, plan: renderPlan, receipts: renderReceipts,
      }[S.tab];
      if (!view) return;
      const ready = S.tab === 'history' ? S.yearData : S.tab === 'items' ? S.itemsData : S.data;
      if (!ready) return content.append(el('p', { class: 'empty' }, 'Loading…'));
      view();
    }

    // ---------- shared bits ----------
    /** Pixel width available to a chart inside a card of the given column span.
     *  Charts take their viewBox from this so they render at their design height
     *  rather than being scaled up on a wide panel (or letterboxed on a narrow
     *  one). Mirrors the grid breakpoints in apps.css; the ResizeObserver
     *  re-renders whenever the panel changes size. */
    function chartWidth(span = 1) {
      const W = content.clientWidth || 900;
      const GAP = 12, PAD = 28;                       // .fin-card left+right padding
      const cols = W <= 720 ? 1 : W <= 1100 ? 2 : 3;
      const eff = Math.min(span, cols);
      const colW = (W - GAP * (cols - 1)) / cols;
      return Math.max(240, Math.round(colW * eff + GAP * (eff - 1) - PAD));
    }

    const card = (titleText, node, cls = '', action = null) => el('section', { class: 'fin-card ' + cls },
      el('div', { class: 'fin-card-head' },
        el('h3', { class: 'fin-card-title' }, titleText),
        action ? el('span', { class: 'grow' }) : null, action),
      node);

    /** Hero band: one dominant number, the two that make it up, and a delta. */
    function hero(s, deltaSpent) {
      const positive = s.net >= 0;
      return el('div', { class: 'fin-hero' },
        el('div', { class: 'fin-hero-main' },
          el('div', { class: 'fin-hero-label' }, positive ? 'Net saved' : 'Net shortfall'),
          el('div', { class: 'fin-hero-value' + (positive ? '' : ' is-neg') }, money(Math.abs(s.net))),
          el('div', { class: 'fin-hero-meta' },
            s.savingsRate === null
              ? el('span', { class: 'muted' }, `${s.count} transactions`)
              : el('span', {}, `${s.savingsRate}% of income kept · ${s.count} transactions`))),
        el('div', { class: 'fin-hero-split' },
          el('div', { class: 'fin-hero-stat is-in' },
            el('span', { class: 'fin-hero-stat-label' }, 'In'),
            el('span', { class: 'fin-hero-stat-value' }, money(s.earned))),
          el('div', { class: 'fin-hero-stat is-out' },
            el('span', { class: 'fin-hero-stat-label' }, 'Out'),
            el('span', { class: 'fin-hero-stat-value' }, money(s.spent)),
            deltaSpent !== null && deltaSpent !== undefined
              ? el('span', { class: 'fin-delta ' + (deltaSpent > 0 ? 'is-up' : deltaSpent < 0 ? 'is-down' : '') },
                deltaSpent === 0 ? 'same as last month'
                  : `${deltaSpent > 0 ? '↑' : '↓'} ${compact(Math.abs(deltaSpent))} vs last month`)
              : null),
          el('div', { class: 'fin-hero-stat' },
            el('span', { class: 'fin-hero-stat-label' }, 'Per day'),
            el('span', { class: 'fin-hero-stat-value' }, money(s.avgSpendPerDay)))),
      );
    }

    function renderOverview() {
      const d = S.data, s = d.summary;
      const cats = d.categories.items.map(c => ({ label: c.category, value: c.total }));
      const monthly = d.monthly.items.map(m => ({ label: MONTH_NAMES[Number(m.month.slice(5, 7)) - 1], a: m.earned, b: m.spent, net: m.net }));
      const daily = d.daily.items.map(p => ({ label: p.date.slice(5), value: p.net }));
      const prev = d.monthly.items.length >= 2 ? d.monthly.items[d.monthly.items.length - 2] : null;
      const curM = d.monthly.items[d.monthly.items.length - 1];
      const deltaSpent = prev && curM ? Math.round(curM.spent - prev.spent) : null;

      content.append(
        hero(s, S.range && S.range !== 'this-month' ? null : deltaSpent),

        el('div', { class: 'fin-grid' },
          card('Twelve-month trend', groupedBars(monthly, {
            width: chartWidth(2), aLabel: 'earned', bLabel: 'spent',
            onPick: (m, i) => {
              const picked = d.monthly.items[i];
              if (!picked) return;
              S.month = picked.month; S.range = ''; rangeSel.value = ''; monthInput.value = S.month;
              refresh();
            },
          }), 'span2'),

          card('Where it went', cats.length
            ? el('div', { class: 'fin-donut-wrap' },
              donut(cats, { centerLabel: fmtNum(d.categories.total), centerSub: S.currency, onPick: drillCategory }),
              legend(cats, { format: money, onPick: drillCategory }))
            : teach('No expenses in this period.', 'Add one with the button top-right, or scan a receipt.')),

          card(S.calendar ? 'Daily spend' : 'Calendar', S.calendar
            ? calendarHeat(S.calendar.days, {
              month: S.calendar.range.start.slice(0, 7), max: S.calendar.max, format: money,
              onPick: (dy) => { S.tab = 'ledger'; S.search = ''; paintTabs(); jumpToDay(dy.date); },
            })
            : el('p', { class: 'empty sm' }, '—')),

          card('Running net', daily.length
            ? areaLine(daily, { width: chartWidth(2), cumulative: true })
            : teach('Nothing recorded yet.', 'The line tracks your balance across the period.'), 'span2'),

          card('Goal', d.goal && (d.goal.minGoal || d.goal.majorGoal)
            ? el('div', {},
              el('div', { class: 'fin-goal-label' }, 'Side income · ' + prettyMonth(d.goal.month)),
              meter(d.goal.progress, d.goal.minGoal || d.goal.majorGoal, { stretch: d.goal.majorGoal, format: money }),
              d.goal.majorGoal && d.goal.majorPct !== null
                ? el('p', { class: 'fin-goal-hint' }, `${d.goal.majorPct}% of the stretch target`)
                : null)
            : teach('No goal set.', 'Set a monthly side-income target in Plan.')),

          card('Budgets', d.budgets.items.length
            ? el('ul', { class: 'fin-budget-mini' }, d.budgets.items.slice(0, 5).map(b =>
              el('li', { class: b.over ? 'is-over' : '' },
                el('span', { class: 'fin-budget-name' }, b.category),
                meter(b.spent, b.amount, { format: money, danger: b.over }))))
            : teach('No budgets yet.', 'Caps per category live in Plan.')),
        ),

        d.recent.length ? card('Latest activity', txnTable(d.recent, { compact: true }),
          'span3', el('button', { class: 'btn ghost xs', onclick: () => { S.tab = 'ledger'; paintTabs(); refresh(); } }, 'See all')) : null,
      );
    }

    const teach = (line, hint) => el('div', { class: 'fin-teach' },
      el('p', {}, line), hint ? el('p', { class: 'fin-teach-hint' }, hint) : null);

    function drillCategory(c) {
      S.tab = 'ledger'; S.search = c.label; S.kindFilter = 'expense'; paintTabs(); refresh();
    }

    async function jumpToDay(date) {
      S.range = ''; S.month = date.slice(0, 7); monthInput.value = S.month; rangeSel.value = '';
      S.search = ''; await refresh();
      const row = content.querySelector(`[data-date="${date}"]`);
      row?.scrollIntoView({ block: 'center' });
      row?.classList.add('is-flash');
    }

    // ---------- history: the "look back" view ----------
    function renderHistory() {
      const y = S.yearData;
      const t = y.totals;
      const years = y.years || [S.year];

      const yearNav = el('div', { class: 'fin-year-nav' },
        el('button', {
          class: 'btn ghost sm', title: 'Previous year',
          onclick: () => { S.year = String(Number(S.year) - 1); refresh(); },
        }, '‹'),
        el('select', { class: 'input sm', onchange: (e) => { S.year = e.target.value; refresh(); } },
          years.map(v => el('option', { value: v, selected: v === S.year }, v))),
        el('button', {
          class: 'btn ghost sm', title: 'Next year',
          onclick: () => { S.year = String(Number(S.year) + 1); refresh(); },
        }, '›'));

      const activeMonths = y.months.filter(m => m.count);
      const spentSeries = y.months.map(m => m.spent);

      content.append(
        el('div', { class: 'fin-year-head' },
          yearNav,
          el('div', { class: 'fin-year-totals' },
            yearStat('Earned', money(t.earned), 'is-in'),
            yearStat('Spent', money(t.spent), 'is-out'),
            yearStat('Net', money(t.net), t.net >= 0 ? 'is-in' : 'is-out'),
            t.savingsRate === null ? null : yearStat('Kept', t.savingsRate + '%'),
            yearStat('Entries', String(t.count)))),

        activeMonths.length ? el('div', { class: 'fin-year-strip' },
          card(`${S.year} at a glance`, groupedBars(
            y.months.map(m => ({ label: MONTH_NAMES[Number(m.month.slice(5, 7)) - 1], a: m.earned, b: m.spent, net: m.net })),
            { width: chartWidth(3), height: 260, aLabel: 'earned', bLabel: 'spent',
              onPick: (m, i) => openMonth(y.months[i].month) }), 'span3')) : null,

        activeMonths.length
          ? el('div', { class: 'fin-month-grid' }, y.months.map(m => monthCard(m, spentSeries)))
          : teach(`Nothing recorded in ${S.year}.`, 'Pick another year, or start logging — the history builds itself.'),

        y.categories.length ? card(`Where ${S.year} went`, el('div', { class: 'fin-year-cats' },
          rankedBars(y.categories.map(c => ({ label: c.category, value: c.total })), { format: money, onPick: drillCategory }),
          el('p', { class: 'fin-note-line' },
            y.busiest ? `Heaviest month: ${prettyMonth(y.busiest.month)} (${money(y.busiest.spent)}).` : '',
            y.leanest ? ` Lightest: ${prettyMonth(y.leanest.month)} (${money(y.leanest.spent)}).` : '',
            t.avgSpendPerActiveMonth ? ` Averaging ${money(t.avgSpendPerActiveMonth)} a month.` : '')), 'span3') : null,
      );
    }

    const yearStat = (label, value, tone = '') => el('div', { class: 'fin-year-stat ' + tone },
      el('span', { class: 'fin-year-stat-label' }, label),
      el('span', { class: 'fin-year-stat-value' }, value));

    /** One month, summarised well enough to be worth revisiting. */
    function monthCard(m, allSpent) {
      const empty = !m.count;
      return el('article', {
        class: 'fin-month-card' + (empty ? ' is-empty' : '') + (m.note ? ' has-note' : ''),
        onclick: empty ? null : () => openMonth(m.month),
        title: empty ? 'Nothing recorded' : 'Open this month',
      },
        el('div', { class: 'fin-month-top' },
          el('span', { class: 'fin-month-name' }, MONTH_NAMES[Number(m.month.slice(5, 7)) - 1]),
          empty ? null : el('span', { class: 'fin-month-net' + (m.net >= 0 ? '' : ' is-neg') },
            (m.net >= 0 ? '+' : '−') + fmtNum(Math.abs(m.net)))),
        empty
          ? el('div', { class: 'fin-month-blank' }, '—')
          : el('div', {},
            el('div', { class: 'fin-month-bars' },
              el('span', { class: 'fin-month-bar is-in', style: { width: barPct(m.earned, allSpent, m) + '%' } }),
              el('span', { class: 'fin-month-bar is-out', style: { width: barPct(m.spent, allSpent, m) + '%' } })),
            el('div', { class: 'fin-month-figs' },
              el('span', { class: 'is-in' }, fmtNum(m.earned)),
              el('span', { class: 'is-out' }, fmtNum(m.spent))),
            m.headline
              ? el('p', { class: 'fin-month-headline' }, m.headline)
              : m.topCategory
                ? el('p', { class: 'fin-month-top-cat' }, `mostly ${m.topCategory.category}`)
                : null,
            m.note ? el('p', { class: 'fin-month-note' }, icon('daily'), el('span', {}, m.note)) : null),
      );
    }

    function barPct(v, all, m) {
      const peak = Math.max(1, ...all, m.earned);
      return Math.max(2, Math.round((v / peak) * 100));
    }

    /** Month detail: the numbers, the frozen write-up, and your own note. */
    async function openMonth(month) {
      const holder = el('div', { class: 'fin-month-detail' }, el('p', { class: 'empty sm' }, 'Loading…'));
      const dlg = modal({
        title: prettyMonth(month), wide: true, body: holder,
        actions: [{ label: 'Close', value: true }],
      });
      try {
        const [sum, cats, recap] = await Promise.all([
          get(`/finance/summary?month=${month}`),
          get(`/finance/chart/categories?month=${month}`),
          get(`/finance/recap?month=${month}`),
        ]);
        S.recap = recap;
        holder.innerHTML = '';
        holder.append(
          el('div', { class: 'fin-md-stats' },
            yearStat('Earned', money(sum.earned), 'is-in'),
            yearStat('Spent', money(sum.spent), 'is-out'),
            yearStat('Net', money(sum.net), sum.net >= 0 ? 'is-in' : 'is-out'),
            sum.savingsRate === null ? null : yearStat('Kept', sum.savingsRate + '%')),
          cats.items.length ? el('div', { class: 'fin-md-cats' },
            rankedBars(cats.items.map(c => ({ label: c.category, value: c.total })), { format: money })) : null,
          recapBlock(month, recap, holder),
          noteBlock(month, recap),
          el('div', { class: 'fin-md-actions' },
            el('button', {
              class: 'btn sm', onclick: () => {
                S.month = month; S.range = ''; rangeSel.value = ''; monthInput.value = month;
                S.tab = 'ledger'; paintTabs(); refresh();
                document.querySelector('.modal-overlay')?.remove();
              },
            }, 'Open in Ledger')),
        );
      } catch (e) {
        holder.innerHTML = '';
        holder.append(el('p', { class: 'empty' }, e.message));
      }
      await dlg;
    }

    function recapBlock(month, recap, holder) {
      const wrap = el('div', { class: 'fin-recap' });
      const paint = (r) => {
        wrap.innerHTML = '';
        wrap.append(el('div', { class: 'fin-recap-head' },
          el('h4', {}, 'What happened'),
          el('span', { class: 'grow' }),
          el('button', {
            class: 'btn ghost xs', title: r.summary ? 'Write it again from the current figures' : 'Summarise this month with the local model',
            onclick: async (ev) => {
              const btn = ev.currentTarget;
              btn.disabled = true; btn.textContent = 'Writing…';
              try {
                const next = await post('/finance/recap', { month, force: !!r.summary });
                paint(next);
                toast('Recap written', 'ok');
              } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = r.summary ? 'Rewrite' : 'Write it'; }
            },
          }, r.summary ? 'Rewrite' : 'Write it')));
        wrap.append(r.summary
          ? el('div', {},
            r.headline ? el('p', { class: 'fin-recap-headline' }, r.headline) : null,
            el('p', { class: 'fin-recap-body' }, r.summary),
            el('p', { class: 'fin-recap-meta' }, `written ${String(r.updatedAt || '').slice(0, 10)}${r.model ? ` · ${r.model}` : ''}`))
          : el('p', { class: 'fin-teach-hint' },
            'Nothing written yet. The local model can turn this month\'s figures into a few sentences you\'ll still understand next year.'));
      };
      paint(recap);
      return wrap;
    }

    function noteBlock(month, recap) {
      const ta = el('textarea', {
        class: 'input fin-note-input', rows: 2, placeholder: 'Your own note — why this month looked the way it did…',
      });
      ta.value = recap.note || '';
      const save = debounce(async () => {
        try { await put('/finance/recap/note', { month, note: ta.value }); }
        catch (e) { toast(e.message, 'err'); }
      }, 700);
      ta.addEventListener('input', save);
      return el('div', { class: 'fin-note-block' },
        el('h4', {}, 'Your note'), ta,
        el('p', { class: 'fin-teach-hint' }, 'Saved as you type. Rewriting the recap never touches this.'));
    }

    // ---------- items: what things cost, and where ----------
    async function loadItems() {
      const q = new URLSearchParams({ sort: S.itemSort });
      if (S.itemSearch) q.set('search', S.itemSearch);
      if (S.itemCategory) q.set('category', S.itemCategory);
      S.itemsData = await get(`/finance/items?${q}`);
      S.currency = S.itemsData.currency || S.currency;
    }

    /** Unit prices are small numbers (¥0.26 per ml), so they need more precision
     *  than money() gives — but a per-each price is just money. */
    const unitPrice = (v, unit) => unit === 'each'
      ? money(v)
      : `${S.currency} ${Number(v || 0).toFixed(v < 1 ? 3 : 2)}`;

    /** The comparable quantity a shopper actually thinks in: per litre, per kilo,
     *  per item — not per millilitre. */
    const perLabel = (unit) => (unit === 'ml' ? 'per L' : unit === 'g' ? 'per kg' : 'each');
    const perValue = (v, unit) => (unit === 'each' ? v : v * 1000);
    const shopPrice = (v, unit) => `${money(perValue(v, unit))} ${perLabel(unit)}`;

    function renderItems() {
      const d = S.itemsData;
      const searchBox = el('input', {
        class: 'input sm fin-search', placeholder: 'Search milk, 牛乳, or a printed name…', value: S.itemSearch,
        oninput: debounce(async (ev) => { S.itemSearch = ev.target.value.trim(); await loadItems(); render(); }, 250),
      });
      const catSel = el('select', { class: 'input sm', onchange: async () => { S.itemCategory = catSel.value; await loadItems(); render(); } },
        el('option', { value: '' }, 'All categories'),
        (d.categories || []).map(c => el('option', { value: c }, c)));
      catSel.value = S.itemCategory;
      const sortSel = el('select', { class: 'input sm', onchange: async () => { S.itemSort = sortSel.value; await loadItems(); render(); } },
        ITEM_SORTS.map(([v, l]) => el('option', { value: v }, l)));
      sortSel.value = S.itemSort;

      content.append(
        el('div', { class: 'fin-toolbar' }, searchBox, catSel, sortSel,
          el('span', { class: 'grow' }),
          d.unresolvedCount
            ? el('button', { class: 'btn sm', onclick: openReviewQueue },
              icon('sparkle'), `${d.unresolvedCount} line${d.unresolvedCount === 1 ? '' : 's'} to name`)
            : null,
          el('button', { class: 'btn sm ghost', onclick: () => openItemEditor() }, icon('plus'), 'New item')),

        d.items.length
          ? el('div', { class: 'fin-item-grid' }, d.items.map(itemCard))
          : teach(
            S.itemSearch || S.itemCategory ? 'Nothing matches that.' : 'No items tracked yet.',
            S.itemSearch || S.itemCategory
              ? 'Search matches the English name, the Japanese name, and every printed name ever seen.'
              : 'Scan a receipt — every line becomes a price point, and brands are folded together so "ヤマダ牛乳" and "明治牛乳" both count as Milk.'),
      );
    }

    function itemCard(it) {
      const hasPrices = it.bestUnitPrice > 0;
      const dearer = hasPrices && it.medianUnitPrice > it.bestUnitPrice * 1.05;
      return el('article', {
        class: 'fin-item-card', onclick: () => openItem(it.id), title: 'Price history and where to buy it',
      },
        el('div', { class: 'fin-item-head' },
          el('div', { class: 'fin-item-names' },
            el('span', { class: 'fin-item-en' }, it.nameEn),
            it.nameJa ? el('span', { class: 'fin-item-ja' }, it.nameJa) : null),
          it.spark.length > 1 ? sparkbars(it.spark, { width: 52, height: 20 }) : null),

        el('div', { class: 'fin-item-tags' },
          el('span', { class: 'fin-cat' }, it.subcategory || it.category),
          el('span', { class: 'fin-item-count' }, `${it.timesBought}×`)),

        hasPrices
          ? el('div', { class: 'fin-item-prices' },
            el('div', { class: 'fin-item-price' },
              el('span', { class: 'fin-item-price-label' }, 'Best'),
              el('span', { class: 'fin-item-price-value is-best' }, shopPrice(it.bestUnitPrice, it.unit)),
              it.bestMerchant ? el('span', { class: 'fin-item-where' }, it.bestMerchant) : null),
            dearer
              ? el('div', { class: 'fin-item-price' },
                el('span', { class: 'fin-item-price-label' }, 'Typical'),
                el('span', { class: 'fin-item-price-value' }, shopPrice(it.medianUnitPrice, it.unit)))
              : null)
          : el('p', { class: 'fin-teach-hint' }, 'no priced purchases yet'),

        it.lastDate
          ? el('div', { class: 'fin-item-foot' }, `last ${it.lastDate}${it.lastMerchant ? ` · ${it.lastMerchant}` : ''}`)
          : null,
      );
    }

    /** Item detail: the answer to "where should I buy this, and is it getting
     *  more expensive". */
    async function openItem(itemId) {
      const holder = el('div', { class: 'fin-item-detail' }, el('p', { class: 'empty sm' }, 'Loading…'));
      const dlg = modal({ title: 'Item', wide: true, body: holder, actions: [{ label: 'Close', value: true }] });
      try {
        const d = await get(`/finance/items/${itemId}`);
        const it = d.item, st = d.stats;
        const merchantNames = d.merchants.map(m => m.merchant);
        const colors = palette(merchantNames.length);

        holder.innerHTML = '';
        holder.append(
          el('div', { class: 'fin-item-hero' },
            el('div', {},
              el('h3', { class: 'fin-item-hero-name' }, it.nameEn),
              it.nameJa ? el('div', { class: 'fin-item-hero-ja' }, it.nameJa) : null,
              el('div', { class: 'fin-item-hero-meta' },
                `${it.category}${it.subcategory ? ' · ' + it.subcategory : ''} · compared ${perLabel(it.unit)}`)),
            el('span', { class: 'grow' }),
            el('button', { class: 'btn ghost xs', title: 'Edit name, unit and category', onclick: () => openItemEditor(it) }, icon('edit'))),

          d.cheapest
            ? el('div', { class: 'fin-best' },
              el('div', {},
                el('div', { class: 'fin-best-label' }, 'Cheapest here'),
                el('div', { class: 'fin-best-shop' }, d.cheapest.merchant),
                el('div', { class: 'fin-best-price' }, shopPrice(d.cheapest.median, it.unit))),
              d.saving
                ? el('div', { class: 'fin-best-saving' },
                  el('span', { class: 'fin-best-pct' }, `${d.saving.pct}%`),
                  el('span', {}, `cheaper than ${d.saving.vs}`))
                : el('p', { class: 'fin-teach-hint' }, d.merchants.length > 1
                  ? 'Only one shop has been sampled more than once — a second visit elsewhere makes the comparison trustworthy.'
                  : 'Only bought here so far. Buy it somewhere else to compare.'))
            : null,

          el('div', { class: 'fin-item-stats' },
            yearStat('Bought', `${st.timesBought}×`),
            yearStat('Spent', money(st.totalSpent)),
            yearStat('Best', shopPrice(st.best, it.unit), 'is-in'),
            yearStat('Typical', shopPrice(st.median, it.unit)),
            yearStat('Worst', shopPrice(st.worst, it.unit), 'is-out'),
            st.trendPct === null ? null
              : yearStat('Trend', `${st.trendPct > 0 ? '+' : ''}${st.trendPct}%`, st.trendPct > 0 ? 'is-out' : 'is-in')),

          d.series.length
            ? el('section', { class: 'fin-item-section' },
              el('h4', {}, 'Every price paid'),
              // The axis has to speak the same unit as every other figure here:
              // showing per-gram next to a per-kg headline reads as a bug.
              pricePoints(d.series, {
                merchants: merchantNames,
                format: (v) => Number(perValue(v, it.unit)).toLocaleString('en-US', { maximumFractionDigits: it.unit === 'each' ? 0 : 0 }),
              }),
              el('div', { class: 'fin-legend-row' }, merchantNames.map((m, i) =>
                el('span', { class: 'fin-legend-chip' },
                  el('span', { class: 'chart-swatch', style: { background: colors[i] } }), m))))
            : null,

          d.merchants.length
            ? el('section', { class: 'fin-item-section' },
              el('h4', {}, 'By shop'),
              (() => {
                const t = el('table', { class: 'fin-table' });
                t.append(el('thead', {}, el('tr', {},
                  el('th', {}, 'Shop'), el('th', { class: 'num' }, 'Typical'),
                  el('th', { class: 'num' }, 'Best'), el('th', { class: 'num' }, 'Latest'),
                  el('th', { class: 'num' }, 'Times'), el('th', {}, 'Last seen'))));
                t.append(el('tbody', {}, d.merchants.map((m, i) => el('tr', { class: i === 0 ? 'is-cheapest' : '' },
                  el('td', {}, el('span', { class: 'chart-swatch', style: { background: colors[i] } }), ' ', m.merchant),
                  el('td', { class: 'num fin-amount' }, shopPrice(m.median, it.unit)),
                  el('td', { class: 'num' }, shopPrice(m.best, it.unit)),
                  el('td', { class: 'num' }, shopPrice(m.latest, it.unit)),
                  el('td', { class: 'num' }, String(m.count)),
                  el('td', { class: 'fin-date' }, m.lastDate)))));
                return el('div', { class: 'fin-scroll' }, t);
              })())
            : null,

          el('section', { class: 'fin-item-section' },
            el('h4', {}, `Printed names that mean "${it.nameEn}"`),
            el('p', { class: 'fin-teach-hint' },
              'Confirmed names are the point of truth — the model is never allowed to reassign them.'),
            el('ul', { class: 'fin-alias-list' }, d.aliases.map(a => el('li', {},
              el('span', { class: 'fin-alias-raw' }, a.raw),
              a.confirmed
                ? el('span', { class: 'fin-alias-tag is-ok' }, 'confirmed')
                : el('button', {
                  class: 'btn ghost xs', title: 'Confirm this mapping',
                  onclick: async (ev) => {
                    try {
                      await post(`/finance/items/${it.id}/alias`, { raw: a.raw });
                      ev.currentTarget.replaceWith(el('span', { class: 'fin-alias-tag is-ok' }, 'confirmed'));
                    } catch (e) { toast(e.message, 'err'); }
                  },
                }, 'confirm'),
              el('span', { class: 'fin-alias-src' }, `${a.source}${a.hits ? ` · seen ${a.hits}×` : ''}`),
              el('button', {
                class: 'btn ghost xs', title: 'This is not the same thing',
                onclick: async (ev) => {
                  try { await del(`/finance/alias/${a.id}`); ev.currentTarget.closest('li').remove(); }
                  catch (e) { toast(e.message, 'err'); }
                },
              }, icon('x')))))),

          d.purchases.length
            ? el('section', { class: 'fin-item-section' },
              el('h4', {}, 'Purchases'),
              el('div', { class: 'fin-scroll' }, (() => {
                const t = el('table', { class: 'fin-table' });
                t.append(el('thead', {}, el('tr', {},
                  el('th', {}, 'Date'), el('th', {}, 'Shop'), el('th', {}, 'As printed'),
                  el('th', { class: 'num' }, 'Paid'), el('th', { class: 'num' }, perLabel(it.unit)))));
                t.append(el('tbody', {}, d.purchases.slice(0, 40).map(p => el('tr', {},
                  el('td', { class: 'fin-date' }, p.date),
                  el('td', {}, p.merchant || '—'),
                  el('td', { class: 'fin-alias-raw' }, p.rawName),
                  el('td', { class: 'num fin-amount' }, money(p.lineTotalBase)),
                  el('td', { class: 'num' }, p.unitPriceBase ? shopPrice(p.unitPriceBase, p.unit || it.unit) : '—')))));
                return t;
              })()))
            : null,
        );
      } catch (e) {
        holder.innerHTML = '';
        holder.append(el('p', { class: 'empty' }, e.message));
      }
      await dlg;
      if (S.tab === 'items') refresh();
    }

    /** The review queue: printed names nobody has classified yet. This is where
     *  the catalogue actually gets taught. */
    // Naming the lines off a grocery receipt is the part that decides whether price
    // tracking ever gets used. Twenty lines × one dialog each is why it doesn't, so this
    // is built for volume: everything on screen at once, the confident matches
    // pre-selected so the common case is read-and-confirm, and a way to bin the lines
    // that were never products at all.
    const CONFIDENT = 0.72;   // below this the model's guess is not worth pre-ticking

    async function openReviewQueue() {
      const holder = el('div', { class: 'fin-review' }, el('p', { class: 'empty sm' }, 'Loading…'));
      const dlg = modal({
        // xl, not wide: a grocery receipt is a dozen-plus lines, each needing its raw
        // name AND its suggestion chips on one row. At 680px the chips overflow the box.
        title: 'Name these lines', xl: true,
        sub: 'Each one you settle becomes permanent — the same printed name is never asked about again.',
        body: holder, actions: [{ label: 'Done', value: true }],
      });

      // rawName → chosen itemId ('' = undecided, '·drop' = not a product)
      const picks = new Map();
      let rows = [];

      const paint = async (refetch = true) => {
        if (refetch) {
          rows = await get('/finance/items/unresolved?limit=120');
          picks.clear();
          // Pre-tick only what the matcher is actually confident about — a wrong
          // pre-selection that gets confirmed in bulk is worse than no help at all.
          for (const r of rows) {
            const top = r.suggestions?.[0];
            if (top && top.score >= CONFIDENT) picks.set(r.rawName, top.id);
          }
        }
        holder.innerHTML = '';
        if (!rows.length) {
          holder.append(el('p', { class: 'fin-teach-hint' }, 'Nothing left to name.'));
          return;
        }
        const chosen = [...picks.values()].filter(v => v && v !== '·drop').length;
        const binned = [...picks.values()].filter(v => v === '·drop').length;

        holder.append(
          el('div', { class: 'fin-review-bar' },
            el('span', { class: 'fin-review-count' },
              `${rows.length} printed name${rows.length === 1 ? '' : 's'} · `,
              el('strong', {}, `${chosen} matched`),
              binned ? `, ${binned} to discard` : ''),
            el('span', { class: 'grow' }),
            el('button', {
              class: 'btn sm', title: 'Tick every suggestion the matcher is confident about',
              onclick: () => {
                for (const r of rows) {
                  const top = r.suggestions?.[0];
                  if (top && top.score >= CONFIDENT && !picks.get(r.rawName)) picks.set(r.rawName, top.id);
                }
                paint(false);
              },
            }, 'Tick confident'),
            el('button', { class: 'btn sm ghost', onclick: () => { picks.clear(); paint(false); } }, 'Clear'),
            el('button', {
              class: 'btn sm primary', disabled: !chosen && !binned,
              onclick: () => commit(),
            }, `Apply ${chosen + binned}`)),
          el('ul', { class: 'fin-review-list' }, rows.map(r => reviewRow(r, picks, () => paint(false)))));
      };

      const commit = async () => {
        const pairs = [];
        const drop = [];
        for (const r of rows) {
          const v = picks.get(r.rawName);
          if (!v) continue;
          if (v === '·drop') drop.push(...r.purchaseIds);
          // assignPurchase files every sibling sharing the printed name, so one id per group
          else pairs.push({ purchaseId: r.purchaseIds[0], itemId: v });
        }
        try {
          let filed = 0, dropped = 0;
          if (pairs.length) filed = (await post('/finance/purchases/assign', { pairs })).assigned;
          if (drop.length) dropped = (await post('/finance/purchases/drop', { ids: drop })).dropped;
          toast(`Filed ${filed} line${filed === 1 ? '' : 's'}`
            + (dropped ? ` · discarded ${dropped}` : ''), 'ok');
          await paint();
        } catch (e) { toast(e.message, 'err'); }
      };

      await paint();
      await dlg;
      if (S.tab === 'items') refresh();
    }

    function reviewRow(r, picks, redraw) {
      const chosen = picks.get(r.rawName) || '';
      const pick = (v) => { if (picks.get(r.rawName) === v) picks.delete(r.rawName); else picks.set(r.rawName, v); redraw(); };
      const named = chosen && chosen !== '·drop'
        ? (r.suggestions.find(s => s.id === chosen)?.nameEn || 'chosen')
        : '';

      return el('li', { class: 'fin-review-row' + (chosen ? ' is-set' : '') + (chosen === '·drop' ? ' is-drop' : '') },
        el('div', { class: 'fin-review-main' },
          el('div', { class: 'fin-review-raw' }, r.rawName),
          el('div', { class: 'fin-review-meta' },
            `${r.count}× · ${r.merchants.join(', ') || 'unknown shop'} · last ${r.lastDate}`,
            named ? el('span', { class: 'fin-review-picked' }, ' → ' + named) : null)),
        el('div', { class: 'fin-review-actions' },
          r.suggestions.map(s => el('button', {
            class: 'fin-chip' + (chosen === s.id ? ' is-on' : ''),
            title: `${Math.round(s.score * 100)}% match${s.score >= CONFIDENT ? ' — confident' : ''}`,
            onclick: () => pick(s.id),
          }, s.nameEn, s.score >= CONFIDENT ? null : el('span', { class: 'fin-suggest-weak' }, ` ${Math.round(s.score * 100)}%`))),
          el('button', {
            class: 'fin-chip', title: 'Create a catalogue entry for this line',
            onclick: async () => {
              const created = await openItemEditor(null, { seedName: r.rawName });
              if (created) { picks.set(r.rawName, created.id); redraw(); }
            },
          }, '+ New'),
          el('button', {
            class: 'fin-chip is-drop' + (chosen === '·drop' ? ' is-on' : ''),
            title: 'This was never a product — discard the price observations',
            onclick: () => pick('·drop'),
          }, 'Not a product')));
    }

    /** Create or edit a catalogue entry. Resolves to the saved item. */
    async function openItemEditor(item = null, { seedName = '' } = {}) {
      const isEdit = !!item?.id;
      const f = {
        nameEn: el('input', { class: 'input', value: item?.nameEn || '', placeholder: 'Milk' }),
        nameJa: el('input', { class: 'input', value: item?.nameJa || '', placeholder: '牛乳' }),
        category: el('input', { class: 'input', list: 'fin-item-cats', value: item?.category || 'Groceries' }),
        subcategory: el('input', { class: 'input', value: item?.subcategory || '', placeholder: 'Dairy' }),
        unit: el('select', { class: 'input' },
          el('option', { value: 'each' }, 'each — countable'),
          el('option', { value: 'ml' }, 'ml — liquids'),
          el('option', { value: 'g' }, 'g — by weight')),
        typicalSize: el('input', { class: 'input', type: 'number', value: item?.typicalSize || '', placeholder: '1000' }),
      };
      f.unit.value = item?.unit || 'each';
      const cats = S.itemsData?.categories || [];

      const ok = await modal({
        title: isEdit ? `Edit "${item.nameEn}"` : 'New item',
        sub: seedName
          ? `Printed as "${seedName}" — give it the generic name, without the brand.`
          : 'Keep the name generic and brand-free: "Milk", not "Yamada Milk".',
        body: el('div', { class: 'fin-form' },
          el('datalist', { id: 'fin-item-cats' }, cats.map(c => el('option', { value: c }))),
          row('English', f.nameEn), row('Japanese', f.nameJa),
          row('Category', f.category), row('Sub', f.subcategory),
          row('Sold by', f.unit), row('Usual size', f.typicalSize)),
        actions: [{ label: 'Cancel', value: false }, { label: isEdit ? 'Save' : 'Create', value: true, kind: 'primary' }],
      });
      if (!ok) return null;
      const payload = {
        nameEn: f.nameEn.value, nameJa: f.nameJa.value, category: f.category.value,
        subcategory: f.subcategory.value, unit: f.unit.value, typicalSize: Number(f.typicalSize.value) || 0,
      };
      try {
        const saved = isEdit
          ? await patch(`/finance/items/${item.id}`, payload)
          : await post('/finance/items', payload);
        toast(isEdit ? 'Saved' : 'Item created', 'ok');
        if (S.tab === 'items') { await loadItems(); render(); }
        return saved;
      } catch (e) { toast(e.message, 'err'); return null; }
    }

    // ---------- ledger ----------
    function txnTable(items, { compact: isCompact = false } = {}) {
      const table = el('table', { class: 'fin-table' });
      table.append(el('thead', {}, el('tr', {},
        el('th', {}, 'Date'), el('th', {}, 'Description'), el('th', {}, 'Category'),
        el('th', { class: 'num' }, 'Amount'), isCompact ? null : el('th', { class: 'fin-th-act' }, ''))));
      const tbody = el('tbody', {});
      for (const t of items) {
        tbody.append(el('tr', {
          class: t.kind === 'income' ? 'is-in' : 'is-out', dataset: { date: t.date },
          ondblclick: () => openTxnEditor(t),
        },
          el('td', { class: 'fin-date' }, t.date.slice(5)),
          el('td', {},
            el('span', { class: 'fin-merchant' }, t.merchant || t.note || '—'),
            t.merchant && t.note ? el('span', { class: 'fin-note' }, t.note) : null,
            t.source !== 'manual' ? el('span', { class: 'fin-src', title: `added by ${t.source}` }, t.source) : null),
          el('td', {}, el('span', { class: 'fin-cat' }, t.category)),
          el('td', { class: 'num fin-amount' },
            (t.kind === 'income' ? '+' : '−') + Number(t.amountBase).toLocaleString('en-US', { maximumFractionDigits: 0 }),
            t.currency !== S.currency ? el('span', { class: 'fin-orig' }, `${t.amount} ${t.currency}`) : null),
          isCompact ? null : el('td', { class: 'fin-row-actions' },
            el('button', {
              class: 'btn ghost xs', title: 'Actions',
              onclick: (ev) => {
                const r = ev.currentTarget.getBoundingClientRect();
                menu(r.left - 120, r.bottom, [
                  { label: 'Edit', icon: 'edit', onclick: () => openTxnEditor(t) },
                  { label: 'Duplicate to today', icon: 'plus', onclick: () => openTxnEditor({ ...t, id: null, date: todayStr() }) },
                  '-',
                  { label: 'Delete', icon: 'trash', danger: true, onclick: () => removeTxn(t) },
                ]);
              },
            }, icon('edit'))),
        ));
      }
      table.append(tbody);
      return el('div', { class: 'fin-scroll' }, table);
    }

    function renderLedger() {
      const searchBox = el('input', {
        class: 'input sm fin-search', placeholder: 'Search merchant, note or category…', value: S.search,
        oninput: debounce(async (ev) => { S.search = ev.target.value.trim(); await loadLedger(); render(); }, 250),
      });
      const kindSel = el('select', {
        class: 'input sm', onchange: async () => { S.kindFilter = kindSel.value; await loadLedger(); render(); },
      }, el('option', { value: '' }, 'Everything'), el('option', { value: 'expense' }, 'Expenses'), el('option', { value: 'income' }, 'Income'));
      kindSel.value = S.kindFilter;

      const l = S.ledger;
      const shownTotal = l ? l.items.reduce((s, t) => s + (t.kind === 'expense' ? t.amountBase : -t.amountBase), 0) : 0;

      content.append(
        el('div', { class: 'fin-toolbar' }, searchBox, kindSel,
          S.search || S.kindFilter
            ? el('button', {
              class: 'btn ghost sm', onclick: async () => { S.search = ''; S.kindFilter = ''; await loadLedger(); render(); },
            }, 'Clear')
            : null,
          el('span', { class: 'grow' }),
          l ? el('span', { class: 'fin-count' }, `${l.total} row${l.total === 1 ? '' : 's'} · net out ${money(shownTotal)}`) : null,
          el('button', { class: 'btn sm ghost', onclick: exportCsv }, icon('download'), 'CSV')),
        l && l.items.length
          ? txnTable(l.items)
          : teach('Nothing matches.', S.search ? 'Try a shorter search, or widen the period.' : 'Add a transaction, or scan a receipt.'),
      );
      if (S.search) { searchBox.focus(); searchBox.setSelectionRange(S.search.length, S.search.length); }
    }

    // ---------- plan ----------
    function renderPlan() {
      const d = S.data, g = d.goal;
      const minI = el('input', { class: 'input sm', type: 'number', value: g.minGoal || '' });
      const majI = el('input', { class: 'input sm', type: 'number', value: g.majorGoal || '' });
      const mainC = el('input', { type: 'checkbox', checked: g.includeMainJob });

      content.append(el('div', { class: 'fin-grid' },
        card('Monthly side-income goal', el('div', {},
          el('div', { class: 'fin-goal-row' },
            el('label', {}, 'Minimum', minI),
            el('label', {}, 'Stretch', majI),
            el('label', { class: 'fin-check' }, mainC, 'Count main-job income'),
            el('button', {
              class: 'btn sm primary',
              onclick: async () => {
                try {
                  await put('/finance/goal', {
                    month: g.month, minGoal: Number(minI.value) || 0,
                    majorGoal: Number(majI.value) || 0, includeMainJob: mainC.checked,
                  });
                  toast('Goal saved', 'ok'); refresh();
                } catch (e) { toast(e.message, 'err'); }
              },
            }, 'Save')),
          g.minGoal || g.majorGoal
            ? meter(g.progress, g.minGoal || g.majorGoal, { stretch: g.majorGoal, format: money })
            : el('p', { class: 'fin-teach-hint' }, 'Set a target to track progress on the Overview.'),
        ), 'span2'),

        card('Category budgets', el('div', {},
          d.budgets.items.length
            ? el('ul', { class: 'fin-budget-list' }, d.budgets.items.map(b =>
              el('li', { class: b.over ? 'is-over' : '' },
                el('div', { class: 'fin-budget-head' },
                  el('span', { class: 'fin-budget-name' }, b.category),
                  el('span', { class: 'fin-budget-fig' }, `${money(b.spent)} of ${money(b.amount)}`),
                  el('button', {
                    class: 'btn ghost xs', title: 'Remove budget',
                    onclick: async () => { await del(`/finance/budgets/${b.id}`); toast('Budget removed'); refresh(); },
                  }, icon('trash'))),
                meter(b.spent, b.amount, { format: money, danger: b.over }))))
            : el('p', { class: 'fin-teach-hint' }, 'No caps set. A budget turns a category into a meter on the Overview.'),
          el('button', { class: 'btn sm', onclick: openBudgetEditor }, icon('plus'), 'Add budget'),
        )),

        card('Quick-log presets', el('div', {},
          d.presets.length
            ? el('ul', { class: 'fin-preset-list' }, d.presets.map(p =>
              el('li', {},
                el('div', { class: 'fin-preset-main' },
                  el('span', { class: 'fin-preset-name' }, p.name),
                  el('span', { class: 'fin-preset-meta' },
                    `${p.amount} ${p.currency}${p.payUnit === 'hour' ? '/hr' : p.payUnit === 'minute' ? '/min' : ''} · ${p.category}${p.uses ? ` · ${p.uses}×` : ''}`)),
                el('button', { class: 'btn sm primary', onclick: () => logPreset(p) }, 'Log'),
                el('button', {
                  class: 'btn ghost xs', title: 'Delete preset',
                  onclick: async () => {
                    if (!await confirmBox(`Delete preset "${p.name}"?`, 'Transactions already logged from it are kept.')) return;
                    await del(`/finance/presets/${p.id}`); toast('Preset deleted'); refresh();
                  },
                }, icon('trash')))))
            : el('p', { class: 'fin-teach-hint' }, 'Presets are one-tap entries for anything you log repeatedly — a shift, a commute, a coffee.'),
          el('button', { class: 'btn sm', onclick: openPresetEditor }, icon('plus'), 'Add preset'),
        )),

        card('Recurring', el('div', { class: 'fin-recurring-slot' }, el('p', { class: 'empty sm' }, 'Loading…')), 'span2'),
      ));
      loadRecurring(content.querySelector('.fin-recurring-slot'));
    }

    async function loadRecurring(slot) {
      try {
        const list = await get('/finance/recurring');
        slot.innerHTML = '';
        slot.append(
          list.length
            ? el('ul', { class: 'fin-preset-list' }, list.map(r =>
              el('li', { class: r.active ? '' : 'is-off' },
                el('div', { class: 'fin-preset-main' },
                  el('span', { class: 'fin-preset-name' }, r.name),
                  el('span', { class: 'fin-preset-meta' },
                    `${r.amount} ${r.currency} · ${r.cadence} on day ${r.day} · ${r.category}${r.lastRun ? ` · last ${r.lastRun}` : ' · never run'}`)),
                el('button', {
                  class: 'btn ghost xs', title: r.active ? 'Pause' : 'Resume',
                  onclick: async () => { await patch(`/finance/recurring/${r.id}`, { active: !r.active }); loadRecurring(slot); },
                }, r.active ? icon('stop') : icon('play')),
                el('button', {
                  class: 'btn ghost xs', title: 'Delete',
                  onclick: async () => {
                    if (!await confirmBox(`Delete "${r.name}"?`, 'Already-posted entries are kept.')) return;
                    await del(`/finance/recurring/${r.id}`); loadRecurring(slot);
                  },
                }, icon('trash')))))
            : el('p', { class: 'fin-teach-hint' }, 'Rent, subscriptions, a standing transfer — added automatically, and never twice for the same period.'),
          el('div', { class: 'fin-recurring-actions' },
            el('button', { class: 'btn sm', onclick: openRecurringEditor }, icon('plus'), 'Add recurring'),
            list.some(r => r.active) ? el('button', {
              class: 'btn sm ghost',
              onclick: async () => {
                try {
                  const dry = await post('/finance/recurring/run', { dryRun: true });
                  if (!dry.pending.length) return toast('Nothing due', 'ok');
                  const ok = await confirmBox(`Post ${dry.pending.length} due entr${dry.pending.length === 1 ? 'y' : 'ies'}?`,
                    dry.pending.map(p => `${p.date} · ${p.name} · ${p.amount}`).join('\n'), 'Post', 'primary');
                  if (!ok) return;
                  const r = await post('/finance/recurring/run', {});
                  toast(`Posted ${r.created}`, 'ok'); refresh();
                } catch (e) { toast(e.message, 'err'); }
              },
            }, 'Run due now') : null),
        );
      } catch (e) {
        slot.innerHTML = '';
        slot.append(el('p', { class: 'empty sm' }, e.message));
      }
    }

    // ---------- receipts ----------
    //
    // A vision model reading a crumpled thermal receipt gets most lines right and then
    // invents one. So the scan is a DRAFT, never a result: every field is editable before
    // anything reaches the ledger, and the arithmetic check tells you where to look —
    // if the lines add up to more than the subtotal, the surplus is very likely a line
    // that isn't on the paper. What you fix is remembered per shop (server/receipts.js
    // learnFix), so the same phantom line is dropped for you next time.

    // Which receipts are expanded, and the in-progress edit for each. Kept on the app
    // state (not the DOM) so a background refresh can't discard half-typed corrections.
    S.openReceipts = S.openReceipts || {};

    /** The reconciliation banner — the single most useful thing on this screen. */
    function checkBanner(chk, currency) {
      if (!chk) return null;
      const m = (n) => `${currency || S.currency} ${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
      if (chk.verdict === 'balanced') {
        return el('div', { class: 'fin-chk is-ok' }, icon('check'),
          el('span', {}, `The lines add up to ${m(chk.itemsSum)} — that matches the receipt.`));
      }
      if (chk.verdict === 'no-items') {
        return el('div', { class: 'fin-chk is-warn' }, icon('eye'),
          el('span', {}, 'No line items were read. Only the total will be logged — add lines below if you want per-item prices tracked.'));
      }
      if (chk.verdict === 'unchecked') {
        return el('div', { class: 'fin-chk is-warn' }, icon('eye'),
          el('span', {}, `No subtotal was printed, so the lines can't be cross-checked. They come to ${m(chk.itemsSum)}.`));
      }
      const over = chk.delta > 0;
      return el('div', { class: 'fin-chk is-bad' }, icon('shield'),
        el('span', {},
          el('strong', {}, over ? `${m(Math.abs(chk.delta))} too much. ` : `${m(Math.abs(chk.delta))} missing. `),
          over
            ? `The lines come to ${m(chk.itemsSum)} but the receipt says ${m(chk.expected)}. Look for a line that isn't on the paper — a surplus this exact is usually one invented item.`
            : `The lines come to ${m(chk.itemsSum)} but the receipt says ${m(chk.expected)}. A line was probably missed — add it below.`));
    }

    /** The editable draft for one receipt. */
    function receiptEditor(r) {
      const draft = S.openReceipts[r.id];
      const cats = S.categories?.expense || [];
      const wrap = el('div', { class: 'fin-rc-edit' });

      const redraw = () => {
        // Recompute the check locally so the banner reacts as you type, without a
        // round trip. The server recomputes it authoritatively on save.
        const sum = draft.items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
        const expected = draft.subtotal ?? (draft.total != null && draft.tax != null ? draft.total - draft.tax : draft.total);
        const delta = Math.round((sum - (expected ?? sum)) * 100) / 100;
        const tol = Math.max(1, Math.abs(expected ?? 0) * 0.01);
        draft.check = !draft.items.length ? { verdict: 'no-items', itemsSum: 0, expected, delta: 0 }
          : expected == null ? { verdict: 'unchecked', itemsSum: sum, expected: null, delta: 0 }
            : Math.abs(delta) <= tol ? { verdict: 'balanced', itemsSum: sum, expected, delta }
              : { verdict: delta > 0 ? 'overshoot' : 'short', itemsSum: sum, expected, delta };
        wrap.innerHTML = '';
        wrap.append(body());
      };

      const num = (obj, key, opts = {}) => el('input', {
        class: 'input xs num', type: 'number', step: opts.step || '1', min: '0',
        value: obj[key] ?? '',
        oninput: (e) => {
          const v = e.target.value.trim();
          obj[key] = v === '' ? null : Number(v);
          if (opts.live) redraw();
        },
      });

      const body = () => el('div', {},
        checkBanner(draft.check, draft.currency),

        draft.learned?.length
          ? el('div', { class: 'fin-chk is-learn' }, icon('sparkle'),
            el('span', {}, `Applied what you taught it: `,
              ...draft.learned.map(l => el('code', {}, l.kind === 'drop' ? `dropped “${l.line}”` : `renamed “${l.line}” → ${l.to}`))))
          : null,
        draft.dropped?.length
          ? el('div', { class: 'fin-chk is-warn' }, icon('eye'),
            el('span', {}, `Removed automatically: `,
              ...draft.dropped.map(d => el('code', {}, `${d.name} ${d.amount} (${d.why})`)),
              ' — add it back below if it was real.'))
          : null,

        // header fields
        el('div', { class: 'fin-rc-head' },
          el('label', { class: 'wide' }, el('span', {}, 'Shop'),
            el('input', { class: 'input xs', value: draft.merchant || '', oninput: e => { draft.merchant = e.target.value; } })),
          el('label', {}, el('span', {}, 'Date'),
            el('input', { class: 'input xs', type: 'date', value: draft.date || '', oninput: e => { draft.date = e.target.value; } })),
          el('label', {}, el('span', {}, 'Subtotal'), num(draft, 'subtotal', { live: true })),
          el('label', {}, el('span', {}, 'Tax'), num(draft, 'tax', { live: true })),
          el('label', {}, el('span', {}, 'Total'), num(draft, 'total', { live: true }))),

        cats.length
          ? el('div', { class: 'fin-chips' }, cats.map(c => el('button', {
            class: 'fin-chip' + (c === draft.category ? ' is-on' : ''),
            onclick: () => { draft.category = c; redraw(); },
          }, c)))
          : null,

        // line items
        el('table', { class: 'fin-rc-lines' },
          el('thead', {}, el('tr', {},
            el('th', {}, 'Printed on the receipt'), el('th', {}, 'Item'),
            el('th', { class: 'num' }, 'Qty'), el('th', { class: 'num' }, 'Amount'), el('th', {}))),
          el('tbody', {}, draft.items.length
            ? draft.items.map((it, i) => el('tr', { class: it.warn?.length ? 'is-suspect' : '' },
              el('td', {}, el('code', { class: 'fin-rc-printed', title: it.printed || '' }, it.printed || '—')),
              el('td', {},
                el('input', { class: 'input xs', value: it.name || '', oninput: e => { it.name = e.target.value; } }),
                it.warn?.length ? el('div', { class: 'fin-rc-warn' }, it.warn.join(' · ')) : null),
              el('td', { class: 'num' }, num(it, 'qty')),
              el('td', { class: 'num' }, num(it, 'amount', { live: true })),
              el('td', {}, el('button', {
                class: 'btn ghost xs', title: 'Not on the receipt — remove it',
                onclick: () => { draft.items.splice(i, 1); redraw(); },
              }, icon('trash')))))
            : [el('tr', {}, el('td', { colspan: '5', class: 'muted' }, 'No lines. Add one, or just log the total.'))])),

        el('div', { class: 'fin-rc-actions' },
          el('button', {
            class: 'btn sm', onclick: () => {
              draft.items.push({ printed: '', name: '', qty: 1, amount: null });
              redraw();
            },
          }, icon('plus'), 'Add a line'),
          el('span', { class: 'grow' }),
          el('button', { class: 'btn sm', onclick: () => saveDraft(r, false) }, 'Save corrections'),
          el('button', {
            class: 'btn sm primary', title: 'One ledger row for the whole receipt',
            onclick: () => saveDraft(r, 'total'),
          }, `Log ${money(draft.total)}`),
          draft.items.length > 1
            ? el('button', {
              class: 'btn sm', title: 'One ledger row per line item',
              onclick: () => saveDraft(r, 'items'),
            }, `Split ${draft.items.length}`)
            : null),

        r.edited
          ? el('div', { class: 'fin-rc-note' }, 'You have already corrected this scan; the model’s original reading is kept for comparison.')
          : null);

      redraw();
      return wrap;
    }

    /** Pull an applied receipt back out of the ledger and open it for correction. */
    async function revertReceipt(r) {
      const n = (r.txnIds || []).length;
      const ok = await confirmBox(
        'Take this receipt back out of the ledger?',
        `Its ${n} row${n === 1 ? '' : 's'} and the prices recorded from it will be removed, and the scan `
        + 'reopens for editing. Nothing else in the ledger is touched.',
        'Undo & edit');
      if (!ok) return;
      try {
        const res = await post(`/finance/receipts/${r.id}/revert`, {});
        toast(`Removed ${res.undone.transactions} row${res.undone.transactions === 1 ? '' : 's'}`, 'ok');
        S.receipts = await get('/finance/receipts?limit=30');
        const fresh = S.receipts.find(x => x.id === r.id);
        if (fresh?.parsed) S.openReceipts[r.id] = JSON.parse(JSON.stringify({ items: [], ...fresh.parsed }));
        await refresh();
      } catch (e) { toast(e.message, 'err'); }
    }

    /** Persist the draft, then optionally post it to the ledger. */
    async function saveDraft(r, applyMode) {
      const draft = S.openReceipts[r.id];
      try {
        const payload = {
          merchant: draft.merchant, date: draft.date, category: draft.category,
          subtotal: draft.subtotal, tax: draft.tax, total: draft.total,
          currency: draft.currency, time: draft.time, paymentMethod: draft.paymentMethod,
          items: draft.items
            .filter(it => (it.name || '').trim() && Number(it.amount) > 0)
            .map(it => ({ printed: it.printed || it.name, name: it.name, qty: it.qty || 1, amount: it.amount })),
        };
        await patch(`/finance/receipts/${r.id}`, payload);
        if (!applyMode) {
          toast('Corrections saved', 'ok');
          delete S.openReceipts[r.id];
        } else {
          const res = await post(`/finance/receipts/${r.id}/apply`, { mode: applyMode });
          const n = res.learned?.learned || 0;
          toast(`Added ${res.created.length} row${res.created.length === 1 ? '' : 's'}`
            + (n ? ` · learned ${n} correction${n === 1 ? '' : 's'}` : ''), 'ok');
          delete S.openReceipts[r.id];
        }
        S.receipts = await get('/finance/receipts?limit=30');
        await refresh();
      } catch (e) { toast(e.message, 'err'); }
    }

    function renderReceipts() {
      const list = S.receipts || [];
      content.append(
        el('div', { class: 'fin-toolbar' },
          el('button', { class: 'btn sm primary', onclick: openReceiptFlow }, icon('sparkle'), 'Scan a receipt'),
          el('span', { class: 'fin-count' }, 'Read on this machine by the local vision model — no image leaves the network. Check it before it lands in the ledger.')),
        list.length
          ? el('ul', { class: 'fin-receipt-list' }, list.map(r => {
            const p = r.parsed || {};
            const items = p.items || [];
            const suspect = p.check && p.check.ok === false;
            const open = !!S.openReceipts[r.id];
            return el('li', { class: 'fin-receipt is-' + r.status + (suspect ? ' is-suspect' : '') + (open ? ' is-open' : '') },
              el('div', { class: 'fin-receipt-row' },
                r.uploadId
                  ? el('a', { href: mediaUrl(`/uploads/${r.uploadId}`), target: '_blank', rel: 'noopener', title: 'Open the photo full size' },
                    el('img', { class: 'fin-receipt-thumb', src: mediaUrl(`/uploads/${r.uploadId}`), alt: '', loading: 'lazy' }))
                  : null,
                el('div', { class: 'fin-receipt-main' },
                  el('div', { class: 'fin-receipt-title' },
                    p.merchant || (r.status === 'failed' ? 'Could not read' : 'Unread'),
                    suspect ? el('span', { class: 'fin-badge is-bad', title: 'The line items do not match the total' }, 'check me') : null,
                    r.edited ? el('span', { class: 'fin-badge', title: 'You corrected this scan' }, 'edited') : null),
                  el('div', { class: 'fin-receipt-meta' },
                    r.status === 'failed' ? r.error
                      : `${p.date || ''} · ${money(p.total)} · ${items.length} item${items.length === 1 ? '' : 's'}${r.status === 'applied' ? ' · in the ledger' : ''}`)),
                r.status === 'parsed'
                  ? el('div', { class: 'fin-receipt-actions' },
                    el('button', {
                      class: 'btn sm' + (suspect || open ? ' primary' : ''),
                      onclick: () => {
                        if (open) delete S.openReceipts[r.id];
                        // Deep-copy so edits are discardable and a refresh can't stomp them.
                        else S.openReceipts[r.id] = JSON.parse(JSON.stringify({ items: [], ...p }));
                        render();
                      },
                    }, icon(open ? 'chevD' : 'edit'), open ? 'Close' : 'Review & edit'),
                    !open ? el('button', { class: 'btn sm', title: 'One row for the receipt total', onclick: () => applyReceipt(r, 'total') }, 'Log total') : null)
                  : null,
                // Already logged, and you have just spotted a line that shouldn't be there.
                // Editing the ledger row alone would fix the total but leave the scan wrong
                // and teach the scanner nothing — so this puts it back in the editor.
                r.status === 'applied'
                  ? el('div', { class: 'fin-receipt-actions' },
                    el('button', {
                      class: 'btn sm', title: 'Remove its rows from the ledger and reopen it for correction',
                      onclick: () => revertReceipt(r),
                    }, icon('refresh'), 'Undo & edit'))
                  : null,
                el('button', {
                  class: 'btn ghost xs', title: 'Delete this scan',
                  onclick: async () => {
                    await del(`/finance/receipts/${r.id}`);
                    delete S.openReceipts[r.id];
                    S.receipts = await get('/finance/receipts?limit=30'); render();
                  },
                }, icon('trash'))),
              open ? receiptEditor(r) : null);
          }))
          : teach('No receipts yet.', 'Photograph one and the local model pulls out the merchant, date, items and total. You get to check it before anything is logged.'));
    }

    // ---------- editors ----------
    const row = (label, node) => el('label', { class: 'fin-form-row' }, el('span', {}, label), node);

    async function openTxnEditor(txn = null) {
      const isEdit = !!txn?.id;
      const cats = [...S.categories.expense, ...S.categories.income];
      const f = {
        kind: el('select', { class: 'input' }, el('option', { value: 'expense' }, 'Expense'), el('option', { value: 'income' }, 'Income')),
        amount: el('input', { class: 'input', type: 'number', step: '0.01', placeholder: '0' }),
        currency: el('input', { class: 'input', value: txn?.currency || S.currency, maxlength: 3 }),
        date: el('input', { class: 'input', type: 'date', value: txn?.date || todayStr() }),
        category: el('input', { class: 'input', list: 'fin-cats', value: txn?.category || '' }),
        merchant: el('input', { class: 'input', value: txn?.merchant || '', placeholder: 'Shop, employer…' }),
        note: el('input', { class: 'input', value: txn?.note || '', placeholder: 'Optional' }),
      };
      f.kind.value = txn?.kind || 'expense';
      if (txn?.amount) f.amount.value = txn.amount;

      const ok = await modal({
        title: isEdit ? 'Edit transaction' : 'Add transaction',
        body: el('div', { class: 'fin-form' },
          el('datalist', { id: 'fin-cats' }, cats.map(c => el('option', { value: c }))),
          row('Type', f.kind), row('Amount', f.amount), row('Currency', f.currency),
          row('Date', f.date), row('Category', f.category), row('Merchant', f.merchant), row('Note', f.note)),
        actions: [{ label: 'Cancel', value: false }, { label: isEdit ? 'Save' : 'Add', value: true, kind: 'primary' }],
      });
      if (!ok) return;
      const payload = {
        kind: f.kind.value, amount: Number(f.amount.value), currency: f.currency.value.toUpperCase(),
        date: f.date.value, category: f.category.value, merchant: f.merchant.value, note: f.note.value,
      };
      try {
        if (isEdit) await patch(`/finance/txns/${txn.id}`, payload);
        else await post('/finance/txns', payload);
        toast(isEdit ? 'Updated' : 'Added', 'ok');
        refresh();
      } catch (e) { toast(e.message, 'err'); }
    }

    async function removeTxn(t) {
      if (!await confirmBox('Delete this transaction?', `${t.date} · ${t.merchant || t.category} · ${money(t.amountBase)}`)) return;
      try { await del(`/finance/txns/${t.id}`); toast('Deleted'); refresh(); }
      catch (e) { toast(e.message, 'err'); }
    }

    async function openBudgetEditor() {
      const cat = el('input', { class: 'input', list: 'fin-cats-b', placeholder: 'Category' });
      const amt = el('input', { class: 'input', type: 'number', placeholder: 'Monthly cap' });
      const ok = await modal({
        title: 'Add budget', sub: 'Applies every month unless you set one for a specific month.',
        body: el('div', { class: 'fin-form' },
          el('datalist', { id: 'fin-cats-b' }, S.categories.expense.map(c => el('option', { value: c }))),
          row('Category', cat), row('Amount', amt)),
        actions: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, kind: 'primary' }],
      });
      if (!ok) return;
      try { await put('/finance/budgets', { category: cat.value, amount: Number(amt.value) }); toast('Budget set', 'ok'); refresh(); }
      catch (e) { toast(e.message, 'err'); }
    }

    async function openPresetEditor() {
      const name = el('input', { class: 'input', placeholder: 'e.g. Tutoring hour' });
      const amount = el('input', { class: 'input', type: 'number', step: '0.01' });
      const kind = el('select', { class: 'input' }, el('option', { value: 'income' }, 'Income'), el('option', { value: 'expense' }, 'Expense'));
      const unit = el('select', { class: 'input' }, ['flat', 'hour', 'minute'].map(u => el('option', { value: u }, u)));
      const cat = el('input', { class: 'input', list: 'fin-cats-p', placeholder: 'Category' });
      const ok = await modal({
        title: 'New quick-log preset',
        body: el('div', { class: 'fin-form' },
          el('datalist', { id: 'fin-cats-p' }, [...S.categories.income, ...S.categories.expense].map(c => el('option', { value: c }))),
          row('Name', name), row('Amount', amount), row('Type', kind), row('Per', unit), row('Category', cat)),
        actions: [{ label: 'Cancel', value: false }, { label: 'Create', value: true, kind: 'primary' }],
      });
      if (!ok) return;
      try {
        await post('/finance/presets', { name: name.value, amount: Number(amount.value), kind: kind.value, payUnit: unit.value, category: cat.value });
        toast('Preset created', 'ok'); refresh();
      } catch (e) { toast(e.message, 'err'); }
    }

    async function openRecurringEditor() {
      const name = el('input', { class: 'input', placeholder: 'e.g. Rent' });
      const amount = el('input', { class: 'input', type: 'number', step: '0.01' });
      const kind = el('select', { class: 'input' }, el('option', { value: 'expense' }, 'Expense'), el('option', { value: 'income' }, 'Income'));
      const cadence = el('select', { class: 'input' }, ['monthly', 'weekly', 'yearly'].map(c => el('option', { value: c }, c)));
      const day = el('input', { class: 'input', type: 'number', value: 1, min: 0, max: 31 });
      const cat = el('input', { class: 'input', list: 'fin-cats-r', placeholder: 'Category' });
      const ok = await modal({
        title: 'New recurring entry',
        sub: 'Posted when you press "Run due now" — never twice for the same period.',
        body: el('div', { class: 'fin-form' },
          el('datalist', { id: 'fin-cats-r' }, S.categories.expense.map(c => el('option', { value: c }))),
          row('Name', name), row('Amount', amount), row('Type', kind), row('Repeats', cadence),
          row('Day', day), row('Category', cat)),
        actions: [{ label: 'Cancel', value: false }, { label: 'Create', value: true, kind: 'primary' }],
      });
      if (!ok) return;
      try {
        await post('/finance/recurring', {
          name: name.value, amount: Number(amount.value), kind: kind.value,
          cadence: cadence.value, day: Number(day.value), category: cat.value,
        });
        toast('Recurring entry created', 'ok'); refresh();
      } catch (e) { toast(e.message, 'err'); }
    }

    async function logPreset(p) {
      const body = { date: todayStr() };
      const isFlat = p.payUnit === 'flat';
      const field = el('input', {
        class: 'input', type: 'number', value: isFlat ? 1 : 1,
        step: isFlat ? '1' : '0.25', min: isFlat ? '1' : '0.25',
      });
      const ok = await modal({
        title: `Log "${p.name}"`,
        body: el('div', { class: 'fin-form' }, row(isFlat ? 'How many' : p.payUnit === 'hour' ? 'Hours' : 'Minutes', field)),
        actions: [{ label: 'Cancel', value: false }, { label: 'Log', value: true, kind: 'primary' }],
      });
      if (!ok) return;
      if (isFlat) body.count = Number(field.value) || 1; else body.units = Number(field.value) || 1;
      try {
        const r = await post(`/finance/presets/${p.id}/log`, body);
        toast(`Logged ${r.created.length} entr${r.created.length === 1 ? 'y' : 'ies'}`, 'ok');
        refresh();
      } catch (e) { toast(e.message, 'err'); }
    }

    async function openReceiptFlow() {
      // IMAGE_ACCEPT, not 'image/*': iOS does not offer HEIC files in the Files branch
      // of its picker unless the extensions are named explicitly.
      const picker = el('input', { type: 'file', accept: IMAGE_ACCEPT, style: { display: 'none' } });
      document.body.append(picker);
      picker.onchange = async () => {
        const file = picker.files?.[0];
        picker.remove();
        if (!file) return;
        try {
          toast('Uploading…');
          const up = await uploadFile(file);
          toast('Reading the receipt — a few seconds…');
          const rec = await post('/finance/receipts/scan', { uploadId: up.id });
          if (rec.status !== 'parsed') toast(rec.error || 'Could not read that receipt', 'err');
          else toast(`Read ${rec.parsed.merchant || 'receipt'} · ${money(rec.parsed.total)}`, 'ok');
          S.tab = 'receipts'; paintTabs();
          S.receipts = await get('/finance/receipts?limit=30');
          render();
        } catch (e) { toast(e.message, 'err'); }
      };
      picker.click();
    }

    async function applyReceipt(r, mode) {
      try {
        const res = await post(`/finance/receipts/${r.id}/apply`, { mode });
        toast(`Added ${res.created.length} transaction${res.created.length === 1 ? '' : 's'}`, 'ok');
        S.receipts = await get('/finance/receipts?limit=30');
        render();
      } catch (e) { toast(e.message, 'err'); }
    }

    function exportCsv() {
      const items = S.ledger?.items || [];
      if (!items.length) return toast('Nothing to export', 'err');
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const head = ['date', 'kind', 'amount', 'currency', 'amountBase', 'category', 'merchant', 'note', 'source'];
      const csv = [head.join(','), ...items.map(t => head.map(k => esc(t[k])).join(','))].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const r = S.data.summary.range;
      const a = el('a', { href: url, download: `finances-${r.start}-to-${r.end}.csv` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    // Bar-label thinning depends on real pixel width, so re-render on resize.
    win._finResize = new ResizeObserver(debounce(() => {
      if (S.tab === 'overview' || S.tab === 'history') render();
    }, 220));
    win._finResize.observe(content);

    this.reopen = (w, o) => {
      if (o?.tab && TABS.some(t => t[0] === o.tab)) { S.tab = o.tab; paintTabs(); }
      refresh();
    };

    refresh();
  },

  unmount(win) {
    win._finResize?.disconnect();
    win._finResize = null;
  },
};
