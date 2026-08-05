# Tasks: GitHub Buildout (CI/CD, Release Process, OSS Framing)
Spec: docs/specs/015-github-buildout.md
Generated: 2026-08-05

Tasks 1–11 are local file changes, committed one per task (mirroring how spec014's task
file worked). Task 12 is the single point where these commits get pushed to `origin/main`
— flagged explicitly because this project's standing preference is "ask before every
commit, never push without being asked"; this is the one place in this spec where pushing
is genuinely unavoidable (GitHub Actions/Rulesets/Releases/GHCR all require the remote to
be populated), so get real-time confirmation before running `git push`, don't treat this
task file's existence as already having granted it. Tasks 13–16 are manual GitHub UI
actions per the spec's Sequencing subsection — Claude cannot execute these, only give exact
click-paths and verify the result afterward. Task 17 proves the whole pipeline end-to-end
via a real PR. Task 18 is final verification.

- [x] 1. Add `LICENSE` (GPLv3) and add the `"license"` field to `package.json`.
  Fetch the canonical GPLv3 text via `WebFetch` from `https://www.gnu.org/licenses/gpl-3.0.txt`,
  and save it as `LICENSE` at the repo root with this exact line prepended before the
  fetched text begins:
  ```
  Tubeshelf
  Copyright (C) 2026 Jon Russell

  ```
  In `package.json`, add `"license": "GPL-3.0-or-later",` as a new line immediately after
  `"private": true,`.
  Done when: `LICENSE` exists, starts with the prepended copyright block above, and
  contains the unmodified GPLv3 text (spot-check it includes the literal line
  `GNU GENERAL PUBLIC LICENSE` and `Version 3, 29 June 2007` near the top, and is not
  truncated — the real file is roughly 675 lines); `package.json` contains the new
  `"license"` line and `bun run lint` (via `devcontainer exec --docker-path podman
  --workspace-folder .`) passes (confirms the JSON is still well-formed).

- [x] 2. Add `.github/workflows/pr.yml`:
  ```yaml
  name: PR Checks
  on:
    pull_request:
    push:
      branches: [main]
  concurrency:
    group: pr-${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: true
  jobs:
    lint:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: oven-sh/setup-bun@v2
          with: { bun-version: "1" }
        - run: bun install --frozen-lockfile
        - run: bun run lint
    test:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: oven-sh/setup-bun@v2
          with: { bun-version: "1" }
        - run: bun install --frozen-lockfile
        - run: bun test
    typecheck:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: oven-sh/setup-bun@v2
          with: { bun-version: "1" }
        - run: bun install --frozen-lockfile
        - run: bunx tsc --noEmit
    docker-build-check:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - run: docker build -t tubeshelf:pr-check .
  ```
  Done when: the file exists at this exact path with this exact content. This workflow
  can't be meaningfully validated locally (no `gh`/`act` available per `CLAUDE.md`) — real
  validation happens in task 12 once it's pushed and actually runs.

- [x] 3. Add `.github/workflows/release.yml`:
  ```yaml
  name: Release
  on:
    release:
      types: [published]
  permissions:
    contents: read
    packages: write
  jobs:
    build-and-push:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: docker/setup-qemu-action@v3
        - uses: docker/setup-buildx-action@v3
        - uses: docker/login-action@v3
          with:
            registry: ghcr.io
            username: ${{ github.actor }}
            password: ${{ secrets.GITHUB_TOKEN }}
        - id: meta
          uses: docker/metadata-action@v5
          with:
            images: ghcr.io/${{ github.repository }}
            tags: |
              type=semver,pattern={{version}}
              type=semver,pattern={{major}}.{{minor}}
              type=semver,pattern={{major}}
            flavor: |
              latest=true
        - uses: docker/build-push-action@v6
          with:
            context: .
            platforms: linux/amd64,linux/arm64
            push: true
            tags: ${{ steps.meta.outputs.tags }}
            labels: ${{ steps.meta.outputs.labels }}
  ```
  Done when: the file exists at this exact path with this exact content. Real validation
  happens in task 15, when publishing the `v1.0.0` release actually triggers this workflow.

- [x] 4. Add `.github/CODEOWNERS`:
  ```
  * @jonrus
  ```
  Done when: the file exists at this exact path with this exact content.

- [x] 5. Add `.github/dependabot.yml`:
  ```yaml
  version: 2
  updates:
    - package-ecosystem: "npm"
      directory: "/"
      schedule:
        interval: "weekly"
    - package-ecosystem: "github-actions"
      directory: "/"
      schedule:
        interval: "weekly"
  ```
  Note: `"npm"`, not `"bun"` — Dependabot has no separate `bun` ecosystem key; Bun's
  `bun.lock` support lives under the npm-compatible `npm_and_yarn` handling (see the spec's
  Context section).
  Done when: the file exists at this exact path with this exact content.

- [x] 6. Add issue templates and a PR template.
  `.github/ISSUE_TEMPLATE/bug_report.yml`:
  ```yaml
  name: Bug report
  description: Report something that isn't working
  labels: [bug]
  body:
    - type: textarea
      id: repro
      attributes:
        label: Steps to reproduce
      validations:
        required: true
    - type: textarea
      id: expected
      attributes:
        label: Expected behavior
      validations:
        required: true
    - type: textarea
      id: actual
      attributes:
        label: Actual behavior
      validations:
        required: true
  ```
  `.github/ISSUE_TEMPLATE/feature_request.yml`:
  ```yaml
  name: Feature request
  description: Suggest an idea
  labels: [enhancement]
  body:
    - type: textarea
      id: problem
      attributes:
        label: What problem does this solve?
      validations:
        required: true
    - type: textarea
      id: proposal
      attributes:
        label: Proposed solution
      validations:
        required: false
  ```
  `.github/ISSUE_TEMPLATE/config.yml`:
  ```yaml
  blank_issues_enabled: true
  ```
  `.github/pull_request_template.md`:
  ```markdown
  ## What/why

  ## Checklist
  - [ ] `bun test` passes
  - [ ] `bun run lint` passes
  - [ ] `bunx tsc --noEmit` passes
  ```
  Done when: all four files exist at these exact paths with this exact content.

- [ ] 7. Update `docker-compose.yml`: replace `build: .` with
  `image: ghcr.io/jonrus/tubeshelf:1`. Everything else in the file is unchanged.
  ```diff
   services:
     tubeshelf:
  -    build: .
  +    image: ghcr.io/jonrus/tubeshelf:1
       restart: unless-stopped
  ```
  Done when: `docker-compose.yml` has no `build:` key anywhere and has
  `image: ghcr.io/jonrus/tubeshelf:1` in its place; `podman compose config` (or
  `podman-compose config`) still parses it without error (per spec014's task 6 precedent
  for validating this file).

- [ ] 8. Update `docs/DEPLOYMENT.md`'s intro paragraph and §6 ("Updating").
  Replace the current intro's first sentence:
  ```
  Tubeshelf ships as a container image built from source (`Dockerfile`) and run via
  `docker-compose.yml`.
  ```
  with:
  ```
  Tubeshelf ships as a prebuilt container image published to GHCR and run via
  `docker-compose.yml`.
  ```
  (Leave the rest of that paragraph — the `docker compose`/`podman compose` substitution
  note — unchanged.)
  Replace all of §6 ("Updating") with:
  ```markdown
  ## 6. Updating

  ```
  git pull   # only needed to pick up doc/config changes, not the app itself
  docker compose pull
  docker compose up -d
  ```

  `docker compose pull` fetches the latest image matching `docker-compose.yml`'s
  `image: ghcr.io/jonrus/tubeshelf:1` tag — since that's the floating major-version tag,
  this picks up every compatible release without needing to edit the compose file. No
  `docker login` step is needed: the GHCR package is public.
  ```
  Done when: both edits are present exactly as above, and `bun run lint` (via
  `devcontainer exec`) still passes (Biome doesn't lint Markdown, but confirms nothing else
  broke).

- [ ] 9. Add `CONTRIBUTING.md` (new, repo root):
  ```markdown
  # Contributing

  Tubeshelf isn't accepting outside pull requests yet — this file exists so a fork is
  workable in the meantime, not as an open invitation to PR.

  ## Dev environment

  See `README.md`'s Development section for the devcontainer setup.

  ## Development pattern

  This project uses Spec-Driven Development — see `CLAUDE.md` at the repo root.

  ## Running checks locally

  ```
  bun test
  bun run lint
  bunx tsc --noEmit
  ```
  (Run these inside the devcontainer — see `README.md`'s Development section.)

  ## Building and running from source

  Instead of the published `ghcr.io/jonrus/tubeshelf` image:
  ```
  docker build -t ghcr.io/jonrus/tubeshelf:1 .
  docker compose up -d
  ```
  `docker compose up` only builds or pulls when no local image already matches
  `docker-compose.yml`'s `image:` tag — a locally-built image tagged to match
  short-circuits the pull, so this works with no other changes to `docker-compose.yml`.
  ```
  Done when: `CONTRIBUTING.md` exists at the repo root with this content.

- [ ] 10. Rewrite `README.md`'s top section (badges, features, license) while leaving the
  existing "Development" and "Deployment" sections' content untouched. Do **not** add a
  screenshot reference yet (task 11 handles that once the image file exists — a broken
  image link would fail this task's own review). New content, replacing everything from the
  top of the file through the current one-line `docs/app_idea.md` pointer:
  ```markdown
  # Tubeshelf

  [![CI](https://github.com/jonrus/Tubeshelf/actions/workflows/pr.yml/badge.svg)](https://github.com/jonrus/Tubeshelf/actions/workflows/pr.yml)
  ![License: GPLv3](https://img.shields.io/badge/License-GPLv3-blue.svg)

  A self-hosted YouTube subscription tracker — a queue-based alternative to the YouTube
  Subscriptions page, with per-channel categories, unwatched/watching/watched status
  tracking, and keyword-based noise filtering. Videos are still watched on youtube.com
  itself (not embedded), so ad-blocking and SponsorBlock in your own browser keep working
  normally.

  See `docs/app_idea.md` for the full product spec.

  ## Features

  - Subscribe to YouTube channels via RSS — no YouTube Data API key required
  - Organize channels into free-text categories
  - Unwatched / Watching / Watched tracking, with a dedicated Watching page
  - Keyword-based Ignore rules to auto-filter noise (e.g. Shorts)
  - Category-filtered Queue, Continue Watching, Watched, and Ignored views
  ```
  Keep everything from `## Development` onward exactly as it currently is. Add a new
  `## License` section at the very end of the file:
  ```markdown
  ## License

  GPLv3 — see [LICENSE](LICENSE).
  ```
  Done when: `README.md` matches this structure (badges/description/features up top,
  unchanged Development/Deployment sections, new License section at the end), and
  `bun run lint` (via `devcontainer exec`) passes.

- [ ] 11. Add the README screenshot (user-provided — see the spec's Design section:
  `claude-in-chrome` can't reach the devcontainer's dev server per `CLAUDE.md`'s
  port-forwarding gotcha, and the extension isn't installed regardless). Ask the user for
  one or two screenshots of the running app; save the chosen one as
  `.github/assets/screenshot.png`. Insert this line into `README.md` between the
  `## Features` list and the `## Development` heading added/kept in task 10:
  ```markdown
  ![Tubeshelf screenshot](.github/assets/screenshot.png)
  ```
  Done when: `.github/assets/screenshot.png` exists (non-empty, a real image file — verify
  with `file .github/assets/screenshot.png` reporting a PNG/JPEG type, not e.g. `ASCII
  text`), and `README.md` references it at the position above.

- [ ] 12. Push tasks 1–11's commits to `origin/main`. **Get explicit confirmation from the
  user before running `git push`** — this project's standing preference is to never push
  without being asked, and this task file existing is not that confirmation; ask in this
  session, in the moment. Once confirmed:
  ```
  git push origin main
  ```
  Done when: the user has explicitly confirmed the push in this session, `git push`
  succeeded, and `git fetch && git log origin/main -1` shows task 11's commit as
  `origin/main`'s HEAD.

- [ ] 13. **Manual (user, GitHub UI).** Flip the repo's visibility to public:
  `https://github.com/jonrus/Tubeshelf/settings` → General → scroll to "Danger Zone" →
  "Change repository visibility" → "Change to public" → type the repository name to
  confirm. Tell the user exactly this click-path and wait for them to report it done.
  Done when: `WebFetch` on `https://github.com/jonrus/Tubeshelf` succeeds and shows real
  repo content (not a login/404 wall) — confirms it's genuinely public, not just
  self-reported.

- [ ] 14. **Manual (user, GitHub UI).** Set up the two rulesets and remaining repo
  settings — give the user this exact checklist and wait for confirmation:
  1. `Settings → Rules → Rulesets → New ruleset → New branch ruleset`:
     - Ruleset name: `main-review`
     - Enforcement status: Active
     - Target branches: Include default branch
     - Bypass list: add yourself (Jon Russell / `jonrus`), bypass mode "Always"
     - Rules: check "Require a pull request before merging" → set required approvals to
       `1` → check "Require review from Code Owners"
     - Save
  2. `New ruleset` again:
     - Ruleset name: `main-checks`
     - Enforcement status: Active
     - Target branches: Include default branch
     - Bypass list: leave empty (nobody, including you, bypasses this one)
     - Rules: check "Require status checks to pass" → add `lint`, `test`, `typecheck`,
       `docker-build-check` (these only appear in the picker once `pr.yml` has reported at
       least one run — task 12's push already triggered that via its `push: branches:
       [main]` trigger, so they should be selectable) → also check "Require branches to be
       up to date before merging" → check "Block force pushes" → check "Restrict
       deletions"
     - Save
  3. `Settings → General → Pull Requests`: enable "Allow squash merging", "Allow rebase
     merging", "Allow merge commits" (all three); enable "Automatically delete head
     branches"
  4. `Settings → Code security`: verify/enable "Dependabot alerts"
  Done when: `WebFetch` on `https://github.com/jonrus/Tubeshelf/actions/workflows/pr.yml/badge.svg`
  returns SVG content containing "passing" (confirms task 12's push-triggered run
  succeeded, which is also what makes the required-checks picker in step 2 above
  populated), and the user confirms all four settings groups above are in place.

- [ ] 15. **Manual (user, GitHub UI).** Cut the `v1.0.0` release:
  `https://github.com/jonrus/Tubeshelf/releases/new` → "Choose a tag" → type `v1.0.0` →
  "Create new tag: v1.0.0 on publish" → Release title: `v1.0.0` → click "Generate release
  notes" → "Publish release". Give the user this exact click-path and wait for
  confirmation.
  Done when: `WebFetch` on `https://github.com/jonrus/Tubeshelf/releases/tag/v1.0.0`
  confirms the release exists, and `WebFetch` on
  `https://github.com/jonrus/Tubeshelf/actions/workflows/release.yml/badge.svg` returns SVG
  content containing "passing" (confirms `release.yml`'s multi-arch build+push completed
  successfully — this can take several minutes due to QEMU-emulated arm64; wait and re-check
  rather than reporting failure prematurely).

- [ ] 16. **Manual (user, GitHub UI).** Confirm/set the GHCR package's visibility to
  public: `https://github.com/jonrus?tab=packages` → `tubeshelf` package → "Package
  settings" → "Danger Zone" → "Change visibility" → Public (if not already) → also use
  "Connect Repository" to link it to `jonrus/Tubeshelf`, if not already linked. Give the
  user this exact click-path and wait for confirmation.
  Done when: `WebFetch` on `https://github.com/jonrus/Tubeshelf/pkgs/container/tubeshelf`
  succeeds without requiring login and lists tags including `1`, `1.0`, `1.0.0`, and
  `latest`.

- [ ] 17. Add the release badge to `README.md`, via a real PR — the first PR the repo's new
  process actually handles, proving the whole pipeline end-to-end.
  1. `git checkout -b docs/release-badge`
  2. In `README.md`, add this badge to the badge line added in task 10 (after the license
     badge):
     ```markdown
     [![Release](https://img.shields.io/github/v/release/jonrus/Tubeshelf)](https://github.com/jonrus/Tubeshelf/releases/latest)
     ```
  3. Commit, then **get explicit confirmation before pushing** (same standing-preference
     note as task 12): `git push -u origin docs/release-badge`
  4. Tell the user to open the PR via the "Compare & pull request" prompt GitHub shows
     after the branch push (`https://github.com/jonrus/Tubeshelf/pull/new/docs/release-badge`),
     wait for `main-checks`' four required checks to go green, then merge it themselves
     (they're on `main-review`'s bypass list, so no second approver is needed) using
     whichever merge-strategy button they prefer.
  Done when: the user confirms the PR is merged, `git fetch && git log origin/main -1`
  shows the merge, and `WebFetch` on the live `README.md` on GitHub shows the release badge
  rendering (confirms `img.shields.io/github/v/release/...` resolved against the now-public
  repo and `v1.0.0` release).

- [ ] 18. Final verification. Run `bun test`, `bun run lint`, and `bunx tsc --noEmit` clean
  across the repo (all via `devcontainer exec --docker-path podman --workspace-folder .`,
  against `main` after task 17's merge — `git pull` first). Then:
  - **Claude performs directly** (plain host-shell `podman`, mirroring spec014's
    established pattern of running the *production* container directly on the host, not
    via `devcontainer exec`):
    - `podman pull ghcr.io/jonrus/tubeshelf:1` — confirms the real published multi-arch
      manifest is pullable anonymously (package is public per task 16) and podman selects
      the host's own architecture from it without error.
    - Run it against a fresh, chowned bind-mounted data dir (same pattern as spec014's task
      5/10) and `curl http://localhost:<port>/healthz`, expecting `200`/`ok` — confirms the
      *published* image (not just a local build) actually boots and serves traffic.
    - Clean up: stop/remove the verification container and any temp directories created.
    - `WebFetch` each of: the repo's public page, the `v1.0.0` release page, the GHCR
      package page, and both workflow badge SVGs (`pr.yml`, `release.yml`) one more time,
      confirming everything from tasks 13–17 is still in the expected state together (not
      just individually, at the moment each task finished).
  - **User performs live in a browser**: not applicable — every check for this spec is
    infra/process/doc-level and verifiable directly via `podman`/`curl`/`WebFetch`, same as
    spec014.
  - Done when: `bun test`, `bun run lint`, and `bunx tsc --noEmit` are all clean; the
    `podman pull`/run/`curl` check above passes against the real published image; all four
    `WebFetch` checks above confirm the expected live GitHub/GHCR state; and
    `docs/specs/015-github-buildout.md`'s frontmatter is updated to `status: implemented`.
