# Tasks: UI/UX Polish Pass
Spec: docs/specs/018-ui-ux-polish-pass.md
Generated: 2026-08-08

- [ ] 1. Style the sidebar scrollbar (spec Design §1). Add to
  `src/styles/input.css`, after the existing `@theme` block:
  ```css
  #sidebar {
    scrollbar-width: thin;
    scrollbar-color: var(--color-border) var(--color-surface);
  }
  #sidebar::-webkit-scrollbar {
    width: 8px;
  }
  #sidebar::-webkit-scrollbar-track {
    background: var(--color-surface);
  }
  #sidebar::-webkit-scrollbar-thumb {
    background-color: var(--color-border);
    border-radius: 9999px;
  }
  ```
  Rebuild CSS: `bun run css:build` (via `devcontainer exec`). Done when: the rule block
  exists exactly as above in `input.css`, `public/css/tailwind.css` rebuilds with no
  errors, and `bun run lint` is clean. (Manual visual confirmation of the scrollbar itself
  happens in the final task's manual-verification section, once ~30 categories exist to
  make the sidebar overflow.)

- [ ] 2. Fix video card button misalignment (spec Design §2). In
  `src/views/queue-list.tsx`, change `CARD_CLASS` (currently `"rounded-lg border
  border-border bg-surface overflow-hidden"`) to `"flex flex-col rounded-lg border
  border-border bg-surface overflow-hidden"`. Change the button row's class (currently
  `class="flex gap-2 p-3 pt-2"`, the `<div>` wrapping the `Mark Watched`/`Ignore` buttons)
  to `class="mt-auto flex gap-2 p-3 pt-2"`. Done when: both class strings match exactly,
  `bun run lint` is clean, and `bunx tsc --noEmit` is clean (no test asserts on these exact
  class strings, so `bun test` isn't expected to catch a mistake here — rely on the lint/tsc
  pass plus the manual verification in the final task).

- [ ] 3. Move the "add category" form above the category listing (spec Design §4). In
  `src/views/categories-list.tsx`, move the trailing `<form hx-post="/categories" ...>`
  block (currently the last child of the outer `<div id="category-list">`, after the
  `{props.error ? ... : null}` block) to be the *first* child of that `<div>`, immediately
  after the opening `<div id="category-list" class="rounded-lg border border-border
  bg-surface">` tag and before the `{props.categories.length === 0 ? ... : ...}`
  conditional. The relative order of the `<ul>`/`EmptyState` conditional and the
  `{props.error ? ...}` block stays the same relative to each other — only the form moves
  to the top, ending up in this order: form, then the list/empty-state conditional, then
  the error paragraph. Also update the `EmptyState` message (currently `"No categories yet
  — add one below."`) to `"No categories yet — add one above."` since the form is no longer
  below it. Done when: the form is the first child in the JSX, the `EmptyState` string says
  "above", and `bun run lint` / `bunx tsc --noEmit` are clean.

- [ ] 4. Copy change: "Clear to Unwatched" → "Mark Unwatched" (spec Design §5). In
  `src/views/queue-list.tsx`, the status-toggle button's conditional label:
  ```
  {row.status === "watching"
    ? "Clear to Unwatched"
    : "Mark Watched"}
  ```
  becomes
  ```
  {row.status === "watching"
    ? "Mark Unwatched"
    : "Mark Watched"}
  ```
  No other logic changes — the `hx-post` target and toggle behavior are unaffected. Done
  when: the string is changed, `bun run lint` is clean, and `bun test` still passes (no
  existing test asserts the old "Clear to Unwatched" string — confirmed via `grep -rn
  "Clear to Unwatched" test/`).

- [ ] 5. Make channel name and category more visually distinct on video cards (spec Design
  §6), across all three card-rendering blocks in `src/views/queue-list.tsx` that build a
  `{channelName} · {categoryName}` line.

  **Watched branch** (`props.view === "watched"`), replace:
  ```jsx
  <p class="mt-1 text-sm text-text-muted">
    {row.channelName} · {row.categoryName}
    {row.watchedAt
      ? ` · watched ${formatRelativeTime(row.watchedAt)}`
      : ""}
  </p>
  ```
  with:
  ```jsx
  <div class="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
    <span class="text-text">{row.channelName}</span>
    <span class="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-text-muted">
      {row.categoryName}
    </span>
    {row.watchedAt ? (
      <span class="text-text-muted">
        watched {formatRelativeTime(row.watchedAt)}
      </span>
    ) : null}
  </div>
  ```

  **Ignored branch** (`props.view === "ignored"`), replace:
  ```jsx
  <p class="mt-1 text-sm text-text-muted">
    {row.channelName} · {row.categoryName}
    {row.ignoreMethod ? (
      <span class="ml-2 inline-block rounded-full bg-surface-raised px-2 py-0.5 text-xs text-text-muted">
        {row.ignoreMethod}
      </span>
    ) : null}
  </p>
  ```
  with:
  ```jsx
  <div class="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
    <span class="text-text">{row.channelName}</span>
    <span class="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-text-muted">
      {row.categoryName}
    </span>
    {row.ignoreMethod ? (
      <span class="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-text-muted">
        {row.ignoreMethod}
      </span>
    ) : null}
  </div>
  ```
  (drops the old `ml-2` — the parent's `gap-1.5` now provides spacing between pills)

  **Queue/continue-watching branch** (the final `else` block, covers both views), replace:
  ```jsx
  <p class="mt-1 text-sm text-text-muted">
    {row.channelName} · {row.categoryName}
    {row.publishedAt
      ? ` · ${formatRelativeTime(row.publishedAt)}`
      : ""}
  </p>
  ```
  with:
  ```jsx
  <div class="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
    <span class="text-text">{row.channelName}</span>
    <span class="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-text-muted">
      {row.categoryName}
    </span>
    {row.publishedAt ? (
      <span class="text-text-muted">{formatRelativeTime(row.publishedAt)}</span>
    ) : null}
  </div>
  ```

  Done when: all three replacements are applied exactly, `bun run lint` and `bunx tsc
  --noEmit` are clean, and `bun test` still passes (no existing test asserts the literal
  `" · "` separator or matches on the old `<p class="mt-1 text-sm text-text-muted">`
  wrapper — confirmed via `grep -rn "·" test/routes/*.test.ts`, no hits).

- [ ] 6. Append "ago" to relative video-age timestamps (spec Design §7). In
  `src/lib/relative-time.ts`, change the four duration-branch returns:
  ```ts
  if (diffMs < HOUR) return `${Math.floor(diffMs / MINUTE)}m`;
  if (diffMs < DAY) return `${Math.floor(diffMs / HOUR)}h`;
  if (diffMs < WEEK) return `${Math.floor(diffMs / DAY)}d`;
  if (diffMs < 4 * WEEK) return `${Math.floor(diffMs / WEEK)}w`;
  ```
  to:
  ```ts
  if (diffMs < HOUR) return `${Math.floor(diffMs / MINUTE)}m ago`;
  if (diffMs < DAY) return `${Math.floor(diffMs / HOUR)}h ago`;
  if (diffMs < WEEK) return `${Math.floor(diffMs / DAY)}d ago`;
  if (diffMs < 4 * WEEK) return `${Math.floor(diffMs / WEEK)}w ago`;
  ```
  Leave the `"just now"` branches and the `date.toLocaleDateString(...)` fallback
  unchanged. Update `test/lib/relative-time.test.ts`'s four matching assertions:
  `toBe("5m")` → `toBe("5m ago")`, `toBe("3h")` → `toBe("3h ago")`, `toBe("2d")` →
  `toBe("2d ago")`, `toBe("2w")` → `toBe("2w ago")` (the `"just now"` and absolute-date
  tests are untouched). Done when: `bun test` passes with the updated assertions, and
  `bun run lint` / `bunx tsc --noEmit` are clean.

- [ ] 7. Rename the sidebar's "Categories" management link (spec Design §8). In
  `src/views/layout.tsx`, the top-level nav link:
  ```jsx
  <a
    href="/categories"
    data-active={props.currentView === "categories"}
    class={NAV_LINK_CLASS}
  >
    Categories
  </a>
  ```
  changes its inner text from `Categories` to `Manage Categories`. No other props/markup
  change. The indented per-category filter sublist directly below it is untouched. Update
  `test/routes/categories.test.ts`'s test `"GET /categories highlights the Categories
  sidebar link and no other top-level link"` — change its
  `expect(activeLinks).toEqual(["Categories"])` to `expect(activeLinks).toEqual(["Manage
  Categories"])` (the regex it uses, `/<a href="[^"]*" data-active="true"[^>]*>([^(<]*)/g`,
  captures the full link text up to `(` or `<`, so it captures "Manage Categories" whole —
  confirm this by running the test after the change rather than assuming). Done when: `bun
  test` passes (including this updated test), and `bun run lint` / `bunx tsc --noEmit` are
  clean.

- [ ] 8. Add a "YouTube" links section to the sidebar (spec Design §9). In
  `src/views/layout.tsx`, insert a new block after the "Channels" `<a>` link and before the
  `<form action="/logout" ...>` block:
  ```jsx
  <p class="mt-2 px-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
    YouTube
  </p>
  <a
    href="https://www.youtube.com/feed/subscriptions"
    target="_blank"
    rel="noopener noreferrer"
    class={NAV_SUBLINK_CLASS}
  >
    Subscriptions
  </a>
  <a
    href="https://www.youtube.com/playlist?list=WL"
    target="_blank"
    rel="noopener noreferrer"
    class={NAV_SUBLINK_CLASS}
  >
    Watch Later
  </a>
  ```
  This reuses the existing `NAV_SUBLINK_CLASS` constant without adding any `data-active`
  logic (neither URL ever matches an app route, so its `data-[active=true]` selectors
  simply never trigger — harmless). Done when: the block exists in this position, `bun run
  lint` / `bunx tsc --noEmit` are clean, and `bun test` still passes (no existing
  `activeLinks` test asserts an exhaustive list of *all* top-level links — each one only
  asserts its own view's active link is exactly `[thatLabel]`, and none of those match
  against `NAV_SUBLINK_CLASS` items — confirmed by reading `test/routes/{categories,
  ignore-rules,channels,queue}.test.ts`).

- [ ] 9. Choose the favicon/icon design (spec Design §3, spec Open Questions). This step is
  interactive by design — the spec's Open Questions section explicitly defers the visual
  choice to this point rather than pre-deciding it. Propose 2-3 simple concepts to the user
  (e.g. a play-button mark, a shelf/stack motif, a monogram) rendered as small inline SVGs
  or descriptions, incorporate their feedback, and save the final chosen design as
  `public/icons/source.svg` — a single square SVG (`viewBox="0 0 512 512"`) using literal
  hex colors matching the app's theme (`--color-bg` `#020617`, `--color-accent` `#2dd4bf`,
  `--color-text` `#f1f5f9` from `src/styles/input.css` — a standalone SVG file can't
  reference Tailwind's CSS custom properties, so use the literal values). Done when:
  `public/icons/source.svg` exists, and the user has explicitly approved the chosen design
  in this session's conversation (not just the first proposal — confirm before finalizing).

- [ ] 10. Generate the icon set from `public/icons/source.svg` (spec Design §3). Add
  `sharp` as a devDependency: `bun add -d sharp` (via `devcontainer exec`). Create
  `scripts/generate-icons.ts`:
  ```ts
  import sharp from "sharp";

  const SOURCE = "public/icons/source.svg";
  const OUT_DIR = "public/icons";

  const sizes = [
    { file: "icon-16.png", size: 16 },
    { file: "icon-32.png", size: 32 },
    { file: "icon-180.png", size: 180 },
    { file: "icon-192.png", size: 192 },
    { file: "icon-512.png", size: 512 },
  ];

  for (const { file, size } of sizes) {
    await sharp(SOURCE).resize(size, size).png().toFile(`${OUT_DIR}/${file}`);
    console.log(`wrote ${file} (${size}x${size})`);
  }

  // Maskable icon: pad the artwork into an ~80% safe zone on a solid background so OS
  // icon masks (circle, squircle, etc.) don't clip it.
  const padded = await sharp(SOURCE).resize(410, 410).png().toBuffer();
  await sharp({
    create: { width: 512, height: 512, channels: 4, background: "#020617" },
  })
    .composite([{ input: padded, left: 51, top: 51 }])
    .png()
    .toFile(`${OUT_DIR}/icon-512-maskable.png`);
  console.log("wrote icon-512-maskable.png (512x512, 410x410 safe zone)");
  ```
  Run it: `devcontainer exec --docker-path podman --workspace-folder . bun run
  scripts/generate-icons.ts`. Done when: the script runs with no errors and its console
  output confirms all 6 files were written (`icon-16.png`, `icon-32.png`, `icon-180.png`,
  `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`), all 6 exist under
  `public/icons/`, and `bun run lint` / `bunx tsc --noEmit` are clean.

- [ ] 11. Wire up the manifest, static serving, and `<head>` links (spec Design §3). Create
  `public/manifest.json`:
  ```json
  {
    "name": "Tubeshelf",
    "short_name": "Tubeshelf",
    "icons": [
      { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
      { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
      {
        "src": "/icons/icon-512-maskable.png",
        "sizes": "512x512",
        "type": "image/png",
        "purpose": "maskable"
      }
    ],
    "theme_color": "#020617",
    "background_color": "#020617",
    "display": "standalone"
  }
  ```
  In `src/index.ts`, replace the single existing static mount (line 34, `app.use("/css/*",
  serveStatic({ root: "./public" }));`) with three mounts:
  ```ts
  app.use("/css/*", serveStatic({ root: "./public" }));
  app.use("/icons/*", serveStatic({ root: "./public" }));
  app.use("/manifest.json", serveStatic({ path: "./public/manifest.json" }));
  ```
  (`path` is a valid `ServeStaticOptions` field for Hono's Bun `serveStatic` — confirmed in
  `node_modules/hono/dist/types/middleware/serve-static/index.d.ts`.)

  Add to both `<head>`s — `src/views/layout.tsx` (inside the existing `<head>`, after
  `<title>{props.title}</title>`) and `src/views/login-page.tsx` (its own independent
  `<head>`, after `<title>Log in — Tubeshelf</title>`):
  ```jsx
  <link rel="icon" type="image/png" sizes="32x32" href="/icons/icon-32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/icons/icon-16.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/icons/icon-180.png" />
  <link rel="manifest" href="/manifest.json" />
  ```
  Done when: `public/manifest.json` exists with the exact content above, `src/index.ts` has
  the three mounts, both `<head>`s have the four `<link>` tags, `bun run lint` / `bunx tsc
  --noEmit` are clean, and (via `devcontainer exec ... curl`) `curl -i
  http://localhost:3000/manifest.json` and `curl -i http://localhost:3000/icons/icon-192.png`
  both return `200` against a running dev server (`bun run dev` in the background, or
  `bun run start` after a build).

- [ ] 12. Final verification, spec status, and PR.

  **Claude performs directly** (via `devcontainer exec --docker-path podman
  --workspace-folder .`):
  - Run `bun test`, `bun run lint`, and `bunx tsc --noEmit` clean across the whole repo.
  - Seed ~30 categories directly against the dev SQLite DB (enough to force the sidebar's
    category sublist to overflow and show the scrolled state), then `curl` the `/categories`
    page and confirm all 30 render in the response HTML.
  - `curl -i http://localhost:3000/manifest.json` and `curl -i
    http://localhost:3000/icons/icon-32.png` (dev server running) — confirm both `200`.
  - `curl -s http://localhost:3000/queue` and confirm the response contains `Mark
    Unwatched`-eligible markup is absent for unwatched rows and present for a watching row
    (i.e. the copy change from task 4 landed), and confirm the response contains `Manage
    Categories` and not a bare `>Categories<` top-level link (task 7).

  **User performs live in a browser** (report back what you see):
  - Open the app on desktop: confirm the sidebar scrollbar (task 1) now matches the dark
    theme instead of showing the browser default, with the 30 seeded categories forcing it
    to actually scroll.
  - On the queue view, confirm a row with a long/wrapping title has its `Mark
    Watched`/`Ignore` buttons level with the buttons on shorter cards in the same row (task
    2), both desktop (multi-column grid) and mobile-width (single column) — resize the
    window or use devtools' device toolbar for the latter.
  - Confirm the Categories page shows the add-category form above the list (task 3), and
    that a video card's channel name/category now read as visually distinct (task 5).
  - Confirm the new "YouTube" section appears in the sidebar with working Subscriptions /
    Watch Later links opening in a new tab (task 8), and that the browser tab shows the new
    favicon (tasks 9-11) on both the main app and the login page (log out to check the
    latter). If your OS/browser supports "Add to Home Screen"/"Install app", optionally
    confirm the install prompt now offers the chosen icon.

  Once both parts above look correct: update `docs/specs/018-ui-ux-polish-pass.md`'s
  frontmatter to `status: implemented`, then check off this task in this file, and commit
  both changes together — **before** pushing, per `CLAUDE.md`'s branch/PR workflow. Then
  ask the user whether they're pushing the `spec/ui-ux-polish-pass` branch themselves or
  want Claude to; once it's on the remote, open the PR (`gh pr create`) with a summary of
  the 9 hit-list items and a test-plan checklist (`bun test` / `bun run lint` / `bunx tsc
  --noEmit`, plus the manual-verification items above). Do not merge it — merging is always
  manual.

  Done when: all three of `bun test`/`bun run lint`/`bunx tsc --noEmit` are clean; both
  manual-verification parts are confirmed; the spec's frontmatter reads `status:
  implemented`; this task is checked off; the branch is pushed; and the PR is open.
