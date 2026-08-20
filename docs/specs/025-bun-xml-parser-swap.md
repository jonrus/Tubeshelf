---
status: draft
created: 2026-08-20
---

# Bun XML Parser Swap

## Context

Bun v1.4 ships a built-in SIMD XML parser/serializer (`Bun.XML.parse` /
`Bun.XML.stringify`) as a global, replacing the need for an npm XML parsing
dependency (per Bun's own v1.4 release notes,
[bun.com/blog/bun-v1.4](https://bun.com/blog/bun-v1.4) and
[bun.com/docs/runtime/xml](https://bun.com/docs/runtime/xml)).

Tubeshelf's only XML parsing need is `src/lib/rss.ts`'s `fetchChannelFeed()`,
which parses each subscribed channel's YouTube Atom RSS feed
(`docs/app_idea.md`'s Ingestion Notes / MVP item 2, refined in
`docs/specs/003-scheduled-video-ingestion.md`) using `fast-xml-parser`'s
`XMLParser`. Dropping that dependency in favor of the runtime-provided parser
removes an npm dependency with no behavior change, now that the project has
confirmed (this session) it's running Bun 1.4.0 in the devcontainer with a
clean `bun test` / `bun run lint` / `bunx tsc --noEmit` baseline.

A related question — whether Bun v1.4's `Bun.cron()` should replace the
hand-rolled `setInterval`-based scheduler in `src/lib/scheduler.ts` — was
raised and rejected during scoping for this spec: `Bun.cron()` is an
OS-level fixed-schedule trigger, not a fit for the scheduler's actual job
(polling the DB every minute for per-channel due-dates with jitter,
in-process, alongside WAL-mode-shared web request traffic — see
`docs/specs/003-scheduled-video-ingestion.md` and
`docs/specs/023-graceful-shutdown.md`). Not pursued; not part of this spec's
scope.

## Scope

**In scope:**
- Replace `fast-xml-parser`'s `XMLParser` with `Bun.XML.parse` (a global,
  no import needed) in `src/lib/rss.ts`.
- Remove `fast-xml-parser` from `package.json` dependencies and regenerate
  the lockfile.
- Replace the `@types/bun` devDependency with a direct `bun-types` one
  pinned to `^1.4.0`. Confirmed this session: `@types/bun` itself
  tops out at `1.3.14` on npm (no `1.4.x` has been published, and its
  `dist-tags.latest` is `1.3.14`) — it's `bun-types` (a separate package)
  that publishes `1.4.0`, and `@types/bun@1.3.14` only pulls in
  `bun-types@1.3.14` transitively. `tsconfig.json` doesn't even resolve
  types through `@types/bun` — it references `bun-types` directly via
  `"types": ["bun-types"]` — so `@types/bun` was doing nothing for type
  resolution to begin with. The fix is to drop `@types/bun` from
  `package.json` entirely and add `"bun-types": "^1.4.0"` as a direct
  devDependency instead. This was verified end-to-end this session: with
  that swap applied, `bun install` resolves cleanly (a single `bun-types@1.4.0`
  in the tree, no duplicate/conflicting nested copy from `@types/bun`), and
  `bunx tsc --noEmit` recognizes `Bun.XML.parse` with no errors across the
  whole repo. Without this change, `Bun.XML.parse` won't type-check.
- Verify `test/lib/rss.test.ts`'s existing cases still pass unmodified (they
  assert on `fetchChannelFeed`'s return value, not on `fast-xml-parser`
  internals, so no test rewiring is expected — see Design for why).
- Manually verify against one real, live YouTube channel RSS feed (not just
  the synthetic fixtures in the test file) that ingestion still produces
  the same video/title/description/publishedAt data as before the swap —
  see Design's CDATA/entity-decoding caveat below.

**Out of scope:**
- Any other Bun v1.4 feature adoption (image processing, markdown parsing,
  cron, HTTP range requests, etc.) — evaluated in conversation prior to this
  spec; nothing else identified a concrete win worth its own scope right
  now, and `Bun.cron()` specifically was evaluated and rejected for the
  scheduler (see Context).
- Any change to `fetchChannelFeed`'s external behavior, `parseEntry`'s
  validation logic, or the `ChannelFeed`/`FeedEntry` types — this is a
  parser substitution, not a refactor.

## Design

### The swap

`src/lib/rss.ts` currently does:

```ts
import { XMLParser } from "fast-xml-parser";
// ...
const parsed = new XMLParser().parse(xml);
```

This becomes:

```ts
const parsed = Bun.XML.parse(xml);
```

with the `fast-xml-parser` import removed. `Bun.XML` is a global (like
`Bun.file` or `Bun.serve`), so no import statement is needed once the
`bun-types` devDependency is updated (see Scope) for the ambient type to be
visible to `tsc`.

### Why this is a safe drop-in for this file specifically

`fetchChannelFeed()` calls `new XMLParser().parse(xml)` with **no options**
— fast-xml-parser's defaults. The only things read off the parsed result are
elements, never attributes: `parsed.feed.title`, `parsed.feed.entry` (or
array thereof), and per-entry `id`, `title`, `published`, and
`entry["media:group"]["media:description"]`. None of this touches XML
attributes, and none of it needs namespace resolution — `media:group` and
`media:description` are read as literal string keys already (the YouTube
feed's `xmlns:media` binding is never resolved or stripped by either
parser).

This was verified empirically this session, not just from documentation:
running `Bun.XML.parse()` inside the devcontainer against
`test/lib/rss.test.ts`'s actual `FEED_XML` fixture (two entries) and a
single-entry variant produced:

- Multi-entry: `entry` comes back as an **array** of objects, each with
  plain string values for `id`, `title`, `published`, and a nested
  `"media:group": { "media:description": "..." }` object — structurally
  identical to what `fast-xml-parser` produces for the same input, and
  exactly what `fetchChannelFeed`'s
  `Array.isArray(rawEntries) ? rawEntries : [rawEntries]` normalization and
  `parseEntry()`'s field reads already expect.
- Single-entry: `entry` comes back as a **plain object**, not a
  single-element array — same "singular vs. array" ambiguity
  `fast-xml-parser` has, which the existing normalization code already
  handles.
- Empty feed (`<feed></feed>`, no title): comes back as `{ feed: "" }`.
  `""..title` is `undefined`, so the existing `typeof title !== "string"`
  check in `fetchChannelFeed` still correctly returns `null` — no change
  needed.
- Attribute keys (e.g. `xmlns:yt`) are namespaced under an `@`-prefix (e.g.
  `"@xmlns:yt"`) in Bun's compact mode. `fast-xml-parser`'s default
  (`ignoreAttributes: true`, confirmed in its own source) **drops
  attributes entirely** rather than surfacing them under a different
  prefix — so the two parsers don't even agree on whether attributes
  appear at all. This is irrelevant to `rss.ts` either way, since nothing
  in it reads attribute keys, but it's the actual reason it's safe, not
  a prefix difference.

Because of this, **no changes to `parseEntry()`, `fetchChannelFeed()`'s
array-normalization, or the `FeedEntry`/`ChannelFeed` types are expected**
beyond the `XMLParser` → `Bun.XML.parse` call-site swap itself.

One shape difference exists but doesn't matter here: `fast-xml-parser`'s
output also carries a top-level `"?xml": ""` key (from the `<?xml ...?>`
declaration) that `Bun.XML.parse`'s output never has. `fetchChannelFeed`
only ever reads `parsed.feed`, so this is a non-issue, but it means the two
outputs aren't literally structurally identical overall — only identical in
the parts this code touches.

### CDATA and entity handling: verified, not just asserted

`media:description`/`title` text in a real YouTube feed could contain HTML
entities or a CDATA section. This was checked empirically this session, not
just inferred from docs: running both parsers side-by-side against a
synthetic fixture containing `&amp;` entities, a `<![CDATA[...]]>` section
with embedded `<b>HTML</b>` tags, and further entities *inside* the CDATA
block produced **byte-identical decoded output** from both parsers. Combined
with the array/single-entry/empty-feed checks already covered above, the
parser-output-shape side of this swap is fully verified against this
project's actual usage — no remaining behavioral unknowns on the parsing
side.

### Manual verification against a real feed (belt-and-suspenders)

The checks above cover every code path `rss.ts` exercises using synthetic
fixtures. As a final sanity check before merging, the task file for this
spec should still include pointing at one real, currently-subscribed
channel's feed URL (or any public one) and confirming the parsed
title/description text matches before vs. after the swap — not because a
specific behavioral gap is expected (none was found), but because this
feed is an unofficial, undocumented YouTube endpoint (per `docs/app_idea.md`'s
Ingestion Notes) and a live check costs little compared to the risk of a
silent ingestion regression.

### Dependency and lockfile changes

- `package.json`: remove `"fast-xml-parser": "^5.10.1"` from dependencies;
  in devDependencies, remove `"@types/bun": "^1.3.14"` and add
  `"bun-types": "^1.4.0"` (see Design above for why it's a replacement, not
  an addition).
- Run `bun install` inside the devcontainer to regenerate the lockfile
  reflecting both changes.
- No other file in the repo imports `fast-xml-parser` (confirmed via repo
  search this session — `src/lib/rss.ts` and `package.json` are the only
  two hits).

### Verification

Standard end-of-spec verification per `CLAUDE.md`: `bun test`,
`bun run lint`, and `bunx tsc --noEmit` must all be clean, plus the manual
live-feed check described above. No new automated test cases are expected
beyond what `test/lib/rss.test.ts` already covers, since this is a
same-behavior parser substitution, not a behavior change — but if the
live-feed check surfaces a real discrepancy (e.g. CDATA handling actually
does differ), that finding should be captured as a new test case and an
Open Question appended here (or the swap reconsidered) rather than silently
worked around.

## Open Questions

None. Every factual claim in this spec — the parser-output-shape
equivalence, the CDATA/entity handling, and the `@types/bun`/`bun-types`
dependency fix — was verified empirically against the actual devcontainer
and the npm registry this session, not assumed from documentation. See the
retrospective below for what each pass caught.

### Red-team retrospective

- **Pass 1 (self-review while drafting):** confirmed the parser-output-shape
  claims (array vs. single-object entries, empty-feed handling) against a
  live `Bun.XML.parse()` run rather than trusting the fetched docs summary.
  Missed two things a fresh pair of eyes caught in Pass 2: it asserted the
  `@types/bun` → `^1.4.0` bump would work without checking whether that
  version actually exists on npm, and it mischaracterized
  `fast-xml-parser`'s default attribute handling as using an `@_` prefix
  rather than dropping attributes entirely.
- **Pass 2 (independent subagent, no memory of the drafting conversation):**
  caught two must-fix issues — (1) `@types/bun@1.4.0` doesn't exist on npm
  and the spec's proposed fix was unworkable as written (`tsconfig.json`
  actually resolves types via `bun-types` directly, not `@types/bun`), and
  (2) the `fast-xml-parser` attribute-prefix claim was factually backwards.
  It also flagged two nice-to-haves: "structurally identical" overstated
  the parser parity (fast-xml-parser's stray top-level `"?xml"` key), and
  the CDATA caveat was framed as unverifiable when a synthetic test would
  have settled it.
- **Follow-up verification (this session, after Pass 2):** rather than
  taking the subagent's findings at face value, each was independently
  re-verified before editing the spec: confirmed `@types/bun`'s npm
  `dist-tags.latest` is `1.3.14` directly via `bun info`; confirmed
  `tsconfig.json`'s `"types": ["bun-types"]` resolves independently of
  `@types/bun`; live-tested the proposed fix (drop `@types/bun`, add
  `bun-types@^1.4.0` directly) end-to-end — `bun install` resolved cleanly
  with no duplicate/conflicting type package, and `bunx tsc --noEmit`
  recognized `Bun.XML.parse` with zero errors across the repo; and ran the
  CDATA/entity synthetic comparison directly, confirming byte-identical
  output between the two parsers. All scratch changes made during this
  verification were reverted before finalizing the spec (repo left clean,
  only this spec file added). No third pass was needed: the follow-up
  verification either confirmed each Pass 2 finding outright or produced a
  concrete working fix, with nothing left uncertain.
