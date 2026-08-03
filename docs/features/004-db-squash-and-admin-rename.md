---
status: refined
created: 2026-08-03
---

# DB Squash + Default User Rename (default → admin)

## Problem / Motivation
Per `docs/app_idea.md`'s "Path to v1.0", step 3 (DB squash) is the next post-MVP sequencing
item, now that styling (spec011) and auth/CSRF (spec012) are both `implemented`. The repo
has accumulated 6 Drizzle migrations (`drizzle/0000`–`0005`) across MVP, styling, and auth
development. The roadmap explicitly calls for collapsing these into one clean baseline
before deployment/Docker packaging work begins, and explicitly authorizes doing this
aggressively since the app has never been deployed (no real user data/migration path to
preserve).

Piggybacking on this same pass: rename the seeded/default single-user account's username
from `default` to `admin`. This is a small, self-contained rename with no real user data at
stake, so it's being bundled into the same no-real-data-to-preserve squash work rather than
spun into its own spec.

## Firm Scope
- Collapse all existing Drizzle migrations into a single baseline migration reflecting the
  current schema.
- Rename the seeded default user's username from `default` to `admin` in `src/db/seed.ts`
  and wherever else it's referenced in application code.
- Local dev DB gets wiped and re-migrated from the new single baseline (no data preserved,
  per app_idea.md's explicit authorization).

## Nice-to-have / Stretch Scope
(none yet)

## Explicitly Out of Scope
- Deployment/Docker packaging (Path to v1.0 step 4 — comes after this).
- GitHub CI/CD buildout (Path to v1.0 step 5).
- Any actual multi-user support (still v2.0 per app_idea.md).

## Related Specs / Code
- `docs/app_idea.md` — "Path to v1.0" section, steps 3–5.
- `drizzle/0000_steady_wild_pack.sql` through `drizzle/0005_misty_jasper_sitwell.sql`, and
  `drizzle/meta/` (journal + snapshots).
- `src/db/seed.ts` — seeds the default user.
- `src/lib/auth.ts`, `src/lib/current-user.ts` — reference the default username.
- `test/helpers/auth.ts` — `loginAsDefaultUser` helper, used across route tests.
- `docs/specs/012-auth-and-csrf.md` / `docs/specs/tasks/012-auth-and-csrf.md` — most recent
  schema-touching spec (sessions table, users columns for lockout).

## Open Questions
(none remaining)

## Resolved Decisions
- **Test helper rename:** `loginAsDefaultUser` (`test/helpers/auth.ts`, used by 6 test
  files) is renamed to `loginAsAdminUser` alongside the literal `"default"` → `"admin"`
  string change. Why: the helper name should describe what it actually does, not go stale
  relative to the username it logs in as.
- **Historical spec012 prose left untouched:** `docs/specs/012-auth-and-csrf.md` and its
  task file (both `status: implemented`) keep their existing `"default"` references as-is.
  Why: they're closed specs — a historical record of the decision at the time — consistent
  with how other implemented specs aren't rewritten when later work changes something they
  describe.
- **Rename footprint confirmed via research:** literal `"default"` username string appears
  in `src/db/seed.ts` (seed insert), `src/lib/auth.ts` (recovery-password lookup query),
  `src/lib/current-user.ts` (current-user lookup query), and 11 test files (`test/helpers/
  auth.ts`, `test/lib/nav-counts.test.ts`, `test/lib/scheduler.test.ts`, `test/lib/
  categories.test.ts`, `test/routes/channels.test.ts`, `test/routes/categories.test.ts`,
  `test/lib/subscribe.test.ts`, `test/routes/queue.test.ts`, `test/routes/auth.test.ts`).
  No user-facing template/view text or README hardcodes the string, so no product-copy
  changes are needed.
