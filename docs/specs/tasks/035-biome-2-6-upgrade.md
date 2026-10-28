# Tasks: Biome 2.6 Upgrade
Spec: docs/specs/035-biome-2-6-upgrade.md
Generated: 2026-10-28

All commands run via `devcontainer exec` (see CLAUDE.md). Order matters: the installed
Biome 2.5.15 rejects the `markdown`/`yaml` config keys, so the version bump comes first.

- [x] 1. Bump Biome — in `package.json` change `@biomejs/biome` from `^2.5.15` to `^2.6.3`,
  then run `bun install` in the devcontainer to regenerate `bun.lock` (the added
  `@biomejs/cli-android-*` optional packages are expected). — done when: `bunx biome --version`
  prints `2.6.3` and `git diff --stat` shows only `package.json` and `bun.lock` changed.

- [x] 2. Point `$schema` at the local package schema — run `bunx biome migrate --write`, read
  `git diff biome.json` and confirm the `$schema` URL bump is the only change it makes (stop
  and report if not). Then replace the `$schema` value in `biome.json` with
  `./node_modules/@biomejs/biome/configuration_schema.json`. — done when: `bunx biome migrate`
  reports no migration needed and `bun run lint` emits no schema-version `info` diagnostic
  (format errors on `*.md`/`docker-compose.yml` are still expected until step 3).

- [ ] 3. Disable the Markdown and YAML formatters — in `biome.json`, add after the `css`
  block (or alongside the other language blocks):
  `"markdown": { "formatter": { "enabled": false } },` and
  `"yaml": { "formatter": { "enabled": false } },`. Do not reformat any Markdown/YAML file
  and do not change any other lint/format config. — done when: `bun run lint` exits 0 with
  zero errors and no `info` diagnostics, and `git status` shows no `*.md`/`*.yml` files
  modified.

- [ ] 4. Check the `lint:fix`/`format` side effect — run `bunx biome format .` (no `--write`)
  and `bunx biome check .`; confirm neither reports any `.md` or `.yml` file. — done when:
  both exit 0 and `git status --short` shows only `package.json`, `bun.lock`, `biome.json`
  (and this task file).

- [ ] 5. [push] Final verification, flip spec to implemented, open the PR — run `bun test`,
  `bun run lint`, `bunx tsc --noEmit`, and `bun run fallow` clean across the repo; set
  `docs/specs/035-biome-2-6-upgrade.md` frontmatter to `status: implemented`. Draft the PR
  (summary + test plan; note it supersedes Dependabot PR #48, which the user closes manually
  after merge; end with the Claude Code attribution line) per CLAUDE.md's git workflow: check
  this step's box *before* pushing, commit, then ask whether the user is pushing or Claude
  should; never merge. — done when: all four commands are green, spec is `implemented`, this
  file is fully checked, and the PR is open (or the user has been handed the push/PR command).
