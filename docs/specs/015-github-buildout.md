---
status: draft
created: 2026-08-05
---

# GitHub Buildout (CI/CD, Release Process, OSS Framing)

## Context

Per `docs/app_idea.md`'s "Path to v1.0", steps 1–4 (styling, auth/CSRF, DB squash,
deployment/Docker packaging — specs 011–014) are all `implemented`. Step 5, "GitHub
buildout (CI, release image pushing, §6's CI/CD Pipeline)", is the last item before the
project can call itself v1.0. Today there's no `.github/` directory, no CI, no `LICENSE`,
and `README.md` is functional but minimal.

This spec originates from `docs/features/006-github-buildout.md` (`status: refined`),
which resolved scope through an extended `/new-feature` conversation plus two follow-up
in-chat rounds after the feature file was marked refined (compose-image tagging strategy,
GHCR/repo visibility sequencing, dropping `build: .` from `docker-compose.yml`). That
file's `Resolved Decisions` are taken as settled; this spec's Design section adds the
concrete mechanics — exact workflow shapes, file layout, sequencing — needed to actually
build it, the same way spec014's Design section added mechanics on top of feature file 005.

Two facts confirmed via research while writing this spec, superseding "TBD, confirm during
implementation" notes in the feature file (not a correction of a *resolved* decision, just
resolving a deferred detail):
- Dependabot has no separate `bun` ecosystem key. Bun is npm-compatible, so its support
  lives under the existing `npm_and_yarn` source — `.github/dependabot.yml` uses
  `package-ecosystem: "npm"`, which picks up `bun.lock` (text-format, Bun ≥1.1.39 — this
  repo's `bun.lock` is already the text format) automatically. Security-update PRs
  specifically aren't yet supported for Bun projects (version-update PRs are); the repo's
  Dependabot *alerts* toggle (a separate GitHub feature, not ecosystem-specific) still
  applies regardless.
  [Source](https://github.blog/changelog/2025-02-13-dependabot-version-updates-now-support-the-bun-package-manager-ga/)
- `docker/metadata-action` lowercases `${{ github.repository }}` automatically when used as
  an `images:` input. This repo is `jonrus/Tubeshelf` (capital T) — without
  `metadata-action` handling this, a naive `ghcr.io/${{ github.repository }}` would fail to
  push (Docker image names must be lowercase). Using `metadata-action` as designed (already
  planned, for the semver tag fan-out) avoids the problem entirely; no manual lowercasing
  step needed. `docker-compose.yml`'s hardcoded `ghcr.io/jonrus/tubeshelf:1` is already
  lowercase, so it matches what gets pushed.
  [Source](https://github.com/orgs/community/discussions/27086)

## Scope

**In scope** (see `docs/features/006-github-buildout.md`'s Firm Scope for the
already-settled why; this list is what/where):
- `.github/workflows/pr.yml`, `.github/workflows/release.yml`
- `.github/CODEOWNERS`, `.github/dependabot.yml`
- `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/feature_request.yml`,
  `.github/ISSUE_TEMPLATE/config.yml`, `.github/pull_request_template.md`
- `LICENSE` (root, GPLv3), `package.json`'s `"license"` field
- `docker-compose.yml` (→ `image:`-only), `docs/DEPLOYMENT.md` (intro paragraph + §6
  rewrite — see Design; the intro's current "ships as a container image built from source"
  framing goes stale the moment `docker-compose.yml` stops building from source)
- `CONTRIBUTING.md` (new, root)
- `README.md` overhaul (badges, features section, quickstart, screenshot)
- A small `docs/app_idea.md` pointer update (this spec's own cross-reference, step 5's
  skill convention)
- The manual GitHub UI actions listed in Design (branch protection, repo settings,
  Dependabot alerts, repo/package visibility) — part of this spec's deliverable even though
  Claude can't execute them directly; the task file `/spec-tasks` generates from this spec
  gives the user exact click-paths for each.
- Cutting the project's first `v1.0.0` GitHub Release.

**Explicitly out of scope:**
- Pre-release/beta channels, native (non-QEMU) ARM64 runners, everything already in
  `docs/app_idea.md`'s Future Roadmap — all per the feature file.
- A `package.json` `"version"` field. The feature file left this as a stretch item
  ("skip if it turns out to be more upkeep than it's worth"); resolved here by skipping —
  nothing in this repo consumes it (`private: true`, no npm publish), and a value that
  needs manual updating every release with no tooling enforcing it staying in sync is more
  likely to go stale than be useful. Revisit only if something starts actually reading it.
- Any code change to the app itself (routes, schema, views) — this spec is entirely
  process/tooling/docs.

## Design

### `.github/workflows/pr.yml`

Four independent jobs, all on `ubuntu-latest`:

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

Notes:
- Four separate jobs (not one job running all four commands in sequence) so they run in
  parallel and each gets its own named required-status-check entry in branch protection —
  a failure is immediately attributable to lint vs. test vs. typecheck vs. Docker without
  reading job output.
- `bun-version: "1"` matches the Dockerfile's `oven/bun:1-alpine` major version pin, so CI
  and the production image can't silently drift onto different Bun majors.
- **Trigger design, and a deliberate narrowing vs. the feature file's literal wording.**
  The feature file says `pr.yml` "runs on pull requests (and pushes to any non-`main`
  branch)"; the YAML above only triggers on `pull_request` plus `push: branches: [main]`.
  Dropped the non-`main`-branch push trigger: for a solo maintainer, `pull_request` already
  re-runs on every push to an *open* PR's branch, so the only gap is a branch pushed with
  no PR open yet — a narrow window not worth a second always-on trigger that would
  otherwise double-run checks (once via `push`, once via `pull_request`) once a PR does
  exist. Flagging as a deliberate correction rather than silently dropping it. Added
  `push: branches: [main]`, not in the feature file at all: with squash-merge or
  rebase-merge enabled (both are, per the feature file), the commit that actually lands on
  `main` has a different SHA than the one required checks ran against (GitHub validates
  against a synthetic test-merge commit, not the final squashed/rebased SHA) — without this
  trigger, `main`'s actual HEAD would never have had CI run directly against it. Also gives
  the CI-status README badge something to reflect even between PRs (the badge shows the
  default branch's latest run by default).
- `bun install --frozen-lockfile` in every job (not a bare `bun install`) mirrors the
  Dockerfile's existing choice (spec014) — fails loudly on a `bun.lock`/`package.json`
  mismatch instead of silently resolving something CI never actually tested.
- `docker-build-check` deliberately doesn't use `buildx`/QEMU or push anywhere — plain
  `docker build` on the runner's native amd64, validating only that the multi-stage
  Dockerfile still builds. Confirms Dockerfile breakage at the PR that caused it rather
  than waiting for the next (infrequent, tag-triggered) `release.yml` run to discover it.
- No dependency caching configured. `bun install --frozen-lockfile` against this repo's
  dependency set is fast enough (few seconds) on a fresh runner that a cache step's
  complexity isn't worth it yet; revisit if install time becomes a real bottleneck.

### `.github/workflows/release.yml`

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

Notes:
- Triggered by `release: published` only — matches the feature file's "tagged releases
  only, no edge/main-merge builds" decision. A release's tag (`vX.Y.Z`, created by
  publishing through the GitHub UI per Design below) is what `metadata-action` reads to
  derive the `X.Y.Z`/`X.Y`/`X` tags; `flavor: latest=true` additionally always stamps
  `latest` (acceptable since pre-release channels are out of scope — every published
  release here is a genuine "latest" candidate; revisit if pre-releases are ever added).
- `permissions: packages: write` scoped at the job level, not a repo-wide Actions
  "Workflow permissions" setting — per the feature file, avoids a manual GitHub UI step
  entirely. `docker/login-action` uses the automatically-provided `GITHUB_TOKEN`; no
  registry secret needs to be manually created.
- `docker/setup-qemu-action` + `docker/setup-buildx-action` + `platforms:
  linux/amd64,linux/arm64` is the standard free-tier-compatible multi-arch pattern — no
  Dockerfile changes needed (confirmed in the feature file's research: `oven/bun:1-alpine`
  publishes an arm64 variant, and `RUN bun install`/`RUN bun run css:build` execute under
  QEMU emulation matching the target platform automatically, pulling correct
  arch-appropriate native deps without any `TARGETPLATFORM`-conditional logic in the
  Dockerfile).
- Exact `tags:`/`flavor:` YAML syntax above is illustrative of intent; `/work-task` should
  verify the actual generated tag set against a real published pre-release-style tag
  (e.g. by inspecting `steps.meta.outputs.tags` in a run, not just trusting the snippet)
  before relying on it for the real `v1.0.0` cut.

### Repo governance

**`.github/CODEOWNERS`:**
```
* @jonrus
```
Paired with branch protection (below) requiring code-owner review.

**Branch protection on `main` — two GitHub Rulesets, not one classic branch-protection
rule** (manual GitHub UI step, `Settings → Rules → Rulesets → New ruleset`). Classic branch
protection's "Do not allow bypassing the above settings" is a single blanket toggle that
exempts a bypassing admin from *every* rule in that one protection rule at once — there's
no way to let the admin skip only the code-owner review while still being blocked by a red
required status check. **Caught during this spec's red-team pass**: the first draft used
classic protection with that checkbox left unchecked, which — read literally — would let
the sole admin merge (or push directly to `main`) with `lint`/`test`/`typecheck`/
`docker-build-check` failing, silently undermining the whole point of adding them. Rulesets
fix this because bypass is configured per-ruleset, and GitHub enforces the union of every
ruleset matching a branch — so splitting the requirements into two rulesets with different
bypass lists gets exactly the intended behavior:

- **Ruleset "main-review"** — target `main`. Require a pull request before merging;
  require approval from Code Owners. **Bypass list: the user (repo admin)** — lets the sole
  admin merge their own PRs without a second approver (GitHub also blocks self-approval of
  one's own PR regardless, so an enforced admin here would be unable to merge anything);
  anyone else's PR still needs code-owner approval.
- **Ruleset "main-checks"** — target `main`. Require status checks to pass before merging:
  `lint`, `test`, `typecheck`, `docker-build-check` (the four `pr.yml` job names above);
  require branches to be up to date before merging; block force pushes; block deletions.
  **Bypass list: empty — nobody, including the admin, bypasses this one.** A direct push to
  `main` (skipping the PR entirely) has no prior check run to point at, so this ruleset
  blocks it outright for anyone without a bypass entry; going through a PR is effectively
  the only path for everyone, admin included, and that PR's checks must be green regardless
  of who merges it.

**Plan-tier caveat, caught during this spec's second (narrower) red-team pass:**
repository Rulesets require a paid GitHub plan (Pro/Team/Enterprise) to use on a *private*
repo — they're free on any plan once the repo is public. The user confirmed they're on
GitHub Free, so ruleset creation is sequenced *after* the repo goes public (see Sequencing
below), not before — this reorders the original draft's sequence, where rulesets were
planned before the public flip.

**Repo settings** (`Settings → General → Pull Requests`):
- Enable "Allow squash merging", "Allow rebase merging", "Allow merge commits" (all three)
- Enable "Automatically delete head branches"

**`.github/dependabot.yml`:**
```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule: { interval: "weekly" }
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule: { interval: "weekly" }
```
`package-ecosystem: "npm"` (not `"bun"` — no such key exists; see Context) covers
`package.json`/`bun.lock` via Dependabot's npm-compatible `npm_and_yarn` handling.
`github-actions` covers pinned action versions in `.github/workflows/*.yml` itself — easy
to forget since it's a separate ecosystem from the app's own dependencies.

**Dependabot alerts** (manual GitHub UI step, separate from the file above — verify/enable
under `Settings → Code security → Dependabot alerts`).

**Issue/PR templates:**
- `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/feature_request.yml` —
  GitHub's YAML issue-form format (current best practice over legacy Markdown templates),
  short field sets (repro steps/expected/actual for bugs; problem/proposal for features).
- `.github/ISSUE_TEMPLATE/config.yml` with `blank_issues_enabled: true` — no need to force
  every issue through a rigid form for a repo this size.
- `.github/pull_request_template.md` — a short checklist (tests/lint/tsc run locally;
  description of what/why).

### License

- `LICENSE` (root): official GPLv3 text (verbatim from gnu.org), copyright line filled in
  as `Copyright (C) 2026 Jon Russell`.
- `package.json`: add `"license": "GPL-3.0-or-later"`.
- No per-file SPDX headers — out of scope per the feature file (low value for a
  single-maintainer project today; revisit if outside contributors become real).

### `docker-compose.yml`

```diff
 services:
   tubeshelf:
-    build: .
+    image: ghcr.io/jonrus/tubeshelf:1
     restart: unless-stopped
```
Everything else in the file (bind mount, `env_file`, `healthcheck`, `environment:`) is
unchanged from spec014. Image-only, no `build:` key — per the follow-up decision in the
feature file, the deployment-facing compose file only carries the pull-based path that
applies to nearly every reader; the from-source path moves to `CONTRIBUTING.md` (below).
Pinned to the floating major tag `:1`, not an exact version, so `docker compose pull` picks
up compatible updates automatically within v1.x — a future breaking `v2` release would only
ever affect the `:2` tag.

### `docs/DEPLOYMENT.md`

**Intro paragraph** (currently: "Tubeshelf ships as a container image built from source
(`Dockerfile`) and run via `docker-compose.yml`") — rewritten to something like "Tubeshelf
ships as a prebuilt container image published to GHCR and run via `docker-compose.yml`."
**Caught during this spec's red-team pass**: the first draft scoped this file's edit to §6
only, leaving the intro self-contradictory against the rewritten §6 two screens below it
once `docker-compose.yml` no longer builds from source at all. §1 "Quick start" doesn't
need a change — `docker compose up -d` already auto-pulls when no local image matches and
no `build:` key exists (Compose's default `pull_policy: missing`), so the existing
first-run instructions stay accurate as-is.

**§6 ("Updating")** rewritten from the current source-build instructions to:
```
git pull   # only needed to pick up doc/config changes, not the app itself
docker compose pull
docker compose up -d
```
No `docker login` step — the GHCR package is public (repo is public by the time any
release exists; see Sequencing below), so an anonymous `pull` works. `--build` is dropped
along with `docker-compose.yml`'s `build:` key.

### `CONTRIBUTING.md` (new, root)

Minimal, per the feature file:
1. Dev environment — pointer to the existing `.devcontainer` setup already documented in
   `README.md`'s Development section (not duplicated here).
2. Spec-Driven Development — pointer to `CLAUDE.md`.
3. Running checks locally — `bun test`, `bun run lint`, `bunx tsc --noEmit` (the same trio
   `pr.yml` runs).
4. Building/running from source instead of the published image:
   ```
   docker build -t ghcr.io/jonrus/tubeshelf:1 .
   docker compose up -d
   ```
   (works because `docker compose up` only builds/pulls if no local image matches the
   `image:` tag already — a locally-built image tagged to match short-circuits the pull.)
5. An explicit note: outside PRs aren't being accepted yet; forking is the recommended path
   for now.

### `README.md`

Restructured, keeping existing accurate content (devcontainer dev steps, the pointer to
`docs/DEPLOYMENT.md`) rather than replacing it:
1. Title + one-line description
2. Badges: CI status (`https://github.com/jonrus/Tubeshelf/actions/workflows/pr.yml/badge.svg`
   — GitHub's own native endpoint, renders for any viewer with repo access even before the
   repo is public, unlike a third-party service querying the API unauthenticated) and
   license (a **static** shields.io badge — hand-set label/text, not a live API call
   against the repo, so it renders correctly regardless of repo visibility). No release
   badge until `v1.0.0` exists to point at (added as this spec's last content step).
3. A short "why this exists" / features section (bulleted, pulled from
   `docs/app_idea.md`'s Core Concept + MVP feature list, not duplicating its full detail)
4. Screenshot — `.github/assets/screenshot.png` (kept out of both the repo root and
   `docs/`, which is reserved for specs/product docs by this project's own convention),
   **user-provided** (see feature file's Resolved Decisions — `claude-in-chrome` can't
   reach the devcontainer's dev server per `CLAUDE.md`'s port-forwarding gotcha, and the
   extension isn't installed regardless)
5. Existing "Development" section, unchanged
6. Existing "Deployment" section, unchanged (still points at `docs/DEPLOYMENT.md`)
7. A "License" section: one line, links to `LICENSE`

### Sequencing & manual GitHub UI actions

Ordered, since several steps depend on an earlier one existing:

1. Commit all file-based deliverables above (`LICENSE`, workflows, `CODEOWNERS`,
   `dependabot.yml`, templates, `docker-compose.yml`, `docs/DEPLOYMENT.md`,
   `CONTRIBUTING.md`, `README.md` minus the screenshot) directly to `main` — no branch
   protection exists yet to require a PR through (feature file's Resolved Decision).
2. User provides the screenshot; commit it and the README section referencing it.
3. **Manual (user, GitHub UI):** flip repo visibility to public
   (`Settings → General → Danger Zone`). Moved ahead of ruleset creation (was step 4 in an
   earlier draft) specifically because repository Rulesets require a paid GitHub plan
   (Pro/Team/Enterprise) on a *private* repo — free on any plan once the repo is public.
   The user confirmed a Free plan, so this reordering is required, not optional, for step 4
   below to even be available in the GitHub UI.
4. **Manual (user, GitHub UI):** create both `main-review` and `main-checks` rulesets, set
   the PR merge-strategy/auto-delete repo settings, verify/enable Dependabot alerts — all
   as specified above. From this point on, all further changes (to this repo, ever) go
   through a PR.
5. **Manual (user, GitHub UI):** draft and publish the `v1.0.0` GitHub Release ("Draft a
   new release", tag `v1.0.0`, "Generate release notes"). Publishing triggers
   `release.yml`.
6. **Manual (user, GitHub UI):** once `release.yml` completes, confirm/set the resulting
   GHCR package's visibility to public (linking it to the repo lets it inherit visibility
   automatically going forward).
7. Add the release badge to `README.md` now that `v1.0.0` exists; this final doc tweak
   goes through the newly-required PR flow from step 4 — the first PR the repo's new
   process actually processes.

**Steps 3 through 6 should happen close together as one sitting, not spread across
sessions.** Once step 1 lands, `docker-compose.yml` points at
`ghcr.io/jonrus/tubeshelf:1`, which doesn't exist until step 5's release workflow finishes.
Going public (step 3) starts that clock — from that point on, an outside visitor following
the README's quick start would hit a `docker compose pull` failure until step 5 finishes
(image doesn't exist yet), and then a confusing auth/403 (not a clean "not found") until
step 6 finishes on top of that, since GHCR packages pushed via `GITHUB_TOKEN` are commonly
private by default even when the parent repo is already public. Whether a package created
from a workflow run in an already-public repo inherits public visibility automatically at
creation, or still needs the manual flip regardless, isn't confirmed — treat step 6 as
required and check it immediately after step 5 completes rather than assuming it's already
handled. None of steps 3–6 need to wait on anything external, so there's no structural
reason they can't all happen in one sitting — the risk is purely about not leaving gaps
between them, not about any one step being slow.

### `docs/app_idea.md` cross-reference

Small pointer edits (this spec's own step 5, per the `/new-spec` skill convention) —
**already applied** while drafting this spec (§6 "CI/CD Pipeline: TBD" and "Path to v1.0"
step 5's line both now point at `docs/specs/015-github-buildout.md`); noted here so
`/spec-tasks` doesn't generate a redundant task expecting to still find "TBD" text.

## Open Questions

None remaining — the feature file's `/new-feature` pass, plus the two in-chat follow-up
rounds, resolved every scope-level ambiguity. This spec's own additions (Dependabot's
`npm`-not-`bun` ecosystem key, `metadata-action`'s auto-lowercasing, dropping the
`package.json` "version" stretch item, the step 4/5 sequencing-gap note, screenshot asset
location) were single-answer mechanical/research questions, not further tradeoffs
requiring the user's judgment.

**Red-team retrospective:** Two independent passes (general-purpose agents, no memory of
the drafting conversation), plus one direct question back to the user once the second pass
surfaced something only the user could answer.

*First pass* found three substantive issues, all fixed:
1. **(High)** Classic branch protection's admin-bypass checkbox is all-or-nothing — "leave
   it unchecked" as originally drafted would let the sole admin merge (or push directly)
   with failing CI, not just skip code-owner review. Fixed by switching to two GitHub
   Rulesets with independent per-ruleset bypass lists (`main-review`, admin-bypassable;
   `main-checks`, bypassable by no one) — see Design's Repo governance subsection.
2. **(Medium)** `docs/DEPLOYMENT.md`'s intro paragraph ("ships as a container image built
   from source") would go stale the moment `docker-compose.yml` drops `build: .`, but the
   spec originally scoped the doc edit to §6 only. Fixed by widening scope to include the
   intro paragraph.
3. **(Medium)** The "steps need to happen close together" sequencing warning covered the
   repo-goes-public → release-cut gap but not the equally real release-cut →
   GHCR-package-visibility gap (which fails worse — a confusing auth/403 instead of a clean
   "not found"). Fixed by extending the warning to cover both.
   Also fixed two low-severity items from the same pass: an unflagged narrowing of
   `pr.yml`'s trigger vs. the feature file's literal wording (now explicitly called out
   with reasoning), and a stale "not yet applied" framing on the `docs/app_idea.md`
   cross-reference (which was in fact already applied while drafting this spec).

*Second pass*, scoped narrowly to verifying the first pass's fixes rather than a full
re-review, confirmed three of four held up correctly and surfaced one new issue: GitHub
Rulesets require a paid plan (Pro/Team/Enterprise) to use on a *private* repo, and the
fixed Sequencing still had ruleset creation happening before the public-visibility flip.
Rather than guess at the user's plan tier, asked directly via `AskUserQuestion` — user
confirmed GitHub Free — and reordered Sequencing so the repo goes public *before* ruleset
creation (rulesets are free on any plan for public repos), which resolves it without
reopening the broken-quickstart risk the first pass's fix #3 addressed (that risk is a
function of how close together steps 3–6 happen, not of exactly which step is numbered
first).

No third pass run: the plan-tier fix was a straightforward reorder plus a direct factual
answer from the user, not a claim requiring further independent verification, and the
second pass's other three checks (ruleset composition mechanics, the full
`docs/DEPLOYMENT.md` file re-read for other stale source-build references, the
`pull_request` trigger's actual `synchronize`-event behavior) all came back clean against
real research/file reads rather than assumption.
