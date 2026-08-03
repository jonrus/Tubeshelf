# Tasks: DB Squash + Default User Rename (default → admin)
Spec: docs/specs/013-db-squash-and-admin-rename.md
Generated: 2026-08-03

- [x] 1. Squash the 6 existing Drizzle migrations into a single baseline. Delete
  `drizzle/0000_steady_wild_pack.sql` through `drizzle/0005_misty_jasper_sitwell.sql` and
  everything under `drizzle/meta/` (`_journal.json` + the 6 `NNNN_snapshot.json` files).
  Then run `bun run db:generate` (via `devcontainer exec --docker-path podman
  --workspace-folder .`, per `CLAUDE.md`) against the now-empty `drizzle/` output
  directory — this diffs `src/db/schema.ts` against nothing, so it emits a single migration
  with no rename ambiguity to resolve (no interactive TTY prompt). Rename the generated
  file from Drizzle's auto-generated name (`0000_<adjective>_<noun>.sql`) to
  `0000_baseline.sql`, and update the matching `tag` field in `drizzle/meta/_journal.json`
  from the auto-generated name to `"baseline"` (leave every other field — `idx`, `version`,
  `when`, `breakpoints` — as generated). Leave `drizzle/meta/0000_snapshot.json` completely
  untouched (its content, not just its filename, is generated — don't hand-edit it).
  Done when: `drizzle/` contains exactly one `.sql` file (`0000_baseline.sql`) and
  `drizzle/meta/` contains exactly `_journal.json` (single entry, `tag: "baseline"`) and
  `0000_snapshot.json`; reading `0000_baseline.sql` shows `CREATE TABLE` statements for all
  7 tables (`users`, `categories`, `youtube_channels`, `subscriptions`, `videos`,
  `ignore_rules`, `sessions`) with columns matching `src/db/schema.ts` exactly (spot-check
  against the schema file — e.g. `users` has `failed_login_attempts` and `locked_until`,
  `videos` has the 3 CHECK constraints, `subscriptions` has the `subscriptions_user_channel_unique`
  unique index) and no `ALTER TABLE`/`DROP` statements (this is a fresh-baseline `CREATE`
  set, not a migration).

- [x] 2. Wipe the local dev DB so it re-creates from the new baseline. Delete
  `data/tubeshelf.db`, `data/tubeshelf.db-shm`, `data/tubeshelf.db-wal` (all gitignored per
  `.gitignore`'s `data/*.db*` — confirm `git status` shows nothing for this deletion).
  Done when: `data/` contains only `.gitkeep`, and `git status` is clean with respect to
  `data/`.

- [x] 3. Rename the seeded username in application code: `src/db/seed.ts`'s
  `db.insert(users).values({ username: "default" })` → `{ username: "admin" }`;
  `src/lib/auth.ts`'s `applyRecoveryPasswordFromEnv` query
  `.where(eq(users.username, "default"))` → `"admin"` (leave its `console.warn` text
  — "the default user's password" — unchanged, since it describes the concept, not the
  literal value, per the spec's Design section); `src/lib/current-user.ts`'s
  `getCurrentUser` query `.where(eq(users.username, "default"))` → `"admin"` (leave its
  thrown error message — "seed did not create the default user" — unchanged, same
  reasoning). Done when: `grep -rn '"default"' src/` returns no results, and
  `grep -n '"admin"' src/db/seed.ts src/lib/auth.ts src/lib/current-user.ts` shows the 3
  updated query/insert sites.

- [x] 4. Rename the test helper in `test/helpers/auth.ts`: function `loginAsDefaultUser` →
  `loginAsAdminUser`; its `db.update(users).set(...).where(eq(users.username, "default"))`
  query → `"admin"`; its login POST body `username: "default"` → `"admin"`; and its two
  internal error-message prefixes (`"loginAsDefaultUser: login response had no Set-Cookie
  header"` and `"loginAsDefaultUser: no session cookie found in Set-Cookie header"`) →
  `"loginAsAdminUser: ..."` to match the new function name. Also update the doc comment at
  the top of the file referencing `loginAsDefaultUser()` by name. Done when:
  `grep -n 'loginAsDefaultUser\|"default"' test/helpers/auth.ts` returns no results, and
  the file exports `loginAsAdminUser` with matching internal naming throughout.

- [ ] 5. Update the 4 real call sites of the renamed helper: `test/routes/channels.test.ts`,
  `test/routes/categories.test.ts`, `test/routes/ignore-rules.test.ts`, and
  `test/routes/queue.test.ts` — each imports `loginAsDefaultUser` from
  `"../helpers/auth"` and calls `await loginAsDefaultUser()`; update both the import and
  the call to `loginAsAdminUser` in all 4 files. Note `test/routes/ignore-rules.test.ts`
  has no literal `"default"` string anywhere else in it — this is its only needed edit.
  Done when: `grep -rln 'loginAsDefaultUser' test/` returns no results, and
  `bun test test/routes/channels.test.ts test/routes/categories.test.ts
  test/routes/ignore-rules.test.ts test/routes/queue.test.ts` passes.

- [ ] 6. Update the remaining literal `"default"` username occurrences in test files that
  query `users.username` directly (not via the helper): `test/lib/nav-counts.test.ts`,
  `test/lib/scheduler.test.ts`, `test/lib/categories.test.ts`, `test/lib/subscribe.test.ts`,
  `test/routes/channels.test.ts`, `test/routes/categories.test.ts`,
  `test/routes/queue.test.ts` — each has a `.where(eq(users.username, "default"))` lookup;
  change `"default"` → `"admin"` in each. Done when:
  `grep -rln '"default"' test/lib/ test/routes/ --include='*.test.ts' | grep -v auth.test.ts`
  returns no results (auth.test.ts is handled separately in the next task), and
  `bun test test/lib/nav-counts.test.ts test/lib/scheduler.test.ts test/lib/categories.test.ts
  test/lib/subscribe.test.ts test/routes/channels.test.ts test/routes/categories.test.ts
  test/routes/queue.test.ts` passes.

- [ ] 7. Update `test/routes/auth.test.ts`: it has its own direct login flow (doesn't use
  the helper) with multiple literal `"default"` occurrences — a lookup query
  (`.where(eq(users.username, "default"))`) and several `username: "default"` values in
  login-request bodies. Change all of them to `"admin"`. Also update the code comment
  (near the top of the file, explaining why this file uses a dedicated non-`"default"` test
  user for lockout tests rather than the shared user via `loginAsDefaultUser`) to reference
  `"admin"` and `loginAsAdminUser` by their new names. Done when:
  `grep -n '"default"\|loginAsDefaultUser' test/routes/auth.test.ts` returns no results,
  and `bun test test/routes/auth.test.ts` passes with no test-order-dependent failures
  (run it at least twice in a row, per this file's existing shared-state sensitivity).

- [ ] 8. Final verification. Run `bun test`, `bun run lint`, and `bunx tsc --noEmit` clean
  across the repo (all via `devcontainer exec`). Then do manual end-to-end verification,
  split per `CLAUDE.md`'s convention:
  - **Claude performs directly** (via `devcontainer exec` / `curl` inside the devcontainer,
    per the port-forwarding gotcha in `CLAUDE.md`): with `data/tubeshelf.db*` absent (from
    task 2, or delete again if task 1–7's test runs recreated it), start the dev server
    (`bun run dev:server`, backgrounded) and confirm it boots with no migration errors;
    confirm via a direct SQLite read (`sqlite3 data/tubeshelf.db "select username from
    users;"` or equivalent) that exactly one user row exists with `username = 'admin'`
    (not `'default'`); confirm `curl -i http://localhost:3000/login` returns 200; confirm
    `POST /login` with the devcontainer's baked-in `AUTH_RECOVERY_PASSWORD` and
    `username=admin` returns a `Set-Cookie` and redirect (this also confirms
    `applyRecoveryPasswordFromEnv` correctly targeted the renamed user); confirm the same
    `POST /login` with `username=default` now fails (401 — the old username no longer
    exists). Stop the server afterward (find its PID via `/proc/[0-9]*/cmdline` per
    `CLAUDE.md`'s no-`ps` gotcha and `kill` it).
  - **User performs live in a browser**: visit the app, log in with username `admin` and
    the devcontainer's recovery password, and confirm you land on `/queue` as normal with
    no visible change in behavior (this is an internal rename — the login form itself is
    unchanged, only the credential value is different).
  - Done when: all three commands are clean, Claude's curl/DB-read checks above all pass,
    and the user confirms the browser login works with `admin`. Then update
    `docs/specs/013-db-squash-and-admin-rename.md`'s frontmatter to `status: implemented`.
