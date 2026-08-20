# Tasks: Bun XML Parser Swap
Spec: docs/specs/025-bun-xml-parser-swap.md
Generated: 2026-08-20

- [x] 1. Update `package.json`'s dependency lists per the spec's Design →
      "Dependency and lockfile changes" section: remove
      `"fast-xml-parser": "^5.10.1"` from `dependencies`; in
      `devDependencies`, remove `"@types/bun": "^1.3.14"` and add
      `"bun-types": "^1.4.0"` in its place. Then run `bun install` (via
      `devcontainer exec --docker-path podman --workspace-folder . bun
      install`) to regenerate `bun.lock`. Done when: `package.json` has
      neither `fast-xml-parser` nor `@types/bun` anywhere, has
      `"bun-types": "^1.4.0"` under `devDependencies`, `bun.lock` reflects
      the same (a single `bun-types@1.4.0` entry, no `fast-xml-parser` or
      `@types/bun` entries), and `bun install` completes with no errors.

- [x] 2. Swap the parser call in `src/lib/rss.ts`: remove line 1
      (`import { XMLParser } from "fast-xml-parser";`) and change line 60
      from `const parsed = new XMLParser().parse(xml);` to
      `const parsed = Bun.XML.parse(xml);`. No other line in this file
      changes — `parseEntry()`, the array-normalization logic, and the
      `FeedEntry`/`ChannelFeed` types are untouched per the spec's Scope
      (Out of scope). Done when: `src/lib/rss.ts` has no import of
      `fast-xml-parser` anywhere in the repo (`grep -rn "fast-xml-parser"
      src/` returns nothing) and uses `Bun.XML.parse`.

- [x] 3. Manually verify against one real, live YouTube channel feed, per
      the spec's Design → "Manual verification against a real feed"
      section. This is fully Claude-performable (a live HTTP fetch from
      inside the devcontainer, no browser needed) — do not ask the user to
      do this step. Query the dev DB for a real subscribed channel's feed
      URL rather than guessing one: `devcontainer exec --docker-path podman
      --workspace-folder . sh -c "bun -e \"import { Database } from
      'bun:sqlite'; const db = new Database('./data/tubeshelf.db',
      {readonly:true}); console.log(db.query('SELECT rss_url FROM
      youtube_channels LIMIT 1').get());\""` (any row works; the dev DB
      has real subscriptions from prior manual testing, e.g. Anthropic's
      channel was present as of this task file's writing). If that query
      returns no rows (e.g. a reset DB on the other dev machine), fall back
      to any known-public channel's feed URL directly, e.g.
      `https://www.youtube.com/feeds/videos.xml?channel_id=UCK8sQmJBp8GCxrOtXWBpyEA`
      (Google's own channel — stable and unlikely to disappear). Then write a
      throwaway script at the repo root (e.g. `.tmp-rss-verify.ts`) that
      imports `fetchChannelFeed` from `./src/lib/rss` and calls it against
      that URL, logging the result; run it via `devcontainer exec
      --docker-path podman --workspace-folder . bun run
      .tmp-rss-verify.ts`; then delete the scratch file
      (`rm .tmp-rss-verify.ts`) so `git status` stays clean — same
      throwaway-script pattern used during this spec's own drafting
      session (write inside the repo so the devcontainer mount can see it,
      run via `devcontainer exec`, delete immediately after). Confirm the
      returned `ChannelFeed` has a non-empty `title`, a non-empty
      `entries` array, and each entry has a non-empty `videoId`/`title`
      and a valid `publishedAt` Date — with no exception thrown. Done
      when: this has been run successfully against a real feed with sane
      output as described, and the scratch file is deleted.

- [x] 4. Run the full verification suite via devcontainer exec — `bun
      test`, `bun run lint`, and `bunx tsc --noEmit` — confirming in
      particular that `test/lib/rss.test.ts`'s existing cases pass
      **unmodified** (per the spec's Scope, no test rewiring is expected).
      If any of the three surfaces something unexpected, fix it and re-run
      before proceeding — do not silently work around a real discrepancy
      (per the spec's Design → "Verification" section, a genuine behavioral
      gap found here should become a new test case and an Open Question
      appended to the spec, not a silent workaround). Once all three are
      clean, update `docs/specs/025-bun-xml-parser-swap.md`'s frontmatter
      to `status: implemented`. Done when: all three commands are clean
      and the frontmatter is updated.

- [x] 5. Open the PR: fill out a summary (referencing this spec — the
      fast-xml-parser → Bun.XML.parse swap, the `@types/bun` →
      `bun-types` devDependency fix, and why both are safe, per the spec's
      Design section) and a test plan (the three commands from task 4,
      plus a one-line description of the live-feed manual check from task
      3 and its result). Per CLAUDE.md, check off this step *before*
      pushing — the push should carry a task file that's already fully
      checked off. Confirm with the user whether they're pushing the
      branch themselves or want it pushed as part of this step before
      doing either. Done when: the PR is open on GitHub with a filled-out
      description, and this checkbox is checked in the commit that either
      accompanies or precedes the push.
