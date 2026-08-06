# Tasks: Subscribe by @handle or Channel URL
Spec: docs/specs/016-handle-url-subscribe.md
Generated: 2026-08-06

Work happens on the already-existing branch `spec/handle-url-subscribe` (created at
`/new-feature` time, per `CLAUDE.md`'s branch/PR workflow) — no task below creates a
branch. Each task's changes are committed locally as usual; per `CLAUDE.md`, never push
without asking first, and the only point a push is actually needed is task 6's final PR
step. `docs/app_idea.md`'s cross-reference pointers (MVP item 1, Future Roadmap bullet)
are **already applied and committed** (done while drafting the spec) — no task below
duplicates that.

- [x] 1. Create `src/lib/channel-resolve.ts` with the module exactly as specified in the
  spec's Design section (`docs/specs/016-handle-url-subscribe.md`, "`src/lib/channel-resolve.ts`
  (new file)"):
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
  `scrapeUrlFor` is not exported (internal helper only); `ResolveChannelInputResult` and
  `resolveChannelInput` are.
  Done when: the file exists matching the above, and `bunx tsc --noEmit` (via
  `devcontainer exec --docker-path podman --workspace-folder .`) is clean.

- [ ] 2. Create `test/lib/channel-resolve.test.ts`, mirroring `test/lib/rss.test.ts`'s
  `spyOn(globalThis, "fetch")` mocking convention. Cover every case listed in the spec's
  Testing section under `test/lib/channel-resolve.test.ts` (`docs/specs/016-handle-url-subscribe.md`):
  - Each of the 3 existing forms (raw ID, `/channel/` URL, RSS URL) resolves via
    `parseChannelInput` alone — assert `fetch` was never called.
  - Each of the 4 new forms (bare `@handle`, full handle URL, handle URL with a trailing
    `/videos` segment, `/c/` URL, `/user/` URL) resolves correctly against a mocked HTML
    response containing a canonical link (use the literal verbatim markup quoted in the
    spec's Design section: `<link rel="canonical" href="https://www.youtube.com/channel/UC...">`
    with a valid 22-char ID) — **and** assert the actual fetched URL
    (`fetchSpy.mock.calls[0]?.[0]`) equals the expected reconstructed scrape URL for each
    form, matching `test/routes/channels.test.ts`'s existing
    `expect(fetchSpy.mock.calls[0]?.[0]).toBe(...)` pattern. The `/videos`-suffix case
    specifically asserts the fetched URL is `https://www.youtube.com/@<handle>/videos`, not
    the suffix-stripped form.
  - A URL with a query string and/or fragment (e.g.
    `https://www.youtube.com/@mkbhd?foo=bar#frag`) resolves, with the fetched URL
    (`fetchSpy.mock.calls[0]?.[0]`) stripped of both.
  - A bare `youtube.com` (no `www`) URL resolves successfully (the second allowlisted
    host's happy path, not just the rejection case below).
  - An uppercase/mixed-case host (`https://WWW.YOUTUBE.COM/@mkbhd`) and an `http://` (not
    `https://`) URL both resolve successfully.
  - Empty string and whitespace-only (`"   "`) input both return
    `{ ok: false, reason: "unrecognized" }` with zero `fetch` calls.
  - A mocked HTML response containing decoy `"channelId":"..."` values (simulate an
    unrelated `ytInitialData`-style blob) *and* a real canonical link resolves to the
    canonical link's ID, not the first decoy match.
  - A full URL pointed at a non-YouTube host (e.g. `https://example.com/@mkbhd`) returns
    `{ ok: false, reason: "unrecognized" }` with **zero** `fetch` calls (the SSRF-guard
    test).
  - A bare word with no `@` (e.g. `"PewDiePie"`) returns
    `{ ok: false, reason: "unrecognized" }`.
  - Totally invalid input (e.g. `"not a channel"`) returns
    `{ ok: false, reason: "unrecognized" }`.
  - A recognized form (valid-looking `@handle`) with a mocked `404` response returns
    `{ ok: false, reason: "resolve-failed" }`.
  - A recognized form with a mocked `200` response whose body has no canonical link
    returns `{ ok: false, reason: "resolve-failed" }`.
  - A mocked network error/timeout (`fetch` rejecting) returns
    `{ ok: false, reason: "resolve-failed" }`.
  Done when: `bun test test/lib/channel-resolve.test.ts` (via `devcontainer exec`) passes,
  covering every case above.

- [ ] 3. Update `POST /subscriptions/preview` in `src/routes/channels.tsx` per the spec's
  diff (`docs/specs/016-handle-url-subscribe.md`, "`src/routes/channels.tsx` — `POST
  /subscriptions/preview`" section) — re-read the current file first rather than trusting
  the spec's diff blindly (it notes this itself): remove `parseChannelInput` from the
  `../lib/channel-input` import, add `import { resolveChannelInput } from
  "../lib/channel-resolve";`, and replace the handler's parse step:
  ```ts
  const resolved = await resolveChannelInput(channelInput);
  if (!resolved.ok) {
    const message =
      resolved.reason === "unrecognized"
        ? "Couldn't parse that as a channel ID, handle, or URL."
        : "Couldn't find a channel at that handle or URL.";
    return c.html(<ConfirmError message={message} />);
  }
  ```
  and rename every subsequent `parsed.channelId`/`parsed.rssUrl` reference in this handler
  to `resolved.channelId`/`resolved.rssUrl`. Leave `POST /subscriptions` (the confirm
  endpoint) and everything else in the file untouched.
  Done when: `bunx tsc --noEmit` is clean, `bun run lint` is clean, and the existing
  `bun test test/routes/channels.test.ts` suite still passes unmodified (confirms no
  regression before task 4 adds new coverage — none of the existing tests assert the old
  "Couldn't parse that as a channel ID or URL." string literal, so this is expected to
  stay green).

- [ ] 4. Add the two route-level tests from the spec's Testing section to
  `test/routes/channels.test.ts`:
  - `POST /subscriptions/preview` with a bare-handle-shaped input (a literal test string
    like `"@previewHandleTest"` — the existing `channelId()` helper produces `UC...`-shaped
    IDs, not handles, so don't reuse it for this case) and a mocked scrape response
    (HTML containing a canonical link pointing at a valid, distinct `UC...`-shaped test
    channel ID) resolves and renders `ConfirmPanel` with that channel's `channelId`/name —
    a full route-level path exercising `resolveChannelInput` through the actual endpoint,
    not just the unit-level resolver from task 2.
  - The same endpoint surfaces "Couldn't parse that as a channel ID, handle, or URL." for
    unrecognized input, and "Couldn't find a channel at that handle or URL." for a
    recognized-but-failed resolution (e.g. mocked `404`) — confirming both messages are
    actually wired to the right `reason` values at the route layer, not just correct in
    isolation at the unit level.
  Reuse the file's existing `postPreview`/`mockFetch` helpers.
  Done when: `bun test test/routes/channels.test.ts` (via `devcontainer exec`) passes,
  including both new tests.

- [ ] 5. Update `src/views/subscribe-confirm.tsx`'s `BlankSubscribeForm` per the spec's
  Design section ("Subscribe-form copy" and "Loading state" subsections):
  - Replace the instructional paragraph:
    ```
    Paste the channel's ID (starts with UC), a URL containing /channel/UC.../, or the
    channel's RSS feed URL. To find the ID: open the channel's page, view source, and
    search for channelId.
    ```
    with:
    ```
    Paste the channel's @handle or its URL (e.g. youtube.com/@handle). If you don't know
    the handle, the channel's ID, /channel/UC.../ URL, or RSS feed URL also work — find the
    ID by opening the channel's page, viewing source, and searching for channelId.
    ```
    (exact JSX markup/formatting — `<code>` tags around the inline literals, etc. — follows
    the existing paragraph's structure; wording itself isn't load-bearing per the spec).
  - Add `hx-disabled-elt="find button"` to the `<form>` element (alongside its existing
    `hx-post`/`hx-target`/`hx-swap`), so the Subscribe button is disabled for the duration
    of the (now up to 8s) preview request.
  - Leave `placeholder="Channel ID or URL"` on the `<input>` unchanged.
  Done when: `bun run lint` and `bunx tsc --noEmit` are clean, and a quick grep of the file
  confirms both the new copy and `hx-disabled-elt="find button"` are present on the form.

- [ ] 6. Final verification, spec status, and PR. First run `bun test`, `bun run lint`, and
  `bunx tsc --noEmit` clean across the whole repo (all via `devcontainer exec
  --docker-path podman --workspace-folder .`).
  **Claude performs directly** (`curl` from inside the devcontainer per `CLAUDE.md`'s
  port-forwarding gotcha, plus direct DB reads against the dev SQLite file):
  1. Start the dev server in the devcontainer if not already running.
  2. `POST /subscriptions/preview` with a real `@handle` (e.g. `@mkbhd`) — response
     contains the real channel name.
  3. Same with a real `/c/...` and a real `/user/...` URL (e.g. `/c/mkbhd`,
     `/user/marquesbrownlee` per the spec's own live-research examples).
  4. `POST /subscriptions/preview` with unrecognized garbage input (e.g. `"not a
     channel"`) — response contains "Couldn't parse that as a channel ID, handle, or URL."
  5. `POST /subscriptions/preview` with a syntactically-valid but nonexistent handle (e.g.
     `@this-handle-should-not-exist-zzz999xyz`) — response contains "Couldn't find a
     channel at that handle or URL."
  6. Full cycle: preview with a real handle, extract the resolved `channelId` from the
     response, `POST /subscriptions` with that `channelId`, then query the dev DB directly
     to confirm a real subscription row exists with the correct `youtube_channel_id`.
  7. Stop the dev server / clean up if started just for this check.
  (The non-YouTube-host SSRF-guard case is already covered by task 2's automated unit
  test — no live check needed for it here, per the spec's own note.)
  **User performs live in a browser** (`/channels`) — give the user this exact checklist
  and wait for them to report back before proceeding:
  1. Type a real `@handle` into the subscribe form — confirm panel populates with the
     correct channel name via an HTMX partial swap (no full page reload), and the Subscribe
     button visibly disables while the request is in flight.
  2. Same for a real legacy `/c/...` or `/user/...` URL pasted in.
  3. Type a nonexistent handle — inline error renders in the confirm panel, styled
     consistently with existing error states.
  4. Visually confirm the rewritten instructional copy above the input reads clearly.
  Once both the Claude-performed and user-performed checks pass: update
  `docs/specs/016-handle-url-subscribe.md`'s frontmatter to `status: implemented`, then
  check off this task in this file, and commit both changes together — **before** pushing,
  per `CLAUDE.md`'s branch/PR workflow (the box-check commit must ride along in the same
  push as everything else, not trail it). Then ask the user whether they're pushing the
  `spec/handle-url-subscribe` branch themselves or want Claude to; once it's on the remote
  (however it got there), open the PR (`gh pr create`) with a summary of the spec and a
  test-plan checklist (`bun test` / `bun run lint` / `bunx tsc --noEmit` / manual
  verification, all per this task), and tell the user it's ready for `main-checks`' four
  required checks and their review/merge. Do not merge it — merging is always manual.
  Done when: all three of `bun test`/`bun run lint`/`bunx tsc --noEmit` are clean; all 7
  Claude-performed checks above pass; the user has confirmed all 4 browser checks; the
  spec's frontmatter reads `status: implemented`; this task is checked off; the branch is
  pushed; and the PR is open.
