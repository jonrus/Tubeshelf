---
status: draft
created: 2026-08-06
---

# Subscribe by @handle or Channel URL

## Context

`docs/app_idea.md`'s MVP item 1 deferred handle-based subscribe to the Future Roadmap:
"Subscribe by `@handle` or channel URL directly, resolved to a channel ID by scraping the
channel page's canonical/meta tags server-side." Today, `parseChannelInput`
(`src/lib/channel-input.ts`) only accepts a raw channel ID, a `/channel/UC...` URL, or an
RSS URL with a `channel_id` param — anything else (a `@handle`, a `/c/CustomName` or
`/user/Username` URL) falls through to `null`, and the subscribe form's only guidance is
"open the channel's page, view source, and search for `channelId`." This is real, recurring
friction: every new subscription requires digging the ID out of page source by hand.

This spec is promoted from `docs/features/007-handle-url-subscribe.md` (`status: refined`),
which resolved scope through an in-chat `/new-feature` session grounded in live research
against real YouTube pages. That file's `Resolved Decisions` are taken as settled; this
spec's Design section adds the concrete mechanics on top, plus one addition found while
writing this spec (see Design's SSRF guard subsection) that wasn't covered in the feature
file.

## Scope

**In** (see the feature file's Firm Scope for the already-settled why; this is what/where):
- Accept, at the existing subscribe input (`BlankSubscribeForm`,
  `src/views/subscribe-confirm.tsx`), four new forms in addition to the three already
  supported:
  - A bare `@handle` (e.g. `@mkbhd`)
  - A full handle URL, with or without a trailing path segment (e.g.
    `https://www.youtube.com/@mkbhd`, `https://www.youtube.com/@mkbhd/videos`)
  - A `/c/CustomName` URL (e.g. `https://www.youtube.com/c/mkbhd`)
  - A `/user/Username` URL (e.g. `https://www.youtube.com/user/marquesbrownlee`)
- A new `src/lib/channel-resolve.ts` module: `resolveChannelInput`, resolving any of the
  seven total accepted forms to `{ channelId, rssUrl }` — the four new forms via a
  server-side fetch of the channel page and a regex parse of its canonical link.
- An SSRF guard on the new fetch (hostname allowlist + strict handle/custom-name character
  allowlist) — see Design. Not in the feature file; found while writing this spec.
- Differentiated error copy in `POST /subscriptions/preview` between "didn't recognize this
  input at all" and "recognized it, but couldn't resolve it to a real channel."
- Rewritten subscribe-form instructional copy, leading with handle/URL instead of the
  view-source method.
- A loading state on the Subscribe button (`hx-disabled-elt`) during the preview request —
  added during this spec's red-team pass, not in the feature file; see Design.
- `docs/app_idea.md` pointer updates (this spec's own cross-references — MVP item 1's
  "deferred (see Future Roadmap)" note, and the Future Roadmap bullet itself).

**Explicitly out** (per the feature file):
- A bare `/c/` or `/user/` name with no path prefix (e.g. typing just `PewDiePie`) —
  ambiguous between the two forms and not how either is normally shared. Only the bare
  `@handle` shorthand skips the URL wrapper.
- Any change to the RSS-based ingestion pipeline, or to `POST /subscriptions`'s (the real
  subscribe-confirm endpoint) existing `CHANNEL_ID_PATTERN` validation — by the time that
  handler runs, `channelId` is already a resolved `UC...` string regardless of what the user
  originally typed into the preview form, so it needs no changes at all.

## Design

### `src/lib/channel-resolve.ts` (new file)

Kept separate from `channel-input.ts` rather than extending it, mirroring this codebase's
existing pure-parsing (`channel-input.ts`) vs. network-fetch (`rss.ts`) split — this keeps
`channel-input.ts` and its currently-mock-free `channel-input.test.ts` unchanged, and puts
the new network-dependent code and its fetch-mocked tests in their own file, same
convention `rss.ts`/`rss.test.ts` already established.

```ts
import { parseChannelInput, rssUrlFor } from "./channel-input";

const SCRAPE_TIMEOUT_MS = 8_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const ALLOWED_HOSTS = new Set(["www.youtube.com", "youtube.com"]);
const HANDLE_SEGMENT = "[A-Za-z0-9_.-]{3,30}";
const CUSTOM_SEGMENT = "[A-Za-z0-9_.-]{1,100}";
const BARE_HANDLE_PATTERN = new RegExp(`^@${HANDLE_SEGMENT}$`);
const URL_PATH_PATTERN = new RegExp(
  `^(?:\\/@(${HANDLE_SEGMENT})|\\/c\\/(${CUSTOM_SEGMENT})|\\/user\\/(${CUSTOM_SEGMENT}))(?:\\/.*)?$`,
);
const CANONICAL_LINK_PATTERN =
  /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})"/;

export type ResolveChannelInputResult =
  | { ok: true; channelId: string; rssUrl: string }
  | { ok: false; reason: "unrecognized" }
  | { ok: false; reason: "resolve-failed" };

function scrapeUrlFor(input: string): string | null {
  if (BARE_HANDLE_PATTERN.test(input)) {
    return `https://www.youtube.com/${input}`;
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) return null;

  const match = url.pathname.match(URL_PATH_PATTERN);
  if (!match) return null;

  return `https://www.youtube.com${match[0]}`;
}

export async function resolveChannelInput(
  input: string,
): Promise<ResolveChannelInputResult> {
  const trimmed = input.trim();

  const direct = parseChannelInput(trimmed);
  if (direct) return { ok: true, ...direct };

  const scrapeUrl = scrapeUrlFor(trimmed);
  if (!scrapeUrl) return { ok: false, reason: "unrecognized" };

  let res: Response;
  try {
    res = await fetch(scrapeUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "resolve-failed" };
  }
  if (!res.ok) return { ok: false, reason: "resolve-failed" };

  const html = await res.text();
  const match = html.match(CANONICAL_LINK_PATTERN);
  const channelId = match?.[1];
  if (!channelId) return { ok: false, reason: "resolve-failed" };

  return { ok: true, channelId, rssUrl: rssUrlFor(channelId) };
}
```

Notes:
- `resolveChannelInput` tries the existing synchronous `parseChannelInput` first — the
  three already-supported forms still take zero network calls, unchanged behavior.
- `scrapeUrlFor` never fetches a raw, unvalidated user string — see SSRF guard below.
- `URL_PATH_PATTERN`'s trailing `(?:\/.*)?$` deliberately keeps whatever sub-path the user
  pasted (e.g. `/videos`) in the reconstructed fetch URL rather than stripping it — verified
  live that a channel's `/videos` tab still carries the same canonical link, so forwarding
  it is harmless and simpler than trying to normalize it away. `url.pathname` never
  includes the query string or fragment (that's just how the `URL` API splits it), so
  tracking params etc. are already dropped without extra code.
- `CANONICAL_LINK_PATTERN` targets the canonical `<link>` tag specifically, not the first
  `"channelId":"..."` match anywhere in the page — verified live that a channel page embeds
  dozens of *other* channels' IDs in an unrelated `ytInitialData` JSON blob (related-channel
  data), so a naive first-match approach would silently resolve to the wrong channel.
  **Verbatim evidence** (not just asserted — the red-team pass on this spec flagged that an
  unquoted "verified live" claim isn't enough, since the regex is brittle to attribute
  order/quoting/whitespace and the unit tests' own HTML fixtures can't catch a
  regex-vs-real-markup mismatch by construction): the literal substring captured from real
  responses against `youtube.com/@mkbhd` and `youtube.com/@mkbhd/videos` is
  `...<link rel="canonical" href="https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ"><link rel="alternate...`
  — `rel` before `href`, double-quoted, no space before the closing `>`, no trailing `/`
  after the channel ID before the closing quote. `CANONICAL_LINK_PATTERN` as written above
  matches this exactly (it only requires up through the closing quote, not the tag's `>`,
  so it's already tolerant of whatever comes after).
- Timeout raised to 8s from `fetchChannelFeed`'s 5s — the scraped page is ~2.6MB (verified
  live against a real channel page), far larger than an RSS feed's few KB. No
  early-abort-on-canonical-link-found streaming optimization for now — simplest thing that
  stays safe via the timeout; revisit only if 8s proves genuinely too slow in practice, not
  preemptively.
  **Correction, caught by this spec's red-team pass**: the feature file's own Resolved
  Decisions section states "reuse `fetchChannelFeed`'s existing shape... 5s
  `AbortSignal.timeout`" (`docs/features/007-handle-url-subscribe.md`), which per this
  project's convention is supposed to be treated as already-settled — but that same file's
  Related Specs/Code section separately flags the 2.6MB page size as a reason `/new-spec`
  shouldn't just copy 5s unexamined. Those two notes contradict each other; this spec
  resolves the contradiction in favor of 8s (the page-size concern is the more specific,
  more recently-reasoned note). Per the append-don't-rewrite convention, the feature file's
  "5s" line itself isn't edited — a pointer note is appended there instead.
- Failure-mode convention matches `fetchChannelFeed`: network error, timeout, non-2xx, and
  missing-canonical-link all collapse to one outcome (here, `{ ok: false, reason:
  "resolve-failed" }`) — no further breakdown needed, same reasoning spec002 used for
  `fetchChannelTitle`.

### SSRF guard (found while writing this spec, not in the feature file)

`test/routes/channels.test.ts` already has a test guarding the *existing* subscribe-confirm
flow against SSRF ("confirm derives the fetch URL from channelId alone, ignoring any other
field") — `POST /subscriptions` always rebuilds its RSS fetch URL from a regex-validated
`channelId`, never from a raw user-supplied URL field. This feature is the first time user
input more directly drives an outbound fetch target (a pasted URL, or a handle interpolated
into a URL this code constructs), so it needs the same discipline or it's a genuine SSRF
hole — e.g. pasting a URL pointing at an internal service instead of youtube.com.

Two layers, both in `scrapeUrlFor` above:
1. **Hostname allowlist** for the three full-URL forms: `new URL(input).hostname` must be
   exactly `www.youtube.com` or `youtube.com` before any fetch is attempted. `URL.hostname`
   normalizes IDN domains to punycode, so a homograph lookalike domain won't collide with
   the literal allowlist strings. Anything else — including an open-redirect-style YouTube
   URL, if one ever existed — is rejected before a request is ever made, not after.
2. **Character allowlist** for the bare-`@handle` form specifically, since that path is
   interpolated into a URL this code constructs itself (`https://www.youtube.com/@${input}`)
   rather than parsed out of an already-well-formed `URL` object:
   `BARE_HANDLE_PATTERN`/`HANDLE_SEGMENT` restrict it to
   `[A-Za-z0-9_.-]{3,30}` (YouTube's actual handle character/length rules) before it ever
   touches a URL string. The `/c/` and `/user/` custom-name segments get the same
   character-class restriction (`CUSTOM_SEGMENT`) as defense-in-depth, even though those
   come from an already-parsed `URL.pathname` rather than raw interpolation.

Test coverage (in `test/lib/channel-resolve.test.ts`, mirroring the existing route-level
SSRF test's spirit at the unit level where the logic actually lives): a full URL pointed at
a non-YouTube host is rejected with **zero** `fetch` calls made — not just a rejected
result, but confirmed no network attempt happened at all.

### `src/routes/channels.tsx` — `POST /subscriptions/preview`

```diff
 import {
   CHANNEL_ID_PATTERN,
-  parseChannelInput,
   rssUrlFor,
 } from "../lib/channel-input";
+import { resolveChannelInput } from "../lib/channel-resolve";
```
(exact final import formatting is whatever `bun run lint`'s Prettier step produces — shown
above to convey intent, not as a literal patch to paste in as-is.)

```diff
 channelsRoute.post("/subscriptions/preview", async (c) => {
   const body = await c.req.parseBody();
   const channelInput =
     typeof body.channelInput === "string" ? body.channelInput : "";
   const categoryIdRaw =
     typeof body.categoryId === "string" ? body.categoryId : "";

-  const parsed = parseChannelInput(channelInput);
-  if (!parsed) {
-    return c.html(
-      <ConfirmError message="Couldn't parse that as a channel ID or URL." />,
-    );
-  }
+  const resolved = await resolveChannelInput(channelInput);
+  if (!resolved.ok) {
+    const message =
+      resolved.reason === "unrecognized"
+        ? "Couldn't parse that as a channel ID, handle, or URL."
+        : "Couldn't find a channel at that handle or URL.";
+    return c.html(<ConfirmError message={message} />);
+  }

   const resolvedCategory = resolveCategoryId(categoryIdRaw);
   if (!resolvedCategory.ok) {
     return c.html(<ConfirmError message={resolvedCategory.error} />);
   }

   const existing = db
     .select()
     .from(youtubeChannels)
-    .where(eq(youtubeChannels.youtubeChannelId, parsed.channelId))
+    .where(eq(youtubeChannels.youtubeChannelId, resolved.channelId))
     .get();

   let channelName: string;
   if (existing) {
     channelName = existing.name;
   } else {
-    const feed = await fetchChannelFeed(parsed.rssUrl);
+    const feed = await fetchChannelFeed(resolved.rssUrl);
     if (!feed) {
       return c.html(
         <ConfirmError message="Couldn't fetch that channel's feed." />,
       );
     }
     channelName = feed.title;
   }

   return c.html(
     <ConfirmPanel
-      channelId={parsed.channelId}
+      channelId={resolved.channelId}
       categoryId={categoryIdRaw}
       channelName={channelName}
     />,
   );
 });
```
Matches `src/routes/channels.tsx` as it exists today line-for-line outside the marked
`+`/`-` lines (verified against the current file while writing this spec, not just
recalled) — the executing task-file step should still re-read the file fresh rather than
trust this diff blindly, standard practice for any patch that's aged since the spec was
written.

`POST /subscriptions` (the real confirm/subscribe endpoint) is untouched — it already
re-validates whatever `channelId` it receives against `CHANNEL_ID_PATTERN` regardless of
how the preview step resolved it, per Scope above.

### Subscribe-form copy (`src/views/subscribe-confirm.tsx`, `BlankSubscribeForm`)

Replaces the current paragraph (added by spec008):
> Paste the channel's ID (starts with `UC`), a URL containing `/channel/UC.../`, or the
> channel's RSS feed URL. To find the ID: open the channel's page, view source, and search
> for `channelId`.

with:
> Paste the channel's `@handle` or its URL (e.g. `youtube.com/@handle`). If you don't know
> the handle, the channel's ID, `/channel/UC.../` URL, or RSS feed URL also work — find the
> ID by opening the channel's page, viewing source, and searching for `channelId`.

Exact wording isn't load-bearing (same caveat spec008 gave its own copy) — the red-team
pass should sanity-check clarity, not treat this as final. `placeholder="Channel ID or URL"`
on the `<input>` itself is left as-is (already generic enough to cover the new forms
without change).

**Loading state, added after this spec's red-team pass caught it as a gap**: the feature
file's "no new loading state needed" call (`docs/features/007-handle-url-subscribe.md`) was
made when the only comparison point was the small, fast RSS-preview fetch — it didn't
anticipate this spec's 8s/2.6MB scrape. Up to 8 seconds with an apparently-unresponsive
Subscribe button is a real gap, not one to inherit unexamined just because an earlier note
said so under different assumptions. Fix: reuse this codebase's existing
`hx-disabled-elt` convention (`src/views/queue-list.tsx`'s un-ignore button), structured
slightly differently here since the request is issued by the `<form>` element (via submit),
not the button itself the way queue-list.tsx's button issues its own — `hx-disabled-elt`
needs to live on the same element as the `hx-post` it's tied to, so it goes on the `<form>`
with a `find` selector targeting the button, not a bare `"this"` on the button itself:

```diff
       <form
         hx-post="/subscriptions/preview"
         hx-target="#confirm-panel"
         hx-swap="outerHTML"
+        hx-disabled-elt="find button"
         class="flex flex-col gap-2"
       >
```

No spinner/text-swap — matches the existing convention's own level of visual feedback (a
disabled button, nothing more), not a new UI pattern introduced just for this feature.

### Testing

- `test/lib/channel-resolve.test.ts` (new, `fetch` mocked via `spyOn(globalThis, "fetch")`
  per this codebase's established convention):
  - Each of the three existing forms (ID, `/channel/` URL, RSS URL) resolves via
    `parseChannelInput` alone — assert zero `fetch` calls.
  - Each of the four new forms (bare `@handle`, full handle URL, handle URL with a trailing
    `/videos` segment, `/c/` URL, `/user/` URL) resolves correctly against a mocked HTML
    response containing a canonical link — **and**, per this codebase's existing convention
    for exactly this kind of check (`test/routes/channels.test.ts`'s
    `expect(fetchSpy.mock.calls[0]?.[0]).toBe(...)` pattern), assert the actual URL `fetch`
    was called with matches the expected reconstructed scrape URL for each form. This
    matters because the existing `mockFetch` test helper returns fixed content regardless
    of the URL it's called with — a test that only checks the *result* wouldn't catch
    `scrapeUrlFor` mangling the URL (e.g. silently dropping the `/videos` suffix, or
    mis-reconstructing the `/c/`/`/user/` path), caught during this spec's red-team pass.
  - The `/videos`-suffix case specifically asserts the trailing segment survives into the
    fetched URL unchanged (`https://www.youtube.com/@mkbhd/videos`, not just
    `/@mkbhd`) — the concrete regression the point above exists to catch.
  - A URL with a query string or fragment (e.g. `https://www.youtube.com/@mkbhd?foo=bar`)
    resolves with the fetched URL stripped of both — asserted via the same
    `fetchSpy.mock.calls[0]?.[0]` check, not just assumed from how `URL.pathname` works.
  - The second allowlisted host's happy path: a bare `youtube.com` (no `www`) URL resolves
    successfully, not just the non-`www` case being rejected.
  - An uppercase or mixed-case host (`WWW.YOUTUBE.COM`) and an `http://` (not `https://`)
    URL both resolve successfully — verified directly against **Bun** (not just Node; this
    project's runtime, per `CLAUDE.md`'s devcontainer rule) via `devcontainer exec
    --docker-path podman --workspace-folder . bun -e 'new
    URL("http://WWW.YOUTUBE.COM/@mkbhd")'` (Bun 1.3.14) that `URL.hostname` always
    lowercases regardless of input case, and `scrapeUrlFor` discards the original scheme
    entirely when rebuilding the fetch URL (always prefixes the literal
    `https://www.youtube.com`), so neither case is actually rejected by anything in this
    design.
  - Empty string and whitespace-only input both return `{ ok: false, reason: "unrecognized"
    }` without attempting a `fetch`.
  - A mocked HTML response containing decoy `"channelId":"..."` values in a fake
    `ytInitialData`-style blob *and* a real canonical link resolves to the canonical link's
    ID, not the first decoy match.
  - A full URL pointed at a non-YouTube host returns `{ ok: false, reason: "unrecognized"
    }` with **zero** `fetch` calls (the SSRF-guard test).
  - A bare word with no `@` (e.g. `"PewDiePie"`) returns `{ ok: false, reason: "unrecognized"
    }` — confirms the explicitly-out-of-scope bare-custom-name case is rejected, not
    guessed at.
  - Totally invalid input (e.g. `"not a channel"`) returns `{ ok: false, reason:
    "unrecognized" }`.
  - A recognized form (e.g. valid-looking `@handle`) with a mocked `404` response returns
    `{ ok: false, reason: "resolve-failed" }`.
  - A recognized form with a mocked `200` response whose body has no canonical link returns
    `{ ok: false, reason: "resolve-failed" }`.
  - A mocked network error/timeout (`fetch` rejecting) returns `{ ok: false, reason:
    "resolve-failed" }`.
- `test/routes/channels.test.ts` additions:
  - `POST /subscriptions/preview` with a handle input, mocked scrape response, resolves and
    renders `ConfirmPanel` with the right `channelId`/name — full route-level path, not just
    the unit-level resolver.
  - Same endpoint surfaces "Couldn't parse that as a channel ID, handle, or URL." for
    unrecognized input, and "Couldn't find a channel at that handle or URL." for a
    recognized-but-failed resolution — confirms the two messages are actually wired to the
    right `reason` values, not just tested in isolation at the unit level.

### `docs/app_idea.md` cross-references

- MVP item 1: "Handle-based (`@handle`) lookup is deferred (see Future Roadmap)." →
  "Handle-based (`@handle`) lookup (refined in `docs/specs/016-handle-url-subscribe.md`)."
- Future Roadmap bullet: append
  "(refined in `docs/specs/016-handle-url-subscribe.md`)" to the existing "Subscribe by
  `@handle` or channel URL directly..." line.

### Manual end-to-end verification

**Claude performs directly** (`curl` from inside the devcontainer per `CLAUDE.md`'s
port-forwarding gotcha, plus direct DB reads):
1. `POST /subscriptions/preview` with a real `@handle` (e.g. `@mkbhd`) — response contains
   the real channel name, proving live scrape + canonical-link parse works end-to-end
   against actual youtube.com, not just mocked tests.
2. Same with a real `/c/...` and a real `/user/...` URL.
3. `POST /subscriptions/preview` with unrecognized garbage input — "Couldn't parse that as
   a channel ID, handle, or URL."
4. `POST /subscriptions/preview` with a syntactically-valid but nonexistent handle (e.g.
   `@this-handle-should-not-exist-zzz999xyz`) — "Couldn't find a channel at that handle or
   URL."
5. Full cycle: preview with a real handle → confirm panel's `channelId` → `POST
   /subscriptions` with that `channelId` → DB query confirms a real subscription row with
   the correct `youtube_channel_id`.
6. The non-YouTube-host SSRF-guard case is covered by the automated unit test instead of a
   live check here — same reasoning spec002 gave for cases hard to exercise by hand; no
   need to actually fetch a third-party host during manual verification.

**User performs live in a browser** (`/channels`):
1. Type a real `@handle` into the subscribe form — confirm panel populates with the correct
   channel name via an HTMX partial swap (no full page reload).
2. Same for a real legacy `/c/...` or `/user/...` URL pasted in.
3. Type a nonexistent handle — inline error renders in the confirm panel, styled
   consistently with existing error states.
4. Visually confirm the rewritten instructional copy above the input reads clearly.

`bun test`, `bun run lint`, and `bunx tsc --noEmit` must all be clean — per `CLAUDE.md`,
this is every spec's final task-file step regardless of whether tests alone would pass.

## Open Questions

None remaining. The feature file's `/new-feature` research resolved every scope-level
ambiguity; this spec's own addition (the SSRF guard) was raised to the user directly during
drafting and confirmed before being written in.

**Red-team retrospective**: one independent pass (general-purpose agent, no memory of the
drafting conversation), which found five real issues, all fixed directly in this spec —
no second pass run, since the fixes were mechanical corrections/additions rather than
design changes that could themselves hide a new blind spot:
1. **(High)** `CANONICAL_LINK_PATTERN` was only backed by prose ("verified live") with no
   quoted evidence, and the unit tests' own fixtures couldn't have caught a
   regex-vs-real-markup mismatch by construction. Fixed by re-fetching and quoting the
   literal captured markup directly in the Design section.
2. **(Medium)** The Testing section described the four new input forms as "resolving
   correctly" without ever asserting *what URL was actually fetched* — since the existing
   `mockFetch` test helper ignores its call's URL, `scrapeUrlFor` mangling a path (e.g.
   silently dropping the `/videos` suffix this spec explicitly claims to preserve) would
   have passed every test unnoticed. Fixed by requiring the same
   `fetchSpy.mock.calls[0]?.[0]` assertion pattern this codebase already uses elsewhere.
3. **(Medium)** This spec's 8s timeout silently overrode the feature file's own Resolved
   Decisions text ("5s `AbortSignal.timeout`") without acknowledging the conflict — that
   section is supposed to be treated as already-settled per this project's convention.
   Fixed by adding an explicit correction note in both this spec and (append-don't-rewrite)
   the feature file itself.
4. **(Medium)** Several edge cases (bare non-`www` `youtube.com` happy path, query
   string/fragment stripping, uppercase host, `http://` scheme, empty/whitespace input)
   were asserted as correct in prose but had no corresponding test. Fixed by adding them to
   the Testing section.
5. **(Low)** The `channels.tsx` diff hunks didn't match the file's actual current
   formatting (collapsed multi-line imports/const declarations). Fixed by correcting the
   diffs to match the real file, with a note that the executing task-file step should still
   re-read the file fresh rather than trust the diff blindly.

A sixth finding, initially flagged and then ruled out by the reviewing agent itself: the
`docs/app_idea.md` "before" text quoted in this spec's cross-reference section didn't match
`git HEAD`, but did match an already-applied, not-yet-committed working-tree edit — not a
defect, just something to commit alongside this spec file as usual.

Also addressed, though not itself a defect in what was written (an omission rather than
something wrong): the reviewing agent noted the 8s timeout increase reopens the feature
file's "no new loading state needed" call, since that call was made assuming the earlier,
much-faster RSS-preview-fetch latency profile. Fixed by adding an `hx-disabled-elt` loading
state, reusing this codebase's existing convention from `queue-list.tsx` (structured
differently here since the request is issued by the `<form>`, not the button itself).
