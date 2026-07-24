---
status: draft
created: 2026-07-24
---

# Category Queue Filtering

## Context

Specs 001–005 delivered MVP items 1, 2, 3, and 5 (subscribe/categorize channels,
scheduled RSS ingestion, the three-state watch flow, unsubscribe), plus two follow-up
bugfixes. What's never been built is `docs/app_idea.md`'s stated **Key Differentiator**:
letting the user split their queue by category, since different categories need
different "watch modes" (Podcasts are long-form background listening, Let's Plays and
Tutorials are focused sit-down watching, etc.) — the whole reason the product exists
instead of just using YouTube's own Subscriptions page.

Today `/queue`, `/continue-watching`, and `/watched` (all from spec004, sort toggle from
spec005) render every video across every category in one blended list. Each row already
displays its category name (`queue-list.tsx`), but there's no way to narrow to just one.

This spec is the filtering mechanism itself — it does not change how categories are
created/assigned/renamed (that's `/categories` and the subscribe flow, both already
built), and does not add any new grouped/sectioned layout. Confirmed during scoping:
single-category filtering (switch into one category's view at a time, not several
blended or all sections rendered at once), applied consistently across all three views,
with the system Uncategorized category included as a filterable option like any other.

## Scope

**In:**
- A category filter, applied one category at a time via `?category=<id>`, on all three
  video-list views: `GET /queue`, `GET /continue-watching`, `GET /watched`.
- The filter's option list is every category that exists (including the system
  Uncategorized row), not just categories with videos currently present in a given
  view — same simple query on every page, no view-specific "distinct categories in this
  result set" computation.
- A plain link-list picker per view — "All · Podcasts · Tutorials · Uncategorized" — no
  active-link highlighting, matching the exact precedent spec004's nav and spec005's
  sort toggle already established ("no active-link highlighting or other polish — first
  pass just needs the links to exist").
- `category` composes with the existing `sort` param on `/queue` (both survive together
  in the URL and through row links) and threads through the existing smart
  return-to-origin navigation (`/watching/:id`'s "Return to X" / "Mark Watched & Return
  to X"), so filtering into a category, opening a video, and returning lands back on the
  same filtered (and, for queue, same-sorted) view.
- An invalid, missing, or nonexistent `category` value falls back to unfiltered ("All"),
  the same defensive-fallback posture `resolveSort`/`resolveToggleView`/
  `resolveReturnTarget`'s `from` handling already use elsewhere in this codebase — never
  a 500.

**Out (deferred):**
- Grouped/sectioned "all categories at once" layout — confirmed during scoping as a
  separate, larger UI shape not needed to deliver the differentiator; single-category
  filtering is the whole ask here.
- Multi-category selection (filtering to two or more categories at once).
- A `<select>`-dropdown picker or any other UI beyond the plain link list — revisit only
  if the link list turns out unwieldy once a real category count is in use (see Open
  Questions).
- Any change to category CRUD, the `/categories` page, or channel-to-category
  assignment — unrelated surfaces, untouched here.
- Persisting the last-used filter across sessions/requests beyond what the URL itself
  carries (no cookie/session-stored "last filter").
- Auth/CSRF — same deferred posture as every prior spec.

## Design

### Category filter resolution (`src/routes/queue.tsx`)

```ts
function resolveCategoryFilter(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const id = Number(raw);
  if (!Number.isInteger(id)) return undefined;
  const exists = db.select({ id: categories.id }).from(categories)
    .where(eq(categories.id, id)).get();
  return exists ? id : undefined;
}
```

A DB round-trip per request (rather than trusting a bare numeric-looking param) mirrors
how `resolveToggleView`/`resolveSort` already validate against a fixed allow-list —
`category` isn't a fixed enum, but the same "never trust it, fall back silently on
anything that doesn't resolve" posture applies. `undefined` means "All" (no filter)
throughout.

### Query changes (`src/routes/queue.tsx`)

All three existing query helpers gain an optional `categoryId` parameter, added to
their `where(and(...))` clause only when present — no new joins needed, since all three
already join `subscriptions`/`categories` to render `categoryName` on each row:

```ts
function queueVideos(userId: number, sort: "newest" | "oldest", categoryId?: number) {
  return db.select({ /* unchanged */ }).from(videos)
    .innerJoin(youtubeChannels, eq(videos.channelId, youtubeChannels.id))
    .innerJoin(subscriptions, eq(subscriptions.youtubeChannelId, youtubeChannels.id))
    .innerJoin(categories, eq(subscriptions.categoryId, categories.id))
    .where(and(
      eq(subscriptions.userId, userId),
      isNull(subscriptions.unsubscribedAt),
      inArray(videos.status, ["unwatched", "watching"]),
      ...(categoryId !== undefined ? [eq(subscriptions.categoryId, categoryId)] : []),
    ))
    .orderBy(/* unchanged */)
    .all();
}
```

Same shape applied to `continueWatchingVideos(userId, categoryId?)` and
`watchedVideos(userId, categoryId?)`. `watchedVideos` filtering by category still works
unchanged for a since-unsubscribed channel's history, since it already joins
`subscriptions`/`categories` without the active-subscription filter — a watched video's
category is whatever its (possibly-inactive) subscription row currently says, same as
today's unfiltered behavior.

Spreading a conditional single-element array into `and(...)`'s argument list (rather
than an `if` block building a mutable conditions array beforehand) matches this
codebase's existing terse style for optional filter clauses — confirm this compiles
against the installed `drizzle-orm@0.45.2` at implementation time, same "verify novel
Drizzle shape" posture specs 002/003/004 already flagged for other query patterns (see
Open Questions).

### Category option list (`src/routes/queue.tsx`)

One shared query, reused by all three routes' picker rendering:

```ts
function allCategories() {
  return db.select({ id: categories.id, name: categories.name, isSystem: categories.isSystem })
    .from(categories)
    .orderBy(desc(categories.isSystem), asc(categories.name))
    .all();
}
```

`isSystem desc` surfaces Uncategorized first, matching the skeleton `/` categories
page's existing "system row first, then alphabetical" convention from spec001.

### Picker component (`src/views/queue-list.tsx`)

```tsx
export const CategoryFilterLinks: FC<{
  categories: { id: number; name: string }[];
  buildHref: (categoryId?: number) => string;
  current?: number;
}> = (props) => (
  <p>
    <a href={props.buildHref()}>All</a>
    {props.categories.map((cat) => (
      <>
        {" "}
        · <a href={props.buildHref(cat.id)}>{cat.name}</a>
      </>
    ))}
  </p>
);
```

`buildHref` is supplied per-page so each view controls which other params (e.g. `sort`
on `/queue`) get preserved alongside `category` — kept out of the shared component
itself rather than hardcoding a `sort`-aware URL builder that `/continue-watching` and
`/watched` would have to no-op around. `current` is accepted but unused for now (no
active-link highlighting, per Scope) — kept in the props so it's a one-line addition
later rather than a signature change.

### Routes (`src/routes/queue.tsx`)

```tsx
queueRoute.get("/queue", (c) => {
  const user = getCurrentUser();
  const sort = resolveSort(c.req.query("sort"));
  const category = resolveCategoryFilter(c.req.query("category"));
  return c.html(
    <Layout title="Queue">
      <p>
        <a href={`/queue${category ? `?category=${category}` : ""}`}>Newest first</a> ·{" "}
        <a href={`/queue?sort=oldest${category ? `&category=${category}` : ""}`}>Oldest first</a>
      </p>
      <CategoryFilterLinks
        categories={allCategories()}
        current={category}
        buildHref={(catId) =>
          `/queue?${new URLSearchParams({
            ...(sort === "oldest" ? { sort: "oldest" } : {}),
            ...(catId !== undefined ? { category: String(catId) } : {}),
          }).toString()}`
        }
      />
      <QueueList view="queue" sort={sort} category={category} rows={queueVideos(user.id, sort, category)} />
    </Layout>,
  );
});
```

`GET /continue-watching` and `GET /watched` gain the analogous `resolveCategoryFilter`
call, a `CategoryFilterLinks` block whose `buildHref` only ever sets/omits `category`
(no `sort` to preserve), and pass `category` into their respective query calls.

`POST /videos/:id/toggle` (the row toggle, queue/continue-watching only) reads
`category` off the query string the same way it already reads `view`/`sort`, and passes
it through to the re-render so toggling a row doesn't drop the active filter:

```ts
queueRoute.post("/videos/:id/toggle", (c) => {
  // ...unchanged toggleQueueStatus call...
  const category = resolveCategoryFilter(c.req.query("category"));
  // ...re-render QueueList with `category` passed through to the matching query call...
});
```

### Return-to-origin navigation (`src/routes/queue.tsx`)

`RETURN_VIEWS`'s three `path` functions and `resolveReturnTarget` gain a `category`
parameter alongside the existing `sort`. Per the existing inline comment on this code
(TypeScript infers a call signature for a union of function types from their *common*
arity), all three entries must keep matching signatures even though `continue-watching`
and `watched` only use `category`, not `sort`:

```ts
// All three branches build their URL through URLSearchParams, not string
// interpolation -- category is an unvalidated, attacker-controlled string at this
// call site (see below), and URLSearchParams guarantees it's percent-encoded into
// the querystring rather than splicing raw bytes (CR/LF, `&`, `#`, etc.) into a
// value later handed straight to c.redirect() in POST /videos/:id/watched-toggle.
// An earlier draft of this spec interpolated continue-watching/watched's category
// directly into a template string while queue's went through URLSearchParams --
// same bug class the click-to-watch code in spec004 was already careful to avoid
// (see that spec's Design note on why the YouTube URL is a `data-` attribute, not
// a string-concatenated inline handler).
function buildReturnPath(base: string, sort?: string, category?: string): string {
  const params = new URLSearchParams();
  if (sort === "oldest") params.set("sort", "oldest");
  if (category !== undefined) params.set("category", category);
  const qs = params.toString();
  return `${base}${qs ? `?${qs}` : ""}`;
}

const RETURN_VIEWS = {
  queue: {
    label: "Queue",
    path: (sort?: string, category?: string) => buildReturnPath("/queue", sort, category),
  },
  "continue-watching": {
    label: "Continue Watching",
    path: (_sort?: string, category?: string) => buildReturnPath("/continue-watching", undefined, category),
  },
  watched: {
    label: "Watched",
    path: (_sort?: string, category?: string) => buildReturnPath("/watched", undefined, category),
  },
} as const;

function resolveReturnTarget(from: string | undefined, sort: string | undefined, category: string | undefined) {
  const key = from !== undefined && from in RETURN_VIEWS ? (from as keyof typeof RETURN_VIEWS) : "queue";
  const entry = RETURN_VIEWS[key];
  return { url: entry.path(sort, category), label: entry.label };
}
```

`category` here is carried as the raw query-string value (not re-validated through
`resolveCategoryFilter`) for the same reason `sort` already is — it's just being
round-tripped into a URL, not used to build a DB query at this call site; the
destination route re-validates it fresh when the URL is actually followed. Because
it's unvalidated, it must go through `URLSearchParams` (as above) everywhere it's
assembled into a URL or redirect target — never raw template-string interpolation.

`GET /watching/:id` and `POST /videos/:id/watched-toggle` both read `category` off
their query string and pass it into `resolveReturnTarget` alongside `from`/`sort`,
exactly as they already do for `sort`.

### Row links (`src/views/queue-list.tsx`, `src/views/watching-page.tsx`)

`watchingHref`, `toggleHref` (`queue-list.tsx`) each gain an optional `category: number`
parameter — **not** `string` — matching the type `resolveCategoryFilter` actually
produces and that the `/queue` route already passes straight into `queueVideos(...,
category)` (a `number | undefined`); converting to a string only happens inside these
two functions, at the point they build a `URLSearchParams` (`params.set("category",
String(category))`), the same place `CategoryFilterLinks`'s `buildHref` already does
`String(catId)`. `QueueListProps`'s three view variants gain a matching
`category?: number` field passed through from the route. (An earlier draft of this
section typed this field `string | undefined` while the route fed it a `number` — a
mismatch that would fail `tsc --noEmit` outright, not just be a style inconsistency;
called out explicitly here so it isn't reintroduced at implementation time.)

`watchedToggleAction` (`watching-page.tsx`) is different: it receives `category` off
`c.req.query("category")` on `GET /watching/:id` (already a raw `string | undefined`,
same as its existing `from`/`sort` params) and round-trips it unvalidated into the form
`action` URL via `URLSearchParams`, exactly like `RETURN_VIEWS`'s `buildReturnPath`
above — it never touches `resolveCategoryFilter` or a `number`. `WatchingPageProps`
gains a `category: string | undefined` field for this purpose. These are two distinct
`category` types flowing through this spec depending on which side of
`resolveCategoryFilter` they're on: **`number | undefined`** wherever a value has been
validated against the DB and is about to build a query or a `QueueList` prop
(`queue.tsx`'s route handlers, `queueVideos`/`continueWatchingVideos`/`watchedVideos`,
`QueueListProps`, `watchingHref`/`toggleHref`), and **`string | undefined`** wherever a
value is only being round-tripped through a URL without ever being validated
(`RETURN_VIEWS`/`resolveReturnTarget`, `WatchingPageProps`, `watchedToggleAction`,
`GET /watching/:id`'s own `from`/`sort`/`category` query reads). Keep the two straight
at implementation time — passing the unvalidated string into `QueueList`/`queueVideos`,
or the validated number where a raw querystring passthrough is expected, are both type
errors under this design, not just style slips.

### Testing (`test/routes/queue.test.ts`)

- `resolveCategoryFilter`: a real category's id (as a string) resolves to that number;
  a non-numeric string, a negative/non-integer number, and a well-formed but
  nonexistent id all resolve to `undefined`; a missing param resolves to `undefined`.
- `GET /queue?category=<id>` — only returns videos whose subscription's category
  matches; `?category=<uncategorized-id>` returns exactly the Uncategorized-channel
  videos; an invalid/nonexistent `category` value behaves identically to no `category`
  at all (full unfiltered list, no error); `category` composes with `?sort=oldest`
  correctly (both applied together).
- `GET /continue-watching?category=<id>` / `GET /watched?category=<id>` — same
  filtering behavior as queue's, and `watched`'s category filter still includes a video
  whose channel has since been unsubscribed (extends the existing "true history" test
  from spec004 with an active category filter).
- Category picker rendering: each of the three pages' response includes a link per
  existing category (including Uncategorized) plus an "All" link; on `/queue`, each
  category link preserves the current `sort` value and each sort link preserves the
  current `category` value.
- `POST /videos/:id/toggle?view=queue&sort=...&category=...` **and**
  `?view=continue-watching&category=...` — both re-render the list still scoped to the
  given category (toggling a row out of `unwatched`/`watching` removes it from the
  filtered list, same as the existing unfiltered-toggle test, now asserted with a
  category filter active). Cover both `view` branches explicitly, not just `queue` —
  the toggle route re-renders via two different query calls
  (`queueVideos`/`continueWatchingVideos`) and it's a plausible implementation slip to
  thread `category` through only one of them.
- Return-navigation round trip: `/watching/:id?from=queue&sort=oldest&category=3`
  renders "Return to Queue" pointing at `/queue?sort=oldest&category=3`; same pattern
  for `from=continue-watching`/`from=watched` with just `&category=3`; `POST
  /videos/:id/watched-toggle?from=queue&sort=oldest&category=3` redirects to that same
  URL.
- Return-navigation round trip with an adversarial `category` value: since
  `category` is carried unvalidated through `RETURN_VIEWS`/`watchedToggleAction` (see
  Row links), assert that a value like `?category=3%26evil%3Dtrue` (a percent-encoded
  `&evil=true`) round-trips as a single, correctly-encoded `category` querystring
  value on the computed return URL/redirect target — not as an injected second
  querystring parameter. This is the test that would have caught the raw
  template-string-interpolation bug an earlier draft of this spec had in two of
  `RETURN_VIEWS`'s three branches (see Design's `buildReturnPath` note).

### Verification (manual, end-to-end)

1. With channels in at least two different categories (plus at least one left
   Uncategorized) and ingested videos across them, open `/queue` — confirm the picker
   lists "All" plus every category including Uncategorized.
2. Click one category's link — confirm only that category's videos remain, and the
   sort toggle links still work and now carry `&category=` in their `href`s.
3. Click the sort toggle while a category filter is active — confirm the category
   filter survives (URL has both `sort` and `category`).
4. Click a video into `/watching/:id` from a filtered queue, then "Return to Queue" —
   confirm it lands back on the same filtered + sorted `/queue` URL, not the unfiltered
   default.
5. Repeat step 4's return-navigation check from `/continue-watching` and `/watched`
   with a category filter active.
6. Filter `/queue` to a category with zero currently-unwatched/watching videos —
   confirm an empty list, no error.
7. Manually visit `/queue?category=99999` (a nonexistent id) — confirm it behaves
   identically to `/queue` (falls back to unfiltered), not a 500.
8. Filter `/watched` to a category whose channel has since been unsubscribed — confirm
   its watched videos still appear (true history + category filter both hold at once).
9. `bun test` and `bun run lint` clean.

## Open Questions

A red-team review of this spec's draft caught two real bugs, both now fixed in the
Design section above rather than left as open risk:
- `RETURN_VIEWS`'s `continue-watching`/`watched` branches interpolated the unvalidated
  `category` string directly into a template literal while `queue`'s branch went
  through `URLSearchParams` — an inconsistency that, for a `category` value containing
  `&`/`#`/CR-LF, would have produced a structurally different (and for the redirect
  case in `POST /videos/:id/watched-toggle`, potentially header-injectable) URL
  depending on which of the three `from` values was in play. Fixed by routing all three
  branches through one `buildReturnPath` helper (see Return-to-origin navigation).
- `QueueListProps`'s `category` field was typed `string | undefined` in an earlier
  draft while the `/queue` route fed it the `number | undefined` produced by
  `resolveCategoryFilter` — a `tsc --noEmit` error, not just a style slip. Fixed by
  keeping `category` as `number | undefined` everywhere it's on the validated side of
  `resolveCategoryFilter` (queries, `QueueListProps`, `watchingHref`/`toggleHref`) and
  `string | undefined` only where it's an unvalidated URL passthrough (`RETURN_VIEWS`,
  `WatchingPageProps`, `watchedToggleAction`) — see Row links for the full split.

- The conditional-array-spread-into-`and(...)` shape sketched for the optional
  category clause hasn't been confirmed against the installed `drizzle-orm@0.45.2` —
  same "verify novel Drizzle shape at implementation time" posture flagged repeatedly
  in specs 002–004; if it doesn't compile/filter as expected, fall back to building the
  conditions array with a plain `if` push before calling `and(...)`.
- The plain link-list picker is a judgment call for MVP scale (a personal subscription
  list with a handful of categories); if the real category count later makes the link
  row unwieldy, revisit with the `<select>`-dropdown alternative considered and
  deferred during scoping.
- `CategoryFilterLinks`'s unused `current` prop is scaffolding for a future
  active-link-highlighting pass (not part of this spec, per the no-polish precedent) —
  confirm it's not dead weight worth just deleting if that pass never happens.
