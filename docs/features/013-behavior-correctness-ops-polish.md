---
status: refined
created: 2026-10-03
---

# Behavior Correctness & Ops Polish

## Problem / Motivation

A full-codebase review (2026-10-03; tests/lint/tsc/fallow all green, none of these seen in
production) found a cluster of user-visible behavior bugs and small operational rough
edges outside the ingestion/enrichment and auth/security paths: a wrong per-category channel
count, an ignore-rule reconciliation pass that undoes a user's explicit un-ignore (and eats
in-progress `watching` videos), an auto-timer that fires on ignored videos, a first-boot
state where nobody can log in, a compose file that errors without a `.env`, a logger that
prints `[object Object]`, and a login form missing browser-friendly attributes. This is
Round C of a three-spec hardening roadmap (B → C → A). Round B (ingestion/enrichment,
`docs/specs/030-ingestion-enrichment-robustness.md`, PR #29) is merged; Round A
(auth/security) follows this one, so this feature deliberately does **not** touch the
session/CSRF/CSP surface.

## Firm Scope

1. **Category channel count (#7).** `categoryChannelCount` (`src/lib/categories.ts`) counts
   every `subscriptions` row for the category — including unsubscribed ones and other
   users'. Scope it to `unsubscribed_at IS NULL` and the current user (takes `userId` like
   its sibling `categoryUnwatchedCount`; `listCategoriesWithCounts` already has `userId`).
2. **Auto-ignore exemption (#8).** Add a column on `videos` (migration **0005**; 0004 is
   Round B's `peaceful_gressill`) marking a video as exempt from auto-ignore.
   `unignoreVideo` (`src/lib/watch-status.ts`) sets it; `reconcileIgnoreRules`
   (`src/lib/ignore-rules.ts`) never re-ignores an exempt video. Today un-ignoring an
   auto-ignored video that still matches a rule is silently undone by the next rule
   add/edit/delete. Ingest-time behavior for *new* videos is unchanged (`src/lib/ingest.ts`
   only auto-ignores on first insert and deliberately never touches status on update).
   Also stop `reconcileIgnoreRules` from auto-ignoring `watching` videos — today it does,
   and un-ignore resets to `unwatched`, losing progress. This changes the reconcile
   candidate set from `unwatched`/`watching` to `unwatched` only. Cite spec007 and
   `docs/app_idea.md` MVP item 6 (which currently says "Unwatched/Watching video that
   newly matches gets auto-ignored") and add an inline pointer there plus on the Video data
   model entry (line ~132) per CLAUDE.md.
3. **Watching page for ignored videos (#9).** `/watching/:id` (`src/routes/queue.tsx`,
   `src/views/watching-page.tsx`) still renders for an `ignored` video, but with no 10s
   auto-timer (`showAutoTimer` currently only excludes `watched`) and no automatic status
   change. The explicit "Mark Watching" button still works (`setWatching` doesn't check
   status and clears `ignoreMethod`).
4. **First-boot password (#19).** If the admin user's `password_hash` is null after
   seeding and `AUTH_RECOVERY_PASSWORD` is unset/empty, generate a random password, hash
   and store it, and log the plaintext **once** at WARN (`src/db/seed.ts` /
   `src/lib/auth.ts`; seed currently inserts `{ username: "admin" }` with a null hash, so
   a fresh deploy with no env var can't log in at all). Also `docker-compose.yml`:
   `env_file: - .env` → `env_file: [{ path: .env, required: false }]` (compose errors if
   `.env` is missing); update `README.md` and `.env.example` docs to match.
5. **Logger object values (#20).** Text mode in `src/lib/logger.ts` prints
   `key=[object Object]` for non-Error object values (`${key}=${value}`). `JSON.stringify`
   non-primitives there.
6. **Login form attributes (minor).** `src/views/login-page.tsx`:
   `autocomplete="username"` / `"current-password"` and `required` on both inputs.

## Explicitly Out of Scope

- Everything in Round A: requireAuth running 4× per request, `getCurrentUser()` vs session
  user, CSP/inline scripts, lockout messaging, session purging, cookie `Secure` derivation,
  `window.open` noopener. (Note the thumbnail `onerror=` handlers in `watching-page.tsx` are
  also Round A's — don't touch them here even though #9 edits that file.)
- Dropped everywhere: #18 channel-handle scraping, `/ignored` ordering by `createdAt`, bare
  fragment on direct `?cursor` GET, `watchedCount` including unsubscribed channels
  (deliberate history), `parseChannelInput` unanchored match.
- Surfacing a UI for converting an auto-ignored video to manual (still deferred per spec007).

## Related Specs / Code

- `docs/specs/007-ignore-rules-and-ignored-view.md`; `docs/app_idea.md` MVP item 6 and the
  Video/IgnoreRule data-model entries.
- `docs/specs/009-unwatched-counters-and-category-links.md` (category counts),
  `docs/specs/012-auth-and-csrf.md` (recovery password / seed), `docs/specs/028-structured-logging.md`
  (logger), `docs/specs/004-watch-flow-queue-views.md` (watching page/timer).
- `docs/specs/030-ingestion-enrichment-robustness.md` — most recent migration (0004) and
  the reference for how a feature's column + Round-B cross-pointers were done.
- Code: `src/lib/categories.ts`, `src/lib/ignore-rules.ts`, `src/lib/watch-status.ts`,
  `src/lib/ingest.ts`, `src/db/schema.ts`, `src/db/seed.ts`, `src/lib/auth.ts`,
  `src/index.ts`, `src/routes/queue.tsx`, `src/views/watching-page.tsx`,
  `src/views/login-page.tsx`, `src/lib/logger.ts`, `docker-compose.yml`, `.env.example`,
  `README.md`.

## Resolved Decisions

1. **Exemption column is a boolean** `videos.auto_ignore_exempt` (notNull, default false;
   migration 0005 is a single `ALTER TABLE ADD COLUMN`). Why: simplest fit; nothing would
   read a timestamp.
2. **Never cleared.** `unignoreVideo` is its only writer; a manual `ignoreVideo` already
   yields `ignoreMethod=manual` (never reconciled), and other transitions leave it alone.
   Why: one writer, no extra writes; an un-ignore is a durable "don't auto-ignore this."
   New videos at ingest are never exempt (insert path unchanged).
3. **`watching` exclusion only affects the auto-ignore pass.** Candidates become
   `status = 'unwatched' AND NOT auto_ignore_exempt`. The auto-un-ignore pass (ignored+auto
   no longer matching) is unchanged. No data migration for videos auto-ignored out of
   `watching` in the past (can't be identified; user can un-ignore them, which also
   exempts them).
4. **First-boot password:** after `seed` and `applyRecoveryPasswordFromEnv` in
   `src/index.ts`, if the admin hash is still null (so `AUTH_RECOVERY_PASSWORD` was
   unset/empty), generate a random password, store its bcrypt hash, and log the plaintext
   once via `logger.warn`. Fires only on true first boot (hash non-null afterwards). Log
   only — no file in `/data` (no plaintext secret on disk). This supersedes spec012's note
   that a null hash is the correct fresh-seed state: the *seed* still inserts null (so
   `seed.ts` and the DB constraint are unchanged), only the boot sequence fills it in; cite
   spec012 in the new spec. There is no password-change UI, so a lost generated password
   is recovered via `AUTH_RECOVERY_PASSWORD` as documented.
5. **Docs:** `docs/DEPLOYMENT.md` (not README, which only links to it) gets the
   first-boot-password note (`docker compose logs`) and drops the now-optional
   `cp .env.example .env` as a hard step; mention that `required: false` needs Compose
   >= 2.24. `.env.example` comment for `AUTH_RECOVERY_PASSWORD` updated accordingly.
6. **Logger:** non-primitive, non-Error values in text mode are `JSON.stringify`'d, with a
   `String(value)` fallback if stringify throws (circular). JSON mode unchanged.

### Missing-pass findings (folded into scope)

- Reconcile and #9 stay consistent: an ignored video whose user presses "Mark Watching"
  becomes `watching` and is now never re-ignored by rules, which is the intended meaning of
  excluding `watching`.
- A `watched -> unwatched` toggle can still be re-ignored by a later rule change (the video
  isn't exempt); accepted, not in scope.
- Spec/doc pointers: spec007's text and `docs/app_idea.md` MVP item 6 / Video / IgnoreRule
  entries get inline pointers to the new spec (watching exclusion + exemption); spec012's
  null-hash note gets one too.
