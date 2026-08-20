---
status: implemented
created: 2026-08-20
---

# Fallow Adoption

## Context

Tubeshelf's `pr.yml` currently runs four checks (`lint`, `test`, `typecheck`,
`docker-build-check`), none of which catch cross-file dead code (an exported
symbol nothing imports anymore, a `package.json` dependency that survived a
refactor, a circular import) or duplication. Biome's `recommended` preset
catches *unused local variables/imports within a single file*, but has no
whole-project reachability analysis. As a solo developer with no second
reviewer to catch this kind of drift in review, that gap has a real chance of
going unnoticed — e.g. it wasn't confirmed whether
`docs/specs/025-bun-xml-parser-swap.md`'s `fast-xml-parser` removal left
anything else behind (it didn't, but nothing would have caught it if it had).

[fallow](https://fallow.tools) (`fallow-rs/fallow` on GitHub, MIT-licensed,
~4.3k stars) is a Rust-implemented static analysis CLI for TypeScript/
JavaScript covering exactly this gap: dead code, duplication, complexity/
health metrics, type-aware analysis, and CSS/design-system-drift checks — all
free/local, no account or API key. Its only paid feature is a separate
product ("Fallow Runtime," production runtime-coverage collection), which is
not part of this spec.

This spec was scoped through an extended conversation (no feature file used)
that included running the tool for real against this repo — not just reading
its docs — before committing to adoption. That distinction matters: an
earlier pass through this conversation drafted a `.fallowrc.json` purely from
AI-summarized doc fetches, and a later ground-truth check against the
installed CLI's own `config-schema`/`config`/`list` output (see Design)
found that draft had several wrong rule names (e.g. `unused-devDependencies`
vs. the real `unused-dev-dependencies`, `boundary-violations` vs. the real
singular `boundary-violation`) and unfounded assumptions (downgrading
`unused-class-members`/`unused-enum-members` over a Drizzle-schema
false-positive risk that doesn't apply — the codebase has zero `class`/`enum`
declarations, confirmed by grep). The config in this spec's Design section
reflects the corrected, tool-verified version, not the original draft.

## Scope

**In scope:**
- `fallow` as a `devDependency` in `package.json`, invoked via a
  `bun run fallow` script — not the official `fallow-rs/fallow` GitHub
  Action. The Action's PR-comment/inline-review features require
  `pull-requests: write`, `checks: write`, `id-token: write` — a
  meaningfully bigger trust footprint for a third-party dependency than
  anything currently in this repo's CI (which only uses `actions/checkout`
  and `oven-sh/setup-bun`, `permissions: contents: read`). Running the CLI
  directly, the same pattern as the existing `lint`/`test`/`typecheck` jobs,
  avoids granting any of that.
- A new `fallow` job in `.github/workflows/pr.yml`, parallel to and
  independent from `lint` — different concern (architecture/dead-code vs.
  formatting), different failure semantics, keeps PR-checks UI signals
  separable, matches the existing one-job-per-concern pattern.
- Adding `fallow` to the `main-checks` GitHub Ruleset's required status
  checks (`docs/specs/015-github-buildout.md`), so it blocks merges like the
  existing four. The user is the sole developer/PR author on this repo, so
  there's no risk of blocking a teammate — going straight to blocking (no
  advisory/soft-rollout period) is a deliberate choice, not an oversight.
- `.fallowrc.json` at the repo root (see Design for exact contents).
- Fixing every finding a real `bunx fallow` run currently produces against
  this repo (see Design's Clean-slate fix list) — no `--save-baseline`
  suppression file. CI starts at zero findings, not a baseline of "known
  issues we're ignoring for now."
- A small pointer edit in `docs/app_idea.md`'s "CI/CD Pipeline" line (already
  applied — see Design's final subsection).
- Updating `CLAUDE.md`'s standing verification-trio rule to a quartet
  including `bun run fallow` (already applied — see Design's "Updating
  `CLAUDE.md`'s verification rule" subsection) — so every spec from this one
  forward catches a `fallow` failure locally before push, not only after CI
  runs `main-checks`.

**Explicitly out of scope:**
- **Fallow Runtime** (paid production runtime-coverage collection) — a
  separate product from the free static-analysis CLI this spec adopts.
- **`fallow security` and `fallow flags`** — separate opt-in subcommands
  (confirmed via `fallow --help`: listed under "Analysis" alongside
  `dead-code`/`dupes`/`health`, but every rule they'd gate is `off` by
  default in the schema, and their own framing is "surface local security
  candidates for agent verification" — i.e. advisory/human-review output,
  not a pass/fail gate). Not part of "adopt fallow for dead-code,
  duplication, complexity/health, and CSS/boundary-drift analysis" as
  originally scoped; revisit as a separate spec if wanted later.
- The opt-in rules that ship `off` by default (`private-type-leaks`,
  `prop-drilling`, `thin-wrapper`, `duplicate-prop-shape`, `coverage-gaps`,
  `feature-flags`, `require-suppression-reason`) — left at their defaults,
  no reason surfaced to turn any on for this project yet.
- Framework-specific rules with no possible signal against this stack
  (Vue/Angular store & inject rules, Svelte event rules, Next.js/SvelteKit
  server-action and route-collision rules) — Tubeshelf is Hono + server-
  rendered JSX with programmatic (not file-based) routing, so these
  structurally can't fire regardless of severity; left at tool defaults
  rather than spending config surface silencing things that already do
  nothing.
- Redesigning `watch-status.ts`/`queue.tsx`/etc.'s actual logic beyond what's
  needed to remove the confirmed duplication — this is a cleanup pass driven
  by real tool findings, not a broader refactor.

## Design

### Ground-truthing the config against the real CLI, not just docs

Everything below was verified by actually running `bunx fallow` (and its
`config-schema`/`config`/`list`/`--help` subcommands) inside the devcontainer
against this repo, not inferred from documentation alone:

- **Active plugins** (`fallow list`): `biome`, `typescript`, `tailwind`,
  `drizzle`, `bun`. The `bun` plugin auto-detects all 20 files under
  `test/**/*.test.ts` as entry points (reason: `(bun)`) — despite `test/`
  living at the repo root rather than colocated under `src/`, no explicit
  `entry`/`ignorePatterns` config is needed for test discovery.
- **Real default `.fallowrc.json` rule severities** (`fallow config-schema` /
  `fallow config`, no config file present yet): 53 rules total, most
  defaulting to `error`; dev/optional-dependency, component-framework, and
  CSS rules default to `warn`; a handful of opt-in rules default to `off`
  (see Scope's "Explicitly out of scope" above for which). The full default
  set is reasonable as-is for this project — the deviations below are the
  only ones with a specific reason to diverge.
- **`unused-class-members` / `unused-enum-members`** (both default `error`):
  an earlier draft of this spec downgraded these to `warn` over a
  hypothesized Drizzle-schema false-positive risk. Checked directly —
  `grep -rn "^\s*enum \|class " src/` returns nothing; Drizzle's
  `sqliteTable()` is a factory-function call, not a `class`. Zero `class`/
  `enum` declarations exist anywhere in `src/`, so both rules are
  structural no-ops regardless of severity. Left at the tool default
  (`error`) rather than a downgrade with no basis.
- **CSS rules** (`css-token-drift`, `css-duplicate-block`,
  `css-selector-complexity`, `css-dead-surface`, `css-broken-reference`, all
  default `warn`): a real `bunx fallow` run produced zero CSS findings and no
  CSS output section at all. Confirmed why — the `tailwind` plugin is active
  and `src/styles/input.css` (28 lines; roughly half `@tailwind`/`@theme`
  directives, the rest a small hand-written `#sidebar` scrollbar rule) is
  in scope, there's just nothing in a file that small for these rules to
  flag. Left at tool defaults; there's no real signal yet to justify
  upgrading any of them, and revisiting this later (if the custom CSS
  surface grows) is cheap.
- **`boundary-violation`** (default `error`): inert with the current empty
  `boundaries.zones` config (confirmed via `fallow config`'s resolved
  output). No zone modeling is in scope for a project this size (per this
  conversation's earlier scoping) — left at the tool default rather than an
  explicit `"off"`, since either way it never fires without zones defined.

### `.fallowrc.json`

```json
{
  "ignorePatterns": ["docs/features/**/*.html"],
  "ignoreDependencies": ["htmx.org"],
  "dynamicallyLoaded": ["scripts/generate-icons.ts"],
  "typeAware": { "enabled": true }
}
```

Everything not listed here uses fallow's own default (see above) —
deliberately minimal rather than re-declaring 53 rules' worth of defaults
that already fit. Each key exists because a real scan against this repo
produced a specific false positive, confirmed via `fallow list`'s
entry-point/file-discovery output (see Clean-slate fix list below for the
findings each one addresses):
- `ignorePatterns`: `docs/features/002-UI_wireframe.html` is a design
  mockup, not app code — it was in fallow's 64-file discovery list and
  produced an `unresolved-imports` finding on a `./support.js` reference
  that doesn't exist as real app wiring. `biome.json` already excludes
  `docs/features/**/*.html` for the identical reason.
- `ignoreDependencies`: `htmx.org` is consumed via the `postinstall` script's
  `cp node_modules/htmx.org/dist/htmx.min.js public/js/htmx.min.js`, never
  an ES import — fallow's dependency graph can't trace a shell copy, so it
  flags the devDependency as unused. Removing the package would break the
  build; this suppresses the false positive without touching the real
  postinstall mechanism.
- `dynamicallyLoaded`: `scripts/generate-icons.ts` doesn't appear in
  `fallow list`'s 26 auto-detected entry points — it's a manually-invoked
  script (`bun scripts/generate-icons.ts`), not wired into any npm script or
  import chain, so fallow correctly can't find a path to it on its own. This
  tells it the file is intentionally reachable-by-hand, not dead.
- `typeAware.enabled: true`: defaults to `false` purely for speed (per
  `fallow --help`); at 64 files that tradeoff doesn't matter. **Caveat
  confirmed during this spec's red-team pass:** enabling it doesn't actually
  change the `unused-exports`/`unused-types` counts on this specific repo
  (checked directly — identical either way), so the "reduces false
  positives" rationale isn't demonstrated by this project's own data, just
  general tool behavior. It does surface a new "Private type leaks" finding
  category (12 instances on this repo) that's silent with `typeAware`
  disabled — this is purely informational, since `private-type-leaks` stays
  at its default `off` severity and doesn't affect `bun run fallow`'s exit
  code, but expect that new output section to appear once this is turned on
  and don't mistake it for a regression.

**Operational note for whoever implements this:** bare `fallow init` has no
non-interactive/`--yes` flag (per `fallow init --help` — only `--toml`,
`--agents`, `--hooks`, and `--decline`, none of which produce a config file
on their own). **Confirmed during this spec's red-team pass:** it does not
hang under `devcontainer exec`'s no-TTY condition the way `drizzle-kit
generate` does (that gotcha, from `CLAUDE.md`, doesn't apply here) — instead
it exits 0 immediately and silently writes a generic, untailored config
(guessed entry points, no project-specific overrides). Don't run bare
`fallow init` expecting it to produce anything useful, and definitely don't
let it overwrite the hand-authored file above — hand-author
`.fallowrc.json` with the exact contents above instead, and verify it with
`bunx fallow config`, which prints the fully resolved config including your
file's overrides merged over the defaults.

### `package.json`

Add to `devDependencies`: `"fallow": "^3.17.0"` (latest published version,
confirmed via the npm registry — ships with per-platform
`optionalDependencies`, the same pattern `@biomejs/biome` already uses, and
is published via GitHub Actions OIDC trusted-publisher provenance).

Add to `scripts`: `"fallow": "fallow"` — same pattern as the existing
`"lint": "biome check ."` entry, calling the installed devDependency's bin
directly.

### `.github/workflows/pr.yml`

New job, added alongside the existing four (matching their exact shape —
`actions/checkout@v7`, `oven-sh/setup-bun@v2` with `bun-version: "1"`,
`bun install --frozen-lockfile`):

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

Deliberately **not** using the `--ci` flag (`--format sarif --fail-on-issues
--quiet`, per `fallow --help`). SARIF's entire value is a consumer that
renders it — typically `github/codeql-action/upload-sarif` into the repo's
Security tab — which is out of scope here (no reason surfaced to want
dead-code/duplication findings in the Security tab, and adding that action
would need its own `security-events: write` permission, the same kind of
elevated-trust footprint this spec already avoided by skipping the official
fallow Action). Without a consumer, `--ci`'s SARIF output would just dump
illegible JSON into the CI log instead of the tool's normal human-readable
report. Plain `bun run fallow` already exits non-zero on any `error`-severity
finding (confirmed via `fallow --help`'s rule-severity description and this
session's real run's own `✗ ... Failed:` exit behavior) — no extra flag
needed for the job to fail correctly.

### Branch protection: a sequencing gotcha

`main-checks` (per `docs/specs/015-github-buildout.md`) already exists with
an empty bypass list and is live against every PR right now, including this
spec's own. GitHub's ruleset UI for "require status checks" only lists check
names that have actually reported at least once for the repo recently — a
brand-new `fallow` job can't be added to the required list *before* it's
run. That forces a specific order, different from spec015's original setup
(which configured rulesets before any PR had run, since branch protection
didn't exist yet at that point):

1. Land this spec's `pr.yml` change (the new `fallow` job) and all the
   clean-slate code/config fixes below on this spec's branch, and open the
   PR. The `fallow` job runs on the PR — not yet required, so it can't block
   merge yet, but its check name is now visible to GitHub.
2. Once it's green (all clean-slate fixes applied, confirmed by this job
   passing on the PR), **manual (user, GitHub UI):** add `fallow` to
   `main-checks`' required status checks list
   (`Settings → Rules → Rulesets → main-checks`), alongside the existing
   `lint`/`test`/`typecheck`/`docker-build-check`.
3. Because `main-checks` has no bypass list, this takes effect immediately
   against the still-open PR too — but since step 1 already made the job
   green, there's nothing left to block. Merge proceeds normally.

Doing step 2 before step 1's PR is green would make `fallow` required while
still failing, blocking the very PR meant to introduce it, with no bypass
available to anyone to unstick it (same class of problem
`docs/specs/015-github-buildout.md`'s Design section already had to reason
through for its own four checks, before any ruleset existed yet to create
the gotcha in the first place).

### Clean-slate fix list

Grounded in a real `bunx fallow` run against this repo (64 files, 10,299
LOC, no config file — i.e. all default severities) performed during this
spec's scoping conversation, plus follow-up investigation into which
findings are genuine vs. config gaps:

**De-export, not delete (7 items, all individually confirmed by grepping the
whole repo including `test/` — each symbol is called only from within its
own file, never imported anywhere else):**
- `src/lib/auth.ts`: `verifyPassword`, `findValidSession`,
  `getTrustedOrigins` — drop the `export` keyword, no other change.
  (`auth.ts` went through `docs/specs/024-security-review-hardening.md`;
  confirming these are internal-only rather than assuming from the tool's
  finding alone mattered specifically because of that file's sensitivity —
  see Open Questions for how this was verified.)
- `src/lib/scheduler.ts`: `tick` — same fix; only called from
  `runGuardedTick` within the same file, which is the actual external
  surface tests and `startScheduler` use.
- `src/views/queue-list.tsx`: `QueueListView`, `WatchedRow`, `IgnoredRow`
  (type exports) — same fix; each is used only as a parameter/property type
  within the file itself.

**Config-only, not code (3 items — already covered above, listed here for
completeness against the original findings):**
- `scripts/generate-icons.ts` "unused file" → `dynamicallyLoaded` entry.
- `htmx.org` "unused devDependency" → `ignoreDependencies` entry.
- `docs/features/002-UI_wireframe.html`'s unresolved `./support.js` import →
  `ignorePatterns` entry.

**Duplication (568 lines / 13.6% across 18 clone groups in the unconfigured
scan):** confirmed during scoping to be genuine same-file copy-paste
(`watch-status.ts`: a 22-line block ×3, a 25-line block ×2; `queue-urls.ts`:
an 11-line block ×3; `queue.tsx` and `categories.tsx` each with several
repeated blocks within themselves), not the "CRUD routes look structurally
similar by design" pattern that was a concern going in — this project's
routes (categories/channels/queue) are intentionally CRUD-shaped, and
abstracting genuinely-just-similar code into a shared helper would be a net
negative, so that distinction mattered before committing to fixing all of
it. Some clone groups in the
fuller scan output have near-identical/overlapping line ranges reported at
different granularities (e.g. `queue.tsx`'s "8 lines ×4" and "9 lines ×3"
groups) — deduplicate the actual extraction list against a fresh
`bunx fallow dupes` run at task-execution time rather than treating the
original 18 as 18 independent fixes. Extract into a shared helper
function local to the affected file (or an existing sibling `lib` module
where one already exists, e.g. `queue-urls.ts`) — no new abstraction module
needed for any of the groups found so far.

**Health (3 functions over threshold in the unconfigured scan, none
alarming — overall maintainability index 92.2/"good"):** `parseEntry`
(`src/lib/rss.ts`, CRAP 49.5), an arrow function in `src/routes/categories.tsx`
(CRAP 31.6), `queueVideos` (`src/routes/queue.tsx`, CRAP 31.6). Default
policy: attempt a small simplification first; if a refactor wouldn't
improve clarity (or isn't worth it relative to the modest CRAP scores
here), suppress with `// fallow-ignore-next-line complexity` and a comment
explaining why — this exact suppression syntax is confirmed directly from
a real run's own output ("To suppress: // fallow-ignore-next-line
complexity"), not inferred from docs. Which of the three get refactored vs.
suppressed is a task-execution-time judgment call, not pre-decided here.

### Updating `CLAUDE.md`'s verification rule

**Already applied** while drafting this spec (not deferred to a task-file
step): `CLAUDE.md`'s standing rule that every spec's final task-file step
must run `bun test`, `bun run lint`, and `bunx tsc --noEmit` clean now also
requires `bun run fallow` clean, a fourth item, worded the same way as the
existing three and with the same kind of rationale (the existing paragraph
already documents *why* `tsc --noEmit` earns a place in that list — a real
incident, spec006, where a type error sat unnoticed for a spec's worth of
commits until someone happened to run it by hand). `bun run fallow` closes
the same class of gap one level further out: cross-file dead code and
duplication that none of the other three touch. The point, raised directly
by the user rather than surfaced during drafting, is to catch a `fallow`
failure locally before push, not discover it only after CI runs
`main-checks` and have to come back and rework outside the task file's own
defined steps.

This is applied immediately, ahead of `fallow` actually being installed
(that happens later in this same spec's own task-file execution), rather
than sequenced as one of this spec's own task-file steps the way the
`main-checks` ruleset update is (see "Branch protection: a sequencing
gotcha" above). The two look similar but aren't: the ruleset update has a
real technical ordering constraint (GitHub won't list an unrun check as
selectable), whereas this is a documentation-only change with no such
constraint — the only risk would be some *other* spec's `/spec-tasks` run
generating a task file that references `bun run fallow` before it exists,
which requires two specs in flight at once. Confirmed with the user this
isn't a real scenario here: sole developer, one spec worked at a time, so
there's no in-flight second spec for the gap between "rule updated" and
"`fallow` installed" to actually bite.

### `docs/app_idea.md` cross-reference

Small pointer edit (this spec's own step, per the `/new-spec` skill
convention) — **already applied** while drafting this spec: §6 "CI/CD
Pipeline" now also points at `docs/specs/026-fallow-adoption.md` alongside
the existing `docs/specs/015-github-buildout.md` reference.

### Verification

Standard end-of-spec verification per `CLAUDE.md`: `bun test`,
`bun run lint`, and `bunx tsc --noEmit` must all be clean, **plus**
`bun run fallow` clean (zero findings, exit 0) — the new check this spec
adds. No existing test behavior is expected to change; the de-export fixes
touch only export visibility, not logic, and the duplication extractions
should preserve existing test coverage as the safety net (if any extraction
changes behavior, that's a bug in the extraction, not an acceptable
side effect).

**Gap found while writing this spec's task file, not during drafting:**
`src/lib/queue-urls.ts` has no test file anywhere in `test/lib/` — the
"existing test coverage as the safety net" line above doesn't hold for this
one file's duplication extraction. Its four functions build query-param
URLs; the extraction needs manual verification of representative inputs
(no args, category only, cursor only, both) against pre-extraction output
before/after, not just a clean `tsc`/lint pass, since there's no automated
check that would catch a behavior change here.

**Gap found while executing task 8, not during drafting:** any `fallow`
command that exercises `typeAware` (`bunx fallow health`, plain
`bunx fallow`/`bun run fallow`) hangs indefinitely inside the devcontainer —
its Bun-only base image has no real Node.js, and `fallow`'s type-aware
sidecar needs one. Confirmed *not* a container-state or TTY issue (reproduces
identically after a full destroy/recreate, and hangs the same way in a real
interactive terminal). Confirmed *not* a CI risk (`ubuntu-latest` ships real
Node.js regardless of `oven-sh/setup-bun@v2`). Full writeup and the
workaround (run on the host directly, not via `devcontainer exec`) now lives
in `CLAUDE.md`'s "Running commands" gotcha list — tasks 10 and 11 below, both
of which need a clean `bun run fallow`, must use that workaround.

## Open Questions

None remaining.

**How the `auth.ts`/`queue-list.tsx` "unused export" findings were verified,
not just trusted:** rather than accept fallow's dead-code findings at face
value — especially for `auth.ts`, given its security history
(`docs/specs/024-security-review-hardening.md`) — each of the four flagged
exports in `auth.ts` plus `scheduler.ts`'s `tick` was individually grepped
across the whole repo (including `test/`) during this spec's scoping
conversation, confirming each is called only within its own file before
concluding "de-export, safe" rather than "delete, risky." The same check was
then run against `queue-list.tsx`'s three flagged type exports, confirming
the identical pattern. This is reflected in the Clean-slate fix list above
as "de-export, not delete," not "remove."

**Config accuracy:** an earlier draft of this spec's `.fallowrc.json` (and
the reasoning behind several of its choices) was built from AI-summarized
fetches of `docs.fallow.tools`, not the tool itself, and contained several
factual errors once checked — see Context and Design's "Ground-truthing"
subsection for specifics. The config and reasoning in this spec reflect the
corrected, CLI-verified version.

### Red-team retrospective

One independent pass (general-purpose agent, no memory of the drafting
conversation). It re-verified this spec's claims against the real repo
rather than trusting the prose — including independently installing the
real `fallow@3.17.0` CLI and re-running it against the repo (with and
without the spec's proposed `.fallowrc.json`) to reproduce the numbers,
grepping the repo itself to re-check every "de-export, not delete" symbol,
and reading `pr.yml`/`biome.json`/`package.json`/spec015 to check the
proposed changes fit existing conventions.

Found no high-severity issues (nothing that would break the build,
contradict Scope, or leave a task-file executor stuck) and confirmed the
core factual claims — the 64-file/10,299-LOC scan totals, all 7
de-export-not-delete symbols, the 568-line/13.6%/18-clone-group duplication
figures, the 3 CRAP-scored functions, MI 92.2, the corrected rule names, the
`docs/app_idea.md` cross-reference, and the npm package facts. It did find
and this spec now incorporates fixes for:
1. **(Medium)** A fabricated citation: the duplication paragraph attributed
   "don't abstract merely-similar code" to this repo's `CLAUDE.md`, which
   contains no such text (that principle was in the assistant's own general
   working instructions, not this project's file). Fixed by removing the
   false attribution and stating the reasoning directly instead.
2. **(Medium)** The `fallow init` operational note assumed it would hang
   under `devcontainer exec`'s no-TTY condition, by analogy to the
   `drizzle-kit generate` gotcha. Reproducing it directly showed it doesn't
   hang — it exits 0 immediately and silently writes a generic, untailored
   config instead. Fixed to state the real behavior and warn against letting
   it silently overwrite the hand-authored config, rather than the
   (incorrect) hang risk.
3. **(Low)** Two numbers stated as directly tool-verified were off: "50
   rules total" (actually 53) and "19 files under `test/**/*.test.ts`"
   (actually 20). Fixed to the re-counted values.
4. **(Low)** `src/styles/input.css` was described as "35 lines of
   `@tailwind`/`@theme` directives"; it's actually 28 lines and roughly half
   of it is a real hand-written `#sidebar` scrollbar rule, not directives.
   Fixed the description (doesn't change the underlying conclusion — zero
   CSS findings either way).
5. **(Low, informational)** Enabling `typeAware.enabled: true` doesn't
   actually change this repo's `unused-exports`/`unused-types` counts (the
   "reduces false positives" claim wasn't demonstrated by this project's own
   data), and surfaces a new "Private type leaks" output section (12
   instances, but `off` severity by default so it doesn't affect the exit
   code). Fixed by softening the unsupported claim and adding a heads-up so
   the new output isn't mistaken for a regression during implementation.

No second pass run: every finding either had a concrete, verifiable fix
(re-grep the repo, re-run the CLI) rather than a further judgment call, and
none touched the spec's structural decisions (scope, CI design, sequencing,
which findings are safe to fix vs. suppress) — a narrower check of just
these five fixed spots would be the right-sized next step if further
scrutiny were warranted, not a full second pass.
