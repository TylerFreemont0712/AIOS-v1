// Job-search AI: resume parsing, fit-scoring, cover letters, questionnaire answers,
// and platform-availability classification. Plain prompts over streamChat (no tool
// calling), so every provider works — including the local 9B. All outputs are
// grounded in the profile; prompts forbid invented facts.

import { loadConfig, contextBudget } from './config.js';
import { streamChat } from './llm.js';
import { getProfile, profileText, mergeParsedResume } from './profile.js';

function modelFor(modelRef) {
  const cfg = loadConfig();
  const ref = modelRef || cfg.jobsearch?.defaultModel || cfg.defaults.chatModel;
  if (!ref) throw Object.assign(new Error('no model selected — pick one in the Job Search header'), { status: 400 });
  return ref;
}

async function llm(prompt, { modelRef, system, maxTokens = 2048, signal } = {}) {
  const ref = modelFor(modelRef);
  const { inputChars } = contextBudget({ modelRef: ref, wantOutput: maxTokens });
  if (prompt.length > inputChars) prompt = prompt.slice(0, inputChars) + '\n…(truncated)';
  const res = await streamChat({
    modelRef: ref, maxTokens, signal,
    system: system || 'You are a precise assistant helping with a job search. Follow the output format EXACTLY. Never invent facts about the candidate.',
    messages: [{ role: 'user', text: prompt }],
  });
  return res.text || '';
}

/** Pull the first JSON object out of model output, tolerating fences and trailing prose. */
export function extractJSON(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  // walk to the matching close brace (string-aware)
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    else if (!inStr && ch === '{') depth++;
    else if (!inStr && ch === '}') {
      depth--;
      if (depth === 0) {
        const cand = cleaned.slice(start, i + 1);
        try { return JSON.parse(cand); } catch { }
        try { return JSON.parse(cand.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }  // strip trailing commas
      }
    }
  }
  return null;
}

// ---------- resume import ----------

export async function parseResume(text, { modelRef } = {}) {
  text = String(text || '').trim();
  if (text.length < 60) throw Object.assign(new Error('paste your resume text (at least a few lines)'), { status: 400 });
  const out = await llm(
    `Parse this resume into JSON. Use EXACTLY this schema (omit nothing; use "" or [] when unknown):
{"contact":{"name":"","email":"","phone":"","location":"","links":{"linkedin":"","github":"","portfolio":""}},
"summary":"one-paragraph professional summary in the candidate's voice",
"skills":[{"name":"","years":0}],
"experience":[{"title":"","org":"","start":"YYYY-MM","end":"YYYY-MM or present","bullets":["accomplishment"]}],
"education":[{"school":"","degree":"","field":"","year":""}],
"projects":[{"name":"","description":"","url":""}],
"certifications":[""],
"languages":[{"lang":"","level":""}],
"workAuth":"visa / work authorization if mentioned"}
Rules: extract ONLY what the resume states; do not invent. Output ONLY the JSON object.

RESUME:
${text}`,
    { modelRef, maxTokens: 3000 });
  const parsed = extractJSON(out);
  if (!parsed) throw new Error('could not parse the resume — the model returned malformed JSON; try again or a bigger model');
  return mergeParsedResume(parsed);
}

// ---------- fit scoring ----------

export async function scoreJob(job, { modelRef } = {}) {
  const out = await llm(
    `Candidate profile:
${profileText()}

Job posting:
Title: ${job.title || '?'} · Company: ${job.company || '?'} · Location: ${job.location || '?'} ${job.remote ? '(remote)' : ''}
${(job.snippet || job.description || '').slice(0, 2500)}

Score how well this candidate fits THIS job. Output ONLY JSON:
{"score": 0-100, "verdict": "one sentence", "reasons": ["why it fits, max 3"], "gaps": ["what's missing, max 2"]}`,
    { modelRef, maxTokens: 600 });
  const j = extractJSON(out);
  if (!j || typeof j.score !== 'number') throw new Error('fit-scoring failed (malformed model output)');
  return {
    score: Math.max(0, Math.min(100, Math.round(j.score))),
    verdict: String(j.verdict || '').slice(0, 240),
    reasons: (j.reasons || []).slice(0, 3).map(String),
    gaps: (j.gaps || []).slice(0, 2).map(String),
    at: new Date().toISOString(),
  };
}

// ---------- cover letter / proposal ----------

export async function coverLetter(job, { modelRef, lang = 'auto', kind = 'letter' } = {}) {
  const jp = lang === 'ja' || (lang === 'auto' && /[぀-ゟ゠-ヿ一-鿿]/.test(`${job.title} ${job.snippet || ''}`));
  const p = getProfile();
  const out = await llm(
    `Candidate profile:
${profileText()}

Job:
Title: ${job.title || '?'} · Company: ${job.company || '?'} · Location: ${job.location || '?'}
${(job.snippet || job.description || '').slice(0, 2500)}

Write a ${kind === 'proposal' ? 'freelance proposal' : 'cover letter'} for this application.
Rules:
- ${jp ? 'Write it in polite Japanese (敬体). Add an English translation after a "---" line.' : 'Write it in English.'}
- Max 220 words (or ~400 Japanese characters). Specific, not generic — reference 2-3 concrete matches between the candidate's experience and this job.
- Tone: ${p.voice?.tone || 'professional, warm, concise'}. First person. No placeholders like [Company] — use what you know; omit what you don't.
- Use ONLY facts from the profile. Output only the ${kind === 'proposal' ? 'proposal' : 'letter'} text.`,
    { modelRef, maxTokens: 1200 });
  return out.trim();
}

// ---------- questionnaire / application answers ----------

export async function answerQuestions(questions, { modelRef, job } = {}) {
  questions = String(questions || '').trim();
  if (!questions) throw Object.assign(new Error('no questions provided'), { status: 400 });
  const out = await llm(
    `Candidate profile (the ONLY source of truth about the candidate):
${profileText()}
${job ? `\nThey are applying to: ${job.title} at ${job.company} — ${(job.snippet || '').slice(0, 800)}\n` : ''}
Below are application-form questions. Answer each one AS the candidate, ready to paste into the form.
Rules:
- Ground every answer in the profile. If the profile lacks the needed fact, answer with "[FILL IN: what's needed]" instead of guessing.
- Match each question's language (answer Japanese questions in Japanese).
- Keep answers form-appropriate: short factual ones one line; "why us / motivation" ones 3-5 sentences.
- Output format: repeat each question as "**Q:** …" then "**A:** …", nothing else.

QUESTIONS:
${questions.slice(0, 4000)}`,
    { modelRef, maxTokens: 2000 });
  return out.trim();
}

// ---------- job extraction from scraped pages ----------

/** Turn a scraped job-board page (markdown) into structured jobs using our own
 *  model — works with self-hosted Firecrawl, which has no LLM of its own. */
export async function extractJobsFromMarkdown(markdown, { modelRef, source = 'web', query = '' } = {}) {
  const md = String(markdown || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')           // images (incl. base64 blobs)
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 14000);
  if (md.trim().length < 200) return [];
  const out = await llm(
    `Below is a scraped job-board listing page. Extract the individual job postings${query ? ` that are relevant to the search "${query}"` : ''}.
Output ONLY JSON: {"jobs":[{"title":"","company":"","location":"","salary":"","url":"","snippet":"one-line summary"}]}
Rules: use the posting's own link from the markdown for "url" (absolute if possible); "" for unknown fields; max 15 jobs; skip ads/navigation/categories — only real job postings.

PAGE (${source}):
${md}`,
    { modelRef, maxTokens: 2500 });
  const j = extractJSON(out);
  return (j?.jobs || []).filter(x => x && x.title).slice(0, 15);
}

// ---------- platform availability classification ----------

export async function classifyAvailability(pageText, platformName, { modelRef } = {}) {
  const out = await llm(
    `This is text from ${platformName}, a data-annotation / gig-work platform (a worker dashboard or public page).
Classify the current state for a worker. Output ONLY JSON:
{"state":"tasks_available|no_tasks|assessment_pending|logged_out|signup_open|waitlist|unknown","evidence":"short quote or reason","confidence":"high|medium|low"}

PAGE TEXT:
${String(pageText || '').slice(0, 5000)}`,
    { modelRef, maxTokens: 300 });
  const j = extractJSON(out);
  if (!j || !j.state) return { state: 'unknown', evidence: 'model output unparseable', confidence: 'low' };
  return { state: String(j.state), evidence: String(j.evidence || '').slice(0, 300), confidence: String(j.confidence || 'low') };
}
