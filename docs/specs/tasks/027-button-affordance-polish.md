# Tasks: Button Affordance Polish
Spec: docs/specs/027-button-affordance-polish.md
Generated: 2026-08-21

- [x] 1. Add the global pointer-cursor rule (spec Design §1). In `src/styles/input.css`,
  after the existing `#sidebar`/`::-webkit-scrollbar` rules (the file's last content), add:
  ```css
  button:not(:disabled) {
    cursor: pointer;
  }
  ```
  Rebuild CSS: `bun run css:build` (via `devcontainer exec --docker-path podman
  --workspace-folder .`). Done when: the rule exists exactly as above in `input.css`,
  `public/css/tailwind.css` rebuilds with no errors, and (via `devcontainer exec ... grep`)
  `public/css/tailwind.css` contains a `button:not(:disabled)` selector paired with
  `cursor:pointer` in its minified output, and `bun run lint` is clean.

- [x] 2. Spread the video-card button pair to opposite edges (spec Design §2). In
  `src/views/queue-list.tsx`, `queueCard`'s button-row `<div>` — currently `class="mt-auto
  flex gap-2 p-3 pt-2"` — changes to `class="mt-auto flex justify-between p-3 pt-2"` (drop
  `gap-2`, add `justify-between`). No other markup in `queueCard` changes; `watchedCard` and
  `ignoredCard` are untouched (neither renders a two-button row — see spec Design §2). Done
  when: the class string matches exactly, `bun run lint` is clean, and `bunx tsc --noEmit`
  is clean (no test asserts this exact class string — confirmed via `grep -rn "gap-2"
  test/` returning no hits — so `bun test` isn't expected to catch a mistake here; rely on
  lint/tsc plus the manual verification in the final task).

- [x] 3. Final verification, spec status, and PR.

  **Claude performs directly** (via `devcontainer exec --docker-path podman
  --workspace-folder .`):
  - Run `bun test`, `bun run lint`, `bunx tsc --noEmit`, and `bun run fallow` clean across
    the whole repo.
  - With the dev server running (`bun run dev` in the background), `curl -s
    http://localhost:3000/queue` (authenticated session/cookie as needed — check
    `test/routes/queue.test.ts` for how existing tests authenticate if a plain `curl` 401s)
    and confirm the response HTML contains `class="mt-auto flex justify-between p-3 pt-2"`
    on at least one queue card (requires at least one video in the queue — seed one via the
    existing subscribe/ingest flow or directly against the dev SQLite DB if the queue is
    currently empty).
  - `curl -s http://localhost:3000/css/tailwind.css | grep -o
    "button:not(:disabled){cursor:pointer}"` (or the equivalent minified form actually
    produced by the Tailwind CLI build — confirm the exact output first, since minification
    may reorder/abbreviate the declaration) and confirm it's present.

  **User performs live in a browser** (report back what you see):
  - On any page with buttons (e.g. `/queue`), hover over a few different buttons (`Mark
    Watched`, `Ignore`, a sidebar nav button if any, a form submit button) and confirm the
    cursor shows as a pointer/hand instead of the default arrow.
  - Trigger an HTMX request that temporarily disables a button (e.g. click `Mark Watched` or
    `Ignore` and, if possible on your connection, observe the brief disabled state) and
    confirm the cursor does *not* show as a pointer while the button is disabled.
  - On the queue page (and continue-watching), confirm the `Mark Watched`/`Ignore` button
    pair now sits at opposite edges of the card (one flush left, one flush right) instead of
    packed together on the left. Check both a normal desktop-width card and the narrowest
    card width the grid produces (resize the window or use devtools' device toolbar) — per
    spec Open Questions, confirm the buttons don't crowd or visually clip at the narrowest
    width with the longest label pairing ("Mark Unwatched" + "Ignore").

  Once both parts above look correct: update `docs/specs/027-button-affordance-polish.md`'s
  frontmatter to `status: implemented`, then check off this task in this file, and commit
  both changes together — **before** pushing, per `CLAUDE.md`'s branch/PR workflow. Then ask
  the user whether they're pushing the `spec/button-affordance-polish` branch themselves or
  want Claude to; once it's on the remote, open the PR (`gh pr create`) with a summary of
  the two changes and a test-plan checklist (`bun test` / `bun run lint` / `bunx tsc
  --noEmit` / `bun run fallow`, plus the manual-verification items above). Do not merge
  it — merging is always manual.

  Done when: all four of `bun test`/`bun run lint`/`bunx tsc --noEmit`/`bun run fallow` are
  clean; both manual-verification parts are confirmed; the spec's frontmatter reads `status:
  implemented`; this task is checked off; the branch is pushed; and the PR is open.
