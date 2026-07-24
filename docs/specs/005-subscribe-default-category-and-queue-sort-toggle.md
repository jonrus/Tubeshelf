---
status: implemented
created: 2026-07-24
---

# Subscribe Default-Category Fix & Queue Sort Toggle

## Context

Two bugs surfaced during spec004's manual end-to-end verification pass (spec004 is
already implemented and committed; neither issue is a regression from that spec, both
predate it):

1. **Subscribing with no category selected fails with "Invalid category."** instead of
   defaulting to Uncategorized, as `docs/app_idea.md` MVP item 1 requires ("Channels
   left unassigned default to a system-managed 'Uncategorized' category").

2. **`/queue` has no UI control to invert the sort order.** `docs/app_idea.md:37`
   explicitly specifies the default queue view is "sorted newest to oldest by default
   with a toggle to invert to oldest-to-newest" — the toggle was never built.
   Spec004 added `?sort=newest|oldest` query-param support end-to-end (routes, return
   navigation) but its Design section never specified an actual link/button for it,
   despite its own Verification section (step 2) assuming one exists.

### Root cause: category bug

`docs/specs/002-channel-subscriptions.md`'s Design section describes a **single-step**
subscribe flow (the form `hx-post`s directly to `/subscriptions`). The actual
implementation (`src/routes/channels.tsx`) instead has a **two-step preview→confirm**
flow — `POST /subscriptions/preview` (renders a `ConfirmPanel` with the channel's real
fetched name for the user to confirm) then `POST /subscriptions` (the real
subscribe) — added at some point after spec002 without spec002's Design text being
updated to match. That drift is exactly where the bug lives:

- `resolveCategoryId` (`channels.tsx:26-46`) resolves a blank `categoryId` to the
  system category's real numeric ID, and rejects any request whose `categoryId`
  explicitly *is* the system category's ID — written as "defense in depth against
  forged form data" for the single-step world spec002 describes, since the system
  category is deliberately excluded from the rendered `<select>`.
- The preview step calls `resolveCategoryId` and passes the **resolved numeric ID**
  into `ConfirmPanel`'s hidden `categoryId` field (`subscribe-confirm.tsx:47`).
- On confirm, `resolveCategoryId` runs again — this time receiving that numeric system
  category ID (not blank) — and rejects it via the same forged-data check, even though
  it's the legitimate value the preview step itself produced.

### Root cause: sort toggle gap

Not a logic bug — the query-param plumbing (`resolveSort`, `queueVideos`, row links
carrying `sort` through to `/watching/:id` and back) all works correctly when driven by
URL. There has just never been a rendered link/button on `/queue` itself that invokes
`?sort=oldest`.

## Scope

**In:**
- Fix the category-resolution round trip so subscribing with no category selected
  succeeds and lands on Uncategorized.
- Add a queue sort toggle UI on `/queue`.

**Out:**
- Backfilling spec002's Design section to document the actual two-step preview→confirm
  flow. Real documentation debt, but doesn't block either fix here — a separate,
  smaller cleanup if it's ever worth doing.
- Any change to Continue Watching's or Watched's sort behavior — both are deliberately
  fixed-order per spec004 (see `app_idea.md`'s Continue Watching/Watched descriptions),
  not touched here.
- Any other UI polish (active-link highlighting, styling) — matches the existing
  precedent set by spec004's nav ("no active-link highlighting or other polish — first
  pass just needs the links to exist").

## Design

### Category fix (`src/routes/channels.tsx`, `src/views/subscribe-confirm.tsx`)

The preview step keeps calling `resolveCategoryId(categoryIdRaw)` for validation
(so an invalid non-blank category is still rejected immediately at preview, before the
user reaches the confirm step) — but now threads the **raw string** the user actually
submitted (`categoryIdRaw`: `""` or a non-system category's id-as-string) into
`ConfirmPanel`, instead of the resolved numeric ID:

```ts
channelsRoute.post("/subscriptions/preview", async (c) => {
  // ...unchanged through the resolveCategoryId validation check...
  return c.html(
    <ConfirmPanel
      channelId={parsed.channelId}
      categoryId={categoryIdRaw} // was resolvedCategory.categoryId
      channelName={channelName}
    />,
  );
});
```

`ConfirmPanel`'s prop type changes from `categoryId: number` to `categoryId: string`
(`subscribe-confirm.tsx:35`); the hidden field's render (`subscribe-confirm.tsx:47`)
is unchanged, just now carries the honest round-tripped value.

`POST /subscriptions` (the confirm handler) needs no changes — it already reads
`categoryId` off the body as a string and calls `resolveCategoryId` on it
(`channels.tsx:143-150`). With this fix, that call only ever sees `""` or a genuine
non-system category id on the honest round trip, so the forged-data rejection
(`channels.tsx:42-43`) still does its job against a hand-crafted request carrying the
system category's real ID directly — it just no longer fires on legitimate traffic.

### Queue sort toggle (`src/routes/queue.tsx`)

A plain two-link toggle, rendered as a sibling of `<QueueList>` (not inside
`queue-list.tsx`'s `#queue-list` div, since it's static per page load and doesn't need
to be part of the `hx-swap="outerHTML"` partial the row-toggle POST already re-renders)
in the `GET /queue` handler only:

```tsx
queueRoute.get("/queue", (c) => {
  const user = getCurrentUser();
  const sort = resolveSort(c.req.query("sort"));
  return c.html(
    <Layout title="Queue">
      <p>
        <a href="/queue">Newest first</a> ·{" "}
        <a href="/queue?sort=oldest">Oldest first</a>
      </p>
      <QueueList view="queue" sort={sort} rows={queueVideos(user.id, sort)} />
    </Layout>,
  );
});
```

Both links are always rendered and clickable (including the one matching the current
sort — clicking it is just a no-op reload), matching the existing "no active-link
highlighting, first pass just needs the links to exist" precedent from spec004's nav
rather than introducing new styling/active-state conventions here.

### Testing (`test/routes/channels.test.ts`, `test/routes/queue.test.ts`)

- **Existing coverage doesn't actually exercise this bug, and would pass identically
  whether it's fixed or not** — confirmed by red-team review before task breakdown.
  Both the `"subscribe -> unsubscribe -> resubscribe cycle"` test (`channels.test.ts:114`)
  and `"blank categoryId resolves to the system category"` (`channels.test.ts:181-203`)
  call `postConfirm({ channelId: id, categoryId: "" })` with a **hardcoded** `""`
  rather than reading the value out of the preceding `postPreview` response's rendered
  hidden field. Against today's (unfixed) code, preview resolves blank to the system
  category's real numeric ID and bakes *that* into the hidden field — but since neither
  test round-trips through it, they never hit the actual broken path. Both must be
  changed to extract `categoryId` from the preview response's hidden field (e.g. a
  small regex/parse helper alongside the existing `postPreview`/`postConfirm` helpers)
  and feed that extracted value into `postConfirm`, instead of hardcoding `""`.
- `test/routes/channels.test.ts`: once the above helper exists, add a regression test
  driving the real two-step flow — `POST /subscriptions/preview` with a blank
  `categoryId`, extract the hidden `categoryId` field's value from the returned HTML,
  then `POST /subscriptions` with that extracted value — assert it succeeds (not
  `ConfirmError`) and the resulting subscription's category is the system Uncategorized
  category. This must fail against pre-fix code and pass against post-fix code (verify
  this explicitly while implementing, since the point of this test is exactly the
  round-trip the two updated tests above were silently skipping).
- `test/routes/queue.test.ts`: `GET /queue` (default) response includes a link to
  `/queue?sort=oldest`; `GET /queue?sort=oldest` response includes a link to `/queue`
  (both links present regardless of current sort, per the no-active-state design
  above).

## Open Questions

None.
