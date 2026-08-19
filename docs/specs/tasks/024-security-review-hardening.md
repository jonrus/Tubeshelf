# Tasks: Security Review Hardening
Spec: docs/specs/024-security-review-hardening.md
Generated: 2026-08-19

- [x] 1. Add the ignore-rule keyword length cap to the schema: in `src/db/schema.ts`, add
      `export const IGNORE_RULE_KEYWORD_MAX_LENGTH = 200;` next to the existing
      `CATEGORY_NAME_MAX_LENGTH = 100`, and add a `check("keyword_length_check",
      sql\`length(${t.keyword}) <= ${sql.raw(String(IGNORE_RULE_KEYWORD_MAX_LENGTH))}\`)` to
      the `ignoreRules` table definition's extra-config array, mirroring `categories`'s
      `name_length_check` exactly (same file, ~line 40). Then generate the migration:
      `bun run db:generate` (via `devcontainer exec --docker-path podman --workspace-folder .
      bun run db:generate`). If it prompts interactively to disambiguate (per CLAUDE.md's
      `drizzle-kit generate` TTY gotcha — unlikely here since this only adds a constraint to
      an existing table, not a rename), stop and hand the exact command to the user to run in
      their own terminal instead of working around it. Done when: the constant and `check()`
      exist in `schema.ts`, a new file exists under `drizzle/` with the constraint (either a
      plain `ALTER`-adjacent constraint addition or a table-recreation, whichever
      `drizzle-kit` produces), and `bun test` passes (`test/smoke.test.ts` runs `migrate()`
      against a fresh in-memory DB, so a broken migration fails immediately).

- [x] 2. Add app-level validation for the new cap in `src/routes/ignore-rules.tsx`: import
      `IGNORE_RULE_KEYWORD_MAX_LENGTH` from `../db/schema`, and in both `POST /ignore-rules`
      (~line 29) and `POST /ignore-rules/:id` (~line 50), add a length check before the
      existing empty-keyword check, returning the same shape of inline error
      (`error={\`Keyword must be ${IGNORE_RULE_KEYWORD_MAX_LENGTH} characters or
      fewer.\`}`) — mirror `src/routes/categories.tsx`'s `CATEGORY_NAME_MAX_LENGTH` checks
      at ~lines 36-40 and ~124-129 exactly, including checking length before emptiness.
      Add tests to `test/routes/ignore-rules.test.ts` mirroring
      `test/routes/categories.test.ts`'s length-cap tests (~lines 143-154, 216-221): a
      keyword of `IGNORE_RULE_KEYWORD_MAX_LENGTH + 1` chars is rejected with the inline
      error and adds/renames no rule, and a keyword of exactly
      `IGNORE_RULE_KEYWORD_MAX_LENGTH` chars is accepted, for both the add and edit
      endpoints. Done when: `bun test` passes with the new cases included.

- [x] 3. Fix the login-timing side channel in `attemptLogin()` (`src/lib/auth.ts:46`): add a
      module-level dummy password hash computed once at load time (e.g.
      `const DUMMY_PASSWORD_HASH = Bun.password.hashSync(randomBytes(32).toString("hex"),
      { algorithm: "bcrypt" });`, using the same `randomBytes` import already at the top of
      the file). Change the "no user found" branch (currently `if (!user) return { ok:
      false };`, ~line 55) to `await verifyPassword(password, DUMMY_PASSWORD_HASH)` (discard
      the result) before returning `{ ok: false }`. Change the password-check line (~lines
      61-63, currently `const passwordOk = user.passwordHash ? await
      verifyPassword(password, user.passwordHash) : false;`) to `const passwordOk =
      user.passwordHash ? await verifyPassword(password, user.passwordHash) : await
      verifyPassword(password, DUMMY_PASSWORD_HASH).then(() => false);` (or equivalent —
      the requirement is that the no-`passwordHash` branch also performs one bcrypt verify
      before unconditionally resolving to `false`, never skipping straight to `false`). Do
      **not** touch the `lockedUntil` early return (~lines 57-59) — out of scope per the
      spec's Design section. Add two tests to `test/routes/auth.test.ts` alongside the
      existing "a failed login re-renders..." test (~line 113): logging in with a username
      that doesn't exist returns the same 401 + "Invalid username or password." as a wrong
      password for an existing user (functional-outcome assertion only — do not assert on
      timing, which is unreliable in CI); and logging in against the seeded "admin" user
      before any password has ever been set (i.e. `passwordHash` still `null`, matching
      `src/db/seed.ts`'s fresh-install state — reset it explicitly in the test since
      `loginAsAdminUser()` in `test/helpers/auth.ts` sets a password as a side effect) also
      returns the same 401 + generic error rather than any distinct behavior. Done when:
      `bun test` passes with both new cases.

- [x] 4. Add the subscription-ownership check across both `src/lib/watch-status.ts` and
      `src/routes/queue.tsx`, plus both files' tests, in one pass — the two layers have to
      land together: Bun doesn't type-check at runtime, so if the `watch-status.ts` function
      signatures changed in an earlier, separate step, `queue.tsx`'s still-unpatched call
      sites would silently pass `userId: undefined` into the new join rather than fail to
      compile, breaking most of `queue.test.ts` at a checkpoint that step would have no way
      to leave green. Do it as a single unit:

      - In `src/lib/watch-status.ts`, give each of the five functions (`setWatching`,
        `toggleQueueStatus`, `toggleWatchedFromWatchingPage`, `ignoreVideo`,
        `unignoreVideo`) a `userId: number` second parameter, and change each function's
        "look up current status" query from `eq(videos.id, videoId)` alone to the join
        specified in the spec's Design section 1 (`innerJoin(youtubeChannels, ...)`,
        `innerJoin(subscriptions, ...)`, filtered by `eq(videos.id, videoId)`,
        `eq(subscriptions.userId, userId)`, `isNull(subscriptions.unsubscribedAt)`) — import
        `youtubeChannels`, `subscriptions`, `and`, `isNull` as needed. The subsequent
        `db.update(videos)...where(eq(videos.id, videoId))` in each function stays
        unchanged (ownership already established by the preceding select in the same
        synchronous call).
      - In `src/routes/queue.tsx`, add the same ownership scoping to the two read-helpers:
        `queueRowById` (~line 110) already joins `subscriptions` for `categoryName` — add
        `eq(subscriptions.userId, userId)` and `isNull(subscriptions.unsubscribedAt)` to its
        existing `where`, and add a `userId: number` parameter. `videoForWatchingPage`
        (~line 383) currently has no join at all — add the same two joins and where-clause
        filters, plus the `userId` parameter.
      - Update every call site in `queue.tsx` (`/videos/:id/watching`,
        `/videos/:id/watched-toggle`, `/videos/:id/toggle`, `/videos/:id/ignore`,
        `/videos/:id/unignore`, `/watching/:id`) to call `const user = getCurrentUser();`
        before calling into `watch-status.ts` or the two read-helpers, and pass `user.id` as
        the new argument — `/watching/:id` currently calls `videoForWatchingPage(id)` before
        `getCurrentUser()` (~lines 554-559), so reorder those two lines.
      - Update `test/lib/watch-status.test.ts`: add a seeded `users` row and a
        `subscriptions` row (active, owning `channel`) near the top alongside the existing
        `channel` fixture, thread that user's `id` as the new argument through every
        existing call to the five functions, and add one new test per function asserting it
        returns `null` (not the mutated result) when called with a *different* `userId` than
        the one subscribed to the video's channel.
      - Fix `test/routes/queue.test.ts`: add `makeSubscription(channel.id)` right after
        `makeChannel(...)` in the one `/videos/:id/watching` test (~line 687-708), all three
        `/videos/:id/watched-toggle` tests (~lines 718-802), and all `GET /watching/:id`
        tests that are missing it (~lines 577-685, and the one at ~line 901 — grep the file
        for `test("GET /watching`, `test("POST /videos/:id/watching`, and
        `test("POST /videos/:id/watched-toggle` to find every case rather than trusting
        these line numbers, since they'll have shifted once this step's edits land). Then
        add one new regression test per mutation endpoint (`/watching`, `/watched-toggle`,
        `/toggle`, `/ignore`, `/unignore`) and for `GET /watching/:id`: create a channel and
        video with **no** subscription for the logged-in test user (or a subscription
        belonging to a different user row, whichever is simpler given the existing
        fixtures) and assert the request 404s instead of mutating or rendering the video —
        this is the route-level proof that the wiring actually closes the gap, not just that
        existing behavior didn't regress.

      Done when: `bun test` passes across the whole suite, including all new
      ownership-denial cases in both test files, with no test left relying on the
      pre-existing (now-incorrect) unscoped behavior.

- [x] 5. Run the full verification suite via devcontainer exec — `bun test`, `bun run lint`,
      and `bunx tsc --noEmit` — fix anything it surfaces (in particular, `noUncheckedIndexedAccess`
      issues are easy to introduce when threading a new parameter through several call
      sites, per this project's spec006 history), then update
      `docs/specs/024-security-review-hardening.md`'s frontmatter to `status: implemented`.
      Done when: all three commands are clean and the frontmatter is updated.

- [ ] 6. Open the PR: fill out a summary (referencing this spec) and a test plan (the
      commands from task 5 plus a one-line description of what each of the three fixes
      closes). Per CLAUDE.md, check off this step *before* pushing — the push should carry a
      task file that's already fully checked off. Confirm with the user whether they're
      pushing the branch themselves or want it pushed as part of this step before doing
      either. Done when: the PR is open on GitHub with a filled-out description, and this
      checkbox is checked in the commit that either accompanies or precedes the push.
