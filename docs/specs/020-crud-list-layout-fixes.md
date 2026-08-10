---
status: in-progress
created: 2026-08-10
---

# CRUD List Layout Fixes

## Context

Two small layout inconsistencies on the CRUD-style list pages (Categories, Ignore Rules,
Channels — the "distinct, simpler list/table treatment" spec011 established, refined by
spec018) were found through actual use and discussed in conversation before this spec was
written:

1. **Ignore Rules' "Add" form sits below the rule list**, not above it. spec018 item 4
   already moved the Categories page's "add category" form above its list specifically to
   match the pre-existing Channels-page pattern (`BlankSubscribeForm` above
   `SubscriptionList`), but `src/views/ignore-rules-list.tsx` was never brought in line with
   that same convention — its "New keyword" form (lines 91–106) is still the last element in
   the component, after the `<ul>` of existing rules.
2. **Channels' Unsubscribe button sits inline with the rest of the row**, not pushed to the
   far right the way Categories' Edit button is. `src/views/categories-list.tsx`'s row
   `<li>` uses `justify-between` to split into two groups — the category link/count on the
   left, a `<span>` wrapping the Edit button (+ `[system]` tag) on the right.
   `src/views/subscription-list.tsx`'s row `<li>` has no such split: channel name, count,
   category, the optional missed-videos warning + Dismiss button, and the Unsubscribe button
   are all one flat `flex flex-wrap items-center gap-2` group, so Unsubscribe just falls
   wherever it lands after the warning/Dismiss content rather than being visually
   distinguished as *the* row action the way Edit is on Categories.

Both are pure-markup fixes with no behavior, route, or data changes — small enough not to
warrant a `/new-feature` pass (per CLAUDE.md, that step is for larger/ambiguous asks; this
one was already scoped in conversation against the current code before this spec was
written).

## Scope

**In scope:**

1. Move `ignore-rules-list.tsx`'s "New keyword" add-form above the rule `<ul>`, mirroring
   `categories-list.tsx`'s existing form-above-list structure (itself established by
   spec018 item 4).
2. Restructure `subscription-list.tsx`'s row `<li>` so **only** the Unsubscribe button is
   pushed to the far right (via `justify-between` + a wrapping `<span>`, mirroring
   `categories-list.tsx`'s Edit-button treatment exactly). The missed-videos warning text
   and its Dismiss button stay inline with the channel name/count/category on the left —
   confirmed explicitly in conversation: only Unsubscribe moves, not a "group all action
   buttons on the right" restructure.

**Explicitly out of scope:**

- Any change to `categories-list.tsx` itself (already correct — the reference pattern both
  items above are matching).
- Any change to the inline per-row edit-form swap behavior on either page (Ignore Rules'
  edit-in-place form, Categories' edit-in-place form) — unaffected by either change.
- Grouping Dismiss + Unsubscribe together on the right (considered, rejected in favor of
  matching Categories' single-button-right pattern exactly — see Context).
- Any other CRUD-list styling change beyond these two specific items.

## Design

**1. Ignore Rules form placement.** In `src/views/ignore-rules-list.tsx`, the standalone
"Add" `<form>` (currently the last child of the `#ignore-rules-list` div, lines 91–106,
posting to `/ignore-rules` and swapping `#ignore-rules-list` via `outerHTML`) moves to
before the `{props.rules.length === 0 ? ... : <ul>...}` block — the exact position
`categories-list.tsx`'s own add-form already occupies relative to its list. No changes to
the form's `hx-post`/`hx-target`/`hx-swap` attributes, its input/button markup, or the
`props.error` paragraph below it — this is purely a reorder of existing JSX, not a rewrite.
The inline per-row edit form (rendered in place of a list item when `editingId` matches a
rule) is unaffected, same as spec018 item 4's equivalent note for Categories.

**2. Unsubscribe button right-alignment.** In `src/views/subscription-list.tsx`, the row
`<li>`'s class becomes `flex items-center justify-between gap-2 px-4 py-3
hover:bg-surface-raised` — identical to `categories-list.tsx`'s row `<li>` class, including
dropping `flex-wrap` from the `<li>` itself (it moves onto the new left-side `<span>` below,
which is where the actual wrapping behavior is needed).

**Structural note caught in review, resolved here:** Categories' `<li>` (`categories-list.tsx:70-91`)
gets away with `justify-between` on the `<li>` itself only because it has exactly two
top-level children — the `<a>` and the Edit-wrapping `<span>` — so the flex algorithm has
only two items to distribute space between. `subscription-list.tsx`'s row, when
`showMissedVideosBadge` is true, currently has *four* sibling elements/text-runs inside the
`<li>` (the channel-name/count/category text run, the warning `<span>`, the Dismiss
`<button>`, and — once added — the Unsubscribe `<span>`). Adding `justify-between` directly
to the `<li>` without also grouping the left-side content would distribute space evenly
across all four items, pulling the warning text and Dismiss button away from the channel
name whenever the badge is shown — directly breaking the "stays inline with the channel
name on the left" requirement below. To avoid this, the `<li>`'s children are grouped into
exactly two top-level flex items, mirroring Categories' two-child structure exactly:

- **Left:** a `<span class="flex flex-wrap items-center gap-2">` wrapping the existing
  channel name, unwatched count, category text, and — when `showMissedVideosBadge` is true
  — the "⚠ Possible missed videos" text and its Dismiss button, exactly as rendered today
  (this new wrapping span keeps the `flex flex-wrap items-center gap-2` treatment the `<li>`
  itself has today, so this content's own internal layout/wrapping behavior is unchanged;
  only its container changes from the `<li>` to this new `<span>`).
- **Right (new):** a `<span class="flex items-center gap-2">` wrapping only the Unsubscribe
  `<button>`, mirroring `categories-list.tsx`'s
  `<span class="flex items-center gap-2 text-sm text-text-muted">` wrapper around its Edit
  button (Unsubscribe keeps its existing `SECONDARY_BUTTON_CLASS` styling rather than
  adopting Categories' `text-sm text-text-muted` span-level text styling, since that class
  on Categories' span exists for the `[system]` tag text, which Channels has no equivalent
  of).

No changes to the Unsubscribe button's `hx-delete`/`hx-target`/`hx-swap` attributes, the
Dismiss button's behavior, or `subscription-list.tsx`'s `Subscription` type — purely a
markup restructure of the existing `<li>`'s children into two grouped flex items.

## Testing

No existing test asserts on element order or position within either component's rendered
markup (confirmed by inspecting `test/routes/ignore-rules.test.ts` and
`test/routes/channels.test.ts`: both use `toContain`/`extractSubscriptionRow`-style
substring checks against rendered HTML, none position- or order-sensitive), so no existing
test is expected to break. No new tests are needed — both changes are purely visual/
structural with no new logic to cover; existing tests continue to assert the same
add/edit/delete/dismiss/unsubscribe *behavior*, which is unchanged.

~~No existing test is expected to break.~~ **Confirmed false at implementation time (task
step 2):** `extractSubscriptionRow` in `test/routes/channels.test.ts` (line 146) anchors its
regex to match the channel name *immediately* after `<li[^>]*>`, with no tag allowed in
between — it is position-sensitive in exactly the way this section said no test was. Wrapping
the channel name in the new left-side `<span>` (Design item 2) broke 5 tests
(`no subscription row found for "..."`). Fixed by relaxing the regex to
`` <li[^>]*>(?:<[^>]+>)*${escaped}[\s\S]*?</li> `` — allowing zero or more wrapping tags
between `<li>` and the channel name — rather than avoiding the wrapping-span structure, since
the two-span structure is required by the "Structural note" above. All 218 tests pass after
the fix.

## Verification

Per CLAUDE.md's split:

**Claude performs directly** (via `curl` from inside the devcontainer):
1. `bun test`, `bun run lint`, and `bunx tsc --noEmit` all clean.
2. `curl /ignore-rules` — confirm the "New keyword" form's markup appears before the first
   rule's row in the response body (or before the empty-state message, if no rules exist).
3. `curl /channels` — confirm a subscription row with `showMissedVideosBadge` true renders
   the warning text and Dismiss button before Unsubscribe in the response body, and that
   Unsubscribe is wrapped in its own `<span>`.

**User performs live in a browser:**
1. Visit `/ignore-rules` — confirm the add-keyword form appears above the list, and adding a
   rule still works (HTMX partial swap, no full reload).
2. Visit `/channels` — confirm Unsubscribe sits flush right on each row, matching Categories'
   Edit-button alignment, at both desktop and mobile widths (checking `flex-wrap` doesn't
   misbehave on a narrow viewport with a long channel/category name plus the missed-videos
   warning present).
3. On a row with the missed-videos warning, confirm Dismiss still sits inline with the
   warning text (not pushed right with Unsubscribe) and both buttons still function.

## Open Questions

None — retrospective below.

**Red-team retrospective:** First pass (subagent, no memory of the drafting conversation)
checked every concrete claim in this spec — line citations in
`ignore-rules-list.tsx`/`categories-list.tsx`/`subscription-list.tsx`, the
`SECONDARY_BUTTON_CLASS`/span-class comparison, and the Testing section's claim that no
existing test is order-sensitive — against the current source. All line citations and class
comparisons checked out exactly, and the test-coverage claim held (`extractSubscriptionRow`'s
regex only anchors on the channel name immediately following `<li ...>` through the next
`</li>`, unaffected by children being regrouped inside it). But it found one substantive
issue: Design item 2's original draft added `justify-between` straight to the `<li>` without
grouping the left-side content into its own container. Since a flex container distributes
space across *all* of its top-level children (not "the left stuff" vs. "the right stuff" as
a single unit unless explicitly wrapped), and `subscription-list.tsx`'s row has up to four
sibling children when the missed-videos badge is present (text run, warning span, Dismiss
button, and the new Unsubscribe span) versus Categories' `<li>` having exactly two, the
original draft would have pulled the warning text and Dismiss button away from the channel
name — directly contradicting the "stays inline on the left" requirement it was meant to
satisfy. Fixed by wrapping the left-side content in its own `<span>`, giving the `<li>`
exactly two top-level flex children (matching Categories' structure) before `justify-between`
is applied — see Design item 2's "Structural note" above.

A second, independent pass (scoped only to the fix, no memory of the first pass, not a full
re-review) confirmed the two-span structure correctly isolates `justify-between` to
left-vs-right in both the badge-present and badge-absent cases, that the left span's `flex
flex-wrap items-center gap-2` preserves today's internal wrapping/spacing behavior unchanged,
and that dropping `flex-wrap` from the `<li>` itself (moving it onto the left span) is sound
— the left span's own wrap handles narrow-viewport wrapping regardless of the `<li>`'s own
wrap setting. It flagged one minor wording nit: item 2's opening sentence originally said the
`<li>`'s class "changes... to include `justify-between`," which read ambiguously about
whether `flex-wrap` was kept or dropped on the `<li>` itself in isolation from the rest of
the section. Fixed by rewording that sentence to state the `<li>`'s final class directly
(dropping `flex-wrap` from the `<li>`, moving it onto the left span) rather than describing
it as a diff. No further issues found — second pass is the stopping point per this skill's
rule (a pass finding nothing further is the stopping signal).
