# Tasks: Behavior Correctness & Ops Polish
Spec: docs/specs/031-behavior-correctness-ops-polish.md
Generated: 2026-10-03

Notes for every step: run commands via the devcontainer (CLAUDE.md). The spec's doc pointers
(`docs/app_idea.md` ×3, spec007, spec012, spec014) are already committed on this branch —
task 12 only verifies them. Don't touch Round A surfaces (`requireAuth`, CSP, the inline
`onerror=`/`onsubmit=` handlers in `watching-page.tsx`).

- [x] 1. Scope `categoryChannelCount` to the current user's active subscriptions — in
  `src/lib/categories.ts` change `categoryChannelCount(categoryId)` to
  `categoryChannelCount(userId, categoryId)` filtering `eq(subscriptions.userId, userId)`,
  `eq(subscriptions.categoryId, categoryId)` and `isNull(subscriptions.unsubscribedAt)` (use
  `and`), and update its one caller in `listCategoriesWithCounts`. Rewrite the existing
  `test/lib/categories.test.ts` test "channelCount counts subscriptions across users and
  includes unsubscribed rows" into one asserting an unsubscribed row and another user's
  subscription to the same category are ignored while an active one counts (call `seed(db)`
  *before* inserting a second user; leave no state that breaks other files). — done when:
  `bun test test/lib/categories.test.ts test/routes/categories.test.ts`, `bun run lint`,
  and `bunx tsc --noEmit` are clean.

- [x] 2. Add `videos.auto_ignore_exempt` column + migration `0005` — in `src/db/schema.ts` add
  `autoIgnoreExempt: integer("auto_ignore_exempt", { mode: "boolean" }).notNull().default(false)`
  to `videos` (same shape as `categories.isSystem`). `drizzle-kit generate` may need a real
  TTY: try `bun run db:generate` via devcontainer, and if it prompts/hangs do NOT work around
  it — hand the user the exact command to run in their own terminal and wait. Inspect the
  generated `drizzle/0005_*.sql`: expected a single `ALTER TABLE videos ADD
  auto_ignore_exempt integer DEFAULT false NOT NULL;`. If a table rebuild appears, its
  `INSERT … SELECT` must not reference the new column (spec029 task 12 phantom-column
  corruption). — done when: migration file + `drizzle/meta` snapshot/journal committed, SQL
  verified as above, and `bun test` plus `bunx tsc --noEmit` are clean (test DB applies
  migrations).

- [x] 3. `unignoreVideo` sets the exemption — in `src/lib/watch-status.ts` add
  `autoIgnoreExempt: true` to `unignoreVideo`'s `.set(...)` (the only writer; nothing clears
  it). Extend `test/lib/watch-status.test.ts`: `unignoreVideo` sets `autoIgnoreExempt` from
  both a manual and an auto ignore; other transition functions (watching/watched/unwatched/
  ignore) leave it unchanged. — done when: `bun test test/lib/watch-status.test.ts` passes.

- [x] 4. `reconcileIgnoreRules` honors the exemption and skips `watching` — in
  `src/lib/ignore-rules.ts` change the second-pass candidate predicate from
  `inArray(videos.status, ["unwatched", "watching"])` to
  `and(eq(videos.status, "unwatched"), eq(videos.autoIgnoreExempt, false))`; drop the unused
  `inArray` import; update the comment block above `reconcileIgnoreRules` (currently says
  "unwatched/watching" and quotes MVP item 6) to describe the new behavior. First pass
  unchanged. Tests: in `test/lib/ignore-rules.test.ts` REPLACE "auto-ignores a watching video
  that newly matches a just-added rule" with: a `watching` video newly matching is NOT
  auto-ignored; an `unwatched` exempt matching video is not auto-ignored; an `unwatched`
  non-exempt one still is; an exempt `ignored`+`manual` video is untouched. Add to
  `test/lib/ingest.test.ts` a check that a new matching video still inserts as
  `ignored`/`auto`. Add the route-level regression in `test/routes/ignore-rules.test.ts` (or
  `queue.test.ts`): add rule → video auto-ignored → `POST /videos/:id/unignore` → add/edit
  another still-matching rule → video stays `unwatched`. — done when: `bun test`,
  `bun run lint`, `bunx tsc --noEmit` clean.

- [x] 5. Watching page: no auto-timer for ignored videos — in `src/views/watching-page.tsx`
  change `showAutoTimer` to `props.status !== "watched" && props.status !== "ignored"`. No
  route change; leave inline `onerror`/`onsubmit` handlers alone. Add to
  `test/routes/queue.test.ts`: `GET /watching/:id` for an `ignored` video has no
  `hx-trigger="load delay:10s"` and shows the "Ignored" badge; for an `unwatched` video it
  still contains the timer. — done when: `bun test test/routes/queue.test.ts` passes.

- [x] 6. Logger text mode renders object values as JSON — in `src/lib/logger.ts`, in the
  text-mode formatter (where `key=value` pairs are built; find it near `normalizeMeta`), render
  values with `typeof value === "object" && value !== null` via `JSON.stringify(value)`,
  falling back to `String(value)` if stringify throws or returns `undefined`. Primitives,
  `null`, functions, and top-level `Error` rendering unchanged; JSON mode unchanged. Tests in
  `test/lib/logger.test.ts`: `{a:1}` → `meta={"a":1}`, an array likewise, a circular object
  doesn't throw (falls back to `String`), Error and primitive rendering unchanged, JSON mode
  unchanged. — done when: `bun test test/lib/logger.test.ts` passes.

- [ ] 7. Login form attributes — in `src/views/login-page.tsx` add `autocomplete="username"`
  and `required` to the username input, and `autocomplete="current-password"` and `required`
  to the password input (`name="password"`). No server change. Add to
  `test/routes/auth.test.ts`: `GET /login` markup contains both autocomplete values and
  `required` on both inputs. — done when: `bun test test/routes/auth.test.ts` passes.

- [ ] 8. `ensureAdminPassword` in `src/lib/auth.ts` + boot wiring — export
  `ensureAdminPassword(): Promise<void>`: read the `admin` user's `passwordHash`; no admin row
  → return silently; non-null hash → return; else generate
  `randomBytes(18).toString("base64url")`, `hashPassword` it, conditional update `WHERE
  username = 'admin' AND password_hash IS NULL`, and only if `changes === 1` `logger.warn`
  the plaintext once (message names the username, says it won't be shown again, and says to
  use `AUTH_RECOVERY_PASSWORD` to replace it). 0 changes → log nothing. Call it in
  `src/index.ts` immediately after `await applyRecoveryPasswordFromEnv()`. `seed.ts` unchanged;
  no file written to `/data`. Tests in `test/lib/auth.test.ts` (new or existing): null hash →
  hash set, verifies against the plaintext captured by spying on `console.error` (WARN goes
  there), logged exactly once; non-null hash → no-op, no log; a hash set by
  `applyRecoveryPasswordFromEnv` is left untouched; no `admin` row → silent no-op. The test
  must null the shared admin hash and restore it in `finally` (pattern in
  `test/routes/auth.test.ts`). — done when: `bun test`, `bun run lint`, `bunx tsc --noEmit`
  clean.

- [ ] 9. Compose tolerates a missing `.env` — in `docker-compose.yml` replace
  `env_file: - .env` with `env_file: [{ path: .env, required: false }]` (long syntax; needs
  Compose ≥ 2.24). Verify: `podman-compose config` (host has podman-compose 1.6.0, no docker)
  parses with no `.env`, and — beyond `config` — try a runtime `up` in a throwaway directory
  with no `.env` to confirm a missing file is tolerated. — done when: change made and the
  report states exactly what was and wasn't verified (config vs. runtime). Clean up the
  throwaway directory/containers.

- [ ] 10. Deployment docs and `.env.example` — `docs/DEPLOYMENT.md`: Quick start step 2
  (`cp .env.example .env`) becomes optional; §3 "Initial login" documents the generated
  first-boot password (`docker compose logs tubeshelf`), keeps the `AUTH_RECOVERY_PASSWORD`
  flow as the way to replace/recover it (drop "the *only* way to set"), notes the
  `LOG_LEVEL=error` caveat (WARN line hidden, not re-emitted next boot), and notes Compose ≥
  2.24; also fix the env-var table row for `AUTH_RECOVERY_PASSWORD` if it contradicts.
  `.env.example`: update the `AUTH_RECOVERY_PASSWORD` comment ("Not required for MVP…" →
  leaving it unset generates a random password on first boot, logged once). — done when:
  docs read consistently with spec section 4 and no remaining claim that
  `AUTH_RECOVERY_PASSWORD` is the only way to set the password (`grep -n "only" docs/DEPLOYMENT.md`).

- [ ] 11. Manual end-to-end verification (Claude-performed part) — per CLAUDE.md. Using a
  temp `DB_FILE_NAME` and `env -u AUTH_RECOVERY_PASSWORD`: fresh-DB boot logs exactly one WARN
  with a password that `DEV_LOGIN_PASSWORD=<logged> scripts/dev-login.sh` accepts; a second
  boot logs nothing and login still works. `PRAGMA table_info(videos)` on the dev DB shows
  `auto_ignore_exempt` with existing rows defaulting `0` (write bun:sqlite queries to a file,
  not inline). `curl` (inside container, via `scripts/dev-login.sh` cookies) `/watching/:id`
  for an ignored vs. unwatched throwaway video: no timer vs. timer. Delete throwaway rows/
  files after. — done when: each check's result is reported.

- [ ] 12. Manual verification (user-performed in a browser) — give the user exact URLs and
  what to look for: login form autofill/required behavior (`/login`); category page channel
  count after unsubscribing a channel in that category; un-ignore → rule edit round trip
  (auto-ignored video stays unwatched after editing a still-matching rule). Also verify the
  doc pointers listed in the spec's Design §2 exist (`grep -n 031 docs/app_idea.md
  docs/specs/007*.md docs/specs/012*.md docs/specs/014*.md`). — done when: the user reports
  results back.

- [ ] 13. Final verification, flip spec to implemented, open the PR — run `bun test`,
  `bun run lint`, `bunx tsc --noEmit`, and `bun run fallow` clean across the repo; set
  `docs/specs/031-behavior-correctness-ops-polish.md` frontmatter to `status: implemented`.
  Draft the PR (summary + test plan; end with the Claude Code attribution line) per
  CLAUDE.md's git workflow: check this step's box *before* pushing, commit, then ask whether
  the user is pushing or Claude should; never merge. — done when: all four commands are
  green, spec is `implemented`, this file is fully checked, and the PR is open (or the user
  has been handed the push/PR command).
