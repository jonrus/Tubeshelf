# Tasks: Fixed Sidebar
Spec: docs/specs/033-fixed-sidebar.md
Generated: 2026-10-04

Notes for every step: run commands via the devcontainer (CLAUDE.md). No schema or route
changes; the only code change is classes in `src/views/layout.tsx`. No existing test asserts
the old classes, so none should break.

- [x] 1. Apply the class changes in `src/views/layout.tsx` and add a regression test — edit
  per the spec's Design: `<body>` (line ~102) → `bg-bg text-text`; `<aside id="sidebar">`
  (line ~120) drop `lg:static`, `lg:w-64`, `lg:shrink-0` (keep `fixed inset-y-0 left-0 z-40
  w-64 -translate-x-full overflow-y-auto … lg:z-auto lg:translate-x-0`); `<nav>` (line ~122)
  `h-full` → `min-h-full` (keep `flex flex-col gap-1 p-4 pt-16 lg:pt-4`); `<main>` (line
  ~236) → `min-w-0 p-4 pt-20 lg:ml-64 lg:pt-6`. Add a test (alongside the existing layout/page
  tests, e.g. rendering `/queue` via the pattern in `test/routes/queue.test.ts`) asserting
  the body has no `lg:flex`, the aside has no `lg:static`, and `<main>` has `lg:ml-64`. —
  done when: the diff touches only those four class strings plus the new test, and
  `bun test` passes.

- [x] 2. Manual verification, Claude-performed — run `bun run css:build`, start the dev
  server in the devcontainer, `scripts/dev-login.sh`, then `curl -b
  /tmp/tubeshelf-dev-cookies.txt http://localhost:3000/queue` from inside the container and
  confirm: `<main>` has `lg:ml-64`, aside has no `lg:static`, body has no `lg:flex`, nav has
  `min-h-full`; also grep `public/css/tailwind.css` for the `lg:ml-64` rule. Stop the dev
  server via a `/proc` scan script file (CLAUDE.md gotcha). — done when: results reported.

- [x] 3. Manual verification, user-performed in a browser — give the user exact URLs and what
  to look for: (a) at desktop width, scroll `/queue` (and one other page, e.g. the Ignored
  page): the sidebar stays in view and content isn't hidden under it (left edge of `<main>`
  clears the sidebar); (b) shrink the window height until the nav is taller than the
  viewport: the sidebar scrolls internally, "Log out" is reachable with padding beneath it,
  and on a tall window "Log out" is pinned to the bottom; (c) narrow the window below `lg`
  (1024px): the Menu button opens/closes the drawer and backdrop as before, and content
  isn't pushed right. — done when: the user reports results back.

- [ ] 4. Final verification, flip spec to implemented, open the PR — run `bun test`,
  `bun run lint`, `bunx tsc --noEmit`, and `bun run fallow` clean across the repo; set
  `docs/specs/033-fixed-sidebar.md` frontmatter to `status: implemented`. Draft the PR
  (summary + test plan; end with the Claude Code attribution line) per CLAUDE.md's git
  workflow: check this step's box *before* pushing, commit, then ask whether the user is
  pushing or Claude should; never merge. — done when: all four commands are green, spec is
  `implemented`, this file is fully checked, and the PR is open (or the user has been handed
  the push/PR command).
