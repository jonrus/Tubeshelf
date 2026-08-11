# Tasks: Category Delete
Spec: docs/specs/021-category-delete.md
Generated: 2026-08-11

Note: Scope item 6 (the `docs/app_idea.md:129` inline pointer to this spec) is already done
— it was committed alongside the spec itself in `f28d55b`. No task step needed for it.

- [x] 1. In `src/lib/categories.ts`, add `getSystemCategory(): typeof categories.$inferSelect`
      (queries `categories` where `isSystem = true`, throws `"seed did not create the system
      category"` if none found — exact code in the spec's Design > "`getSystemCategory()` —
      new shared helper" section) and `categoryChannelCount(categoryId: number): number`
      (counts `subscriptions` rows where `categoryId` matches, **no** `userId` or
      `unsubscribedAt` filter — exact code in Design > "`channelCount` on `CategoryWithCount`"
      section). Add `channelCount: number` to `CategoryWithCount` and to
      `listCategoriesWithCounts`'s `.map()` (`channelCount:
      categoryChannelCount(category.id)`, alongside the existing `unwatchedCount`). Then in
      `src/routes/channels.tsx`, replace `resolveCategoryId`'s inline "find the system
      category or throw" query (currently lines 32-40) with `return { ok: true, categoryId:
      getSystemCategory().id };`, importing `getSystemCategory` from `../lib/categories`
      (already imports `listCategoriesWithCounts` from there). Leave `channels.tsx`'s
      `categories` import from `../db/schema` in place — still used by
      `listNonSystemCategories` and `listActiveSubscriptions`'s join.

      Extend `test/lib/categories.test.ts` with cases for `channelCount`: a category with 0
      subscriptions, 1, and multiple — including one subscription belonging to a *second*
      user (proves the count is global, not scoped to `userId`, unlike `unwatchedCount`
      right above it) and one subscription that's unsubscribed (`unsubscribedAt` set — proves
      inactive rows still count, since they still hold the FK the delete transaction will
      need to repoint).

      — done when: `devcontainer exec --docker-path podman --workspace-folder . bunx tsc
      --noEmit` passes, `devcontainer exec --docker-path podman --workspace-folder . bun run
      lint` is clean, and `devcontainer exec --docker-path podman --workspace-folder . bun
      test test/lib/categories.test.ts test/routes/channels.test.ts` passes (the second file
      covers `resolveCategoryId`'s existing behavior, unchanged from the caller's
      perspective, so no existing assertion there should break).

- [x] 2. In `src/routes/categories.tsx`, add a `DELETE /categories/:id` handler placed after
      the existing `POST /categories/:id` (rename) handler — exact code in the spec's Design
      > "`DELETE /categories/:id` route" section: look up the category by id (404 via
      `c.notFound()` if missing, matching the existing not-found branch at line 106);
      if `category.isSystem`, return the `CategoriesList` HTML swap with error `"Cannot
      delete the system category."` (same shape as the existing "Cannot rename the system
      category." branch at lines 108-115); otherwise call `getSystemCategory()` (from task
      1) and run `db.transaction((tx) => { tx.update(subscriptions).set({ categoryId:
      systemCategory.id }).where(eq(subscriptions.categoryId, id)).run();
      tx.delete(categories).where(eq(categories.id, id)).run(); })`, then return the
      `CategoriesList` HTML swap with the refreshed `listCategoriesWithCounts(user.id)`. Add
      the new `subscriptions` import from `../db/schema` (currently only imports
      `CATEGORY_NAME_MAX_LENGTH, categories`) and `getSystemCategory` from `../lib/categories`
      (currently only imports `listCategoriesWithCounts` from there).

      Add tests to `test/routes/categories.test.ts`:
      - `DELETE /categories/:id` on a category with an active subscription moves that
        subscription's `categoryId` to the system category's id (assert directly against the
        `subscriptions` table) and removes the category row (assert `db.select().from
        (categories).where(eq(categories.id, id)).get()` is now `undefined`).
      - Same, but the category also has an *unsubscribed* subscription in it (`unsubscribedAt`
        set) — assert that row's `categoryId` is also repointed, not left dangling.
      - `DELETE` on the system category's id returns the "Cannot delete the system category."
        error and the system category row is unchanged afterward (mirror the existing
        system-row rename-rejection test around `categories.test.ts:261-272`).
      - `DELETE` on a nonexistent id returns 404 (mirror the existing "renaming a nonexistent
        id 404s" test around `categories.test.ts:281-284`).

      — done when: `devcontainer exec --docker-path podman --workspace-folder . bunx tsc
      --noEmit` passes, `devcontainer exec --docker-path podman --workspace-folder . bun run
      lint` is clean, and `devcontainer exec --docker-path podman --workspace-folder . bun
      test test/routes/categories.test.ts` passes including all four new cases above.

- [ ] 3. In `src/views/categories-list.tsx`, add a "Delete" button next to the existing "Edit"
      button inside the non-edit-mode row's action `<span>` (currently `{category.isSystem ?
      "[system]" : null}{category.isSystem ? null : (<button ...>Edit</button>)}`) — wrap
      Edit and the new Delete button in a fragment (`<>...</>`, same pattern already used at
      `src/views/subscription-list.tsx:39` and `src/views/queue-list.tsx:301/309/317`) so both
      stay gated on `!category.isSystem`. Exact button markup in the spec's Design >
      "`CategoriesList` view: Delete button" section: `hx-delete={`/categories/${category.id}`}`,
      `hx-target="#category-list"`, `hx-swap="outerHTML"`, `hx-confirm={`Delete
      "${category.name}"? ${category.channelCount} channel${category.channelCount === 1 ? ""
      : "s"} will move to Uncategorized.`}`, same `SECONDARY_BUTTON_CLASS` as Edit.

      Add a test to `test/routes/categories.test.ts`: `GET /categories` renders a Delete
      button with an `hx-confirm` attribute containing the category's name and its
      `channelCount` for a non-system category (spot-check the exact wording), and renders no
      Delete button (search for `hx-delete="/categories/${systemCategory.id}"`) for the system
      row.

      — done when: `devcontainer exec --docker-path podman --workspace-folder . bunx tsc
      --noEmit` passes, `devcontainer exec --docker-path podman --workspace-folder . bun run
      lint` is clean, and `devcontainer exec --docker-path podman --workspace-folder . bun
      test test/routes/categories.test.ts` passes including the new rendering test.

- [ ] 4. In `src/views/subscription-list.tsx`, replace the category-name parenthetical
      (currently lines 35-37: `{subscription.channelName} ({subscription.unwatchedCount}) (
      {subscription.categoryName})`) with a pill-styled `<span>` around just the category
      name — exact markup in the spec's Design > "`SubscriptionList` pill restyle" section:
      `{subscription.channelName} ({subscription.unwatchedCount})` followed by `<span
      class="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-text-muted">
      {subscription.categoryName}</span>`, class list copied verbatim from
      `src/views/queue-list.tsx:158`/`189`/`239`. No other changes to this file — the
      `showMissedVideosBadge`/Dismiss/Unsubscribe markup and the `Subscription` type are
      unaffected.

      Add a test to `test/routes/channels.test.ts`: `GET /channels` renders a subscription's
      category name inside a `rounded-full` `<span>`, not as a bare `(categoryName)`
      parenthetical (confirmed during spec red-team review that no existing test in this file
      asserts on `categoryName` in any form, so no existing assertion needs updating).

      — done when: `devcontainer exec --docker-path podman --workspace-folder . bunx tsc
      --noEmit` passes, `devcontainer exec --docker-path podman --workspace-folder . bun run
      lint` is clean, and `devcontainer exec --docker-path podman --workspace-folder . bun
      test test/routes/channels.test.ts` passes including the new pill-markup test.

- [ ] 5. Run the full verification suite and do manual end-to-end verification, per
      `CLAUDE.md`'s Claude-performs-directly vs. user-performs-live-in-a-browser split (spec's
      own Verification section spells out the same list):
      - **Claude performs directly** (via `devcontainer exec --docker-path podman
        --workspace-folder . curl ...`, or a direct SQLite read against the dev DB file):
        create a category, subscribe a channel to it, `curl -X DELETE
        http://localhost:3000/categories/:id` with a valid session cookie + matching `Origin`
        header (CSRF), then read the `subscriptions` table directly to confirm that channel's
        `categoryId` now points at the system category and the category row is gone;
        `curl -X DELETE` against the system category's id and confirm the response still
        contains "Cannot delete the system category." with the row unchanged in the DB;
        `curl /channels` and confirm a category name now renders inside a `rounded-full`
        `<span>` rather than in parentheses.
      - **User performs live in a browser**: visit `/categories`, delete a category that has
        channels in it, confirm the native browser confirm dialog states the correct channel
        count, and after confirming, the category disappears from the list via an HTMX
        partial swap (no full page reload) with no error; visit `/channels` and confirm those
        channels now show `Uncategorized` in a pill; confirm the category pill on `/channels`
        visually matches a category pill on a queue-view video card, at both desktop and a
        narrow (mobile) viewport width; on `/categories`, confirm the sidebar still shows a
        just-deleted category until the next full navigation (accepted staleness per the
        spec's Scope), then confirm it's gone after navigating anywhere else.
      — done when: `devcontainer exec --docker-path podman --workspace-folder . bun test`,
      `bun run lint`, and `bunx tsc --noEmit` are all clean across the whole repo, Claude's
      direct `curl`/DB checks above pass, and the user has confirmed the live-browser checks
      above.

- [ ] 6. Flip `docs/specs/021-category-delete.md`'s frontmatter to `status: implemented`, then
      open the PR (summary + test plan filled out, referencing this task file and the manual
      verification results from step 5) — check this box *before* pushing, per `CLAUDE.md`'s
      git workflow ("Finishing a spec" section), so the push carries a fully-checked-off task
      file. — done when: the spec's `status` is `implemented`, this box is checked, and a PR
      against `main` exists for the `spec/category-delete` branch (confirm with the user
      beforehand whether they are pushing themselves or want Claude to, per `CLAUDE.md` —
      never push without asking).
