---
status: draft
created: 2026-10-03
---

# Behavior Correctness & Ops Polish

## Context

A full-codebase review (2026-10-03; tests/lint/tsc/fallow all green, none of the bugs seen
in production) found a cluster of user-visible behavior bugs and operational rough edges
outside the ingestion/enrichment and auth/security paths. This is Round C of a three-spec
hardening roadmap (B → C → A). Round B
(`docs/specs/030-ingestion-enrichment-robustness.md`, PR #29) is merged; Round A
(auth/security) follows and owns the session/CSRF/CSP surface, which this spec deliberately
does not touch. Source of scoping and resolved decisions:
`docs/features/013-behavior-correctness-ops-polish.md` (`status: refined`). Related specs:
`007-ignore-rules-and-ignored-view.md`, `009-unwatched-counters-and-category-links.md`,
`004-watch-flow-queue-views.md`, `012-auth-and-csrf.md`, `028-structured-logging.md`.

The feature file's code citations were re-checked against the current tree. Two things had
drifted and are handled here rather than in the feature file: `unignoreVideo`/`setWatching`
etc. now take `(videoId, userId)` (ownership-scoped via `ownedVideo`, since spec024), and
`docs/app_idea.md` makes three statements (MVP item 6, the Video entry, the IgnoreRule
entry) that this spec refines, not just two.

## Scope

**In:**

1. `categoryChannelCount` counts only the current user's active subscriptions.
2. Auto-ignore exemption: `videos.auto_ignore_exempt` (migration `0005`), set by
   `unignoreVideo`, honored by `reconcileIgnoreRules`; reconcile no longer auto-ignores
   `watching` videos.
3. `/watching/:id` for an `ignored` video renders without the 10s auto-timer.
4. First-boot generated admin password (logged once at WARN) when no
   `AUTH_RECOVERY_PASSWORD` is set; `docker-compose.yml` tolerates a missing `.env`; docs
   updated to match.
5. Logger text mode renders object values as JSON instead of `[object Object]`.
6. Login form gets `autocomplete`/`required` attributes.

**Out:**

- Everything in Round A (`requireAuth` running 4× per request, `getCurrentUser()` vs. session
  user, CSP/inline scripts, lockout messaging, session purging, cookie `Secure` derivation,
  `window.open` noopener). The thumbnail `onerror=` / form `onsubmit=` inline handlers in
  `watching-page.tsx` are Round A's too — don't touch them even though item 3 edits that
  file.
- Dropped everywhere: channel-handle scraping fragility, `/ignored` ordering by `createdAt`,
  bare fragment on direct `?cursor` GET, `watchedCount` including unsubscribed channels
  (deliberate history), `parseChannelInput` unanchored match.
- A UI to convert an auto-ignored video to manual (still deferred per spec007).
- A password-change UI (a lost generated password is recovered via
  `AUTH_RECOVERY_PASSWORD`, as already documented).
- Data migration for videos auto-ignored out of `watching` in the past (not identifiable).

## Design

### 1. Category channel count (`src/lib/categories.ts`)

`categoryChannelCount` currently counts every `subscriptions` row for the category —
unsubscribed rows and other users' rows included. Change it to
`categoryChannelCount(userId, categoryId)` filtering
`eq(subscriptions.userId, userId)` and `isNull(subscriptions.unsubscribedAt)`, mirroring its
sibling `categoryUnwatchedCount(userId, categoryId)` (argument order included).
`listCategoriesWithCounts` already has `userId`; no caller outside this file changes. Why
user-scoped even though the app is single-user: the sibling already is, and the multi-user
schema is modeled deliberately (`docs/app_idea.md` §4).

### 2. Auto-ignore exemption (`src/db/schema.ts`, migration 0005, `ignore-rules.ts`, `watch-status.ts`)

**Problem.** Un-ignoring an auto-ignored video that still matches a rule is silently undone
by the next rule add/edit/delete (`reconcileIgnoreRules` sees an `unwatched` video matching a
rule and re-ignores it). Separately, reconcile's candidate set includes `watching`, so an
in-progress video gets auto-ignored and un-ignore resets it to `unwatched`, losing progress.

**Schema.** Add `autoIgnoreExempt: integer("auto_ignore_exempt", { mode: "boolean" })
.notNull().default(false)` to `videos` (same shape as `categories.isSystem`). Migration
`0005` is expected to be a single `ALTER TABLE videos ADD auto_ignore_exempt integer DEFAULT
false NOT NULL;` (SQLite allows `ADD COLUMN … NOT NULL` with a non-null default; no CHECK is
added, so no table rebuild). **Verify the generated SQL**: if a rebuild appears, its
`INSERT … SELECT` must not reference the new column (spec029 task 12's phantom-column
corruption, as referenced in spec030). `drizzle-kit generate` may need a real TTY — hand the
user the command rather than running it (CLAUDE.md). Boolean over a timestamp because
nothing would read a timestamp.

**Writers.** `unignoreVideo` is the *only* writer: it adds `autoIgnoreExempt: true` to its
`set`. Nothing ever clears it. Why: an un-ignore is a durable "don't auto-ignore this"; a
manual `ignoreVideo` already yields `ignoreMethod = 'manual'` (reconcile never touches it),
and the other transitions don't need to know about the flag. This applies to an un-ignore of
a *manual* ignore too (so a later rule can't auto-ignore a video the user explicitly
rescued) — consistent with the same "durable" reading. Ingest is unchanged: new videos
insert with the default `false` and `src/lib/ingest.ts`'s upsert `set` doesn't include the
column, so re-ingest never touches it.

**Reader.** `reconcileIgnoreRules` second pass changes its candidate predicate from
`inArray(videos.status, ["unwatched", "watching"])` to
`and(eq(videos.status, "unwatched"), eq(videos.autoIgnoreExempt, false))`. `inArray` is then
unused in `ignore-rules.ts` (drop the import — lint's `noUnusedImports`). The first pass
(un-ignore `ignored`+`auto` videos that no longer match) is unchanged: an exempt video can't
be `ignored`+`auto` (only ingest-insert and reconcile produce that state, and neither
applies to an exempt video), so it needs no exemption check.

**Interactions, stated so they aren't re-derived:**

- An `ignored` video where the user presses "Mark Watching" (item 3) becomes `watching` and
  is thereafter never re-ignored by rules — the intended meaning of excluding `watching`.
- `watched → unwatched` toggles leave `autoIgnoreExempt` as it was (nothing clears it): a
  video the user previously un-ignored stays exempt through the round trip, while one that
  was never un-ignored is non-exempt and a later rule change *can* re-ignore it. Accepted,
  not in scope.
- Past `watching` videos already auto-ignored stay ignored; un-ignoring them exempts them.

**Code comment.** The comment block above `reconcileIgnoreRules` (`src/lib/ignore-rules.ts`,
which says "unwatched/watching" and quotes MVP item 6) is updated alongside the predicate
change.

**Doc pointers** (per CLAUDE.md, small inline pointers, not rewrites). These were added to
the working tree while writing this spec (so they exist and only need verifying, not
re-adding, at implementation time), and they assert this design — if the design changes,
fix them too:

- `docs/app_idea.md` MVP item 6 (the sentence "every Unwatched/Watching video that newly
  matches gets auto-ignored"), the Video entry (the un-ignore sentence), and the IgnoreRule
  entry ("Unwatched/Watching videos") each carry
  `(refined in docs/specs/031-behavior-correctness-ops-polish.md — reconcile only auto-ignores Unwatched videos, and a video the user un-ignores is exempt from future auto-ignore)`
  or equivalent wording.
- `docs/specs/007-ignore-rules-and-ignored-view.md`: one pointer at its reconciliation Scope
  bullet. Its body is otherwise left alone (append-don't-rewrite).
- `docs/specs/012-auth-and-csrf.md` (Schema changes null-hash note) and
  `docs/specs/014-deployment-docker-packaging.md` ("Initial login" item) each carry a pointer
  for the first-boot password.
- `docs/app_idea.md` MVP item 6's trailing "auto-ignored videos stay reconcilable by rule
  changes indefinitely unless explicitly un-ignored" stays accurate (an explicit un-ignore is
  exactly what exempts), so it gets no edit.

### 3. Watching page for ignored videos (`src/views/watching-page.tsx`)

`showAutoTimer` is `props.status !== "watched"`; change to
`props.status !== "watched" && props.status !== "ignored"`. `/watching/:id` still renders for
an ignored video (the route's `ownedVideo` lookup has no status filter, and that's kept:
rendering is harmless and avoids a new 404 case), the badge shows "Ignored", and nothing
changes status automatically. The explicit "Mark Watching" button still works (`setWatching`
doesn't check status and clears `ignoreMethod`). The "Mark Watched & Return" form is also
unchanged (it moves an ignored video to `watched`, clearing `ignoreMethod`, as today). No
route change in `src/routes/queue.tsx`.

### 4. First-boot password and compose (`src/lib/auth.ts`, `src/index.ts`, `docker-compose.yml`, docs)

**Problem.** `seed` inserts `{ username: "admin" }` with a null `password_hash`, and the only
thing that fills it is `AUTH_RECOVERY_PASSWORD`. A fresh deploy with that unset can't be
logged into at all. Separately, `env_file: - .env` makes `docker compose up` error if `.env`
doesn't exist.

**Boot sequence.** Add an exported `ensureAdminPassword(): Promise<void>` to
`src/lib/auth.ts`, called in `src/index.ts` immediately after
`await applyRecoveryPasswordFromEnv()`:

1. Read the `admin` user's `passwordHash`. If it is non-null, return (true first boot only —
   after one successful run the hash is non-null forever, including after
   `AUTH_RECOVERY_PASSWORD` has been applied).
2. Otherwise generate a password (`randomBytes(18).toString("base64url")`, 24 chars),
   hash it via the existing `hashPassword`, and store it with a conditional update
   (`WHERE username = 'admin' AND password_hash IS NULL`) so it can never overwrite a hash
   written between the read and the write.
3. Only if the update reported `changes === 1`, `logger.warn` the plaintext **once**, in
   the message text, naming the username and saying it won't be shown again and how to
   replace it (`AUTH_RECOVERY_PASSWORD`). If the update changed 0 rows, log nothing — never
   print a password that wasn't stored. If there is no `admin` row at all (read returns
   undefined), return silently.

Placing it in `index.ts` rather than `seed.ts` keeps `seed` and the DB constraint
unchanged: `seed` still inserts null. This **supersedes spec012's note** that a null hash is
the correct fresh-seed state (`docs/specs/012-auth-and-csrf.md`, Schema changes) — that note
describes `seed`, which is unchanged, but is no longer the state a booted app is left in.
Pointers at spec012's note and at `docs/specs/014-deployment-docker-packaging.md`'s "Initial
login" item (which also claims `AUTH_RECOVERY_PASSWORD` is the only way to set the password)
are listed under Doc pointers in section 2.

Log only; **no file in `/data`** (no plaintext secret on disk). `ensureAdminPassword` is
only called from `index.ts`, so existing tests that null the hash on purpose
(`test/routes/auth.test.ts`) are unaffected.

**Accepted limitation:** the log line is at WARN, so `LOG_LEVEL=error` hides it, and the
hash is already stored by then, so it won't be re-emitted on the next boot. Recovery is the
documented `AUTH_RECOVERY_PASSWORD` path; `docs/DEPLOYMENT.md` says so explicitly. Not worth
a logger-API change to force the line through.

**Compose.** `env_file: [{ path: .env, required: false }]` in `docker-compose.yml`. The
`required` key needs Docker Compose ≥ 2.24 (documented). A red-team pass
found `podman-compose` 1.6.0 on the host (`podman compose` delegates to it; no `docker` on
the host) and confirmed `podman-compose config` parses the long syntax with no `.env`
present. The implementation must still confirm at runtime (`up` in a throwaway directory
with no `.env`) that a missing file is tolerated, not just that `config` parses, and report
what was and wasn't verified. CI (`.github/workflows/pr.yml`) has no compose references and
is unaffected.

**Docs.** The feature file's firm scope names `README.md`, but `README.md` only links to
`docs/DEPLOYMENT.md` (feature file Resolved Decision 5 already redirects there), so:

- `docs/DEPLOYMENT.md`: Quick start step 2 stops being a hard `cp .env.example .env` step
  (`.env` becomes optional); §3 "Initial login" documents the generated first-boot password
  (`docker compose logs tubeshelf`), keeps the `AUTH_RECOVERY_PASSWORD` flow as the way to
  *replace/recover* it (and drops "the *only* way to set"), notes the `LOG_LEVEL=error`
  caveat above, and notes the Compose ≥ 2.24 requirement.
- `.env.example`: the `AUTH_RECOVERY_PASSWORD` comment is updated ("Not required for MVP if
  you don't need recovery" → leaving it unset generates a random password on first boot,
  logged once).

### 5. Logger (`src/lib/logger.ts`)

Text mode's `${key}=${value}` prints `[object Object]` for non-Error object values
(`normalizeMeta` only special-cases `Error`). In the text-mode formatter, a value where
`typeof value === "object" && value !== null` is rendered via `JSON.stringify(value)`, with
`String(value)` as the fallback if stringify throws (circular reference, BigInt inside) or
returns `undefined`. Primitives, `null`, and functions keep their current `${value}`
rendering. JSON mode is unchanged (it already serializes the whole record; a circular value
there is a pre-existing, separate concern, left alone). Dates render as quoted ISO strings
via `JSON.stringify`; accepted. An `Error` nested inside an object value (e.g. `{ctx: {err}}`)
renders as `{}` because `normalizeMeta` only unwraps top-level Errors; accepted, since every
current call site passes errors at the top level.

### 6. Login form (`src/views/login-page.tsx`)

`autocomplete="username"` and `required` on the username input; `autocomplete="current-password"`
and `required` on the password input. No server-side change: the route already treats an
empty username/password as a failed login.

### Testing

- `test/lib/categories.test.ts`: **rewrite** the existing test "channelCount counts
  subscriptions across users and includes unsubscribed rows" (asserts `3`; the correct value
  after this change is the current user's active subscriptions only) into one asserting
  `channelCount` ignores an unsubscribed subscription and another user's subscription to the
  same category and counts an active one. **Test hazard (spec012 retro):** the `db` singleton is shared across all test
  files in a `bun test` run and `seed.ts` only seeds when the `users` table is empty — a test
  needing a second user (the existing test being rewritten above inserts one without it)
  must call `seed(db)` *before* inserting its own user row, and must
  not leave state that breaks other files.
- `test/lib/ignore-rules.test.ts`: **replace** the existing "auto-ignores a watching video
  that newly matches a just-added rule" with one asserting a `watching` video that newly
  matches a rule is **not** auto-ignored; an `unwatched`
  exempt video that matches is not auto-ignored; an `unwatched` non-exempt one still is; an
  exempt `ignored`+`manual` video is untouched.
- `test/lib/watch-status.test.ts`: `unignoreVideo` sets `autoIgnoreExempt` (from both a
  manual and an auto ignore); other transition functions leave it unchanged.
- Route-level regression (`test/routes/ignore-rules.test.ts` or `queue.test.ts`): auto-ignore
  a video via adding a rule → `POST /videos/:id/unignore` → edit/add another rule that still
  matches it → the video stays `unwatched`.
- `test/lib/ingest.test.ts`: a new matching video still inserts as `ignored`/`auto`
  (exemption default doesn't interfere).
- `test/routes/queue.test.ts`: `GET /watching/:id` for an `ignored` video contains no
  `hx-trigger="load delay:10s"` and shows the "Ignored" badge; for an `unwatched` video it
  still contains the timer.
- `test/lib/auth.test.ts` (new or existing): `ensureAdminPassword` — null hash → hash set,
  verifies against the logged plaintext (capture via spying on `console.error`, since WARN
  goes to `console.error`), logged exactly once; non-null hash → no-op, no log; leaves a hash
  that `applyRecoveryPasswordFromEnv` set untouched; no `admin` row → silent no-op. The test
  must null the shared `admin` hash and restore it in `finally`, following
  `test/routes/auth.test.ts`'s existing null-hash/restore pattern, since the `db` singleton
  is shared across files.
- `test/lib/logger.test.ts`: text mode renders `{a:1}` as `meta={"a":1}`, an array likewise,
  a circular object doesn't throw (falls back to `String`), Error and primitive rendering
  unchanged, JSON mode unchanged.
- `test/routes/auth.test.ts`: `GET /login` markup contains both `autocomplete` values and
  `required` on both inputs.
- Compose / docs changes aren't unit-testable; see the manual verification below.

### Manual verification (task file will split Claude-vs-user per CLAUDE.md)

Claude performs directly: fresh-DB boot (temp `DB_FILE_NAME`; the devcontainer's
`containerEnv` sets `AUTH_RECOVERY_PASSWORD`, so start with `env -u AUTH_RECOVERY_PASSWORD`)
logs one WARN line with a password that `scripts/dev-login.sh` accepts when given
`DEV_LOGIN_PASSWORD=<logged password>` (its default is the recovery password); a second
boot logs nothing and keeps working; `curl` of `/watching/:id` for an ignored vs. unwatched
video; direct SQLite check of the migration (`PRAGMA table_info(videos)`, existing rows
default `0`); `docker compose config` with and without a `.env` if a compose binary is
available. User performs in a browser: login form autofill/required behavior; the category
page's channel count after unsubscribing; un-ignore → rule edit round trip. Final step runs
`bun test`, `bun run lint`, `bunx tsc --noEmit`, `bun run fallow` clean (CLAUDE.md).

## Open Questions

None.

**Red-team retrospective — pass 1** (subagent, no memory of the drafting conversation;
verified citations against the tree, ran `podman-compose config` empirically). Real findings,
all fixed above: an existing `categories.test.ts` test asserts the old unscoped count and
must be rewritten, not just supplemented; spec007's "auto-ignores a watching video" test
must be replaced; `ensureAdminPassword` could log a password whose conditional update
changed 0 rows (now gated on `changes === 1`, with a no-`admin`-row no-op); the first-boot
manual verification would silently use the devcontainer's `AUTH_RECOVERY_PASSWORD` (now
`env -u` plus `DEV_LOGIN_PASSWORD`); the `ensureAdminPassword` test must null/restore the
shared admin hash; the `reconcileIgnoreRules` comment block needed updating; the
`watched → unwatched` interaction note misdescribed exempt videos; the compose-support
claim was resolved empirically for `config` (runtime `up` still to verify); nested-Error
logger edge noted. One claim in the report (doc pointers pre-existing in commit f0837ce)
was wrong — those pointers are this session's own uncommitted edits, present once each.
A second full pass was not run: every finding was a narrow, mechanical correction with no
change to the design's shape.
