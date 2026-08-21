---
status: implemented
created: 2026-08-21
---

# Button Affordance Polish

## Context

Two small, unrelated UI rough edges surfaced in conversation while brainstorming a larger
(ultimately rejected — see below) feature idea:

1. Buttons across the app show the default arrow cursor on hover instead of the pointer
   ("hand") cursor, which is the conventional web affordance signaling an element is
   clickable.
2. On queue/continue-watching video cards, the `Mark Watched`/`Ignore` button pair sits
   packed to the left with a small gap, rather than spread to opposite edges of the card.

Both were scoped and confirmed small enough to skip `/new-feature` and go straight to a
spec, per this project's convention that `/new-feature` is optional for smaller/obvious
work (`CLAUDE.md`).

A third idea from the same conversation — a "Last updated: X / Next: Y" channel-status line
on the queue page — was discussed and explicitly **dropped**, not deferred into this spec.
It surfaced real complexity (the scheduler updates a batch of 5 channels per tick, not one;
newly-subscribed channels with a `null` `nextFetchDueAt` would jump the display
unpredictably; the line would go stale immediately since `/queue` doesn't live-poll its
header) that didn't justify a "gee-whiz" reassurance feature. The user's own read: this kind
of scheduler-health visibility is better suited to a future logging/observability pass,
where "last updated" can be defined rigorously as part of that larger effort, rather than a
one-off label bolted onto the queue page now. Not tracked as deferred work in
`docs/app_idea.md`'s Future Roadmap for the same reason spec018 didn't track its rejected
PWA idea there — it was considered and rejected, not deferred.

## Scope

**In scope:**

1. Give all buttons a pointer cursor on hover, app-wide.
2. On queue/continue-watching video cards only, spread the `Mark Watched`/`Ignore` button
   pair to opposite edges of the card (left-aligned / right-aligned) instead of packed left.

**Explicitly out of scope:**

- The "Last updated / Next" channel-status line — considered and rejected this round, see
  Context. Not deferred to `docs/app_idea.md`.
- Applying the same left/right button-edge treatment to other multi-button rows in the app
  (category edit/delete, ignore-rule edit/delete, subscription actions). Explicitly
  confirmed out of scope in conversation — those are list-row actions with different
  layouts, not video cards, and weren't part of the original ask.

## Design

**1. Pointer cursor, app-wide.** Add one rule to `src/styles/input.css` (already the home
for other global, non-component-scoped style rules — e.g. the `#sidebar` scrollbar styling
added in spec018):

```css
button:not(:disabled) {
  cursor: pointer;
}
```

A single global rule on the `button` element, rather than adding a `cursor-pointer`
Tailwind utility class to each individual `<button>` across the 8 view files that render one
(`login-page.tsx`, `ignore-rules-list.tsx`, `subscribe-confirm.tsx`, `layout.tsx`,
`subscription-list.tsx`, `categories-list.tsx`, `queue-list.tsx`, `watching-page.tsx`). This
is both a smaller diff and self-maintaining — any future `<button>` added anywhere in the
app picks up the correct cursor automatically, with nothing to remember to add. No existing
rule in `input.css` sets `cursor` today (confirmed by reading the file in full), so there's
no conflict to resolve.

The `:not(:disabled)` qualifier matters and isn't optional: the app uses HTMX's
`hx-disabled-elt` in several places (`queue-list.tsx`'s toggle/ignore/un-ignore buttons,
`subscribe-confirm.tsx:21`'s `hx-disabled-elt="find button"`) to set the `disabled`
attribute for the duration of an in-flight request. Browsers are *not* consistent about
exempting disabled elements from an author-specified `cursor` rule — Firefox's UA
stylesheet overrides it, but Chromium and WebKit generally render whatever `cursor` the
author specified even when `disabled` is set. Without the qualifier, a plain `button {
cursor: pointer }` rule would show a misleading pointer cursor on a momentarily-disabled
button in Chrome/Safari specifically. `:not(:disabled)` sidesteps the cross-browser
inconsistency entirely rather than relying on it.

**2. Video card button edge alignment.** In `src/views/queue-list.tsx`, `queueCard`'s
button-row `<div>` (currently `class="mt-auto flex gap-2 p-3 pt-2"`, per spec018 item 2)
changes to `class="mt-auto flex justify-between p-3 pt-2"` — dropping `gap-2` in favor of
`justify-between`, which spreads the two buttons to opposite ends of the row. `gap-2` is
redundant once `justify-between` is set: with exactly two flex children, `justify-between`
already places one at each edge, and `gap` only matters as a minimum enforced spacing that
would come into play if the two buttons' natural widths were wide enough to nearly touch —
not a real scenario here given both buttons are short (`Mark Watched`/`Mark Unwatched` and
`Ignore`) inside a card that's already `minmax(240px, 1fr)` per `QueueList`'s grid template.

This is the only two-button row on a video card — confirmed by reading all four card
variants in `queue-list.tsx`: `watchedCard` renders zero buttons and `ignoredCard` renders
exactly one ("Un-ignore"), so `justify-between` has no effect on them one way or the other
and neither needs touching. `queueCard` is shared by both the `"queue"` and
`"continue-watching"` views (its `view` prop), so this single change covers both without
further edits.

At the grid's minimum card width (`minmax(240px, 1fr)`, `QueueList`'s grid template) minus
the row's `p-3` padding, the longest label pairing ("Mark Unwatched" + "Ignore") leaves a
plausibly tight fit rather than clearly comfortable margin — the row has no `flex-wrap`, so
if it ever did crowd, the two buttons would sit close together rather than wrap to a second
line (`CARD_CLASS`'s `overflow-hidden` rules out an actual overflow/broken-layout failure
mode, worst case is just tighter spacing than ideal). This isn't expected to be a real
problem at the card widths this grid actually produces in practice, but it's a visual
judgment call rather than something to assert from the class names alone — worth a quick
look at the narrowest card width during manual verification rather than treating it as
settled by this spec.

## Open Questions

- Whether the button row stays visually comfortable at the grid's narrowest card width
  (~240px) with the longest label pairing ("Mark Unwatched" + "Ignore") — see Design §2.
  Not expected to be a real problem, but confirm with a look during manual verification
  rather than treating it as settled by the class-name reasoning alone.

**Red-team retrospective:** First pass (fresh-eyes subagent, no drafting-conversation
context) checked every factual claim against the actual source and found three substantive
issues: (1) the "~7 files" list of `<button>`-rendering views was missing
`watching-page.tsx` (8 files, not 7) — fixed by correcting the count and list in Design §1;
(2) the claim that browsers universally exempt `:disabled` elements from author `cursor`
styling is wrong for Chromium/WebKit (only Firefox's UA stylesheet does this) — the original
design would have shown a misleading pointer cursor on momentarily-disabled buttons
(HTMX's `hx-disabled-elt`) in Chrome/Safari; fixed by changing the rule to
`button:not(:disabled)` instead of relying on browser behavior that doesn't actually hold;
(3) the dismissal of the narrow-card button-crowding edge case was asserted without
measurement — fixed by adding rough numbers and flagging it as a manual-verification item
rather than a settled non-issue (see Open Questions). `hx-disabled-elt`'s presence on
`subscribe-confirm.tsx` (not just `queue-list.tsx`) was also missing from the original
description; folded into the corrected Design §1 text. All four fixed directly above. A
second, narrower pass (self-checked, scoped only to the corrected Design §1/§2 text and the
`:not(:disabled)` reasoning, not a full re-review) confirmed the fixes are accurate and
found nothing further.
