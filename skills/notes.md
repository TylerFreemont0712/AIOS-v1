# The note system (second brain)

The vault is a typed note system, not a pile of markdown. Every durable note is ONE of
seven kinds, each with a fixed template. Typed notes stay scannable, recall packs them
efficiently, and two people (the user and you) can maintain them without style drift.
Read [knowledge-base](knowledge-base.md) for the tool workflow; this playbook is the
WHAT-to-write. Get any template verbatim with the `note_template` tool, and pass
`kind` to `wiki_learn` so the type lands in frontmatter.

## Pick the kind first

| kind | use when | title looks like |
|---|---|---|
| `concept` | explaining what something IS | "Event Loop", "CSS Specificity" |
| `howto` | a repeatable task recipe | "Publish an npm Package" |
| `reference` | exact API/tool/flag facts | "fetch() Options", "jq Cheatsheet" |
| `decision` | a choice was made and must stick | "Zero-build Frontend Decision" |
| `troubleshooting` | an error was diagnosed and fixed | "ECONNRESET on Node fetch" |
| `source` | distilling a book/article/video | "Ousterhout — A Philosophy of Software Design" |
| `project` | the hub note for an ongoing effort | "AIOS", "Job Search 2026" |

If a note wants to be two kinds, it's two notes — split and link them.

## Templates (follow the section names exactly)

**concept** — definition first so a truncated recall is still useful:
```
**<One-sentence definition.>**
## Why it matters
## How it works
## Example            ← minimal, runnable, correct
## Pitfalls
## Related            ← [[links]], always last
```

**howto** — one action per step, verifiable end state:
```
**Goal: <what this achieves, one line.>**
## Prerequisites
## Steps              ← numbered; one command/edit per step
## Verify             ← how you know it worked
## Pitfalls
## Related
```

**reference** — exact and versioned or it's worse than nothing:
```
**<What this covers, one line, with version.>**
## Key signatures     ← code block, exact
## Options that matter← table: option | effect | default
## Minimal example
## Gotchas
## Source             ← URL so it can be re-checked
## Related
```

**decision** — context now, trigger to revisit later:
```
**Decision: <what was decided> (<date>).**
## Context
## Options considered ← each with the pro/con that mattered
## Rationale
## Consequences       ← what this commits us to
## Revisit when       ← the concrete trigger that would reopen it
## Related
```

**troubleshooting** — searchable by symptom:
```
**Symptom: <exact error text or observable failure.>**
## Root cause
## Fix                ← the working fix, copy-pasteable
## Prevention
## Environment        ← versions/OS, date seen
## Related
```

**source** — claims and quotes stay attributed:
```
**<Author> — *<Title>* (<year>): <one-line thesis.>**
## Key claims         ← with chapter/section anchors
## Quotes             ← verbatim, > blockquoted, only keepers
## Takeaways          ← what changes in practice
## Related
```

**project** — a hub, not a diary; link out, log tersely:
```
**<Project> — <goal in one line.> Status: <active|paused|done>.**
## Goal & success criteria
## Current state
## Key notes          ← [[links]] to its decisions/references/howtos
## Log                ← "- YYYY-MM-DD <event>", newest first
## Related
```

## Quality bar (applies to every kind)
- **Atomic**: one topic. If the Related section is doing the work of sections, split.
- **Definition-first bold line** — never start with throat-clearing.
- **Concrete over general**: signatures, versions, numbers, exact error text.
- **≥2 [[links]]** in Related; link liberally — a link to a note that doesn't exist yet
  marks it worth writing (`[[Redis Persistence]]` before the note exists is GOOD).
- **Grounded**: web-sourced facts carry the URL; experience-sourced facts carry the date.
- **Tags**: 2-4 lowercase frontmatter tags, reuse existing ones (`vault_search` a tag
  before inventing a synonym).

## Filing
- Wiki notes live under the wiki folder in domain folders: `JavaScript/`, `Python/`,
  `Git/`, `Shell/`, `Practices/`, `AIOS/`, `Learning/`, plus new domains as needed —
  max two levels deep.
- Templates live in `Meta/Templates/` — copy structure from there, never edit them
  to hold content.
- `decision` and `project` notes for a codebase ALSO get summarized into that repo's
  `.aios/` memory if you're the agent working there — the vault is for knowledge that
  outlives one repo.

## Maintenance (do these opportunistically, they're pre-approved)
- Found new facts on an existing topic → update that note; never write "X (new)".
- A note answered your question but was stale/wrong → fix it in the same run.
- After 3+ related notes appear, make/refresh the domain's index note and link them.
- `wiki_index` after bulk changes so [[Home]] stays honest.
