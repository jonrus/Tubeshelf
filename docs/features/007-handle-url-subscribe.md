---
status: refined
created: 2026-08-06
---

# Subscribe by @handle or Channel URL

## Problem / Motivation
MVP subscribe (`docs/specs/002-channel-subscriptions.md`) only accepts a raw channel ID, a
`/channel/UC...` URL, or an RSS URL with a `channel_id` param (`src/lib/channel-input.ts`).
Anything else — a `@handle` URL, a bare handle, a `/c/CustomName` URL — falls through to
`null` today, per `docs/app_idea.md`'s MVP item 1: "the subscribe page should include copy
guiding them to find [the channel ID] via `/channel/` or `channelId` in the channel's page
source." This is real, recurring friction: every new subscription requires the user to go
dig the ID out of page source manually, unlike almost every other YouTube-adjacent tool
where you just paste the handle/URL you're already looking at.

This is the next roadmap item queued up post-v1.0 (`docs/app_idea.md`'s Future Roadmap:
"Subscribe by `@handle` or channel URL directly, resolved to a channel ID by scraping the
channel page's canonical/meta tags server-side").

## Firm Scope
- Accept, at the existing subscribe input, all of:
  - A bare `@handle` (e.g. `@mkbhd`)
  - A full handle URL (`https://www.youtube.com/@mkbhd`, with or without a trailing path
    segment like `/videos`)
  - A legacy `/c/CustomName` URL (e.g. `https://www.youtube.com/c/mkbhd`)
  - A legacy `/user/Username` URL (e.g. `https://www.youtube.com/user/marquesbrownlee`)
  - (Bare `/c/` or `/user/` names with no path prefix are **not** accepted — see Explicitly
    Out of Scope; only a bare handle gets the no-URL shorthand.)
- Resolve any of the above to a channel ID via a server-side fetch of the channel's page
  and parsing `<link rel="canonical" href="https://www.youtube.com/channel/UC...">` out of
  the response HTML. One resolver function handles all four forms identically — same fetch
  + canonical-link-parse, just a different starting URL.
  - **Verified during this feature file's research:** a plain `fetch` with a normal browser
    `User-Agent` header returns this canonical link in the initial HTML response for all
    four forms — no JS execution/headless browser needed. Confirmed live against
    `youtube.com/@mkbhd`, `/@mkbhd/videos`, `/c/mkbhd`, `/user/marquesbrownlee`, and
    `/user/PewDiePie`.
  - **Caution, also verified:** the same page embeds dozens of *other* channels' IDs in an
    embedded `ytInitialData` JSON blob (related-channels data) — the parser must target the
    canonical `<link>` specifically, not just grab the first `"channelId":"..."` match in
    the page, which would silently resolve to the wrong channel.
- New failure mode needs user-facing handling distinct from the existing RSS-fetch-failure
  path: the scrape can fail (bad/nonexistent handle/custom-name/username → YouTube 404,
  network timeout, or a YouTube page-layout change breaking the canonical-link parse).
  Existing subscribe error UX should be reviewed and extended to cover this. (See Resolved
  Decisions — the failure-mode *convention* itself is settled; exact new copy is the one
  remaining Open Question.)
- Rewrite the subscribe input's placeholder/instructional copy (currently in
  `docs/specs/008-mvp-completion-gaps.md`'s scope, rendered in
  `src/views/subscribe-confirm.tsx`'s `BlankSubscribeForm`) to lead with handle/URL as the
  easy path, demoting the "view page source for `channelId`" method to a fallback line for
  when a channel has no discoverable handle.

## Nice-to-have / Stretch Scope
None identified.

## Explicitly Out of Scope
- A **bare** `/c/` custom name or `/user/` username with no path prefix (e.g. typing just
  `PewDiePie` with no `@`, no `/c/`, no `/user/`) — ambiguous between the two legacy forms
  (and not how either is normally shared/copied by a user in the first place), unlike a
  bare handle which is unambiguous by its `@` prefix. Only the bare-handle shorthand gets
  no-URL treatment; `/c/` and `/user/` always require their full URL.
- Any change to the RSS-based ingestion pipeline itself — this only touches how a channel
  ID is *obtained* at subscribe time, not what happens after.

## Related Specs / Code
- `src/lib/channel-input.ts` — `parseChannelInput`, the function this extends. Currently
  synchronous/pure (no I/O); adding handle/URL resolution introduces the first network call
  *before* `upsertYoutubeChannel`'s existing RSS fetch.
- `src/lib/subscribe.ts` — `upsertYoutubeChannel`, the existing (only) network-dependent
  step in the subscribe flow today; the new scrape-resolution step needs to compose with
  this, including how a scrape failure surfaces vs. an RSS-fetch failure.
- `docs/specs/002-channel-subscriptions.md` — original subscribe-flow spec.
- `docs/specs/008-mvp-completion-gaps.md` — owns the current subscribe-page instructional
  copy this feature will need to update.
- **Technical note for `/new-spec`'s Design section**: the full channel-page HTML fetched
  during research was **2.6MB** (`wc -c` on a live `youtube.com/@mkbhd` response), far
  larger than an RSS feed's few KB — `fetchChannelFeed`'s 5s timeout shouldn't be assumed
  to carry over unexamined; worth a deliberate call on timeout duration and whether an
  early-abort-once-canonical-link-found optimization is worth the complexity, rather than
  silently downloading the full page every time.

## Open Questions
- What should the user see while resolution is in flight, and exactly what error copy for
  each new failure mode (bad handle / timeout / parse failure)?

## Resolved Decisions
- **Where the network fetch happens**: `POST /subscriptions/preview`
  (`src/routes/channels.tsx`) already does an async resolve-then-confirm step today — for a
  not-yet-known channel it fetches the RSS feed just to get the channel's display name for
  `ConfirmPanel`, before the user ever hits the real `POST /subscriptions`. The handle/URL
  scrape slots into this exact same step: `parseChannelInput` is tried first (unchanged,
  synchronous, handles the existing three forms with no network call), and only if that
  returns `null` do we attempt the new async scrape-resolve as a fallback. `ConfirmPanel`
  already threads the resolved `channelId` through as a hidden field to the real subscribe
  POST, so `channelsRoute.post("/subscriptions", ...)`'s existing
  `CHANNEL_ID_PATTERN`-validation needs **no change at all** — by the time it runs, the ID
  is already a resolved `UC...` string regardless of what the user originally typed. No new
  UX pattern needed (no loading state beyond what the existing RSS-fetch-on-preview already
  has); no change needed to the real subscribe POST handler.
- **Rate-limiting**: not needed. Unlike the scheduled RSS-ingestion job (which stagger/
  jitters across potentially hundreds of channels from one IP), this fetch only fires once
  per manual, user-initiated preview submission — inherently self-limited by human
  interaction speed, same reasoning as why the existing RSS-fetch-for-name-on-preview step
  needed no throttling either.
- **Failure-mode convention**: reuse `fetchChannelFeed`'s existing shape
  (`src/lib/rss.ts`) — collapse network error / timeout / non-2xx / unparseable response
  into a single `null` return, no thrown exceptions, 5s `AbortSignal.timeout`. Verified live
  (2026-08-06): a nonexistent handle (`youtube.com/@this-handle-should-not-exist-zzz999xyz`)
  returns a clean `404` with no canonical link in the body — so a plain `!res.ok` check
  (same as `fetchChannelFeed`) is sufficient to catch the common case; the existing
  `ConfirmError` route-layer pattern already gives its own message per call site regardless
  of *why* the lower-level function returned `null` (e.g. today's "Couldn't fetch that
  channel's feed." doesn't distinguish 404 from timeout either), so no new
  failure-classification plumbing is needed to give the new step its own message.
- **Legacy `/c/CustomName` and `/user/Username` URLs**: verified live (2026-08-06) that
  these resolve via the exact same canonical-link mechanism as `@handle` —
  `youtube.com/c/mkbhd`, `youtube.com/user/marquesbrownlee`, and
  `youtube.com/user/PewDiePie` all returned `200` with a correct
  `<link rel="canonical" href=".../channel/UC...">`. (One arbitrary custom-name guess,
  `/c/PewDiePie`, 404'd — expected, that specific slug was apparently never claimed; not a
  mechanism failure.) Also verified a handle URL with a trailing path segment
  (`/@mkbhd/videos`) resolves fine, so no special-casing needed for that either.
