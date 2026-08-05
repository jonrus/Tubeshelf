<!--
Transcribed from a scoping conversation (2026-08-05), not authored fresh by the user in this
file. Everything under Firm Scope / Related Specs / Resolved Decisions reflects what was
actually agreed in that conversation — nothing here is invented scope.
-->
---
status: promoted
created: 2026-08-05
promoted_to: docs/specs/015-github-buildout.md
---

# GitHub Buildout (CI/CD, Release Process, OSS Framing)

## Problem / Motivation

`docs/app_idea.md`'s "Path to v1.0" section lists five sequenced post-MVP items; the first
four (styling, auth/CSRF, DB squash, deployment/Docker packaging) are all `implemented`.
The fifth and last — **"GitHub buildout (CI, release image pushing, §6's CI/CD Pipeline)"**
— is the only thing left before the project can call itself v1.0. Today there's no
`.github/` directory, no CI, no LICENSE, and the README is functional but minimal (no
badges, no screenshots, no "why this project exists" framing). This feature scopes that
whole buildout: CI enforcement, a real release process with a published container image,
repo governance (CODEOWNERS, branch protection, issue/PR templates, Dependabot), a license,
and OSS-appropriate README/CONTRIBUTING docs — ending in the project's first official
`v1.0.0` GitHub Release.

## Firm Scope

**CI (two workflows)**
- `pr.yml` — runs on pull requests (and pushes to any non-`main` branch): `bun test`,
  `bun run lint`, `bunx tsc --noEmit`. These become required status checks once branch
  protection is turned on. (No CI-provided secrets/env vars needed — every existing test
  file already sets its own `DB_FILE_NAME=":memory:"` / `TRUSTED_ORIGINS` inline; confirmed
  by reading `test/**/*.test.ts` and `test/helpers/auth.ts`.)
- `release.yml` — runs **only** when a GitHub Release is published (tag-triggered), not on
  every merge to `main`. Builds and pushes a multi-arch (amd64 + arm64, via
  `docker/setup-qemu-action` + `docker/setup-buildx-action` + `docker/build-push-action`)
  image to GHCR. Uses `docker/metadata-action` to fan a pushed `vX.Y.Z` tag out into
  `X.Y.Z` / `X.Y` / `X` / `latest` image tags (bun's `oven/bun:1` pattern) — pinning to the
  floating `X` tag lets `docker compose pull` pick up compatible updates within a major
  version without exposing pulls to a future breaking `v2` release.
- No merges-to-`main` build/push step — deliberately rejected in favor of tagged-release-only
  builds (see Resolved Decisions).
- `packages: write` permission scoped at the `release.yml` job level (not a repo-wide
  Actions "Workflow permissions" toggle) — avoids one manual GitHub UI step entirely.
- No `gh` CLI dependency anywhere in this feature — confirmed absent from the host
  (`command -v gh` → not found); every Claude-authored deliverable here is a plain
  git-committed file, and every registry/release action either happens through the GitHub
  UI or through the standard `GITHUB_TOKEN` inside Actions.

**Repo governance**
- `CODEOWNERS`: `* @jonrus`.
- Branch protection on `main` (manual GitHub UI step — see below): required status checks
  = `pr.yml`'s three jobs, require PR before merging, require code-owner review, require
  branches up to date before merging, block force-push to `main`, auto-delete head branches
  after merge, **admin enforcement left off** — lets the sole admin (the user) merge their
  own PRs without needing to bypass anything, while still gating anyone else's PRs on
  code-owner approval.
- Repo settings (manual GitHub UI step): enable squash / rebase / merge-commit merge
  buttons (all three), enable "Automatically delete head branches."
- `.github/dependabot.yml` covering the `bun` (or whatever ecosystem key Dependabot exposes
  for `bun.lock` — confirm during implementation) and `github-actions` ecosystems. Version
  updates activate automatically once the file lands on `main`; Dependabot **security**
  alerts are a separate toggle to verify/enable under Settings → Code security (manual UI
  step).
- Issue templates (bug report, feature request) + a PR template under `.github/`.

**License**
- GPLv3. Root `LICENSE` file + `package.json` `"license"` field + a README badge.

**README overhaul**
- Modeled on the two reference projects the user linked
  (`Trigus42/alpine-qbittorrentvpn`, `louislam/dockge`): badges (CI status, license, latest
  release), a features/why-this-exists section, quickstart pointing at
  `docs/DEPLOYMENT.md`, and a screenshot (**user-provided** — see Resolved Decisions).
  Existing accurate content (devcontainer dev instructions, pointer to
  `docs/DEPLOYMENT.md`) is kept, not replaced — new sections are added around it.

**CONTRIBUTING.md**
- A general framework doc for someone other than the user to develop the app (even just a
  fork) — dev environment (devcontainer pointer), the Spec-Driven Development pattern
  (pointer to `CLAUDE.md`), how to run tests/lint/tsc, and an explicit note that outside
  PRs aren't being accepted yet.
- A documented "build and run from source" one-liner (e.g.
  `docker build -t ghcr.io/jonrus/tubeshelf:1 . && docker compose up -d`) — this is the
  home for the from-source path now that `docker-compose.yml` itself is image-only (see
  Registry / release mechanics below).

**Registry / release mechanics**
- GHCR (`ghcr.io`). The repo goes public shortly before the first release is cut (see
  Resolved Decisions), so the GHCR package is set **public** too around the same time —
  no more private-package/GPLv3 source-availability tension to manage, and no `docker
  login` step needed in `docs/DEPLOYMENT.md` for anyone pulling the image.
- Releases are cut manually via GitHub's "Draft a new release" UI (with "Generate release
  notes"), not via `git tag` + push or `gh`. Publishing the release *is* the trigger for
  `release.yml`.
- `docker-compose.yml`'s `build: .` is replaced with `image: ghcr.io/jonrus/tubeshelf:1`
  (image-only, no `build:` key) — the deployment-facing compose file only carries the
  pull-based path that applies to essentially every user. The from-source path moves to
  `CONTRIBUTING.md` as a documented one-liner instead (see below), rather than living in
  the primary compose file.
- `docs/DEPLOYMENT.md` §6 ("Updating") gets rewritten to match — it currently says "There's
  no published registry image yet... this section will change once an image is published,"
  i.e. this rewrite is already anticipated by the current doc.
- The project's first `v1.0.0` GitHub Release, cut once this feature's own work has merged,
  is the official v1.0 milestone referenced throughout `docs/app_idea.md`'s "Path to v1.0."

**Manual GitHub UI actions (carried into the eventual task file as its own labeled
section, mirroring the Claude-performs/user-performs-live split CLAUDE.md already
documents for manual verification sections):**
- Enable branch protection on `main` with the settings listed above.
- Repo settings → Pull Requests: merge-button types + auto-delete head branches.
- Verify/enable Dependabot security alerts.
- Shortly before cutting the `v1.0.0` release: Settings → Danger Zone → flip repo
  visibility to public.
- After the first release workflow run: confirm/set the GHCR package's visibility to
  public (linking it to the repo lets it inherit the repo's visibility automatically).

## Nice-to-have / Stretch Scope

- A `package.json` `"version"` field, manually bumped to match each release tag when
  drafting a GitHub Release. Purely informational (nothing in this repo consumes it —
  `private: true`, no npm publish) — skip if it turns out to be more upkeep than it's
  worth.

## Explicitly Out of Scope

- Pre-release/beta release channels (`-rc`, `-beta` tags) — solo maintainer, first release
  is the v1.0.0 milestone itself, no need for a pre-release channel yet.
- `PUID`/`PGID`, graceful shutdown, structured logging, Bun-compiled-binary packaging — all
  already deferred in `docs/app_idea.md`'s Future Roadmap, untouched by this feature.
- Native (non-QEMU) ARM64 runners — QEMU emulation via buildx is the free-tier-friendly
  choice; native arm64 GitHub-hosted runners are a paid-tier feature.

## Related Specs / Code

- `docs/app_idea.md` §6 (Development Workflow & DevOps) — "CI/CD Pipeline: TBD", and the
  "Path to v1.0" section's step 5, which this feature implements.
- `docs/specs/014-deployment-docker-packaging.md` — the `Dockerfile`/`docker-compose.yml`/
  `docs/DEPLOYMENT.md` this feature extends rather than replaces.
- `CLAUDE.md` — "Manual verification sections in task files" convention, being mirrored
  here for GitHub-UI-only setup steps (not itself being edited by this feature).
- `Dockerfile` — multi-stage, `oven/bun:1-alpine` base (which publishes arm64 variants, so
  buildx cross-arch builds need no Dockerfile changes).
- `package.json` — existing `lint`/`test` scripts (`biome check .`, `bun test`) that
  `pr.yml` will call directly.
- `biome.json`, `tsconfig.json` — existing lint/type-check configuration, unchanged by this
  feature.

## Open Questions

(all resolved — see Resolved Decisions below)

## Resolved Decisions

- **PR-driven cutover**: this feature's own implementation lands on `main` directly (no
  branch protection exists yet to require a PR through); branch protection is turned on as
  the feature's *last* task-list step, so everything after is enforced. *Why:* no other
  ordering is possible — you can't require a PR-based workflow before the workflow files
  that would be required checks exist.
- **CI split**: `pr.yml` (fast, every PR) vs `release.yml` (slow, tag-triggered only).
  *Why:* keeps the PR feedback loop decoupled from the multi-arch image build.
- **Image builds: tagged releases only, no `edge`/main-merge builds.** *Why:* simpler CI,
  matches "a release is a deliberate, official event" — avoids an always-on, unversioned,
  untested image floating around that would also need its own README caveat.
- **Registry: GHCR, public.** *Why:* free, no extra secret (uses `GITHUB_TOKEN`). Public
  GHCR + a private repo would've created a GPLv3 corresponding-source problem (recipients
  of the image binary with no way to get the source), but the user resolved that by timing
  the repo's public flip to just before the first release, rather than keeping the package
  private — simpler deployment docs (no `docker login` step) with no compliance gap.
- **Image tagging: bun-style semver fan-out (`X.Y.Z`/`X.Y`/`X`/`latest`) via
  `docker/metadata-action`, driven by the git tag a GitHub Release creates on publish.**
  *Why:* lets a future breaking `v2` release exist without silently affecting anyone
  pinned to `v1`, mirroring `oven/bun:1`'s own pattern, which is what prompted the
  question in the first place.
- **CODEOWNERS mechanism: `* @jonrus` + branch protection requiring code-owner review, with
  admin-enforcement left off.** *Why:* GitHub blocks self-approval of one's own PR, so a
  solo admin who *is* enforced would be unable to merge anything; leaving admin enforcement
  off means the sole admin bypasses the review gate automatically while it still applies to
  anyone else, achieving "path of least resistance for me, blocks others" with zero extra
  bypass-list configuration.
  **Superseded during spec writing** — a single classic-branch-protection admin-bypass
  toggle turns out to be all-or-nothing (it would also exempt the admin from required
  status checks, not just review, undermining the CI this feature exists to add). See
  `docs/specs/015-github-buildout.md`'s Design section (Repo governance) for the corrected
  two-Ruleset mechanism, and its Sequencing subsection for a further plan-tier-driven
  reordering (GitHub Free requires the repo to be public before Rulesets are usable) found
  during that spec's own red-team pass.
- **License: GPLv3.** *Why:* this is a self-hosted app, not a library others embed into
  proprietary code, so copyleft's usual friction barely applies, and it matches the
  self-hosted/homelab space's norms more than a permissive JS-library-style license would.
- **Branch protection specifics**: required status checks, require branches up to date
  before merging (accepted the friction for correctness), no force-push to `main` (feature
  branches remain unaffected — force-push protection only ever applies to the *protected*
  branch), auto-delete head branches after merge (PR record is preserved regardless — GitHub
  never deletes PR history/diff/comments when the branch ref goes away).
- **Merge strategies: squash, rebase, and merge-commit all enabled.** *Why:* low cost to
  allow all three for a solo-maintained repo; no need to force one convention yet.
- **Multi-arch: amd64 + arm64 via QEMU/buildx, best-effort.** *Why:* "not too much of a
  lift" was the bar, and QEMU-based buildx is the standard free-tier-compatible approach;
  the user has no capacity to test ARM64 builds themselves, so the README gets an explicit
  "best-effort, not actively tested by the maintainer" note for that architecture.
- **`gh` CLI is not required anywhere in this feature.** *Why:* confirmed absent from the
  host; every deliverable here is either a git-committed file or a GitHub-UI-only action
  that was already going to be manual regardless of `gh`'s presence.
- **`docker-compose.yml`'s `image:` line pins to the floating major tag
  (`ghcr.io/jonrus/tubeshelf:1`), not an exact version.** *Why:* this is the entire reason
  the bun-style `:1` tagging pattern was chosen in the first place — `docker compose pull`
  should pick up compatible updates automatically, with a future breaking `v2` release only
  affecting the `:2` tag, never silently affecting anyone still on `:1`.
- **`docker-compose.yml` is image-only — no `build: .` key.** *Why:* initially planned to
  keep both (Compose allows `image:` and `build:` on the same service without conflict:
  `docker compose pull` always fetches from the registry, and `docker compose up -d`
  without `--build` only builds if no local image exists, so the pull-based update flow
  would have worked fine either way) — but on reflection that only served a from-source
  build path relevant to `CONTRIBUTING.md`'s forker audience, not the deployment file's
  actual audience (self-hosters who only ever pull). Moved the from-source path to a
  documented `docker build` one-liner in `CONTRIBUTING.md` instead, keeping the primary
  compose file scoped to what nearly everyone actually uses.
- **`pr.yml` includes a build-only (no push, single-arch) `docker build` validation step.**
  *Why:* cheap to run (no QEMU, no registry push) and catches a broken Dockerfile at the PR
  that caused it, rather than it silently sitting merged on `main` until the next tagged
  release — which, under the tagged-release-only build policy above, could be weeks or
  months later.
- **README screenshot: user-provided, not captured via `claude-in-chrome`.** *Why:*
  `claude-in-chrome` needs the Claude for Chrome browser extension installed and granted
  site permissions on the user's machine, which isn't set up — and even if it were, the
  dev server runs inside the podman devcontainer, which per `CLAUDE.md`'s documented
  port-forwarding gotcha isn't reachable from the host browser at all (the same reason
  `curl http://localhost:3000` from the host hangs). A live screenshot isn't achievable
  without extra plumbing this feature doesn't otherwise need, so the user captures one (or
  two) manually instead.
- **CONTRIBUTING.md stays minimal**: devcontainer setup, a pointer to `CLAUDE.md`'s
  Spec-Driven Development pattern, the test/lint/tsc commands, and an explicit "not
  accepting outside PRs yet" note — no Code of Conduct or contributor etiquette section.
  *Why:* matches what was actually asked for (a framework for forkers) without building
  process for a contribution flow that isn't open yet.
- **README badges use sources that render correctly while the repo is still private**:
  the CI-status badge uses GitHub's own native badge endpoint
  (`github.com/.../actions/workflows/pr.yml/badge.svg`, which renders for any viewer with
  repo access, unlike third-party services) rather than shields.io, and the license badge
  is a static badge (hand-set text, not a live shields.io API call against the repo) since
  shields.io's GitHub-API-backed badges can't see a private repo's contents at all. *Why:*
  caught during the "what am I missing" pass — shields.io's typical GitHub badges
  (license, latest release) call GitHub's public API unauthenticated, which returns nothing
  for a private repo, so naively copying the badge markdown from a public-repo README would
  silently render broken/blank badges until the repo goes public. A release-version badge
  is deferred until after the first `v1.0.0` release exists to point at.
