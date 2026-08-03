# Tasks: Auth & CSRF
Spec: docs/specs/012-auth-and-csrf.md
Generated: 2026-08-02

- [x] 1. Schema changes in `src/db/schema.ts`. Add to the existing `users` table:
  `failedLoginAttempts: integer("failed_login_attempts").notNull().default(0)` and
  `lockedUntil: integer("locked_until", { mode: "timestamp" })` (nullable). Leave
  `passwordHash` exactly as-is (still nullable) — do not add a `NOT NULL` constraint, per
  the spec's Design > Schema changes section (would break `src/db/seed.ts`'s no-password
  seed). Add a new `sessions` table: `id` (integer pk, autoincrement), `userId` (integer,
  `.notNull().references(() => users.id)`), `tokenHash` (text, `.notNull().unique()`),
  `createdAt` (timestamp, `.notNull().default(sql\`(unixepoch())\`)`, matching this file's
  existing convention for other tables), `lastSeenAt` (timestamp, `.notNull().default(sql\`
  (unixepoch())\`)`).
  - Done when: `bunx tsc --noEmit` passes with no errors introduced by this change.

- [x] 2. Generate the migration for task 1's schema change. **This step requires a real
  interactive TTY that a Claude Code session does not have** (per `CLAUDE.md`'s "Running
  commands" section — `drizzle-kit generate` can prompt to disambiguate new-vs-renamed
  tables/columns, and piping input does not substitute for a TTY). Tell the user to run
  `devcontainer exec --docker-path podman --workspace-folder . bun run db:generate` in
  their own terminal, and wait for them to report back the result.
  - Done when: the user confirms a new migration file (something like
    `drizzle/0005_<name>.sql`) was generated and its contents create the `sessions` table
    and add the two new `users` columns from task 1, with no unexpected drops/renames.

- [x] 3. In a new `src/lib/auth.ts`: password hashing and the recovery-password bootstrap.
  Export `hashPassword(plain: string): Promise<string>` (wraps `Bun.password.hash(plain,
  { algorithm: "bcrypt" })`) and `verifyPassword(plain: string, hash: string):
  Promise<boolean>` (wraps `Bun.password.verify`). Export
  `applyRecoveryPasswordFromEnv(): Promise<void>`: if `process.env.AUTH_RECOVERY_PASSWORD`
  is set, hash it and update the `"default"` user's `passwordHash` column (look up by
  `eq(users.username, "default")`, same pattern as `src/lib/current-user.ts`), then
  `console.warn` a message stating the recovery password was applied and should be unset
  after use. If the env var is unset, this function is a no-op.
  - Done when: `bunx tsc --noEmit` and `bun run lint` pass; a throwaway manual check (e.g.
    a temporary script or REPL, not a committed test) confirms calling the function with
    `AUTH_RECOVERY_PASSWORD` set updates the seeded user's `passwordHash` to a value
    `Bun.password.verify` accepts for that plaintext.

- [x] 4. In `src/lib/auth.ts`: session CRUD. Export `createSession(userId: number): {
  token: string }` — generates a random token via `randomBytes(32)` from `node:crypto`,
  base64url-encodes it, inserts a `sessions` row with its SHA-256 hash (`createHash("sha256")`
  from `node:crypto`) and the given `userId`, returns the raw token (never store the raw
  token). Export `findValidSession(token: string): { userId: number } | undefined` — hashes
  the token, looks up the `sessions` row, returns `undefined` if not found or if
  `Date.now() - lastSeenAt.getTime() > 30 * 24 * 60 * 60 * 1000`; on a hit, updates that
  row's `lastSeenAt` to now before returning. Export `deleteSession(token: string): void` —
  hashes and deletes the matching row.
  - Done when: `bunx tsc --noEmit` and `bun run lint` pass.

- [x] 5. In `src/lib/auth.ts`: trusted-origins parsing and per-request secure-flag
  resolution. Export `getTrustedOrigins(): string[]` — parses
  `process.env.TRUSTED_ORIGINS` as a comma-separated list, trimming whitespace on each
  entry, defaulting to `["http://localhost:3000"]` if unset. Export
  `resolveCookieSecure(c: Context): boolean` (Hono `Context` type) — reads the `Origin`
  header; if present, find the matching entry in `getTrustedOrigins()` and return whether
  it starts with `https://`; if absent, do the same lookup against the `Host` header instead
  (matching hostname[:port] against each trusted origin's host); if nothing matches, default
  to `false` (never mark a cookie `Secure` for a request that doesn't match a known trusted
  origin, to fail toward "cookie still gets sent over the default-assumed-http case" rather
  than silently dropping it — since an unmatched request is already an edge case not
  addressed by the trusted-origins list at all).
  - Done when: `bunx tsc --noEmit` and `bun run lint` pass.

- [x] 6. In `src/lib/auth.ts`: the `requireAuth` Hono middleware. Reads the `session`
  cookie (via `getCookie` from `hono/cookie`); if absent or `findValidSession` (task 4)
  returns `undefined`, treat as unauthenticated: if the request has an `HX-Request` header,
  respond with status `401`, header `HX-Redirect: /login?from=<url-encoded current path +
  query string>`, and **no** `WWW-Authenticate` header; otherwise respond with a `302`
  redirect to the same `/login?from=...` location. If the session is valid: call `setCookie`
  (from `hono/cookie`) to re-issue the `session` cookie with a fresh 30-day `Max-Age`,
  `HttpOnly: true`, `SameSite: "Lax"`, and `Secure: resolveCookieSecure(c)` (task 5); attach
  the resolved `userId` to the context (`c.set("userId", ...)`, with a matching
  `declare module "hono" { interface ContextVariableMap { userId: number } }` — confirmed
  present and used this way by Hono's own built-in JWT middleware in the installed
  `hono@4.12.31`, so this is the real mechanism, not a guess); call `next()`.
  - Done when: `bunx tsc --noEmit` and `bun run lint` pass. Not yet wired into any router
    (that's task 12) — this task only defines the middleware.

- [x] 7. In `src/lib/auth.ts`: the `csrfCheck` middleware. Export `csrfCheck` built from
  Hono's built-in `csrf` (`import { csrf } from "hono/csrf"`), called as
  `csrf({ origin: getTrustedOrigins() })` (task 5) — pass the array directly, no custom
  matcher function needed (confirmed against the installed `hono@4.12.31` source during
  spec review that `origin` accepts a plain `string[]`).
  - Done when: `bunx tsc --noEmit` and `bun run lint` pass.

- [x] 8. In `src/lib/auth.ts`: lockout and login orchestration. Export
  `attemptLogin(username: string, password: string): Promise<{ ok: true; userId: number }
  | { ok: false }>` as a single function (not spread across separate exported lockout
  helpers) so the lockout-check/password-verify/counter-write sequence stays easy to keep
  race-free per the spec's Design > Lockout section:
  1. Look up the user by `username`. If none, return `{ ok: false }` (do not reveal
     username-existence via a different error).
  2. If `user.lockedUntil` is set and in the future, return `{ ok: false }` immediately —
     do not call `verifyPassword` and do not touch `failedLoginAttempts`/`lockedUntil`.
  3. `await verifyPassword(password, user.passwordHash)` (handle `user.passwordHash` being
     `null` as always-false, per task 1's note that a null hash means "cannot log in with
     any password").
  4. If verification failed: re-read the user's current `lockedUntil` fresh from the DB
     (not the value from step 2, since the `await` in step 3 is exactly the gap the spec's
     race-condition note warns about) — if it's now locked (a concurrent request already
     tripped it), return `{ ok: false }` without incrementing further. Otherwise increment
     `failedLoginAttempts` via a single atomic SQL update
     (`sql\`failed_login_attempts = failed_login_attempts + 1\`\`` via Drizzle's `.set({
     failedLoginAttempts: sql\`failed_login_attempts + 1\` })`, not a JS read-modify-write);
     if the updated value reaches 5, in the same update also set
     `lockedUntil = new Date(Date.now() + 15 * 60 * 1000)` and reset
     `failedLoginAttempts` to `0`. Return `{ ok: false }`.
  5. If verification succeeded: reset `failedLoginAttempts` to `0` and clear `lockedUntil`
     to `null`, return `{ ok: true, userId: user.id }`.
  - Done when: `bunx tsc --noEmit` and `bun run lint` pass. Full behavioral coverage of this
    function happens in task 19's tests, not here.

- [x] 9. In `src/lib/auth.ts`: the open-redirect-safe `from` validator. Export
  `safeRedirectTarget(from: string | undefined): string` — if `from` is undefined, return
  `"/queue"`. Otherwise attempt `new URL(from, "http://internal.invalid")`; if the result's
  `.origin` is exactly `"http://internal.invalid"`, return `from` unchanged (it stayed a
  same-origin relative path); otherwise return `"/queue"`. Do **not** implement this as a
  string-prefix check (e.g. "starts with `/`, doesn't start with `//`") — per the spec's
  Design > Login page > Open-redirect guard section, that variant has a demonstrated
  bypass (WHATWG URL parsing strips tabs/newlines, so e.g. `/\t/evil.com` would pass a
  naive check yet still normalize to an off-site `//evil.com` in a real browser).
  - Done when: `bunx tsc --noEmit` and `bun run lint` pass.

- [x] 10. New `src/views/login-page.tsx`, exporting a `LoginPage` component. **Not** wrapped
  in `Layout` (`src/views/layout.tsx`) — per the spec's Design > Login page section,
  `Layout` requires `navCounts`/`categories` props from authenticated-user queries and
  renders a full sidebar with no reachable destinations pre-login. Render a minimal
  `<html>` page reusing the existing Tailwind design tokens from spec011
  (`bg-bg`, `text-text`, `bg-surface`, `border-border`, etc. — check `src/views/layout.tsx`
  and any CRUD-page view like `src/views/categories-page.tsx` for the exact token usage to
  match): a centered card with `username`/`password` fields, a submit button, an optional
  error message prop (e.g. `error?: string` for "invalid credentials" / "too many
  attempts"), and a hidden `from` input carrying through whatever `from` value was on the
  incoming `GET /login` query string (raw passthrough is fine here — this is what
  `POST /login` will validate via `safeRedirectTarget`, task 9, not this view).
  - Done when: `bunx tsc --noEmit` and `bun run lint` pass.

- [x] 11. New `src/routes/auth.tsx`, exporting `authRoute = new Hono()`. Add
  `authRoute.use("*", csrfCheck)` (from task 7) as the **first statement** after the
  `new Hono()` line — do not add `requireAuth` here, per the spec's Design > Middleware
  composition section (`/login` must be reachable unauthenticated). Then:
  - `GET /login`: if the request already carries a valid session (check via the same
    cookie-read + `findValidSession` used in `requireAuth`, task 6 — call `requireAuth`'s
    underlying check directly or factor a small shared helper, implementer's choice, but
    don't duplicate the session-lookup logic verbatim), redirect to
    `safeRedirectTarget(c.req.query("from"))` (task 9). Otherwise render `LoginPage` (task
    10) with `from` passed through from the query string.
  - `POST /login`: read `username`/`password` from the form body
    (`c.req.parseBody()`, matching every other route's body-reading convention). Call
    `attemptLogin` (task 8). On `{ ok: false }`, re-render `LoginPage` with an error message
    and the same `from` value, status `401`. On `{ ok: true, userId }`, call `createSession`
    (task 4), set the `session` cookie (`HttpOnly`, `SameSite: "Lax"`,
    `Secure: resolveCookieSecure(c)` from task 5, `Max-Age` = 30 days), and redirect (302)
    to `safeRedirectTarget(c.req.parseBody().from as string | undefined)` (task 9).
  - `POST /logout`: read the `session` cookie if present, call `deleteSession` (task 4),
    clear the cookie (`deleteCookie` from `hono/cookie`), redirect (302) to `/login`. No
    auth guard needed — a missing/already-invalid session makes this a harmless no-op.
  - Done when: `bunx tsc --noEmit` and `bun run lint` pass. Not yet mounted in
    `src/index.ts` (that's task 12).

- [x] 12. Wire everything into `src/index.ts` and the four existing route modules.
  - In `src/index.ts`: import `authRoute` and mount it via `app.route("/", authRoute)`
    **before** the four existing `app.route("/", ...)` calls for `categoriesRoute`,
    `channelsRoute`, `queueRoute`, `ignoreRulesRoute`. This order is a hard requirement per
    the spec's Design > Middleware composition section — mounting a gated router first
    would make `requireAuth`'s wildcard middleware leak forward across `app.route(...)`
    calls and catch `/login` itself, causing an infinite `/login?from=/login` redirect
    loop. Also call `await applyRecoveryPasswordFromEnv()` (task 3) right after the
    existing `seed(db)` call.
  - In each of `src/routes/categories.tsx` (after line 11's
    `export const categoriesRoute = new Hono();`), `src/routes/channels.tsx` (after line
    129's `export const channelsRoute = new Hono();`), `src/routes/ignore-rules.tsx`
    (after line 12's `export const ignoreRulesRoute = new Hono();`), and
    `src/routes/queue.tsx` (after line 253's `export const queueRoute = new Hono();`):
    add `<routerName>.use("*", csrfCheck, requireAuth);` as the immediate next line, before
    any existing `.get`/`.post`/`.delete` call in that file. This exact placement (first
    statement after the router is created) is a hard requirement per the same Design
    section — Hono middleware only applies to routes registered after it in file order, so
    appending this line later in the file would silently leave every route on that router
    unprotected. Import `csrfCheck`/`requireAuth` from `../lib/auth` in each file.
  - Done when: `bunx tsc --noEmit` and `bun run lint` pass. **`bun test` is expected to
    fail widely after this step** — every existing mutating/GET test in
    `test/routes/{categories,channels,ignore-rules,queue}.test.ts` will now hit
    `requireAuth`/`csrfCheck` with no session/Origin attached. This is expected, not a
    regression to chase down within this task — tasks 15-18 fix it via retrofit. Confirm
    via `bun run dev` (or a quick `curl` inside the devcontainer) that `GET /queue`
    unauthenticated now redirects to `/login`, and that `GET /login` itself loads without
    redirecting.

- [x] 13. Devcontainer and `.env.example` defaults. In `.devcontainer/devcontainer.json`,
  add a `"containerEnv"` block setting a fixed dev-only `AUTH_RECOVERY_PASSWORD` value
  (e.g. `"AUTH_RECOVERY_PASSWORD": "dev-password-change-me"` — the exact string doesn't
  matter, but add a `// devcontainer.json doesn't support comments — note this decision
  in the PR/commit rather than inline` style caveat is unnecessary since JSONC comments
  *are* supported by VS Code's devcontainer tooling; add a short comment above the key
  stating this is dev-only, insecure-by-design, and must never be used as a real deployment
  credential). Update `.env.example` (currently just a placeholder comment) to list
  `AUTH_RECOVERY_PASSWORD` and `TRUSTED_ORIGINS` with one-line descriptions and example
  values, replacing the "No environment variables are required for MVP" comment.
  - Done when: a fresh `devcontainer up --docker-path podman --workspace-folder .` (safe to
    rerun, per `CLAUDE.md`) picks up the new `containerEnv` value — confirm by checking
    `devcontainer exec --docker-path podman --workspace-folder . printenv
    AUTH_RECOVERY_PASSWORD` prints the configured value.

- [x] 14. New `test/helpers/auth.ts`. At module load, set `process.env.TRUSTED_ORIGINS =
  "http://test.local"` (mirroring the existing `process.env.DB_FILE_NAME = ":memory:"`
  pattern used at the top of every `test/routes/*.test.ts` file). Export a function (e.g.
  `loginAsDefaultUser(): Promise<{ cookie: string; origin: string }>`) that: ensures the
  `"default"` user has a known test password (update its `passwordHash` directly via
  `hashPassword` + a DB write, rather than going through `attemptLogin`, to avoid coupling
  this helper to lockout state), then calls `authRoute.request("/login", { method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Origin:
  "http://test.local" }, body: new URLSearchParams({ username: "default", password:
  <the known test password> }) })`, extracts the `Set-Cookie` header's `session=...` value
  from the response, and returns it alongside the origin string for callers to attach to
  their own requests.
  - Done when: `bunx tsc --noEmit` and `bun run lint` pass, and a throwaway call from a
    scratch test confirms `loginAsDefaultUser()` returns a cookie value that
    `findValidSession` (task 4) accepts.

- [x] 15. Retrofit `test/routes/categories.test.ts`: import `loginAsDefaultUser` from
  task 14's helper, call it once (module load or a `beforeAll`-equivalent, matching this
  file's existing top-level setup style), and attach `Cookie: <cookie>` +
  `Origin: <origin>` headers to every existing `categoriesRoute.request(...)` call in the
  file (both GETs, now gated, and the existing POST create/rename calls).
  - Done when: `bun test test/routes/categories.test.ts` passes fully again with no
    assertions weakened or removed.

- [x] 16. Retrofit `test/routes/channels.test.ts` the same way as task 15 (import the
  helper, attach cookie + Origin headers to every `channelsRoute.request(...)` call,
  including the DELETE and the two POST helper functions defined near the top of the
  file).
  - Done when: `bun test test/routes/channels.test.ts` passes fully again with no
    assertions weakened or removed.

- [x] 17. Retrofit `test/routes/ignore-rules.test.ts` the same way (attach cookie + Origin
  headers to every `ignoreRulesRoute.request(...)` call, including the DELETE).
  - Done when: `bun test test/routes/ignore-rules.test.ts` passes fully again with no
    assertions weakened or removed.

- [x] 18. Retrofit `test/routes/queue.test.ts` the same way (attach cookie + Origin headers
  to every `queueRoute.request(...)` call across all its GET and POST endpoints).
  - Done when: `bun test test/routes/queue.test.ts` passes fully again with no assertions
    weakened or removed.

- [x] 19. New `test/routes/auth.test.ts`. Follow the same `process.env.DB_FILE_NAME =
  ":memory:"` + `migrate` + `seed(db)` setup as every existing route test file, **calling
  `seed(db)` before inserting any test-only fixture rows** — per the spec's Design > Test
  retrofit section, `src/db/seed.ts`'s guard is `if (!anyUser)`, so seeding after an insert
  would silently skip creating the `"default"` user and break every other test file in the
  same `bun test` run (this file's name sorts alphabetically early among
  `test/routes/*.test.ts`, making the mistake easy to hit by accident). For any test that
  exercises lockout (failing login repeatedly), insert and use a **separate,
  dedicated test-only user row** (not `"default"`) so failure-count/lockout state never
  leaks into other test files' shared use of `"default"` via `loginAsDefaultUser` (task
  14). Cover: successful login redirects to `from` (and to `/queue` when `from` is
  absent/unsafe — include one case with an unsafe `from` like `/\t/evil.com` asserting it
  falls back to `/queue`, not the off-site target); failed login re-renders the form with
  an error and status 401; 5 failed attempts against the dedicated test user lock it (6th
  attempt rejected without a password check even with the correct password); lockout
  persists without extending on repeated attempts during the window (use `bun:test`'s
  built-in `setSystemTime` to advance past the 15-minute window and confirm login succeeds
  again — not the pattern in `test/lib/scheduler.test.ts`, which takes `now` as an explicit
  argument rather than mocking the clock, and doesn't transfer to this black-box HTTP
  testing style); a session found via `findValidSession` past the 30-day sliding window
  (again via `setSystemTime`) is rejected; logging out then reusing the old cookie is
  rejected; a mutating request with a missing/mismatched `Origin` header is rejected by
  `csrfCheck`; a JSON-bodied mutating request is *not* rejected by `csrfCheck` regardless of
  `Origin` (documenting the Content-Type dependency noted in the spec's Design section, not
  treating it as a gap); an unauthenticated `GET` to a gated route (e.g. `/queue` via
  `queueRoute.request("/queue")` with no cookie) redirects to `/login`.
  - Done when: `bun test test/routes/auth.test.ts` passes, and running the full suite
    (`bun test`) shows no test-order-dependent failures (run it at least twice in a row to
    catch any lingering shared-state leakage from this file into the others).

- [x] 20. Final verification. Run `bun test`, `bun run lint`, and `bunx tsc --noEmit` clean
  across the repo, then `bun run css:build` once more to confirm the login page's markup
  doesn't need any Tailwind classes not already in the generated stylesheet. Then do manual
  end-to-end verification, split per `CLAUDE.md`'s convention:
  - **Claude performs directly** (via `curl` inside the devcontainer): confirm an
    unauthenticated `curl -i http://localhost:3000/queue` redirects (302) to
    `/login?from=%2Fqueue`; confirm an unauthenticated `curl -i http://localhost:3000/`
    double-redirects as the spec's Design > Interaction with existing routes section
    expects (`/` → `/queue` → `/login?from=%2Fqueue`, harmless, no special-casing needed —
    confirm both hops rather than assuming the chain works); confirm `GET /login` returns
    200; confirm `POST /login` with a
    wrong password returns 401 with the form re-rendered and an error message; confirm 5
    consecutive wrong-password `POST /login` calls against the same account result in a 6th
    attempt being rejected even before checking the password (verify via response
    timing/content, not just status); confirm a correct `POST /login` (using the
    devcontainer's baked-in `AUTH_RECOVERY_PASSWORD`, task 13) returns a `Set-Cookie` header
    and a redirect; confirm a subsequent authenticated `curl` with that cookie against
    `POST /categories` **without** an `Origin` header is rejected, and the same call **with**
    a matching `Origin` header succeeds; confirm `POST /logout` clears the session (a
    following authenticated request with the same, now-stale cookie is redirected to
    `/login` again); confirm via a direct SQLite read that the `sessions` table and the new
    `users` columns exist and behave as expected (a row disappears after logout; a locked
    user's `lockedUntil` is set).
  - **User performs live in a browser**: visit `/queue` while logged out and confirm you
    land on a login page styled consistently with the rest of the app (dark theme, same
    tokens as spec011 — not an unstyled form); log in with the devcontainer's default
    recovery password and confirm you're returned to `/queue` (not dumped on some other
    page); use one of the existing mutating actions (e.g. Mark Watched) and confirm the
    HTMX partial swap still works exactly as before with no full-page reload; open dev
    tools, delete the `session` cookie manually, then trigger an HTMX mutating action (e.g.
    Mark Watched again) and confirm the browser navigates to `/login` (via `HX-Redirect`)
    rather than showing a broken partial swap or a native basic-auth popup; log out via
    whatever logout affordance was added and confirm you land back on `/login`.
  - Done when: all three commands are clean, Claude's curl/DB-read checks above all pass,
    and the user confirms the browser-only checks. Then update
    `docs/specs/012-auth-and-csrf.md`'s frontmatter to `status: implemented`.
