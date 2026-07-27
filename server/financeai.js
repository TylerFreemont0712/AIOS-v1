// The narrative layer over Finances: a short, plain-language account of a month,
// written once by the local model and then frozen.
//
// Rationale: a ledger is excellent at "what did I spend on 12 June" and useless
// at "what kind of month was June". A year later the rows are still there but
// the context is gone — you cannot tell a one-off flight from a new recurring
// bill by looking at two numbers. So we snapshot the *numbers the model saw*
// alongside the prose, and never regenerate silently: an account of a month that
// changes each time you open it is not a record of anything.

import { streamChat } from './llm.js';
import { loadConfig } from './config.js';
import * as finance from './finance.js';

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

const SYSTEM = `You write short monthly money summaries for one person, in plain language.
You are given real figures — never invent, round loosely, or add numbers that are not there.
Be concrete and neutral. No greetings, no coaching platitudes, no emoji, no markdown headings.
If the month is unremarkable, say so briefly rather than padding.`;

function buildPrompt(month, facts, cur) {
  const m = (n) => `${cur} ${Number(n).toLocaleString('en-US')}`;
  const lines = [
    `Month: ${month}`,
    `Earned ${m(facts.totals.earned)}, spent ${m(facts.totals.spent)}, net ${m(facts.totals.net)}.`,
    facts.totals.savingsRate === null ? '' : `Saved ${facts.totals.savingsRate}% of income.`,
    `Average spend ${m(facts.totals.avgSpendPerDay)} per day.`,
    `Versus ${facts.previousMonth.month}: spending changed by ${m(facts.changeVsPrev.spent)}, income by ${m(facts.changeVsPrev.earned)}.`,
  ].filter(Boolean);

  if (facts.topCategories?.length) {
    lines.push('Top categories: ' + facts.topCategories.slice(0, 6)
      .map(c => `${c.category} ${m(c.total)} (${c.pct}%)`).join(', ') + '.');
  }
  if (facts.biggestMovers?.length) {
    lines.push('Biggest changes vs last month: ' + facts.biggestMovers
      .map(x => `${x.category} ${x.delta >= 0 ? 'up' : 'down'} ${m(Math.abs(x.delta))} (now ${m(x.now)})`).join(', ') + '.');
  }
  if (facts.unusuallyLarge?.length) {
    lines.push('Unusually large purchases for their category: ' + facts.unusuallyLarge
      .map(x => `${x.merchant} ${m(x.amount)} on ${x.date}`).join(', ') + '.');
  }
  if (facts.budgetPressure?.length) {
    lines.push('Budgets: ' + facts.budgetPressure
      .map(b => `${b.category} at ${b.pct}% of ${m(b.budget)}${b.over ? ' (over)' : ''}`).join(', ') + '.');
  }
  if (facts.goal && (facts.goal.minGoal || facts.goal.majorGoal)) {
    lines.push(`Side-income goal progress: ${m(facts.goal.progress)}`
      + (facts.goal.minPct !== null ? `, ${facts.goal.minPct}% of the minimum` : '')
      + (facts.goal.majorPct !== null ? `, ${facts.goal.majorPct}% of the stretch target` : '') + '.');
  }

  return `${lines.join('\n')}

Write the recap as STRICT JSON, nothing else:

{
  "headline": string,   // at most 60 characters, the gist of the month, e.g. "Rent rose; eating out doubled"
  "summary": string     // 3-5 sentences: what defined the month, what changed and why it likely changed, anything worth remembering later. Reference the actual figures.
}`;
}

/** Generate (or regenerate) the recap for a month and store it. */
export async function generateRecap(month, { model, force = false, signal } = {}) {
  const existing = finance.getRecap(month);
  if (existing.summary && !force) return existing;

  const facts = finance.insights({ month });
  if (!facts.totals.earned && !facts.totals.spent) {
    throw bad(`nothing recorded in ${month} — there is no month to summarise yet`);
  }

  const cfg = loadConfig();
  const modelRef = String(model || cfg.finance?.recapModel || cfg.defaults?.chatModel || '').trim();
  if (!modelRef) throw bad('no model configured — set a default chat model in Settings');

  const res = await streamChat({
    modelRef,
    system: SYSTEM,
    messages: [{ role: 'user', text: buildPrompt(month, facts, facts.currency) }],
    maxTokens: 1600,
    sampling: { temperature: 0.3 },
    signal,
  });

  const text = res.text || res.reasoning || '';
  const { extractJSON } = await import('./util.js');
  const obj = extractJSON(text, { require: ['summary', 'headline'] }) || {};
  let headline = String(obj.headline || '').trim().slice(0, 200);
  let summary = String(obj.summary || '').trim();

  // A model that ignored the JSON instruction still produced usable prose —
  // keep it rather than failing the whole recap.
  if (!summary) summary = String(text).trim().slice(0, 4000);
  if (!summary) throw bad('the model returned nothing — try a different model');
  if (!headline) headline = summary.split(/(?<=\.)\s/)[0].slice(0, 60);

  return finance.saveRecap(month, { summary, headline, facts, model: modelRef });
}
