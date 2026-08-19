---
status: in-progress
created: 2026-08-19
---

# Security Review Hardening

## Context

A two-pass security review of the whole app was run on 2026-08-19 directly in conversation
(not a prior spec): a blind subagent reviewed all application source/config with no access
to `.md` docs, then its findings were triaged against `docs/app_idea.md` and
`docs/specs/012-auth-and-csrf.md` for design intent. SQLi, XSS, CSRF, SSRF, CI-workflow, and
Docker/devcontainer risks were checked and cleared with specific reasoning (see review
findings for detail — not reproduced here). Four findings survived triage; this spec covers
the three that are actionable now. See Scope for what's explicitly deferred and why.

## Scope

**In:**

1. Video watch-status mutations (and their read-path counterparts) in
   `src/lib/watch-status.ts` and `src/routes/queue.tsx` currently key off `videos.id` alone,
   with no check that the caller is actually subscribed to the video's channel. Add that
   check.
2. `attemptLogin()` in `src/lib/auth.ts` has a login-timing side channel: unknown usernames
   return immediately, known usernames incur a bcrypt verify, so response latency reveals
   whether a username exists. Normalize the timing.
3. Ignore-rule keywords (`src/routes/ignore-rules.tsx`, `src/db/schema.ts`) have no upper
   length bound, unlike category names. Add one, mirroring the existing
   `CATEGORY_NAME_MAX_LENGTH` pattern.

**Out (deferred, not fixed by this spec):**

- **`getCurrentUser()`'s hardcoded `username: "admin"` lookup** (`src/lib/current-user.ts`),
  which ignores the authenticated session's actual `userId`. Confirmed intentional MVP
  scope per `docs/app_idea.md:128` ("MVP runs as a single implicit user, but the schema
  should still model a `User` record now so v2.0 multi-user support doesn't require a
  breaking migration"). Wiring session identity through is real work that belongs with that
  future multi-user spec, not a standalone hardening fix — doing it in isolation here would
  just be dead code, since `getCurrentUser()`'s caller is the only thing that would change.
- **`AUTH_RECOVERY_PASSWORD` overwriting the password on every boot.** Already a documented,
  accepted tradeoff (`docs/specs/012-auth-and-csrf.md`: "at the accepted cost that leaving
  it set overwrites any UI-set password on the next restart"), already mitigated with a
  `console.warn`. No new information from this review; no change.
- **True per-user watch status.** `videos.status` is a single column on the video row
  itself, not per-user — there is no per-user junction table. That means today's fix (item
  1 above) closes cross-tenant *griefing* (mutating videos on channels you're not subscribed
  to) but does **not** give each user their own watched/ignored state on a video multiple
  users are subscribed to; that's inherently shared under the current data model. Making
  watch state genuinely per-user needs a schema change (a junction table keyed on
  `userId` + `videoId`), which is bigger than this hardening pass and belongs with the
  future multi-user spec — confirmed explicitly with the user rather than assumed.

## Design

### 1. Subscription-ownership check on video reads/mutations

Five functions in `src/lib/watch-status.ts` (`setWatching`, `toggleQueueStatus`,
`toggleWatchedFromWatchingPage`, `ignoreVideo`, `unignoreVideo`) and two read-helpers in
`src/routes/queue.tsx` (`queueRowById`, `videoForWatchingPage`) currently look up a video by
`eq(videos.id, videoId)` alone. `src/routes/channels.tsx`'s subscription-mutation endpoints
already do this correctly — `eq(subscriptions.id, id), eq(subscriptions.userId, user.id),
isNull(subscriptions.unsubscribedAt)` — so this fix copies that established pattern rather
than inventing a new one.

Each of the seven functions gains a `userId: number` parameter. The existing "look up
current state" query in each `watch-status.ts` function changes from:

```ts
db.select({ status: videos.status }).from(videos).where(eq(videos.id, videoId)).get();
```

to joining through the ownership chain and requiring an active subscription:

```ts
db.select({ status: videos.status })
  .from(videos)
  .innerJoin(youtubeChannels, eq(videos.channelId, youtubeChannels.id))
  .innerJoin(subscriptions, eq(subscriptions.youtubeChannelId, youtubeChannels.id))
  .where(
    and(
      eq(videos.id, videoId),
      eq(subscriptions.userId, userId),
      isNull(subscriptions.unsubscribedAt),
    ),
  )
  .get();
```

If this returns nothing, the function returns `null` exactly as it does today for a
genuinely nonexistent `videoId` — callers already treat `null`/falsy as `c.notFound()`
(`src/routes/queue.tsx`'s `/videos/:id/*` handlers), so unauthorized-but-existing IDs and
truly-nonexistent IDs are indistinguishable to the caller, same as the existing
`channels.tsx` pattern. The subsequent `db.update(videos)...where(eq(videos.id,
videoId))` call in each function is unchanged — ownership was already established by the
select immediately before it in the same synchronous request handler (bun:sqlite is
synchronous/single-connection here, so there's no TOCTOU window to close).

`queueRowById` already joins `subscriptions` (for `categoryName`) but doesn't filter by
`subscriptions.userId` — add `eq(subscriptions.userId, userId)` and
`isNull(subscriptions.unsubscribedAt)` to its existing `where`. `videoForWatchingPage`
currently has no join at all; add the same two joins and where-clause additions as the
`watch-status.ts` functions above.

Call sites in `src/routes/queue.tsx` (`/videos/:id/watching`, `/videos/:id/watched-toggle`,
`/videos/:id/toggle`, `/videos/:id/ignore`, `/videos/:id/unignore`, `/watching/:id`) each
need `const user = getCurrentUser();` (not all currently call it before using these
functions — `/watching/:id` currently calls `videoForWatchingPage(id)` before
`getCurrentUser()`; reorder so `user.id` is available first) and pass `user.id` as the new
argument.

`test/lib/watch-status.test.ts` builds its test videos against a bare `youtubeChannels` row
with no `users`/`subscriptions` insert at all, since none of the five functions currently
check ownership. Once the join lands, every existing case in that file will start getting
`null` back instead of a result — this isn't just a signature update at call sites, the test
file needs a user + active-subscription fixture added before its existing assertions still
mean anything.

The same gap exists, inconsistently, in `test/routes/queue.test.ts`: its `/videos/:id/toggle`,
`/videos/:id/ignore`, and `/videos/:id/unignore` tests already call `makeSubscription(channel.id)`
before hitting the endpoint, but its `/videos/:id/watching` test (one case, ~line 687), all
`/videos/:id/watched-toggle` tests (three cases, ~lines 718-793), and all `GET /watching/:id`
tests (four cases, ~lines 577-685 plus ~901) create a `channel` via `makeChannel(...)` with no
matching `makeSubscription` call. Once the ownership join lands these will start 404ing
instead of asserting real behavior. Each needs a `makeSubscription(channel.id)` call added
alongside its existing `makeChannel(...)` call, matching the pattern the `/toggle`/`/ignore`/
`/unignore` tests in the same file already use.

### 2. Constant-time login for unknown usernames

`attemptLogin()` (`src/lib/auth.ts:46`) returns `{ ok: false }` immediately when no user
matches; when a user does match, it runs `verifyPassword` (a bcrypt hash comparison, the
expensive step) before succeeding or failing. Fix: precompute a fixed dummy bcrypt hash
once at module load (e.g. `Bun.password.hashSync` of a random value, stored in a
module-level constant — never a real credential, never logged). When no user is found, call
`await verifyPassword(password, dummyHash)` and discard the result before returning `{ ok:
false }`.

This also has to cover a second fast-path: `attemptLogin` skips `verifyPassword` entirely
when the matched user's `passwordHash` is `null` (`auth.ts:61-63`,
`user.passwordHash ? verifyPassword(...) : false`) — and that's not a hypothetical edge
case, it's the literal default state of a fresh install (`src/db/seed.ts` seeds the "admin"
user with no `passwordHash` until `AUTH_RECOVERY_PASSWORD` is ever applied). Route that
branch through the same dummy hash too:
`user.passwordHash ? verifyPassword(password, user.passwordHash) : verifyPassword(password, dummyHash)`,
still failing afterward regardless of the dummy verify's result. With both changes, "no such
user," "user exists with no password set," and "user exists, wrong password" all perform
exactly one bcrypt verify before failing.

Scope note: the existing lockout check (`user.lockedUntil` — `auth.ts:57-59`) also returns
before `verifyPassword` and is *not* touched by this fix. It only fires for a username that
already exists and already has failed attempts recorded, so it doesn't leak new information
beyond what the lockout mechanism itself already implies; normalizing it is a separate,
smaller concern not raised by the original finding and is left out to keep this change
minimal.

### 3. Ignore-rule keyword length cap

Add `IGNORE_RULE_KEYWORD_MAX_LENGTH = 200` to `src/db/schema.ts` next to the existing
`CATEGORY_NAME_MAX_LENGTH = 100`. 200 was chosen over reusing 100 because ignore-rule
keywords are free-text phrases matched via substring (`matchesAnyRule`'s `.includes()`),
plausibly longer than a category name, while still being far below the multi-MB abuse case
the finding described.

Mirror the `categories` table's existing pattern exactly:

- A DB-level `CHECK` constraint on `ignoreRules.keyword` (`length(keyword) <=
  IGNORE_RULE_KEYWORD_MAX_LENGTH`), matching `categories`'s `sql\`length(${t.name}) <=
  ${sql.raw(String(CATEGORY_NAME_MAX_LENGTH))}\`` constraint.
- App-level validation in both `POST /ignore-rules` and `POST /ignore-rules/:id`
  (`src/routes/ignore-rules.tsx`), returning the same shape of inline error as the existing
  empty-keyword check (`"Keyword must be {N} characters or fewer."`), matching
  `categories.tsx`'s two equivalent checks.

Implementation note for the task file: adding a `CHECK` constraint to an existing SQLite
table requires a `drizzle-kit generate` migration, and per this project's `CLAUDE.md`,
`drizzle-kit generate` needs an interactive TTY that `devcontainer exec` from a Claude Code
session doesn't have. That step has to be handed to the user to run in their own terminal,
same as any other schema change in this project — not something to work around.

## Open Questions

None. Scoping was settled via direct conversation with the user before drafting (see Scope's
"Out" list for the three explicit exclusions and why each was deferred rather than folded
in).

**Red-team retrospective:** One independent pass was run against this draft. It caught three
issues, all fixed directly in the sections above: a wrong line citation for the lockout
check (was `auth.ts:52-54`, actually `auth.ts:57-59`); the login-timing fix as originally
scoped left a second fast-path unnormalized (`passwordHash === null`, which is a fresh
install's actual default state per `db/seed.ts`, not an edge case) — extended item 2 to
route that branch through the dummy hash too; and the Design section didn't mention that
`test/lib/watch-status.test.ts` needs a new user/subscription fixture, not just call-site
signature updates, since its existing cases have no active subscription for the ownership
join to match. A second full pass wasn't run — the fixes were narrow and localized enough
that a fresh full read wasn't warranted, per this project's stopping-signal guidance for
red-team passes.

**Discovered during `/spec-tasks` decomposition (2026-08-19):** while breaking Design item 1
into concrete steps, reading `test/routes/queue.test.ts` in full (not just grepped) showed the
missing-subscription-fixture issue the red-team pass caught in `test/lib/watch-status.test.ts`
also applies, inconsistently, to several route-level tests in that file (`/watching`,
`/watched-toggle`, `GET /watching/:id`) — while sibling tests for `/toggle`/`/ignore`/
`/unignore` in the same file already set up a subscription correctly. Folded into Design
item 1 above rather than left as a task-file-only note, so a reader of the spec alone still
gets the full picture of what breaks.
