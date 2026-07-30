---
status: refined
created: 2026-07-30
---

# Style and Layout Foundation

## Problem / Motivation
The application is mostly feature complete for the MVP, but it still needs to be styled. See `docs/features/002-UI_wireframe.html` for UI a wireframe starting point.

## Firm Scope
- Dark mode first
- Reactive design all around
  + Primary usage will be on a laptop/desktop (1920x1080) but the style should be reactive and usage on a mobile device

## Nice-to-have / Stretch Scope
<!-- Optional extensions, if time/complexity allows. Omit this section if there are none. -->

## Explicitly Out of Scope
- light/dark mode/color swap to be done either via manual action or read from the users system preferences
- Any net new features should be deferred to a new feature spec

## Related Specs / Code
- `docs/app_idea.md:75-79` — Path to v1.0 sequencing: styling is deliberately first among
  post-MVP work, before Auth, while manual browser verification is still cheap.
- `src/views/layout.tsx` — shared layout/nav wrapper every route renders through; the
  top-nav → sidebar change happens here.
- `src/styles/input.css`, `public/css/tailwind.css`, `package.json:9-10` (`css:build`/
  `css:watch`) — existing Tailwind v4 pipeline, wired in but essentially unused (3 color
  utilities total, no dark mode config, no design tokens).
- `src/views/queue-list.tsx`, `src/routes/queue.tsx` — Queue/Continue Watching/Watched/
  Ignored share this one component, branching by `view` prop.
- `src/views/categories-list.tsx`, `src/views/ignore-rules-list.tsx`,
  `src/views/subscription-list.tsx`, `src/views/subscribe-confirm.tsx` — the three CRUD-style
  pages (Categories, Ignore Rules, Channels).
- `src/views/watching-page.tsx` — single-video Watching page; only existing page with a
  thumbnail image today.
- `src/lib/nav-counts.ts` — `NavCounts` type backing the nav's per-item counts.
- `docs/specs/009-unwatched-counters-and-category-links.md`,
  `docs/specs/010-queue-as-root-route.md` — most recent nav/routing-adjacent specs.

## Open Questions
<!-- none remaining — see Resolved Decisions below -->

## Resolved Decisions
- **Wireframe is the settled direction, extrapolated.** The wireframe
  (`docs/features/002-UI_wireframe.html`) only sketches one screen (Queue as a 3-column card
  grid, option `1b`/turn `t1`) but is treated as the chosen direction for all video-list
  pages (Queue, Continue Watching, Watched, Ignored). Pages it doesn't cover (Categories,
  Ignore Rules, Channels, the shared nav) get a consistent design proposed during `/new-spec`
  rather than waiting on more wireframe screens.
- **Sidebar navigation replaces the flat top-nav.** The current single horizontal
  `<nav>` (`src/views/layout.tsx:31-41`) is replaced with a sidebar, including expandable
  Categories and Ignore Rules sub-items and per-item counts, matching the wireframe. This is
  a structural change to `layout.tsx`, not pure CSS, and is explicitly in scope.
- **Video thumbnails added to all video-list views.** Queue, Continue Watching, Watched, and
  Ignored gain a thumbnail `<img>` per row/card, reusing the exact same
  `https://i.ytimg.com/vi/{id}/hqdefault.jpg` URL pattern already used on the Watching page
  (`src/views/watching-page.tsx:15-17`). No new data or API calls — treated as in-scope
  markup, not a net-new feature.
- **View counts dropped; dates switch to relative time.** View counts (the wireframe's `12K`
  style) are out of scope — the field doesn't exist anywhere in the data model
  (`app_idea.md:55`) and capturing it would be real new capability (ingestion/schema
  change), deferred to a separate feature. Relative "time ago" formatting (the wireframe's
  `2h`/`1d`/`1w`) *is* in scope, since it needs no new data — just reformatting the existing
  `publishedAt`/`watchedAt` timestamps already rendered via `toLocaleDateString()`
  (`src/views/queue-list.tsx:130,169`).
- **No new detail pages.** No individual Channel detail page or individual Category detail
  page exists today (category "detail" is just Queue pre-filtered by `?category=id`;
  channels have no detail route at all). Neither is added by this feature — styling this
  feature's scope means restyling what exists, and a new route/page is a net-new feature per
  the existing "Explicitly Out of Scope" line above.
- **CRUD pages get a distinct list/table treatment, not the card grid.** Categories, Ignore
  Rules, and Channels (`src/views/categories-list.tsx`, `ignore-rules-list.tsx`,
  `subscription-list.tsx`) keep their row-based, inline-edit-swaps-to-a-form interaction
  pattern, styled as a clean list/table consistent with the dark theme and sidebar — not
  forced into the video views' card-grid visual language.
- **`ignoredCount` not added.** The Ignored (and Ignore Rules) sidebar item(s) stay countless,
  matching today's behavior. `NavCounts` (`src/lib/nav-counts.ts:5-9`) is not extended with a
  new query for this feature.
- **Single spec.** `/new-spec` writes this as one spec covering the sidebar/layout shell,
  dark theme + design tokens, the four video-list pages, the three CRUD pages, and relative-
  time formatting. `/spec-tasks` breaks execution into many small per-page steps regardless,
  and everything shares one design system + one `layout.tsx` change, so splitting into
  multiple specs would mostly add cross-spec coordination overhead.
- **Wireframe file stays checked in.** `docs/features/002-UI_wireframe.html` remains in the
  repo permanently as a visual reference for the styling direction (not deleted once the
  spec exists).
- **Whole app gets the dark theme, not just the wireframe's one covered screen.** The Firm
  Scope's "Dark mode first" / "Reactive design all around" already commits to full coverage,
  so the single-video Watching page (`src/views/watching-page.tsx` — currently an unstyled
  full-width thumbnail, plain-text status badge, and unstyled buttons) is restyled to match
  the same design tokens/theme as every other page, even though the wireframe itself doesn't
  depict it.
- **Sidebar category links replace the in-page category filter row.** The sidebar's
  Categories sub-items become the one way to filter Queue/Continue Watching/Watched/Ignored
  by category; the existing in-page `CategoryFilterLinks` row (`src/views/queue-list.tsx:82-
  96`, duplicated across those four views) is removed rather than kept alongside the sidebar,
  avoiding two controls doing the same thing on the same page.
- **Sidebar collapses to off-canvas/hamburger on mobile.** Below a breakpoint, the sidebar
  collapses behind a toggle rather than staying persistently docked, consistent with the
  Firm Scope's mobile-reactive requirement; full docked sidebar remains the desktop
  (1920x1080-primary) experience.
