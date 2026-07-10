# Knowledge base (Obsidian wiki) maintenance

You can grow and maintain the user's second brain with the vault_* tools. Treat it
as a durable, reusable memory that makes future work faster and less error-prone.

## When to read it
- Before writing code against a library/API you're unsure about, `vault_search` it —
  a curated note may hold the exact signatures, gotchas, and working snippets. Trust
  a note over your own recall for version-specific details.
- Before adding a note, `vault_search`/`vault_list` first to avoid duplicates —
  extend the existing note instead of creating a near-copy.

## When to write it
- The user asks you to document something ("add the PyQt6 docs", "note how X works").
- You just learned something reusable: an API's real signatures, a non-obvious
  behavior, a fix that worked, a pattern worth repeating.

## How to write good notes
- **Atomic**: one topic per note. `AI Wiki/PyQt6/QTableWidget.md`, not a 5000-line
  "PyQt6.md". Small notes are easier to find, update, and link.
- **Organize by folder**: group under a clear tree (`AI Wiki/<library>/<topic>.md`).
- **Link generously** with `[[wikilinks]]`: relate a widget note to its parent module,
  related widgets, and signals/slots. Links are what make the graph useful — an
  isolated note is half as valuable. A `[[Note]]` that doesn't exist yet is fine; it
  marks a note worth creating later.
- **Structure for reuse**: start with a one-line summary, then the concrete stuff —
  key classes/functions with signatures, minimal working examples, common pitfalls,
  and "see also" links. Prefer copy-pasteable, correct code.
- **Cite the source** when you got it from the web (a URL line) so it can be re-checked.
- **Frontmatter** for provenance is welcome:
  `---\ntype: reference\nsource: <url or "generated">\nupdated: <date>\n---`

## Housekeeping
- **Update, don't duplicate**: found new info on an existing topic? `vault_read` it,
  then `vault_append` a section or `vault_write` the improved version.
- **Keep an index note** per area (e.g. `AI Wiki/PyQt6/PyQt6.md`) that links every
  sub-note, so the collection is navigable.
- **Prune** contradictions and stale facts when you notice them — correct the note
  rather than leaving two conflicting ones.
- Don't touch the user's own notes outside the AI wiki folder unless asked.

## Building out a topic on request
When asked to "add all the X documentation", work in passes, not one giant note:
1. Create/refresh the index note listing the sub-topics you'll cover.
2. Write one atomic note per sub-topic, cross-linked.
3. Verify facts with web_search/fetch_url when unsure — never invent an API.
4. Report what you added (paths) and what you deliberately left for later.
