# Tasks: CRUD List Layout Fixes
Spec: docs/specs/020-crud-list-layout-fixes.md
Generated: 2026-08-10

- [ ] 1. In `src/views/ignore-rules-list.tsx`, move the standalone "Add" `<form>` (currently
      the last child of the `#ignore-rules-list` div, lines 91-106, `hx-post="/ignore-rules"`
      `hx-target="#ignore-rules-list"` `hx-swap="outerHTML"`) to immediately before the
      `{props.rules.length === 0 ? (<EmptyState .../>) : (<ul>...</ul>)}` block (currently
      starting at line 23) — i.e. the form becomes the first child of the div, followed by
      the empty-state/list block, followed by the existing `props.error` paragraph (currently
      lines 88-90). No changes to the form's attributes, its `<input>`/`<button>` markup, the
      `props.error` paragraph's own markup, or the inline per-row edit form (rendered in place
      of a list item when `editingId` matches a rule). — done when: the "Add" form's JSX
      appears before the rules list/empty-state block in `ignore-rules-list.tsx`'s source
      (matching `categories-list.tsx`'s existing form-above-list ordering), no other lines in
      the file changed, and `devcontainer exec --docker-path podman --workspace-folder .
      bunx tsc --noEmit` passes.

- [ ] 2. In `src/views/subscription-list.tsx`, restructure the row `<li>` (currently lines
      31-63, class `flex flex-wrap items-center gap-2 px-4 py-3 hover:bg-surface-raised`) per
      the spec's Design item 2:
      - Change the `<li>`'s class to `flex items-center justify-between gap-2 px-4 py-3
        hover:bg-surface-raised` (drops `flex-wrap`, adds `justify-between`).
      - Wrap the existing channel-name/unwatched-count/category-name text and the conditional
        missed-videos-warning + Dismiss-button fragment (today's first two children of the
        `<li>`, unchanged content/logic) in a new `<span class="flex flex-wrap items-center
        gap-2">`.
      - Wrap the existing Unsubscribe `<button>` (today's last child of the `<li>`, unchanged
        `hx-delete`/`hx-target`/`hx-swap`/class) in a new `<span class="flex items-center
        gap-2">`, sibling to the left span above.
      - No changes to `SubscriptionList`'s prop types, the `Subscription` type, the Dismiss
        button's `hx-post` target, or the Unsubscribe button's `hx-delete` target.
      — done when: the `<li>` has exactly two top-level children (the left span and the right
      span) in both the badge-present and badge-absent cases, `devcontainer exec
      --docker-path podman --workspace-folder . bunx tsc --noEmit` passes, and
      `devcontainer exec --docker-path podman --workspace-folder . bun test` still passes
      (existing `channels.test.ts`/`extractSubscriptionRow`-based assertions are
      substring-based, not order-sensitive, per the spec's Testing section — no test changes
      expected).

- [ ] 3. Run the full verification suite and do manual end-to-end verification, per
      `CLAUDE.md`'s convention of splitting manual verification into what Claude can check
      directly vs. what needs a live browser:
      - **Claude performs directly** (via `devcontainer exec --docker-path podman
        --workspace-folder . curl ...`): `curl /ignore-rules` and confirm the "New keyword"
        form's markup appears before the first rule's row (or before the empty-state message,
        if no rules exist) in the response body; `curl /channels` with at least one
        subscription seeded with `showMissedVideosBadge` true and confirm the response
        contains the warning text and Dismiss button ahead of the Unsubscribe button, with
        Unsubscribe wrapped in its own `<span>`.
      - **User performs live in a browser**: visit `/ignore-rules`, confirm the add-keyword
        form appears above the list, and confirm adding a rule still works via HTMX partial
        swap (no full reload); visit `/channels`, confirm Unsubscribe sits flush right on
        every row matching Categories' Edit-button alignment, at both desktop and a narrow
        (mobile) viewport width, including a row with the missed-videos warning present
        (confirm Dismiss stays inline with the warning text on the left, not pushed right
        with Unsubscribe, and both buttons still function).
      — done when: `devcontainer exec --docker-path podman --workspace-folder . bun test`,
      `bun run lint`, and `bunx tsc --noEmit` are all clean, Claude's direct `curl` checks
      above pass, and the user has confirmed the live-browser checks above.

- [ ] 4. Flip `docs/specs/020-crud-list-layout-fixes.md`'s frontmatter to
      `status: implemented`, then open the PR (summary + test plan filled out, referencing
      this task file and the manual verification results from step 3) — check this box
      *before* pushing, per `CLAUDE.md`'s git workflow ("Finishing a spec" section), so the
      push carries a fully-checked-off task file. — done when: the spec's `status` is
      `implemented`, this box is checked, and a PR against `main` exists for the
      `spec/crud-list-layout-fixes` branch (confirm with the user beforehand whether they are
      pushing themselves or want Claude to, per `CLAUDE.md` — never push without asking).
