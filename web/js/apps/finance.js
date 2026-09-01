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
  ['income', 'Income'],
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

/** Replace a node's children in place, skipping the nulls conditional children produce.
 *  Repainting one region instead of the whole panel is what keeps a focused input
 *  focused — replaceChildren alone rejects the nulls, so it needs this wrapper. */
const fill = (node, ...kids) => {
  node.replaceChildren(...kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false));
  return node;
};

/**
 * Put the caret in `node` once the browser has actually laid it out.
 *
 * Focus is only honoured on a node that is in the document, and the callers here focus a
 * field they have just built — inside a modal that is still being assembled, or a table
 * row appended microseconds ago. A frame's delay costs nothing perceptible and removes
 * the whole class of "focus() silently did nothing". `select()` on top, because every
 * caller is offering a field whose current contents are a starting point to replace
 * (a fresh 0, a carried-over rate), not something to append to.
 */
const focusSoon = (node) => {
  if (!node) return;
  requestAnimationFrame(() => {
    try { node.focus({ preventScroll: false }); node.select?.(); } catch { /* gone already */ }
  });
};

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
          if (S.tab === 'receipts') {
            [S.receipts, S.learning] = await Promise.all([
              get('/finance/receipts?limit=30'),
              // Never fatal: the scan list is the point of this tab, and losing the
              // "is it improving" strip must not take it down with it.
              get('/finance/receipt-learning').catch(() => null),
            ]);
          }
          if (S.tab === 'income') S.income = await get(`/finance/income?${qs()}`);
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
      // Typing in a search box re-runs the query and re-renders the whole tab, which
      // destroys the very field you are typing in — you get one word in, pause, and the
      // next keystroke goes nowhere. Both search boxes carry .fin-search, so remember
      // the caret across the rebuild instead of restructuring every tab around a
      // toolbar that survives it.
      const active = document.activeElement;
      const hadFocus = active?.classList.contains('fin-search') && content.contains(active);
      const caret = hadFocus ? [active.selectionStart, active.selectionEnd] : null;

      content.innerHTML = '';
      const view = {
        overview: renderOverview, history: renderHistory, items: renderItems,
        ledger: renderLedger, plan: renderPlan, receipts: renderReceipts, income: renderIncome,
      }[S.tab];
      if (!view) return;
      const ready = S.tab === 'history' ? S.yearData : S.tab === 'items' ? S.itemsData : S.data;
      if (!ready) return content.append(el('p', { class: 'empty' }, 'Loading…'));
      view();

      const next = hadFocus && content.querySelector('.fin-search');
      if (next) {
        next.focus();
        if (caret) next.setSelectionRange(caret[0], caret[1]);   // not jumped to the end
      }
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

    /**
     * The band the Overview now leads with: "am I on my goal" and "what is left to
     * spend", side by side and large.
     *
     * These were both small cards buried in the grid below the twelve-month chart,
     * which put a year of history above the two questions actually asked daily. The
     * arithmetic all happens server-side (finance.monthStatus) — including the part
     * that is easy to get wrong, which is that money already committed for later this
     * month is not money you still have.
     */
    function statusBand(st) {
      if (!st) return null;
      const sp = st.spend, g = st.goal;
      const live = st.isCurrent;

      // --- left to spend ---
      let spendCard;
      if (sp.basis === 'none') {
        spendCard = statusCard('Left to spend', '', teach('No budget set for this month.',
          'Add caps per category in Plan and this becomes a live "how much is left".'));
      } else {
        // A month is "tight" once the pace would blow the ceiling, and "over" once it
        // already has. Colour follows that, not the raw remaining figure — ¥20,000
        // left on the 3rd and on the 28th are not the same situation.
        const tone = sp.over ? 'is-over' : (live && sp.onTrack === false) ? 'is-tight' : 'is-good';
        const headline = sp.available;
        spendCard = statusCard(
          sp.over ? 'Over budget' : 'Left to spend', tone,
          el('div', {},
            el('div', { class: 'fin-status-value' + (headline < 0 ? ' is-neg' : '') },
              (headline < 0 ? '−' : '') + money(Math.abs(headline))),
            el('div', { class: 'fin-status-sub' },
              sp.basis === 'budget'
                ? `of ${money(sp.limit)} budgeted across ${sp.categoriesCovered} categor${sp.categoriesCovered === 1 ? 'y' : 'ies'}`
                : `of ${money(sp.limit)} that came in this month`),
            // A bare bar with its own caption: the default one reads "29,500 /
            // 60,000", which sat directly under a headline of "29,010" and made two
            // different quantities look like the same one mistyped.
            meter(sp.spent, sp.limit, { format: money, danger: sp.over, bare: true }),
            el('div', { class: 'fin-status-scale' },
              el('span', {}, `${money(sp.spent)} spent`),
              el('span', { class: 'muted' }, `of ${money(sp.limit)}`)),
            el('ul', { class: 'fin-status-facts' },
              live && sp.perDayLeft !== null
                ? fact(`${money(sp.perDayLeft)} a day for the ${st.days.left} day${st.days.left === 1 ? '' : 's'} left`)
                : null,
              sp.committed > 0
                ? fact(`${money(sp.committed)} still to come out`, 'is-warn',
                  sp.committedItems.map(c => `${c.name} · ${c.date.slice(5)}`).join('\n'))
                : null,
              live && sp.pace !== null
                ? fact(sp.spent > sp.pace
                  ? `${money(sp.spent - sp.pace)} ahead of an even pace`
                  : `${money(sp.pace - sp.spent)} behind an even pace — comfortable`,
                  sp.spent > sp.pace ? 'is-warn' : 'is-ok')
                : null,
              live && sp.onTrack === false
                ? fact(`On this pace the month ends at ${compact(sp.projected)}`, 'is-warn')
                : null)));
      }

      // --- goal ---
      let goalCard;
      if (!g.target) {
        goalCard = statusCard('Monthly goal', '', teach('No goal set.',
          'Set a monthly side-income target in Plan to track it here.'));
      } else {
        const tone = g.met ? 'is-good' : (live ? 'is-tight' : 'is-over');
        goalCard = statusCard(
          g.met ? (g.stretchMet ? 'Stretch goal met' : 'Goal met') : 'Goal', tone,
          el('div', {},
            el('div', { class: 'fin-status-value' },
              money(g.progress),
              el('span', { class: 'fin-status-badge ' + (g.met ? 'is-ok' : '') },
                g.met ? `${g.pct}%` : `${money(g.toGo)} to go`)),
            el('div', { class: 'fin-status-sub' },
              `${g.includeMainJob ? 'All income' : 'Side income'} against ${money(g.target)}`),
            meter(g.progress, g.target, { stretch: g.majorGoal, format: money, good: true }),
            el('ul', { class: 'fin-status-facts' },
              !g.met && live && g.perDayNeeded
                ? fact(`${money(g.perDayNeeded)} a day for the remaining ${st.days.left} day${st.days.left === 1 ? '' : 's'}`)
                : null,
              g.met && !g.stretchMet && g.majorGoal
                ? fact(`${money(g.majorGoal - g.progress)} to the ${money(g.majorGoal)} stretch target`)
                : null,
              g.stretchMet ? fact('Both targets cleared', 'is-ok') : null,
              !live ? fact(`${prettyMonth(st.month)} · closed`) : null)));
      }

      return el('div', { class: 'fin-status' }, spendCard, goalCard);
    }

    const statusCard = (label, tone, bodyNode) => el('section', { class: 'fin-status-card ' + (tone || '') },
      el('div', { class: 'fin-status-label' }, label), bodyNode);

    const fact = (text, cls = '', title = '') =>
      el('li', { class: cls || null, title: title || null }, text);

    /** Compact stat strip: the old hero, demoted so the band above it can lead. */
    function hero(s, deltaSpent) {
      const positive = s.net >= 0;
      const stat = (label, value, cls = '', extra = null) => el('div', { class: 'fin-strip-stat ' + cls },
        el('span', { class: 'fin-strip-label' }, label),
        el('span', { class: 'fin-strip-value' }, value), extra);
      return el('div', { class: 'fin-strip' },
        stat(positive ? 'Net saved' : 'Net shortfall', money(Math.abs(s.net)), positive ? '' : 'is-neg',
          s.savingsRate === null ? null : el('span', { class: 'fin-strip-note' }, `${s.savingsRate}% kept`)),
        stat('In', money(s.earned), 'is-in'),
        stat('Out', money(s.spent), 'is-out',
          deltaSpent !== null && deltaSpent !== undefined
            ? el('span', { class: 'fin-delta ' + (deltaSpent > 0 ? 'is-up' : deltaSpent < 0 ? 'is-down' : '') },
              deltaSpent === 0 ? 'same as last month'
                : `${deltaSpent > 0 ? '↑' : '↓'} ${compact(Math.abs(deltaSpent))} vs last month`)
            : null),
        stat('Per day', money(s.avgSpendPerDay)),
        stat('Entries', String(s.count)),
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
        // Goal vs what's left first, the totals underneath: the band answers "how am
        // I doing right now", the strip answers "out of what".
        statusBand(d.status),
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

          // Daily NET, not daily spend: on a freelance income the question each day
          // answers is "did I come out ahead", which spend alone cannot say.
          card(S.calendar ? 'Daily net' : 'Calendar', S.calendar
            ? calendarHeat(S.calendar.days.map(dy => ({ ...dy, value: dy.net })), {
              month: S.calendar.range.start.slice(0, 7), max: S.calendar.maxNet || S.calendar.max,
              format: money, signed: true,
              onPick: (dy) => { S.tab = 'ledger'; S.search = ''; paintTabs(); jumpToDay(dy.date); },
            })
            : el('p', { class: 'empty sm' }, '—')),

          card('Running net', daily.length
            ? areaLine(daily, { width: chartWidth(2), cumulative: true })
            : teach('Nothing recorded yet.', 'The line tracks your balance across the period.'), 'span2'),

          // The Goal card that used to sit here is now the right half of the status
          // band above — one goal shown twice on one screen is just noise.

          // Year to date, because a month in isolation cannot tell you whether the year
          // is working. This is also the number a tax return starts from.
          d.ytd ? card(`${d.ytd.year} so far`, el('div', { class: 'fin-ytd' },
            el('div', { class: 'fin-ytd-row' },
              el('span', {}, 'In'), el('strong', { class: 'is-in' }, money(d.ytd.earned))),
            el('div', { class: 'fin-ytd-row' },
              el('span', {}, 'Out'), el('strong', { class: 'is-out' }, money(d.ytd.spent))),
            el('div', { class: 'fin-ytd-row is-net' },
              el('span', {}, 'Net'),
              el('strong', { class: d.ytd.net < 0 ? 'is-neg' : '' },
                (d.ytd.net < 0 ? '−' : '+') + fmtNum(Math.abs(d.ytd.net)) + ' ' + S.currency)),
            el('div', { class: 'fin-ytd-meta' },
              `${d.ytd.days} days · ${money(d.ytd.perDay)}/day`,
              d.ytd.isCurrent ? ` · on track for ${compact(d.ytd.projectedNet)}` : '',
              d.ytd.hours ? ` · ${d.ytd.hours} h logged` : ''),
            el('button', { class: 'btn ghost xs', onclick: () => { S.tab = 'income'; paintTabs(); refresh(); } }, 'Income →')))
            : null,

          card('Budgets', d.budgets.items.length
            ? el('ul', { class: 'fin-budget-mini' }, d.budgets.items.slice(0, 5).map(b =>
              el('li', { class: b.over ? 'is-over' : '' },
                el('span', { class: 'fin-budget-name' }, b.category),
                meter(b.spent, b.amount, { format: money, danger: b.over }))))
            : teach('No budgets yet.', 'Caps per category live in Plan.')),

          // Work done but not yet paid for, kept visibly apart from every other number
          // on this screen: it is owed, not earned. Only shown once there is any.
          d.pending ? card('Expected · 想定', el('div', { class: 'fin-ytd' },
            el('div', { class: 'fin-ytd-row' },
              el('span', {}, 'Awaiting'),
              el('strong', {}, money(d.pending.open.total))),
            el('div', { class: 'fin-ytd-meta' },
              d.pending.open.count
                ? `${d.pending.open.count} estimate${d.pending.open.count === 1 ? '' : 's'}${d.pending.open.oldest ? ` · oldest ${d.pending.open.oldest}` : ''}`
                : 'Nothing outstanding'),
            d.pending.groups.length
              ? el('ul', { class: 'fin-kv' }, d.pending.groups.map(g => el('li', {},
                el('span', {}, g.payer),
                el('span', {}, `${money(g.total)} · ${g.count}`))))
              : null,
            d.pending.settled
              ? el('div', { class: 'fin-ytd-row is-net' },
                el('span', {}, 'Guessed vs paid'),
                el('strong', { class: d.pending.settled.variance < 0 ? 'is-neg' : '' },
                  `${d.pending.settled.variance >= 0 ? '+' : '−'}${fmtNum(Math.abs(d.pending.settled.variance))}` +
                  (d.pending.settled.biasPct === null ? '' : ` (${d.pending.settled.biasPct > 0 ? '+' : ''}${d.pending.settled.biasPct}%)`)))
              : null,
            el('button', { class: 'btn ghost xs', onclick: () => { S.tab = 'income'; paintTabs(); refresh(); } }, 'Record a payment →')))
            : null,
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
            ? meter(g.progress, g.minGoal || g.majorGoal, { stretch: g.majorGoal, format: money, good: true })
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

        card('Templates & quick-log', el('div', {},
          d.presets.length
            ? el('ul', { class: 'fin-preset-list' }, d.presets.map(p =>
              el('li', {},
                el('div', { class: 'fin-preset-main' },
                  el('span', { class: 'fin-preset-name' }, p.name,
                    p.isEstimate ? el('span', { class: 'fin-tag is-est' }, '想定') : null),
                  el('span', { class: 'fin-preset-meta' }, [
                    p.asksAmount
                      ? `asks for the amount${p.payUnit === 'flat' ? '' : ` and the ${p.payUnit}s`}`
                      : `${p.amount} ${p.currency}${p.payUnit === 'hour' ? '/hr' : p.payUnit === 'minute' ? '/min' : ''}`,
                    p.category, p.merchant || p.name, p.uses ? `${p.uses}×` : '',
                  ].filter(Boolean).join(' · '))),
                el('button', { class: 'btn sm primary', onclick: () => logPreset(p) }, 'Log'),
                el('button', { class: 'btn ghost xs', title: 'Edit template', onclick: () => openPresetEditor(p) }, icon('edit')),
                el('button', { class: 'btn ghost xs', title: 'Delete', onclick: () => removePreset(p) }, icon('trash')))))
            : el('p', { class: 'fin-teach-hint' }, 'A template answers everything about an income stream except the amount, so logging one is a click and a number. Leave its amount fixed instead and it logs on the click alone.'),
          el('button', { class: 'btn sm', onclick: () => openPresetEditor() }, icon('plus'), 'Add template'),
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

    // ---------- income ----------
    //
    // Freelance income is not "expenses with the sign flipped". The questions are
    // different — what came in today, from which client, for how many hours, and is the
    // year ahead or behind — so it gets its own surface rather than a filter on the
    // ledger. Everything here writes the same finance_txn rows the rest of the app reads,
    // so a logged hour immediately moves the Overview net, the goal meter and the YTD.

    /** How money can arrive. Each mode is a different arithmetic, not a different table. */
    const INCOME_MODES = [
      { id: 'amount', label: 'Amount', hint: 'A flat payment.' },
      { id: 'hourly', label: 'Hourly', hint: 'Hours worked × your rate. Records the hours, so effective rate is knowable later.' },
      { id: 'unit', label: 'Per item', hint: 'Pieces × price each — words, articles, lessons, deliveries.' },
      { id: 'fee', label: 'Gross − fee', hint: 'What the client paid minus the platform cut. Logs the net you actually keep.' },
    ];

    function renderIncome() {
      const d = S.income;
      if (!d) { content.append(el('p', { class: 'empty sm' }, 'Loading…')); return; }
      const s = d.summary, y = d.ytd, pend = d.pending;
      const monthly = d.monthly.items.map(m => ({ label: MONTH_NAMES[Number(m.month.slice(5, 7)) - 1], a: m.earned, b: m.spent, net: m.net }));
      const cats = d.byCategory.items.map(c => ({ label: c.category, value: c.total }));

      content.append(
        // ---- hero: this period, then the year ----
        el('div', { class: 'fin-hero' },
          el('div', { class: 'fin-hero-main' },
            el('div', { class: 'fin-hero-label' }, 'Earned this period'),
            el('div', { class: 'fin-hero-value' }, money(s.earned)),
            el('div', { class: 'fin-hero-meta' },
              s.hours
                ? el('span', {}, `${s.hours} h logged · ${money(s.effectiveRate)}/h effective`)
                : el('span', { class: 'muted' }, `${d.log.days.length} day${d.log.days.length === 1 ? '' : 's'} with income`))),
          el('div', { class: 'fin-hero-split' },
            el('div', { class: 'fin-hero-stat is-in' },
              el('span', { class: 'fin-hero-stat-label' }, `${y.year} in`),
              el('span', { class: 'fin-hero-stat-value' }, money(y.earned))),
            el('div', { class: 'fin-hero-stat is-out' },
              el('span', { class: 'fin-hero-stat-label' }, `${y.year} out`),
              el('span', { class: 'fin-hero-stat-value' }, money(y.spent))),
            el('div', { class: 'fin-hero-stat' },
              el('span', { class: 'fin-hero-stat-label' }, 'Year net'),
              el('span', { class: 'fin-hero-stat-value' + (y.net < 0 ? ' is-neg' : '') },
                (y.net < 0 ? '−' : '+') + money(Math.abs(y.net)).replace(/^\S+\s/, S.currency + ' ')),
              y.isCurrent
                ? el('span', { class: 'fin-delta' }, `on track for ${compact(y.projectedNet)}`)
                : null),
            // Work done and not yet paid for. Deliberately its own stat rather than part
            // of "earned": it is a claim, not money, and the two must never blur.
            pend?.open.count
              ? el('div', { class: 'fin-hero-stat is-pending' },
                el('span', { class: 'fin-hero-stat-label' }, 'Awaiting'),
                el('span', { class: 'fin-hero-stat-value' }, money(pend.open.total)),
                el('span', { class: 'fin-delta' }, `${pend.open.count} estimate${pend.open.count === 1 ? '' : 's'}`))
              : null)),

        // ---- quick log: the templates, one tap ----
        //
        // Two kinds of chip sit here and they behave differently on purpose. A chip with
        // a figure on it is a fixed entry and logs on the click. A chip marked "amount →"
        // is a TEMPLATE: the payer, the type, the currency and the note are already
        // settled, so it opens a single field and the whole entry is one number.
        el('div', { class: 'fin-quick' },
          el('span', { class: 'fin-quick-label' }, 'Log'),
          ...d.presets.map(p => el('button', {
            class: 'fin-chip' + (p.asksAmount ? ' is-tpl' : '') + (p.isEstimate ? ' is-est' : ''),
            title: presetHint(p),
            onclick: () => logPreset(p),
            oncontextmenu: (e) => {
              e.preventDefault();
              menu(e.clientX, e.clientY, [
                { label: 'Log…', icon: 'plus', onclick: () => logPreset(p) },
                { label: 'Open in the full form', icon: 'edit', onclick: () => openIncomeForm(seedFromPreset(p)) },
                '-',
                { label: 'Edit template', icon: 'edit', onclick: () => openPresetEditor(p) },
                { label: 'Delete', icon: 'trash', danger: true, onclick: () => removePreset(p) },
              ]);
            },
          }, p.name, el('span', { class: 'fin-chip-rate' }, presetRate(p)))),
          el('button', { class: 'fin-chip is-add', onclick: () => openIncomeForm() }, '+ Log income'),
          el('button', {
            class: 'fin-chip is-add', title: 'Screenshot an Uber, delivery or marketplace payout screen and it fills the form in',
            onclick: () => openEarningsShot(),
          }, icon('image'), 'From a screenshot'),
          el('button', { class: 'btn sm ghost', onclick: () => openPresetEditor() }, icon('plus'), 'New template')),

        el('div', { class: 'fin-grid' },
          card('Twelve months', groupedBars(monthly, {
            width: chartWidth(2), aLabel: 'earned', bLabel: 'spent',
            onPick: (m, i) => {
              const picked = d.monthly.items[i];
              if (!picked) return;
              S.month = picked.month; S.range = ''; rangeSel.value = ''; monthInput.value = S.month;
              refresh();
            },
          }), 'span2'),

          card('Where it came from', d.bySource.items.length
            ? el('ul', { class: 'fin-source-list' }, d.bySource.items.map(src => el('li', {},
              el('div', { class: 'fin-source-head' },
                el('span', { class: 'fin-source-name' }, src.source),
                el('span', { class: 'fin-source-total' }, money(src.total))),
              meter(src.total, d.bySource.total, { format: money, bare: true }),
              el('div', { class: 'fin-source-meta' },
                `${src.share}% · ${src.count} entr${src.count === 1 ? 'y' : 'ies'}`,
                src.rate ? ` · ${money(src.rate)}/h` : '',
                src.lastDate ? ` · last ${src.lastDate}` : ''))))
            : teach('Nothing yet this period.', 'Log something with a client name and it shows up here.')),

          card('By type', cats.length
            ? el('div', { class: 'fin-donut-wrap' },
              donut(cats, { centerLabel: fmtNum(d.byCategory.total), centerSub: S.currency }),
              legend(cats, { format: money }))
            : teach('No income categorised yet.', 'Freelance, Main Job, Investment…')),

          card('Side-income goal', d.goal && (d.goal.minGoal || d.goal.majorGoal)
            ? el('div', {},
              el('div', { class: 'fin-goal-label' }, prettyMonth(d.goal.month)),
              meter(d.goal.progress, d.goal.minGoal || d.goal.majorGoal, { stretch: d.goal.majorGoal, format: money, good: true }),
              d.goal.majorGoal && d.goal.majorPct !== null
                ? el('p', { class: 'fin-goal-hint' }, `${d.goal.majorPct}% of the stretch target`)
                : null)
            : teach('No goal set.', 'A monthly side-income target lives in Plan.')),

          pendingCard(pend),
          calibrationCard(pend),

          d.recurring.length
            ? card('Recurring income', el('ul', { class: 'fin-kv' }, d.recurring.map(r =>
              el('li', {},
                el('span', {}, r.name),
                el('span', {}, `${money(r.amount)} · ${r.cadence}`)))))
            : null,
        ),

        // ---- the daily log ----
        card(`Daily log · ${d.log.days.length} day${d.log.days.length === 1 ? '' : 's'}`,
          d.log.days.length
            ? el('div', { class: 'fin-daylog' }, d.log.days.map(day => el('div', { class: 'fin-day' },
              el('div', { class: 'fin-day-head' },
                el('span', { class: 'fin-day-date' }, dayLabel(day.date)),
                el('span', { class: 'grow' }),
                day.hours ? el('span', { class: 'fin-day-hours' }, `${day.hours} h`) : null,
                el('span', { class: 'fin-day-total' }, money(day.total))),
              el('ul', { class: 'fin-day-entries' }, day.entries.map(t => el('li', {
                ondblclick: () => openTxnEditor(t),
                oncontextmenu: (e) => {
                  e.preventDefault();
                  menu(e.clientX, e.clientY, [
                    { label: 'Edit', icon: 'edit', onclick: () => openTxnEditor(t) },
                    { label: 'Duplicate to today', icon: 'plus', onclick: () => openTxnEditor({ ...t, id: null, date: todayStr() }) },
                    '-',
                    { label: 'Delete', icon: 'trash', danger: true, onclick: () => removeTxn(t) },
                  ]);
                },
              },
                el('span', { class: 'fin-entry-src' }, t.merchant || t.category),
                el('span', { class: 'fin-entry-note' },
                  [t.units && t.unit ? `${t.units} ${t.unit}${t.units === 1 ? '' : 's'}` : '', t.note].filter(Boolean).join(' · ')),
                el('span', { class: 'fin-entry-amt' }, money(t.amountBase))))))))
            : teach('Nothing logged in this period.', 'Use a quick-log chip above, or “Log income” for hours, per-item and platform-fee entries.'),
          'span3'),
      );
    }

    // A template's chip says what it will ask for; a fixed preset's says what it logs.
    const presetRate = (p) => p.asksAmount
      ? (p.payUnit === 'flat' ? 'amount →' : p.payUnit === 'hour' ? 'amount + h →' : 'amount + min →')
      : p.payUnit === 'hour' ? `${money(p.amount)}/h`
        : p.payUnit === 'minute' ? `${money(p.amount)}/min` : money(p.amount);
    const presetHint = (p) => [
      p.merchant || p.name, p.category, p.isMainJob ? 'main job' : '',
      p.isEstimate ? 'logged as expected (想定)' : '',
      p.asksAmount ? 'type the amount' : presetRate(p),
    ].filter(Boolean).join(' · ') + '\n\nRight-click to edit.';

    /** Everything a template already knows, in the shape openIncomeForm seeds from. */
    const seedFromPreset = (p, extra = {}) => ({
      presetId: p.id, templateName: p.name,
      merchant: p.merchant || p.name, category: p.category, currency: p.currency,
      note: p.note || '', isMainJob: p.isMainJob, estimate: p.isEstimate,
      mode: p.payUnit === 'hour' ? 'hourly' : 'amount',
      rate: p.payUnit === 'hour' || p.payUnit === 'minute' ? (p.amount || undefined) : undefined,
      amount: p.asksAmount ? undefined : p.amount,
      ...extra,
    });

    async function removePreset(p) {
      if (!await confirmBox(`Delete "${p.name}"?`, 'Entries already logged from it are kept.')) return;
      try { await del(`/finance/presets/${p.id}`); toast('Template deleted'); refresh(); }
      catch (e) { toast(e.message, 'err'); }
    }
    const dayLabel = (iso) => {
      const t = todayStr();
      if (iso === t) return 'Today';
      const y = new Date(Date.parse(t) - 86400000).toISOString().slice(0, 10);
      if (iso === y) return 'Yesterday';
      return new Date(iso + 'T00:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    };

    /**
     * One tap on a quick-log chip.
     *
     * Which of four things happens is decided entirely by what the preset already knows:
     *
     *   fixed amount, income  → logged on the click. This is the one-tap case the Income
     *                           tab promises, and nothing should stand in front of it.
     *   fixed amount, expense → asks how many, because three coffees is one click and a
     *                           digit, not three clicks.
     *   no amount (template)  → asks for the amount. Payer, category, currency, note and
     *                           the main-job flag are already answered, so they are not
     *                           shown; "More fields…" is there for the day one is wrong.
     *   hourly / per minute   → asks for the work, and for the amount too if the template
     *                           carries no rate.
     *
     * There were two functions by this name in this file, both live, the second silently
     * overriding the first — so the one-tap path above had never actually run. One now.
     */
    async function logPreset(p) {
      const needsAmount = p.asksAmount;
      const needsUnits = p.payUnit === 'hour' || p.payUnit === 'minute';
      const needsCount = !needsAmount && !needsUnits && p.kind === 'expense';
      if (!needsAmount && !needsUnits && !needsCount) return sendPresetLog(p, { date: todayStr() });

      const amount = el('input', { class: 'input', type: 'number', step: '1', min: '0', placeholder: '0', inputmode: 'decimal' });
      const units = el('input', { class: 'input', type: 'number', step: '0.25', min: '0.25', value: '1' });
      const count = el('input', { class: 'input', type: 'number', step: '1', min: '1', value: '1' });
      const date = el('input', { class: 'input', type: 'date', value: todayStr() });
      const note = el('input', { class: 'input', placeholder: p.note || 'optional' });
      const estimate = el('input', { type: 'checkbox', checked: !!p.isEstimate });
      const preview = el('div', { class: 'fin-form-preview' });

      const paint = () => {
        const a = needsAmount ? Number(amount.value) || 0
          : needsUnits ? p.amount * (Number(units.value) || 0)
            : p.amount * (Number(count.value) || 0);
        fill(preview,
          el('span', { class: 'fin-form-preview-label' },
            `${p.category} · ${p.merchant || p.name}${p.isMainJob ? ' · main job' : ''}`),
          el('strong', {}, a > 0 ? money(a) : 'Enter the amount'),
          p.kind === 'income'
            ? el('span', { class: 'muted' }, estimate.checked ? ' — expected, not yet received' : ' — received')
            : null);
      };
      for (const n of [amount, units, count]) n.addEventListener('input', paint);
      estimate.addEventListener('change', paint);
      paint();

      // Type, Enter, done — the caret never has to leave the field to reach a button.
      for (const n of [amount, units, count]) n.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        n.closest('.modal')?.querySelector('.modal-actions .btn.primary')?.click();
      });

      const first = needsAmount ? amount : needsUnits ? units : count;
      focusSoon(first);
      const actions = [{ label: 'Cancel', value: null }];
      // The escape hatch only makes sense for income — the full form it opens is the
      // income form, and pointing an expense preset at it would be a dead end.
      if (p.kind === 'income') actions.push({ label: 'More fields…', value: 'more' });
      actions.push({ label: 'Log', value: 'log', kind: 'primary' });

      const choice = await modal({
        title: p.name,
        sub: needsAmount ? presetHint(p).split('\n')[0]
          : needsUnits ? `${presetRate(p)} — how ${p.payUnit === 'hour' ? 'many hours' : 'long in minutes'}?`
            : `${presetRate(p)} each`,
        body: el('div', { class: 'fin-form' },
          needsAmount ? row('Amount', amount) : null,
          needsUnits ? row(p.payUnit === 'hour' ? 'Hours' : 'Minutes', units) : null,
          needsCount ? row('How many', count) : null,
          row('Date', date), row('Note', note),
          p.kind === 'income'
            ? el('label', { class: 'fin-form-check' }, estimate,
              el('span', {}, 'Expected only (想定) — record the actual when it is paid'))
            : null,
          preview),
        actions,
      });
      if (!choice) return;
      if (choice === 'more') {
        return openIncomeForm(seedFromPreset(p, {
          date: date.value, note: note.value.trim() || p.note || '',
          estimate: estimate.checked,
          amount: needsAmount ? (Number(amount.value) || undefined) : undefined,
          qty: needsUnits ? (Number(units.value) || 1) : undefined,
        }));
      }
      if (needsAmount && !(Number(amount.value) > 0)) return toast('Enter an amount', 'err');
      return sendPresetLog(p, {
        date: date.value,
        amount: needsAmount ? Number(amount.value) : undefined,
        units: needsUnits ? Number(units.value) || 1 : undefined,
        count: needsCount ? Math.max(1, Math.trunc(Number(count.value) || 1)) : undefined,
        note: note.value.trim() || undefined,
        estimate: estimate.checked,
      });
    }

    async function sendPresetLog(p, body) {
      try {
        const r = await post(`/finance/presets/${p.id}/log`, body);
        const rows = r.estimate ? r.pending : r.created;
        const total = rows.reduce((a, t) => a + t.amountBase, 0);
        const many = rows.length > 1 ? ` · ${rows.length} entries` : '';
        toast(r.estimate ? `Expected ${money(total)} recorded` : `Logged ${money(total)}${many}`, 'ok');
        refresh();
      } catch (e) { toast(e.message, 'err'); }
    }

    // ---------- expected income (想定) ----------
    //
    // Income that is earned and estimated on the day, then paid in a lump some time
    // later. Two things follow from that, and both are load-bearing:
    //
    //   * An estimate is NOT money. It never enters the ledger, never moves "earned",
    //     never counts towards a goal. It sits in its own list until a payout lands.
    //   * A payout covers many estimates at once. So settling is a batch action — pick
    //     a client, type what actually arrived, and every estimate it covers is marked
    //     off against it and compared with it.
    //
    // The comparison is the point. A month of guesses that lands 6% under what was paid
    // is a calibration you can use the next month, and it is invisible unless both
    // numbers are kept.

    S.openPendGroups = S.openPendGroups || {};

    const pendDay = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
    const dateSpan = (from, to) => (from === to ? pendDay(from) : `${pendDay(from)} → ${pendDay(to)}`);
    const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + money(Math.abs(n));
    /** Which way the intuition leans, said in the direction that is actually useful:
     *  money arriving ABOVE the estimate means the guesses were too low. */
    const biasWord = (b) => b === null ? '' : b > 0 ? `guesses run ${b}% low` : b < 0 ? `guesses run ${-b}% high` : 'guesses are on the nose';

    function pendingCard(pend) {
      const openList = pend?.open;
      const head = el('button', { class: 'btn sm', onclick: () => openPendingEditor() }, icon('plus'), 'Add');
      if (!openList?.count) {
        return card('Expected · 想定', teach('Nothing outstanding.',
          'Log a day’s freelance work as expected when you can only estimate it, then record the real amount when the payout lands. The difference is tracked for you.'),
          '', head);
      }

      const oldestDays = Math.max(0, Math.round((Date.parse(todayStr()) - Date.parse(openList.oldest)) / 86400000));
      return card('Expected · 想定', el('div', { class: 'fin-pend' },
        el('div', { class: 'fin-pend-sum' },
          el('strong', {}, money(openList.total)),
          el('span', { class: 'muted' },
            ` awaiting across ${openList.count} estimate${openList.count === 1 ? '' : 's'}`),
          oldestDays > 0
            ? el('span', { class: 'fin-pend-age' + (oldestDays > 45 ? ' is-old' : '') }, `oldest ${oldestDays}d`)
            : null),

        ...openList.groups.map(g => {
          const isOpen = !!S.openPendGroups[g.payer];
          const rows = openList.items.filter(r => (r.merchant || r.category) === g.payer);
          return el('div', { class: 'fin-pend-group' + (isOpen ? ' is-open' : '') },
            el('div', {
              class: 'fin-pend-head',
              onclick: () => { S.openPendGroups[g.payer] = !isOpen; render(); },
            },
              el('span', { class: 'fin-pend-caret' }, isOpen ? '▾' : '▸'),
              el('span', { class: 'fin-pend-payer' }, g.payer),
              el('span', { class: 'fin-pend-meta' }, `${g.count} · ${dateSpan(g.from, g.to)}`),
              el('span', { class: 'grow' }),
              el('span', { class: 'fin-pend-total' }, money(g.total)),
              el('button', {
                class: 'btn xs primary',
                title: `Record what ${g.payer} actually paid`,
                onclick: (e) => { e.stopPropagation(); openSettleForm(g, rows); },
              }, 'Record payment')),
            isOpen
              ? el('ul', { class: 'fin-pend-entries' }, rows.map(r => el('li', {
                ondblclick: () => openPendingEditor(r),
                oncontextmenu: (e) => {
                  e.preventDefault();
                  menu(e.clientX, e.clientY, [
                    { label: 'Edit estimate', icon: 'edit', onclick: () => openPendingEditor(r) },
                    { label: 'Record payment for just this', icon: 'plus', onclick: () => openSettleForm({ ...g, count: 1, total: r.amountBase, from: r.date, to: r.date }, [r]) },
                    '-',
                    { label: 'Write off (never paid)', icon: 'x', onclick: () => writeOffPending(r) },
                    { label: 'Delete', icon: 'trash', danger: true, onclick: () => removePending(r) },
                  ]);
                },
              },
                el('span', { class: 'fin-entry-src' }, pendDay(r.date)),
                el('span', { class: 'fin-entry-note' },
                  [r.units && r.unit ? `${r.units} ${r.unit}${r.units === 1 ? '' : 's'}` : '', r.note].filter(Boolean).join(' · ')),
                el('span', { class: 'fin-entry-amt' }, money(r.amountBase)))))
              : null);
        }),
      ), 'span2', head);
    }

    /**
     * How good the guesses were. Two windows, on purpose: the selected period answers
     * "did this month work out", and a six-month lookback per client answers "which way
     * should I lean next time" — which one month of payouts is far too little to say.
     */
    function calibrationCard(pend) {
      const st = pend?.settled;
      if (!st?.count && !pend?.byPayer?.length) return null;

      const body = el('div', { class: 'fin-cal' });
      if (st?.count) {
        const good = st.variance >= 0;
        body.append(
          el('div', { class: 'fin-cal-head' },
            el('div', { class: 'fin-cal-pair' },
              el('span', { class: 'fin-cal-label' }, 'Guessed'),
              el('span', { class: 'fin-cal-value' }, money(st.expected))),
            el('span', { class: 'fin-cal-arrow' }, '→'),
            el('div', { class: 'fin-cal-pair' },
              el('span', { class: 'fin-cal-label' }, 'Paid'),
              el('span', { class: 'fin-cal-value is-in' }, money(st.actual)))),
          el('p', { class: 'fin-cal-verdict' + (good ? '' : ' is-neg') },
            `${signed(st.variance)}${st.biasPct === null ? '' : ` (${st.biasPct > 0 ? '+' : ''}${st.biasPct}%)`}`,
            el('span', { class: 'muted' }, ` across ${st.payouts} payout${st.payouts === 1 ? '' : 's'} this period`)),
          st.items.length
            ? el('ul', { class: 'fin-cal-list' }, st.items.slice(0, 6).map(pay => el('li', {
              title: 'Open the payout in the ledger',
              onclick: () => { S.tab = 'ledger'; S.search = pay.payer; S.kindFilter = 'income'; paintTabs(); refresh(); },
            },
              el('span', { class: 'fin-cal-date' }, pendDay(pay.date)),
              el('span', { class: 'fin-cal-payer' }, pay.payer),
              el('span', { class: 'fin-cal-nums' }, `${compact(pay.expected)} → ${compact(pay.actual)}`),
              el('span', { class: 'fin-cal-var' + (pay.variance < 0 ? ' is-neg' : '') },
                pay.biasPct === null ? signed(pay.variance) : `${pay.biasPct > 0 ? '+' : ''}${pay.biasPct}%`))))
            : null);
      } else {
        body.append(teach('No payouts recorded in this period.',
          'Record a payment against your estimates and the comparison shows up here.'));
      }

      if (pend.byPayer?.length) {
        body.append(
          el('div', { class: 'fin-cal-sub' }, 'Last 6 months, by client'),
          el('ul', { class: 'fin-bias-list' }, pend.byPayer.slice(0, 6).map(b => el('li', {},
            el('div', { class: 'fin-bias-head' },
              el('span', { class: 'fin-bias-payer' }, b.payer),
              el('span', { class: 'fin-bias-word' }, biasWord(b.biasPct))),
            // A bar either side of a centre line: left of it the estimates were high,
            // right of it they were low. A one-sided meter cannot show a sign.
            el('div', { class: 'fin-bias-bar' },
              el('i', {
                class: b.biasPct >= 0 ? 'is-low' : 'is-high',
                style: { width: Math.min(50, Math.abs(b.biasPct || 0)) + '%' },
              })),
            el('div', { class: 'fin-bias-meta' },
              `${compact(b.expected)} guessed · ${compact(b.actual)} paid · ${b.payouts} payout${b.payouts === 1 ? '' : 's'}`))))); 
      }
      return card('Guess vs paid', body);
    }

    /**
     * Record what actually arrived.
     *
     * The received amount starts at the sum of the estimates it covers, because that is
     * the number most often right and the one worth showing a difference against. The
     * difference is live: type the real figure and the modal says, before anything is
     * written, how far off the intuition was.
     */
    async function openSettleForm(group, rows) {
      const ids = rows.map(r => r.id);
      const expected = rows.reduce((n, r) => n + r.amountBase, 0);
      const cur = S.income?.settings?.codes?.includes(group.currency) ? group.currency : S.currency;

      const amount = el('input', { class: 'input', type: 'number', step: '1', min: '0', inputmode: 'decimal', value: String(Math.round(expected)) });
      const date = el('input', { class: 'input', type: 'date', value: todayStr() });
      const currency = el('select', { class: 'input select' },
        (S.income?.settings?.codes || [S.currency]).map(c => el('option', { value: c, selected: c === cur }, c)));
      const note = el('input', { class: 'input', placeholder: 'optional — invoice number, payout id…' });
      const diff = el('div', { class: 'fin-form-preview' });

      const paint = () => {
        const got = Number(amount.value) || 0;
        const d = Math.round((got - expected) * 100) / 100;
        const pct = expected > 0 ? Math.round(d / expected * 100) : null;
        fill(diff,
          el('span', { class: 'fin-form-preview-label' },
            `${rows.length} estimate${rows.length === 1 ? '' : 's'} · ${dateSpan(group.from, group.to)} · ${money(expected)} expected`),
          got > 0
            ? el('strong', { class: d < 0 ? 'is-neg' : '' },
              d === 0 ? 'Exactly as estimated'
                : `${signed(d)} ${d > 0 ? 'more' : 'less'} than estimated${pct === null ? '' : ` (${pct > 0 ? '+' : ''}${pct}%)`}`)
            : el('strong', {}, 'What actually arrived?'));
      };
      amount.addEventListener('input', paint);
      paint();
      amount.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        amount.closest('.modal')?.querySelector('.modal-actions .btn.primary')?.click();
      });

      focusSoon(amount);
      const ok = await modal({
        title: `Payment from ${group.payer}`,
        sub: 'Writes one income entry for what arrived, and closes the estimates it covers.',
        body: el('div', { class: 'fin-form' },
          row('Received', amount), row('Currency', currency), row('Paid on', date), row('Note', note), diff),
        actions: [{ label: 'Cancel', value: null }, { label: 'Record it', value: true, kind: 'primary' }],
      });
      if (!ok) return;
      if (!(Number(amount.value) > 0)) return toast('Enter what actually arrived', 'err');
      try {
        const r = await post('/finance/pending/settle', {
          ids, amount: Number(amount.value), currency: currency.value,
          date: date.value, note: note.value.trim() || undefined,
        });
        toast(r.variance === 0
          ? `Recorded ${money(r.actual)} — exactly as estimated`
          : `Recorded ${money(r.actual)} · ${signed(r.variance)} vs estimate`, 'ok');
        refresh();
      } catch (e) { toast(e.message, 'err'); }
    }

    /** Add or correct a single estimate. Same fields as an income entry minus the ones
     *  only real money has, plus the date the money is expected to arrive. */
    async function openPendingEditor(entry = null) {
      const isEdit = !!entry?.id;
      const cats = S.income?.categories || S.categories.income || [];
      const sources = S.income?.sources || [];

      const amount = el('input', { class: 'input', type: 'number', step: '1', min: '0', inputmode: 'decimal', value: entry?.amount ?? '' });
      const date = el('input', { class: 'input', type: 'date', value: entry?.date || todayStr() });
      const due = el('input', { class: 'input', type: 'date', value: entry?.dueDate || '' });
      const merchant = el('input', { class: 'input', placeholder: 'client or platform', value: entry?.merchant || '', list: 'fin-pend-src' });
      const srcList = el('datalist', { id: 'fin-pend-src' }, sources.map(x => el('option', { value: x.value })));
      const cat = el('select', { class: 'input select' },
        cats.map(c => el('option', { value: c, selected: c === (entry?.category || 'Freelance') }, c)));
      const cur = el('select', { class: 'input select' },
        (S.income?.settings?.codes || [S.currency]).map(c => el('option', { value: c, selected: c === (entry?.currency || S.currency) }, c)));
      const qty = el('input', { class: 'input', type: 'number', step: '0.25', min: '0', value: entry?.units || '' });
      const unit = el('select', { class: 'input select' },
        ['', 'hour', 'minute', 'item', 'day', 'word'].map(u => el('option', { value: u, selected: u === (entry?.unit || '') }, u || '—')));
      const note = el('input', { class: 'input', placeholder: 'what was it for (optional)', value: entry?.note || '' });

      focusSoon(amount);
      const ok = await modal({
        title: isEdit ? 'Edit estimate' : 'Expected income · 想定',
        sub: 'Not counted as earned until you record the payment.',
        body: el('div', { class: 'fin-form' }, srcList,
          row('Amount', amount), row('Worked on', date), row('From', merchant),
          row('Type', cat), row('Currency', cur),
          el('label', { class: 'fin-form-row' }, el('span', {}, 'Work'),
            el('div', { class: 'fin-form-pair' }, qty, unit)),
          row('Paid on (if known)', due), row('Note', note)),
        actions: [{ label: 'Cancel', value: null }, { label: isEdit ? 'Save' : 'Add', value: true, kind: 'primary' }],
      });
      if (!ok) return;
      if (!(Number(amount.value) > 0)) return toast('Enter an amount', 'err');
      const bodyOut = {
        amount: Number(amount.value), date: date.value, dueDate: due.value || '',
        merchant: merchant.value.trim(), category: cat.value, currency: cur.value,
        units: Number(qty.value) || 0, unit: unit.value, note: note.value.trim(),
      };
      try {
        if (isEdit) await patch(`/finance/pending/${entry.id}`, bodyOut);
        else await post('/finance/pending', bodyOut);
        toast(isEdit ? 'Estimate updated' : `Expected ${money(bodyOut.amount)} recorded`, 'ok');
        refresh();
      } catch (e) { toast(e.message, 'err'); }
    }

    async function writeOffPending(r) {
      if (!await confirmBox(`Write off ${money(r.amountBase)} from ${r.merchant || r.category}?`,
        'It stays on record as expected-but-never-paid, and drops out of every total.', 'Write off', 'danger')) return;
      try { await post('/finance/pending/void', { ids: [r.id] }); toast('Written off'); refresh(); }
      catch (e) { toast(e.message, 'err'); }
    }

    async function removePending(r) {
      if (!await confirmBox(`Delete this estimate?`, `${r.date} · ${money(r.amountBase)}`)) return;
      try { await del(`/finance/pending/${r.id}`); toast('Estimate deleted'); refresh(); }
      catch (e) { toast(e.message, 'err'); }
    }

    /**
     * Log income, in whichever shape the money actually arrived.
     *
     * The mode only changes the arithmetic that produces the amount — every mode writes
     * one ordinary income row, so nothing downstream has to know which was used. Hourly
     * and per-item additionally record `units`, which is what makes "what am I really
     * earning per hour" answerable months later.
     */
    async function openIncomeForm(seed = {}) {
      let mode = seed.mode || 'hourly';
      const cats = S.income?.categories || S.categories.income || [];
      const sources = S.income?.sources || [];

      const date = el('input', { class: 'input', type: 'date', value: seed.date || todayStr() });
      const source = el('input', { class: 'input', placeholder: 'client or platform', value: seed.merchant || '', list: 'fin-src-list' });
      const srcList = el('datalist', { id: 'fin-src-list' }, sources.map(x => el('option', { value: x.value })));
      const cat = el('select', { class: 'input select' }, cats.map(c => el('option', { value: c, selected: c === (seed.category || 'Freelance') }, c)));
      const cur = el('select', { class: 'input select' },
        (S.income?.settings?.codes || [S.currency]).map(c => el('option', { value: c, selected: c === S.currency }, c)));
      const note = el('input', { class: 'input', placeholder: 'what was it for (optional)', value: seed.note || '' });
      const mainJob = el('input', { type: 'checkbox', checked: !!seed.isMainJob });
      // 想定: the money has been earned but not received. Ticking this sends the entry to
      // the expected ledger instead of the real one — see the 想定 section above.
      const estimate = el('input', { type: 'checkbox', checked: !!seed.estimate });
      const due = el('input', { class: 'input', type: 'date', value: seed.dueDate || '' });
      const dueRow = row('Paid on (if known)', due);
      let presetId = seed.presetId || '';

      // mode-specific inputs
      const amount = el('input', { class: 'input', type: 'number', step: '1', min: '0', placeholder: '0' });
      const rate = el('input', { class: 'input', type: 'number', step: '1', min: '0', placeholder: 'rate' });
      const qty = el('input', { class: 'input', type: 'number', step: '0.25', min: '0', placeholder: 'hours', value: '1' });
      const gross = el('input', { class: 'input', type: 'number', step: '1', min: '0', placeholder: 'gross' });
      const feePct = el('input', { class: 'input', type: 'number', step: '0.1', min: '0', max: '100', placeholder: '%', value: '10' });
      const feeFlat = el('input', { class: 'input', type: 'number', step: '1', min: '0', placeholder: 'or fixed fee' });

      // A seed carries numbers when the form was opened from a read payout screen. They
      // are only ever a starting point — the fields stay editable and nothing is logged
      // until the user presses the button, which is the whole reason this fills a form
      // instead of writing a row.
      for (const [node, v] of [[amount, seed.amount], [rate, seed.rate], [qty, seed.qty],
        [gross, seed.gross], [feeFlat, seed.fee]]) {
        if (v !== undefined && v !== null && v !== '') node.value = v;
      }
      if (seed.currency) cur.value = seed.currency;

      const preview = el('div', { class: 'fin-form-preview' });
      const modeRow = el('div', { class: 'fin-chips' });
      const fieldSlot = el('div', {});

      // The templates, one click. Applying one fills every field that never changes for
      // that stream, so the full form is only ever "the template, plus the bit that is
      // unusual today" rather than a fresh retype.
      const templates = (S.income?.presets || []).filter(p => p.kind === 'income');
      const tplRow = el('div', { class: 'fin-chips fin-tpl-row' });
      const applyTemplate = (p) => {
        presetId = presetId === p.id ? '' : p.id;
        if (presetId) {
          source.value = p.merchant || p.name;
          cat.value = cats.includes(p.category) ? p.category : cat.value;
          if ((S.income?.settings?.codes || []).includes(p.currency)) cur.value = p.currency;
          if (p.note) note.value = p.note;
          mainJob.checked = !!p.isMainJob;
          estimate.checked = !!p.isEstimate;
          if (p.payUnit === 'hour' || p.payUnit === 'minute') {
            mode = 'hourly';
            if (p.amount > 0) rate.value = p.amount;
          } else if (!p.asksAmount) {
            mode = 'amount';
            amount.value = p.amount;
          }
        }
        paintTpl();
        paintMode({ focus: true });
        paintEstimate();
      };
      const paintTpl = () => fill(tplRow,
        el('span', { class: 'fin-quick-label' }, 'Template'),
        templates.map(p => el('button', {
          class: 'fin-chip' + (presetId === p.id ? ' is-on' : ''),
          title: presetHint(p),
          onclick: () => applyTemplate(p),
        }, p.name)),
        el('button', { class: 'fin-chip is-add', title: 'Create a template from scratch', onclick: () => openPresetEditor() }, '+'));
      const paintEstimate = () => { dueRow.hidden = !estimate.checked; paintPreview(); };
      estimate.addEventListener('change', paintEstimate);

      const computed = () => {
        if (mode === 'amount') return { amount: Number(amount.value) || 0 };
        if (mode === 'hourly') return { amount: (Number(rate.value) || 0) * (Number(qty.value) || 0), units: Number(qty.value) || 0, unit: 'hour' };
        if (mode === 'unit') return { amount: (Number(rate.value) || 0) * (Number(qty.value) || 0), units: Number(qty.value) || 0, unit: 'item' };
        const g = Number(gross.value) || 0;
        const fee = Number(feeFlat.value) > 0 ? Number(feeFlat.value) : g * (Number(feePct.value) || 0) / 100;
        return { amount: Math.max(0, g - fee), fee: Math.round(fee * 100) / 100, gross: g };
      };

      // Repainted in TWO independent pieces, and the split is not cosmetic.
      //
      // This form used to rebuild the chips and the field slot on every keystroke, to keep
      // the running total honest. Emptying the slot detaches the <input> the caret is in,
      // and a detached input is a blurred one — so typing "1200" into Amount landed as
      // four separate one-character edits, each into a freshly re-attached empty-ish
      // field. Multi-digit numbers were effectively impossible to type. The live total is
      // the only thing that has to react to typing, and it contains nothing focusable, so
      // that is the only thing a keystroke now repaints.
      const paintPreview = () => {
        const c = computed();
        fill(preview,
          el('span', { class: 'fin-form-preview-label' }, INCOME_MODES.find(m => m.id === mode).hint),
          el('strong', {}, c.amount > 0
            ? (estimate.checked ? `Expecting ${money(c.amount)}` : `You keep ${money(c.amount)}`)
            : 'Enter the numbers'),
          mode === 'fee' && c.fee > 0 ? el('span', { class: 'muted' }, ` (fee ${money(c.fee)})`) : null,
          estimate.checked
            ? el('span', { class: 'muted' }, ' — held as expected until you record the payment')
            : null);
      };

      // The first field of the chosen mode is the one you always type into, so switching
      // mode puts the caret there — a mode chip is a click you make on the way to typing,
      // never a destination.
      let firstField = amount;
      const paintMode = ({ focus = false } = {}) => {
        fill(modeRow, INCOME_MODES.map(m => el('button', {
          class: 'fin-chip' + (m.id === mode ? ' is-on' : ''),
          onclick: () => { mode = m.id; paintMode({ focus: true }); },
        }, m.label)));
        const fieldsFor = mode === 'amount' ? [['Amount', amount]]
          : mode === 'hourly' ? [['Hours', qty], ['Rate per hour', rate]]
            : mode === 'unit' ? [['How many', qty], ['Price each', rate]]
              : [['Gross paid', gross], ['Platform fee %', feePct], ['…or fixed fee', feeFlat]];
        fill(fieldSlot, fieldsFor.map(([label, node]) => row(label, node)));
        firstField = fieldsFor[0][1];
        paintPreview();
        if (focus) focusSoon(firstField);
      };
      for (const inp of [amount, rate, qty, gross, feePct, feeFlat]) inp.addEventListener('input', paintPreview);
      paintMode();

      // Enter anywhere in the numbers logs it, so the whole entry is keyboard-only:
      // open, type, Enter. Without this the caret has to leave the field it is already in
      // to reach a button, which is the slow half of logging an hour of work.
      for (const inp of [amount, rate, qty, gross, feePct, feeFlat]) {
        inp.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          inp.closest('.modal')?.querySelector('.modal-actions .btn.primary')?.click();
        });
      }

      // modal() focuses the first focusable thing in the body, which here is a mode chip.
      // The mode is usually already right, so land in the number instead.
      if (templates.length) paintTpl();
      paintEstimate();

      focusSoon(firstField);
      const ok = await modal({
        title: 'Log income', sub: seed.readFrom || (seed.templateName ? `From the ${seed.templateName} template` : ''), wide: true,
        body: el('div', { class: 'fin-form' },
          templates.length ? tplRow : null,
          modeRow, fieldSlot, preview, srcList,
          row('Date', date), row('From', source), row('Type', cat), row('Currency', cur),
          row('Note', note), dueRow,
          el('label', { class: 'fin-form-check' }, mainJob, el('span', {}, 'Main job (excluded from the side-income goal)')),
          el('label', { class: 'fin-form-check' }, estimate,
            el('span', {}, 'Expected only (想定) — an estimate, not money received yet'))),
        actions: [{ label: 'Cancel', value: null }, { label: 'Log it', value: true, kind: 'primary' }],
      });
      if (!ok) return;

      const c = computed();
      if (!(c.amount > 0)) return toast('That comes to zero — check the numbers', 'err');
      const noteParts = [note.value.trim()];
      if (mode === 'fee' && c.fee > 0) noteParts.push(`gross ${c.gross} − fee ${c.fee}`);
      // Same numbers, two ledgers. An estimate is a claim on money that has not arrived,
      // so it goes to the expected table and touches no total until it is settled.
      const payload = {
        date: date.value, amount: c.amount, currency: cur.value,
        category: cat.value, merchant: source.value.trim(), note: noteParts.filter(Boolean).join(' · '),
        isMainJob: mainJob.checked, units: c.units || 0, unit: c.unit || '', presetId,
      };
      try {
        if (estimate.checked) {
          await post('/finance/pending', { ...payload, dueDate: due.value || '' });
          toast(`Expected ${money(c.amount)} recorded`, 'ok');
        } else {
          await post('/finance/txns', { ...payload, kind: 'income' });
          toast(`Logged ${money(c.amount)}`, 'ok');
        }
        refresh();
      } catch (e) { toast(e.message, 'err'); }
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
    S.rcView = S.rcView || {};   // per-receipt zoom/rotate/pan for the photo pane

    /**
     * How sure the reading is, as a bar you can read at a glance.
     *
     * The number matters less than the sentence under it. "78/100" tells a reviewer
     * nothing actionable; "the lines come to 200 more than the receipt says" tells them
     * exactly where to look. So the meter is the summary and the reasons are the content —
     * and the reasons are the same checks that drove the automatic re-reads, which is why
     * a scan that was read three times and still scores 40 is worth opening.
     */
    function confidenceMeter(conf) {
      if (!conf || typeof conf.score !== 'number') return null;
      const LABEL = { high: 'Confident', good: 'Probably right', fair: 'Worth checking', low: 'Check this carefully' };
      const bad = conf.reasons?.filter(r => r.delta < 0) || [];
      const good = conf.reasons?.filter(r => r.delta > 0) || [];

      return el('div', { class: 'fin-conf is-' + conf.level },
        el('div', { class: 'fin-conf-head' },
          el('span', { class: 'fin-conf-score' }, String(conf.score)),
          el('div', { class: 'fin-conf-bar' }, el('i', { style: { width: conf.score + '%' } })),
          el('span', { class: 'fin-conf-label' }, LABEL[conf.level] || 'Unscored')),
        conf.reads > 1
          ? el('div', { class: 'fin-conf-reads' },
            `Read ${conf.reads} times automatically`
            + (conf.angle ? `, turning it ${conf.angle}° on the way` : '')
            + ' — this is the best of them.')
          : null,
        bad.length || good.length
          ? el('ul', { class: 'fin-conf-why' },
            bad.map(r => el('li', { class: 'is-bad' }, r.text)),
            good.map(r => el('li', { class: 'is-ok' }, r.text)))
          : null);
    }

    /**
     * Already in the ledger. Shown while reviewing rather than only on the way out,
     * because finding out that a scan was a duplicate only after correcting all its
     * lines is the annoying version of a guardrail.
     */
    function duplicateBanner(dupe, currency) {
      if (!dupe) return null;
      const m = (n) => `${currency || S.currency} ${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
      return el('div', { class: 'fin-chk is-bad' }, icon('shield'),
        el('span', {},
          el('strong', {}, 'Already logged. '),
          `${dupe.merchant || 'A receipt'} on ${dupe.date} for ${m(dupe.total)} is in the ledger with the same items `
          + 'and prices. This copy cannot be added — delete it, or undo the original if that one was wrong.'));
    }

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
    /**
     * The photo, beside the fields, so you can actually check the reading.
     *
     * This is the difference between "trust the model" and "verify it": a thermal receipt
     * misread of 牛乳 as 牛丼 is invisible in a text field and obvious against the paper.
     * Zoom to read the small print, rotate because a photo taken sideways is common, and
     * drag to pan when zoomed in. Kept out of the phone view — there is no room beside the
     * fields there, and the photo is already in your hand.
     */
    function receiptViewer(r) {
      const st = (S.rcView[r.id] ||= { zoom: 1, rot: 0, x: 0, y: 0 });
      const img = el('img', { class: 'fin-rc-img', src: mediaUrl(`/uploads/${r.uploadId}`), alt: 'the receipt photo', draggable: 'false' });
      const stage = el('div', { class: 'fin-rc-stage' }, img);

      const apply = () => {
        img.style.transform = `translate(${st.x}px, ${st.y}px) scale(${st.zoom}) rotate(${st.rot}deg)`;
        stage.style.cursor = st.zoom > 1 ? 'grab' : 'default';
      };
      const zoom = (mult) => { st.zoom = Math.min(8, Math.max(1, st.zoom * mult)); if (st.zoom === 1) { st.x = 0; st.y = 0; } apply(); };

      // Wheel zooms, so the page does not scroll away under you while you are reading.
      stage.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15); }, { passive: false });
      stage.addEventListener('dblclick', () => { st.zoom = st.zoom > 1 ? 1 : 3; st.x = 0; st.y = 0; apply(); });
      stage.addEventListener('pointerdown', (e) => {
        if (st.zoom <= 1) return;
        e.preventDefault();
        const x0 = e.clientX - st.x, y0 = e.clientY - st.y;
        stage.setPointerCapture(e.pointerId);
        stage.style.cursor = 'grabbing';
        const move = (ev) => { st.x = ev.clientX - x0; st.y = ev.clientY - y0; apply(); };
        const up = () => { stage.removeEventListener('pointermove', move); stage.removeEventListener('pointerup', up); stage.style.cursor = 'grab'; };
        stage.addEventListener('pointermove', move);
        stage.addEventListener('pointerup', up);
      });
      apply();

      // Rotating re-renders the editor, not just the image: the action row grows a
      // "Re-read at N°" button once the angle differs from what the model was given.
      const btn = (label, title, fn, rerender) => el('button', {
        class: 'btn ghost xs', title,
        onclick: () => { fn(); apply(); if (rerender) render(); },
      }, label);
      return el('div', { class: 'fin-rc-photo' },
        stage,
        el('div', { class: 'fin-rc-tools' },
          btn('−', 'Zoom out', () => zoom(1 / 1.3)),
          btn('+', 'Zoom in', () => zoom(1.3)),
          btn('⟲', 'Rotate left', () => { st.rot = (st.rot - 90) % 360; }, true),
          btn('⟳', 'Rotate right', () => { st.rot = (st.rot + 90) % 360; }, true),
          btn('Reset', 'Back to fit', () => { st.zoom = 1; st.rot = 0; st.x = 0; st.y = 0; }, true),
          el('a', { class: 'btn ghost xs', href: mediaUrl(`/uploads/${r.uploadId}`), target: '_blank', rel: 'noopener', title: 'Open the full-size photo' }, '↗')));
    }

    function receiptEditor(r) {
      const draft = S.openReceipts[r.id];
      const cats = S.categories?.expense || [];

      // Built once, then repainted in four independent regions: the reconciliation
      // banner, the category chips, the line rows, and the action row.
      //
      // This used to rebuild the whole editor on every keystroke in a number field.
      // That tore the focused <input> out of the document and took the caret with it,
      // so typing "112" into a price landed as three separate one-character edits with
      // the field deselected after each — the value ended up as "2". Nothing repainted
      // below contains a field you can be typing in, except the line table, which is
      // only rebuilt when a row is actually added or removed.
      const chkSlot = el('div', { class: 'fin-rc-slot' });
      const chipRow = el('div', { class: 'fin-chips' });
      const lineBody = el('tbody');
      const actionRow = el('div', { class: 'fin-rc-actions' });

      /** Recompute the check locally so the banner reacts as you type, without a round
       *  trip. The server recomputes it authoritatively on save. */
      const recheck = () => {
        const sum = draft.items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
        const expected = draft.subtotal ?? (draft.total != null && draft.tax != null ? draft.total - draft.tax : draft.total);
        const delta = Math.round((sum - (expected ?? sum)) * 100) / 100;
        const tol = Math.max(1, Math.abs(expected ?? 0) * 0.01);
        draft.check = !draft.items.length ? { verdict: 'no-items', itemsSum: 0, expected, delta: 0 }
          : expected == null ? { verdict: 'unchecked', itemsSum: sum, expected: null, delta: 0 }
            : Math.abs(delta) <= tol ? { verdict: 'balanced', itemsSum: sum, expected, delta }
              : { verdict: delta > 0 ? 'overshoot' : 'short', itemsSum: sum, expected, delta };
        fill(chkSlot, checkBanner(draft.check, draft.currency));
        paintActions();          // "Log ¥…" and "Split N" both read off the draft
      };

      // step 'any': receipts in a currency with decimals (and the rounding the model
      // sometimes produces) are legitimate values, and step="1" only marks them invalid
      // without stopping them — a red field for a correct number.
      const num = (obj, key, opts = {}) => el('input', {
        class: 'input xs num', type: 'number', step: opts.step || 'any', min: '0',
        inputmode: opts.step === '1' ? 'numeric' : 'decimal',
        value: obj[key] ?? '',
        oninput: (e) => {
          const v = e.target.value.trim();
          obj[key] = v === '' ? null : Number(v);
          if (opts.live) recheck();
        },
        onkeydown: opts.onkeydown,
      });

      /** Mark a line as hand-corrected without repainting the row the caret is in. */
      const markEdited = (it, e) => { it.edited = true; e.target.closest('tr')?.classList.add('is-edited'); };

      const paintChips = () => fill(chipRow, cats.map(c => el('button', {
        class: 'fin-chip' + (c === draft.category ? ' is-on' : ''),
        onclick: () => { draft.category = c; paintChips(); },
      }, c)));

      /**
       * Add a line and put the caret in it.
       *
       * Typing a missed line is a four-field job, and it starts at the left. Leaving the
       * caret wherever it was means every added line costs a click before it costs a
       * keystroke — which is most of the friction in correcting a receipt the model read
       * badly, because that is exactly when several lines have to be added in a row.
       */
      const addLine = () => {
        draft.items.push({ printed: '', name: '', qty: 1, amount: null });
        paintLines({ focus: draft.items.length - 1 });
        recheck();
      };

      /** Tab out of the last Amount and you are done with that line, so Enter there means
       *  "next line" — the same key that ends a row in every spreadsheet. Enter anywhere
       *  else in the table means the same thing, so the shortcut needs no explaining. */
      const lineKeys = (i) => (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (i === draft.items.length - 1) addLine();
        else focusSoon(lineBody.children[i + 1]?.querySelector('input'));
      };

      const lineRow = (it, i) => el('tr', { class: (it.warn?.length ? 'is-suspect' : '') + (it.edited ? ' is-edited' : '') },
        // Printed text is EDITABLE, not a label. When the OCR misreads the characters
        // themselves — 牛乳 as 牛丼 — fixing only the tidy name leaves the catalogue
        // keyed on the wrong string, so the same mistake recurs on the next receipt.
        el('td', {}, el('input', {
          class: 'input xs mono', value: it.printed || '', title: 'Exactly as printed on the paper — correct it if the reading is wrong',
          oninput: e => { it.printed = e.target.value; markEdited(it, e); },
          onkeydown: lineKeys(i),
        })),
        el('td', {},
          el('input', {
            class: 'input xs', value: it.name || '',
            oninput: e => { it.name = e.target.value; markEdited(it, e); },
            onkeydown: lineKeys(i),
          }),
          it.warn?.length ? el('div', { class: 'fin-rc-warn' }, it.warn.join(' · ')) : null),
        el('td', { class: 'num' }, num(it, 'qty', { step: '1', onkeydown: lineKeys(i) })),
        el('td', { class: 'num' }, num(it, 'amount', { live: true, onkeydown: lineKeys(i) })),
        el('td', {}, el('button', {
          class: 'btn ghost xs', title: 'Not on the receipt — remove it',
          onclick: () => { draft.items.splice(i, 1); paintLines(); recheck(); },
        }, icon('trash'))));

      /** `focus` is a row index: repainting the table replaces every <input> in it, so the
       *  caret has to be placed on the new node, after the rebuild, not before. */
      const paintLines = ({ focus = -1 } = {}) => {
        fill(lineBody, draft.items.length
          ? draft.items.map(lineRow)
          : el('tr', {}, el('td', { colspan: '5', class: 'muted' }, 'No lines. Add one, or just log the total.')));
        if (focus >= 0) focusSoon(lineBody.children[focus]?.querySelector('input'));
      };

      const paintActions = () => {
        const rot = ((S.rcView[r.id]?.rot || 0) % 360 + 360) % 360;
        fill(actionRow,
          el('button', {
            class: 'btn sm', title: 'Add a line and start typing it (Enter on the last line does the same)',
            onclick: addLine,
          }, icon('plus'), 'Add a line'),
          el('span', { class: 'grow' }),
          el('button', {
            class: 'btn sm', title: 'Read the photo again. Worth it after turning it, after picking a different reader in Settings, or once corrections have been learned since — otherwise the same photo gives the same reading',
            onclick: () => rescanReceipt(r),
          }, icon('refresh'), 'Re-read'),
          // Rotate the preview until it reads right, then have the model read THAT.
          rot
            ? el('button', {
              class: 'btn sm primary', title: 'Save this angle and read it again',
              onclick: () => rescanReceipt(r, rot),
            }, `Re-read at ${rot}°`)
            : null,
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
            : null);
      };

      const fields = el('div', { class: 'fin-rc-fields' },
        duplicateBanner(r.duplicate, draft.currency),
        confidenceMeter(draft.confidence),
        chkSlot,

        // Angle was a leading cause of bad reads, so when the photo was straightened
        // automatically, say so — and make the other direction one click away, because
        // the direction is a heuristic and a wrong guess should cost almost nothing.
        r.oriented?.rotated
          ? el('div', { class: 'fin-chk is-learn' }, icon('refresh'),
            el('span', {}, `Straightened it ${r.oriented.rotated === 270 ? 'anticlockwise' : r.oriented.rotated + '°'} before reading — ${r.oriented.why}. `,
              el('button', { class: 'fin-linkbtn', onclick: () => rescanReceipt(r, 180) }, 'turned the wrong way?')))
          : null,

        draft.learned?.length
          ? el('div', { class: 'fin-chk is-learn' }, icon('sparkle'),
            el('span', {}, `Applied what you taught it: `,
              ...draft.learned.map(l => el('code', {},
                l.kind === 'drop' ? `dropped “${l.line}”`
                  : l.kind === 'amount' ? `“${l.line}” ${l.from} → ${l.to}`
                    : l.kind === 'merchant' ? `shop “${l.line}” → ${l.to}`
                      : `renamed “${l.line}” → ${l.to}`))))
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

        cats.length ? chipRow : null,

        el('table', { class: 'fin-rc-lines' },
          el('thead', {}, el('tr', {},
            el('th', {}, 'Printed on the receipt'), el('th', {}, 'Item'),
            el('th', { class: 'num' }, 'Qty'), el('th', { class: 'num' }, 'Amount'), el('th', {}))),
          lineBody),

        actionRow,

        r.edited
          ? el('div', { class: 'fin-rc-note' }, 'You have already corrected this scan; the model’s original reading is kept for comparison.')
          : null);

      paintChips();
      paintLines();
      recheck();          // paints the banner and the action row

      // Two columns on a desktop: the fields you type into, and the paper you check them
      // against. Falls back to one column when the pane is narrow.
      return el('div', { class: 'fin-rc-edit' },
        r.uploadId ? el('div', { class: 'fin-rc-split' }, fields, receiptViewer(r)) : fields);
    }

    /** Ask the model to read the photo again. */
    async function rescanReceipt(r, rotate) {
      const draft = S.openReceipts[r.id];
      const touched = draft && (r.edited || draft.items?.some(i => i.edited));
      if (touched && !await confirmBox(
        'Re-read this photo?',
        'Your corrections to this scan will be replaced by the new reading.', 'Re-read')) return;
      try {
        toast(rotate ? `Rotating ${rotate}° and reading again…` : 'Reading it again — a few seconds…');
        const fresh = await post(`/finance/receipts/${r.id}/rescan`, rotate ? { rotate } : {});
        if (rotate) delete S.rcView[r.id];        // the stored photo moved; drop the view transform
        S.receipts = await get('/finance/receipts?limit=30');
        if (fresh.status === 'parsed' && fresh.parsed) {
          S.openReceipts[r.id] = JSON.parse(JSON.stringify({ items: [], ...fresh.parsed }));
          const conf = fresh.parsed.confidence;
          const c = fresh.parsed.check;
          const how = conf ? ` — ${conf.score}% sure${conf.reads > 1 ? ` after ${conf.reads} passes` : ''}` : '';
          toast(c && c.ok === false ? `Read again${how}, but the lines still do not add up` : `Read again${how}`,
            c && c.ok === false ? '' : 'ok');
        } else {
          delete S.openReceipts[r.id];
          toast(fresh.error || 'Could not read it that time either', 'err');
        }
        render();
      } catch (e) { toast(e.message, 'err'); }
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
            .map(it => ({ printed: it.printed || it.name, name: it.name, qty: it.qty || 1, amount: it.amount, edited: !!it.edited })),
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
      } catch (e) {
        toast(e.message, 'err');
        await refreshReceipts();
      }
    }

    /**
     * What the scanner has picked up, and whether it is working.
     *
     * A correction loop that cannot show its work is indistinguishable from one that does
     * nothing, and the user has no way to tell which they have. So: how many corrections
     * are stored, how many are trusted enough to fire on their own, how much vocabulary
     * the catalogue has to steer the reading with, and — the only number that really
     * answers the question — how the last ten scans scored against the ten before them.
     */
    function learningStrip() {
      const L = S.learning;
      if (!L || (!L.corrections.total && !L.vocab.confirmed && L.confidence.recent === null)) return null;
      const stat = (value, label, title) => el('div', { class: 'fin-learn-stat', title: title || '' },
        el('strong', {}, value), el('span', {}, label));

      const t = L.confidence.trend;
      return el('div', { class: 'fin-learn' },
        icon('sparkle'),
        stat(L.corrections.active, `correction${L.corrections.active === 1 ? '' : 's'} in force`,
          `${L.corrections.total} recorded in total; one fires automatically once you have made it ${L.corrections.activeAfter} times.`),
        stat(L.vocab.confirmed, 'confirmed product names',
          `${L.vocab.aliases} printed strings mapped across ${L.vocab.items} catalogue items. These are fed back into the prompt so the model prefers words you actually buy.`),
        L.confidence.recent !== null
          ? stat(`${L.confidence.recent}%`,
            t === null ? 'average confidence'
              : t > 0 ? `average confidence · up ${t}`
                : t < 0 ? `average confidence · down ${-t}` : 'average confidence · steady',
            L.confidence.before !== null
              ? `The last 10 scans averaged ${L.confidence.recent}, the 10 before them ${L.confidence.before}.`
              : `Across the last ${L.confidence.n} scored scans.`)
          : null,
        el('span', { class: 'grow' }),
        L.scans.total
          ? el('span', { class: 'fin-learn-note' }, `${L.scans.edited} of ${L.scans.total} scans corrected by hand`)
          : null);
    }

    function renderReceipts() {
      const list = S.receipts || [];
      content.append(
        el('div', { class: 'fin-toolbar' },
          el('button', { class: 'btn sm primary', onclick: openReceiptFlow }, icon('sparkle'), 'Scan a receipt'),
          el('span', { class: 'fin-count' }, 'Read on this machine by the local vision model — no image leaves the network. Check it before it lands in the ledger.')),
        learningStrip(),
        list.length
          ? el('ul', { class: 'fin-receipt-list' }, list.map(r => {
            const p = r.parsed || {};
            const items = p.items || [];
            const suspect = p.check && p.check.ok === false;
            const conf = r.confidence;
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
                    // The score first: it is the one badge that says how much of the rest
                    // of this row to believe.
                    conf ? el('span', {
                      class: 'fin-badge fin-conf-pill is-' + conf.level,
                      title: (conf.reasons || []).map(x => x.text).join('\n')
                        + (conf.reads > 1 ? `\n\nRead ${conf.reads} times — this is the best of them.` : ''),
                    }, `${conf.score}%`) : null,
                    r.duplicate ? el('span', { class: 'fin-badge is-bad', title: `Already logged on ${r.duplicate.date}` }, 'duplicate') : null,
                    suspect ? el('span', { class: 'fin-badge is-bad', title: 'The line items do not match the total' }, 'check me') : null,
                    r.edited ? el('span', { class: 'fin-badge', title: 'You corrected this scan' }, 'edited') : null),
                  el('div', { class: 'fin-receipt-meta' },
                    r.status === 'failed' ? r.error
                      : `${p.date || ''} · ${money(p.total)} · ${items.length} item${items.length === 1 ? '' : 's'}${r.status === 'applied' ? ' · in the ledger' : ''}`)),
                r.status === 'parsed'
                  ? el('div', { class: 'fin-receipt-actions' },
                    el('button', {
                      class: 'btn sm' + (suspect || open || r.duplicate ? ' primary' : ''),
                      onclick: () => {
                        if (open) delete S.openReceipts[r.id];
                        // Deep-copy so edits are discardable and a refresh can't stomp them.
                        else S.openReceipts[r.id] = JSON.parse(JSON.stringify({ items: [], ...p }));
                        render();
                      },
                    }, icon(open ? 'chevD' : 'edit'), open ? 'Close' : 'Review & edit'),
                    // No quick-log on a known duplicate: the server would refuse it anyway,
                    // and offering a button whose only outcome is an error is a small lie.
                    !open && !r.duplicate
                      ? el('button', { class: 'btn sm', title: 'One row for the receipt total', onclick: () => applyReceipt(r, 'total') }, 'Log total')
                      : null)
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

    /**
     * A template for an income stream you log over and over.
     *
     * The whole point is that everything constant about the stream — who pays, what type
     * it counts as, which currency, whether it is main-job work, the standing note — is
     * answered once here, so logging it later is one number. Leaving Amount BLANK is what
     * makes it a template rather than a fixed one-tap entry: the chip then asks for the
     * figure and fills in all the rest.
     */
    async function openPresetEditor(preset = null) {
      const isEdit = !!preset?.id;
      const name = el('input', { class: 'input', placeholder: 'e.g. Micro1', value: preset?.name || '' });
      const amount = el('input', {
        class: 'input', type: 'number', step: '0.01', inputmode: 'decimal',
        placeholder: 'leave blank to be asked each time',
        value: preset && preset.amount > 0 ? preset.amount : '',
      });
      const kind = el('select', { class: 'input select' },
        el('option', { value: 'income' }, 'Income'), el('option', { value: 'expense' }, 'Expense'));
      kind.value = preset?.kind || 'income';
      const unit = el('select', { class: 'input select' },
        ['flat', 'hour', 'minute'].map(u => el('option', { value: u, selected: u === (preset?.payUnit || 'flat') }, u)));
      const cat = el('input', { class: 'input', list: 'fin-cats-p', placeholder: 'Category', value: preset?.category || '' });
      const merchant = el('input', {
        class: 'input', placeholder: 'defaults to the template name',
        value: preset?.merchant || '',
      });
      const cur = el('select', { class: 'input select' },
        (S.income?.settings?.codes || [S.currency]).map(c => el('option', { value: c, selected: c === (preset?.currency || S.currency) }, c)));
      const note = el('input', { class: 'input', placeholder: 'standing note (optional)', value: preset?.note || '' });
      const mainJob = el('input', { type: 'checkbox', checked: !!preset?.isMainJob });
      const isEstimate = el('input', { type: 'checkbox', checked: !!preset?.isEstimate });
      const estRow = el('label', { class: 'fin-form-check' }, isEstimate,
        el('span', {}, 'Log as expected (想定) by default — for work you guess now and are paid for later'));

      const hint = el('p', { class: 'fin-teach-hint' });
      const paint = () => {
        estRow.hidden = kind.value !== 'income';
        const n = name.value.trim() || 'this';
        hint.textContent = amount.value.trim()
          ? `One click logs ${amount.value}${unit.value === 'flat' ? '' : ` per ${unit.value}`} — nothing to type.`
          : unit.value === 'flat'
            ? `Clicking ${n} will ask for the amount and fill in everything else.`
            : `Clicking ${n} will ask for the amount and the ${unit.value}s.`;
      };
      for (const n of [name, amount, unit, kind]) n.addEventListener('input', paint);
      kind.addEventListener('change', paint);
      unit.addEventListener('change', paint);
      paint();

      const ok = await modal({
        title: isEdit ? `Edit ${preset.name}` : 'New income template',
        sub: 'Leave the amount blank for a stream where only the figure changes.',
        body: el('div', { class: 'fin-form' },
          el('datalist', { id: 'fin-cats-p' }, [...S.categories.income, ...S.categories.expense].map(c => el('option', { value: c }))),
          row('Name', name), row('Amount', amount), row('Per', unit), row('Type', kind),
          row('Category', cat), row('Paid by', merchant), row('Currency', cur), row('Note', note),
          el('label', { class: 'fin-form-check' }, mainJob, el('span', {}, 'Main job (excluded from the side-income goal)')),
          estRow, hint),
        actions: [{ label: 'Cancel', value: false }, { label: isEdit ? 'Save' : 'Create', value: true, kind: 'primary' }],
      });
      if (!ok) return;
      if (!name.value.trim()) return toast('Give the template a name', 'err');
      const payload = {
        name: name.value.trim(),
        // '' rather than 0: the server reads a blank amount as "ask me".
        amount: amount.value.trim() === '' ? '' : Number(amount.value),
        kind: kind.value, payUnit: unit.value, category: cat.value.trim(),
        merchant: merchant.value.trim(), currency: cur.value, note: note.value.trim(),
        isMainJob: mainJob.checked, isEstimate: isEstimate.checked,
      };
      try {
        if (isEdit) await patch(`/finance/presets/${preset.id}`, payload);
        else await post('/finance/presets', payload);
        toast(isEdit ? 'Template saved' : 'Template created', 'ok'); refresh();
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

    /**
     * Log a shift from a screenshot of the app that paid for it.
     *
     * The friction this removes is specific and daily: an Uber or delivery payout screen
     * already states the payout, the platform's cut, the trips and the hours — and logging
     * it means reading four numbers off a phone and typing them into another screen, which
     * is exactly the kind of task that stops getting done after a fortnight.
     *
     * It reads into the FORM, never into the ledger. An earnings screen has no arithmetic
     * of its own to check the reading against — unlike a receipt, whose lines must sum to
     * its total — so the only real check available is the user glancing at four numbers
     * they can already see on their phone. Making them press the button is that check.
     */
    async function openEarningsShot() {
      const picker = el('input', { type: 'file', accept: IMAGE_ACCEPT, style: { display: 'none' } });
      document.body.append(picker);
      picker.onchange = async () => {
        const file = picker.files?.[0];
        picker.remove();
        if (!file) return;
        try {
          toast('Uploading…');
          const up = await uploadFile(file);
          toast('Reading the screen — a few seconds…');
          const res = await post('/finance/earnings/read', { uploadId: up.id });
          if (!res.parsed) return toast(res.error || 'Could not read that screenshot', 'err');
          const p = res.parsed;

          // What was read, in the words of what it will log — so a wrong reading is
          // obvious before the form is even filled in, not after a row appears.
          const said = [
            p.net !== null ? `${money(p.net)} kept` : null,
            p.fee ? `${money(p.fee)} fee` : null,
            p.jobs ? `${p.jobs} job${p.jobs === 1 ? '' : 's'}` : null,
            p.hours ? `${p.hours} h` : null,
          ].filter(Boolean).join(' · ');
          toast(`Read ${p.payer || 'the screen'}: ${said}`, 'ok');

          // Hourly and per-job modes multiply a rate by a count, and a payout screen states
          // the product rather than the factors. Back the rate out of it: the amount then
          // comes to what was actually paid, and the hours or jobs get RECORDED, which is
          // the only reason to pick those modes over a flat amount. It is an effective rate,
          // not an agreed one — which is exactly what the Income tab reports it as anyway.
          const per = (n) => (p.net !== null && n ? Math.round((p.net / n) * 100) / 100 : undefined);
          const qty = p.mode === 'hourly' ? p.hours : p.mode === 'unit' ? p.jobs : undefined;

          await openIncomeForm({
            mode: p.mode, date: p.date, merchant: p.payer, currency: p.currency,
            amount: p.net, gross: p.gross, fee: p.fee,
            qty, rate: per(qty),
            note: [p.jobs ? `${p.jobs} jobs` : '', p.hours ? `${p.hours}h online` : ''].filter(Boolean).join(', '),
            readFrom: `Read from a screenshot${p.derived?.length ? ` — ${p.derived.join(' and ')} worked out from the other figures, so check ${p.derived.length > 1 ? 'them' : 'it'}` : ''}${p.dateGuessed ? ' · no date on the screen, so today is assumed' : ''}`,
          });
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
      } catch (e) {
        toast(e.message, 'err');
        // A refused duplicate is the one failure the row itself should now explain, so
        // reload rather than leaving a row that still offers the button that just failed.
        await refreshReceipts();
      }
    }

    /** Pull the list back in and redraw, swallowing errors — a failed refresh must never
     *  replace a screen the user is working on with an error page. */
    async function refreshReceipts() {
      try {
        S.receipts = await get('/finance/receipts?limit=30');
        S.learning = await get('/finance/receipt-learning').catch(() => S.learning);
        render();
      } catch { /* the list on screen is still usable */ }
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
