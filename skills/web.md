# HTML / CSS / frontend best practices

## HTML
- Semantic elements: `<button>` for actions (never a clickable `<div>`), `<a>` for navigation, `<nav>/<main>/<section>`, `<label>` wired to every input.
- Images get `alt`; icon-only buttons get `title` or `aria-label`.
- Forms submit on Enter for free if you use `<form onsubmit>` — don't rebuild that with key handlers.

## CSS layout
- Flexbox for rows/columns, Grid for 2-D layouts. Gap over margins between siblings: `display:flex; gap:8px`.
- The scroll container needs `min-height:0` (or `min-width:0`) when inside flex — the #1 "why won't it scroll" bug.
- `box-sizing: border-box` globally (usually already in the reset — check before re-adding).
- Relative units for layout (`rem`, `%`, `fr`, `min()/clamp()`); px only for borders and small fixed details.
- Don't hardcode heights to make things fit — let content size itself, constrain with `max-height` + `overflow-y:auto`.

## CSS organization
- Reuse the project's variables (`var(--accent)`, spacing, radii) — grep the theme file first; never hardcode a color that has a variable.
- Class selectors, shallow (`.card-title`, not `div > span.title`); avoid `!important` — fix specificity instead.
- States as modifier classes toggled from JS: `.btn.loading`, `.item.selected`.
- Transitions on specific properties (`transition: opacity .15s`), not `all`. Respect dark mode: test both themes if the app has them.

## Interaction & a11y
- Everything clickable: cursor pointer, visible hover state, and a focus style (`:focus-visible`).
- Keyboard path for every mouse path: Enter/Space activates, Escape closes, arrows navigate lists.
- Contrast: body text ≥ 4.5:1 against its background. Muted ≠ unreadable.
- Loading/empty/error states for anything async — a blank region is a bug.

## Vanilla JS DOM
- Build with `createElement`/helpers, not string-concatenated `innerHTML` with user data (XSS).
- Event delegation for lists (one listener on the container), direct listeners for singletons.
- Clean up what you start when a view unmounts: intervals, observers, global listeners.

## Verify
- Open it in the browser and click through the changed flow; check console for errors and layout at a narrow width (~800px).
