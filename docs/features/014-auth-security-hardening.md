---
status: refined
created: 2026-10-03
---

# Auth & Security Hardening

## Problem / Motivation

Round A (last) of a three-spec hardening sequence from a full-codebase review on
2026-10-03. Rounds B (spec030, ingestion/enrichment robustness) and C (spec031, behavior
correctness / ops polish) are merged; this round has the widest footprint (middleware
wiring, every route file, every view with inline script, Dockerfile) so it goes last.
Numbers like `#1`/`#6` below are the review's finding IDs, kept so they stay traceable.

The app may be exposed to the internet (NPM / Cloudflare Tunnel), but today: auth
middleware runs redundantly 4x per request, no CSP or other security headers are sent,
idle-expired sessions are never purged and survive a recovery-password reset, the cookie
`Secure` flag depends on the (proxy-rewritable) `Host` header, and the lockout response is
indistinguishable from a wrong password.

## Firm Scope

- **#1 Run csrf + auth exactly once per request.** Each route file does
  `xRoute.use("*", csrfCheck, requireAuth)`, and `app.route("/", xRoute)` makes that
  wildcard apply to every route registered *after* it, so `requireAuth` runs 4x on an
  authenticated request (4 session SELECTs, 4 `UPDATE sessions.last_seen_at`, 4 Set-Cookie
  headers; confirmed by probe). Fix: keep the per-router `use("*", csrfCheck, requireAuth)`
  (routers stay self-protecting, so all six `test/routes/*.test.ts` that mount one router
  standalone keep exercising auth with no churn) but make both middlewares **idempotent per
  request** — a repeat invocation sees the work was already done (e.g. `c.get("userId")`
  set / a context flag for csrf) and just calls `next()`. Result: 1 session SELECT, 1
  `last_seen_at` UPDATE, 1 Set-Cookie. Public routes stay public (`/login`, `/logout`,
  `/healthz`, static). Add a test asserting the single-execution (e.g. exactly one
  `Set-Cookie` on an authenticated GET).
- **#6 Use the session's user, not the hardcoded `"admin"` row.** Replace
  `getCurrentUser()` (`src/lib/current-user.ts`, looks up `username = "admin"`) with the
  `userId` `requireAuth` already puts on the context (`c.get("userId")`) at all ~20 call
  sites across `queue.tsx`, `categories.tsx`, `channels.tsx`, `ignore-rules.tsx`; delete
  `getCurrentUser()` and its per-handler SELECT. Lib functions already take `user.id`.
  Supersedes spec024's deferral — add a short pointer in spec024's "Out" bullet (and
  `docs/app_idea.md:128` if appropriate) per CLAUDE.md's inline-pointer convention.
- **#10 Strict Content-Security-Policy + security headers.**
  - Move every inline script into static files under `public/js/`, loaded via
    `<script src>` (use `defer` so DOM exists): `layout.tsx` `WATCH_LINK_CLICK_SCRIPT` and
    `SIDEBAR_TOGGLE_SCRIPT`, and `watching-page.tsx`'s `pageshow` reload script (the
    `pageshow` script loads only on the watching page, as its own small file — not
    globally).
  - Remove inline event-handler attributes, replaced by delegated listeners in the static
    JS: `onerror="this.style.visibility='hidden'"` on thumbnails (`queue-list.tsx:164`,
    `watching-page.tsx:85`) → capture-phase `error` listener on `document` (`error`
    doesn't bubble), **plus** a pass for images that already errored before the deferred
    script ran (`img.complete && img.naturalWidth === 0`) and for images HTMX swaps in
    (endless scroll `revealed` → `outerHTML` swap; capture listener on `document` covers
    these). `onsubmit="this.querySelector('button').disabled = true"`
    (`watching-page.tsx:119`) → `data-disable-on-submit` attribute + delegated `submit`
    listener.
  - Headers via `hono/secure-headers` (already in the installed hono), applied as the
    first `app.use("*")` in `src/index.ts` so static, `/healthz`, `/login`, 401/redirects
    and `app.onError` responses all carry them (test this explicitly — errors are the
    easy ones to miss): `Content-Security-Policy` (`default-src 'self'; img-src 'self'
    https://i.ytimg.com; script-src 'self'; style-src 'self'; frame-ancestors 'none';
    base-uri 'none'; form-action 'self'` — exact string settled in the spec),
    `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options`. **Enforcing
    from the start** (no report-only phase). **No HSTS** (reverse proxy's job; the app
    can't reliably know it's behind TLS).
  - htmx under the CSP: htmx 2.x (installed) injects an inline `<style>` for
    `.htmx-indicator` unless `includeIndicatorStyles` is `false`, and nothing in
    `src/views` uses `hx-indicator` or inline `style=`. Add
    `<meta name="htmx-config" content='{"includeIndicatorStyles":false,"allowEval":false}'>`
    to `Layout`'s head so `style-src 'self'` needs no `'unsafe-inline'`. Views use only
    `hx-get/post/delete`, `hx-trigger` (`revealed`, `load delay:10s`), `hx-target`,
    `hx-swap`, `hx-confirm` (native `confirm()`) — none need eval.
  - `Dockerfile` final stage COPYs an explicit allowlist (`public/icons`,
    `public/manifest.json`, built css, `htmx.min.js`) — add the new tracked
    `public/js/*.js` files. `public/js/htmx.min.js` is gitignored (postinstall copy) while
    the new files must be tracked: adjust `.gitignore` so only `htmx.min.js` stays
    ignored. The `docker-build-check` CI job builds the image, so a missed COPY breaks CI.
  - **Tests:** header assertions (`/login`, an authed page, `/healthz`, a static file, a
    500 from `onError`); a static test that rendered views contain no inline `<script>`
    bodies and no `on*=` attributes (guards against regressions under the strict CSP).
- **#11 Distinct lockout message.** Keep the 5-attempt / 15-minute per-username lockout
  (`attemptLogin`, `src/lib/auth.ts`) unchanged; `attemptLogin` returns a reason so
  `POST /login` can show "Too many attempts, try again later." for a **real, currently
  locked** account, still `401` (existing tests assert 401). Unknown usernames and wrong
  passwords keep the generic message. Accepted tradeoff: this reveals that a locked
  username exists (single-user app with a known default `admin`; usability wins over
  spec024's enumeration-hardening for this one case). No per-IP throttle, no tracking of
  attempts for nonexistent users.
- **#12 Purge sessions.**
  - Delete idle-expired sessions (`last_seen_at` older than `SESSION_IDLE_TIMEOUT_MS`) on
    startup and then at most once per hour from the scheduler tick (not every 60 s tick).
  - Delete **all** sessions when `applyRecoveryPasswordFromEnv` applies the recovery
    password — but only when the stored hash doesn't already verify against the env
    value, so a restart with the var still set doesn't log everyone out every boot
    (spec012's accepted "re-applies every boot" behavior is otherwise unchanged; the
    existing warning log stays). Ordering in `src/index.ts`: recovery apply → session
    purge, before `ensureAdminPassword`.
- **#14 Cookie `Secure` from config.** Replace `resolveCookieSecure`'s `Host`-header-match
  fallback with a **fail-secure default**: the cookie is `Secure` iff any `TRUSTED_ORIGINS`
  entry is `https://`, *except* when the request positively matches an `http://` entry
  (the `Origin` header when present, otherwise the `Host`) — so plain-http localhost still
  works with a mixed list (`http://localhost:3000,https://tubeshelf.example.com`), and a
  proxy-rewritten `Host` that matches nothing falls to `Secure`. No `X-Forwarded-*` trust
  (spec012:143-146 deliberately avoided proxy-supplied headers). A list with no https
  entry never yields `Secure`. Amends spec012's per-request design (inline pointer there);
  update `.env.example`/README `TRUSTED_ORIGINS` text to describe the new rule.
- **#15 `noopener`** on `window.open` in the watch-link handler, done as part of moving
  that script to a static file (use `"noopener"` windowFeatures).

## Nice-to-have / Stretch Scope

- Dedupe the three copies of the session cookie options (`requireAuth`, `POST /login`) and
  the duplicate `SESSION_MAX_AGE_SECONDS` constant in `routes/auth.tsx` into one helper in
  `src/lib/auth.ts` while touching #14.

## Explicitly Out of Scope

- **#13 stricter CSRF** (POST with no `Content-Type` bypasses Hono's `csrf()`;
  `SameSite=Lax` is the only guard) — dropped by the user.
- Per-IP login throttling; attempt tracking for nonexistent usernames.
- HSTS, CSP report-only phase, CSP nonces.
- Multi-user support / user-management UI (#6 only wires the *session* user through).
- Central `createApp()` / moving auth out of the routers (rejected for #1: test churn).
- The review's "explicitly dropped" list (#18 handle scraping, `/ignored` sort key, bare
  fragment on direct GET with `?cursor`, `watchedCount` incl. unsubscribed,
  `parseChannelInput` unanchored match).
- Already done by earlier rounds — do **not** redo: login form `autocomplete`/`required`,
  generated first-boot admin password (#19), logger `[object Object]` (#20), and the
  no-auto-timer for `ignored` videos on `/watching/:id` (#9) — all spec031.

## Related Specs / Code

- `docs/specs/012-auth-and-csrf.md` — sessions, lockout, recovery password, CSRF
  allowlist, per-request cookie `Secure` (the design #11/#12/#14 amend; lines ~136-146).
- `docs/specs/024-security-review-hardening.md` — deferred #6 as "intentional MVP scope
  per `docs/app_idea.md:128`"; lockout timing normalization (relevant to #11).
- `docs/specs/030-ingestion-enrichment-robustness.md` (added `app.onError` in
  `src/index.ts`), `docs/specs/031-behavior-correctness-ops-polish.md` (touched
  `ensureAdminPassword`/`login-page.tsx`/`logger.ts`/`queue.tsx`/`watching-page.tsx`).
- `docs/app_idea.md` — baseline-hardening bullet (~line 147), single-implicit-user note
  (~line 128); inline pointers per CLAUDE.md.
- Code: `src/index.ts`, `src/lib/auth.ts`, `src/lib/current-user.ts` (to delete),
  `src/routes/*.tsx`, `src/lib/scheduler.ts`, `src/views/layout.tsx`,
  `src/views/watching-page.tsx`, `src/views/queue-list.tsx`, `src/views/login-page.tsx`,
  `Dockerfile`, `.gitignore`, `.env.example`, `README.md`, `test/helpers/auth.ts`,
  `test/routes/*.test.ts`, `test/lib/auth.test.ts`, `test/lib/scheduler.test.ts`.
- **Migration: none.** Session purge is a plain `DELETE`; no schema change in any item
  (Round C's was `0005_shiny_mach_iv`; this round would be `0006` only if scope grows a
  column, which it doesn't).
- **Manual verification** (user in browser, per CLAUDE.md's split): watch-link opens in a
  new tab and middle-click works, sidebar toggle (mobile width), thumbnail fallback hides a
  broken image, endless scroll still loads, `hx-confirm` delete, "Mark Watched & Return"
  disables its button, DevTools console shows **no CSP violations** on every page.
  Claude-performed via curl: response headers, single Set-Cookie, locked-login message,
  session purge via direct SQLite.

## Open Questions

None remaining.

## Resolved Decisions

- **#1 approach — idempotent per-request middleware, routers stay self-protecting.**
  Why: all six route test files mount one router standalone and rely on its own guard; a
  central `createApp()` would churn every one of them and `loginAsAdminUser`, and the
  no-op repeats are cheap.
- **#6 — do it now, delete `getCurrentUser()`.** Why: removes a latent authz footgun and a
  SELECT per handler; supersedes spec024's deferral (pointer added there).
- **#10 — strict CSP via static files (not nonces), enforcing immediately, no HSTS,
  `includeIndicatorStyles:false` + `allowEval:false` so `style-src 'self'`/`script-src
  'self'` need no unsafe-inline/eval.** Why: grep found no inline `style=` or
  `hx-indicator`; HSTS is the proxy's job and the app can't reliably detect TLS.
- **#10 tests — header assertions plus a static no-inline-script/handler test.** Why: a
  future inline handler would silently break under the CSP only in a browser.
- **#10 — `pageshow` reload script ships as a separate file loaded only on the watching
  page**, disable-on-submit via a `data-` attribute + delegated listener.
- **#11 — lockout message only for real locked accounts, status stays 401.** Why: usable
  in a single-user app; accepts username-exists disclosure for locked accounts; avoids new
  per-nonexistent-user state and existing test churn.
- **#12 — recovery purge only when the hash actually changes; idle purge at startup +
  hourly.** Why: avoids logging out on every restart while the env var is left set.
- **#13 dropped** (user, 2026-10-03).
- **#14 — fail-secure default: Secure iff any trusted https origin exists unless the
  request positively matches an http entry; no `X-Forwarded-*` trust.** Why: fixes the
  Host-rewriting-proxy case on GETs (no `Origin`) while keeping plain-http localhost
  working with a mixed `TRUSTED_ORIGINS`.
- **#15 — `noopener` added during the script move.**
- **No migration needed.**
- **Unprompted check:** no further interactions found beyond those folded in above
  (images errored before the deferred script ran, HTMX-swapped images, security headers on
  error/static responses, CI `docker-build-check` needing the new COPY lines, `.gitignore`
  scope for `public/js`).
