---
status: implemented
created: 2026-08-02
---

# Auth & CSRF

## Context

Per `docs/app_idea.md` §"Path to v1.0", step 2, the app has been deliberately auth-free
through MVP and styling development (`docs/specs/001` through `011`, all `implemented`) —
that posture doesn't survive the app actually being exposed, whether on the LAN or over the
internet via a tunnel (§5, "Security & Authentication"). This spec implements that
requirement: session-based username/password login, DB-backed lockout on failed attempts,
env-var password recovery, and CSRF protection on every state-changing request.

This spec originates from `docs/features/003-auth-and-csrf.md` (`status: refined`), which
already resolved the bulk of scope through a `/new-feature` pass — including the
PIN-vs-password decision, the multi-domain (NGINX Proxy Manager LAN + Cloudflare Tunnel
WAN) deployment reality and its consequences for CSRF/cookie design, and the existing
test suite's per-router `.request()` pattern and what that means for how middleware must be
wired. This spec confirms that scope against the current codebase (all Related Specs/Code
claims in the feature file were verified accurate as of this writing) and resolves the
concrete technical design the feature file deliberately left open: session storage
mechanism, lockout thresholds, post-login redirect behavior, and the local dev bootstrap
story.

## Scope

**In:**
1. Username/password login gating every existing route except `GET /css/*`
   (`src/index.ts:19`) and the new `/login` route.
2. A new `authRoute` Hono sub-router (`src/routes/auth.tsx`): `GET /login`, `POST /login`,
   `POST /logout`.
3. DB-backed sessions (new `sessions` table) with a 30-day sliding expiration, delivered via
   an `HttpOnly` cookie holding an opaque random token.
4. DB-backed lockout: `failedLoginAttempts` and `lockedUntil` columns added to `users`. A
   raw cumulative counter (no time-decay — see Design) reaching 5 failed attempts triggers
   a 15-minute lockout.
5. Password recovery via an env var (`AUTH_RECOVERY_PASSWORD`) applied on every boot.
6. CSRF protection via an Origin-header allowlist (`TRUSTED_ORIGINS` env var, comma-
   separated) on every state-changing request across all five route modules (the four
   existing ones plus the new `authRoute`). The originating feature file undercounted the
   existing mutating endpoints at 11; the actual, verified count is **14**:
   `src/routes/channels.tsx` (`POST /subscriptions/preview`, `POST /subscriptions`,
   `DELETE /subscriptions/:id`, `POST /subscriptions/:id/dismiss-missed-videos`),
   `src/routes/categories.tsx` (`POST /categories`, `POST /categories/:id`),
   `src/routes/ignore-rules.tsx` (`POST /ignore-rules`, `POST /ignore-rules/:id`,
   `DELETE /ignore-rules/:id`), `src/routes/queue.tsx` (`POST /videos/:id/watching`,
   `POST /videos/:id/watched-toggle`, `POST /videos/:id/toggle`, `POST /videos/:id/ignore`,
   `POST /videos/:id/unignore`).
7. Post-login redirect back to the originally requested page, via a new `from` query
   param on `/login` — same naming convention as, but a distinct mechanism from, the
   existing enum-based `from`/`RETURN_VIEWS` "smart return" pattern
   (`src/routes/queue.tsx:205-234`); see Design for why they can't literally share code and
   how the new one is validated.
8. `HX-Redirect`-based session-expiry handling for HTMX requests, so an expired session on
   a mutating (or any authenticated) request navigates the browser instead of a broken
   partial swap.
9. A devcontainer-baked default recovery password (`.devcontainer/devcontainer.json`'s
   `containerEnv`) so local dev has a working login with zero manual setup, clearly
   documented as dev-only and never meant to reach a real deployment.
10. Full retrofit of `test/routes/*.test.ts` (all four existing files) plus new coverage:
    a shared `test/helpers/auth.ts`, login success/failure, lockout trigger/expiry, session
    expiry/logout, CSRF rejection, and unauthenticated-GET-redirects-to-login.

**Out (deferred / not this spec):**
- OTP/MFA (`app_idea.md:128`, explicitly "v3+").
- Multi-user support, registration, guest/admin roles (`app_idea.md`'s User Roles table,
  "Post MVP").
- DB squash — deliberately sequenced after this spec (`app_idea.md` Path to v1.0 step 3),
  so it can catch this spec's own migrations (`sessions` table, `users` columns) in the same
  squash. This spec adds migrations; it does not clean any up.
- Deployment/Docker packaging, standing up the actual NPM/Cloudflare Tunnel infrastructure,
  and choosing the real production domains — Path to v1.0 step 4. This spec builds the
  *mechanism* (a trusted-origins allowlist, a per-request-derived cookie `Secure` flag) that
  makes multi-domain deployment possible; it does not configure or deploy it.
- Cross-domain single sign-on. Confirmed in the feature file: logging in via one trusted
  origin does not authenticate a visit via another — accepted, not a gap to close here.
- Password complexity requirements / minimum length enforcement beyond "non-empty." Single-
  account personal app; not worth the added surface for this spec.

## Design

### Schema changes

`src/db/schema.ts`:
- `users` gains two columns: `failedLoginAttempts: integer("failed_login_attempts")
  .notNull().default(0)` and `lockedUntil: integer("locked_until", { mode: "timestamp" })`
  (nullable; null = not locked). `passwordHash` stays nullable at the DB level (its existing
  type) — a null hash means "cannot log in with any password," which is the correct state
  for a freshly-seeded user before the recovery env var has ever been applied. No DB-level
  `NOT NULL` constraint is added, to avoid breaking `src/db/seed.ts:16-19`'s existing
  no-password seed.
- New `sessions` table: `id` (integer pk, autoincrement), `userId` (fk to `users.id`),
  `tokenHash` (text, not null, unique — SHA-256 of the opaque token, via `node:crypto`'s
  `createHash("sha256")`; the raw token itself is never stored, only its hash, so a DB read
  alone can't be replayed as a live session), `createdAt` (timestamp, default now),
  `lastSeenAt` (timestamp, not null, default now — the sliding-expiration clock; updated on
  every authenticated request).
- New `TRUSTED_ORIGINS`/`AUTH_RECOVERY_PASSWORD` env vars are read at startup, not stored in
  the DB.

**Why DB-backed sessions over a stateless JWT:** confirmed with the user — `app_idea.md`'s
own DB-squash rationale ("Path to v1.0" step 3) already anticipates auth adding "session/
token storage" schema, and a DB-backed row is what makes logout and lockout actually mean
something (a session can be deleted; a stateless JWT can't be revoked before its own expiry
without a DB-backed blacklist table anyway, which is the same schema cost for a worse
design).

### Session lifecycle

- Login (`POST /login`): on success, generate a random opaque token (`node:crypto`'s
  `randomBytes(32)`, base64url-encoded), insert a `sessions` row with its SHA-256 hash, and
  set it as an `HttpOnly`, `SameSite=Lax` cookie. `SameSite=Lax` (not `Strict`) is required
  because top-level navigation *to* the app (e.g. a bookmark or typed URL) must still carry
  the cookie — `Strict` would drop it on that first navigation.
- Every authenticated request — GET or POST, not just mutations — `requireAuth` middleware
  (new `src/lib/auth.ts`) looks up the session by the cookie token's hash. If found and
  `now - lastSeenAt < 30 days`, the request proceeds, `lastSeenAt` is bumped to `now`, and
  **the cookie is re-issued** (`Set-Cookie` sent again with a fresh 30-day `Max-Age`) so the
  browser's own copy of the expiry actually slides in step with the server-side row, rather
  than the browser dropping the cookie 30 days after the *original* login regardless of
  continued daily use. If the session is missing or expired, the request is treated as
  unauthenticated.
- Logout (`POST /logout`): deletes the matching `sessions` row and clears the cookie.
  Gap found at implementation time (task 20 manual verification): none of tasks 1-19
  actually added a way to *trigger* this from the UI — the endpoint existed but no page
  linked to it, so a logged-in user had no way to log out except manually deleting the
  cookie. Fixed by adding a plain `<form method="post" action="/logout">`/submit-button
  pair to the bottom of `Layout`'s sidebar (`src/views/layout.tsx`) — a real form so the
  browser sends the `Origin` header `csrfCheck` requires, same pattern as the existing
  Mark Watched/Unwatched forms in `src/views/watching-page.tsx`.
- Cookie `Secure` attribute is derived **per request**, not from one global flag: whichever
  `TRUSTED_ORIGINS` entry matches determines the scheme, and the cookie is set `Secure` iff
  that scheme is `https`. Matching uses the `Origin` header when present (reliably true for
  the login `POST`), falling back to the `Host` header otherwise — which is the common case,
  not an edge case: plain top-level GET navigations generally don't carry an `Origin` header
  at all, and since the cookie is now reissued on *every* authenticated request including
  GETs (previous paragraph), the `Host` fallback is exercised on most requests, not just the
  initial login. This relies on the assumption — true for the intended NPM/Cloudflare Tunnel
  topology, and worth keeping true if the deployment shape ever changes — that the reverse
  proxy forwards the original `Host` header unmodified and the app is never reachable by a
  path that bypasses the proxy with an attacker-controlled `Host`.

### Lockout

- `failedLoginAttempts`/`lockedUntil` live directly on `users`, not a separate audit-log
  table — there is exactly one account, so a per-attempt log has no reader.
- The counter is a **raw cumulative count with no time-based decay** — it only resets on a
  successful login or on hitting the threshold (below). A real consequence, accepted as
  fine for a single-user app: two failed attempts today and three unrelated ones next month
  would trigger a lockout on that fifth, otherwise-ordinary attempt. If that ever proves
  annoying in practice, a decay window can be added later; not worth the added complexity
  now.
- On a failed login: if not currently locked (`lockedUntil` is null or in the past),
  increment `failedLoginAttempts`; at 5, set `lockedUntil = now + 15 minutes` and reset
  `failedLoginAttempts` to 0 for the next window. **The lockout check, password
  verification, and counter increment must not be three separate read/write steps** — a
  naive "read `lockedUntil` → `await Bun.password.verify(...)` → write incremented counter"
  sequence has a real await gap in the middle, during which concurrent login attempts (the
  exact scenario lockout exists to defend against) could race and lose increments, delaying
  or bypassing the threshold. Implement the increment as a single atomic SQL statement
  (`failed_login_attempts = failed_login_attempts + 1`, not a JS read-modify-write), and
  re-check `lockedUntil` from a fresh read immediately before that write, not from the value
  read before the password check. This is race-free as long as there is genuinely no
  `await` between that fresh read and the write — `bun:sqlite`/Drizzle calls here are
  synchronous, so nothing else can run in between as written, but this is a fragile
  invariant to preserve under future edits (an accidentally-inserted `await` between the two
  would silently reopen the race); worth a one-line callout on the implementation/review
  checklist rather than assuming it stays true by construction forever.
- On a login attempt while `lockedUntil` is still in the future: reject immediately (before
  even checking the password) with a generic "too many attempts, try again later" message,
  and **do not** extend or reset `lockedUntil`. This is a deliberate correctness fix beyond
  what either the feature file or the batched questions specified: if a lockout-in-progress
  attempt reset the timer, an attacker could keep the real user perpetually locked out by
  sending one bogus request every 14 minutes forever. A fixed expiry that attempts during
  lockout can't touch closes that off.
- On a successful login: reset `failedLoginAttempts` to 0 and clear `lockedUntil`.

### Middleware composition — per-router, not top-level

Confirmed via the feature file's research: every existing route test
(`test/routes/*.test.ts`) calls its Hono sub-router directly (e.g. `queueRoute.request(...)`
in `test/routes/queue.test.ts:117`), bypassing the top-level `app` in `src/index.ts`
entirely. Middleware registered only via `app.use(...)` on that top-level `app` would never
run under the existing test pattern, silently defeating both auth and CSRF coverage. So:

- `src/lib/auth.ts` exports `requireAuth` (session-checking middleware) and `csrfCheck`
  (Hono's built-in `csrf()` from `hono/csrf`, given the parsed `TRUSTED_ORIGINS` list
  directly as its `origin` option — confirmed against the installed `hono@4.12.31` source
  that `origin` accepts a plain `string[]` natively, no custom matcher function needed).
- `categoriesRoute`, `channelsRoute`, `ignoreRulesRoute`, `queueRoute` each add
  `.use("*", csrfCheck, requireAuth)` (in that order — reject a forged request before
  spending a session lookup on it).
- **This `.use(...)` call must be the first statement on each router, before any `.get`/
  `.post`/`.delete` registration in that file — this is a hard requirement, not a style
  preference.** Empirically confirmed against this Hono version: middleware only applies to
  routes registered *after* the `.use()` call in file order; a route registered above it is
  never touched. Every one of the four existing route files currently opens with
  `export const xRoute = new Hono();` immediately followed by route registrations (e.g.
  `queueRoute.get("/", ...)` is the first route in `src/routes/queue.tsx:255`) — appending
  the new `.use(...)` line later in the file, which is the more natural place to add it
  when retrofitting, would silently leave every route on that router completely
  unprotected. The task file for this spec must call this out explicitly as an
  implementation and review-checklist item, not leave it implicit.
- The new `authRoute` adds `.use("*", csrfCheck)` only — **not** `requireAuth`, since
  `/login` must be reachable unauthenticated. `POST /logout` needs no auth guard either: if
  there's no valid session to delete, it's a harmless no-op redirect to `/login`.
- **`src/index.ts` must mount `authRoute` *before* the four gated routers — this is a hard
  requirement, not a stylistic choice, and the opposite of what a first pass at this design
  assumed.** Hono's `app.route(...)` composition is not scoped per-mount the way it might
  look: `.use("*", ...)` middleware registered in an earlier-mounted sub-router leaks
  forward and applies to routes registered afterward via a *later* `app.route(...)` call
  too, not just within its own sub-router. Empirically confirmed: mounting a gated router
  before `authRoute` causes a request to `/login` to be caught by the earlier router's
  `requireAuth`, which redirects to `/login?from=/login` — an infinite redirect loop that
  makes the entire app, including login itself, unusable. Mounting `authRoute` first avoids
  this; the four gated routers' own routes remain correctly protected either way. As a
  harmless side effect of the same forward-leak, the four gated routers will end up
  redundantly re-running each other's `csrfCheck`/`requireAuth` once mounted — wasteful but
  not incorrect, and not worth optimizing away for this app's request volume.
- **Dependency on request body encoding:** Hono's `csrf()` only inspects requests whose
  `Content-Type` matches form/multipart/text-plain (or is absent) — a JSON body bypasses the
  Origin check by design (a cross-origin JSON POST would need a CORS preflight anyway,
  which is a separate protection). This is safe today because every existing mutating route
  reads its body via `c.req.parseBody()` (form-encoded), but it's a real dependency: if any
  future endpoint switches to a JSON body, it silently stops being covered by this CSRF
  check and would need its own protection.

### HTMX-aware redirect on session expiry

The app has 14 existing state-changing endpoints across the four route modules (see the
full list under Scope item 6). Most return an HTML fragment for `hx-swap` on success, but
not all — e.g. `queueRoute.post("/videos/:id/watched-toggle")` already returns a 303
redirect, not a fragment. That inconsistency doesn't actually matter for this design:
`requireAuth` rejects an expired/missing session *before* any handler runs, so what a given
handler would have
returned on success is irrelevant — what matters is that `requireAuth`'s own rejection
response is safe for HTMX to receive in place of *any* handler's response, fragment or
redirect alike.

`requireAuth` checks the `HX-Request` header: if present, it responds with an
`HX-Redirect: /login?from=<original path>` header (HTMX's own mechanism for "do a full
navigation instead of a swap or an in-place error render"), using a **401** status rather
than 200 — `HX-Redirect` is honored by HTMX independent of status code, and 401 correctly
represents what happened (an authentication failure) rather than misrepresenting it as a
successful response, which matters if anything other than HTMX ever inspects this response
in the future. This should be confirmed against real htmx 2.0.4 behavior (the version
pinned in `src/views/layout.tsx`) during manual verification, not just assumed from the
header's documented intent. The 401 response must **not** include a `WWW-Authenticate`
header — some browsers show a native basic-auth credential prompt on a 401 that carries
one, which would appear in front of (or instead of) the `HX-Redirect` navigation. For a
non-HTMX request, `requireAuth` responds with a normal 302 to the same location.

### Login page

A new minimal `src/views/login-page.tsx`, **not** wrapped in the existing `Layout` component
(`src/views/layout.tsx`). `Layout` requires `navCounts`/`categories` props sourced from
authenticated-user queries and renders a full sidebar linking to every gated route — using
it pre-login would mean either querying data for a page with nothing to navigate to yet, or
rendering navigation links that immediately bounce back to `/login`. The login page reuses
the same design tokens (`bg-bg`, `text-text`, `bg-surface`, `border-border`, etc., per
spec011) for visual consistency, just without the sidebar shell.

`GET /login` accepts an optional `from` query param and renders it as a hidden field, so
`POST /login` can read it back and redirect there on success (falling back to `/queue` if
absent or if resolving it would be unsafe — see "Open-redirect guard" below). This `from` is
**not** the same mechanism as the existing `from`/`RETURN_VIEWS` enum lookup in
`src/routes/queue.tsx:205-234` (which resolves one of a fixed set of named views, e.g.
`"queue"`/`"watched"`) — it's a new, distinct mechanism that must accept and validate an
arbitrary same-origin path (e.g. `/watched?category=3`), since a session can expire on any
gated route, not just the three the existing enum covers. They share a query-param name by
convention only; an implementer should not try to wire the login redirect through
`RETURN_VIEWS`. If a request to `GET /login` already carries a valid session, it redirects
straight to `from` (or `/queue`) rather than showing the form again.

**Open-redirect guard.** `from` is only honored if it is a same-origin relative path. The
guard must be the `new URL(from, "http://internal.invalid")`-and-check-`origin` approach —
**not** a string-prefix check like "starts with `/`, second character isn't `\`."
Empirically confirmed during the spec's review that a naive character-based check has a real
gap a `new URL`-based check doesn't: WHATWG URL parsing strips tabs/newlines before
interpreting the rest of the string, so a value like `/\t/evil.com` (a literal tab as the
second character, not a backslash) passes a "second character isn't `\`" check yet still
normalizes to the protocol-relative `//evil.com` in a real browser. Parse `from` via `new
URL(from, "http://internal.invalid")` and only treat it as safe if the result's `origin` is
still exactly `http://internal.invalid` — i.e. `from` never became absolute or
protocol-relative once actually parsed the way a browser would parse it. Falls back to
`/queue` on any rejection.

### Env vars

- `AUTH_RECOVERY_PASSWORD` — if set, hashed via `Bun.password.hash` (bcrypt) and written to
  the default user's `passwordHash` on every startup, with a `console.warn` logged each time
  it's applied (per the feature file's resolved decision — this is what makes it a real
  recovery path rather than bootstrap-only, at the accepted cost that leaving it set
  overwrites any UI-set password on the next restart).
- `TRUSTED_ORIGINS` — comma-separated list of exact `scheme://host[:port]` origins, e.g.
  `TRUSTED_ORIGINS=http://localhost:3000,https://tubeshelf.example.com`. No wildcard/pattern
  matching — each origin is enumerated explicitly, per the feature file's multi-domain
  resolution (NPM/LAN + Cloudflare Tunnel/WAN get one entry each in production; local dev
  defaults to `http://localhost:3000` if unset).
- `.devcontainer/devcontainer.json`'s `containerEnv` sets a fixed dev-only
  `AUTH_RECOVERY_PASSWORD` value (documented inline as insecure-by-design, dev-only) so a
  fresh devcontainer checkout has a working login with no manual step, matching how
  `DB_FILE_NAME` already just works today without setup.

### Password hashing

`Bun.password.hash`/`Bun.password.verify` (bcrypt algorithm) — no new `package.json`
dependency, satisfies `app_idea.md` §5's "Bcrypt + salt" requirement natively.

### Test retrofit

New `test/helpers/auth.ts`:
- Sets `process.env.TRUSTED_ORIGINS` to include a fixed test origin (e.g.
  `http://test.local`) at module load, same pattern as `process.env.DB_FILE_NAME =
  ":memory:"` already used in every route test file (`test/routes/queue.test.ts:7`).
- Exposes a helper that logs in via `authRoute.request("/login", { method: "POST", body,
  headers: { Origin: "http://test.local" } })`, extracts the `Set-Cookie` session value from
  the response, and returns a small object/function that other test files use to attach both
  the session cookie and a matching `Origin` header to their own mutating `.request(...)`
  calls — this works across route modules in the same test process because they all share
  the same module-level `db` singleton (`src/db/client.ts`), the same mechanism that already
  lets `test/routes/queue.test.ts` seed data other tests in the same file query back.
- Every existing mutating call in `test/routes/{categories,channels,ignore-rules,queue}
  .test.ts` gets the session cookie + `Origin` header attached via this helper.
- **Lockout tests must not exercise failures against the shared seeded `"default"` user.**
  Confirmed (by running a throwaway shared-module experiment under `bun test`) that
  `src/db/client.ts`'s module-level `db` is one true singleton across every test file in a
  `bun test` run, not just within a single file — which is exactly what makes the auth
  helper above work (`authRoute.request(...)` in one file, validated by `queueRoute
  .request(...)` in another), but also means there is exactly one `users` row shared
  globally across the entire run. A dedicated lockout test that intentionally fails login 5
  times against `"default"` would leave that account locked for 15 minutes of wall-clock
  time (or however `setSystemTime`, below, is used) for *every other test file* in the same
  run, however unrelated. Lockout tests insert and use their own separate test-only user row
  instead of touching `"default"`, so their failure-count manipulation can never affect any
  other file's ability to log in. **That new test file must call `seed(db)` before inserting
  its own test-only user row, matching every existing route test file's convention** — not
  after. `src/db/seed.ts`'s guard is `if (!anyUser)`, checking whether the `users` table is
  empty at all, not specifically whether `"default"` exists; inserting a dedicated test user
  first would make `seed()` see a non-empty table and silently skip creating `"default"`,
  breaking `getCurrentUser()` — and therefore every other route test file — for the entire
  `bun test` run. A new auth/lockout test file's name is likely to sort early alphabetically
  among `test/routes/*.test.ts`, making this an easy mistake to make by accident; call it out
  on the task-file checklist the same way the middleware-ordering hazard above is.
- New tests: login success/failure, lockout trigger at attempt 5, lockout persisting on a
  6th attempt without extending, lockout clearing after the 15-minute window (via `bun:test`'s
  built-in `setSystemTime`, not the pattern in `test/lib/scheduler.test.ts` — that file takes
  `now` as an explicit function argument rather than mocking the clock, which only helps if
  the lockout code is *also* written to accept an injectable `now`; since lockout is meant to
  be tested black-box through `authRoute.request(...)` HTTP calls, `setSystemTime` is the
  right tool here instead), session validity across the 30-day sliding window and expiry
  past it (including that the cookie is reissued with a fresh `Max-Age` on continued
  activity, per Design), logout actually invalidating the session, CSRF rejection on a
  missing/mismatched `Origin`, a JSON-body request correctly *not* being CSRF-checked (per
  the Content-Type dependency noted in Design — document the behavior, don't treat it as a
  gap), and an unauthenticated `GET` to a gated route redirecting to `/login`.

### Interaction with existing routes

- ~~`GET /` (`queueRoute.get("/", ...)`, added in spec010) redirects to `/queue` regardless
  of auth state; `/queue` itself is gated, so an unauthenticated visit to `/`
  double-redirects (`/` → `/queue` → `/login?from=/queue`) — harmless, no special-casing
  needed.~~ Corrected at implementation time (task 20 manual verification): since
  `requireAuth` is `queueRoute`'s own wildcard middleware (task 12) and `queueRoute` is
  mounted at `/`, it intercepts `GET /` itself before the route's redirect-to-`/queue`
  handler ever runs. The actual unauthenticated chain is a **single** redirect, `/` →
  `/login?from=%2F` (not `%2Fqueue`) — confirmed via `curl -i http://localhost:3000/`.
  Still harmless: after a successful login, `safeRedirectTarget("/")` returns `/` unchanged
  (same-origin relative path), which on the follow-up authenticated `GET /` passes
  `requireAuth` and hits the real handler, landing on `/queue` — one extra hop after login
  instead of before it, same eventual destination.
- No route currently reads `getCurrentUser()` (`src/lib/current-user.ts`) in a way that
  assumes it can never fail — it stays exactly as-is (still resolves the single seeded
  `"default"` user by username), since this spec doesn't add multi-user support. `requireAuth`
  is a separate, new concern layered in front of routes that already call `getCurrentUser()`,
  not a replacement for it.
- Bumping `lastSeenAt` (and reissuing the cookie) on every authenticated request, including
  plain GETs, is a write on every page load. Accepted as a non-issue at this app's scale
  (single user, LAN/personal-tunnel traffic) — worth revisiting only if this ever runs on
  write-sensitive storage (e.g. an SD card) at a much higher request volume than intended.

## Open Questions

None remaining — everything below was resolved directly in the Design section above during
the two red-team passes, rather than left as a forward-pointing question. Two items are
flagged inline in Design for explicit re-verification during implementation rather than
being treated as fully closed by review alone: real htmx `HX-Redirect`-with-401 behavior,
and that the lockout increment truly has zero `await` between its lockout-check and its
write. A third assumption (the `/` → `/queue` → `/login?from=/queue` double-redirect in
Design > Interaction with existing routes) was checked the same way at task 20 and turned
out inaccurate — see the strike-through correction there; the actual single-redirect
behavior is still harmless.

**Red-team retrospective — pass 1** (subagent, no memory of the drafting conversation):
checked every concrete file/line citation against the current source, and empirically
verified two load-bearing claims against the actual installed versions rather than trusting
recall: (1) wrote and ran throwaway Hono middleware/routing test code confirming
`.use("*", ...)` only affects routes registered *after* it in file order within one router —
this surfaced the intra-file middleware-ordering requirement; (2) wrote and ran a throwaway
shared-module experiment under `bun test` confirming the module-level `db` singleton is
shared across *all* test files in one run, not just within a file — this confirmed the
test-retrofit plan's core premise is sound, but also surfaced the lockout/shared-`"default"`
-user test-isolation hazard. The pass also read `hono`'s installed `csrf()` source directly
and found `origin` accepts a plain array (simplifying the original custom-matcher-function
plan) and the check only inspects form/multipart/text-plain bodies (a real, now-documented
dependency). Further findings fixed in Design/Scope: the mutating-endpoint count was wrong
(11 claimed, 14 actual, carried over uncorrected from the feature file); the "all endpoints
return an HTML fragment" premise was false for at least one route and wasn't actually
load-bearing for the design anyway; the Secure-cookie `Host`-header fallback appeared to be
dead code until traced through to the missing "cookie must be reissued on every
authenticated request" design point; the 200-status choice for `HX-Redirect` rested on a
likely-wrong assumption about htmx behavior (changed to 401); the lockout increment had an
unaddressed race window; the open-redirect guard's original "starts with `/`, not `//`"
check missed the backslash bypass; the "reuses the existing `from`/smart-return pattern"
framing mischaracterized an enum-based mechanism as one that validates arbitrary paths; and
the `test/lib/scheduler.test.ts` time-mocking citation was wrong (corrected to `bun:test`'s
`setSystemTime`).

**Red-team retrospective — pass 2** (a second, narrower subagent pass, per the stopping
rule's guidance that a substantive first pass warrants a second — scoped specifically to
verifying pass 1's own fixes rather than re-reviewing the whole spec): found that pass 1's
fix itself had a bug. The claim "`src/index.ts` mounts `authRoute` alongside the existing
four, order doesn't matter" was empirically demonstrated false — mounting a gated router
before `authRoute` causes `.use("*", requireAuth)` to leak forward across `app.route(...)`
calls and catch `/login` itself, producing an infinite `/login?from=/login` redirect loop
that breaks the entire app. Corrected to mandate `authRoute` must mount first. Pass 2 also
confirmed the lockout race is real (not theoretical — empirically verified
`Bun.password.verify` genuinely yields the event loop during its `await`, so concurrent
requests really can interleave there) and that the fix is appropriately scoped, not
overengineered; confirmed 401 status doesn't conflict with htmx's `HX-Redirect` handling but
surfaced an unstated `WWW-Authenticate`-header caveat (now added); found that offering the
open-redirect guard as "either a backslash check or a `new URL` check" was itself a bug,
since the backslash-only variant has a demonstrated tab/newline bypass gap the `new URL`
check doesn't — now mandated as the only approach; and found the test-retrofit fix omitted
an explicit seed-before-insert ordering requirement whose violation (easy to hit by
accident, given a new test file's likely alphabetical position) would silently break
`getCurrentUser()` for the entire test suite — now stated explicitly.

A third pass was not run: every pass-2 finding was concrete, directly actionable, and fixed
with narrow, mechanical corrections rather than a change to the overall design shape —
re-verified directly (not by spawning a further agent) against the same empirically-
confirmed Hono/Bun/htmx behavior pass 2 already established, which is the kind of narrower,
cheaper substitute check the stopping rule allows in place of a further full pass.
