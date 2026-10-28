---
status: in-progress
created: 2026-10-28
---

# Biome 2.6 Upgrade

## Context

Dependabot opened PR #48 bumping `@biomejs/biome` from `2.5.15` to `2.6.3`. Its `lint`
check (`biome check .`) fails with 88 errors; every other required check passes. This spec
supersedes #48: the same version bump, plus the config change that makes it pass. #48 gets
closed manually once this spec's PR merges.

The failures aren't a regression in project code. Biome 2.6 formats **Markdown and YAML**
files that 2.5.x silently skipped. Reproduced locally with `bunx @biomejs/biome@2.6.3 check
. --max-diagnostics=500` against current `main`:

- Every error is a `format` diagnostic (88 on `main`; 89 once this spec file exists, since
  it is Markdown too). There are no `lint/` rule violations, so the
  `recommended` preset introduces nothing new for this codebase.
- The flagged files are every `*.md` in the repo (`CLAUDE.md`, `CONTRIBUTING.md`,
  `docs/DEPLOYMENT.md`, `docs/app_idea.md`, all of `docs/features/`, `docs/specs/` and
  `docs/specs/tasks/`, `.github/pull_request_template.md`) plus `docker-compose.yml`. The
  `.github/workflows/*.yml` and `dependabot.yml` files are already compliant.
- The first look at #48's CI log was truncated by Biome's default diagnostic limit
  ("Diagnostics not shown: 69"), which is why the list initially looked like only `docs/`
  and the compose file. `docs/specs/**` and `CLAUDE.md` are in it too.
- There is also one `info` diagnostic: `biome.json`'s `$schema` URL still pins `2.5.15`
  while the CLI is `2.6.3`. It doesn't fail the run, but `biome migrate` fixes it.

## Scope

**In:**

- Bump `@biomejs/biome` in `package.json` to `^2.6.3` and regenerate `bun.lock` via
  `bun install` in the devcontainer. **This must happen before the `biome.json` edits
  below:** the installed 2.5.15 rejects the `markdown`/`yaml` config keys with a
  configuration error, so `bun run lint` is unusable until the new version is installed.
- Point `biome.json`'s `$schema` at the installed package's schema,
  `./node_modules/@biomejs/biome/configuration_schema.json`, instead of the version-pinned
  `biomejs.dev` URL. (With 2.6.3 installed, run `biome migrate --write` and read `git diff biome.json` to
  confirm the URL bump is the only change it makes, since plain `migrate` shows no diff,
  then replace the bumped URL with the local path. Afterwards `biome migrate` should report
  no migration needed.)
- Disable the Markdown and YAML formatters in `biome.json`:

  ```json
  "markdown": { "formatter": { "enabled": false } },
  "yaml": { "formatter": { "enabled": false } },
  ```

- Final verification: `bun test`, `bun run lint`, `bunx tsc --noEmit`, `bun run fallow`
  all clean.

**Out:**

- Reformatting any Markdown or YAML file with Biome. No docs churn.
- Enabling any of 2.6's new nursery rules, or any other lint-config change.
- Changing `.github/dependabot.yml` (grouping, ignore rules).
- Closing #48, which is a manual step after merge.

## Design

**Disable the formatters rather than exclude paths.** Two approaches were tried in place
against 2.6.3, and both bring `biome check .` to zero errors:

- (A) `markdown.formatter.enabled` / `yaml.formatter.enabled` set to `false`. Still checks
  every file (178 on `main`).
- (B) Excluding paths with negations in `files.includes` (`"!**/*.md"`,
  `"!docker-compose.yml"`). Checks 89 files on `main`, because the files leave Biome's scope
  entirely.

A (disable the formatters) is chosen. It restores exactly the 2.5.x behavior (those languages weren't formatted)
without a path list that has to be kept in step with the repo. A new `*.md` or `*.yml`
added later is covered automatically. B would also need a new exclusion for any future YAML
file that doesn't happen to match what Biome wants. The cost of A is that the workflow
YAML files, which happen to be compliant today, aren't format-checked either, which is the
same as before the upgrade.

**Side effect on scripts, worth knowing:** `lint:fix` (`biome check --write .`) and
`format` (`biome format --write .`) also run over `.`. With the formatters off they leave
docs and YAML alone. Without this change, running either script after the upgrade would
have silently rewritten about 90 files.

**Why not reformat the docs with Biome (the third option, alongside A and B).** It would
produce a very noisy diff across spec history, the docs were just cleaned up in PRs #46 and
#47, and nothing about Markdown style is worth enforcing mechanically here. The decision is
to keep Biome out of Markdown and YAML, as it was before 2.6.

**Local `$schema` path instead of a versioned URL.** The URL pins a Biome version, so every
Dependabot Biome bump would raise the "configuration schema version does not match the CLI
version" `info` (the one #48 shows) until someone ran `biome migrate`. The package ships its
own schema at `node_modules/@biomejs/biome/configuration_schema.json` (confirmed present in
both 2.5.15 and 2.6.3), which always matches the installed CLI, so future bumps touch only
`package.json` and `bun.lock`. Costs, accepted: editors show an unresolved-schema warning
until `bun install` has run (the CLI doesn't use `$schema` for validation, so CI is
unaffected, and the devcontainer bind-mounts `node_modules`), and the path is less
self-documenting than a URL. The first task step must confirm `bun run lint` emits no
schema `info` with the local path.

**Version range.** `^2.6.3` matches the existing caret style (`^2.5.15`). The lockfile
hunk in Dependabot's #48 also adds `@biomejs/cli-android-*` optional packages; those come
along with a normal `bun install` and need no handling.

## Open Questions

None.

### Red-team retrospective

- **Drafting-session review (inline):** checked the claims against the reproduction run.
  Confirmed the 88 errors were all `format` diagnostics (no `lint/` rules) and that both
  candidate configs reach zero errors against 2.6.3. Corrected the Context: the initial file
  list came from truncated CI output and omitted `docs/specs/**` and `CLAUDE.md`. Added the
  `lint:fix`/`format` side effect to Design.
- **Independent pass (fresh subagent, verified by running the tooling):** confirmed the
  core claims (`format`-only diagnostics, flagged-file set, the config keys, the local
  `$schema` path producing zero errors and no info, no other Biome version pins in the
  repo). Findings, all fixed above: (1) file counts shift by one once the spec file exists,
  so the spec now says 88/89 and 178/179 contexts explicitly; (2) plain `biome migrate`
  prints no diff, so the instruction now uses `migrate --write` plus `git diff`; (3)
  ordering trap, 2.5.15 rejects the `markdown`/`yaml` keys, so the version bump and
  `bun install` must precede the `biome.json` edit (now stated in Scope); (4) the spec
  leaned on conversation history ("option 1 from the discussion", "the user chose"),
  restated in-spec; the word "exclusion" was ambiguous against option B, so it now says
  "disable" consistently. The follow-up check on these edits was a read-through, not a
  second full pass, since the changes are wording and ordering only.
