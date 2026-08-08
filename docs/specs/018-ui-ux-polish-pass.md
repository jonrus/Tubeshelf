---
status: in-progress
created: 2026-08-08
---

# UI/UX Polish Pass

## Context

After using the app for a few days post-MVP (spec011's base styling pass), the user
compiled a hit list of small UI/UX rough edges found through actual use. This spec bundles
that hit list into one scoped pass rather than splitting into many single-item specs, the
same way spec011 bundled the original styling work. Each item was discussed and refined in
conversation before this spec was written (2026-08-08) — decisions and rejected
alternatives are recorded inline below rather than re-derived.

## Scope

**In scope:**

1. Style the sidebar's scrollbar (`#sidebar` in `src/views/layout.tsx`) to match the app's
   existing dark theme instead of the browser default.
2. Fix video card button misalignment: when a video title wraps to multiple lines, its
   card's `Mark Watched`/`Ignore` buttons currently sit lower than buttons on shorter cards
   in the same row.
3. Add a favicon and icon set sized for home-screen installability (see Design — explicitly
   *not* full PWA/offline support).
4. Move the "add category" form above the category listing on the Categories page, to match
   the existing pattern on the Channels page.
5. Copy change: "Clear to Unwatched" → "Mark Unwatched".
6. Make channel name and category more visually distinct on video cards (currently one
   undifferentiated muted line). Applies to all four card variants that render this line —
   queue, continue-watching, watched, and ignored.
7. Append "ago" to relative video-age timestamps (`2h` → `2h ago`), but not to the
   absolute-date fallback for older videos.
8. Copy change to make clearer that the sidebar's per-category links filter whatever view
   is currently active, without misrepresenting the top-level "Categories" link itself
   (which navigates to category management, not filtering — see Design).
9. Add a "YouTube" links section to the sidebar with two static external links:
   `https://www.youtube.com/feed/subscriptions` and
   `https://www.youtube.com/playlist?list=WL`.

**Explicitly out of scope (considered and rejected, not just deferred):**

- **Full PWA support** (service worker, offline caching strategy). Discussed and
  deliberately rejected, not deferred — the user's actual goal is home-screen
  installability, which the icon set + web manifest alone provide (modern Chromium/Brave
  installability doesn't require a service worker). Since offline support isn't a live goal
  (this app is link-out-to-YouTube for playback per `docs/app_idea.md` §2, so there's
  little to usefully cache offline anyway), there's nothing deferred to track in
  `docs/app_idea.md`'s Future Roadmap — this decision is recorded here for that reason.
- **Radio-button-style category filter controls.** Considered as an alternative to item 8
  above; rejected as disproportionate UI-semantics work for what's a discoverability gap,
  not a functionality gap. The copy change is the chosen fix; if it proves insufficient
  after living with it, a future spec can revisit.
- Redesigning the color palette/theme established in spec011 — this pass fixes specific
  rough edges on top of that existing styling, not a re-theme.

## Design

**1. Sidebar scrollbar.** Add `scrollbar-width`/`scrollbar-color` (Firefox) and
`::-webkit-scrollbar` / `::-webkit-scrollbar-thumb` / `::-webkit-scrollbar-track`
(Chromium/Brave) rules to `src/styles/input.css`, scoped to `#sidebar`, using the existing
`border`/`surface-raised` theme tokens so it reads as part of the same theme rather than a
one-off color. No JS needed. `#sidebar` is the same DOM element on both mobile and desktop
(shown/hidden via a `translate-x` transform, not separate markup — see
`src/views/layout.tsx`), so no separate mobile-specific rule is needed; regression risk is
low since touch UIs typically render overlay scrollbars regardless. To make the scrollbar
visible for manual verification, seed enough categories that the sidebar's category list
overflows — done directly against the dev DB (or via repeated `POST /categories`), not a
UI feature, so no app code needed for this and it isn't a task-file step of its own beyond
the manual-verification section.

**2. Card button alignment.** `CARD_CLASS` in `src/views/queue-list.tsx` (currently
`"rounded-lg border border-border bg-surface overflow-hidden"`) gains `flex flex-col`. The
button row (`class="flex gap-2 p-3 pt-2"`, same file) gains `mt-auto`, pinning it to the
bottom of whichever height the CSS grid row stretches the card to. This fixes the queue and
continue-watching card variants (the only ones rendering that button row); the watched and
ignored card variants share `CARD_CLASS` but have no trailing button row to misalign, so
`flex flex-col` is a no-op layout-wise for them (their existing children still stack
normally in a column). Row-height stretch is already CSS Grid's default
(`align-items: stretch`) via `QueueList`'s existing `grid` container — no grid changes
needed, only the card's own internal layout.

**3. Favicon / installability icons.** One source icon design (visual concept TBD — see
Open Questions) rendered to the standard installability sizes: 16×16 and 32×32 (favicon),
180×180 (`apple-touch-icon`), 192×192 and 512×512 (including a maskable variant), placed
under `public/icons/`. Add `public/manifest.json`: `name: "Tubeshelf"`, a `short_name`,
the icon set, `theme_color`/`background_color` matching the existing `bg`/`surface` theme
tokens, `display: "standalone"`. Link `<link rel="icon">`, `<link rel="apple-touch-icon">`,
and `<link rel="manifest">` in **both** `<head>`s in the app — `src/views/layout.tsx` (used
by every authenticated page) and `src/views/login-page.tsx` (which renders its own
independent `<html><head>`, not `Layout` — confirmed it has its own `<title>` and
stylesheet `<link>` already, so it needs its own copy of these tags too, otherwise the
one page every unauthenticated visitor sees — and the natural place to trigger "Add to
Home Screen" from — would have no icon/manifest at all). Also add a static-serving route
for the new files: `src/index.ts` currently only mounts `/css/*` via `serveStatic({ root:
"./public" })` (line 34) — `public/icons/*` and `public/manifest.json` will 404 without an
equivalent mount (either broaden the existing mount's path or add a second one). No service
worker, no offline caching — see Scope.

**4. Categories form placement.** In `src/views/categories-list.tsx`, the add-category
`<form>` (currently the last element, after the `<ul>`) moves above the `<ul>`, mirroring
`src/views/channels-page.tsx`'s existing `BlankSubscribeForm` → `SubscriptionList` order.
The inline per-row edit form (rendered in place of a list item when `editingId` matches)
is unaffected — this change only moves the standalone "new category" form.

**5. Copy change.** `src/views/queue-list.tsx`'s status-toggle button label: the `"Clear to
Unwatched"` string (used when `row.status === "watching"`) becomes `"Mark Unwatched"`. The
`"Mark Watched"` label (the other branch) is unchanged. No behavior change — this button's
`hx-post` target and toggle logic already exist.

**6. Card metadata clarity.** In `src/views/queue-list.tsx`, all four card variants
(queue/continue-watching, watched, and ignored — three separate `.map()` blocks, each
building its own `{channelName} · {categoryName}` text line) get the same restructure:
replace the plain `" · "`-joined text with a `flex flex-wrap items-center gap-1.5` line
containing the channel name given visual weight distinct from the rest (`text-text` instead
of the current uniform `text-text-muted`) followed by the category rendered as an inline
pill badge, reusing the existing pill pattern already used for the ignore-method tag in the
ignored view (`rounded-full bg-surface-raised px-2 py-0.5 text-xs text-text-muted`) rather
than inventing a new one. Any trailing text that isn't part of the channel/category
pairing — the published/watched-relative-time suffix on queue and watched cards, the
existing ignore-method pill on ignored cards — stays after it, plain muted text (or the
existing pill, for ignore-method) as today, just no longer joined with a literal `" · "`
against the now-pill category.

**7. "ago" suffix.** In `src/lib/relative-time.ts`, the `m`/`h`/`d`/`w` return branches
(lines 13–16) each get an appended `" ago"` (e.g. `` `${Math.floor(diffMs / HOUR)}h ago` ``).
The `date.toLocaleDateString(...)` fallback branch (for videos ≥4 weeks old) is unchanged —
it already reads as an absolute date (e.g. "Jan 26"), not a duration, so "ago" would read
oddly there. The `"just now"` branches are also unchanged (already reads correctly as-is).

**8. Categories filter copy.** The top-level `<a href="/categories">` in
`src/views/layout.tsx` (currently labeled `"Categories"`) navigates to the category
management page (add/rename) — it is not itself a filter control, so relabeling it
`"Categories (Filter)"` (the original idea) would be actively misleading. The real filter
controls are the indented per-category `<a>` links directly below it, already
visually distinguished (indentation, left border, active-state highlight via
`data-active`). Fix: rename the top-level link to `"Manage Categories"` instead, which
correctly describes what clicking it does and, by contrast, implies the sublist beneath it
is the selection/filter mechanism rather than more management. No changes to the sublist
itself.

**9. YouTube links section.** New static nav section in `src/views/layout.tsx`'s sidebar,
under a small "YouTube" heading, with two links:
`https://www.youtube.com/feed/subscriptions` and
`https://www.youtube.com/playlist?list=WL`, both `target="_blank" rel="noopener
noreferrer"`. These are intentionally hardcoded, not per-user data — both URLs resolve
against whichever YouTube account the visiting browser is already logged into, so there is
nothing to store per-user for this. Every existing top-level sidebar entry (Queue,
Categories, Ignored, Channels) is an `<a>` styled with `NAV_LINK_CLASS`, which includes
`data-[active=true]` styling — there's no existing precedent in this sidebar for a
non-interactive section label, since "Categories"/"Ignored" are themselves clickable links
rather than headings over their sublists. "YouTube" needs a small non-link caption (e.g. a
`<p>` with a muted, smaller/uppercase treatment distinct from `NAV_LINK_CLASS`) to read as a
label rather than a dead link; the two URLs below it use `NAV_SUBLINK_CLASS` (or similar)
without any `data-active` logic, since neither URL ever matches an app route. Exact
placement within the sidebar (relative to Channels / Log out) is left to implementation
judgment during `/work-task` — not a decision worth blocking the spec on.

## Open Questions

- Favicon/icon visual design not yet chosen. To be resolved during `/work-task`: propose a
  few simple concepts (e.g. a play-button mark, a shelf/stack motif, a monogram) against
  the existing theme colors before generating the icon set.
- None else — retrospective below.

**Red-team retrospective:** First pass (fresh-eyes subagent, no drafting-conversation
context) checked every code claim against the actual source and found six issues, four
substantive: item 3 originally only touched `layout.tsx`'s `<head>`, missing that
`login-page.tsx` renders its own independent `<head>` (unauthenticated visitors would get
no favicon/manifest) and missing that `src/index.ts` has no static route to actually serve
the new files (would 404 even once added); item 8 originally proposed relabeling the
top-level `"Categories"` link `"Categories (Filter)"`, but that link navigates to category
*management*, not filtering — the actual filter links are the indented sublist below it,
left unaddressed by that copy change; item 6 was scoped to only 2 of the app's 3
independent card-rendering blocks (missing the ignored-view variant), and didn't specify
how the new category pill interacts with the existing `" · "` text-separator convention;
item 9 didn't account for there being no existing non-link sidebar heading to reuse. All
four fixed directly in the Design/Scope sections above. Two minor items (scrollbar and
button-alignment reasoning) were checked and confirmed sound, no changes needed. A second,
narrower pass scoped only to the four fixes (not a full re-review) confirmed each is
correct against the current code and found nothing further.
