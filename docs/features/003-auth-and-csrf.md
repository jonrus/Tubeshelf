---
status: promoted
created: 2026-08-02
promoted_to: docs/specs/012-auth-and-csrf.md
---

# Auth & CSRF

## Problem / Motivation
Per `docs/app_idea.md`'s "Path to v1.0" sequencing (§"Path to v1.0", step 2), the app is
currently auth-free by design during MVP + styling development, but that posture doesn't
survive the app actually being exposed (LAN or Cloudflare Tunnel to the internet, per §5).
Before deployment, the app needs: session/login middleware, rate-limiting/lockout on login
attempts, and CSRF protection on state-changing HTMX requests.

## Firm Scope
- Username/password login (not PIN-based — considered and rejected this session: a 4-6
  digit PIN's entropy is far weaker than a password, and since MVP is single-implicit-user,
  the credential is the *entire* security boundary with no username-enumeration surface to
  offset it).
- Session-based auth gating every route except the login route and static assets
  (`/css/*`, per `src/index.ts:19`) — the login page must remain reachable
  (and stylable) pre-authentication.
- Logout action.
- Rate-limiting/lockout on failed login attempts, DB-backed (not in-memory-only) — this
  matches `app_idea.md`'s own "Path to v1.0" step 3 note that the DB squash is deliberately
  sequenced *after* auth specifically because auth is expected to add its own schema
  (session/token storage, login-attempt tracking).
- Password recovery via an env var override (user-selected this session, in place of
  PIN/email-reset alternatives): low-lift, appropriate for v1 given there's no
  email/SMTP infra for a self-service reset flow.
- CSRF protection via an Origin-header allowlist check (Hono's built-in `hono/csrf`
  middleware, matched against a configurable `TRUSTED_ORIGINS` list — see Resolved
  Decisions on multi-domain support) on every existing state-changing HTMX endpoint. Full
  current list (all
  four route modules): `src/routes/channels.tsx` (`POST /subscriptions/preview`,
  `POST /subscriptions`, `DELETE /subscriptions/:id`,
  `POST /subscriptions/:id/dismiss-missed-videos`), `src/routes/categories.tsx`
  (`POST /categories`, `POST /categories/:id`), `src/routes/ignore-rules.tsx`
  (`POST /ignore-rules`, `POST /ignore-rules/:id`, `DELETE /ignore-rules/:id`),
  `src/routes/queue.tsx` (`POST /videos/:id/watching`, `POST /videos/:id/watched-toggle`,
  `POST /videos/:id/toggle`, `POST /videos/:id/ignore`, `POST /videos/:id/unignore`).
  **Superseded during spec writing — this is actually 14 endpoints, not 11; the corrected
  count and list are in `docs/specs/012-auth-and-csrf.md`'s Scope section.**
- Retrofit of the existing test suite to work under enforced auth/CSRF (see "Testing impact"
  below) — this is core scope for this feature, not incidental cleanup, because without it
  the bulk of the existing route-level test suite (`test/routes/*.test.ts`) would fail the
  moment middleware is enforced.

## Nice-to-have / Stretch Scope
<!-- Optional extensions, if time/complexity allows. Omit this section if there are none. -->

## Explicitly Out of Scope
- OTP/multi-factor auth — explicitly deferred to "v3+" per `app_idea.md:128`.
- Multi-user support, registration, guest/admin roles — MVP and this feature both assume
  the single implicit user from `docs/app_idea.md`'s data model section; those roles are
  listed as "Post MVP" in the User Roles & Permissions table.
- DB squash — deliberately sequenced *after* this feature (`app_idea.md` Path to v1.0 step
  3), specifically so it can catch this feature's own schema additions (sessions,
  login-attempt tracking) in the same squash. This feature adds migrations; it does not
  clean them up.
- Deployment/Docker packaging and the TLS-terminating tunnel itself — Path to v1.0 step 4,
  a separate future feature. This feature's job is to make the app safe to eventually put
  behind that tunnel, not to stand the tunnel up.

## Related Specs / Code
- `docs/app_idea.md`, §5 "Security & Authentication" and "Path to v1.0" step 2 — the
  authoritative scope statement and sequencing rationale for this feature.
- `src/db/schema.ts:15-22` — `users` table already has a nullable `passwordHash` column
  with a `// nullable now; auth is out of scope` comment; this feature makes it non-null
  going forward and adds whatever session/login-attempt tables the design needs.
- `src/db/seed.ts:16-19` — seeds exactly one user (`username: "default"`, no password) if
  none exists; this feature's bootstrap/recovery mechanism is what first gives that user a
  password.
- `src/index.ts` — top-level Hono `app`; currently just mounts four route modules and
  static assets with no middleware at all.
- `src/routes/{channels,categories,ignore-rules,queue}.tsx` — the four route modules
  listed above under Firm Scope, each its own `Hono` sub-router instance.
- `package.json:29-33` — no auth-adjacent dependency exists yet (no bcrypt/argon2, no
  session/JWT/CSRF library); Hono ships `hono/csrf` and `hono/cookie` built in, so a
  same-origin/Origin-header CSRF check needs no new dependency, but password hashing does.
- **No new dependency needed for password hashing.** Bun ships `Bun.password.hash` /
  `Bun.password.verify` natively, supporting bcrypt directly — satisfies `app_idea.md`'s
  "Bcrypt + salt" requirement (§5) with zero new entries in `package.json`.
- **HTMX partial-swap responses need `HX-Redirect`, not a plain 302, for expired-session
  mutating requests.** All 11 existing mutating endpoints listed above respond with an
  HTML fragment for `hx-swap` (per spec004/spec011's HTMX patterns) — if a session expires
  mid-use and one of those POSTs comes back as an ordinary redirect or a login-page HTML
  fragment, HTMX will swap that fragment into the wrong place in the DOM instead of
  navigating. The auth middleware needs to detect HTMX requests (`HX-Request` header) and
  respond with an `HX-Redirect` response header pointing at the login route instead, so
  the browser does a full navigation.
- **Schema changes in this feature (session/login-attempt tables) will hit the known
  `drizzle-kit generate` TTY limitation** (see `CLAUDE.md`'s "Running commands" section) —
  the interactive rename-vs-new-table prompt can't be answered from a Claude Code session,
  so the task file for this feature should plan to hand the user the exact
  `drizzle-kit generate` command to run in their own terminal, same as prior schema-
  touching specs.
- **Testing impact (established earlier this session, carries directly into task-file
  scoping):** every existing route test (`test/routes/*.test.ts`) calls its Hono sub-router
  directly — e.g. `queueRoute.request("/queue")`
  (`test/routes/queue.test.ts:117`), `channelsRoute.request(...)`
  (`test/routes/channels.test.ts:77-97`) — bypassing the top-level `app` in `src/index.ts`
  entirely, with no cookies or headers attached today. This means:
  1. Auth/CSRF middleware must be composed into each route module itself (not only
     `app.use(...)` on the top-level `app`), or the existing per-route test pattern won't
     exercise it at all and the suite would give false confidence.
  2. Once enforced, essentially every existing mutating-request test across all four route
     test files will start failing (401/redirect on missing session, 403 on missing CSRF
     token) without retrofitting — needs a shared test helper (e.g. `test/helpers/auth.ts`)
     that logs in the seeded default user, captures the session cookie + CSRF token, and
     gets imported into every existing route test file rather than patched ad hoc per file.
  3. New test coverage needed that doesn't exist today: login success/failure, lockout
     after N attempts + lockout reset/expiry (check `test/lib/scheduler.test.ts` for a
     reusable time-mocking convention — it already fakes `Date`-driven due-time logic for
     the ingestion scheduler), session expiry/logout, CSRF rejection on missing/stale
     token, unauthenticated-GET-redirects-to-login.
     **Superseded during spec writing — `test/lib/scheduler.test.ts` doesn't actually mock
     the clock; it takes `now` as an explicit function argument instead, which doesn't
     transfer to black-box HTTP testing of lockout expiry. `docs/specs/012-auth-and-csrf.md`
     specifies `bun:test`'s built-in `setSystemTime` instead.**

## Open Questions
<!-- resolved via /new-feature — see Resolved Decisions -->

## Resolved Decisions
- **Env var password recovery applies on every boot, not just bootstrap.** If the env var
  is set, the app hashes it and overwrites the default user's stored password on every
  startup — this is what makes it an actual recovery path (set the var, restart, log in,
  unset the var) rather than only a first-run seed. Tradeoff, accepted: leaving the var set
  permanently means any password set via the UI gets silently overwritten on the next
  restart, so the app logs a warning whenever it applies the override.
- **Multi-domain deployment is a real, expected topology, not a hypothetical.** The
  intended production setup is two separate domains reaching the same app instance: one
  via NGINX Proxy Manager on the LAN, one via a Cloudflare Tunnel for WAN access. This
  changes the CSRF/cookie design from "one canonical origin" to "an allowlist of trusted
  origins":
  - A `TRUSTED_ORIGINS`-style env var holds a list (not a single value) of exact
    scheme+host origins the app will accept as legitimate — needed because neither NPM nor
    Cloudflare Tunnel rewrite the browser's `Origin` header, but the app's *own* view of
    its origin (derived from the raw request it receives, post-TLS-termination) is
    otherwise wrong in both cases.
  - The session cookie's `Secure` attribute is derived **per request**, from which trusted
    origin matched (or its forwarded scheme), not from one global flag — this is what lets
    the design tolerate the LAN path potentially being plain HTTP while the WAN path is
    HTTPS, without either breaking the LAN login or weakening the WAN cookie.
  - Exact env var name/format and the actual domains are deployment-feature concerns
    (Path to v1.0 step 4); this feature's job is only to build the allowlist mechanism
    instead of hardcoding a single origin.
- **Login-attempt lockout is keyed by username, not client IP.** Because the app may sit
  behind either or both of two different reverse proxies, trusting a forwarded-for header
  for per-IP lockout adds real complexity (whose header, how many hops, is the app
  reachable any other way that could spoof it) for no benefit in a single-account app —
  there's exactly one username to lock out, so keying on it sidesteps proxy-header trust
  entirely.
- **Cookies are not shared across the two domains, and that's accepted, not a bug to
  fix.** Logging in via the Cloudflare WAN domain does not authenticate a visit via the
  NPM LAN domain (or vice versa) — separate cookie jars per browser origin. No
  cross-domain SSO is being built for this feature; each domain requires its own login.
  Confirmed explicitly: a shared-session/SSO mechanism across domains is a candidate for a
  future feature if it ever proves annoying in practice, not something this feature builds.
- **CSRF via Origin-header allowlist check**, using Hono's built-in `hono/csrf` middleware
  configured with a custom matcher against the `TRUSTED_ORIGINS` list, rather than a
  double-submit token embedded in every form. Zero changes needed to any of the 11
  existing mutating endpoints' view templates, and the allowlist approach extends to N
  origins with no added complexity over a single one.
- **Sessions are long-lived and sliding: 30 days.** Chosen over session-only-until-browser-
  close specifically because logins are now per-domain (LAN vs WAN, see above) rather than
  shared — a short session lifetime would compound with that into frequent re-logins on
  whichever domain is used less often. Activity resets the 30-day clock.
