# Tasks: Fallow Adoption
Spec: docs/specs/026-fallow-adoption.md
Generated: 2026-08-20

Tasks 1–10 are local file changes, committed one per task. Task 11 is final
verification + flipping the spec's status. Task 12 opens the PR — checked off
*before* pushing, per `CLAUDE.md`'s convention for this one step. Task 13 is a
**manual GitHub UI step that comes after task 12's PR is open**, not before —
an intentional exception to the usual "PR is the last step" pattern, because
GitHub's required-status-check picker only lists checks that have already
reported at least once (see the spec's Design → "Branch protection: a
sequencing gotcha"). Task 14 exists because task 13's own checkbox can only be
checked *after* task 12 already pushed and opened the PR — that checkbox
commit needs to land back on the same still-open PR branch before merge, not
sit as a local commit that gets lost once `main-checks`' "automatically delete
head branches" setting removes the branch post-merge. **Do not merge the PR
until task 14 is done.** Every `bun`/`bunx` command below runs via
`devcontainer exec --docker-path podman --workspace-folder .` per `CLAUDE.md`.

- [x] 1. Add `.fallowrc.json` at the repo root with the exact contents from
      the spec's Design → `.fallowrc.json` section:
      ```json
      {
        "ignorePatterns": ["docs/features/**/*.html"],
        "ignoreDependencies": ["htmx.org"],
        "dynamicallyLoaded": ["scripts/generate-icons.ts"],
        "typeAware": { "enabled": true }
      }
      ```
      Then update `package.json`: add `"fallow": "^3.17.0"` to
      `devDependencies` (alphabetical position, between `"drizzle-kit"` and
      `"htmx.org"`), and add `"fallow": "fallow"` to `scripts` (alongside the
      existing `"lint"`/`"format"` entries). Run `bun install` to regenerate
      `bun.lock`. Do **not** run bare `fallow init` — per the spec's
      Operational note, it silently writes a generic config that would
      overwrite this hand-authored one. Done when: `.fallowrc.json` exists
      with the exact content above; `package.json` has both new entries;
      `bun.lock` reflects the new `fallow` dependency (including its
      per-platform `optionalDependencies`); `bunx fallow config` runs
      without error and its output shows `ignorePatterns`,
      `ignoreDependencies`, `dynamicallyLoaded`, and `typeAware.enabled: true`
      matching the file above (confirms the config is actually being picked
      up, not silently ignored).

- [x] 2. De-export the 7 symbols confirmed safe in the spec's Design →
      Clean-slate fix list → "De-export, not delete." Remove the `export`
      keyword only — no other change to any of these declarations or their
      call sites:
      - `src/lib/auth.ts`: `verifyPassword`, `findValidSession`,
        `getTrustedOrigins`
      - `src/lib/scheduler.ts`: `tick`
      - `src/views/queue-list.tsx`: `QueueListView`, `WatchedRow`,
        `IgnoredRow` (type exports)
      Done when: `grep -n "^export function verifyPassword\|^export function findValidSession\|^export function getTrustedOrigins" src/lib/auth.ts`,
      `grep -n "^export async function tick" src/lib/scheduler.ts`, and
      `grep -n "^export type QueueListView\|^export type WatchedRow\|^export type IgnoredRow" src/views/queue-list.tsx`
      all return nothing (confirms `export` was dropped, not the
      declaration); `bun test` and `bunx tsc --noEmit` are both clean
      (confirms nothing outside these three files was actually depending on
      the export).

- [x] 3. Extract `src/lib/watch-status.ts`'s repeated "current status"
      lookup into a private helper. All five exported functions
      (`setWatching`, `toggleQueueStatus`, `toggleWatchedFromWatchingPage`,
      `ignoreVideo`, `unignoreVideo`) currently repeat this identical block
      before their own logic:
      ```ts
      const current = db
        .select({ status: videos.status })
        .from(videos)
        .innerJoin(youtubeChannels, eq(videos.channelId, youtubeChannels.id))
        .innerJoin(
          subscriptions,
          eq(subscriptions.youtubeChannelId, youtubeChannels.id),
        )
        .where(
          and(
            eq(videos.id, videoId),
            eq(subscriptions.userId, userId),
            isNull(subscriptions.unsubscribedAt),
          ),
        )
        .get();
      if (!current) return null;
      ```
      Extract this into one private (non-exported) helper — e.g.
      `getCurrentStatus(videoId: number, userId: number)` returning the same
      shape `current` has now — and call it from all five functions in
      place of the repeated block. Behavior must be byte-identical; this is
      a pure extraction, not a logic change. Done when: this exact query
      block appears exactly once in the file; all five exported functions
      are otherwise unchanged; `bun test` (in particular
      `test/lib/watch-status.test.ts`) passes unmodified; `bunx tsc --noEmit`
      is clean; `bunx fallow dupes` no longer reports a clone group inside
      this file.

- [x] 4. Extract `src/lib/queue-urls.ts`'s repeated URL-params-building
      logic into a private helper. `buildContinueWatchingHref`,
      `buildWatchedHref`, and `buildIgnoredHref` are currently identical
      except for their base path; `buildQueueHref` is the same shape plus an
      extra `sort` param. Extract a private helper (e.g.
      `buildParams(category?: number, cursor?: { at: Date; id: number })
      : URLSearchParams`) building the shared `category`/`cursor` query
      params, and have all four functions call it (for `buildQueueHref`,
      set `sort` on the returned `URLSearchParams` before calling
      `.toString()`). Behavior must be byte-identical for every input this
      code currently handles. **No existing test file covers
      `queue-urls.ts`** (confirmed absent from the `test/lib/` directory
      listing) — after extracting, manually verify by temporarily calling
      each of the four functions with a representative set of inputs
      (no args, category only, cursor only, both) via a throwaway script run
      through `devcontainer exec` (same pattern as spec025's task 3 —
      write inside the repo so the devcontainer mount can see it, run it,
      delete it immediately after) and confirm the output URLs match what
      the pre-extraction code would have produced for the same inputs.
      Done when: the shared logic appears once; all four functions still
      produce correct URLs (verified via the throwaway script, then
      deleted); `bunx tsc --noEmit` is clean; `bunx fallow dupes` no longer
      reports a clone group inside this file.

- [x] 5. Extract `src/routes/queue.tsx`'s repeated pagination-finalization
      logic. `queueVideos`, `continueWatchingVideos`, `watchedVideos`,
      `ignoredVideos` (and any other paginated query function in this file —
      confirm by reading the full file, not just the first ~270 lines)
      each end with the same shape:
      ```ts
      const hasMore = fetched.length > PAGE_SIZE;
      const rows = hasMore ? fetched.slice(0, PAGE_SIZE) : fetched;
      const lastRow = rows.length > 0 ? rows[rows.length - 1] : undefined;
      const nextCursor =
        hasMore && lastRow && lastRow.<cursorField> !== null
          ? { at: lastRow.<cursorField>, id: lastRow.id }
          : undefined;
      return { rows, nextCursor };
      ```
      differing only in which timestamp field (`publishedAt` vs.
      `watchedAt`) drives the cursor. Extract a private generic helper
      (e.g. `finalizePage<T extends { id: number }>(fetched: T[], cursorAt:
      (row: T) => Date | null): { rows: T[]; nextCursor: { at: Date; id:
      number } | undefined }`) and call it from each function in place of
      the repeated block. Behavior must be byte-identical. Done when: the
      logic appears once as a shared helper; all affected functions are
      otherwise unchanged; `bun test` (in particular
      `test/routes/queue.test.ts`) passes unmodified; `bunx tsc --noEmit` is
      clean; `bunx fallow dupes` no longer reports this pattern as
      duplicated in this file.

- [ ] 6. Address `src/routes/categories.tsx`'s duplication. Run
      `bunx fallow dupes` first to get the current exact clone groups (the
      spec's drafting-time line numbers may have shifted) — expect to find
      the repeated "look up category by id" query (`db.select().from(categories).where(eq(categories.id, id)).get()`,
      currently duplicated across the `POST /categories/:id`, `DELETE
      /categories/:id`, and `GET /categories/:id/edit` handlers) and/or the
      repeated `c.html(<CategoriesList categories={listCategoriesWithCounts(user.id)} .../>)`
      error-response pattern. Extract whichever the fresh scan confirms are
      genuine clone groups into private helpers local to this file. Preserve
      exact existing behavior (status codes, error messages, which props
      each response passes) — this is extraction only, not a behavior
      change. Done when: `bunx fallow dupes` reports no remaining clone
      groups in this file; `bun test` (in particular
      `test/routes/categories.test.ts`) passes unmodified; `bunx tsc
      --noEmit` is clean.

- [ ] 7. Reconcile any remaining duplication against a fresh full-repo scan.
      Run `bunx fallow dupes` across the whole repo and compare against the
      spec's original 18-group/13.6% baseline. Per the spec's Design note,
      some of the original groups may have been near-identical/overlapping
      ranges reported at different granularities rather than 18 truly
      independent issues — trust this fresh scan's actual output over the
      original count. Fix any genuine remaining clone group not already
      covered by tasks 3–6 the same way (extract into a local private
      helper); if the scan comes back clean, this task is a no-op
      confirmation, not busywork to skip. Done when: `bunx fallow dupes`
      reports zero clone groups across the repo.

- [ ] 8. Address the 3 health/complexity findings from the spec's Design →
      Clean-slate fix list: `parseEntry` (`src/lib/rss.ts`), the arrow
      function in `src/routes/categories.tsx` (re-check its exact location
      after task 6's extraction — it may have moved), and `queueVideos`
      (`src/routes/queue.tsx`, re-check after task 5's extraction — the
      pagination-tail extraction may have already lowered its complexity
      enough to clear the threshold). Run `bunx fallow health` to confirm
      current findings before deciding what's left to address. For each
      still-flagged function: attempt a small simplification first; if a
      refactor wouldn't improve clarity relative to the modest CRAP scores
      involved, suppress with `// fallow-ignore-next-line complexity` plus a
      one-line comment explaining why simplification wasn't worth it. Done
      when: `bunx fallow health` reports zero above-threshold findings
      (either genuinely resolved or explicitly suppressed with reasoning);
      `bun test` and `bunx tsc --noEmit` are both clean.

- [ ] 9. Add the new `fallow` job to `.github/workflows/pr.yml`, exactly as
      specified in the spec's Design section (parallel to the existing four
      jobs):
      ```yaml
        fallow:
          runs-on: ubuntu-latest
          steps:
            - uses: actions/checkout@v7
            - uses: oven-sh/setup-bun@v2
              with: { bun-version: "1" }
            - run: bun install --frozen-lockfile
            - run: bun run fallow
      ```
      Done when: `pr.yml` has this job alongside the existing `lint`/
      `test`/`typecheck`/`docker-build-check` jobs, matching their exact
      action-version style; the file is otherwise unchanged.

- [ ] 10. Run `bun run fallow` across the whole repo (now that tasks 1–9 are
      all in place) and confirm it exits 0 with zero findings. If anything
      unexpected still shows up (a false positive tasks 1–9 didn't
      anticipate, or a finding category not yet covered), fix it the same
      way the rest of this task file has — extract/de-export/suppress with
      reasoning, or add a narrowly-scoped `.fallowrc.json` entry with the
      same kind of justification the existing four entries have — don't
      silently work around it. Done when: `bun run fallow` exits 0 with no
      `error`-severity findings anywhere in the repo.

- [ ] 11. Final verification. Run `bun test`, `bun run lint`,
      `bunx tsc --noEmit`, and `bun run fallow` — all four clean across the
      repo (per `CLAUDE.md`'s now-updated verification-quartet rule). Then
      update `docs/specs/026-fallow-adoption.md`'s frontmatter to
      `status: implemented`. Done when: all four commands are clean and the
      frontmatter is updated.

- [ ] 12. Open the PR: fill out a summary (adopting fallow for cross-file
      dead-code/duplication/complexity/CSS-drift analysis, as a new
      blocking CI check — reference the spec) and a test plan (the four
      commands from task 11, plus a one-line note on the `queue-urls.ts`
      manual verification from task 4 since that file has no automated
      test coverage). Per `CLAUDE.md`, check off this step *before*
      pushing. Confirm with the user whether they're pushing the branch
      themselves or want it pushed as part of this step, before doing
      either. **Unlike a normal final PR-opening step, this task file will
      not be fully checked off at this point** — tasks 13 and 14 below
      necessarily happen after this PR already exists (see the note at the
      top of this file) — so this is a deliberate, documented exception to
      the usual "push carries a fully checked-off task file" convention,
      not an oversight. Done when: the PR is open on GitHub with a
      filled-out description, and this checkbox is checked in the commit
      that either accompanies or precedes the push.

- [ ] 13. **Manual (user, GitHub UI) — only once task 12's PR is open and
      its `fallow` check has reported at least one run.** Add `fallow` to
      `main-checks`' required status checks:
      `Settings → Rules → Rulesets → main-checks` → under "Require status
      checks to pass," add `fallow` alongside the existing `lint`/`test`/
      `typecheck`/`docker-build-check` → Save. Give the user this exact
      click-path and wait for confirmation. Per the spec's Design →
      "Branch protection: a sequencing gotcha," this can't happen before
      the PR exists (GitHub's picker only lists checks that have already
      reported at least once), so it necessarily comes after task 12 rather
      than being folded into it. **Do not merge the PR after this step —
      task 14 still needs to land on it first.** Done when: the user
      confirms it's done, and `gh api repos/jonrus/Tubeshelf/rulesets/<id>`
      (find `<id>` via `gh api repos/jonrus/Tubeshelf/rulesets`) shows
      `fallow` present in `rules[].parameters.required_status_checks`
      alongside the existing four.

- [ ] 14. Land task 13's checkbox on the open PR. **Exact order, same
      check-off-before-pushing convention as task 12 — do the edit and
      commit first, push second:**
      1. In this task file, check off **both** box 13 and box 14 (this box)
         — one edit, before anything is pushed. (Same self-referential
         pattern as task 12 checking itself off before its own push; this
         is not a new convention, just applied a second time in this task
         file.)
      2. Commit that edit.
      3. Confirm with the user before pushing — same standing preference as
         every other push in this project.
      4. Push that commit to the **same still-open PR branch** from task 12
         (not a new branch, not a new PR).
      5. Verify afterward: the PR's "Commits" tab on GitHub shows this
         commit, and the task file as rendered on that PR branch has all 14
         boxes checked.
      This is what keeps the checked-off task 13/14 boxes from becoming a
      dangling local commit, lost once the PR merges and its branch gets
      auto-deleted (per `docs/specs/015-github-buildout.md`'s repo
      settings) — the whole reason this task exists as a separate step
      after task 13 rather than being folded into it. **Only after step 5
      above is confirmed should the user merge the PR** (Claude never
      merges — the user does this themselves once ready). Done when: steps
      1–5 above are all complete.
