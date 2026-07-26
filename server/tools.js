// The agent's tool belt. Every path is confined to the session's work root.
// Tools are classified read/write; write tools go through the approval gate in agent.js.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { safePath, truncate, isBinary, walk } from './util.js';
import { loadConfig, DATA } from './config.js';
import { listSkills, getSkill } from './skills.js';
import { search as vaultSearch, index as vaultIndex, readNote as vaultReadNote, writeNote as vaultWriteNote, dailyCapture, generateWiki } from './vault.js';
import * as wiki from './wiki.js';
import * as forge from './toolforge.js';
import * as planner from './planner.js';
import * as git from './git.js';
import * as geo from './geo.js';
import * as everyday from './everyday.js';
import * as finance from './finance.js';
import * as notify from './notify.js';
import * as bench from './bench.js';
import { gpuStats } from './gpu.js';
import { llmStatus as llmctlStatus } from './llmctl.js';
import { probeServices } from './services.js';
import { fetchRecent as mailRecent, searchMail, readMessage as mailRead } from './mail.js';

export const TOOL_DEFS = [
  {
    name: 'bash', write: true, group: 'system', core: true,
    description: 'Run a bash command in the project root. Returns combined stdout/stderr. Use for builds, tests, git, package managers, and anything the file tools do not cover. Long output is truncated.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run with bash -c' },
        timeout_ms: { type: 'number', description: 'Kill after this many ms (default 60000, max 300000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file', write: false, group: 'files', core: true,
    description: 'Read a text file. Returns line-numbered content. Use offset/limit for large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to project root' },
        offset: { type: 'number', description: '1-based line to start from' },
        limit: { type: 'number', description: 'Max lines to return (default 2000)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file', write: true, group: 'files', core: true,
    description: 'Create or overwrite a file with the given content. Creates parent directories.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file', write: true, group: 'files', core: true,
    description: 'Replace an exact string in a file. old_string must match exactly once (or set replace_all). Include enough surrounding context to make it unique.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_dir', write: false, group: 'files',
    description: 'List a directory. Returns names with type and size, directories first.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative path, empty for root' } } },
  },
  {
    name: 'glob', write: false, group: 'files',
    description: 'Find files matching a glob pattern like "src/**/*.ts". Skips node_modules/.git. Returns up to 300 paths, newest first.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Subdirectory to search in' } },
      required: ['pattern'],
    },
  },
  {
    name: 'grep', write: false, group: 'files',
    description: 'Search file contents with a regex (POSIX extended). Returns matching lines as path:line:text.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Subdirectory to search in' },
        include: { type: 'string', description: 'Filename glob filter, e.g. "*.js"' },
        ignore_case: { type: 'boolean' },
        max_results: { type: 'number', description: 'Default 200' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'move_path', write: true, group: 'files',
    description: 'Move or rename a file or directory within the project. Refuses to replace an existing destination unless overwrite is true.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string' }, to: { type: 'string' },
        overwrite: { type: 'boolean', description: 'Replace the destination if it already exists (destroys it)' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'delete_path', write: true, group: 'files',
    description: 'Delete a file, or a directory when recursive is true.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } }, required: ['path'] },
  },
  {
    name: 'git_status', write: false, group: 'git',
    description: 'Show the git state of the project: current branch, changed/untracked files, and last commit. Run it before starting work and again before committing.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git_diff', write: false, group: 'git',
    description: 'Show uncommitted changes as a unified diff (working tree vs HEAD). Review your own edits with this before committing. Optionally scope to one path, a base ref, or staged-only.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Limit the diff to this file or folder' },
        base: { type: 'string', description: 'Diff against this ref instead of HEAD (e.g. "main")' },
        staged: { type: 'boolean', description: 'Show staged changes only' },
      },
    },
  },
  {
    name: 'git_log', write: false, group: 'git',
    description: 'Recent commit history, one line per commit. Use it to see what changed lately or to find a commit to reference.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many commits (default 15, max 50)' },
        path: { type: 'string', description: 'Only commits touching this path' },
      },
    },
  },
  {
    name: 'git_branch', write: true, group: 'git',
    description: 'Create and switch to a new branch. Do this BEFORE the first edit of a new piece of work on a repo, with a short descriptive name like "aios/fix-login-css". Uncommitted changes carry over.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Branch name, e.g. "aios/add-dark-mode"' },
        from: { type: 'string', description: 'Start point ref (default: current HEAD)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'git_switch', write: true, group: 'git',
    description: 'Switch to an existing branch. Fails safely if uncommitted changes would be overwritten (commit or ask the user first).',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'git_commit', write: true, group: 'git',
    description: 'Stage ALL changes and commit them. Message: imperative subject ≤ 72 chars (conventional-commit prefix welcome), optional body after a blank line. Commit when a coherent unit of work is done and verified.',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Full commit message (subject + optional body)' } },
      required: ['message'],
    },
  },
  {
    name: 'git_init', write: true, group: 'git',
    description: 'Initialize a git repository in the project root (default branch "main"). Use when starting project work in a folder with no version control.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git_push', write: true, group: 'git',
    description: 'Push the current branch to origin (sets upstream on first push). Never creates repos or commits — fails with a clear reason when there is no remote, no commits, or the remote is ahead (pull first). Push only after the user asked, or after a commit they approved.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git_pull', write: true, group: 'git',
    description: 'Pull from origin with rebase + autostash. On conflicts the rebase is aborted automatically — the working tree comes back untouched and the error names the conflicting files. Safe to run with uncommitted local changes.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'skill', write: false, group: 'system',
    description: `Read a best-practices playbook before working in an area you have not read a playbook for this session. Available: ${listSkills().join(', ') || 'core'}.`,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Playbook name, e.g. "testing" or "python"' } },
      required: ['name'],
    },
  },
  {
    name: 'web_search', write: false, group: 'web',
    description: 'Search the web via the local SearXNG metasearch instance (falls back to DuckDuckGo). Returns numbered results with title, URL, and snippet. Follow up with fetch_url to read a promising result.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query — keep it short and keyword-like' },
        max_results: { type: 'number', description: 'How many results (default 8, max 20)' },
        category: { type: 'string', enum: ['general', 'it', 'science', 'news', 'files'], description: 'Search category (default general; "it" is best for programming)' },
        time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Only results from this recent period' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_url', write: false, group: 'web',
    description: 'Fetch a URL and return its text content (HTML is stripped to readable text). Use to read documentation or a web_search result in full. Long pages are returned one window at a time — the reply says how to get the next one.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_chars: { type: 'number', description: 'Characters to return per call (default 20000, max 100000)' },
        offset: { type: 'number', description: 'Character offset to resume from — use the value the previous call reported' },
      },
      required: ['url'],
    },
  },
  {
    name: 'crawl_site', write: false, group: 'web',
    description: 'Crawl a website: start at a URL and follow its links (same site) to read SEVERAL pages, returning their readable text. Unlike fetch_url (one page), this surveys a whole section of a site. Give a `query` to keep only the pages relevant to it. Use for docs spread across pages, product/company sites, or "read this site and tell me X".',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Start URL' },
        query: { type: 'string', description: 'Optional — rank/keep only pages matching these keywords' },
        max_pages: { type: 'number', description: 'Pages to fetch (default 6, max 20)' },
        depth: { type: 'number', description: 'How many link-hops from the start page (default 2, max 3)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'wikipedia', write: false, group: 'web',
    description: 'Look something up on Wikipedia and get a concise summary with the article link. Fast and reliable for people, places, history, science, definitions — anything encyclopedic. Prefer this over a general web_search for well-known topics.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic or title, e.g. "Suma-ku, Kobe" or "photosynthesis"' },
        lang: { type: 'string', description: 'Wikipedia language code (default "en"; "ja" for Japanese)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'directions', write: false, group: 'maps',
    description: 'Travel time and distance between two places. Origin defaults to the user\'s home when omitted (or say "home"). Modes: driving (default), walking, cycling, transit. Driving/walking/cycling are free; transit (train/bus) needs a Google key in Settings → Tools → Maps. For exact train schedules, also try web_search.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Destination: a place/address ("Suma Station, Kobe") or "lat,lon"' },
        from: { type: 'string', description: 'Origin; omit or "home" for the user\'s home location' },
        mode: { type: 'string', enum: ['driving', 'walking', 'cycling', 'transit'], description: 'Default driving' },
      },
      required: ['to'],
    },
  },
  {
    name: 'find_places', write: false, group: 'maps',
    description: 'Find real places near a location using OpenStreetMap — stations, shops, restaurants, pharmacies, landmarks, addresses. Returns names, addresses and distance from the reference point (the user\'s home by default). Use for everyday local questions like "nearest convenience store" or "where is X".',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, e.g. "pharmacy", "Takatsuki station", "ramen"' },
        near: { type: 'string', description: 'Reference place; omit or "home" for the user\'s home' },
        limit: { type: 'number', description: 'Max results (default 6, max 15)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'weather', write: false, group: 'maps',
    description: 'Current conditions and a multi-day forecast for any place (defaults to the user\'s home). Free, no key (Open-Meteo). Use for "what\'s the weather", "will it rain", trip planning.',
    parameters: {
      type: 'object',
      properties: {
        place: { type: 'string', description: 'Place name or "lat,lon"; omit or "home" for the user\'s home' },
        days: { type: 'number', description: 'Forecast days (default 3, max 10)' },
      },
    },
  },
  {
    name: 'translate', write: false, group: 'utility',
    description: 'Translate text between languages (auto-detects the source). Handy for daily life in Japan — read a sign, a menu, an email, or draft a reply in Japanese. Default target is English.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        to: { type: 'string', description: 'Target language code, e.g. "en", "ja", "es" (default "en")' },
        from: { type: 'string', description: 'Source language code; omit to auto-detect' },
      },
      required: ['text'],
    },
  },
  {
    name: 'calculate', write: false, group: 'utility',
    description: 'Evaluate a math expression exactly (no guessing arithmetic). Supports + - * / %, ^ power, parentheses, and functions like sqrt, log, ln, sin/cos/tan, round, min, max, fact. Constants pi, e, tau.',
    parameters: { type: 'object', properties: { expression: { type: 'string', description: 'e.g. "(1200*1.1)/3" or "sqrt(2)*pi"' } }, required: ['expression'] },
  },
  {
    name: 'convert', write: false, group: 'utility',
    description: 'Convert a value between units — length, mass, volume, speed, data, time, temperature — or between currencies (live rates, ISO codes like USD/JPY). e.g. 10 km→mi, 100 usd→jpy, 25 c→f.',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'number' },
        from: { type: 'string', description: 'Unit or 3-letter currency code, e.g. "km", "kg", "usd"' },
        to: { type: 'string', description: 'Unit or currency to convert to, e.g. "mi", "lb", "jpy"' },
      },
      required: ['value', 'from', 'to'],
    },
  },
  {
    name: 'datetime', write: false, group: 'utility',
    description: 'Get the current date/time (optionally in a timezone) and compute time until/since a date. Use for "what time is it in Tokyo/New York", "how many days until X". Local and exact — do not do this math in your head.',
    parameters: {
      type: 'object',
      properties: {
        tz: { type: 'string', description: 'IANA timezone, e.g. "Asia/Tokyo", "America/New_York" (default: server local)' },
        until: { type: 'string', description: 'A date (YYYY-MM-DD or ISO) to count down/up to' },
      },
    },
  },
  {
    name: 'vault_search', write: false, group: 'vault',
    description: 'Search the Obsidian knowledge base (your second brain / LLM wiki) for notes matching a query. Returns matching notes with path, title, and an excerpt. Consult it BEFORE writing code or answering — it holds curated docs and past learnings that reduce errors.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'default 10, max 30' } }, required: ['query'] },
  },
  {
    name: 'vault_list', write: false, group: 'vault',
    description: 'List notes in the knowledge base, optionally under a folder (e.g. "AI Wiki/PyQt6"). Returns note paths and titles so you can see what already exists before adding more.',
    parameters: { type: 'object', properties: { folder: { type: 'string', description: 'Folder prefix to filter by; empty for all' } } },
  },
  {
    name: 'vault_read', write: false, group: 'vault',
    description: 'Read a knowledge-base note by its vault-relative path (e.g. "AI Wiki/PyQt6/QTableWidget.md"). Returns the markdown.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'vault_write', write: true, group: 'vault',
    description: 'Create or overwrite a knowledge-base note (markdown). Use to build and maintain the wiki. Path is vault-relative; organise under folders like "AI Wiki/PyQt6/…". Keep notes atomic (one topic each) and link related notes with [[wikilinks]] so the graph stays connected.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'vault_append', write: true, group: 'vault',
    description: 'Append a markdown section to a knowledge-base note (creates it if missing). Good for growing a note incrementally with new details.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'wiki_recall', write: false, group: 'vault',
    description: 'Your long-term memory: fetch the most relevant knowledge-base notes for a query as ONE packed context block (note bodies, not just excerpts). Use this FIRST when starting work on any topic the wiki might cover — it replaces several vault_search + vault_read round-trips.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, max_chars: { type: 'number', description: 'Budget for the packed block (default 6000)' } }, required: ['query'] },
  },
  {
    name: 'wiki_learn', write: true, group: 'vault',
    description: 'Save durable knowledge to the wiki the right way: give a title and markdown body; frontmatter, tags, [[autolinks]] to existing notes, and the Home index are handled for you. Use whenever you learn something reusable (an API, a decision, a fix, a concept). Pick a `kind` and follow its template (see note_template / the notes skill). Writes into the wiki folder and is normally pre-approved.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Concise noun phrase, e.g. "QTableWidget cell editing"' },
        content: { type: 'string', description: 'Markdown body — definition first, then details/examples, then a Related section' },
        kind: { type: 'string', enum: ['concept', 'howto', 'reference', 'decision', 'troubleshooting', 'source', 'project'], description: 'Note type — stamps frontmatter and implies the template (note_template shows it)' },
        folder: { type: 'string', description: 'Optional subfolder inside the wiki, e.g. "PyQt6"' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'note_template', write: false, group: 'vault',
    description: 'Get the canonical template for a note kind (concept, howto, reference, decision, troubleshooting, source, project) before writing it with wiki_learn. Call without a kind to list all kinds and when to use each.',
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string', description: 'One of the note kinds; omit to list them' } },
    },
  },
  {
    name: 'wiki_index', write: true, group: 'vault',
    description: 'Regenerate the wiki\'s Home.md map-of-content (notes grouped by folder, recent updates, orphans). Runs automatically after wiki_learn/wiki_generate; call it directly after bulk vault_write edits.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'wiki_generate', write: true, group: 'vault',
    description: 'Grow the wiki autonomously: generate a small web of interlinked atomic notes about a topic (uses the session model). Use when the user wants a topic documented or you need a knowledge scaffold to build on. Prefer wiki_learn for single facts.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        count: { type: 'number', description: 'How many notes (default 5, max 12)' },
        source_note: { type: 'string', description: 'Optional vault-relative note path to expand from instead of a topic' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'daily_log', write: true, group: 'vault',
    description: 'Append a timestamped bullet to today\'s daily note in the vault. Use to log notable events, decisions, or completed work so the user\'s journal stays current.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'quick_note', write: true, group: 'vault',
    description: 'Quickly save a note to the user\'s knowledge base (their Obsidian vault). Files it under "Notes/" by default. Additive and safe: if a note with the same title exists, your text is appended, never overwritten. Use whenever the user says "note this", "save this", "remember that", or wants to jot something down.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short note title (becomes the filename)' },
        content: { type: 'string', description: 'Markdown body of the note' },
        folder: { type: 'string', description: 'Vault subfolder (default "Notes")' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'research_start', write: false, group: 'apps',
    description: 'Start a deep-research run (plan → web search → read sources → cited report) in the background and return its id. The report lands in the Research app and auto-exports to the wiki when done. Use for questions needing multiple sources; poll research_status while doing other work.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        depth: { type: 'string', enum: ['quick', 'standard', 'deep'], description: 'Default standard; quick for a fast pass' },
      },
      required: ['question'],
    },
  },
  {
    name: 'research_status', write: false, group: 'apps',
    description: 'Check a deep-research run: status, phase, sources gathered, and the report (when finished). Research takes minutes — do other useful work between polls.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'agenda_view', write: false, group: 'apps',
    description: 'Read the user\'s schedule for a day from the Planner app: calendar events, tasks due, and overdue tasks. Check it when work involves dates, deadlines, or planning.',
    parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD (default: today)' } } },
  },
  {
    name: 'finance_summary', write: false, group: 'apps',
    description: 'Totals from the user\'s Finances ledger for a period: earned, spent, net, savings rate, and the biggest spending categories. Use whenever money, affordability, budgets or "can I" questions come up — do not guess at their finances.',
    parameters: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'YYYY-MM. Omit to use `range` instead.' },
        range: { type: 'string', enum: ['this-month', 'last-month', 'this-year', '30d', '90d', 'all'], description: 'Relative period (default this-month)' },
      },
    },
  },
  {
    name: 'finance_search', write: false, group: 'apps',
    description: 'List individual transactions from the Finances ledger, filtered by period, kind, category or free text. Use to answer "what did I spend at X", "show my subscriptions", or to check something before logging a duplicate.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Matches merchant, note or category' },
        kind: { type: 'string', enum: ['income', 'expense'] },
        category: { type: 'string' },
        month: { type: 'string', description: 'YYYY-MM' },
        range: { type: 'string', enum: ['this-month', 'last-month', 'this-year', '30d', '90d', 'all'] },
        limit: { type: 'number', description: 'Max rows (default 25, max 100)' },
      },
    },
  },
  {
    name: 'finance_insights', write: false, group: 'apps',
    description: 'Analysis of a month\'s spending: change vs the previous month, the categories that moved most, unusually large purchases, budgets under pressure, and goal progress. Use for "why was this month expensive", "how am I doing", or before giving any budgeting advice.',
    parameters: {
      type: 'object',
      properties: { month: { type: 'string', description: 'YYYY-MM (default: this month)' } },
    },
  },
  {
    name: 'finance_log', write: true, group: 'apps',
    description: 'Record one transaction in the user\'s Finances ledger. Use when they say they spent or earned something ("log 1200 yen for lunch", "I got paid 50000"). Amounts are positive; `kind` carries the direction. Check finance_search first if a duplicate looks likely.',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Positive amount, in `currency`' },
        kind: { type: 'string', enum: ['income', 'expense'], description: 'Default expense' },
        category: { type: 'string', description: 'Must be one of the app\'s categories — call finance_summary first if unsure' },
        merchant: { type: 'string', description: 'Shop, employer or payer' },
        note: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD (default: today)' },
        currency: { type: 'string', description: 'ISO code (default: the user\'s base currency)' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'task_list', write: false, group: 'apps',
    description: 'List to-dos from the user\'s Planner, newest first, with their ids. Call this before task_done (you need the id), and to check whether something is already tracked instead of adding a duplicate.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'done', 'all'], description: 'Default open' },
        limit: { type: 'number', description: 'Default 25, max 100' },
      },
    },
  },
  {
    name: 'task_done', write: true, group: 'apps',
    description: 'Tick off a Planner to-do (or re-open it). Use when the user says something is finished, or when you have just completed work that a task was tracking. Get the id from task_list.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id from task_list' },
        done: { type: 'boolean', description: 'Default true; pass false to re-open' },
      },
      required: ['id'],
    },
  },
  {
    name: 'notify', write: true, group: 'apps',
    description: 'Send the user a push notification (Discord webhook) they will see away from this screen. Use ONLY for something they genuinely need to know now — a long job finished, a build broke, a decision is blocking you. Never for progress chatter; they are already reading the transcript.',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'One or two sentences, plain text' } },
      required: ['message'],
    },
  },
  {
    name: 'system_status', write: false, group: 'system',
    description: 'This machine\'s live state: GPU model and free VRAM, which local model llama.cpp is currently serving, and the health of every AIOS service (ComfyUI, SearXNG, mail, …). Check the free VRAM before starting anything GPU-heavy like comfy_generate, and check here first when a local model call fails.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'bench_best', write: false, group: 'system',
    description: 'The measured leaderboard of the user\'s LOCAL models, from the Bench app: which model actually scores best per task category (coding, reasoning, extraction, …) with its speed. Use when choosing a local model, or when the user asks which of their models to use for something — this is real measured data, so prefer it over guessing from model names.',
    parameters: {
      type: 'object',
      properties: { category: { type: 'string', description: 'Filter to one task category; omit for the whole board' } },
    },
  },
  {
    name: 'sql_query', write: false, group: 'system',
    description: 'Run a read-only SELECT against one of AIOS\'s own SQLite databases: "finance" (transactions, budgets, goals, presets, recurring, receipts), "learn" (subjects, lessons, assessments, mastery) or "bench" (model benchmark runs). Use for questions the purpose-built tools cannot express — cross-table joins, custom groupings, arbitrary date maths. Call with no `sql` to get the schema.',
    parameters: {
      type: 'object',
      properties: {
        db: { type: 'string', enum: ['finance', 'learn', 'bench'] },
        sql: { type: 'string', description: 'A single SELECT (or WITH … SELECT). Omit to print the schema instead.' },
        limit: { type: 'number', description: 'Max rows returned (default 50, max 500)' },
      },
      required: ['db'],
    },
  },
  {
    name: 'github_work', write: false, group: 'git',
    description: 'The user\'s open GitHub pull requests and issues across their repos (from the configured token). Use when work relates to a PR or issue, or to see what is outstanding before starting something new.',
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['prs', 'issues', 'both'], description: 'Default both' } },
    },
  },
  {
    name: 'task_add', write: true, group: 'apps',
    description: 'Add a to-do to the user\'s Planner. Additive and normally pre-approved. Use when the user mentions something they must do, or when finished work needs a follow-up they should see.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        due: { type: 'string', description: 'YYYY-MM-DD, omit if undated' },
        priority: { type: 'number', description: '0 normal · 1 high · 2 urgent' },
        notes: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'event_add', write: true, group: 'apps',
    description: 'Add a calendar event to the user\'s Planner (appointment, deadline, meeting). Additive and normally pre-approved.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        start: { type: 'string', description: 'HH:MM 24h — omit for all-day' },
        end: { type: 'string', description: 'HH:MM 24h' },
        recur: { type: 'string', enum: ['', 'daily', 'weekly', 'monthly', 'yearly'] },
        notes: { type: 'string' },
      },
      required: ['title', 'date'],
    },
  },
  {
    name: 'comfy_generate', write: true, group: 'apps',
    description: 'Generate images on the local ComfyUI (SDXL-Lightning txt2img). AIOS frees the GPU automatically (swaps the LLM to a tiny CPU profile) — expect the swap on first use. Blocks until the render finishes; results appear in the Studio app.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to render — concrete, visual language' },
        negative: { type: 'string', description: 'What to avoid (optional)' },
        width: { type: 'number', description: 'Default 1024' },
        height: { type: 'number', description: 'Default 1024' },
        count: { type: 'number', description: '1-4 images (default 1)' },
        seed: { type: 'number', description: 'Fixed seed for reproducibility (optional)' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'comfy_status', write: false, group: 'apps',
    description: 'Check the local ComfyUI: reachable? VRAM free? which llama.cpp profile is live? recent renders. Use before comfy_generate when unsure.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'mail_recent', write: false, group: 'mail',
    description: 'List the user\'s most recent inbox messages over IMAP (read-only — nothing is marked seen). Returns uid, from, subject, date, and a snippet. Use mail_read with a uid for the full message.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max messages (default 15, max 30)' },
        days: { type: 'number', description: 'Look back this many days (default 3)' },
      },
    },
  },
  {
    name: 'mail_search', write: false, group: 'mail',
    description: 'Search the user\'s inbox (read-only). Query syntax: plain words search body text; "from:alice", "to:bob", "subject:\\"weekly report\\"", and "is:unread" filter. Example: "from:recruiter is:unread interview".',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        days: { type: 'number', description: 'Look back window in days (default 30)' },
        limit: { type: 'number', description: 'Max results (default 15, max 30)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'mail_read', write: false, group: 'mail',
    description: 'Read one email in full by its uid (from mail_recent/mail_search). Read-only — the message stays unread. Returns headers and the cleaned text body.',
    parameters: { type: 'object', properties: { uid: { type: 'number' } }, required: ['uid'] },
  },
  {
    name: 'create_tool', write: true, group: 'system',
    description: `Forge a new tool for yourself when a needed capability is missing and likely to be reused (an API wrapper, a converter, a checker). It becomes callable next turn and persists across sessions. Write plain JS statements for the body of \`async (args, ctx) => {...}\` — return a string or JSON-able value. ctx API: fetchText(url), fetchJSON(url,{method,headers,body}), webSearch(q,n), readFile(rel), listDir(rel), vaultSearch(q), vaultRead(path), llm(prompt,{maxTokens}), log(msg); access:"write" additionally grants writeFile(rel,content) + vaultWrite(path,content). Declare the LEAST access needed. Example code:\n${forge.TOOL_TEMPLATE}`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'snake_case, e.g. "currency_convert"' },
        description: { type: 'string', description: 'When to use it — you will pick tools from this later' },
        parameters: { type: 'object', description: 'JSON schema: {"type":"object","properties":{...},"required":[...]}' },
        access: { type: 'string', enum: ['read', 'write'], description: '"read" = no side effects (preferred)' },
        code: { type: 'string', description: 'JS body of async (args, ctx) => {...}' },
      },
      required: ['name', 'description', 'parameters', 'access', 'code'],
    },
  },
  {
    name: 'list_custom_tools', write: false, group: 'system',
    description: 'List the custom tools you have forged: name, access, description, run count, last error, and code. Check before creating a similar one.',
    parameters: { type: 'object', properties: { show_code: { type: 'boolean', description: 'Include each tool\'s code' } } },
  },
  {
    name: 'delete_tool', write: true, group: 'system',
    description: 'Delete a custom tool you previously created (e.g. superseded or broken beyond repair).',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },

  {
    name: 'model_auto_setup', write: true, group: 'apps',
    description: 'Automatically tag and configure local gguf models: an LLM reads each filename/size, proposes tags + a serving preset sized to this machine (ctx, KV quant, GPU layers, vision-projector pairing) and saves it. Pass file to configure one model; omit it to configure every model that has no preset yet. Use when the user drops in a new model or asks to "set up" their models.',
    parameters: {
      type: 'object',
      properties: { file: { type: 'string', description: 'A .gguf filename from the Models app; omit for all unconfigured' } },
    },
  },

  // ---- Learning Corner ----------------------------------------------------
  // These let the agent act as the tutor: inspect the student's real record
  // (mastery is measured, not guessed), author assessments question by question,
  // and drive the curriculum. Read tools first so the agent can look before it writes.
  {
    name: 'learn_subjects', write: false, group: 'learning',
    description: 'List every Learning Corner subject with its id, parent (subjects nest: Programming → Python → Graphs), module/lesson counts and overall mastery %. Call this first to find a subject id.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'learn_subject', write: false, group: 'learning',
    description: 'Full detail for one subject: goal, level, breadcrumb path, child subjects, roadmap modules (with topics + done state), lesson list, assessments with best scores, measured weak topics, and what the Corner thinks the student should do next.',
    parameters: {
      type: 'object',
      properties: { subject_id: { type: 'string' } },
      required: ['subject_id'],
    },
  },
  {
    name: 'learn_lesson_read', write: false, group: 'learning',
    description: 'Read the full markdown of one lesson. Use before writing a quiz about it so the questions test what was actually taught rather than what you assume was taught.',
    parameters: {
      type: 'object',
      properties: { subject_id: { type: 'string' }, lesson_id: { type: 'string' } },
      required: ['subject_id', 'lesson_id'],
    },
  },
  {
    name: 'learn_weak_topics', write: false, group: 'learning',
    description: 'The student\'s measured weak spots for a subject: per-topic accuracy from every graded answer, worst first. This is evidence, not vibes — use it to decide what to re-teach or re-test.',
    parameters: {
      type: 'object',
      properties: { subject_id: { type: 'string' }, limit: { type: 'number', description: 'Default 8' } },
      required: ['subject_id'],
    },
  },
  {
    name: 'learn_attempt_review', write: false, group: 'learning',
    description: 'Review one graded attempt question by question: what was asked, what the student answered, whether it was right, the rubric/explanation, and any grader feedback. The highest-signal record of how they actually think.',
    parameters: {
      type: 'object',
      properties: { subject_id: { type: 'string' }, attempt_id: { type: 'string' } },
      required: ['subject_id', 'attempt_id'],
    },
  },
  {
    name: 'learn_create_subject', write: true, group: 'learning',
    description: 'Create a subject, optionally nested under a parent (pass parent_id to make e.g. "Python" a child of "Programming", or "Dijkstra\'s" a child of "Python"). Nests up to 5 deep.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        goal: { type: 'string', description: 'What the student should be able to DO — steers the roadmap' },
        level: { type: 'string', description: 'beginner | intermediate | advanced' },
        parent_id: { type: 'string', description: 'Optional parent subject id' },
      },
      required: ['name'],
    },
  },
  {
    name: 'learn_create_quiz', write: true, group: 'learning',
    description: 'Create an empty assessment shell, then fill it with learn_add_question. kind: quiz (one lesson/module) | midterm (several modules) | final (whole subject) | diagnostic (placement, spans everything). Use this + learn_add_question when you want to author questions yourself; use learn_generate_assessment to have the tutor engine write a whole paper in one shot.',
    parameters: {
      type: 'object',
      properties: {
        subject_id: { type: 'string' },
        kind: { type: 'string', description: 'quiz | midterm | final | diagnostic (default quiz)' },
        title: { type: 'string' },
        blurb: { type: 'string', description: 'One line: what it covers and how it is scored' },
        module_id: { type: 'string', description: 'Optional module this quiz belongs to' },
        lesson_id: { type: 'string', description: 'Optional lesson this quiz belongs to' },
        scope: { type: 'array', items: { type: 'string' }, description: 'Module ids covered (midterm/final)' },
        pass_pct: { type: 'number', description: 'Pass threshold, default by kind (quiz/midterm 70, final 75)' },
      },
      required: ['subject_id'],
    },
  },
  {
    name: 'learn_add_question', write: true, group: 'learning',
    description: 'Add one question to an assessment. kind "mcq": one correct — answer is the 0-based index as a string ("2"). kind "multi": several correct — answer is a JSON index array ("[0,2]"). kind "shortanswer": the student TYPES it — answer is a JSON array of every accepted spelling/alias, graded case/space-insensitively. kind "order": choices are items in scrambled display order — answer is the JSON permutation giving the correct sequence ("[2,0,1]"), partial credit for mostly-right. kind "open": no choices, the model grades against the rubric in answer. Always set topic: it is the key mastery is tracked under, so a typo silently splits the student\'s record.',
    parameters: {
      type: 'object',
      properties: {
        assessment_id: { type: 'string' },
        kind: { type: 'string', description: 'mcq | multi | shortanswer | order | open (default mcq)' },
        prompt: { type: 'string' },
        choices: { type: 'array', items: { type: 'string' }, description: 'mcq: exactly 4; multi: 4-6; order: 3-8 in scrambled order. Distractors must be plausible misconceptions.' },
        answer: { type: 'string', description: 'mcq: "2" · multi: "[0,2]" · shortanswer: \'["alias1","alias2"]\' · order: "[2,0,1]" · open: the rubric' },
        explanation: { type: 'string', description: 'Why the answer is right AND why the tempting wrong one is wrong' },
        topic: { type: 'string', description: '2-4 words; match a roadmap topic where possible' },
        difficulty: { type: 'string', description: 'warmup | core | stretch' },
        points: { type: 'number', description: '1-5, default 1' },
      },
      required: ['assessment_id', 'prompt'],
    },
  },
  {
    name: 'learn_generate_assessment', write: true, group: 'learning',
    description: 'Have the tutor engine write a complete assessment (web-grounded, weighted toward the student\'s measured weak topics) and save it. Runs in the background and streams to the Learning app. Prefer this over hand-authoring unless you need exact control of the questions.',
    parameters: {
      type: 'object',
      properties: {
        subject_id: { type: 'string' },
        kind: { type: 'string', description: 'diagnostic | quiz | midterm | final (default quiz)' },
        module_id: { type: 'string' },
        lesson_id: { type: 'string' },
      },
      required: ['subject_id'],
    },
  },
  {
    name: 'learn_generate_lesson', write: true, group: 'learning',
    description: 'Generate the next lesson for a subject (searches current sources, writes it, exports to the vault). Pass review:true to aim it squarely at the student\'s measured weak topics instead of the next new topic.',
    parameters: {
      type: 'object',
      properties: {
        subject_id: { type: 'string' },
        module_id: { type: 'string', description: 'Optional — defaults to the first unfinished module' },
        focus: { type: 'string', description: 'Optional specific topic to teach' },
        review: { type: 'boolean', description: 'Target measured weak spots' },
      },
      required: ['subject_id'],
    },
  },
  {
    name: 'learn_check_lessons', write: false, group: 'learning',
    description: 'Health-check every lesson in a subject and report what is damaged. Catches the failures that still "succeed": the model narrating a web search instead of writing, output truncated mid-code-fence, unbalanced <details>, missing practice. Run this when the student says a lesson came out wrong.',
    parameters: {
      type: 'object',
      properties: { subject_id: { type: 'string' } },
      required: ['subject_id'],
    },
  },
  {
    name: 'learn_regenerate_lesson', write: true, group: 'learning',
    description: 'Rewrite an existing lesson IN PLACE — same slot, same id, so quizzes and vault notes pointing at it stay valid. The old body is snapshotted to revision history first, so this is never a one-way door. Pass instructions to say what to fix; omit them and the detected health problems are used as the brief. Pass use_web:false to skip research entirely — the escape hatch when web search is what derailed the previous attempt.',
    parameters: {
      type: 'object',
      properties: {
        subject_id: { type: 'string' },
        lesson_id: { type: 'string' },
        instructions: { type: 'string', description: 'What to fix, e.g. "it was truncated — write it complete" or "too shallow on closures"' },
        focus: { type: 'string', description: 'Optionally re-aim the lesson at a different topic' },
        use_web: { type: 'boolean', description: 'Default true. false = write from fundamentals, no search.' },
      },
      required: ['subject_id', 'lesson_id'],
    },
  },
  {
    name: 'learn_lesson_revisions', write: false, group: 'learning',
    description: 'List the saved previous versions of a lesson (every regenerate snapshots one), with why each was replaced. Use with learn_restore_revision to put a better older draft back.',
    parameters: {
      type: 'object',
      properties: { subject_id: { type: 'string' }, lesson_id: { type: 'string' } },
      required: ['subject_id', 'lesson_id'],
    },
  },
  {
    name: 'learn_restore_revision', write: true, group: 'learning',
    description: 'Restore a previous version of a lesson. The current version is snapshotted first, so you can bounce between drafts without losing either.',
    parameters: {
      type: 'object',
      properties: { subject_id: { type: 'string' }, lesson_id: { type: 'string' }, revision_id: { type: 'string' } },
      required: ['subject_id', 'lesson_id', 'revision_id'],
    },
  },
  {
    name: 'learn_suggest_paths', write: true, group: 'learning',
    description: 'Research and store certificate + career-path suggestions for a subject (web-grounded: real certs, current costs, prep time), shown in the Learning app\'s Paths tab. Each suggestion can be adopted as a sub-subject. Use when the student asks "what should I aim for / which cert is worth it".',
    parameters: {
      type: 'object',
      properties: { subject_id: { type: 'string' } },
      required: ['subject_id'],
    },
  },
  {
    name: 'learn_generate_roadmap', write: true, group: 'learning',
    description: 'Design (or redesign) the prerequisite-ordered module roadmap for a subject. Completed modules keep their done state across a redesign, matched by title.',
    parameters: {
      type: 'object',
      properties: { subject_id: { type: 'string' } },
      required: ['subject_id'],
    },
  },
  {
    name: 'learn_record_result', write: true, group: 'learning',
    description: 'Record one graded answer against a topic directly, moving the student\'s mastery. Use when you assessed them conversationally (e.g. you asked a question in chat and judged the answer) so tutoring outside the quiz UI still teaches the Corner what they know.',
    parameters: {
      type: 'object',
      properties: {
        subject_id: { type: 'string' },
        topic: { type: 'string' },
        correct: { type: 'boolean' },
      },
      required: ['subject_id', 'topic', 'correct'],
    },
  },
  {
    name: 'learn_module_done', write: true, group: 'learning',
    description: 'Mark a roadmap module complete (or not). Passing a midterm/final auto-completes the modules it covered, so use this mainly for modules the student finished outside an exam.',
    parameters: {
      type: 'object',
      properties: { subject_id: { type: 'string' }, module_id: { type: 'string' }, done: { type: 'boolean' } },
      required: ['subject_id', 'module_id'],
    },
  },
];

export const WRITE_TOOLS = new Set(TOOL_DEFS.filter(t => t.write).map(t => t.name));
const BUILTIN_NAMES = new Set(TOOL_DEFS.map(t => t.name));

/** Custom (agent-forged) tools mapped to the built-in def shape. */
const customDefs = () => forge.listCustomTools()
  .filter(t => !BUILTIN_NAMES.has(t.name))
  .map(t => ({ name: t.name, description: t.description, parameters: t.parameters, write: t.access === 'write', group: 'custom', custom: true }));

export const enabledTools = () => {
  const cfg = loadConfig();
  const disabled = new Set(cfg.tools?.disabled || []);
  const hasVault = !!cfg.vault?.path;
  const hasMail = !!(cfg.mail?.host && cfg.mail?.user && cfg.mail?.password);
  // vault/mail tools only make sense once those integrations are connected;
  // git tools only when the git binary exists on this machine
  return [...TOOL_DEFS, ...customDefs()].filter(t =>
    !disabled.has(t.name) && (t.group !== 'vault' || hasVault) && (t.group !== 'mail' || hasMail)
    && (t.group !== 'git' || git.hasGit()));
};

/** Write classification across built-ins AND custom tools — the approval gate keys off this. */
export function isWriteTool(name) {
  if (WRITE_TOOLS.has(name)) return true;
  if (BUILTIN_NAMES.has(name)) return false;
  return forge.getCustomTool(name)?.access === 'write';
}

/** Additive upkeep calls (wiki folder, daily note, generated maps, planner items) —
 *  pre-approved by the gate when vault.autoApprove is on. */
export function isWikiScopedCall(name, args) {
  if (['wiki_learn', 'wiki_index', 'wiki_generate', 'daily_log', 'task_add', 'event_add', 'finance_log'].includes(name)) return true;
  if (['vault_write', 'vault_append'].includes(name) && typeof args?.path === 'string') return wiki.isWikiPath(args.path);
  return false;
}

function requireVault() {
  if (!loadConfig().vault?.path) throw new Error('No Obsidian vault is connected — set one in Settings → Vault before using the knowledge base.');
}
function vaultNoteExists(rel) {
  try { return fs.existsSync(safePath(loadConfig().vault.path, rel)); } catch { return false; }
}

/** For the model: enabled defs without our internal flags. Pass `groups` to get only
 *  those groups' tools — the lean loadout sends full schemas for ACTIVE groups only,
 *  because 60+ full schemas cost ~7k tokens per call, which a 32k local model can't
 *  afford on every turn of a long task. */
export const toolSchemas = (groups) => enabledTools()
  .filter(t => !groups || groups.includes(t.group))
  .map(({ name, description, parameters }) => ({ name, description, parameters }));

/** All group names that currently have enabled tools. */
export const toolGroups = () => [...new Set(enabledTools().map(t => t.group))];

// Plain Chat has no project root and no approval gate, so it only gets READ-ONLY,
// root-independent info tools — the ones that make an answer more current or grounded
// (web search/read, the vault, mail, the planner, the learning corner). Files/git/system
// and every write tool are deliberately excluded; use the Agent for those.
const CHAT_TOOL_ALLOW = new Set([
  'web_search', 'fetch_url', 'crawl_site', 'wikipedia',
  'directions', 'find_places', 'weather',
  'translate', 'calculate', 'convert', 'datetime',
  'vault_search', 'vault_list', 'vault_read', 'wiki_recall', 'note_template',
  'mail_recent', 'mail_search', 'mail_read',
  'agenda_view',
  'finance_summary', 'finance_search', 'finance_insights',
  'learn_subjects', 'learn_subject', 'learn_lesson_read', 'learn_weak_topics',
  // additive writes Chat is allowed to make (see CHAT_SAFE_WRITES) — jotting notes,
  // logging the day, adding planner items on request
  'quick_note', 'vault_append', 'daily_log', 'task_add', 'event_add', 'finance_log',
]);
// Chat has no approval gate, so writes are normally Agent-only. These few are the
// exception: additive and non-destructive (create-or-append a note, log the day, add
// a task/event), so an errant call can't clobber anything. Everything else that
// writes stays out of Chat.
const CHAT_SAFE_WRITES = new Set(['quick_note', 'vault_append', 'daily_log', 'task_add', 'event_add', 'finance_log']);
export const isChatSafeWrite = (name) => CHAT_SAFE_WRITES.has(name);

/** Enabled chat tools: read-only plus the additive-safe writes above (respects config
 *  disable + vault/mail availability). */
export const chatTools = () => enabledTools().filter(t => CHAT_TOOL_ALLOW.has(t.name) && (!isWriteTool(t.name) || CHAT_SAFE_WRITES.has(t.name)));
export const chatToolSchemas = () => chatTools().map(({ name, description, parameters }) => ({ name, description, parameters }));

/** Compact per-group directory for the lean loadout's system prompt: one line per
 *  group, tool names with a clause of description each. ~2KB instead of ~29KB. */
export function toolDirectory(excludeGroups = []) {
  const short = (d) => {
    const s = String(d || '').split(/(?<=[.!?])\s/)[0];
    return (s.length > 70 ? s.slice(0, 67) + '…' : s).replace(/\.$/, '');
  };
  const byGroup = {};
  for (const t of enabledTools()) {
    if (excludeGroups.includes(t.group)) continue;
    (byGroup[t.group] ||= []).push(`${t.name} (${short(t.description)})`);
  }
  return Object.entries(byGroup)
    .map(([g, tools]) => `- ${g} [${tools.length}]: ${tools.join('; ')}`)
    .join('\n');
}

/** For the settings UI: every tool with its metadata and current state. */
export function toolCatalog() {
  const disabled = new Set(loadConfig().tools?.disabled || []);
  const base = TOOL_DEFS.map(({ name, description, write, group, core }) => ({
    name, description, write: !!write, group: group || 'files', core: !!core, enabled: !disabled.has(name),
  }));
  const custom = forge.listCustomTools().filter(t => !BUILTIN_NAMES.has(t.name)).map(t => ({
    name: t.name, description: t.description, write: t.access === 'write', group: 'custom', core: false,
    enabled: !disabled.has(t.name), custom: true, runs: t.runs || 0, lastError: t.lastError || '',
  }));
  return [...base, ...custom];
}

/** Is the bundled/configured SearXNG instance answering? */
export async function searxngStatus() {
  const url = (loadConfig().tools?.searxng?.url || '').replace(/\/$/, '');
  if (!url) return { url: '', up: false };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 2500);
  try {
    const r = await fetch(url + '/healthz', { signal: ctl.signal });
    return { url, up: r.ok };
  } catch {
    return { url, up: false };
  } finally { clearTimeout(t); }
}

const SECRET_ENV = /^(ANTHROPIC|OPENAI|AWS|GOOGLE|GH|GITHUB|NPM|CLAUDE)[A-Z_]*(KEY|TOKEN|SECRET)/i;

export async function runTool(name, args, ctx) {
  // ctx: { root, signal, modelRef }
  const impl = impls[name];
  try {
    if (!impl) {
      const def = forge.getCustomTool(name);
      if (!def) return { content: `Unknown tool: ${name}`, isError: true };
      const out = await forge.runCustomTool(def, args || {}, { caps: customCaps(ctx), modelRef: ctx?.modelRef, signal: ctx?.signal });
      return { content: truncate(out, loadConfig().agent.maxOutputChars), isError: false };
    }
    const out = await impl(args || {}, ctx);
    return { content: truncate(out, loadConfig().agent.maxOutputChars), isError: false };
  } catch (e) {
    return { content: `Error: ${e.message}`, isError: true };
  }
}

/** Capability API injected into forged tools — everything confined the same way
 *  the built-in tools are (project root, vault). Write caps are stripped inside
 *  toolforge for tools that declared access:"read". */
function customCaps({ root } = {}) {
  return {
    webSearch, fetchReadable,
    readFile: root ? (rel) => {
      const buf = fs.readFileSync(safePath(root, rel));
      if (isBinary(buf)) throw new Error('binary file');
      return buf.toString('utf8').slice(0, 400_000);
    } : null,
    listDir: root ? (rel = '') => fs.readdirSync(safePath(root, rel), { withFileTypes: true })
      .slice(0, 300).map(e => e.isDirectory() ? e.name + '/' : e.name) : null,
    writeFile: root ? (rel, content) => {
      const abs = safePath(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(content ?? ''));
      return `wrote ${rel}`;
    } : null,
    vaultSearch: (q, limit = 10) => vaultSearch(String(q || ''), Math.min(Math.max(limit, 1), 20)).map(h => ({ path: h.path, title: h.title, excerpt: h.excerpt })),
    vaultRead: (p) => vaultReadNote(String(p || '')).content.slice(0, 200_000),
    vaultWrite: (p, content) => {
      if (!/\.md$/i.test(String(p || ''))) throw new Error('vault paths must end in .md');
      vaultWriteNote(String(p), String(content ?? ''));
      return `wrote ${p}`;
    },
  };
}

const impls = {
  async bash({ command, timeout_ms }, { root, signal }) {
    const timeout = Math.min(Math.max(timeout_ms || loadConfig().agent.bashTimeoutMs, 1000), 300000);
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (SECRET_ENV.test(k)) delete env[k];
    return await new Promise((resolve) => {
      const child = spawn('/bin/bash', ['-c', command], { cwd: root, env, detached: true });
      let out = '';
      let killed = false;
      const kill = () => { killed = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { } } };
      const timer = setTimeout(kill, timeout);
      const onAbort = () => kill();
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', d => { out += d; if (out.length > 400000) kill(); });
      child.stderr.on('data', d => { out += d; if (out.length > 400000) kill(); });
      child.on('error', e => { clearTimeout(timer); resolve(`spawn error: ${e.message}`); });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        let res = out || '(no output)';
        if (killed) res += `\n[killed: timeout ${timeout}ms or output limit or cancelled]`;
        else if (code !== 0) res += `\n[exit code ${code}]`;
        resolve(res);
      });
    });
  },

  async read_file({ path: p, offset = 1, limit = 2000 }, { root }) {
    const abs = safePath(root, p);
    const buf = fs.readFileSync(abs);
    if (isBinary(buf)) return `[binary file, ${buf.length} bytes]`;
    const lines = buf.toString('utf8').split('\n');
    const start = Math.max(1, offset) - 1;
    const slice = lines.slice(start, start + Math.min(limit, 4000));
    if (!buf.length) return '(empty file)';
    if (!slice.length) return `(no lines at offset ${offset} — the file has ${lines.length} lines)`;
    const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(5)}→${l.length > 500 ? l.slice(0, 500) + '…' : l}`).join('\n');
    const shownTo = start + slice.length;
    const tail = lines.length > shownTo
      ? `\n… showing lines ${start + 1}-${shownTo} of ${lines.length}. Continue with offset:${shownTo + 1}.`
      : '';
    return numbered + tail;
  },

  async write_file({ path: p, content }, { root }) {
    const abs = safePath(root, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const existed = fs.existsSync(abs);
    fs.writeFileSync(abs, content ?? '');
    return `${existed ? 'Overwrote' : 'Created'} ${p} (${Buffer.byteLength(content ?? '')} bytes)`;
  },

  async edit_file({ path: p, old_string, new_string, replace_all }, { root }) {
    const abs = safePath(root, p);
    const src = fs.readFileSync(abs, 'utf8');
    if (!old_string) throw new Error('old_string is empty');
    const count = src.split(old_string).length - 1;
    if (count === 0) throw new Error('old_string not found in file');
    if (count > 1 && !replace_all) throw new Error(`old_string matches ${count} times; add context to make it unique or set replace_all`);
    const next = replace_all ? src.split(old_string).join(new_string) : src.replace(old_string, new_string);
    fs.writeFileSync(abs, next);
    return `Edited ${p} (${count} replacement${count > 1 ? 's' : ''})`;
  },

  async list_dir({ path: p = '' }, { root }) {
    const abs = safePath(root, p);
    const CAP = 500;
    const all = fs.readdirSync(abs, { withFileTypes: true })
      .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    if (!all.length) return '(empty directory)';
    const body = all.slice(0, CAP).map(e => {
      if (e.isDirectory()) return `${e.name}/`;
      let size = '';
      try { size = `  (${fs.statSync(path.join(abs, e.name)).size} B)`; } catch { }
      return `${e.name}${size}`;
    }).join('\n');
    // A silent cap reads as "this is the whole directory" — say so when it isn't.
    return all.length > CAP
      ? `${body}\n… TRUNCATED — showing ${CAP} of ${all.length} entries. Use \`glob\` with a pattern to target what you need.`
      : body;
  },

  async glob({ pattern, path: p = '' }, { root }) {
    const base = safePath(root, p);
    const rx = globToRegex(pattern);
    const hits = [];
    walk(base, (abs, rel, e) => {
      if (!e.isDirectory() && rx.test(rel)) {
        let mtime = 0; try { mtime = fs.statSync(abs).mtimeMs; } catch { }
        hits.push({ rel: p ? path.posix.join(p, rel) : rel, mtime });
      }
    });
    hits.sort((a, b) => b.mtime - a.mtime);
    const shown = hits.slice(0, 300).map(h => h.rel);
    return shown.join('\n') + (hits.length > 300 ? `\n… (${hits.length} matches total)` : '') || '(no matches)';
  },

  async grep({ pattern, path: p = '', include, ignore_case, max_results = 200 }, { root, signal }) {
    const base = safePath(root, p);
    const cap = Math.min(Math.max(Math.floor(max_results) || 200, 1), 2000);
    const args = ['-rnE', '--binary-files=without-match', '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist', '--exclude-dir=.venv'];
    if (ignore_case) args.push('-i');
    if (include) args.push(`--include=${include}`);
    args.push('-e', pattern, '.');
    return await new Promise((resolve) => {
      const child = spawn('grep', args, { cwd: base });
      let out = '', errOut = '', capped = false, timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15000);
      signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
      child.stdout.on('data', d => {
        out += d;
        // Stop reading once we have more than we will show — but remember that we
        // did, so the caller is told the result set is incomplete.
        if (!capped && out.split('\n').length > cap + 1) { capped = true; child.kill('SIGKILL'); }
      });
      child.stderr.on('data', d => { if (errOut.length < 2000) errOut += d; });
      child.on('error', e => { clearTimeout(timer); resolve(`grep could not run: ${e.message}`); });
      child.on('close', () => {
        clearTimeout(timer);
        const lines = out.split('\n').filter(Boolean);
        // grep exits non-zero and writes to stderr for a bad regex or an unreadable
        // path. Answering "(no matches)" there is actively misleading: the model
        // concludes the codebase does not contain the string and moves on.
        if (!lines.length && errOut.trim()) {
          const first = errOut.trim().split('\n')[0].replace(/^grep:\s*/, '');
          return resolve(`grep rejected this search: ${first}\n`
            + 'Note: the pattern is POSIX extended regex (grep -E), so \\d is not supported — use [0-9]. '
            + 'Escape literal braces, brackets and parentheses.');
        }
        if (!lines.length && timedOut) {
          return resolve('grep timed out after 15s before finding anything. Narrow the search with `path` or `include`.');
        }
        if (!lines.length) return resolve(`(no matches for ${JSON.stringify(pattern)})`);
        const shown = lines.slice(0, cap).map(l => l.replace(/^\.\//, p ? p + '/' : ''));
        const incomplete = capped || lines.length > cap;
        return resolve(shown.join('\n') + (incomplete
          ? `\n… TRUNCATED at ${cap} matches — more exist. Narrow with \`include\`/\`path\`, or raise \`max_results\`.`
          : ''));
      });
    });
  },

  async move_path({ from, to, overwrite }, { root }) {
    const a = safePath(root, from), b = safePath(root, to);
    if (a === path.resolve(root)) throw new Error('refusing to move the project root');
    if (!fs.existsSync(a)) throw new Error(`source does not exist: ${from}`);
    // fs.renameSync clobbers the destination without a word. That silently destroyed
    // whatever was at `to`, so make overwriting explicit.
    if (fs.existsSync(b) && !overwrite) {
      const what = fs.statSync(b).isDirectory() ? 'directory' : 'file';
      throw new Error(`${to} already exists (a ${what}). Pick another name, or pass overwrite:true to replace it.`);
    }
    fs.mkdirSync(path.dirname(b), { recursive: true });
    const replaced = fs.existsSync(b);
    fs.renameSync(a, b);
    return `Moved ${from} → ${to}${replaced ? ' (replaced the existing file)' : ''}`;
  },

  async delete_path({ path: p, recursive }, { root }) {
    const abs = safePath(root, p);
    if (abs === path.resolve(root)) throw new Error('refusing to delete the project root');
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      if (!recursive) throw new Error('path is a directory; set recursive:true');
      fs.rmSync(abs, { recursive: true, force: true });
    } else fs.unlinkSync(abs);
    return `Deleted ${p}`;
  },

  async skill({ name }) {
    const text = getSkill(name);
    if (!text) throw new Error(`unknown playbook "${name}" — available: ${listSkills().join(', ')}`);
    return text;
  },

  async git_status(_, { root }) {
    const info = git.gitInfo(root);
    if (!info.git) return 'git is not installed on this machine.';
    if (!info.repo) return 'Not a git repository. Use git_init if version control would help this work.';
    const head = `On branch ${info.branch}${info.detached ? ' (detached HEAD)' : ''}`
      + (info.lastCommit ? ` — last commit: ${info.lastCommit}` : ' — no commits yet')
      + (info.ahead || info.behind ? ` [${info.ahead} ahead / ${info.behind} behind upstream]` : '');
    if (!info.dirty) return `${head}\nWorking tree clean.`;
    return `${head}\n${info.dirty} changed file(s):\n`
      + info.files.map(f => `  ${f.s.padEnd(2)} ${f.path}`).join('\n')
      + (info.dirty > info.files.length ? `\n  … (${info.dirty - info.files.length} more)` : '');
  },

  async git_diff({ path: p, base, staged }, { root, signal }) {
    const args = ['diff'];
    if (staged) args.push('--cached');
    if (base) args.push(String(base));
    else if (!staged && git.gitInfo(root).hasCommits) args.push('HEAD');
    args.push('--');
    if (p) args.push(String(p));
    const r = await git.runGit(root, args, { signal });
    if (r.code !== 0) throw new Error(r.out.trim() || 'git diff failed');
    return r.out.trim() || '(no changes)';
  },

  async git_log({ limit = 15, path: p }, { root, signal }) {
    const n = Math.min(Math.max(Math.floor(limit) || 15, 1), 50);
    const args = ['log', `-${n}`, '--date=short', '--format=%h %ad %an — %s'];
    if (p) args.push('--', String(p));
    const r = await git.runGit(root, args, { signal });
    if (r.code !== 0) throw new Error(r.out.trim() || 'git log failed — no commits yet?');
    return r.out.trim() || '(no commits yet)';
  },

  async git_branch({ name, from }, { root, signal }) {
    const clean = git.cleanBranchName(name);
    const args = ['checkout', '-b', clean];
    if (from) args.push(String(from));
    const r = await git.runGit(root, args, { signal });
    if (r.code !== 0) throw new Error(r.out.trim() || 'git branch failed');
    return `Created and switched to branch "${clean}". Uncommitted changes came along.`;
  },

  async git_switch({ name }, { root, signal }) {
    const r = await git.runGit(root, ['checkout', String(name || '').trim()], { signal });
    if (r.code !== 0) throw new Error(r.out.trim() || 'git switch failed');
    return `Switched to branch "${name}".`;
  },

  async git_commit({ message }, { root }) {
    const r = await git.gitCommit(root, { message });
    const branch = git.gitInfo(root).branch;
    return `Committed ${r.hash} on ${branch}: ${r.message.split('\n')[0]}\n${r.stat}`;
  },

  async git_init(_, { root }) {
    const r = await git.gitInit(root);
    return r.note === 'already a repository'
      ? 'Already a git repository.'
      : 'Initialized empty git repository on branch "main". Add a .gitignore before the first commit if the project needs one.';
  },

  async git_push(_, { root }) {
    const { gitPush } = await import('./github.js');
    const r = await gitPush(root);
    return `Pushed ${r.branch} to origin.${r.behind ? ` Note: still ${r.behind} commit(s) behind the remote — consider git_pull.` : ''}`;
  },

  async git_pull(_, { root }) {
    const { gitPull } = await import('./github.js');
    const r = await gitPull(root);
    return `Pulled origin into ${r.branch}.${r.out ? `\n${r.out}` : ''}${r.ahead ? `\nYou now have ${r.ahead} local commit(s) to push.` : ''}`;
  },

  async vault_search({ query, limit = 10 }) {
    requireVault();
    const hits = vaultSearch(String(query || ''), Math.min(Math.max(limit || 10, 1), 30));
    if (!hits.length) return `No notes match "${query}". The knowledge base may not cover this yet — consider adding a note with vault_write.`;
    return hits.map(h => `${h.path}${h.title && h.title !== h.path ? `  (${h.title})` : ''}\n   ${h.excerpt || ''}`).join('\n');
  },

  async vault_list({ folder = '' }) {
    requireVault();
    const pre = String(folder || '').replace(/^\/+|\/+$/g, '');
    const notes = vaultIndex().filter(n => !pre || n.path.toLowerCase().startsWith(pre.toLowerCase()));
    if (!notes.length) return pre ? `No notes under "${pre}".` : 'The knowledge base is empty.';
    return notes.slice(0, 300).map(n => n.path).join('\n') + (notes.length > 300 ? `\n… (${notes.length} notes total)` : '');
  },

  async vault_read({ path: p }) {
    requireVault();
    const n = vaultReadNote(String(p || ''));
    const bl = n.backlinks?.length ? `\n\n[backlinks: ${n.backlinks.map(b => b.title).join(', ')}]` : '';
    return n.content + bl;
  },

  async vault_write({ path: p, content }) {
    requireVault();
    if (!/\.md$/i.test(String(p || ''))) throw new Error('vault note path must end in .md');
    const existed = vaultNoteExists(p);
    vaultWriteNote(String(p), content ?? '');
    return `${existed ? 'Updated' : 'Created'} note ${p} (${Buffer.byteLength(content ?? '')} bytes)`;
  },

  async vault_append({ path: p, content }) {
    requireVault();
    if (!/\.md$/i.test(String(p || ''))) throw new Error('vault note path must end in .md');
    let prev = '';
    try { prev = vaultReadNote(String(p)).content; } catch { }
    const next = prev ? prev.replace(/\s*$/, '') + '\n\n' + (content ?? '') : (content ?? '');
    vaultWriteNote(String(p), next);
    return `${prev ? 'Appended to' : 'Created'} note ${p}`;
  },

  async wiki_recall({ query, max_chars }) {
    requireVault();
    const { text, notes } = wiki.recall(query, { chars: Math.min(Math.max(max_chars || 6000, 1000), 20000) });
    if (!notes.length) return `Nothing in the knowledge base matches "${query}". If you learn something useful about this, save it with wiki_learn.`;
    return `Recalled ${notes.length} note(s):\n\n${text}`;
  },

  async wiki_learn({ title, content, folder, tags, kind }) {
    requireVault();
    const r = wiki.upsertNote({ title, folder, content, tags, kind, source: 'agent' });
    let idx = '';
    try { wiki.rebuildIndex(); idx = ', Home index refreshed'; } catch { }
    return `${r.created ? 'Created' : 'Updated'} ${r.path}${r.linked.length ? ` (autolinked: ${r.linked.join(', ')})` : ''}${idx}.`;
  },

  async note_template({ kind }) {
    const t = wiki.noteTemplate(kind);
    if (t.kinds) {
      return 'Note kinds (pass one as `kind`):\n'
        + t.kinds.map(k => `- ${k.kind} — ${k.what}`).join('\n')
        + '\nRead the `notes` skill for the full system (quality bar, filing, maintenance).';
    }
    return `Template for a "${t.kind}" note (${t.what}) — fill every section, keep the section names:\n\n${t.template}`;
  },

  async wiki_index() {
    requireVault();
    const r = wiki.rebuildIndex();
    return `Rebuilt ${r.path}: ${r.notes} notes indexed${r.orphans ? `, ${r.orphans} orphan(s) flagged for linking` : ''}.`;
  },

  async wiki_generate({ topic, count, source_note }, { modelRef, signal }) {
    requireVault();
    if (!modelRef) throw new Error('no model available in this session');
    const { created, folder } = await generateWiki({
      topic, sourcePath: source_note || undefined,
      count: Math.min(Math.max(Math.floor(count) || 5, 1), 12),
      modelRef, signal,
    });
    try { wiki.rebuildIndex(); } catch { }
    return `Created ${created.length} interlinked notes in ${folder}/:\n${created.map(c => `- ${c.path}`).join('\n')}\nHome index refreshed.`;
  },

  async daily_log({ text }) {
    requireVault();
    if (!String(text || '').trim()) throw new Error('text is empty');
    const { path: rel } = dailyCapture(String(text));
    return `Logged to ${rel}.`;
  },

  async quick_note({ title, content, folder }) {
    requireVault();
    const t = String(title || '').trim();
    if (!t) throw new Error('title is empty');
    const safeTitle = t.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
    const fold = String(folder || 'Notes').replace(/^\/+|\/+$/g, '') || 'Notes';
    const rel = `${fold}/${safeTitle}.md`;
    if (vaultNoteExists(rel)) {
      // additive: never clobber an existing note — append a timestamped section
      let prev = ''; try { prev = vaultReadNote(rel).content; } catch { }
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      vaultWriteNote(rel, prev.replace(/\s*$/, '') + `\n\n---\n*added ${stamp}*\n\n` + (content || ''));
      return `Appended to existing note ${rel} (nothing overwritten).`;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    vaultWriteNote(rel, `---\ntitle: ${t}\ncreated: ${stamp}\ntags: [note]\n---\n\n# ${t}\n\n${content || ''}`);
    return `Saved note ${rel}.`;
  },

  async research_start({ question, depth }, { modelRef }) {
    if (!modelRef) throw new Error('no model available in this session');
    const { startResearch } = await import('./research.js');
    const r = startResearch({ question: String(question || ''), modelRef, depth: depth || 'standard' });
    return `Deep research ${r.id} started ("${r.question}", depth ${r.depth}). It runs in the background for minutes — continue other work and poll research_status {id:"${r.id}"}. The finished report appears in the Research app and auto-exports to the wiki.`;
  },

  async research_status({ id }) {
    const { getResearch } = await import('./research.js');
    const r = getResearch(String(id || ''));
    const head = `Research ${r.id}: ${r.status}${r.status === 'running' ? ` (phase: ${r.phase})` : ''} — ${r.queries.length} queries, ${r.sources.length} sources, ${r.notes.length} notes.`;
    if (r.status === 'error') return `${head}\nError: ${r.error}`;
    if (r.report) return `${head}\n\nREPORT:\n${truncate(r.report, 6000)}`;
    return `${head}\nNo report yet — poll again after doing other work.`;
  },

  async agenda_view({ date }) {
    const a = planner.agenda(date || planner.todayStr());
    const ev = a.events.map(e => `- ${e.allDay ? 'all-day' : e.start + (e.end ? `–${e.end}` : '')} ${e.title}${e.recur ? ` (${e.recur})` : ''}`);
    const due = a.tasks.map(t => `- [ ] ${t.title}${t.priority ? ` (P${t.priority})` : ''}`);
    const over = a.overdue.map(t => `- [!] ${t.title} (due ${t.due})`);
    return `Agenda for ${a.date}:\nEvents:\n${ev.join('\n') || '- none'}\nTasks due:\n${due.join('\n') || '- none'}${over.length ? `\nOverdue:\n${over.join('\n')}` : ''}`;
  },

  async finance_summary({ month, range }) {
    const s = finance.summary({ month, range });
    const cats = finance.byCategory({ month, range, kind: 'expense' }).items.slice(0, 6);
    const m = (n) => `${s.currency} ${Number(n).toLocaleString('en-US')}`;
    const lines = [
      `Finances ${s.range.start} → ${s.range.end} (${s.count} transactions)`,
      `  earned ${m(s.earned)} · spent ${m(s.spent)} · net ${m(s.net)}`,
      s.savingsRate === null ? '  savings rate: n/a (no income this period)' : `  savings rate ${s.savingsRate}% · avg spend ${m(s.avgSpendPerDay)}/day`,
      cats.length ? 'Top expense categories:' : 'No expenses recorded in this period.',
      ...cats.map(c => `  ${c.category}: ${m(c.total)} (${c.pct}%, ${c.count}x)`),
    ];
    return lines.join('\n');
  },

  async finance_search({ search, kind, category, month, range, limit }) {
    const n = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const r = finance.listTxns({ search, kind, category, month, range: range || (month ? undefined : 'all'), limit: n });
    if (!r.items.length) return `No transactions match (${r.range.start} → ${r.range.end}).`;
    const rows = r.items.map(t => {
      const sign = t.kind === 'income' ? '+' : '-';
      const who = t.merchant || t.category;
      const extra = t.currency !== undefined && t.amount !== t.amountBase ? ` [${t.amount} ${t.currency}]` : '';
      return `  ${t.date}  ${sign}${Number(t.amountBase).toLocaleString('en-US')}  ${who} · ${t.category}${t.note ? ` — ${t.note}` : ''}${extra}`;
    });
    const more = r.total > r.items.length ? `\n  … ${r.total - r.items.length} more (raise limit or narrow the filters)` : '';
    return `${r.total} transaction(s), ${r.range.start} → ${r.range.end}, amounts in the base currency:\n${rows.join('\n')}${more}`;
  },

  async finance_insights({ month }) {
    const i = finance.insights(month ? { month } : {});
    const m = (n) => `${i.currency} ${Number(n).toLocaleString('en-US')}`;
    const signed = (n) => (n > 0 ? `+${m(n)}` : m(n));
    const out = [
      `Finances ${i.range.start} → ${i.range.end}`,
      `  earned ${m(i.totals.earned)} · spent ${m(i.totals.spent)} · net ${m(i.totals.net)}` +
      (i.totals.savingsRate === null ? '' : ` · saved ${i.totals.savingsRate}%`),
      `  vs ${i.previousMonth.month}: spending ${signed(i.changeVsPrev.spent)}, income ${signed(i.changeVsPrev.earned)}`,
    ];
    if (i.biggestMovers.length) {
      out.push('Biggest category changes:');
      out.push(...i.biggestMovers.map(x => `  ${x.category}: ${m(x.now)} (was ${m(x.was)}, ${signed(x.delta)})`));
    }
    if (i.unusuallyLarge.length) {
      out.push('Unusually large for their category:');
      out.push(...i.unusuallyLarge.map(x => `  ${x.date} ${x.merchant} ${m(x.amount)} (${x.category})`));
    }
    if (i.budgetPressure.length) {
      out.push('Budgets at or near the limit:');
      out.push(...i.budgetPressure.map(b => `  ${b.category}: ${m(b.spent)} of ${m(b.budget)} (${b.pct}%)${b.over ? ' — OVER' : ''}`));
    }
    if (i.goal && (i.goal.minGoal || i.goal.majorGoal)) {
      out.push(`Side-income goal: ${m(i.goal.progress)} so far` +
        (i.goal.minPct !== null ? ` · minimum ${i.goal.minPct}%` : '') +
        (i.goal.majorPct !== null ? ` · stretch ${i.goal.majorPct}%` : ''));
    }
    if (out.length === 3) out.push('Nothing unusual stands out this period.');
    return out.join('\n');
  },

  async finance_log({ amount, kind, category, merchant, note, date, currency }) {
    const t = finance.addTxn({ amount, kind: kind || 'expense', category, merchant, note, date, currency, source: 'ai' });
    const conv = t.currency !== finance.settings().baseCurrency
      ? ` (= ${Number(t.amountBase).toLocaleString('en-US')} ${finance.settings().baseCurrency} at ${t.fxRate})` : '';
    return `Logged ${t.kind}: ${Number(t.amount).toLocaleString('en-US')} ${t.currency}${conv} · ${t.category}` +
      `${t.merchant ? ` · ${t.merchant}` : ''} on ${t.date}. Visible in the Finances app (id ${t.id}).`;
  },

  async task_list({ status = 'open', limit = 25 }) {
    const n = Math.min(Math.max(Math.floor(limit) || 25, 1), 100);
    const all = planner.listTasks();
    const want = ['open', 'done', 'all'].includes(status) ? status : 'open';
    const rows = all.filter(t => want === 'all' || (want === 'done' ? t.done : !t.done));
    if (!rows.length) return want === 'open' ? 'No open tasks.' : `No ${want} tasks.`;
    const shown = rows.slice(0, n).map(t =>
      `  [${t.done ? 'x' : ' '}] ${t.id}  ${t.title}`
      + (t.due ? ` (due ${t.due})` : '') + (t.priority ? ` P${t.priority}` : '')
      + (t.category ? ` #${t.category}` : ''));
    const more = rows.length > n ? `\n  … ${rows.length - n} more (raise limit)` : '';
    return `${rows.length} ${want} task(s):\n${shown.join('\n')}${more}`;
  },

  async task_done({ id, done = true }) {
    const t = planner.updateTask(String(id || ''), { done: !!done });
    return `${t.done ? 'Completed' : 'Re-opened'}: "${t.title}"${t.done && t.doneAt ? ` (${t.doneAt.slice(0, 10)})` : ''}`;
  },

  async notify({ message }) {
    const text = String(message || '').trim();
    if (!text) throw new Error('message is empty');
    const st = notify.notifyStatus();
    if (!st.discord) throw new Error('no notification channel configured — add a Discord webhook in Settings → Notifications');
    await notify.sendDiscord(text.slice(0, 1800));
    return `Notification sent: "${text.slice(0, 120)}${text.length > 120 ? '…' : ''}"`;
  },

  async system_status() {
    const [gpu, llm, svcs] = await Promise.all([
      Promise.resolve(gpuStats()),
      Promise.resolve(llmctlStatus()),
      probeServices().catch(e => [{ name: 'services', status: 'down', detail: e.message }]),
    ]);
    const lines = [];
    lines.push(gpu
      ? `GPU: ${gpu.name} — ${gpu.freeMB} MB free of ${gpu.totalMB} MB (${gpu.usedMB} MB in use)`
      : 'GPU: no NVIDIA GPU detected (or nvidia-smi unavailable)');
    if (llm.running) lines.push(`llama.cpp: serving "${llm.profile || 'unknown'}" on port ${llm.port} (pid ${llm.pid})`);
    else if (llm.foreign) lines.push(`llama.cpp: a server AIOS does not manage is running on port ${llm.port}`);
    else lines.push(`llama.cpp: not running (managed: ${llm.managed ? 'yes' : 'no'})`);
    const byStatus = { up: [], down: [], off: [], warn: [], unknown: [] };
    for (const s of svcs) (byStatus[s.status] ||= []).push(`${s.name}${s.detail ? ` (${s.detail})` : ''}`);
    lines.push('Services:');
    for (const [k, list] of Object.entries(byStatus)) {
      if (list.length) lines.push(`  ${k}: ${list.join(', ')}`);
    }
    return lines.join('\n');
  },

  async bench_best({ category }) {
    const { models, best, tests } = bench.leaderboard();
    if (!models.length) return 'No benchmark results yet — the user has not run the Bench app. Nothing measured to recommend from.';
    if (category) {
      const cat = String(category).toLowerCase();
      const known = [...new Set(tests.map(t => t.category))];
      if (!known.includes(cat)) return `Unknown category "${category}". Measured categories: ${known.join(', ')}.`;
      const ranked = models.filter(m => m.categories[cat] !== undefined)
        .sort((a, b) => b.categories[cat] - a.categories[cat]);
      return `Local models ranked for "${cat}" (score 0-1, higher is better):\n`
        + ranked.map((m, i) => `  ${i + 1}. ${m.model} — ${m.categories[cat]}${m.tokS ? `, ${m.tokS} tok/s` : ''}`).join('\n');
    }
    const lines = [`Measured leaderboard (${models.length} local model(s)):`];
    for (const m of models.slice(0, 8)) {
      lines.push(`  ${m.model} — overall ${m.overall}, ${m.tokS || '?'} tok/s, ${m.covered} test(s) covered`);
    }
    if (Object.keys(best).length) {
      lines.push('Best per category:');
      for (const [cat, b] of Object.entries(best)) lines.push(`  ${cat}: ${b.model} (${b.score})`);
    }
    return lines.join('\n');
  },

  async sql_query({ db: which, sql, limit = 50 }) {
    const DBS = { finance: 'finance.db', learn: 'learn.db', bench: 'bench.db' };
    const file = DBS[String(which || '')];
    if (!file) throw new Error(`unknown database "${which}" — choose one of: ${Object.keys(DBS).join(', ')}`);
    const abs = path.join(DATA, file);
    if (!fs.existsSync(abs)) return `The ${which} database does not exist yet — that app has not stored anything.`;

    const { DatabaseSync } = await import('node:sqlite');
    // readOnly is the real guard; the string checks below just fail fast with a
    // message the model can act on instead of an opaque SQLITE_READONLY.
    const conn = new DatabaseSync(abs, { readOnly: true });
    try {
      if (!sql || !String(sql).trim()) {
        const tables = conn.prepare(
          `SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
        if (!tables.length) return `The ${which} database has no tables yet.`;
        return `Schema of the ${which} database:\n\n` + tables.map(t => t.sql).join(';\n\n')
          + '\n\nRe-call with `sql` to query it.';
      }
      const q = String(sql).trim().replace(/;\s*$/, '');
      if (/;/.test(q)) throw new Error('only one statement per call — remove the semicolon and any trailing statement');
      if (!/^\s*(select|with)\b/i.test(q)) throw new Error('only SELECT (or WITH … SELECT) is allowed here; use the finance_/learn_ write tools to change data');
      if (/\b(attach|pragma)\b/i.test(q)) throw new Error('ATTACH and PRAGMA are not allowed');

      const n = Math.min(Math.max(Math.floor(limit) || 50, 1), 500);
      let rows;
      try { rows = conn.prepare(q).all(); }
      catch (e) {
        // Hand back the schema hint with the error so the next attempt can succeed.
        const names = conn.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
          .all().map(t => t.name).join(', ');
        throw new Error(`${e.message}\nTables in ${which}: ${names}. Call sql_query with no \`sql\` to see full column definitions.`);
      }
      if (!rows.length) return '(0 rows)';
      const cols = Object.keys(rows[0]);
      const shown = rows.slice(0, n);
      const head = cols.join(' | ');
      const body = shown.map(r => cols.map(c => {
        const v = r[c];
        return v === null ? '' : String(v).replace(/\n/g, ' ').slice(0, 80);
      }).join(' | ')).join('\n');
      const more = rows.length > n ? `\n… TRUNCATED — ${rows.length} rows matched, showing ${n}. Add LIMIT or raise \`limit\`.` : '';
      return `${head}\n${'-'.repeat(Math.min(head.length, 80))}\n${body}\n(${rows.length} row(s))${more}`;
    } finally {
      try { conn.close(); } catch { }
    }
  },

  async github_work({ kind = 'both' }) {
    const { prs: ghPrs, issues: ghIssues } = await import('./github.js');
    const want = ['prs', 'issues', 'both'].includes(kind) ? kind : 'both';
    const out = [];
    if (want !== 'issues') {
      const p = await ghPrs();
      const fmt = (list) => list.map(x => `  #${x.number} ${x.repo} — ${x.title}${x.draft ? ' (draft)' : ''} · updated ${String(x.updatedAt).slice(0, 10)}`);
      out.push('Open pull requests:');
      if (p.authored.length) out.push(' Yours:', ...fmt(p.authored));
      if (p.reviewRequested.length) out.push(' Waiting on your review:', ...fmt(p.reviewRequested));
      if (p.involved.length) out.push(' Involving you:', ...fmt(p.involved));
      if (!p.authored.length && !p.reviewRequested.length && !p.involved.length) out.push('  (none)');
    }
    if (want !== 'prs') {
      const i = await ghIssues();
      out.push('Open issues involving you:');
      out.push(...(i.issues.length
        ? i.issues.map(x => `  #${x.number} ${x.repo} — ${x.title} · ${x.comments} comment(s)`)
        : ['  (none)']));
    }
    return out.join('\n');
  },

  async task_add({ title, due, priority, notes }) {
    const t = planner.addTask({ title, due, priority, notes });
    return `Task added: "${t.title}"${t.due ? ` (due ${t.due})` : ''}${t.priority ? ` P${t.priority}` : ''} — visible in the Planner app and on Home.`;
  },

  async event_add({ title, date, start, end, recur, notes }) {
    const e = planner.addEvent({ title, date, start, end, recur, notes });
    return `Event added: "${e.title}" on ${e.date}${e.allDay ? ' (all-day)' : ` at ${e.start}${e.end ? `–${e.end}` : ''}`}${e.recur ? `, repeats ${e.recur}` : ''}.`;
  },

  async comfy_generate({ prompt, negative, width, height, count, seed }, { signal }) {
    const comfy = await import('./comfy.js');
    const job = await comfy.generate({ prompt, negative, width, height, count, seed });
    // block (bounded) until the job settles so the model gets a real answer
    for (let i = 0; i < 600; i++) {
      if (signal?.aborted) throw new Error('cancelled');
      const j = comfy.getJob(job.id);
      if (j.status === 'done') return `Rendered ${j.images.length} image(s) — visible in the Studio app (job ${j.id}, seed ${j.seed}, ${j.width}×${j.height}). Files: ${j.images.join(', ')}`;
      if (j.status === 'error') throw new Error(j.error || 'generation failed');
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('generation still running after 10 minutes — check the Studio app');
  },

  async comfy_status() {
    const comfy = await import('./comfy.js');
    const s = await comfy.comfyStatus();
    const jobs = comfy.listJobs().slice(0, 3);
    const lines = [
      s.up ? `ComfyUI up at ${s.url} — ${s.vramFreeMB}MB VRAM free of ${s.vramTotalMB}MB` : `ComfyUI NOT running at ${s.url} (${s.error || ''}) — the user must start it`,
      s.llm?.running ? `llama.cpp profile: ${s.llm.profile}${s.llm.profile === 'big' ? ' (GPU held — generation will auto-swap to tiny)' : ''}` : s.llm?.foreign ? 'llama.cpp running unmanaged (will be replaced on first swap)' : 'llama.cpp stopped',
      s.gpu ? `GPU: ${s.gpu.name} — ${s.gpu.freeMB}MB free / ${s.gpu.totalMB}MB` : 'no NVIDIA GPU visible',
      jobs.length ? `Recent: ${jobs.map(j => `${j.id}:${j.status}`).join(', ')}` : 'no renders yet',
    ];
    return lines.join('\n');
  },

  async mail_recent({ limit = 15, days = 3 }) {
    const cfg = loadConfig();
    const msgs = await mailRecent({ ...cfg.mail, lookbackDays: Math.max(1, Math.min(days || 3, 14)), maxMessages: Math.max(1, Math.min(limit || 15, 30)) });
    if (!msgs.length) return `No messages in the last ${days} day(s).`;
    return msgs.map(m => `[${m.uid}] ${m.seen ? '' : '(unread) '}${m.from} — ${m.subject}\n   ${m.date}${m.snippet ? `\n   ${m.snippet.slice(0, 160)}` : ''}`).join('\n');
  },

  async mail_search({ query, days = 30, limit = 15 }) {
    const msgs = await searchMail({ query, days, limit });
    if (!msgs.length) return `No messages match "${query}" in the last ${days} day(s).`;
    return msgs.map(m => `[${m.uid}] ${m.seen ? '' : '(unread) '}${m.from} — ${m.subject}\n   ${m.date}${m.snippet ? `\n   ${m.snippet.slice(0, 160)}` : ''}`).join('\n');
  },

  async mail_read({ uid }) {
    const m = await mailRead(uid);
    return `From: ${m.from}\nTo: ${m.to}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.body || '(no readable text body — likely HTML-only or an attachment)'}`;
  },

  async create_tool({ name, description, parameters, access, code }) {
    const r = forge.saveCustomTool({ name, description, parameters, access, code }, { builtinNames: BUILTIN_NAMES });
    return `Tool "${r.name}" ${r.updated ? 'updated' : 'forged'} (access: ${access}). It is callable from your next turn — call it directly like any other tool. If it errors, fix it with another create_tool call (same name overwrites).`;
  },

  async list_custom_tools({ show_code }) {
    const list = forge.listCustomTools();
    if (!list.length) return 'No custom tools yet. Forge one with create_tool when a reusable capability is missing.';
    return list.map(t =>
      `${t.name} [${t.access}] — ${t.description}\n  runs: ${t.runs || 0}${t.lastError ? `, last error: ${t.lastError}` : ''}${show_code ? `\n  code:\n${t.code.split('\n').map(l => '  | ' + l).join('\n')}` : ''}`
    ).join('\n\n');
  },

  async delete_tool({ name }) {
    forge.deleteCustomTool(String(name || ''));
    return `Deleted custom tool "${name}".`;
  },

  async web_search({ query, max_results = 8, category, time_range }) {
    const { source, results, answers, note } = await webSearch(query, { n: max_results, category, time_range });
    if (!results.length && !answers.length) return `No results for "${query}". Try different keywords.`;
    const lines = [
      ...answers.map(a => `Answer: ${a}`),
      ...results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`),
    ];
    return `Web results for "${query}" (${source}):${note ? `\n(${note})` : ''}\n\n${lines.join('\n')}`;
  },

  async fetch_url({ url, max_chars, offset }) {
    const { status, text } = await fetchReadable(url);
    // Without windowing, a long page gets middle-truncated by runTool and the rest
    // is simply unreachable. Page through it instead.
    const cap = Math.min(Math.max(Math.floor(max_chars) || 20000, 500), 100000);
    const from = Math.max(Math.floor(offset) || 0, 0);
    const body = text.slice(from, from + cap);
    const head = `[${status}] ${url}`;
    if (from >= text.length && text.length) {
      return `${head}\n\n(offset ${from} is past the end — the page is ${text.length} chars)`;
    }
    const next = from + body.length;
    const more = next < text.length
      ? `\n\n… showing chars ${from}-${next} of ${text.length}. Continue with offset:${next}.`
      : '';
    return `${head}\n\n${body}${more}`;
  },

  async crawl_site({ url, query, max_pages, depth }, { signal }) {
    return await crawlSite(url, {
      query: query || '',
      maxPages: Math.min(Math.max(Math.floor(max_pages) || 6, 1), 20),
      depth: Math.min(Math.max(Number.isFinite(depth) ? Math.floor(depth) : 2, 0), 3),
      signal,
    });
  },

  async wikipedia({ query, lang }, { signal }) {
    const r = await everyday.wikipedia(query, { lang: lang || 'en', signal });
    return `${r.title}${r.description ? ` — ${r.description}` : ''}\n\n${r.extract}\n\n${r.url}`;
  },

  async directions({ to, from, mode }, { signal }) {
    const units = geo.mapsUnits();
    const dest = await geo.resolvePlace(to, { signal });
    const orig = await geo.resolvePlace(from || 'home', { signal });
    const r = await geo.route(orig, dest, { mode: mode || 'driving', signal });
    const modeLabel = r.mode.charAt(0).toUpperCase() + r.mode.slice(1);
    const lines = [
      `${geo.placeLabel(orig)} → ${geo.placeLabel(dest)}`,
      `${modeLabel}${r.estimated ? ' (estimated)' : ''}: ${geo.fmtDuration(r.duration_s)}, ${geo.fmtDistance(r.distance_m, units)} · via ${r.provider}`,
      `Straight-line: ${geo.fmtDistance(geo.haversineKm(orig, dest) * 1000, units)}`,
    ];
    if (r.steps?.length) lines.push('Transit: ' + r.steps.join(' · '));
    if (r.estimated) lines.push('(walking/cycling time estimated from road distance — add a Google Directions key in Settings → Tools → Maps for exact figures and transit.)');
    return lines.join('\n');
  },

  async find_places({ query, near, limit }, { signal }) {
    const units = geo.mapsUnits();
    let origin = null;
    try { origin = await geo.resolvePlace(near || 'home', { signal }); }
    catch (e) { if (near) throw e; }   // no home set is fine; a bad explicit `near` is not
    const { places } = await geo.findPlaces(query, { near: origin, limit: Math.min(Math.max(limit || 6, 1), 15), signal });
    if (!places.length) return `No places found for "${query}"${origin ? ` near ${geo.placeLabel(origin)}` : ''}. Try a broader term or a nearby city.`;
    const head = origin ? `Places matching "${query}" near ${geo.placeLabel(origin)}:` : `Places matching "${query}":`;
    return head + '\n' + places.map((p, i) => {
      const dist = p.distanceKm != null ? ` — ${geo.fmtDistance(p.distanceKm * 1000, units)} away` : '';
      return `${i + 1}. ${p.name}${p.type ? ` (${p.type})` : ''}${dist}\n   ${p.display}`;
    }).join('\n');
  },

  async weather({ place, days }, { signal }) {
    const w = await geo.forecast(place || 'home', { days: days || 3, signal });
    const c = w.current, windUnit = w.unit === '°F' ? ' mph' : ' km/h';
    const head = `Weather for ${w.place}: ${c.emoji} ${c.label}, ${c.temp}${w.unit} (feels ${c.feels}${w.unit}), humidity ${c.humidity}%, wind ${c.wind}${windUnit}.`;
    const fc = w.days.map(d => `  ${d.date}: ${d.emoji} ${d.label}, ${d.lo}–${d.hi}${w.unit}${d.precip != null ? `, ${d.precip}% precip` : ''}`).join('\n');
    return `${head}\nForecast:\n${fc}`;
  },

  async translate({ text, to, from }, { signal }) {
    const r = await everyday.translate(text, { to: to || 'en', from: from || 'auto', signal });
    return `(${r.from} → ${r.to})\n${r.text}`;
  },

  async calculate({ expression }) {
    const v = everyday.calculate(expression);
    const out = Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)));
    return `${expression} = ${out}`;
  },

  async convert({ value, from, to }, { signal }) {
    const r = await everyday.convert(value, from, to, { signal });
    const round = (n) => Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(6)));
    let line = `${value} ${r.from} = ${round(r.value)} ${r.to}`;
    if (r.dim === 'currency') line += ` (rate ${round(r.rate)}${r.asOf ? `, as of ${r.asOf}` : ''})`;
    return line;
  },

  async datetime({ tz, until }) {
    const r = everyday.datetime({ tz, until });
    const lines = [`${r.local}${r.tz ? ` (${r.tz})` : ''}`];
    if (r.until) lines.push(`${r.until.date} is ${r.until.days}d ${r.until.hours}h ${r.until.direction}`);
    return lines.join('\n');
  },

  async model_auto_setup({ file }, { modelRef }) {
    const { autoSetup } = await import('./router.js');
    const r = await autoSetup({ file, modelRef });
    if (!r.configured.length) return r.note || 'nothing to configure';
    return r.configured.map(c => c.ok
      ? `${c.file}: tags [${c.tags.join(', ')}] · ctx ${c.ctx}${c.mmproj ? ` · vision: ${c.mmproj}` : ''} — ${c.why}`
      : `${c.file}: FAILED (${c.error})`).join('\n');
  },

  // ---- Learning Corner ----------------------------------------------------
  // learn.js imports webSearch/fetchReadable from this module, so a static import
  // back would be a cycle — these load it on demand (same trick learn.js uses for
  // vault.js). learnMod() is cheap after the first call: ESM caches the module.

  async learn_subjects() {
    const learn = await learnMod();
    const rows = learn.listSubjects();
    if (!rows.length) return 'No subjects yet. Create one with learn_create_subject.';
    const byId = new Map(rows.map(r => [r.id, r]));
    const label = (r) => {
      const crumbs = [];
      let cur = r;
      while (cur && crumbs.length < 6) { crumbs.unshift(cur.name); cur = cur.parentId ? byId.get(cur.parentId) : null; }
      return crumbs.join(' → ');
    };
    return rows.map(r =>
      `${r.id}  ${label(r)}\n   level=${r.level} · ${r.modulesDone}/${r.modules} modules · ${r.lessons} lessons · ${r.assessments} assessments · mastery=${r.mastery === null ? 'unmeasured' : r.mastery + '%'}`
    ).join('\n');
  },

  async learn_subject({ subject_id }) {
    const learn = await learnMod();
    const s = learn.getSubject(subject_id);
    const mods = (s.roadmap?.modules || []).map((m, i) =>
      `  ${i + 1}. [${m.done ? 'x' : ' '}] ${m.title} (id=${m.id}, ${m.kind})\n     ${m.summary}\n     topics: ${m.topics.join(' · ') || '(none)'}`).join('\n');
    const lessons = s.lessons.map(l => `  L${l.n} ${l.title} (id=${l.id}, ${l.type})${l.done ? ' ✓' : ''}`).join('\n');
    const assess = s.assessments.map(a =>
      `  ${a.kind}: "${a.title}" (id=${a.id}, ${a.questions} questions, ${a.attempts} attempts${a.best ? `, best ${a.best.score}/${a.best.maxScore} ${a.best.passed ? 'PASS' : 'FAIL'}` : ''})`).join('\n');
    const weak = s.weak.map(w => `  ${w.topic}: ${w.correct}/${w.seen} (${Math.round(w.ratio * 100)}%)`).join('\n');
    return [
      `${s.path.map(p => p.name).join(' → ')}  (id=${s.id})`,
      `goal: ${s.goal || '(not stated)'}`,
      `level: ${s.level} · mastery: ${s.mastery.pct === null ? 'unmeasured' : s.mastery.pct + '%'} across ${s.mastery.topics} topics`,
      s.children.length ? `sub-subjects: ${s.children.map(c => `${c.name} (id=${c.id})`).join(', ')}` : 'sub-subjects: (none)',
      '', `ROADMAP (${s.roadmap?.modules?.length || 0} modules):`, mods || '  (no roadmap yet — call learn_generate_roadmap)',
      '', `LESSONS (${s.lessons.length}):`, lessons || '  (none)',
      '', `ASSESSMENTS (${s.assessments.length}):`, assess || '  (none)',
      '', 'MEASURED WEAK TOPICS:', weak || '  (nothing assessed yet)',
      '', `NEXT UP: [${s.nextUp.kind}] ${s.nextUp.why}`,
    ].join('\n');
  },

  async learn_lesson_read({ subject_id, lesson_id }) {
    const learn = await learnMod();
    const l = learn.getLesson(subject_id, lesson_id);
    return `# ${l.title} (lesson ${l.n}, ${l.type})\ntopic: ${l.topic}\n\n${l.content}`;
  },

  async learn_weak_topics({ subject_id, limit = 8 }) {
    const learn = await learnMod();
    const rows = learn.getWeakTopics(subject_id, Math.max(1, Math.min(30, Number(limit) || 8)));
    if (!rows.length) return 'Nothing assessed yet for this subject — no mastery data. Give them a quiz or a diagnostic first.';
    return rows.map(r => `${r.topic}: ${r.correct}/${r.seen} correct (${Math.round(r.ratio * 100)}%)${r.streak >= 3 ? ` · streak ${r.streak}` : ''}`).join('\n');
  },

  async learn_attempt_review({ subject_id, attempt_id }) {
    const learn = await learnMod();
    const t = learn.getAttempt(subject_id, attempt_id);
    const head = `Attempt ${t.id} — ${t.score}/${t.maxScore} (${Math.round(t.score / (t.maxScore || 1) * 100)}%) ${t.passed ? 'PASS' : 'FAIL'} · ${t.submittedAt || 'not submitted'}`;
    const body = t.responses.map(r => {
      const given = r.kind === 'open' ? String(r.given).slice(0, 400) : renderGiven(r);
      return `Q${r.idx + 1} [${r.topic || 'untagged'} · ${r.difficulty}] ${r.correct ? '✓' : '✗'} ${r.points}/${r.worth}\n  ${r.prompt.slice(0, 300)}\n  answered: ${given || '(blank)'}\n  ${r.kind === 'open' ? `grader: ${r.feedback}` : `correct: ${renderAnswer(r)}`}\n  why: ${(r.explanation || '').slice(0, 300)}`;
    }).join('\n\n');
    return `${head}\n\n${body}`;
  },

  async learn_create_subject({ name, goal, level, parent_id }) {
    const learn = await learnMod();
    const s = learn.createSubject({ name, goal, level, parentId: parent_id || null });
    return `Created subject "${s.name}" (id=${s.id}${s.parentId ? `, nested under ${s.parentId}` : ''}). Next: learn_generate_roadmap.`;
  },

  async learn_create_quiz({ subject_id, kind = 'quiz', title, blurb, module_id, lesson_id, scope, pass_pct }) {
    const learn = await learnMod();
    const a = learn.createAssessment({
      subjectId: subject_id, kind, title, blurb,
      moduleId: module_id || null, lessonId: lesson_id || null,
      scope: Array.isArray(scope) ? scope : [], passPct: pass_pct,
    });
    return `Created empty ${a.kind} (id=${a.id}). Add questions with learn_add_question(assessment_id="${a.id}", ...). It stays unanswerable until it has questions.`;
  },

  async learn_add_question({ assessment_id, kind = 'mcq', prompt, choices, answer, explanation, topic, difficulty, points }) {
    const learn = await learnMod();
    const q = learn.addQuestion(assessment_id, { kind, prompt, choices, answer, explanation, topic, difficulty, points });
    return `Added question ${q.idx + 1} (id=${q.id}, ${kind}) to assessment ${assessment_id}.`;
  },

  async learn_generate_assessment({ subject_id, kind = 'quiz', module_id, lesson_id }, { modelRef }) {
    const learn = await learnMod();
    const r = learn.generateAssessment({ id: subject_id, kind, moduleId: module_id, lessonId: lesson_id, modelRef });
    return `Started generating a ${kind} for subject ${subject_id} (streaming to the Learning app). It writes the questions, weights them toward measured weak topics, and saves when done. Status: ${r.status}.`;
  },

  async learn_generate_lesson({ subject_id, module_id, focus, review }, { modelRef }) {
    const learn = await learnMod();
    const r = learn.generateLesson({ id: subject_id, moduleId: module_id, focus, review: !!review, modelRef });
    return `Started generating a${review ? ' REVIEW' : ''} lesson for subject ${subject_id} (status: ${r.status}). It searches current sources, writes the lesson, and exports it to the vault.`;
  },

  async learn_generate_roadmap({ subject_id }, { modelRef }) {
    const learn = await learnMod();
    const r = learn.generateRoadmap({ id: subject_id, modelRef });
    return `Started designing the roadmap for subject ${subject_id} (status: ${r.status}).`;
  },

  async learn_suggest_paths({ subject_id }, { modelRef }) {
    const learn = await learnMod();
    const r = learn.generateAdvice({ id: subject_id, modelRef });
    return `Started researching certificates and career paths for subject ${subject_id} (status: ${r.status}). Results land in the Learning app's Paths tab; each can be adopted as a sub-subject.`;
  },

  async learn_check_lessons({ subject_id }) {
    const learn = await learnMod();
    const r = learn.checkSubjectLessons(subject_id);
    if (!r.checked) return 'This subject has no lessons yet.';
    const lines = r.lessons.map(l => {
      if (l.ok) return `  L${l.n} (id=${l.id}) OK — ${l.title}`;
      const errs = l.health.filter(i => i.level === 'error').map(i => i.text);
      const warns = l.health.filter(i => i.level === 'warn').map(i => i.text);
      return `  L${l.n} (id=${l.id}) ${errs.length ? 'DAMAGED' : 'minor gaps'} — ${l.title}` +
        (errs.length ? `\n     errors: ${errs.join('; ')}` : '') +
        (warns.length ? `\n     warnings: ${warns.join('; ')}` : '');
    });
    return `${r.checked} lesson(s) checked, ${r.broken} damaged.\n${lines.join('\n')}` +
      (r.broken ? `\n\nFix a damaged one with learn_regenerate_lesson (omit instructions to use these findings as the brief; add use_web:false if search is what derailed it).` : '');
  },

  async learn_regenerate_lesson({ subject_id, lesson_id, instructions, focus, use_web }, { modelRef }) {
    const learn = await learnMod();
    const r = learn.regenerateLesson({
      id: subject_id, lessonId: lesson_id, instructions, focus,
      useWeb: use_web !== false, modelRef,
    });
    return `Rewriting lesson ${lesson_id} in place (status: ${r.status}${use_web === false ? ', offline — no web search' : ''}). The previous version is saved to revision history and can be restored.`;
  },

  async learn_lesson_revisions({ subject_id, lesson_id }) {
    const learn = await learnMod();
    const rows = learn.listRevisions(subject_id, lesson_id);
    if (!rows.length) return 'No previous versions — this lesson has never been regenerated.';
    return rows.map(r => `${r.id}  ${r.createdAt}  "${r.title}" · ${r.chars} chars · ${r.sources} sources${r.health.length ? ` · had ${r.health.length} issue(s)` : ' · clean'}\n   replaced because: ${r.reason || '(no reason recorded)'}`).join('\n');
  },

  async learn_restore_revision({ subject_id, lesson_id, revision_id }) {
    const learn = await learnMod();
    learn.restoreRevision(subject_id, lesson_id, revision_id);
    return `Restored revision ${revision_id} into lesson ${lesson_id}. The version it replaced was snapshotted, so this is reversible.`;
  },

  async learn_record_result({ subject_id, topic, correct }) {
    const learn = await learnMod();
    learn.recordTopicResult(subject_id, topic, !!correct);
    const after = learn.getWeakTopics(subject_id, 30).find(w => w.topic === String(topic).trim().toLowerCase());
    return `Recorded ${correct ? 'CORRECT' : 'INCORRECT'} for "${topic}" in subject ${subject_id}.${after ? ` Now ${after.correct}/${after.seen} (${Math.round(after.ratio * 100)}%).` : ''}`;
  },

  async learn_module_done({ subject_id, module_id, done = true }) {
    const learn = await learnMod();
    const r = learn.setModuleDone(subject_id, module_id, !!done);
    return `Module ${module_id} marked ${r.done ? 'complete' : 'incomplete'}.`;
  },
};

const learnMod = () => import('./learn.js');

/** Render a stored objective response back into readable text, per question kind. */
const tryParse = (v, fb) => { try { return JSON.parse(v); } catch { return fb; } };
function renderGiven(r) {
  if (r.kind === 'shortanswer') return String(tryParse(r.given, r.given));
  if (r.kind === 'order') return (tryParse(r.given, []) || []).map(i => r.choices[Number(i)] ?? '?').join(' → ');
  const idxs = r.kind === 'multi' ? (tryParse(r.given, []) || []) : [tryParse(r.given, r.given)];
  return idxs.filter(i => i !== '' && i !== null && i !== undefined)
    .map(i => `${i}) ${r.choices[Number(i)] ?? '?'}`).join(', ');
}
function renderAnswer(r) {
  if (r.kind === 'shortanswer') { const a = tryParse(r.answer, null); return Array.isArray(a) ? a.join(' / ') : String(r.answer); }
  if (r.kind === 'order') return (tryParse(r.answer, []) || []).map(i => r.choices[Number(i)] ?? '?').join(' → ');
  const idxs = r.kind === 'multi' ? (tryParse(r.answer, []) || []) : [r.answer];
  return idxs.map(i => `${i}) ${r.choices[Number(i)] ?? '?'}`).join(', ');
}

// ---------- shared web helpers (used by the tools above and by research.js) ----------

/** Structured web search: SearXNG when configured, DuckDuckGo fallback. */
export async function webSearch(query, { n = 8, category, time_range } = {}) {
  if (!query || !String(query).trim()) throw new Error('query is empty');
  const cap = Math.min(Math.max(Math.floor(n) || 8, 1), 20);
  const base = (loadConfig().tools?.searxng?.url || '').replace(/\/$/, '');

  if (base) {
    try {
      const u = new URL(base + '/search');
      u.searchParams.set('q', query);
      u.searchParams.set('format', 'json');
      if (category) u.searchParams.set('categories', category);
      if (time_range) u.searchParams.set('time_range', time_range);
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      let j;
      try {
        const r = await fetch(u, { signal: ctl.signal, headers: { accept: 'application/json' } });
        if (!r.ok) throw new Error(`status ${r.status}`);
        j = await r.json();
      } finally { clearTimeout(t); }

      const answers = [];
      for (const a of (j.answers || []).slice(0, 2)) {
        const text = typeof a === 'string' ? a : a?.answer || '';
        if (text) answers.push(text);
      }
      const ib = j.infoboxes?.[0];
      if (ib?.content) answers.push(`${ib.infobox || 'Info'}: ${String(ib.content).replace(/\s+/g, ' ').slice(0, 400)}`);
      const results = (j.results || []).slice(0, cap).map(x => ({
        title: x.title || '(untitled)', url: x.url,
        snippet: String(x.content || '').replace(/\s+/g, ' ').slice(0, 280),
      }));
      return { source: 'SearXNG', results, answers, note: '' };
    } catch (e) {
      try {
        const results = await ddgSearch(query, cap);
        return { source: 'DuckDuckGo', results, answers: [], note: `SearXNG at ${base} failed (${e.message}) — used DuckDuckGo fallback` };
      } catch (e2) {
        throw new Error(`web search failed — SearXNG at ${base}: ${e.message}; DuckDuckGo fallback: ${e2.message}. Start SearXNG with \`npm run searxng\` or fix the URL in Settings → Tools.`);
      }
    }
  }
  const results = await ddgSearch(query, cap);
  return { source: 'DuckDuckGo', results, answers: [], note: 'SearXNG not configured — set it up in Settings → Tools for better results' };
}

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';

/** Strip HTML to readable plain text (scripts/styles/tags removed, entities decoded). */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>(?=.)/gi, '\n').replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** Fetch a URL and reduce it to readable text (HTML stripped). opts.headers lets
 *  callers pass auth cookies (e.g. platform availability checks). */
export async function fetchReadable(url, cap = 2_000_000, opts = {}) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) URLs');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': BROWSER_UA, ...(opts.headers || {}) } });
    const type = r.headers.get('content-type') || '';
    let body = await r.text();
    if (body.length > cap) body = body.slice(0, cap);
    if (type.includes('html')) body = htmlToText(body);
    return { status: r.status, text: body };
  } finally { clearTimeout(t); }
}

// ---------- website crawling ----------
// crawl_site follows same-host links from a start page (breadth-first) and returns
// several pages of readable text — the "read a whole section of a site" companion to
// fetch_url. Native (no external service), polite (small delay + page/time budgets),
// and query-rankable so only the relevant pages come back.

const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

function extractTitle(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 200) : '';
}

function extractLinks(html, base) {
  const out = [];
  const rx = /<a\b[^>]*\bhref=["']([^"']+)["']/gi;
  let m;
  while ((m = rx.exec(html)) && out.length < 400) {
    let href = m[1].trim();
    if (!href || /^(javascript:|mailto:|tel:|data:|#)/i.test(href)) continue;
    href = href.split('#')[0];
    if (href) try { out.push(new URL(href, base).href); } catch { /* skip bad href */ }
  }
  return out;
}

const normUrl = (u) => { try { const x = new URL(u); x.hash = ''; return (x.origin + x.pathname).replace(/\/+$/, '') + (x.search || ''); } catch { return u; } };

async function fetchRaw(url, { signal, cap = 800_000 } = {}) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) URLs');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': BROWSER_UA } });
    const type = r.headers.get('content-type') || '';
    if (type && !/text|html|xml|json/.test(type)) throw new Error('not a text page');
    let body = await r.text();
    if (body.length > cap) body = body.slice(0, cap);
    return { status: r.status, body };
  } finally { clearTimeout(t); signal?.removeEventListener('abort', onAbort); }
}

/** Breadth-first same-host crawl. Returns a readable digest of the pages visited,
 *  ranked by `query` keywords when given. */
export async function crawlSite(startUrl, { query = '', maxPages = 6, depth = 2, signal } = {}) {
  const start = new URL(startUrl);
  if (!/^https?:$/.test(start.protocol)) throw new Error('only http(s) URLs');
  const host = start.host;
  const seen = new Set([normUrl(start.href)]);
  const queue = [{ url: start.href, d: 0 }];
  const pages = [];
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const deadline = Date.now() + 45_000;

  while (queue.length && pages.length < maxPages) {
    if (signal?.aborted || Date.now() > deadline) break;
    const { url, d } = queue.shift();
    let html;
    try { ({ body: html } = await fetchRaw(url, { signal })); }
    catch { continue; }
    const text = htmlToText(html);
    if (text.length > 60) {
      const score = terms.length ? terms.reduce((n, w) => n + (text.toLowerCase().split(w).length - 1), 0) : 1;
      pages.push({ url, title: extractTitle(html), text, score });
    }
    if (d < depth) {
      for (const link of extractLinks(html, url)) {
        let lhost; try { lhost = new URL(link).host; } catch { continue; }
        if (lhost !== host) continue;
        const key = normUrl(link);
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push({ url: link, d: d + 1 });
        if (seen.size > 500) break;
      }
    }
    await sleepMs(120);   // be polite to the origin
  }

  if (!pages.length) return `Crawled ${seen.size} link(s) from ${startUrl} but found no readable pages (the site may require JavaScript — try fetch_url on a specific page).`;
  let shown = pages;
  if (terms.length) {
    const matched = pages.filter(p => p.score > 0).sort((a, b) => b.score - a.score);
    if (matched.length) shown = matched;
  }
  shown = shown.slice(0, maxPages);
  const perPage = terms.length ? 2500 : 1600;
  const body = shown.map(p =>
    `### ${p.title || p.url}\n${p.url}${terms.length ? `  (relevance ${p.score})` : ''}\n\n${p.text.slice(0, perPage)}${p.text.length > perPage ? '\n…[truncated]' : ''}`
  ).join('\n\n---\n\n');
  return `Crawled ${pages.length} page(s) from ${host}${terms.length ? `, ranked for "${query}"` : ''} — visited ${seen.size} link(s):\n\n${body}`;
}

// ---------- PDF ingestion ----------
// Digital PDFs (papers, specs, reports) carry a text layer that `pdftotext`
// (poppler) extracts cleanly; scanned/image PDFs have none, so we fall back to
// OCR (rasterize with pdftoppm → recognize with tesseract) when those binaries
// are installed. Everything degrades gracefully: no toolchain → a clear throw
// that the caller turns into a skipped source, never a crash.

const _cmdCache = {};
function hasCmd(cmd) {
  if (_cmdCache[cmd] === undefined) {
    try { _cmdCache[cmd] = spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0; }
    catch { _cmdCache[cmd] = false; }
  }
  return _cmdCache[cmd];
}
/** True when at least the pdftotext text-layer path is available. */
export const canReadPdf = () => hasCmd('pdftotext');

/** Spawn `cmd`, pipe `input` (Buffer|null) to stdin, resolve stdout as UTF-8.
 *  Tolerant of non-zero exit when usable stdout was produced (pdftotext warns a lot). */
function runPipe(cmd, args, input, { timeoutMs = 45000, maxOut = 12_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { timeout: timeoutMs }); }
    catch (e) { return reject(e); }
    const out = []; let outLen = 0; const errc = [];
    child.stdout.on('data', d => { outLen += d.length; if (outLen <= maxOut) out.push(d); });
    child.stderr.on('data', d => errc.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      const text = Buffer.concat(out).toString('utf8');
      if (text.trim().length || code === 0) resolve(text);
      else reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(errc).toString('utf8').slice(0, 160)}`));
    });
    if (input) { child.stdin.on('error', () => { }); child.stdin.end(input); }
    else child.stdin.end();
  });
}

/** OCR a PDF buffer: pdftoppm → PNG pages → tesseract. Gated on both binaries. */
async function ocrPdf(buf, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-pdf-'));
  try {
    const pdfPath = path.join(dir, 'in.pdf');
    fs.writeFileSync(pdfPath, buf);
    const pages = Math.max(1, Math.min(opts.ocrPages || 12, 40));
    await runPipe('pdftoppm', ['-png', '-r', '150', '-l', String(pages), pdfPath, path.join(dir, 'p')], null, { timeoutMs: 90000 });
    const pngs = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
    let out = '';
    for (const png of pngs) {
      try { out += (await runPipe('tesseract', [path.join(dir, png), 'stdout', '-l', opts.ocrLang || 'eng'], null, { timeoutMs: 40000 })) + '\n\n'; }
      catch { /* skip a bad page */ }
    }
    return out.replace(/\n{3,}/g, '\n\n').trim();
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
}

/** Fetch a PDF URL and return its extracted text as { status, text }.
 *  Text layer via pdftotext first; OCR fallback for scanned PDFs when available. */
export async function fetchPdfText(url, cap = 500_000, opts = {}) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) URLs');
  if (!hasCmd('pdftotext')) throw new Error('pdftotext not installed — install poppler-utils to read PDFs');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs || 30000);
  let buf;
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`status ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(t); }
  const maxBytes = opts.maxBytes || 25_000_000;
  if (buf.length > maxBytes) buf = buf.subarray(0, maxBytes);
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF (bad header)');

  let text = '';
  try { text = await runPipe('pdftotext', ['-q', '-layout', '-', '-'], buf); } catch { }
  text = text.replace(/\f/g, '\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  if (text.length < 200 && hasCmd('pdftoppm') && hasCmd('tesseract')) {
    try { const ocr = await ocrPdf(buf, opts); if (ocr.length > text.length) text = ocr; } catch { }
  }
  return { status: 200, text: text.slice(0, cap) };
}

/** Best-effort DuckDuckGo HTML scrape — used only when SearXNG is unavailable. */
async function ddgSearch(query, n) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  let html;
  try {
    const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      signal: ctl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0' },
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
    html = await r.text();
  } finally { clearTimeout(t); }

  const unesc = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  const out = [];
  for (const block of html.split(/class="result results_links/).slice(1)) {
    const href = block.match(/class="result__a"[^>]*href="([^"]+)"/)?.[1] || '';
    const title = unesc(block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/)?.[1] || '');
    const snippet = unesc(block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1] || '');
    let url = href;
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) { try { url = decodeURIComponent(m[1]); } catch { } }
    if (url.startsWith('//')) url = 'https:' + url;
    if (title && url.startsWith('http')) out.push({ title, url, snippet: snippet.slice(0, 280) });
    if (out.length >= n) break;
  }
  if (!out.length) throw new Error('no results parsed');
  return out;
}

function globToRegex(glob) {
  let rx = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { rx += '(?:.*)'; i++; if (glob[i + 1] === '/') i++; }
      else rx += '[^/]*';
    } else if (c === '?') rx += '[^/]';
    else if (c === '.') rx += '\\.';
    else if ('()[]{}+^$|\\'.includes(c)) rx += '\\' + c;
    else rx += c;
  }
  return new RegExp('^' + rx + '$');
}

/** Unified diff preview for approval cards. */
export function diffPreview(root, name, args) {
  try {
    if (name === 'write_file') {
      const abs = safePath(root, args.path);
      const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      return simpleDiff(before, args.content ?? '', args.path);
    }
    if (name === 'edit_file') {
      const abs = safePath(root, args.path);
      const before = fs.readFileSync(abs, 'utf8');
      const after = args.replace_all ? before.split(args.old_string).join(args.new_string) : before.replace(args.old_string, args.new_string);
      return simpleDiff(before, after, args.path);
    }
    if (name === 'vault_write' || name === 'vault_append') {
      const v = loadConfig().vault?.path;
      if (!v) return null;
      const abs = safePath(v, args.path);
      const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      const after = name === 'vault_write'
        ? (args.content ?? '')
        : (before ? before.replace(/\s*$/, '') + '\n\n' + (args.content ?? '') : (args.content ?? ''));
      return simpleDiff(before, after, args.path);
    }
    if (name === 'quick_note') {
      const v = loadConfig().vault?.path;
      if (!v) return null;
      const safeTitle = String(args.title || '').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
      const fold = String(args.folder || 'Notes').replace(/^\/+|\/+$/g, '') || 'Notes';
      const rel = `${fold}/${safeTitle}.md`;
      const abs = safePath(v, rel);
      const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      const after = before
        ? before.replace(/\s*$/, '') + '\n\n---\n*(appended)*\n\n' + (args.content ?? '')
        : `# ${args.title}\n\n${args.content ?? ''}`;
      return simpleDiff(before, after, rel);
    }
    if (name === 'wiki_learn') {
      const v = loadConfig().vault?.path;
      if (!v) return null;
      const rel = wiki.notePathFor({ title: args.title, folder: args.folder });
      const abs = safePath(v, rel);
      const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      return simpleDiff(before, args.content ?? '', rel);
    }
    if (name === 'create_tool') {
      const prev = forge.getCustomTool(args.name);
      const render = (t) => t ? `// ${t.name} [${t.access}] — ${t.description}\n// params: ${JSON.stringify(t.parameters)}\n${t.code}` : '';
      return simpleDiff(render(prev), render(args), `data/tools/${args.name}.json`);
    }
    if (name === 'git_commit') {
      const stat = git.statPreview(root);
      return stat ? `everything below gets staged and committed:\n${stat}` : null;
    }
  } catch { }
  return null;
}

/** Line diff (LCS on trimmed windows) — good enough for previews, not for patching. */
function simpleDiff(a, b, file) {
  const al = a.split('\n'), bl = b.split('\n');
  // trim common prefix/suffix
  let s = 0; while (s < al.length && s < bl.length && al[s] === bl[s]) s++;
  let e = 0; while (e < al.length - s && e < bl.length - s && al[al.length - 1 - e] === bl[bl.length - 1 - e]) e++;
  const del = al.slice(s, al.length - e), add = bl.slice(s, bl.length - e);
  const cap = (arr, n = 200) => arr.length > n ? [...arr.slice(0, n), `… (${arr.length - n} more lines)`] : arr;
  const lines = [
    `--- ${file}`, `+++ ${file}`,
    `@@ line ${s + 1} @@`,
    ...cap(del).map(l => '-' + l),
    ...cap(add).map(l => '+' + l),
  ];
  return lines.join('\n');
}
