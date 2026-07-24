# Tasks: Subscribe Default-Category Fix & Queue Sort Toggle
Spec: docs/specs/005-subscribe-default-category-and-queue-sort-toggle.md
Generated: 2026-07-24

- [x] 1. Fix the category round-trip bug per the spec's Design > Category fix section:
  in `src/routes/channels.tsx`'s `POST /subscriptions/preview` handler (currently
  `channelsRoute.post("/subscriptions/preview", ...)`, `channels.tsx:92-137`), change the
  `<ConfirmPanel>` render (`channels.tsx:130-136`) to pass `categoryId={categoryIdRaw}`
  instead of `categoryId={resolvedCategory.categoryId}` — the `resolveCategoryId` call
  above it stays exactly as-is (still validates and still produces the inline error for
  a genuinely invalid category at preview time; only the value threaded into the panel
  changes). In `src/views/subscribe-confirm.tsx`, change `ConfirmPanel`'s prop type
  (`subscribe-confirm.tsx:33-37`) from `categoryId: number` to `categoryId: string`; the
  hidden field render (`subscribe-confirm.tsx:47`, `<input type="hidden" name="categoryId"
  value={props.categoryId} />`) needs no change. Do not touch `POST /subscriptions`
  (`channels.tsx:139-153`) — the spec confirms it needs no changes. Done when: the two
  edits above are made, `bun run lint` is clean, and `bunx tsc --noEmit` (or the
  project's equivalent typecheck) reports no new errors from the prop type change.

- [ ] 2. Fix the test-coverage gap identified in the spec's Testing section: both
  `"subscribe -> unsubscribe -> resubscribe cycle"` (`test/routes/channels.test.ts`, the
  `postConfirm({ channelId: id, categoryId: "" })` call around line 114) and
  `"blank categoryId resolves to the system category"` (`channels.test.ts:181-203`, same
  hardcoded `categoryId: ""` pattern) currently hardcode a blank `categoryId` on the
  confirm call instead of extracting it from the preceding `postPreview` response's
  rendered hidden field, so neither actually exercises the round-trip task 1 fixed. Add a
  small helper near the existing `postPreview`/`postConfirm` functions
  (`channels.test.ts:75-89`) that parses the `categoryId` hidden field's value out of a
  preview response's HTML (e.g. a regex against `name="categoryId" value="([^"]*)"`), and
  update both tests to extract-and-feed-through that value instead of hardcoding `""`.
  Then add the new regression test from the spec's Testing section: preview with a blank
  category, extract the hidden field value, confirm with it, assert success (not
  `ConfirmError`) and that the resulting subscription's `categoryId` is the system
  category's id. Before finishing this step, confirm the new regression test actually
  catches the bug — temporarily revert task 1's two edits, run
  `bun test test/routes/channels.test.ts`, confirm the new test (and ideally the two
  updated tests) fail, then re-apply task 1's edits and confirm everything passes again.
  Done when: `bun test test/routes/channels.test.ts` passes with task 1's fix in place,
  and you've confirmed (per the above) that it fails without it.

- [ ] 3. Add the queue sort toggle UI per the spec's Design > Queue sort toggle section:
  in `src/routes/queue.tsx`'s `GET /queue` handler (`queue.tsx:172-180`), add a `<p>`
  sibling before `<QueueList>` (inside `<Layout>`, outside `#queue-list`) containing two
  plain always-rendered links — `<a href="/queue">Newest first</a>` and
  `<a href="/queue?sort=oldest">Oldest first</a>` — exactly matching the spec's code
  sketch (no active-link styling, no htmx). Done when: `bun run lint` is clean and
  `curl`ing `/queue` and `/queue?sort=oldest` from inside the devcontainer both return
  HTML containing both links.

- [ ] 4. Add the queue sort toggle test coverage per the spec's Testing section: in
  `test/routes/queue.test.ts`, add assertions that `GET /queue`'s response body contains
  a link to `/queue?sort=oldest`, and that `GET /queue?sort=oldest`'s response body
  contains a link to `/queue` (plain substring/`toContain` checks on the href, following
  the existing test file's style) — done when: `bun test test/routes/queue.test.ts`
  passes covering both cases.

- [ ] 5. Run full verification: `bun test` and `bun run lint` clean across the whole
  repo — done when: both commands exit 0 with no failures.
