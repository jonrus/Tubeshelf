---
status: implemented
created: 2026-10-03
---

# Auth & Security Hardening

## Context

Round A (last) of a three-spec hardening sequence from a full-codebase review on
2026-10-03; rounds B (spec030) and C (spec031) are merged. Scope was settled in
`docs/features/014-auth-security-hardening.md` (promoted to this spec); finding IDs
(`#1`, `#6`, …) are the review's, kept so they stay traceable. The app may be exposed to the
internet (NPM / Cloudflare Tunnel — `docs/app_idea.md` §5, "Baseline hardening"), but today:
auth middleware runs redundantly 4x per request, no CSP or other security headers are sent,
idle-expired sessions are never purged and survive a recovery-password reset, the cookie
`Secure` flag depends on the proxy-rewritable `Host` header, and the lockout response is
indistinguishable from a wrong password. This round has the widest footprint (middleware, every
route file, every view with inline script, Dockerfile), hence last.

## Scope

**In:** #1 run csrf + auth once per request; #6 use the session's user instead of the
hardcoded `"admin"` row; #10 strict CSP + security headers (inline scripts/handlers moved to
static files); #11 distinct lockout message; #12 session purge; #14 cookie `Secure` from
config; #15 `noopener`; and (stretch, included because the same lines are touched by #14) one
shared session-cookie helper.

**Out:** #13 stricter CSRF (dropped by the user); per-IP login throttling / attempt tracking
for nonexistent usernames; HSTS, CSP report-only phase, CSP nonces; multi-user support /
user-management UI; a central `createApp()` / moving auth out of the routers; the review's
"explicitly dropped" list (#18 handle scraping, `/ignored` sort key, bare fragment on direct
`?cursor` GET, `watchedCount` incl. unsubscribed, `parseChannelInput` unanchored match);
anything spec031 already did (login form `autocomplete`/`required`, generated first-boot admin
password, logger `[object Object]`, no auto-timer for `ignored` on `/watching/:id`).

**Migration: none.** No schema change in any item.

## Design

### #1 — csrf + auth exactly once per request

Each route file does `xRoute.use("*", csrfCheck, requireAuth)`, and `app.route("/", xRoute)`
makes that wildcard apply to every route registered *after* it, so `requireAuth` runs up to
4x on an authenticated request (4 session SELECTs, 4 `UPDATE sessions.last_seen_at`, 4
Set-Cookie headers; confirmed by probe).

**Fix: keep the per-router `use("*", csrfCheck, requireAuth)` and make both middlewares
idempotent per request.** Why: all six `test/routes/*.test.ts` files mount one router
standalone and rely on its own guard; a central `createApp()` would churn every one of them
and `loginAsAdminUser`, while a no-op repeat is cheap.

- `requireAuth`: at the top, `if (c.get("userId") !== undefined) return next();`. (`userId`
  is currently declared non-optional in `ContextVariableMap`; either make it optional
  (`userId?: number`) and have routes narrow it — see #6 — or keep it required and compare
  against `undefined` anyway. Settled at implementation; whichever is chosen must keep
  `tsc --noEmit` clean under `noUncheckedIndexedAccess`.) **Resolved (task 2): kept `userId: number`
  required and compared against `undefined`; `tsc --noEmit` clean.**)
- `csrfCheck`: today an alias for Hono's `csrf({ origin: getTrustedOrigins() })`, which
  snapshots `TRUSTED_ORIGINS` at module load. **Make that lazy** —
  `csrf({ origin: (o) => getTrustedOrigins().includes(o) })` (Hono accepts an origin function) —
  because #12 makes `scheduler.ts` import `auth.ts`, and `bun test` shares one module registry
  across files: `test/lib/scheduler.test.ts` (which doesn't set `TRUSTED_ORIGINS`) would
  otherwise freeze the default `http://localhost:3000` and every later `test/routes/*` request
  with `Origin: http://test.local` would 403. This also removes the "set env before import"
  pitfall below and makes the comment in `test/helpers/auth.ts` accurate. Then:
  the lazy instance becomes a private
  `csrfInner` and `csrfCheck` is exported `csrfCheck` as a wrapper: if `c.get("csrfChecked")` (new
  `ContextVariableMap` boolean) is set, `return next()`; otherwise run `csrfInner(c, …)` with a
  `next` callback that sets `csrfChecked = true` *before* calling the real `next()`, so the flag
  is only ever set after the check passed (a rejected request never reaches it).
- `authRoute` keeps `use("*", csrfCheck)` only (login must stay public); it is registered
  first, so its csrf check is the one that runs and the later routers' repeats no-op.
- Public routes stay public: `/login`, `/logout`, `/healthz`, static assets.

**Test:** an authenticated GET returns exactly one `Set-Cookie` (assert on the full app
mount, not a single router, so the repeat is actually exercised — see Testing); plus a
unit-ish test that a second `requireAuth`/`csrfCheck` invocation on the same context performs
no further session SELECT/UPDATE (e.g. `last_seen_at` bumped once).

### #6 — use the session's user, not `getCurrentUser()`

`getCurrentUser()` (`src/lib/current-user.ts`) looks up `username = "admin"` and is called at
20 sites (`queue.tsx` ×10, `categories.tsx` ×5, `channels.tsx` ×4, `ignore-rules.tsx` ×1),
ignoring the `userId` that `requireAuth` already put on the context. Replace each with
`c.get("userId")`; lib functions already take a user id. Where a helper takes the whole user row
(`updateOwnedSubscription(c, user, id, …)` in `channels.tsx`), change it to take the id —
verify at implementation that no call site reads another `user` field. Delete
`src/lib/current-user.ts` and its per-handler SELECT.

This **supersedes spec024's deferral** ("intentional MVP scope per `docs/app_idea.md:128`").
That deferral reasoned wiring it through "would just be dead code" until multi-user; the
counter-argument here is that the hardcoded lookup is a latent authz footgun (any future second
user would silently act as `admin`) and costs a SELECT per handler. The data model itself is
unchanged (single implicit user for MVP) — this only wires the *session* user through, no
user-management UI. Inline pointers added to spec024's "Out" bullet and to
`docs/app_idea.md`'s single-implicit-user line (§4 "User").

Because `requireAuth` is idempotent (#1) and runs before every handler on these routers, the
`userId` is always set when a handler runs; handlers read it without a fallback.

### #10 — strict Content-Security-Policy + security headers

**Move inline scripts to static files** (served by the existing public
`app.use("/js/*", serveStatic({ root: "./public" }))`, which moves into `buildApp()`, so no auth needed):

- `public/js/app.js` — loaded by `Layout`'s head as `<script src="/js/app.js" defer>`
  (alongside the existing htmx tag). Contains: the watch-link `click`/`auxclick` handler
  (`WATCH_LINK_CLICK_SCRIPT`, with #15's `noopener`), the sidebar toggle
  (`SIDEBAR_TOGGLE_SCRIPT`), the thumbnail-error handler, and the disable-on-submit handler.
  `defer` guarantees the sidebar elements exist when it runs; still null-guard
  `#sidebar-toggle`/`#sidebar-backdrop` so a missing element can't throw at load and kill the
  other handlers in the file. A browser-cached stale `app.js` against new HTML is accepted (a
  single-user app; a hard refresh fixes it) — no `?v=` cache-busting. `LoginPage` is a standalone
  document (not `Layout`), has no scripts, and is unchanged.
- `public/js/pageshow-reload.js` — the `pageshow`/`event.persisted` reload from
  `watching-page.tsx`, loaded **only** on the watching page via `<script src defer>` as its
  own file.
- Delete the `WATCH_LINK_CLICK_SCRIPT`/`SIDEBAR_TOGGLE_SCRIPT` constants and both
  `dangerouslySetInnerHTML` script tags in `layout.tsx`, and the one in `watching-page.tsx`.

**Remove inline event-handler attributes**, replaced by delegated listeners in `app.js`:

- `onerror="this.style.visibility='hidden'"` on thumbnails (`queue-list.tsx:164`,
  `watching-page.tsx:85`) → a **capture-phase** `error` listener on `document` (`error` doesn't
  bubble) that hides `<img>` targets via `img.style.visibility = "hidden"`. Setting a property
  through the CSSOM is permitted by `style-src 'self'` (only `style` *attributes* in markup and
  `setAttribute("style", …)` are blocked), so no Tailwind class is needed — and a class
  wouldn't help anyway, since Tailwind only scans `src/`, not `public/js`. Because the script
  is deferred, also run a one-time pass at load for images that already errored
  (`img.complete && img.naturalWidth === 0`). Images HTMX swaps in later (endless scroll
  `revealed` → `outerHTML`) are covered by the document-level capture listener with no extra
  hook. (A lazy offscreen `<img>` that hasn't started loading reports `complete === false`, so
  the load-time pass won't wrongly hide it.)
- `onsubmit="this.querySelector('button').disabled = true"` (`watching-page.tsx:119`) →
  `data-disable-on-submit` attribute on the form + a delegated `submit` listener that disables
  the form's first `<button>` (same behavior as today). The `pageshow` reload (above) already
  un-sticks the disabled button on back-navigation.

**Headers** via `hono/secure-headers` (in the installed hono 4.12.31), registered as the
**first** `app.use("*", …)` in `buildApp()` (`src/app.ts`, see Testing) — before the static
handlers and routes — so
static files, `/healthz`, `/login`, 401/302 responses and `app.onError`'s 500 all carry them
(errors are the easy ones to miss, so tested explicitly):

- `Content-Security-Policy`: `default-src 'self'; img-src 'self' https://i.ytimg.com;
  script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none';
  base-uri 'none'; form-action 'self'`, passed as hono's `contentSecurityPolicy` directive
  object. Hono's `contentSecurityPolicy` takes camelCase keys (`defaultSrc`, `imgSrc`, `scriptSrc`,
  `styleSrc`, `objectSrc`, `frameAncestors`, `baseUri`, `formAction`), values as arrays with their
  own quotes. `i.ytimg.com` is the only external origin (`src/lib/youtube.ts`
  `youtubeThumbnailUrl`). XHR from htmx falls under `default-src 'self'` (same-origin).
  **Enforcing from the start** (no report-only phase — single-user app, any breakage is caught
  by the manual verification pass before merge).
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` (**not** hono's `no-referrer` default: under
  `no-referrer`, browsers serialize `Origin` as `null` on same-origin non-CORS form POSTs —
  login, logout, "Mark Watched & Return" — which would break `csrfCheck` in browsers without
  `Sec-Fetch-Site` and make `resolveCookieSecure`'s `Origin` match (#14) fail; `same-origin`
  keeps `Origin` on same-origin posts and still sends no referrer to YouTube/ytimg),
  `X-Frame-Options: DENY` (hono defaults to `SAMEORIGIN`; `frame-ancestors 'none'` already
  says none, so match it for old browsers).
- **HSTS explicitly off: `strictTransportSecurity: false`.** *Correction to the feature file,
  which said "no HSTS" without noting the default:* hono's `secureHeaders()` turns
  `Strict-Transport-Security` **on** by default (`max-age=15552000; includeSubDomains`), so
  simply calling it would silently violate the decision. HSTS is the reverse proxy's job; the
  app can't reliably know it's behind TLS, and sending it on a plain-http LAN deployment is
  harmless but wrong. A test asserts the header is absent.
- Hono's other defaults (`Cross-Origin-Resource-Policy: same-origin`,
  `Cross-Origin-Opener-Policy: same-origin`, `Origin-Agent-Cluster`, `X-Download-Options`,
  `X-DNS-Prefetch-Control`, `X-Permitted-Cross-Domain-Policies`, `X-XSS-Protection: 0`) are
  left at their defaults: they only constrain how *other* origins use this app's responses,
  and `window.open(…, "noopener")` to YouTube is unaffected by COOP on our own pages.

**htmx under the CSP:** htmx 2.0.10 injects an inline `<style>` for `.htmx-indicator` unless
`includeIndicatorStyles` is `false`; nothing in `src/views` uses `hx-indicator` or inline
`style=` (grep-verified). Add
`<meta name="htmx-config" content='{"includeIndicatorStyles":false,"allowEval":false}'>` to
`Layout`'s `<head>` (before the htmx script) so `style-src 'self'` needs no `'unsafe-inline'`
and `script-src 'self'` no `'unsafe-eval'`. Views use only `hx-get/post/delete`, `hx-trigger`
(`revealed`, `load delay:10s`), `hx-target`, `hx-swap`, `hx-select`, `hx-disabled-elt`,
`hx-confirm` (native `confirm()`) — none need eval or inline styles. Tailwind output has no
`url(`/`@font-face`/`@import`; icons and manifest are same-origin.

**Lint/fallow for the new JS:** `public/js/app.js` and `pageshow-reload.js` become the first
tracked JS under `public/` — they must pass `biome check .` (only `public/css` is excluded;
formatting + recommended rules apply). Nothing imports them, so if `bun run fallow` flags them
as unused files, add `public/js/**` to `.fallowrc.json`'s `ignorePatterns` (tsconfig has
`allowJs` without `checkJs`, so no type errors).

**Dockerfile / `.gitignore`:** the final stage COPYs an explicit allowlist, so add
`COPY public/js/app.js ./public/js/app.js` and
`COPY public/js/pageshow-reload.js ./public/js/pageshow-reload.js` (a missed COPY would 404
the scripts in the image; the `docker-build-check` job only builds, so it would *not* catch
that — the manual image smoke check below does). *Correction
to the feature file:* `.gitignore` needs **no change** — it ignores only the exact path
`public/js/htmx.min.js` (not `public/js/`), so the new files are already trackable.

**Tests:**
- Header assertions on the full app (see Testing): `/login`, an authenticated page, `/healthz`,
  a static file (`/js/app.js`), and a 500 produced by `app.onError` each carry the CSP string,
  `nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`, and carry **no**
  `Strict-Transport-Security`.
- A static no-inline guard: fetched HTML for `/login`, `/queue` (with at least one video card),
  `/watching/:id`, `/channels`, `/categories`, `/ignore-rules`, and an HTMX partial
  (`QueueListMore`) contains no `<script>` without a `src`, no `<style` element, no
  `on[a-z]+=` attribute, and no `style=` attribute. Guards against a future inline handler that
  would silently break under the CSP only in a browser.

### #11 — distinct lockout message

Keep the 5-attempt / 15-minute per-username lockout (`attemptLogin`, `src/lib/auth.ts`)
unchanged. `attemptLogin`'s failure shape becomes
`{ ok: false; reason: "invalid" | "locked" }`: `"locked"` on both existing locked paths (the
up-front `lockedUntil > now` check — which also covers a *correct* password while locked — and
the post-verify `fresh` re-check for a concurrent lock); `"invalid"` for unknown usernames and
wrong passwords. `POST /login` renders "Too many attempts, try again later." for `"locked"`,
still **401** (existing tests assert 401); the generic message is unchanged otherwise. The
5th wrong attempt (the one that trips the lock) still gets the generic message; the *next*
attempt gets the lockout message — simplest, and avoids a re-read purely to special-case it.

Accepted tradeoff: this reveals that a locked username exists (single-user app with a known
default `admin`; usability wins over spec024's enumeration-hardening for this one case).
No per-IP throttle, no tracking of attempts for nonexistent users (no new state).
Timing: the locked paths already return without a bcrypt verify today; that's unchanged and
is itself the disclosed case.

### #12 — purge sessions

- **Idle purge.** New `purgeIdleSessions(now = new Date())` in `src/lib/auth.ts`:
  `DELETE FROM sessions WHERE last_seen_at < now - SESSION_IDLE_TIMEOUT_MS` (same cutoff
  `findValidSession` uses; keep one constant). Run it **on startup**, and **at most once per
  hour from the scheduler tick** (not every 60 s tick): a module-level `lastSessionPurgeAt` in
  `scheduler.ts` initialised at module load (the startup call just ran), checked against an
  injectable `now` so it's unit-testable without timers. It runs in its own try/catch inside
  `tick()` (like the enrichment sweep) so a purge failure never masks or is logged as an
  ingestion failure.
- **Recovery purge.** `applyRecoveryPasswordFromEnv` deletes **all** sessions when it
  actually changes the password — i.e. only when the stored hash is null or does **not**
  verify against the env value. If it already verifies (restart with the var still set), skip
  the re-hash/write *and* the purge, so a restart doesn't log everyone out every boot, and the
  stored hash isn't pointlessly re-salted. Hash first (async), then the password update + session delete run in one *synchronous*
  `db.transaction` (bun-sqlite transaction callbacks can't be async). The existing warning stays and is logged on both paths (wording adjusted
  on the unchanged path: still set, unset it). spec012's accepted "leaving it set overwrites
  any UI-set password on next restart" is otherwise unchanged — a different password in the
  env still wins on the next boot (and now also logs out existing sessions, which is the
  point).
- **Ordering in `src/index.ts`:** `applyRecoveryPasswordFromEnv()` → `purgeIdleSessions()` →
  `ensureAdminPassword()` (the first-boot generated-password path has no sessions to purge).

### #14 — cookie `Secure` from config

Replace `resolveCookieSecure`'s `Host`-header-match fallback with a **fail-secure default**:
the cookie is `Secure` iff any `TRUSTED_ORIGINS` entry is `https://`, **except** when the
request positively matches an `http://` entry (the `Origin` header when present — an exact
match against an entry — otherwise the `Host` header against each entry's host). Cases:

| `TRUSTED_ORIGINS` | request | `Secure`? |
|---|---|---|
| no https entry (incl. default `http://localhost:3000`) | any | no |
| `https://t.example.com` only | any (even a rewritten `Host`) | yes |
| `http://localhost:3000,https://t.example.com` | `Origin`/`Host` = localhost:3000 | no (http entry matched) |
| same mixed list | `Host` = anything else / no match | yes (fail-secure) |

This fixes the Host-rewriting-proxy case on GETs (which carry no `Origin`) while keeping
plain-http localhost working with a mixed list. **No `X-Forwarded-*` trust** (spec012 §
"Cookie `Secure`" deliberately avoided proxy-supplied headers). Amends spec012's per-request
Host-fallback design (inline pointer there). Update `.env.example` and README
`TRUSTED_ORIGINS` text to describe the new rule, including the mixed-list behavior and the
fact that an https entry makes `Secure` the default.

**Caveat, documented in README/`.env.example`:** `requireAuth` re-issues the cookie on every
authenticated request, so with a *mixed* list behind a proxy that rewrites `Host` to a value
matching an `http://` entry (e.g. a Cloudflare Tunnel overriding the origin Host to
`localhost:3000`), GETs would re-set the cookie without `Secure`. A mixed list is therefore
supported only for local development; production behind a proxy should list only `https://`
origins (then `Secure` is unconditional). Likewise, any https entry makes the cookie `Secure` for
plain-http access at a non-listed host (LAN IP, `127.0.0.1`) and browsers will drop it —
fail-secure by design; note it in the README.

**Cookie helper (stretch, included):** one `setSessionCookie(c, token)` in `src/lib/auth.ts`
owning `httpOnly`, `sameSite: "Lax"`, `secure: resolveCookieSecure(c)`, `path: "/"`, and a
single `SESSION_MAX_AGE_SECONDS`; used by `requireAuth` and `POST /login`, removing the
duplicate constant and the two copies of the options in `routes/auth.tsx`/`auth.ts`.

### #15 — `noopener`

`window.open(url, "_blank", "noopener")` in the watch-link handler, done as part of moving it
to `app.js`. Note `noopener` makes `window.open` return `null`; the existing handler ignores
the return value, so no change needed there.

## Testing

- New/extended tests need the **full app** (to exercise real router stacking, not a single
  router). `src/index.ts` runs migrations/`Bun.serve` at import, so it can't be imported by a
  test; extract app construction into a module with no *startup* side effects (it still opens the
  SQLite file via `db/client` on import, as `index.ts` does today — so tests set
  `DB_FILE_NAME=":memory:"` before a dynamic import, then `migrate(db, …)` and `seed` before
  requesting, as `test/routes/queue.test.ts` does) (e.g. `src/app.ts`
  exporting `buildApp()` — a pure factory building the `Hono` instance with `onError`,
  secure-headers, static handlers, and `app.route(...)` calls) that `src/index.ts` imports. `index.ts` keeps `runMigrations`/`seed`/recovery/
  `purgeIdleSessions`/`ensureAdminPassword`, `startScheduler`, `Bun.serve` and the signal
  handlers; `buildApp()` owns `onError`, `secureHeaders`, the static handlers and the routes
  *This is not the "central `createApp()` moving auth out of routers" rejected above (hence the
  deliberately different name `buildApp`)* —
  routers stay self-protecting; the factory only makes the existing wiring importable and is
  what lets the single-`Set-Cookie`, header, and no-inline tests run against the real
  middleware order. Existing single-router tests are untouched. Pitfalls for the full-app tests: import
  `test/helpers/auth.ts` (sets `TRUSTED_ORIGINS`) before making requests; the forced-500 test registers a throwing route on the returned app (a GET — it sits
  behind the auth wildcard, so send the logged-in cookie from `loginAsAdminUser`); run from the repo root (`serveStatic`'s
  `root` is cwd-relative); hono joins CSP directives with `"; "`, so exact-string assertions
  must match that. Directive values need their own quotes (`"'self'"`).
- `test/lib/auth.test.ts`: `attemptLogin` reasons; `purgeIdleSessions` (deletes only idle ones);
  recovery purge deletes all sessions iff the hash changed (and not when it already verifies);
  `resolveCookieSecure` table above; cookie helper. `applyRecoveryPasswordFromEnv` purges only
  when the admin row exists and was actually updated (use `.returning()` as `ensureAdminPassword`
  does; covers null hash + env set, and a missing admin row = no purge).
- `test/lib/scheduler.test.ts`: hourly purge throttle. `tick()`/`runGuardedTick()` take no
  arguments, so export a small helper (`maybePurgeSessions(now)`, owning `lastSessionPurgeAt`)
  that `tick()` calls; the test calls it directly (once within an hour, again after).
- `test/routes/auth.test.ts`: locked account → 401 with the lockout message (assert the HTML at
  both the post-lock attempt and the correct-password-while-locked attempt); unknown user /
  wrong password → generic message.
- Route tests: `getCurrentUser` removal covered by existing route tests passing unchanged
  (they log in as `admin`); add one asserting a session belonging to a *non-admin* user row sees
  that user's data, not `admin`'s.

## Manual verification (in the task file, split per CLAUDE.md)

- **Claude, via `curl` inside the devcontainer:** response headers on `/login`, an authed page,
  `/healthz`, `/js/app.js`, and a forced 500; exactly one `Set-Cookie` on an authed GET; locked
  login message after 5 bad attempts; session purge via direct SQLite (insert a stale
  `last_seen_at` row, restart, row gone; recovery password change deletes all rows, restart with
  same value leaves them).
- **User, in a browser:** login and a plain form POST (logout, "Mark Watched & Return") work with
  the CSP/`Referrer-Policy` enabled; watch-link opens in a new tab and middle-click works; sidebar toggle
  at mobile width; a broken thumbnail is hidden (incl. after endless-scroll load); endless
  scroll still loads; `hx-confirm` delete still prompts; "Mark Watched & Return" disables its
  button; back-navigation to the watching page reloads; **DevTools console shows no CSP
  violations on every page**; docker image built from the Dockerfile serves `/js/app.js` (200).

## Open Questions

None.

**Red-team retrospective (pass 1, independent subagent):** confirmed the idempotent
csrf/auth design, hono `secure-headers` behavior (incl. HSTS default-on, headers on
`onError`), htmx indicator-style handling, and the Dockerfile/.gitignore facts. Caught and
fixed in this spec: `Referrer-Policy: no-referrer` would send `Origin: null` on form POSTs
(→ `same-origin`); the mixed-`TRUSTED_ORIGINS` + Host-rewriting-proxy cookie downgrade
(documented as dev-only); wrong `getCurrentUser` call-site counts (20, not ~24); scheduler
purge needing an exported helper; missing existence guard on the recovery purge; full-app
test pitfalls; missing `hx-select`/`hx-disabled-elt` in the htmx list; `app.js` null-guards.


**Pass 2 (narrow, independent subagent; covered the `buildApp` extraction and pass-1 edits):**
caught a real bug — `csrfCheck` snapshots `TRUSTED_ORIGINS` at import and #12 makes
`scheduler.ts` import `auth.ts`, so `scheduler.test.ts` would poison the shared module registry
and 403 every later route test (fixed: lazy origin function). Also fixed: stale `src/index.ts`
references after the `buildApp` move; `buildApp` isn't fully import-side-effect-free (opens the
DB); sync-transaction note; camelCase CSP keys; biome/fallow handling for the new tracked JS;
README note for the https-entry + plain-http-host case. Confirmed: hono `referrerPolicy`/
`xFrameOptions`/`strictTransportSecurity` option forms, cookie table vs. code, no conflict with
existing auth tests. A third pass wasn't run: pass 2's one real bug was in a pre-existing
import-time pattern the new code touches, and its fix is small and local.
