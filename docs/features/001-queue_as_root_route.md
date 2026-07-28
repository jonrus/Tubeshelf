---
status: promoted
created: 2026-07-28
promoted_to: docs/specs/010-queue-as-root-route.md
---

# Adjust Root Path to Queue Page

## Problem / Motivation
Adjust the root route `/` to point at the queue page. The main usage of the application
will be to _watch_ content. The shortest path to watching is from the queue page.

## Firm Scope
- The root route `/` redirects (303) to `/queue`, reusing the existing `c.redirect`
  precedent (src/routes/queue.tsx:422). No queue rendering logic is duplicated onto `/`.
- The existing Categories page (currently `categoriesRoute.get("/", ...)`) moves to
  `GET /categories`, alongside its existing POST create/rename handlers.
- The nav bar's Categories link (`src/views/layout.tsx:32`) is updated to point at
  `/categories`. The Queue nav link is unchanged.

## Nice-to-have / Stretch Scope
- N/A

## Explicitly Out of Scope
- Any backend changes unrelated to updating the route(s).
<!-- Anything you already know you don't want touched, or want deferred to a future feature. -->

## Related Specs / Code
- `src/index.ts:17-23` — Hono app mounting `categoriesRoute`, `channelsRoute`,
  `queueRoute`, `ignoreRulesRoute` all via `app.route("/", ...)`; no single top-level
  route table, each sub-router owns its own paths.
- `src/routes/categories.tsx:49-57` — current `GET /` handler (Categories page), to move
  to `GET /categories`.
- `src/routes/queue.tsx:276-299` — `GET /queue` handler, the redirect target.
- `src/routes/queue.tsx:422` — existing `c.redirect(url, 303)` precedent to reuse.
- `src/views/layout.tsx:31-40` — hardcoded nav bar; no active-link highlighting exists
  anywhere in the codebase (confirmed via grep), so none needs to be added or adjusted.

## Open Questions
<!-- Anything you're already unsure about, or expect will come up. Leave blank if none come
     to mind yet — /new-feature does its own research pass regardless and will likely find
     more than you list here. -->

## Resolved Decisions

- **Root serves queue content via an HTTP redirect (`c.redirect`), not a direct render.**
  `/` is currently owned by `categoriesRoute.get("/", ...)` (src/routes/categories.tsx),
  a real Categories management page — not a placeholder. The queue handler
  (src/routes/queue.tsx:276-299) resolves a "current user" and queries per-user queue
  data. Multi-user support is a long-term goal of the app (docs/app_idea.md); a redirect
  keeps `/queue` as the single canonical route owning that user-resolution/query logic,
  so future auth/session work only touches one route. Direct-rendering the same content
  at both `/` and `/queue` would mean keeping two route registrations in sync as that
  logic grows (e.g. a future `/login` redirect for unauthenticated users, or a per-user
  path). `/` becomes a thin redirect (303, matching the existing precedent at
  src/routes/queue.tsx:422) with no business logic of its own.

  *Superseded during spec writing* — the status code was changed to 302. See
  docs/specs/010-queue-as-root-route.md's Design section: the 303 precedent is
  specifically a POST-then-redirect-to-GET (PRG) pattern, which doesn't apply to this
  plain GET-to-GET redirect; 302 is the conventional choice there instead. Confirmed with
  the user while writing the spec.

- **Categories moves to `/categories`.** Matches the existing `/channels`/`/queue`
  plural-noun path convention. `categoriesRoute` already owns a `/categories` sub-path
  for its POST create/rename handlers (src/routes/categories.tsx), so the existing GET
  `/` handler just moves to sit alongside them at GET `/categories` — no new routing
  pattern introduced.

- **Nav bar: only the Categories link changes.** `src/views/layout.tsx:32` updates
  `<a href="/">Categories</a>` to `<a href="/categories">Categories</a>`. The Queue link
  (`<a href="/queue">Queue</a>`) is untouched — Queue's route and logic didn't move, only
  `/` now redirects to it. Confirmed via grep (`href="/"` and route registrations) that
  no other template or route depends on `/` resolving to Categories — the nav link and
  `categoriesRoute.get("/", ...)` are the only two references.
