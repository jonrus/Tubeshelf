---
status: in-progress
created: 2026-07-20
---

# Channel Subscriptions

## Context

Spec001 delivered the scaffold (devcontainer, Hono/Drizzle/SQLite wiring, Tailwind, one
skeleton page) but only modeled `Category` end-to-end. This spec implements the next
vertical slice toward MVP: subscribing to and unsubscribing from YouTube channels
(`docs/app_idea.md` MVP items 1 and 5).

Working through the design surfaced a latent bug in spec001's schema: `channels` ties
channel ownership 1:1 to a user via a unique `youtube_channel_id`, so a second user
subscribing to a channel the first user already subscribed to would hit the unique
constraint and fail outright. `docs/app_idea.md` already modeled a `User` table early
specifically to avoid a breaking migration for v2.0 multi-user — this spec applies the
same reasoning to channel ownership, since the fix is cheap now and a genuine functional
bug (not just schema purity) later. Per-user watch status on `Video` is a separable,
larger concern intentionally left alone here (see Scope).

Discussion also reconsidered `docs/app_idea.md` MVP item 5's unsubscribe behavior (delete
Unwatched/Watching/Ignored videos, keep Watched as history) — once channels are shared
data rather than user-owned rows, deleting videos on unsubscribe is tidiness, not
correctness. This spec changes that behavior; see the pointer added to `app_idea.md`.

## Scope

**In:**
- Schema split: `youtube_channels` (global channel identity, never deleted) +
  `subscriptions` (per-user join: category, active/unsubscribed state). Replaces
  spec001's `channels` table.
- `videos.channelId` FK retargeted to `youtube_channels.id`.
- Subscribe flow: accept raw channel ID, `/channel/<id>` URL, or RSS URL; parse/validate;
  fetch the channel's RSS feed once (synchronous, not the recurring job) to confirm
  validity and pull the real channel name; assign a category.
- Unsubscribe flow: soft-delete the `subscriptions` row only. No `videos` rows are ever
  touched by unsubscribe.
- Re-subscribing to a previously-unsubscribed channel reactivates the existing
  subscription (and updates its category) rather than erroring.
- New `/channels` page: subscribe form + list of this user's active subscriptions +
  unsubscribe action.
- `fast-xml-parser` dependency, used here for the channel-title lookup and intended for
  reuse by spec003's ingestion job.

**Out (deferred):**
- The scheduled/staggered RSS ingestion job that actually populates `videos` (spec003).
  This spec's RSS fetch is a one-off validation/name-lookup call only, at subscribe time.
- `possibleMissedVideos` gap-detection logic and its UI — the column exists (carried over
  from spec001) but stays unused/`false` until spec003.
- Per-user watch status on `Video` (currently a single column, implicitly fine for MVP's
  one real user) — true multi-user video status is a separate, larger migration left for
  the actual multi-user spec.
- Watch flow, ignore rules, auth — unrelated verticals.

## Design

### Schema (`src/db/schema.ts`)

Replaces spec001's `channels` table with two tables:

```ts
import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const youtubeChannels = sqliteTable("youtube_channels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  youtubeChannelId: text("youtube_channel_id").notNull().unique(),
  name: text("name").notNull(),
  rssUrl: text("rss_url").notNull(),
  possibleMissedVideos: integer("possible_missed_videos", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

export const subscriptions = sqliteTable("subscriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  youtubeChannelId: integer("youtube_channel_id").notNull().references(() => youtubeChannels.id),
  categoryId: integer("category_id").notNull().references(() => categories.id),
  unsubscribedAt: integer("unsubscribed_at", { mode: "timestamp" }), // null = active
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (t) => [
  unique("subscriptions_user_channel_unique").on(t.userId, t.youtubeChannelId),
]);
```

`videos.channelId` (defined in spec001) now references `youtubeChannels.id` instead of
the old `channels.id`. No data migration concern — no real video rows exist yet at this
point in the build, so this is a straight schema edit followed by
`drizzle-kit generate`.

`subscriptions_user_channel_unique` is what makes "already subscribed" a detectable
conflict, and what the reactivate-on-resubscribe logic below queries against.

### Input parsing (`src/lib/channel-input.ts` or similar)

Accepts raw channel ID, a `/channel/<id>` URL, or an RSS URL with a `channel_id` query
param; normalizes all three to a canonical `{ channelId, rssUrl }`:

```ts
const CHANNEL_ID_PATTERN = /^UC[a-zA-Z0-9_-]{22}$/;

function rssUrlFor(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

export function parseChannelInput(input: string): { channelId: string; rssUrl: string } | null {
  const trimmed = input.trim();

  if (CHANNEL_ID_PATTERN.test(trimmed)) {
    return { channelId: trimmed, rssUrl: rssUrlFor(trimmed) };
  }

  const pathMatch = trimmed.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/);
  if (pathMatch) {
    return { channelId: pathMatch[1], rssUrl: rssUrlFor(pathMatch[1]) };
  }

  try {
    const url = new URL(trimmed);
    const channelId = url.searchParams.get("channel_id");
    if (channelId && CHANNEL_ID_PATTERN.test(channelId)) {
      return { channelId, rssUrl: rssUrlFor(channelId) };
    }
  } catch {
    // not a URL at all — falls through to null
  }

  return null;
}
```

Anything that doesn't match any of the three forms returns `null`, surfaced as an inline
form error rather than a 500.

### RSS title lookup (`src/lib/rss.ts` or similar)

One-off fetch + parse, used only at subscribe time in this spec (spec003's ingestion job
will reuse `fast-xml-parser` for full entry parsing, not necessarily this exact function):

```ts
import { XMLParser } from "fast-xml-parser";

const FETCH_TIMEOUT_MS = 5_000;

export async function fetchChannelTitle(rssUrl: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(rssUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return null; // network error or timeout
  }
  if (!res.ok) return null;

  const xml = await res.text();
  const parsed = new XMLParser().parse(xml);
  const title = parsed?.feed?.title;
  return typeof title === "string" && title.length > 0 ? title : null;
}
```

YouTube's channel RSS feed is Atom-format (`<feed><title>...` at the top level, separate
from each `<entry>`'s own `<title>`), so `parsed.feed.title` is the channel name. A bare
5s timeout guards against the endpoint hanging — this is the same "unofficial, undocumented
endpoint" `docs/app_idea.md` already accepts as a risk, so the subscribe request needs a
bound rather than trusting it to always respond. All failure paths (network error, timeout,
non-OK response, missing title) collapse to one `null` → one generic inline error; not
worth distinguishing further for this spec.

### Subscribe flow (`POST /subscriptions`)

Given `{ channelInput, categoryId }` from the form (`categoryId` may be blank/omitted,
meaning "leave it Uncategorized" — see the `/channels` page section below for why the
system category is never an explicit option):

1. `parseChannelInput(channelInput)` — `null` → inline error, stop.
2. Resolve `categoryId`:
   - Blank/omitted → look up the system category (`isSystem = true`) and use its id.
   - Provided → validate it refers to an existing **non-system** category — inline error
     if it doesn't exist, and inline error if it *is* the system category's id (defense in
     depth against forged form data, since the system category is deliberately excluded
     from the rendered `<select>`; `docs/app_idea.md` treats it as not user-selectable).
3. Look up `youtube_channels` by `channelId`.
   - Not found: call `fetchChannelTitle(rssUrl)`. `null` (fetch/parse/timeout failure) →
     inline error, nothing saved. Otherwise attempt to insert a new `youtube_channels`
     row. If the insert fails on the `youtube_channel_id` unique constraint (a concurrent
     request created it first — the exact race this spec's schema split makes possible
     the moment a second subscriber exists), re-query by `channelId` and proceed with the
     now-found row rather than surfacing the DB error.
   - Found: reuse the existing row as-is (no re-fetch — another subscriber already
     validated it).
4. Look up `subscriptions` by `(userId, youtubeChannelId)`.
   - Active row exists (`unsubscribedAt` null) → inline error, "already subscribed."
   - Inactive row exists → `UPDATE`: clear `unsubscribedAt`, set `categoryId` to the
     resolved value.
   - No row → attempt `INSERT` a new subscription. If it fails on the
     `subscriptions_user_channel_unique` constraint (a second racing request from the
     same double-submit got there first — the same race shape as step 3's
     `youtube_channels` insert, one join away), re-query and fall into the
     already-active/reactivate branches above instead of surfacing the DB error.
5. Re-query this user's active subscriptions (joined with `youtube_channels` and
   `categories`) and return the list partial.

Steps 3 and 4's insert-with-recovery logic (the two unique-constraint races) live in
`src/lib/subscribe.ts` as independently callable functions —
`upsertYoutubeChannel(channelId, rssUrl)` and `upsertSubscription(userId, youtubeChannelId, categoryId)`
— rather than inlined directly in the route handler. That's what gives the race-condition
tests in Testing something to call directly (pre-insert a conflicting row, then invoke the
function and assert it recovers) instead of needing real concurrency or route-level
mocking to exercise.

MVP has a single implicit user. Routes resolve `userId` by looking up the seed's known
row — `db.select().from(users).where(eq(users.username, "default")).get()` — not an
unqualified `.get()` on the whole table, which would just return whatever row happens to
come back first if more than one `users` row ever exists (e.g. in a test). Auth (reading
`userId` from a session instead) is a separate, later spec.

### Unsubscribe flow (`DELETE /subscriptions/:id`)

Sets `unsubscribedAt = now` on the subscription row, scoped to
`WHERE id = :id AND userId = currentUserId` (same implicit-user lookup as subscribe) — a
mismatched or already-inactive `id` is a 404, not a silent no-op or someone else's row
getting touched. This scoping is a no-op under MVP's single user today, but it's exactly
the kind of check this spec exists to get right before multi-user makes it load-bearing —
an unscoped `DELETE ... WHERE id = :id` is the same class of bug as the unique-constraint
issue in Context. Nothing else changes: no `videos` query, no `youtube_channels` query.
Returns the updated (now-filtered) active-subscriptions list partial. Re-subscribing later
(step 4 above) picks the same row back up.

### `/channels` page (`src/routes/channels.tsx`, `src/views/...`)

- `GET /channels` — full page: subscribe form (text input + category `<select>`) plus
  `<div id="subscription-list">` listing active subscriptions (channel name, category,
  unsubscribe button per row: `hx-delete="/subscriptions/{id}"`, target/swap as below).
- Category `<select>`: options are the **non-system** categories only (`isSystem = false`),
  plus a default blank option labeled "Uncategorized" with `value=""`. This is what makes
  Uncategorized "not user-selectable" hold in practice — it's never a distinct list item
  pointing at its real category id, only the default state when nothing else is chosen
  (mirrors the resolution logic in the subscribe flow above).
- Form: `hx-post="/subscriptions" hx-target="#subscription-list" hx-swap="outerHTML"`.
- Ordering: alphabetical by channel name (category grouping/sorting can wait for a UI
  polish pass — not core to this vertical).

### Testing (`test/lib/`, `test/routes/`)

Starting with this spec, unit/route test files mirror the directory of the `src/` file they
cover — `src/lib/foo.ts` → `test/lib/foo.test.ts`, `src/routes/foo.tsx` →
`test/routes/foo.test.ts` — rather than everything living flat under `test/`. (Spec001's
`test/smoke.test.ts` predates this convention and stays flat, since it's a cross-cutting
migration+seed integration test rather than a unit test of one module.)

- `test/lib/channel-input.test.ts`: unit tests for `parseChannelInput` covering all three
  input forms plus invalid input, and confirming ID/`/channel/` URL/RSS URL for the *same*
  channel all normalize to an identical `{ channelId, rssUrl }`.
- `test/routes/channels.test.ts`: route-level test for the subscribe→unsubscribe→resubscribe
  cycle against an in-memory DB, with `fetch` mocked (Bun's `mock.module` or
  `spyOn(globalThis, "fetch")` — confirm which actually intercepts a bare `fetch()` call at
  implementation time) to avoid a real network call in tests.
- `test/routes/channels.test.ts`: test the category resolution: blank `categoryId` lands on
  the system category; an explicit system-category id is rejected inline.
- `test/lib/subscribe.test.ts`: test the concurrent-insert race path directly against
  `upsertYoutubeChannel` and `upsertSubscription` (`src/lib/subscribe.ts`) in isolation:
  pre-insert the conflicting row, then call the function and assert it recovers by
  re-querying rather than throwing.
- `test/routes/channels.test.ts`: test unsubscribe ownership scoping: insert a second
  `users` row directly via the DB (distinct `username` from `"default"`, so the
  deterministic lookup above still resolves the real "current" user unambiguously), create
  a subscription owned by that second user, and assert `DELETE /subscriptions/:id` from the
  default user's context 404s and leaves that row untouched.
- `test/routes/channels.test.ts`: since spec003's ingestion job doesn't exist yet, there's
  no real way to end-to-end prove "unsubscribe never touches videos" against actual
  ingested data. Cover it directly instead: manually insert a `videos` row for a subscribed
  channel, unsubscribe, assert the video row is unchanged and still present.
- `test/lib/rss.test.ts`: unit tests for `fetchChannelTitle` (see RSS title lookup section)
  covering success, network error, timeout, non-OK response, and missing-title, all
  collapsing to `null`, with `fetch` mocked the same way as above.

### Verification (manual, end-to-end)

1. `bun run db:generate` — confirm the migration drops `channels` and creates
   `youtube_channels` + `subscriptions` with the unique constraint.
2. Subscribe using a real channel's `/channel/<id>` URL, leaving category blank — list
   shows the real channel name (proves the RSS fetch + parse worked, not a placeholder)
   under Uncategorized.
3. Attempt to subscribe to that same channel again (any input form) while still active —
   inline "already subscribed" error, no duplicate row.
4. Unsubscribe — row disappears from `/channels`.
5. Re-subscribe to the *same* channel using a **different input form** than step 2 (e.g.
   its raw ID instead of the URL) and a real category this time — it reactivates (confirm
   via DB query it's the same `subscriptions.id` and the same `youtube_channels.id`, not
   new rows) and shows the new category, proving the three input forms parse to the same
   channel identity and reactivation works.
6. Submit garbage input (e.g. `not a channel`) — inline error, no 500, nothing inserted.
7. Confirm via direct DB query that the `youtube_channels` row and any `videos` rows (if
   manually inserted per the testing section) survived the unsubscribe in step 4
   untouched.
8. `bun test` and `bun run lint` clean.

## Open Questions

- `CHANNEL_ID_PATTERN` (`UC` + 22 chars) covers current YouTube channel IDs but not
  necessarily every legacy format Google has ever issued. Not treated as a blocker — an
  unmatched-but-valid edge case surfaces as an inline "couldn't parse that" error, not
  silent data corruption, so it can be loosened later if a real channel ever fails to
  match.
- Category grouping/sorting on the `/channels` list is deferred to a UI-polish pass;
  confirm that's acceptable once the page is actually seen in the browser.
- Which Bun mechanism actually intercepts a bare `fetch()` call in tests (`mock.module`
  vs. `spyOn(globalThis, "fetch")`) isn't confirmed against the installed Bun version —
  verify at implementation time, same caveat spec001 flagged for Drizzle's `check()`
  syntax.
- SQLite can't alter a foreign key's target table in place, so retargeting
  `videos.channelId` from `channels` to `youtube_channels` requires `drizzle-kit` to
  recreate the `videos` table (create-new, copy rows, drop old, rename) rather than a
  simple `ALTER TABLE`. Not confirmed this generates cleanly — inspect the actual
  generated migration SQL at implementation time, same category of risk as spec001's
  flagged `check()` syntax uncertainty.
- Spec001's shipped `schema.ts` only ever validated the `(t) => [check(...), ...]`
  array-callback shape (confirmed against `drizzle-orm@0.45.2`, per its inline comment).
  `subscriptions_user_channel_unique` is this codebase's first use of the table-level
  `unique(name).on(col1, col2)` composite-constraint builder in that same array — not yet
  proven to compile or to emit a real `UNIQUE(user_id, youtube_channel_id)` constraint.
  Verify against the installed Drizzle version at implementation time; if the shape
  differs, it likely differs the same way `check()` would have.
