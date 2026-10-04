---
status: implemented
created: 2026-10-04
---

# Fixed Sidebar

## Context

At `lg:` and up, the sidebar (`<aside id="sidebar">` in `src/views/layout.tsx`) is
`lg:static` inside a flex `<body class="... lg:flex lg:min-h-screen">`, so it scrolls away
with the page. On long pages (e.g. `/queue` with many rows) the nav and "Log out" are
unreachable without scrolling back to the top. Layout background: `docs/specs/011-style-and-layout.md`
and `docs/specs/018-ui-ux-polish-pass.md` (the drawer/sidebar structure this builds on).

## Scope

In:
- Desktop (`lg:`+) sidebar stays in view while the page scrolls.
- Class-only changes in `src/views/layout.tsx` (body, aside, nav, main).

Out:
- Any change to the mobile drawer (below `lg:`), its toggle, or backdrop.
- Finding the root cause of why the flex body didn't grow with its content (see Design).
- Sidebar content/ordering changes.

## Design

**Rejected first attempt: `lg:sticky lg:top-0 lg:h-screen lg:self-start`.** The classes
applied correctly (DevTools: `position: sticky`, `align-self: flex-start`) but did nothing
on `/queue`: `<html>`, `<body>` and `<main>` all stayed at viewport height (965px) while
`#queue-list` overflowed to a document `scrollHeight` of ~5466px, so sticky had no
ancestor height to travel within. The root cause (why the flex body doesn't grow with its
content) was never found. Rather than keep chasing it, the chosen approach doesn't depend
on body height at all.

**Chosen: make the sidebar `fixed` at all widths** (verified working in a real browser on
`/queue` and the Ignored page). The aside is already `fixed inset-y-0 left-0 w-64` for the
mobile drawer, so desktop simply stops overriding that to `static`:

- `<body>`: `bg-bg text-text lg:flex lg:min-h-screen` → `bg-bg text-text`.
- `<aside>`: drop `lg:static`, `lg:w-64`, `lg:shrink-0` (width is already `w-64` at base,
  and a fixed element is out of flow so `shrink-0` is meaningless). Keep
  `fixed inset-y-0 left-0 w-64` plus `lg:z-auto lg:translate-x-0`.
- `<main>`: `min-w-0 flex-1 p-4 pt-20 lg:pt-6` → `min-w-0 p-4 pt-20 lg:ml-64 lg:pt-6`.
  `flex-1` is dropped (body is no longer flex); `lg:ml-64` reserves the space the
  now-out-of-flow sidebar used to occupy (matches `w-64`).
- `<nav>` (inside the aside): `h-full` → `min-h-full`. With `h-full`, when the window is
  shorter than the content the children overflow nav's box, `mt-auto` collapses to 0, and
  nav's bottom `p-4` falls outside the scrollable area, leaving "Log out" flush against the
  bottom edge. `min-h-full` keeps `mt-auto` pinning it to the bottom on tall windows and
  keeps the padding when scrolling.
- Mobile drawer unchanged: `lg:hidden` toggle/backdrop, `-translate-x-full` →
  `data-[open=true]:translate-x-0`, `z-40`.

**Short windows.** The aside keeps `overflow-y-auto`, so when the window is shorter than the
nav the aside scrolls internally and "Log out" (at the bottom, `mt-auto`) stays reachable.
This must be checked explicitly since a fixed sidebar can no longer be reached by page scroll.

**`lg:z-auto`** is kept as-is: `lg:ml-64` keeps `<main>` and its descendants from
overlapping the aside at desktop widths, so z-order never matters there (positioned
descendants of `<main>` would paint above a `z-auto` aside by DOM order, but can't reach it).

## Verification

- Run `bun run css:build` (or have `css:watch` running) first: `public/css/tailwind.css`
  is generated and untracked, so `lg:ml-64` won't exist until it's rebuilt.
- `bun test` (including the no-inline guard test for pages), `bun run lint`,
  `bunx tsc --noEmit`, `bun run fallow` — all clean.
- `curl` `/queue` from inside the devcontainer (via `scripts/dev-login.sh` cookie jar) and
  confirm the new classes (`lg:ml-64` on `<main>`; no `lg:static` on the aside, no
  `lg:flex` on body).
- User, live in a browser: sidebar stays in view while scrolling `/queue` and one other
  page; "Log out" reachable at a short window height; mobile drawer (narrow window) still
  opens/closes.

## Open Questions

None. Red-team pass 1 (independent subagent) found no blocking defects; fixed: nav
`h-full` → `min-h-full` (Log out bottom padding at short heights), added the CSS rebuild
step to Verification, softened the `lg:z-auto` reasoning, corrected the "aside/body"
wording, and added a supersession pointer in spec011. The pass also noted the flex-body
root cause remains unknown (acceptable, `fixed` doesn't depend on it). Task-file step
should also change nav's `h-full` per Design.
