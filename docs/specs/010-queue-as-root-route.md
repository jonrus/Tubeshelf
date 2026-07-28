---
status: draft
created: 2026-07-28
---

# Queue as Root Route

## Context

The main usage of the app is watching queued content, and the shortest path to that is the
Queue page (`/queue`). Today the root route `/` is owned by `categoriesRoute.get("/", ...)`
(`src/routes/categories.tsx:49-57`) — a real Categories management page, not a placeholder
— so visiting the bare domain lands on category management instead of the queue.

This spec originates from `docs/features/001-queue_as_root_route.md` (`status: refined`),
which already resolved the core approach through a scoping pass. This spec confirms that
scope against the current codebase, resolves two implementation gaps the feature file left
open (exact handler location and redirect status code), and is now the source of truth for
this work.

## Scope

**In:**
1. `GET /` redirects (302 Found) to `/queue`. The handler is registered on the existing
   `queueRoute` sub-router (`src/routes/queue.tsx`) as `queueRoute.get("/", (c) =>
   c.redirect("/queue", 302))` — a one-line handler with no business logic.
2. The Categories page's existing `GET /` handler
   (`categoriesRoute.get("/", ...)`, `src/routes/categories.tsx:49-57`) moves to
   `GET /categories`, sitting alongside that router's existing `/categories` POST
   create/rename handlers.
3. The nav bar (`src/views/layout.tsx:32`) updates its Categories link from `href="/"` to
   `href="/categories"`. The Queue link (`href="/queue"`) is unchanged.
4. `test/routes/categories.test.ts:275` (`categoriesRoute.request("/")`) updates to
   `categoriesRoute.request("/categories")` — same assertions, new path.
5. A new test in `test/routes/queue.test.ts` covers `queueRoute.request("/")` returning a
   302 with a `Location: /queue` header.

**Out (deferred / not this spec):**
- Any backend changes unrelated to updating these routes (per the originating feature
  file).
- Any auth/session/multi-user work. Multi-user support is a long-term product goal and is
  the *reason* a redirect was chosen over a direct render (see Design below), but no
  auth/session code is added here — `getCurrentUser()` (`src/lib/current-user.ts`)
  continues to resolve a single default user exactly as it does today, unchanged by this
  spec.
- Any active-nav-link highlighting (e.g. marking "Queue" as the current page). Confirmed
  via grep that no such mechanism exists anywhere in the codebase today, so none is being
  removed, broken, or owed here.
- Preserving query strings across the `/` → `/queue` redirect (e.g. `/?sort=oldest`). No
  existing link or bookmark points at `/` with query params, so there's nothing to
  preserve; a bare redirect to `/queue` is sufficient.

## Design

**Redirect, not direct render.** `/queue`'s handler (`src/routes/queue.tsx:276-299`)
resolves a "current user" and queries per-user queue data. Multi-user support is a
long-term goal of the app (`docs/app_idea.md`). A redirect keeps `/queue` as the single
canonical route that owns that user-resolution/query logic — when real auth/session work
eventually lands, only the redirect target (or a future auth-gating check) needs to change
in one place, rather than two route registrations (`/` and `/queue`) needing to stay in
sync as that logic grows. This was confirmed with the user specifically because of the
multi-user goal, not assumed.

**Redirect handler lives on `queueRoute`, not directly on the bare `app` in
`src/index.ts`.** Every existing route in this codebase lives on one of four exported Hono
sub-routers (`categoriesRoute`, `channelsRoute`, `queueRoute`, `ignoreRulesRoute`), each
independently testable via `<router>.request(path)` in its corresponding
`test/routes/*.test.ts` file. `src/index.ts`'s `app` is never exported and, unlike the route
modules, runs migrations, seeding, and `startScheduler()` as import-time side effects
(`src/index.ts:12-25`) — exporting it for tests would trigger those side effects on import,
which is undesirable. Registering the redirect as `queueRoute.get("/", ...)` keeps it
testable with the exact same pattern (`queueRoute.request("/")`) as every other route in the
app, at the cost of a redirect-only handler technically living in `queue.tsx` rather than a
neutral top-level file — judged an acceptable trade given the alternative is an untestable
route, the only one in the codebase.

**302 Found, not 303 See Other.** The one existing `c.redirect` call in the codebase
(`src/routes/queue.tsx:422`) uses 303, but that's specifically a POST-then-redirect-to-GET
(PRG) pattern, where 303 explicitly tells the client "fetch the result via GET regardless of
the original method." This redirect is GET-to-GET, for which 302 is the conventional choice
(a temporary redirect from an index path to its canonical view). Since the original request
here is already GET, browser-visible behavior is identical either way — this is a semantic
convention choice, not a functional one — but 302 was chosen as the better fit for a plain
GET redirect rather than defaulting to the PRG-flavored precedent.

**Categories moves to `/categories`, matching the existing `/channels` and `/queue`
plural-noun path convention.** `categoriesRoute` already owns `/categories` as a path
prefix for its POST create/rename handlers (`src/routes/categories.tsx:59,107,123`), so the
existing `GET /` handler simply joins them at `GET /categories` — no new routing pattern is
introduced, and no route-mounting order changes are needed in `src/index.ts` (only
`queueRoute` will register `/` going forward; `categoriesRoute` no longer does).

**Nav bar: only the Categories link changes.** Confirmed via grep (`href="/"` and route
registrations) that the nav link (`src/views/layout.tsx:32`) and
`categoriesRoute.get("/", ...)` are the only two references to bare `/` anywhere in the
codebase — no other template, redirect target, or route depends on `/` resolving to
Categories.

## Open Questions

None. Two implementation gaps left open by the originating feature file were resolved
during spec writing, confirmed directly with the user:
- Redirect handler location (`queueRoute` vs. bare `app` in `index.ts`) — resolved in favor
  of `queueRoute`, for testability (see Design).
- Redirect status code (302 vs. 303) — resolved in favor of 302, as the conventional choice
  for a GET-to-GET redirect (see Design).

**Red-team retrospective:** One review pass (independent subagent, no memory of the
drafting conversation) checked every concrete code claim in this spec against the current
source (line numbers, route registrations, test call sites), checked route-mount ordering
in `src/index.ts` for conflicts, checked query-param interaction on the `/` → `/queue`
redirect, and re-verified the "no active-nav-highlighting exists" and "nothing else sits at
or near `/`" claims (no favicon/robots.txt/health-check route found either). It found
nothing inaccurate or inconsistent. No second pass was run, per the stopping rule — a first
pass finding nothing is itself the signal to stop.
