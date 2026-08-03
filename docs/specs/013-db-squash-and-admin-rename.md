---
status: in-progress
created: 2026-08-03
---

# DB Squash + Default User Rename (default → admin)

## Context

Per `docs/app_idea.md`'s "Path to v1.0", step 3, now that styling (spec011) and auth/CSRF
(spec012) are both `implemented`, the next pre-v1.0 sequencing item is collapsing the
repo's accumulated Drizzle migrations into one clean baseline — deliberately sequenced
*after* auth so its own schema additions (the `sessions` table, `users.failedLoginAttempts`
/ `users.lockedUntil`) get caught by the squash too, rather than surviving as leftover
dev-time churn past an earlier squash point. `app_idea.md` explicitly authorizes doing this
aggressively: the app has never been deployed, so there's no real user data or migration
path to preserve.

The repo currently has 6 migrations (`drizzle/0000_steady_wild_pack.sql` through
`drizzle/0005_misty_jasper_sitwell.sql`), accumulated one-or-more-per schema-touching spec
across MVP, styling, and auth development.

This spec originates from `docs/features/004-db-squash-and-admin-rename.md`
(`status: refined`), which already resolved the bulk of scope through a `/new-feature`
pass — including bundling in a second, unrelated-but-small change: renaming the seeded
single-user account's username from `default` to `admin`. That rename rides along on this
spec specifically because it shares the same "no real data at stake, safe to do directly"
property as the squash itself, not because it's otherwise related to migrations.

## Scope

**In scope:**
- Collapse all 6 existing migrations into a single baseline migration matching the current
  `src/db/schema.ts` exactly (no schema changes — this is a pure history collapse).
- Rename the seeded username from `"default"` to `"admin"` in application code
  (`src/db/seed.ts`, `src/lib/auth.ts`, `src/lib/current-user.ts`) and test code (9 test
  files containing the literal `"default"` string — see Design section for the exact,
  independently-verified list).
- Rename the test helper `loginAsDefaultUser` → `loginAsAdminUser`
  (`test/helpers/auth.ts`), updating its 4 call sites, plus `test/routes/ignore-rules.test.ts`
  (see Design section — this file calls the helper but contains no literal `"default"`
  string itself, so it's a 10th touched test file not captured by the count above).
- Wipe the local dev DB (`data/tubeshelf.db*`, gitignored) so it re-creates cleanly against
  the new baseline + renamed seed on next server start.

**Explicitly out of scope:**
- Deployment/Docker packaging (Path to v1.0 step 4 — comes after this).
- GitHub CI/CD buildout (Path to v1.0 step 5).
- Any actual schema change. This spec touches zero columns/tables/constraints — the
  post-squash `drizzle-kit generate` output must be a byte-for-byte-equivalent schema to
  today's, just expressed as one migration instead of six. If a diff shows up, that's a
  bug in the squash process, not an intentional change to fold in here.
- Any real multi-user support (still v2.0 per `app_idea.md`).
- Editing any existing spec or task file's prose — several `implemented` specs beyond just
  012 also quote `"default"` (e.g. 001, 002, 004, 008 and their task files). All are left
  untouched as a historical record of the decision at the time, per the feature file's
  resolved decision (which called out 012 specifically as the most relevant example, not
  as the only one).

## Design

### Migration squash mechanics

1. Delete `drizzle/*.sql` and everything under `drizzle/meta/` (the journal +
   per-migration snapshots).
2. Run `drizzle-kit generate` (`bun run db:generate` via `devcontainer exec`) against the
   now-empty `drizzle/` output directory. Because there's no prior snapshot to diff
   against, this emits a single set of `CREATE TABLE` statements straight from
   `src/db/schema.ts` — critically, this sidesteps the interactive-TTY rename-ambiguity
   prompt noted in `CLAUDE.md` (that prompt only fires when diffing against an *existing*
   snapshot to disambiguate a rename, e.g. spec002's `channels` → `youtube_channels` split;
   generating from nothing has no ambiguity to resolve).
3. Rename the generated migration file and its journal `tag` from Drizzle's
   auto-generated adjective-noun name (e.g. `0000_random_name.sql`) to
   `0000_baseline.sql` / tag `baseline`. Reasoning: the whole point of a squash is a clean,
   legible starting point for anyone reading `drizzle/` later — an auto-generated name
   would obscure that this file is deliberately the collapsed baseline rather than just
   migration zero of a fresh project. This is a manual edit to the generated `.sql`
   filename and the `tag` field in `drizzle/meta/_journal.json` only; the SQL content and
   the snapshot in `drizzle/meta/0000_snapshot.json` are left exactly as generated.
4. Delete `data/tubeshelf.db`, `data/tubeshelf.db-shm`, `data/tubeshelf.db-wal` (all
   gitignored per `.gitignore`'s `data/*.db*`, so this touches no tracked files). No
   separate manual migrate step is needed afterward: `src/index.ts` calls
   `runMigrations()` (via `drizzle-orm/bun-sqlite/migrator`, `src/db/migrate.ts`) and then
   `seed(db)` unconditionally on every server start, so the next `bun run dev` (or any test
   run — see below) recreates the DB file from the new baseline and reseeds it from
   scratch.

### Why this also affects the test suite, not just prod/dev DB files

Tests don't push the schema directly against an in-memory DB — every test file that touches
the DB runs the *actual* `drizzle/` migration files via `drizzle-orm/bun-sqlite/migrator`
pointed at the `./drizzle` folder, either indirectly (importing `src/db/client.ts`, whose
module-level `runMigrations()` call most test files rely on) or, in `test/smoke.test.ts`'s
case, by constructing its own in-memory `Database`/`drizzle()` instance and calling
`migrate(db, { migrationsFolder: "./drizzle" })` directly — same folder, different
mechanism. Either way, the squashed baseline is what the whole test suite applies on every
run, not merely a prod-deployment concern. The primary guarantee that the squashed baseline
is schema-equivalent to the original six is `drizzle-kit generate`'s determinism against an
*unchanged* `schema.ts` (per the "Explicitly out of scope" note above — no schema edits
happen in this spec); `bun test` passing cleanly is corroborating evidence on top of that,
not the primary proof — it doesn't directly exercise every CHECK constraint
(`status_check`, `watched_at_check`, `name_length_check`, `ignore_method_check` in
`src/db/schema.ts`), so a subtle SQL-serialization difference wouldn't necessarily fail a
test.

### Username rename mechanics

Literal `"default"` username string occurrences (confirmed via repo-wide grep,
independently re-verified during this spec's red-team pass — this list is exhaustive for
the literal string, not illustrative):
- `src/db/seed.ts` — seed insert (`db.insert(users).values({ username: "default" })`)
- `src/lib/auth.ts:39` — `applyRecoveryPasswordFromEnv`'s lookup query
- `src/lib/current-user.ts:9` — `getCurrentUser`'s lookup query
- `test/helpers/auth.ts:24,34` — `loginAsAdminUser` (post-rename) lookup query + login
  POST body
- `test/lib/nav-counts.test.ts:22`, `test/lib/scheduler.test.ts:23`,
  `test/lib/categories.test.ts:22`, `test/lib/subscribe.test.ts:22`,
  `test/routes/channels.test.ts:27`, `test/routes/categories.test.ts:39`,
  `test/routes/queue.test.ts:30`, `test/routes/auth.test.ts:39,74,82,92,102,172,196` — each
  has its own direct lookup query against `users.username` (or, in `auth.test.ts`'s case,
  several — it exercises login directly rather than through the helper)

One additional file needs editing despite containing no literal `"default"` string:
`test/routes/ignore-rules.test.ts:3,21` imports and calls `loginAsDefaultUser()` — once the
helper is renamed, this call site must be updated to `loginAsAdminUser()` even though grep
for the literal string wouldn't surface this file. (Caught during this spec's red-team
pass — the original draft's file list, inherited from the feature file, missed it because
it only tracked literal-string occurrences, not helper call sites.)

Conceptual prose that mentions "the default user" *without* quoting the literal string
(e.g. `auth.ts`'s `console.warn` text, `current-user.ts`'s thrown error message, the
`.devcontainer/devcontainer.json` comment above `AUTH_RECOVERY_PASSWORD`) is **not** changed
— it remains accurate regardless of what the seeded username actually is, since it's
describing the concept of "the one seeded/recovery-target account," not asserting its
literal value.

`loginAsDefaultUser` → `loginAsAdminUser`: both the function name and its internal literal
`"default"` username change together, plus its 4 actual call sites —
`test/routes/channels.test.ts:21`, `test/routes/categories.test.ts:26`,
`test/routes/ignore-rules.test.ts:21`, `test/routes/queue.test.ts:24` — so the helper's name
keeps describing what it actually logs in as. (`test/routes/auth.test.ts:30` only mentions
the old name inside a code comment explaining why that file deliberately does its own
direct login instead of using the helper; that comment gets updated to the new name too,
but it's not a call site.)

### Ordering / independence

The two halves of this spec (migration squash, username rename) touch disjoint files and
have no sequencing dependency on each other — they can be done in either order or
interleaved. `/spec-tasks` may split them into separate task groups for clarity, but
neither blocks the other.

## Open Questions

None. The feature file (`docs/features/004-db-squash-and-admin-rename.md`) already resolved
the two genuine ambiguities (test-helper rename, historical-spec-prose handling) through its
own `/new-feature` pass; this spec's Design section resolves the remaining mechanical
questions (squashed-migration naming, exact rename footprint) directly, as they had a single
clearly-correct answer rather than a real tradeoff to weigh with the user.

**Red-team retrospective:** One independent pass (general-purpose agent, no memory of the
drafting conversation) was run against the first draft. It caught several factual errors
inherited/compounded from the feature file's file list, all fixed directly in this spec:
the test-file count was wrong (claimed 11, actually 9 files contain the literal `"default"`
string); the `loginAsDefaultUser` call-site count was wrong (claimed 6, actually 4, with one
more mention in a comment); `test/routes/ignore-rules.test.ts` was missing entirely from
the file list — it calls the helper but contains no literal `"default"` string, so a
grep-only pass silently missed it; and the test-suite claim in Design overstated that
"every test file imports `src/db/client.ts`" when `test/smoke.test.ts` constructs its own
migrator call directly against the same `./drizzle` folder. Two lower-severity nitpicks
(the out-of-scope note singling out spec012 as if uniquely exempted, and an overclaim that
`bun test` alone proves schema-equivalence) were also softened. A narrower follow-up check,
scoped only to the corrected file/call-site lists and the reworded test-suite section above,
found no further issues — no second full pass was needed.
