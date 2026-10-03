# Tasks: Auth & Security Hardening
Spec: docs/specs/032-auth-security-hardening.md
Generated: 2026-10-03

Notes for every step: run commands via the devcontainer (CLAUDE.md). Finding IDs (`#1`, `#6`,
…) are the spec's. Inline doc pointers (spec012, spec024, `docs/app_idea.md` §4 "User") are
already committed on this branch — task 14 only verifies them. Full-app tests (tasks 1+) use
`DB_FILE_NAME=":memory:"` set before a dynamic import, `migrate(db, …)` + `seed` before
requesting (copy the setup from `test/routes/queue.test.ts`), import `test/helpers/auth.ts`
before making requests, and run from the repo root (`serveStatic` root is cwd-relative).
No schema change anywhere in this spec.

- [x] 1. Extract `buildApp()` into `src/app.ts` — create `src/app.ts` exporting
  `buildApp(): Hono` that builds the `Hono` instance with the existing `app.onError` (moved
  verbatim from `src/index.ts`), the four static handlers (`/css/*`, `/js/*`, `/icons/*`,
  `/manifest.json`), and the six `app.route("/", …)` calls in the existing order (health,
  auth, categories, channels, queue, ignore-rules). No startup side effects (no migrations,
  no `Bun.serve`; it opening the DB via `db/client` on import is fine). `src/index.ts` keeps
  `runMigrations`/`seed`/recovery/`ensureAdminPassword`, `startScheduler`, `Bun.serve`, signal
  handlers, and calls `buildApp()`. Add `test/app.test.ts` with a smoke test: `GET /healthz`
  → 200 and `GET /queue` unauthenticated → 302 to `/login?from=…` on the full app. — done
  when: `bun test` passes (existing tests untouched), `bunx tsc --noEmit` clean, and
  `bun run src/index.ts` still boots (check `/healthz` via `curl` inside the container, then
  kill it per CLAUDE.md).

- [x] 2. #1 — csrf + auth run exactly once per request — in `src/lib/auth.ts`: (a) make
  `csrf` origin lazy: `const csrfInner = csrf({ origin: (o) => getTrustedOrigins().includes(o) })`;
  (b) export `csrfCheck` as a wrapper `MiddlewareHandler`: if `c.get("csrfChecked")` call
  `return next()`, else `return csrfInner(c, async () => { c.set("csrfChecked", true); await next(); })`
  (flag set only after the check passes); add `csrfChecked: boolean` to `ContextVariableMap`;
  (c) `requireAuth`: first line `if (c.get("userId") !== undefined) return next();` (keep
  `userId: number` required in `ContextVariableMap` and compare against `undefined` anyway —
  or make it optional if you prefer; whichever, `tsc --noEmit` must stay clean). Update the
  comment in `test/helpers/auth.ts` so it's accurate (origins now read lazily). Add tests in
  `test/app.test.ts`: an authenticated `GET` on the full app (cookie from `loginAsAdminUser`)
  returns exactly **one** `Set-Cookie` (`res.headers.getSetCookie().length === 1`) on a page
  registered late in the router order (e.g. `/ignore-rules`); and in `test/lib/auth.test.ts`
  a unit-ish test that running `requireAuth` twice on one context bumps `sessions.last_seen_at`
  once (assert via a second pass not changing the value / spying the DB write). Also confirm
  a rejected cross-origin POST still 403s. — done when: new tests pass, all existing tests
  (esp. `test/routes/*`, which depend on lazy `TRUSTED_ORIGINS`) pass, tsc clean.

- [x] 3. #14 + cookie helper — in `src/lib/auth.ts`: rewrite `resolveCookieSecure` to the
  spec's fail-secure rule (Secure iff any `TRUSTED_ORIGINS` entry is `https://`, except when
  the request positively matches an `http://` entry — `Origin` header exact match when
  present, else `Host` header vs each entry's `new URL(entry).host`; no `X-Forwarded-*`);
  add exported `setSessionCookie(c, token)` owning `httpOnly`, `sameSite: "Lax"`,
  `secure: resolveCookieSecure(c)`, `path: "/"`, `maxAge: SESSION_MAX_AGE_SECONDS` (single
  constant in `auth.ts`); use it in `requireAuth` and `POST /login` in `src/routes/auth.tsx`,
  deleting the duplicate constant and inline options there (drop the now-unused
  `setCookie`/`resolveCookieSecure` imports). Update `.env.example` and the README
  `TRUSTED_ORIGINS` text per spec §#14 (new rule, mixed-list behavior, https entry makes
  Secure the default, the dev-only mixed-list caveat with a Host-rewriting proxy, and the
  plain-http-at-non-listed-host caveat). Tests in `test/lib/auth.test.ts`: the four-row table
  from the spec (plus an `Origin`-present variant of the mixed row) and `setSessionCookie`
  attributes. — done when: tests pass, existing auth route tests pass, README/.env.example
  updated.

- [x] 4. #11 — distinct lockout message — in `src/lib/auth.ts` change `attemptLogin`'s
  failure type to `{ ok: false; reason: "invalid" | "locked" }`: `"locked"` on both locked
  paths (up-front `lockedUntil > now`, which includes correct-password-while-locked, and the
  post-verify `fresh` re-check); `"invalid"` for unknown user / wrong password (including the
  5th attempt that trips the lock). In `src/routes/auth.tsx` `POST /login`: render
  "Too many attempts, try again later." for `"locked"`, still status 401; generic message
  unchanged otherwise. Tests: `test/lib/auth.test.ts` for the reasons; `test/routes/auth.test.ts`:
  after 5 bad attempts the 6th shows the lockout message (401), a correct password while
  locked also shows it (401), and unknown user / wrong password still show the generic message.
  — done when: tests pass, existing lockout tests updated if they relied on the old shape.

- [ ] 5. #12 — `purgeIdleSessions` + recovery purge in `src/lib/auth.ts` — add exported
  `purgeIdleSessions(now = new Date())` deleting `sessions` where `last_seen_at <
  now - SESSION_IDLE_TIMEOUT_MS` (reuse the same constant as `findValidSession`). Change
  `applyRecoveryPasswordFromEnv`: if env unset return; read the admin row; if it exists and
  its stored hash is non-null and verifies against the env value → no re-hash, no write, no
  purge (still log the warning, wording adjusted: "still set, unset it"); otherwise hash
  (async) first, then in one **synchronous** `db.transaction` update the admin password
  (with `.returning({ id })`) and, only if a row was updated, `db.delete(sessions)` (all
  rows); log the existing warning. A missing admin row = no update and no purge. Tests in
  `test/lib/auth.test.ts`: `purgeIdleSessions` deletes only idle sessions; recovery purge
  deletes all sessions when hash was null or differs; does not when it already verifies
  (hash unchanged and sessions kept); missing admin row → no purge. — done when: tests pass,
  tsc clean.

- [ ] 6. #12 — wire purge into startup and scheduler — `src/index.ts`: order becomes
  `await applyRecoveryPasswordFromEnv()` → `purgeIdleSessions()` → `await ensureAdminPassword()`.
  `src/lib/scheduler.ts`: add module-level `lastSessionPurgeAt` initialised at module load
  (`Date.now()`), and exported `maybePurgeSessions(now = new Date())` that calls
  `purgeIdleSessions(now)` and updates `lastSessionPurgeAt` only if ≥ 1 hour has elapsed since
  it; `tick()` calls it in its own try/catch (log "Session purge failed", separate from the
  ingest loop and enrichment sweep). Test in `test/lib/scheduler.test.ts`: within an hour →
  no purge, after an hour → purges an idle session; confirm `scheduler.test.ts` doesn't break
  later `test/routes/*` (full `bun test` run, since the shared module registry was the spec's
  pass-2 bug). — done when: tests pass in a full `bun test` run.

- [ ] 7. #6 — session user in `src/routes/queue.tsx` — replace all 10 `getCurrentUser()`
  calls (lines ~373–607) with `const userId = c.get("userId")` and update uses (`user.id` →
  `userId`, any other `user` field read — verify none); remove the `current-user` import.
  — done when: `rg getCurrentUser src/routes/queue.tsx` is empty, `bun test test/routes/queue.test.ts`
  and `bunx tsc --noEmit` pass.

- [ ] 8. #6 — session user in `categories.tsx`, `ignore-rules.tsx`, `channels.tsx`; delete
  `current-user.ts` — same replacement for the 5 / 1 / 4 call sites. In `channels.tsx`
  change `updateOwnedSubscription(c, user, id, …)` to take `userId: number` (verify no call
  site reads another `user` field). Delete `src/lib/current-user.ts`. Add a route test (e.g.
  in `test/routes/channels.test.ts` or `categories.test.ts`) that inserts a second, non-admin
  user row with a password, logs in as them (create a session via `createSession(user.id)`),
  and asserts a page shows that user's data (e.g. their category) and not `admin`'s. — done
  when: `rg getCurrentUser src` is empty, `src/lib/current-user.ts` gone, all route tests
  and tsc pass.

- [ ] 9. #10 — static JS files + view cleanup — create `public/js/app.js` containing: the
  watch-link `click`/`auxclick` handler (port `WATCH_LINK_CLICK_SCRIPT` from
  `src/views/layout.tsx` verbatim in behavior, with `window.open(url, "_blank", "noopener")`
  — #15), the sidebar toggle (port `SIDEBAR_TOGGLE_SCRIPT`, null-guarding
  `#sidebar-toggle`/`#sidebar-backdrop`), a **capture-phase** `error` listener on `document`
  setting `img.style.visibility = "hidden"` for `<img>` targets plus a load-time pass for
  `img.complete && img.naturalWidth === 0`, and a delegated `submit` listener disabling the
  first `<button>` of forms with `data-disable-on-submit`. Create
  `public/js/pageshow-reload.js` with the `pageshow`/`event.persisted` reload. Then edit
  views: `layout.tsx` — delete the two script constants and both
  `dangerouslySetInnerHTML` script tags, add
  `<meta name="htmx-config" content='{"includeIndicatorStyles":false,"allowEval":false}'>`
  before the htmx script, and `<script src="/js/app.js" defer>` after it;
  `watching-page.tsx` — remove the `dangerouslySetInnerHTML` script, add
  `<script src="/js/pageshow-reload.js" defer>`, replace `onsubmit=…` with
  `data-disable-on-submit`, remove `onerror=…`; `queue-list.tsx:164` — remove `onerror=…`.
  Keep `LoginPage` unchanged. Make both JS files pass `biome check .`; if `bun run fallow`
  flags them as unused, add `"public/js/**"` to `ignorePatterns` in `.fallowrc.json`. Update
  any existing view/route test that asserted the old inline strings. — done when:
  `rg "dangerouslySetInnerHTML|onerror=|onsubmit=" src` is empty, `bun run lint`,
  `bun run fallow`, `bun test`, tsc pass.

- [ ] 10. Dockerfile — in the final stage of `Dockerfile` add
  `COPY public/js/app.js ./public/js/app.js` and
  `COPY public/js/pageshow-reload.js ./public/js/pageshow-reload.js` next to the existing
  `public/` COPY lines. `.gitignore` needs no change (verify `git status` shows the two new
  JS files as trackable). — done when: both COPY lines exist and `git check-ignore
  public/js/app.js public/js/pageshow-reload.js` prints nothing.

- [ ] 11. #10 — security headers — in `src/app.ts`, register as the **first**
  `app.use("*", secureHeaders({...}))` (`hono/secure-headers`) before static handlers/routes:
  `contentSecurityPolicy` object with camelCase keys: `defaultSrc ["'self'"]`, `imgSrc
  ["'self'", "https://i.ytimg.com"]`, `scriptSrc ["'self'"]`, `styleSrc ["'self'"]`,
  `objectSrc ["'none'"]`, `frameAncestors ["'none'"]`, `baseUri ["'none'"]`, `formAction
  ["'self'"]`; `referrerPolicy: "same-origin"`; `xFrameOptions: "DENY"`;
  `strictTransportSecurity: false`; leave other hono defaults. Tests in `test/app.test.ts`
  on the full app: `/login`, an authenticated page (cookie), `/healthz`, `/js/app.js`, and a
  forced 500 (register a throwing GET on the returned app, send the logged-in cookie) each
  carry the exact CSP string (directives joined by `"; "`), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, and have **no**
  `Strict-Transport-Security`. — done when: tests pass, tsc/lint clean.

- [ ] 12. #10 — no-inline guard test — in `test/app.test.ts` (or a new
  `test/no-inline.test.ts`) fetch, on the full app with seeded data (at least one video card
  in the queue, a watching-page video, a channel, category, ignore rule): `/login`, `/queue`,
  `/watching/:id`, `/channels`, `/categories`, `/ignore-rules`, plus an HTMX partial
  (`QueueListMore`, e.g. `/queue?cursor=…` with `HX-Request`), and assert each body has no
  `<script>` without `src`, no `<style` element, no `on[a-z]+=` attribute, and no `style=`
  attribute. — done when: test passes (and demonstrably fails if you temporarily
  reintroduce an `onerror=`).

- [ ] 13. Manual end-to-end verification (Claude-performed part) — per CLAUDE.md, inside
  the devcontainer with `scripts/dev-login.sh` cookies: response headers (CSP, nosniff,
  Referrer-Policy, X-Frame-Options, no HSTS) on `/login`, an authed page, `/healthz`,
  `/js/app.js`, `/js/pageshow-reload.js`, and a forced 500 if practical; exactly one
  `Set-Cookie` on an authed GET; locked-login message after 5 bad attempts (then reset
  `failed_login_attempts`/`locked_until` on the dev DB); session purge via direct SQLite
  (script file, not inline `bun -e`): insert a stale `last_seen_at` session, restart server,
  row gone; changing `AUTH_RECOVERY_PASSWORD` deletes all sessions on boot, restarting with
  the same value leaves them. Clean up throwaway rows/files; kill dev server via `/proc`
  scan. — done when: each check's result is reported.

- [ ] 14. Manual verification (user-performed in a browser) — give exact URLs and what to
  look for, with the DevTools console open: login, logout and "Mark Watched & Return" form
  POSTs work; watch-link opens a new tab and middle-click works; sidebar toggle at mobile
  width; a broken thumbnail is hidden (incl. after endless-scroll load); endless scroll
  loads; `hx-confirm` delete still prompts; "Mark Watched & Return" disables its button;
  back-navigation to the watching page reloads; **no CSP violations in the console on every
  page**. Also have the user (or Claude via `podman`) build the Dockerfile image and confirm
  `/js/app.js` and `/js/pageshow-reload.js` return 200. Claude also verifies doc pointers:
  `grep -n 032 docs/app_idea.md docs/specs/012*.md docs/specs/024*.md`. — done when: the
  user reports results back.

- [ ] 15. Final verification, flip spec to implemented, open the PR — run `bun test`,
  `bun run lint`, `bunx tsc --noEmit`, and `bun run fallow` clean across the repo; set
  `docs/specs/032-auth-security-hardening.md` frontmatter to `status: implemented`. Draft the
  PR (summary + test plan; end with the Claude Code attribution line) per CLAUDE.md's git
  workflow: check this step's box *before* pushing, commit, then ask whether the user is
  pushing or Claude should; never merge. — done when: all four commands are green, spec is
  `implemented`, this file is fully checked, and the PR is open (or the user has been handed
  the push/PR command).
