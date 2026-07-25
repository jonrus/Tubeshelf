---
status: in-progress
created: 2026-07-25
---

# Ignore Rules and Ignored View

## Context

Specs 001–006 delivered MVP items 1, 2, 3, 5 (subscribe/categorize channels, scheduled
RSS ingestion, the three-state watch flow, unsubscribe) plus the category-filtering
differentiator. The one MVP feature from `docs/app_idea.md` still unbuilt is **item 6**:
manual/auto Ignored status as a noise filter, backed by a global keyword `IgnoreRule`
list, plus a dedicated Ignored view to review/undo.

The schema is already scaffolded for this from spec001 — `videos.status` already
includes `'ignored'`, `videos.ignoreMethod` (`manual | auto | null`) already exists with
its check constraint, and the `ignore_rules` table already exists (migration `0000`).
None of that needs a new migration. What's missing is entirely application logic and
UI: keyword matching at ingestion, the manual ignore/un-ignore actions, the
`/ignore-rules` management page, and the `/ignored` view.

Confirmed during scoping:
- The manual "Ignore" action lives as a row button on `/queue` and `/continue-watching`
  (mirroring the existing per-row status-toggle button), not on the Watching page.
- `/ignore-rules` is its own dedicated page, styled like `/categories`.
- `app_idea.md`'s note that "manually triggering Ignore on an already auto-ignored
  video converts it to manual, locking it in" is **deferred** — since auto-ignored
  videos never appear on `/queue`/`/continue-watching` (where the manual Ignore button
  lives), there's no natural place to trigger this in the UI surfaces this spec builds.
  Auto-ignored videos stay reconcilable by future rule changes indefinitely unless
  explicitly un-ignored.
- Keyword matching only runs at RSS-ingestion **insert** time — a video's title/
  description are checked against the current rule set only the first time that video
  is seen. A later poll that updates an already-known video's title/description
  (rare, but the RSS feed's fields could change) never re-triggers auto-ignore for it.
  This matches the existing `applyFeedToChannel` upsert's established posture ("status/
  ignoreMethod deliberately excluded from the update set: ingestion never touches
  watch/ignore state on a video it's seen before").
- `/ignored` gets the same `?category=` filter spec006 built for the other three
  views, reusing that infrastructure rather than leaving it a fourth, inconsistent
  view.
- `/ignored` is scoped to **active subscriptions only**, like `/queue` and
  `/continue-watching` — not true history like `/watched`. Ignored is a working
  noise-filter list, not a permanent record; unsubscribing from a channel drops its
  ignored videos out of view same as it already does for queue/continue-watching.
- Editing an `IgnoreRule`'s keyword on `/ignore-rules` uses an Edit-link-toggles-a-form
  pattern (HTMX partial swap), not an always-visible inline form per row.

## Scope

**In:**
- `IgnoreRule` CRUD at `/ignore-rules`: add, edit (toggle-to-form), delete.
- Case-insensitive substring matching of each `IgnoreRule.keyword` against a video's
  `title` and `description`, applied once, at RSS-ingestion insert time only (never
  re-checked when an existing video row is updated on a later poll).
- A manual "Ignore" button on each `/queue` and `/continue-watching` row (alongside the
  existing status-toggle button) → `POST /videos/:id/ignore`, sets
  `status: 'ignored'`, `ignoreMethod: 'manual'`.
- A new `GET /ignored` view: lists ignored videos scoped to active subscriptions,
  category-filterable via the existing `resolveCategoryFilter`/`CategoryFilterLinks`
  infrastructure from spec006, plain (non-clickable) title text per row (no YouTube
  watch-link — these are things to *not* watch), an "Un-ignore" button per row →
  `POST /videos/:id/unignore`, and each row annotated with how it was ignored
  (`[manual]` / `[auto]`).
- Un-ignore reverts `status` to `'unwatched'` and clears `ignoreMethod` to `null`,
  regardless of whether the video was manually or auto-ignored (matches
  `docs/app_idea.md`'s existing "un-ignoring reverts status to unwatched and clears
  ignore_method" data-model note).
- A full reconciliation pass, triggered synchronously after every `IgnoreRule`
  add/edit/delete: every `ignored`+`auto` video that no longer matches any current rule
  reverts to `unwatched`; every `unwatched`/`watching` video that newly matches a rule
  becomes `ignored`+`auto`. `manual`-ignored videos are never touched by reconciliation
  in either direction (per `app_idea.md`'s existing MVP item 6 description). `watched`
  videos are also never touched — reconciliation only ever considers
  `unwatched`/`watching` as candidates to newly-ignore, matching `app_idea.md`'s literal
  wording ("every Unwatched/Watching video that newly matches").
- Nav links for "Ignored" and "Ignore Rules" added to `Layout`.

**Out (deferred):**
- The "lock in" action (manually re-triggering Ignore on an already auto-ignored video
  to convert it to manual) — no UI surface for it in this spec's scope; see Context.
- Any Ignore action on the Watching page.
- Per-channel/per-category-scoped ignore rules — still global for MVP, per
  `app_idea.md`'s Future Roadmap.
- Keyword uniqueness/duplicate-prevention — the `ignore_rules` table has no unique
  constraint on `keyword` and this spec doesn't add one; duplicate/overlapping keywords
  are harmless (matching is a simple "does any rule match" check), just redundant.
- Auth/CSRF — same deferred posture as every prior spec.
- Any change to Category/Channel/Subscription CRUD or the other three video-list views'
  existing behavior beyond adding the Ignore button and threading the new
  `/videos/:id/ignore` route alongside the existing toggle route.

## Design

### `src/lib/ignore-rules.ts` (new)

Shared matching + reconciliation logic, used by both ingestion and the `/ignore-rules`
routes:

```ts
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { ignoreRules, videos } from "../db/schema";

export function listIgnoreRules() {
  return db.select().from(ignoreRules).orderBy(asc(ignoreRules.keyword)).all();
}

// Structural typing lets both a full ignoreRules row and a bare {keyword} literal
// satisfy this -- callers that already fetched full rows (listIgnoreRules) don't need
// to re-shape them.
export function matchesAnyRule(
  video: { title: string; description: string | null },
  rules: { keyword: string }[],
): boolean {
  const haystack = `${video.title} ${video.description ?? ""}`.toLowerCase();
  // Relies on IgnoreRule.keyword never being empty -- enforced by the add/edit routes'
  // validation below. An empty keyword's `"".toLowerCase()` would make `.includes("")`
  // true unconditionally, matching every video -- never let an empty keyword reach here.
  return rules.some((rule) => haystack.includes(rule.keyword.toLowerCase()));
}

// Called after every IgnoreRule add/edit/delete. Re-runs the current rule set against
// every ignored+auto video (un-ignoring the ones that no longer match) and every
// unwatched/watching video (auto-ignoring the ones that newly match). Manual ignores
// and watched videos are excluded from both queries below, by construction -- neither
// is a candidate the reconciliation pass ever considers, matching app_idea.md's MVP
// item 6 ("auto-ignored video that no longer matches... Unwatched/Watching video that
// newly matches... Manually-ignored videos are never touched").
export function reconcileIgnoreRules(): void {
  const rules = listIgnoreRules();

  // Wrapped in one transaction -- unlike applyFeedToChannel's per-channel upserts
  // (docs/specs/003-scheduled-video-ingestion.md's "no transaction needed" call),
  // which self-heal automatically on the next hourly scheduled poll regardless of a
  // mid-run failure, this function only reruns on the next explicit rule add/edit/
  // delete. A crash partway through the loop below (a genuine DB failure, not a
  // reachable app-level error) would otherwise leave some videos reconciled and
  // others not, with no guaranteed retry -- a single transaction makes the whole pass
  // atomic instead.
  db.transaction((tx) => {
    const autoIgnored = tx
      .select({ id: videos.id, title: videos.title, description: videos.description })
      .from(videos)
      .where(and(eq(videos.status, "ignored"), eq(videos.ignoreMethod, "auto")))
      .all();
    for (const video of autoIgnored) {
      if (!matchesAnyRule(video, rules)) {
        tx.update(videos)
          .set({ status: "unwatched", ignoreMethod: null })
          .where(eq(videos.id, video.id))
          .run();
      }
    }

    const candidates = tx
      .select({ id: videos.id, title: videos.title, description: videos.description })
      .from(videos)
      .where(inArray(videos.status, ["unwatched", "watching"]))
      .all();
    for (const video of candidates) {
      if (matchesAnyRule(video, rules)) {
        tx.update(videos)
          .set({ status: "ignored", ignoreMethod: "auto" })
          .where(eq(videos.id, video.id))
          .run();
      }
    }
  });
}
```

Two passes rather than one combined query: the first pass's un-ignoring must use the
*current* rule set exactly like the second pass's auto-ignoring does, and a video can't
be both a candidate for un-ignoring and newly-ignoring in the same pass (its status
changes between the two queries' `where` clauses), so there's no double-processing risk
from doing them sequentially against the same `rules` snapshot.

### `src/lib/ingest.ts` changes

`applyFeedToChannel` fetches the current rule set once per call and computes each
entry's match before its upsert, folding the result into `.values()` only:

```ts
import { listIgnoreRules, matchesAnyRule } from "./ignore-rules";

export function applyFeedToChannel(channelId: number, feed: ChannelFeed): void {
  const previousNewest = /* unchanged */;
  const rules = listIgnoreRules();

  for (const entry of feed.entries) {
    const ignored = matchesAnyRule(
      { title: entry.title, description: entry.description },
      rules,
    );
    db.insert(videos)
      .values({
        channelId,
        youtubeVideoId: entry.videoId,
        title: entry.title,
        description: entry.description,
        publishedAt: entry.publishedAt,
        ...(ignored ? { status: "ignored" as const, ignoreMethod: "auto" as const } : {}),
      })
      .onConflictDoUpdate({
        target: videos.youtubeVideoId,
        set: {
          title: entry.title,
          description: entry.description,
          publishedAt: entry.publishedAt,
          // status/ignoreMethod still deliberately excluded here, unchanged from
          // before this spec -- values() above only ever takes effect on the insert
          // branch of this upsert, so a rule match only auto-ignores a video the first
          // time it's ever ingested, never retroactively on a later poll that updates
          // an already-seen video's title/description. This is what makes the
          // insert-time-only semantics from Context/Scope correct without any extra
          // "does this row already exist" check -- onConflictDoUpdate's `set` clause
          // already guarantees the update branch never touches these two columns.
        },
      })
      .run();
  }

  /* ...unchanged gap-detection and reschedule logic below... */
}
```

### `src/lib/watch-status.ts` changes

**Real gap caught in red-team review, fixed here rather than left implicit:** none of
the three *existing* functions (`setWatching`, `toggleQueueStatus`,
`toggleWatchedFromWatchingPage`) touch `ignoreMethod`, and none of their call sites
(`/watching/:id`, `/videos/:id/toggle`, `/videos/:id/watched-toggle`) guard against
being invoked against a video whose `status` is currently `ignored` — `videoForWatchingPage`
has no status filter, and the two POST routes look a video up by bare id with no status
check either. Concretely: a video is `watching`; a rule edit's reconciliation pass
auto-ignores it while a `/watching/:id` tab for it is still open; the user then clicks
"Mark Watched & Return to X" — `toggleWatchedFromWatchingPage` moves it to `watched`
but leaves `ignoreMethod: "auto"` in place, silently violating `app_idea.md`'s own
data-model invariant ("`ignore_method`... null unless status is `ignored`"). All three
existing functions now unconditionally clear `ignoreMethod` alongside their status
write, since none of their target statuses (`watching`, `watched`, `unwatched`) is ever
`ignored`:

```ts
export function setWatching(videoId: number): { status: "watching" } | null {
  const current = db
    .select({ status: videos.status })
    .from(videos)
    .where(eq(videos.id, videoId))
    .get();
  if (!current) return null;

  db.update(videos)
    .set({
      status: "watching",
      // Only touches watchedAt on the watched -> watching branch (the rewatch flow via
      // the Watching page's "Mark Watching" button) -- the other two source states
      // (unwatched, watching) already have it null, so leaving the key out of `set`
      // avoids a redundant write on the far more common non-rewatch path.
      ...(current.status === "watched" ? { watchedAt: null } : {}),
      ignoreMethod: null, // new -- closes the stale-ignoreMethod gap above; a no-op
      // write on the far more common already-null path, same tradeoff as watchedAt's
      // comment just above, just unconditional rather than branch-gated since every
      // non-ignored target status here has ignoreMethod null already.
    })
    .where(eq(videos.id, videoId))
    .run();

  return { status: "watching" };
}
```

`toggleQueueStatus` and `toggleWatchedFromWatchingPage` each gain the identical single
new key in their existing `.set({...})` call — fully sketched here too, rather than
left as prose, per a second red-team pass's note that leaving these two as prose was
itself the same "described only in prose" category this spec already criticizes itself
for elsewhere (only the *addition* is new; every other line is unchanged from the
current file):

```ts
export function toggleQueueStatus(
  videoId: number,
): { status: "watched" | "unwatched" } | null {
  const current = db.select({ status: videos.status }).from(videos)
    .where(eq(videos.id, videoId)).get();
  if (!current) return null;

  // unwatched -> watched
  // watched   -> unwatched
  // watching  -> unwatched
  const nextStatus = current.status === "unwatched" ? "watched" : "unwatched";

  db.update(videos)
    .set({
      status: nextStatus,
      watchedAt: nextStatus === "watched" ? new Date() : null,
      ignoreMethod: null, // new
    })
    .where(eq(videos.id, videoId))
    .run();

  return { status: nextStatus };
}

export function toggleWatchedFromWatchingPage(
  videoId: number,
): { status: "watched" | "unwatched" } | null {
  const current = db.select({ status: videos.status }).from(videos)
    .where(eq(videos.id, videoId)).get();
  if (!current) return null;

  const nextStatus = current.status === "watched" ? "unwatched" : "watched";

  db.update(videos)
    .set({
      status: nextStatus,
      watchedAt: nextStatus === "watched" ? new Date() : null,
      ignoreMethod: null, // new
    })
    .where(eq(videos.id, videoId))
    .run();

  return { status: nextStatus };
}
```

Two new functions, same shape as the existing three:

```ts
export function ignoreVideo(videoId: number): { status: "ignored" } | null {
  const current = db.select({ status: videos.status }).from(videos)
    .where(eq(videos.id, videoId)).get();
  if (!current) return null;

  db.update(videos)
    .set({ status: "ignored", ignoreMethod: "manual", watchedAt: null })
    .where(eq(videos.id, videoId))
    .run();
  return { status: "ignored" };
}

export function unignoreVideo(videoId: number): { status: "unwatched" } | null {
  const current = db.select({ status: videos.status }).from(videos)
    .where(eq(videos.id, videoId)).get();
  if (!current) return null;

  db.update(videos)
    .set({ status: "unwatched", ignoreMethod: null, watchedAt: null })
    .where(eq(videos.id, videoId))
    .run();
  return { status: "unwatched" };
}
```

**Real bug caught in a second red-team pass, fixed here:** an earlier draft of
`unignoreVideo` left `watchedAt` untouched. `POST /videos/:id/unignore` (see routes
below) has no status guard, same as every other by-id route in this codebase — so
calling it against a video that's currently `watched` (reachable: its id is exposed in
`/ignored`'s rendered markup, and a stale tab could separately mark that same video
Watched via the already-unguarded `/videos/:id/watched-toggle` first) would set
`status: "unwatched"` while leaving `watchedAt` non-null, violating the
`watched_at_check` constraint (`(status = 'watched') = (watched_at is not null)`,
`src/db/schema.ts`) and throwing at the `.run()` call — an uncaught 500, not a silent
bad state. `ignoreVideo` above already clears `watchedAt` defensively for the same
underlying reason (unguarded-by-id routes); `unignoreVideo` now does too, closing the
one call site that didn't.

Separately (not a bug, just worth stating plainly): `POST /videos/:id/ignore` itself
also has no status guard, so calling it against a video that's already `ignored`
(again, only reachable by directly hitting the route with a known id — no UI surface
does this) would harmlessly set `ignoreMethod: 'manual'` again. That's not a bad state;
it's exactly the deferred "lock in" behavior from Context, just reachable through the
raw route rather than through any UI this spec builds. Left as-is — no UI surface
triggers it, and there's no invariant it violates.

### `src/routes/queue.tsx` changes

New query function, same shape as `queueVideos`/`continueWatchingVideos`, scoped to
active subscriptions like those two (not true history like `watchedVideos`):

```ts
function ignoredVideos(userId: number, categoryId?: number) {
  return db
    .select({
      id: videos.id,
      title: videos.title,
      channelName: youtubeChannels.name,
      categoryName: categories.name,
      ignoreMethod: videos.ignoreMethod,
    })
    .from(videos)
    .innerJoin(youtubeChannels, eq(videos.channelId, youtubeChannels.id))
    .innerJoin(subscriptions, eq(subscriptions.youtubeChannelId, youtubeChannels.id))
    .innerJoin(categories, eq(subscriptions.categoryId, categories.id))
    .where(
      and(
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        eq(videos.status, "ignored"),
        ...(categoryId !== undefined ? [eq(subscriptions.categoryId, categoryId)] : []),
      ),
    )
    .orderBy(desc(videos.createdAt))
    .all();
}
```

`buildIgnoredHref`, the route, and the toggle-style ignore/unignore routes, all
following spec006's established `buildXHref`/`resolveCategoryFilter` pattern exactly:

```ts
function buildIgnoredHref(category?: number): string {
  const params = new URLSearchParams();
  if (category !== undefined) params.set("category", String(category));
  const qs = params.toString();
  return `/ignored${qs ? `?${qs}` : ""}`;
}

queueRoute.get("/ignored", (c) => {
  const user = getCurrentUser();
  const category = resolveCategoryFilter(c.req.query("category"));
  return c.html(
    <Layout title="Ignored">
      <CategoryFilterLinks
        categories={allCategories()}
        current={category}
        buildHref={buildIgnoredHref}
      />
      <QueueList view="ignored" category={category} rows={ignoredVideos(user.id, category)} />
    </Layout>,
  );
});

queueRoute.post("/videos/:id/ignore", (c) => {
  const id = Number(c.req.param("id"));
  const result = ignoreVideo(id);
  if (!result) return c.notFound();

  const user = getCurrentUser();
  const view = resolveToggleView(c.req.query("view"));
  const sort = resolveSort(c.req.query("sort"));
  const category = resolveCategoryFilter(c.req.query("category"));

  if (view === "continue-watching") {
    return c.html(
      <QueueList view="continue-watching" category={category} rows={continueWatchingVideos(user.id, category)} />,
    );
  }
  return c.html(
    <QueueList view="queue" sort={sort} category={category} rows={queueVideos(user.id, sort, category)} />,
  );
});

queueRoute.post("/videos/:id/unignore", (c) => {
  const id = Number(c.req.param("id"));
  const result = unignoreVideo(id);
  if (!result) return c.notFound();

  const user = getCurrentUser();
  const category = resolveCategoryFilter(c.req.query("category"));
  return c.html(
    <QueueList view="ignored" category={category} rows={ignoredVideos(user.id, category)} />,
  );
});
```

`POST /videos/:id/ignore` deliberately mirrors `POST /videos/:id/toggle`'s exact
`view`/`sort`/`category` reading and re-render branching (down to reusing
`resolveToggleView`) rather than introducing a third pattern — same re-render target,
same two possible source views.

### `src/views/queue-list.tsx` changes

`QueueListProps`'s union gains an `"ignored"` variant with its own row type:

**Type-error caught in red-team review:** `videos.ignoreMethod` has no `.notNull()` in
`src/db/schema.ts` (only `watchedAt` is tied to its status via the `watched_at_check`
constraint — `ignoreMethod` isn't similarly tied to `status = 'ignored'`), so
`ignoredVideos()`'s direct select of `videos.ignoreMethod` infers as
`"manual" | "auto" | null` under Drizzle, not the non-nullable type an earlier draft of
this section declared. `IgnoredRow` is typed nullable to match, and the render branch
below only shows the `[manual]`/`[auto]` annotation when it's actually present rather
than asserting/coalescing a value that the schema doesn't actually guarantee:

```ts
export type IgnoredRow = {
  id: number;
  title: string;
  channelName: string;
  categoryName: string;
  ignoreMethod: "manual" | "auto" | null;
};

type QueueListProps =
  | { view: "queue"; sort: "newest" | "oldest"; category?: number; rows: QueueRow[] }
  | { view: "continue-watching"; category?: number; rows: QueueRow[] }
  | { view: "watched"; category?: number; rows: WatchedRow[] }
  | { view: "ignored"; category?: number; rows: IgnoredRow[] };
```

New href helpers, same `URLSearchParams`-based shape as `toggleHref`:

```ts
function ignoreHref(
  id: number,
  view: "queue" | "continue-watching",
  sort?: "newest" | "oldest",
  category?: number,
): string {
  const params = new URLSearchParams({ view });
  if (sort) params.set("sort", sort);
  if (category !== undefined) params.set("category", String(category));
  return `/videos/${id}/ignore?${params.toString()}`;
}

function unignoreHref(id: number, category?: number): string {
  const params = new URLSearchParams();
  if (category !== undefined) params.set("category", String(category));
  const qs = params.toString();
  return `/videos/${id}/unignore${qs ? `?${qs}` : ""}`;
}
```

`QueueList`'s body becomes a three-way branch on `props.view` (`watched` / `ignored` /
queue+continue-watching), fully sketched here rather than left as prose — spec006's own
retro flagged exactly this category of gap ("described only in prose... exactly the
kind of gap that let a bug slip through undetected") for `watchedToggleAction`, so this
spec holds itself to the same standard rather than repeating it:

```tsx
export const QueueList: FC<QueueListProps> = (props) => {
  return (
    <div id="queue-list">
      <ul>
        {props.view === "watched"
          ? props.rows.map((row) => (
              <li key={row.id}>
                <a
                  href={watchingHref(row.id, "watched", undefined, props.category)}
                  class="watch-link"
                  data-youtube-url={youtubeUrl(row.youtubeVideoId)}
                >
                  {row.title}
                </a>{" "}
                — {row.channelName} ({row.categoryName})
                {row.watchedAt
                  ? ` · watched ${row.watchedAt.toLocaleDateString()}`
                  : ""}
              </li>
            ))
          : props.view === "ignored"
            ? props.rows.map((row) => (
                <li key={row.id}>
                  {row.title}
                  {row.ignoreMethod ? ` [${row.ignoreMethod}]` : ""} —{" "}
                  {row.channelName} ({row.categoryName})
                  <button
                    type="button"
                    hx-post={unignoreHref(row.id, props.category)}
                    hx-target="#queue-list"
                    hx-swap="outerHTML"
                    hx-disabled-elt="this"
                  >
                    Un-ignore
                  </button>
                </li>
              ))
            : props.rows.map((row) => {
                const sort = props.view === "queue" ? props.sort : undefined;
                return (
                  <li key={row.id}>
                    <a
                      href={watchingHref(row.id, props.view, sort, props.category)}
                      class="watch-link"
                      data-youtube-url={youtubeUrl(row.youtubeVideoId)}
                    >
                      {row.title}
                    </a>{" "}
                    — {row.channelName} ({row.categoryName})
                    {row.publishedAt
                      ? ` · published ${row.publishedAt.toLocaleDateString()}`
                      : ""}
                    <button
                      type="button"
                      hx-post={toggleHref(row.id, props.view, sort, props.category)}
                      hx-target="#queue-list"
                      hx-swap="outerHTML"
                      hx-disabled-elt="this"
                    >
                      {row.status === "watching"
                        ? "Clear to Unwatched"
                        : "Mark Watched"}
                    </button>
                    <button
                      type="button"
                      hx-post={ignoreHref(row.id, props.view, sort, props.category)}
                      hx-target="#queue-list"
                      hx-swap="outerHTML"
                      hx-disabled-elt="this"
                    >
                      Ignore
                    </button>
                  </li>
                );
              })}
      </ul>
    </div>
  );
};
```

(`props.view` is narrowed to `"queue" | "continue-watching"` inside the third branch
already, same narrowing the existing `toggleHref` call relies on — `ignoreHref` reuses
that same narrowed `props.view`/`sort` pair.)

### `src/routes/ignore-rules.tsx` (new)

Modeled directly on `categories.tsx`'s add/list shape, extended with edit/delete:

```tsx
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { ignoreRules } from "../db/schema";
import { listIgnoreRules, reconcileIgnoreRules } from "../lib/ignore-rules";
import { IgnoreRulesList } from "../views/ignore-rules-list";
import { IgnoreRulesPage } from "../views/ignore-rules-page";

export const ignoreRulesRoute = new Hono();

ignoreRulesRoute.get("/ignore-rules", (c) => {
  return c.html(<IgnoreRulesPage rules={listIgnoreRules()} />);
});

ignoreRulesRoute.post("/ignore-rules", async (c) => {
  const body = await c.req.parseBody();
  const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
  if (!keyword) {
    return c.html(<IgnoreRulesList rules={listIgnoreRules()} error="Keyword is required." />);
  }
  db.insert(ignoreRules).values({ keyword }).run();
  reconcileIgnoreRules();
  return c.html(<IgnoreRulesList rules={listIgnoreRules()} />);
});

ignoreRulesRoute.get("/ignore-rules/:id/edit", (c) => {
  const id = Number(c.req.param("id"));
  return c.html(<IgnoreRulesList rules={listIgnoreRules()} editingId={id} />);
});

ignoreRulesRoute.post("/ignore-rules/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
  if (!keyword) {
    return c.html(
      <IgnoreRulesList rules={listIgnoreRules()} editingId={id} error="Keyword is required." />,
    );
  }
  const updated = db.update(ignoreRules).set({ keyword })
    .where(eq(ignoreRules.id, id)).returning().get();
  if (!updated) return c.notFound();
  reconcileIgnoreRules();
  return c.html(<IgnoreRulesList rules={listIgnoreRules()} />);
});

ignoreRulesRoute.delete("/ignore-rules/:id", (c) => {
  const id = Number(c.req.param("id"));
  const deleted = db.delete(ignoreRules).where(eq(ignoreRules.id, id)).returning().get();
  if (!deleted) return c.notFound();
  reconcileIgnoreRules();
  return c.html(<IgnoreRulesList rules={listIgnoreRules()} />);
});
```

Every mutating route (add/edit/delete) runs `reconcileIgnoreRules()` synchronously
after its own DB write and before re-rendering — at MVP's personal-subscription scale
a full-table reconciliation pass costs nothing and there's no background-job
infrastructure to defer it to.

### `src/views/ignore-rules-list.tsx` + `ignore-rules-page.tsx` (new)

`IgnoreRulesPage` is a thin `Layout` wrapper, same shape as `CategoriesPage`:

```tsx
import type { FC } from "hono/jsx";
import type { ignoreRules } from "../db/schema";
import { Layout } from "./layout";
import { IgnoreRulesList } from "./ignore-rules-list";

export const IgnoreRulesPage: FC<{
  rules: (typeof ignoreRules.$inferSelect)[];
}> = (props) => (
  <Layout title="Ignore Rules">
    <IgnoreRulesList rules={props.rules} />
  </Layout>
);
```

`IgnoreRulesList` is the interesting piece — an `editingId` prop switches one row into
an inline edit form, following the exact `hx-select` "reuse the GET route as a cancel
target" pattern `subscribe-confirm.tsx`'s `ConfirmPanel` Cancel button already
established:

```tsx
import type { FC } from "hono/jsx";
import type { ignoreRules } from "../db/schema";

type IgnoreRule = typeof ignoreRules.$inferSelect;

export const IgnoreRulesList: FC<{
  rules: IgnoreRule[];
  editingId?: number;
  error?: string;
}> = (props) => (
  <div id="ignore-rules-list">
    <ul>
      {props.rules.map((rule) =>
        props.editingId === rule.id ? (
          <li key={rule.id}>
            <form
              hx-post={`/ignore-rules/${rule.id}`}
              hx-target="#ignore-rules-list"
              hx-swap="outerHTML"
            >
              <input type="text" name="keyword" value={rule.keyword} />
              <button type="submit">Save</button>
            </form>
            <button
              type="button"
              hx-get="/ignore-rules"
              hx-select="#ignore-rules-list"
              hx-target="#ignore-rules-list"
              hx-swap="outerHTML"
            >
              Cancel
            </button>
          </li>
        ) : (
          <li key={rule.id}>
            {rule.keyword}{" "}
            <button
              type="button"
              hx-get={`/ignore-rules/${rule.id}/edit`}
              hx-target="#ignore-rules-list"
              hx-swap="outerHTML"
            >
              Edit
            </button>{" "}
            <button
              type="button"
              hx-delete={`/ignore-rules/${rule.id}`}
              hx-target="#ignore-rules-list"
              hx-swap="outerHTML"
            >
              Delete
            </button>
          </li>
        ),
      )}
    </ul>
    {props.error ? <p class="text-red-600">{props.error}</p> : null}
    <form hx-post="/ignore-rules" hx-target="#ignore-rules-list" hx-swap="outerHTML">
      <input type="text" name="keyword" placeholder="New keyword" />
      <button type="submit">Add</button>
    </form>
  </div>
);
```

If `editingId` doesn't match any row in `rules` (e.g. the rule was deleted by a
concurrent request between the Edit click and this render), no row enters edit mode —
the list just renders normally, the same silent-fallback posture used throughout this
codebase for stale/invalid state rather than a special error path.

### `src/views/layout.tsx` nav

```tsx
<a href="/">Categories</a> | <a href="/channels">Channels</a> |{" "}
<a href="/queue">Queue</a> | <a href="/continue-watching">Continue Watching</a> |{" "}
<a href="/watched">Watched</a> | <a href="/ignored">Ignored</a> |{" "}
<a href="/ignore-rules">Ignore Rules</a>
```

### `src/index.ts`

```ts
import { ignoreRulesRoute } from "./routes/ignore-rules";
// ...
app.route("/", ignoreRulesRoute);
```

### Testing

`test/lib/ignore-rules.test.ts` (new):
- `matchesAnyRule`: matches a title substring case-insensitively; matches a
  description substring; no match when neither field contains any rule's keyword;
  an empty rule set never matches anything.
- `reconcileIgnoreRules`: an `ignored`+`auto` video whose matching rule was deleted
  reverts to `unwatched` with `ignoreMethod: null`; an `unwatched` video newly matching
  a just-added rule becomes `ignored`+`auto`; a `watching` video newly matching a rule
  also becomes `ignored`+`auto` (explicit coverage — app_idea.md calls out
  Unwatched *and* Watching); a `watched` video that would match a rule is left
  untouched (reconciliation never considers `watched` a candidate); an `ignored`+
  `manual` video is left untouched by both directions even when it would/wouldn't
  match current rules.

`test/lib/watch-status.test.ts` extension (gap caught while decomposing this spec into
tasks — the Design section's `ignoreMethod`-clearing fix on the three pre-existing
functions otherwise had no direct unit coverage, only indirect coverage through the new
HTTP routes' tests below):
- `setWatching`, `toggleQueueStatus`, and `toggleWatchedFromWatchingPage` each clear a
  stale `ignoreMethod` to `null` — for each function, create a video via the existing
  `makeVideo` helper, directly `db.update(videos).set({ ignoreMethod: "auto" })` to
  simulate the stale-state scenario the Design section describes, call the function,
  and assert `ignoreMethod` is `null` afterward. Cover all three functions explicitly,
  not just one.
- `ignoreVideo`: transitions `unwatched` to `ignored`/`manual` and clears `watchedAt`;
  transitions `watching` to `ignored`/`manual`; returns `null` for a nonexistent id.
- `unignoreVideo`: transitions both an `ignored`/`manual` and an `ignored`/`auto` video
  to `unwatched` with `ignoreMethod: null` (cover both source values); transitions a
  `watched` video (non-null `watchedAt`) to `unwatched` without throwing, clearing
  `watchedAt` to `null` (the direct unit-level version of the crash regression a second
  red-team pass caught — see `unignoreVideo`'s Design section); returns `null` for a
  nonexistent id.

`test/lib/ingest.test.ts` extension:
- A feed entry matching an existing `IgnoreRule` is inserted as `ignored`/`auto` on
  first ingestion.
- The same video, re-ingested on a later poll with a changed title that would now
  match a rule it didn't match originally, keeps its existing status unchanged (proves
  the insert-time-only semantics — `onConflictDoUpdate`'s `set` never touches
  status/ignoreMethod).

`test/routes/ignore-rules.test.ts` (new):
- `GET /ignore-rules` lists existing rules.
- `POST /ignore-rules` adds a rule (empty keyword rejected with an inline error,
  re-rendering the list unchanged); a successful add triggers reconciliation
  (assert against a fixture video that newly matches).
- `GET /ignore-rules/:id/edit` renders that row in edit mode.
- `POST /ignore-rules/:id` renames a rule (empty keyword rejected, staying in edit
  mode with an error; nonexistent id 404s) and triggers reconciliation (assert a
  fixture video that no longer matches the renamed keyword reverts to unwatched).
- `DELETE /ignore-rules/:id` removes a rule (nonexistent id 404s) and triggers
  reconciliation (a fixture `auto`-ignored video with no other matching rule reverts
  to unwatched).

`test/routes/queue.test.ts` extension:
- `POST /videos/:id/ignore?view=queue&...` and `?view=continue-watching&...` both
  set the video to `ignored`/`manual` and re-render with it removed from the
  respective list, same category/sort-preservation coverage spec006 established for
  `/videos/:id/toggle` (cover both `view` branches explicitly, same reasoning
  spec006 already flagged: it's a plausible slip to thread the new route through only
  one of the two re-render branches).
- `GET /ignored` lists only `ignored` videos scoped to active subscriptions; an
  ignored video whose channel has since been unsubscribed does **not** appear (the one
  behavioral difference from `/watched`, confirming the active-subscriptions-only
  scoping decision); `?category=<id>` filters correctly, including to the
  Uncategorized category; an invalid/nonexistent `category` falls back to unfiltered.
- `POST /videos/:id/unignore` reverts an `ignored`/`manual` video and, separately, an
  `ignored`/`auto` video, both to `unwatched` with `ignoreMethod: null`, and removes
  it from the re-rendered `/ignored` list — cover both source `ignoreMethod` values
  explicitly, since un-ignore must behave identically regardless of how the video got
  ignored.
- `POST /videos/:id/unignore` against a video whose status is currently `watched`
  (`watchedAt` non-null) does **not** throw/500 and correctly clears `watchedAt` to
  `null` alongside `status: 'unwatched'` — the regression test for the crash a second
  red-team pass caught (see `unignoreVideo`'s Design section): without clearing
  `watchedAt`, this update would violate the `watched_at_check` constraint.
- Category-filter round trip for `/ignored`'s picker links, same pattern as the other
  three views' existing coverage.
- **End-to-end row-button round trip** (caught missing in red-team review — the bullets
  above only hit `/videos/:id/ignore`/`/videos/:id/unignore` with hand-built query
  strings, which would still all pass even if `ignoreHref`/`unignoreHref` were never
  actually wired into `queue-list.tsx`'s JSX, exactly the gap spec006's own "End-to-end
  row-link round trip" test was added to close for `watchingHref`): `GET /queue`, parse
  a row's rendered Ignore button's `hx-post` value out of the response body (not
  hand-constructed), `POST` to that extracted URL, and assert the video is gone from a
  fresh `GET /queue`. Repeat once for `/continue-watching`'s Ignore button and once for
  `/ignored`'s Un-ignore button (parsed from a `GET /ignored` response, asserting the
  video reappears on a fresh `GET /queue` as `unwatched`).

### Verification (manual, end-to-end)

1. Add an `IgnoreRule` whose keyword matches an existing Unwatched video's title —
   confirm it disappears from `/queue` and appears on `/ignored` tagged `[auto]`.
2. From `/queue`, click "Ignore" on a different Unwatched video — confirm it
   disappears from `/queue` and appears on `/ignored` tagged `[manual]`.
3. Click "Un-ignore" on each of the two videos from step 1/2 — confirm both return to
   `/queue` as Unwatched.
4. Re-add the same rule from step 1 (re-matching that video, which is back to
   Unwatched after step 3) and confirm it's auto-ignored again.
5. Edit that rule's keyword to something that no longer matches — confirm the
   auto-ignored video from step 4 reverts to Unwatched on `/queue`.
6. Manually Ignore that same video again, then edit the rule's keyword back to
   something matching it — confirm it stays Ignored and does **not** flip its
   `[manual]` tag to `[auto]` (manual ignores are untouched by reconciliation in
   either direction).
7. Delete the `IgnoreRule` entirely — confirm no remaining videos are wrongly
   affected (nothing was relying solely on it besides what's already been manually
   handled above).
8. Filter `/ignored` by category — confirm scoping matches the other three views.
9. Unsubscribe from a channel with a currently-ignored video — confirm it drops out
   of `/ignored` (unlike `/watched`, which would keep it).
10. `bun test`, `bun run lint`, and `bunx tsc --noEmit` all clean.

## Open Questions

None currently open. A red-team pass of this spec's draft (before any implementation)
caught four real issues, all fixed in the Design section above rather than left as risk:
- `IgnoredRow.ignoreMethod` was typed non-nullable (`"manual" | "auto"`) while
  `ignoredVideos()`'s Drizzle select actually infers `"manual" | "auto" | null` from
  the schema's nullable `ignoreMethod` column — a `tsc --noEmit` error, not just a style
  slip. Fixed by widening the type and rendering the `[manual]`/`[auto]` tag
  conditionally (see `src/views/queue-list.tsx` changes).
- The `src/routes/ignore-rules.tsx` sketch imported `asc` from `drizzle-orm` without
  using it (ordering lives inside `listIgnoreRules()` instead) — would fail
  `bun run lint`'s `noUnusedImports` rule. Fixed by dropping the unused import.
- None of the three pre-existing `watch-status.ts` functions cleared `ignoreMethod`,
  and none of their call sites guard against acting on an already-`ignored` video (all
  reachable directly by id, with no status filter) — a video could get marked
  Watching/Watched while silently keeping a stale `ignoreMethod`, violating
  `app_idea.md`'s own "null unless status is ignored" invariant. Fixed by having all
  three existing functions unconditionally clear `ignoreMethod` alongside their status
  write (see `src/lib/watch-status.ts` changes).
- No test exercised the actual `ignoreHref`/`unignoreHref`-generated row buttons through
  to a real status change — only the route handlers in isolation, which would all still
  pass even if those two functions were never wired into `queue-list.tsx`'s JSX. Added
  as the Testing section's "End-to-end row-button round trip" bullet.

A second red-team pass (after the first pass's four fixes above were already applied)
caught one real bug and two consistency gaps, all now fixed:
- **Real bug:** `unignoreVideo` didn't clear `watchedAt`, so calling
  `POST /videos/:id/unignore` against a video whose status happened to be `watched`
  (reachable via the same unguarded-by-id pattern fix #3 above already diagnosed for
  three other functions) would violate the `watched_at_check` constraint and throw —
  an uncaught 500, not just a silent bad state. Fixed by having `unignoreVideo`
  unconditionally clear `watchedAt` too, matching `ignoreVideo`'s existing defensive
  clear. A dedicated regression test bullet was added to Testing.
- `reconcileIgnoreRules`'s two-pass loop issued individual synchronous updates with no
  transaction — unlike `applyFeedToChannel`'s per-channel upserts (which self-heal on
  the next hourly scheduled poll regardless of a mid-run failure), this function only
  reruns on the next explicit rule CRUD action, so a mid-loop crash could leave
  inconsistent state indefinitely. Fixed by wrapping both passes in one
  `db.transaction(...)`.
- `toggleQueueStatus`/`toggleWatchedFromWatchingPage`'s `ignoreMethod: null` addition
  and `IgnoreRulesPage`'s shape were both left as prose rather than fully sketched —
  the exact "described only in prose" gap category this spec already criticizes itself
  for elsewhere. Both are now fully sketched in their respective Design subsections.

Also confirmed, not a gap: `POST /videos/:id/ignore` against an already-`ignored` video
(reachable only by directly hitting the route with a known id, no UI surface does this)
harmlessly re-sets `ignoreMethod: 'manual'` — this is exactly the deferred "lock in"
behavior from Context, just reachable through the raw route rather than any UI this
spec builds; left as-is since nothing breaks and no UI triggers it.

The one deferred item from Context (the "lock in"/convert-to-manual action, as a real
UI surface) remains an accepted scope cut, not an open question — it can be picked up
in a follow-up spec if auto-ignored videos accumulating without a lock-in path proves
annoying in real use.

A third pass — decomposing this spec into `docs/specs/tasks/007-ignore-rules-and-ignored-view.md`
via `/spec-tasks`, a different failure mode than the two red-team passes above (checking
the decomposition, not the design) — caught one gap: the Testing section had no direct
unit coverage for the `ignoreMethod`-clearing fix on the three pre-existing
`watch-status.ts` functions, only indirect coverage through the new ignore/unignore
routes' HTTP-level tests. Fixed by adding the `test/lib/watch-status.test.ts` extension
bullet above.
