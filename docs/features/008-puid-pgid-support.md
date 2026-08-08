---
status: promoted
created: 2026-08-08
promoted_to: docs/specs/017-puid-pgid-support.md
---

# PUID/PGID Environment Variable Support

## Problem / Motivation
Deployment/Docker packaging (spec014) shipped a Dockerfile that fixes the runtime user at
build time via `USER bun`, baked into `oven/bun:1-alpine` as uid/gid `1000:1000`. Since the
app bind-mounts `./data:/data` for its SQLite storage, the host directory must already be
owned by that exact uid, so `docs/DEPLOYMENT.md` §4 currently tells every self-hoster to run
`chown -R 1000:1000 ./data` before first run. This was a deliberate MVP simplification —
`docs/app_idea.md`'s Future Roadmap explicitly defers "`PUID`/`PGID` env var support
(linuxserver.io-style) so the container can run as an arbitrary host UID/GID and avoid
bind-mount permission friction on the `/data` volume," and spec014's own scope excludes it
by name.

This feature implements that roadmap item: let a self-hoster set `PUID`/`PGID` env vars so
the container remaps its runtime user to match whatever host uid/gid should own `./data`,
instead of only working when that host uid happens to already be `1000`.

## Firm Scope
- **Entrypoint script replaces the Dockerfile's fixed `USER bun`.** The image starts as
  root; a new `docker-entrypoint.sh` (or similar name), set as `ENTRYPOINT` with the
  existing `CMD ["bun", "run", "start"]` passed through as its arguments, runs first:
  - If running as root (`id -u` = `0`):
    - Reads `PUID`/`PGID` from the environment, defaulting to `1000`/`1000` if unset (matches
      today's fixed behavior exactly for anyone who sets neither — non-breaking default).
    - Remaps the image's existing `bun` user/group to those values via `usermod -o -u
      "$PUID" bun` / `groupmod -o -g "$PGID" bun` (`-o` permits non-unique ids, in case the
      target value collides with an existing entry in the minimal image's `/etc/passwd`).
    - `chown -R "$PUID:$PGID" /data` — the only directory the app writes to at runtime.
      Nothing under `/app` needs chowning; app code stays root-owned/read-only.
    - If `PUID` or `PGID` resolves to `0`, prints a clear warning to stdout (e.g. "running
      as root — this is almost never what you want") but does **not** hard-fail. (Rationale
      in Resolved Decisions.) **Superseded during spec writing** — see
      `docs/specs/017-puid-pgid-support.md`'s Design section: the warning goes to **stderr**,
      not stdout. Deliberate correction, not an oversight: warning/diagnostic output
      conventionally goes to stderr, and `docker logs` captures and interleaves both streams
      identically, so there's no practical difference for a self-hoster tailing logs.
    - Sets `umask "${UMASK:-022}"` immediately before the final exec.
    - `exec su-exec bun "$@"` — hands off to the real `bun run start` process as the
      remapped user. Using `exec` (not a forked wrapper) matters so the app process becomes
      PID 1 and receives signals directly, keeping the door open for a future graceful-
      shutdown feature (already on the roadmap, separately) without this entrypoint getting
      in the way.
  - If **not** running as root (e.g. a self-hoster overrides with their own `user:` in a
    compose override, or runs under a restricted runtime that never grants root), the
    usermod/chown/su-exec steps are skipped entirely — the script still sets `umask
    "${UMASK:-022}"` (independent of the privilege-drop path) and directly `exec`s `"$@"` as
    whatever user the container is already running as. This lets the old manual-chown
    pattern keep working unmodified for anyone who deliberately opts out of the new
    mechanism, rather than erroring out.
  - Dockerfile also gains `apk add --no-cache shadow su-exec` (alpine's busybox doesn't ship
    `usermod`/`groupmod`, and `su-exec` is alpine's lightweight `gosu` equivalent) and a
    `COPY` + `chmod +x` for the new script.
- **`UMASK` env var**, alongside `PUID`/`PGID` — same linuxserver.io convention, controls the
  permission mask for newly-created files (only the three SQLite files under `/data` in
  practice). Defaults to `022` (standard Linux default) if unset.
- **`.env.example`** gains `PUID`/`PGID`/`UMASK` entries, matching the existing one-line-
  comment-per-var style already used for `DB_FILE_NAME`/`AUTH_RECOVERY_PASSWORD`/
  `TRUSTED_ORIGINS`.
- **`docs/DEPLOYMENT.md` §4** rewritten: `PUID`/`PGID` (defaulting to `1000`/`1000`) as the
  primary/expected method, including a worked example of finding your own host uid/gid
  (`id -u`, `id -g`) so a reader actually knows what to put in `.env` — this is the part
  that makes the feature usable, not just present. The existing manual-`chown` steps are
  kept as an explicitly-labeled advanced/fallback method (for restricted runtimes that never
  grant the container root), with a note that it still works unmodified.
- **`docs/app_idea.md`**: remove the now-implemented `PUID`/`PGID` Future Roadmap bullet (or
  replace with an inline pointer to this feature's eventual spec, per CLAUDE.md's convention
  for that file).
- **Automated regression coverage in CI**: extend `.github/workflows/pr.yml`'s
  `docker-build-check` job (currently just `docker build -t tubeshelf:pr-check .`) with a
  step that builds the image, runs it briefly with a custom `PUID`/`PGID`, and asserts `id`
  inside the running container reflects the requested values — plus a second run confirming
  the unset-defaults-to-`1000` case still holds. This is real automated coverage for logic
  `bun test` can't reach (it's shell running as root inside a container, not TypeScript),
  rather than leaving the whole feature to manual verification only.

## Nice-to-have / Stretch Scope
None identified.

## Explicitly Out of Scope
- Any change to `docker-compose.yml` itself is expected to be unnecessary — it already does
  `env_file: .env`, so `PUID`/`PGID`/`UMASK` set there flow straight through as container env
  vars with no compose-file edit required. Confirm this holds during spec/implementation;
  flag if it turns out otherwise.
- Documenting/handling an upgrade path for existing deployments explicitly — the default
  (`1000:1000`) is unchanged from today's fixed behavior, so upgrading is a non-issue by
  construction. Deliberately not adding upgrade-path documentation for this: no known
  audience for it beyond the current single self-hoster (who already runs `1000:1000`), and
  it would be unused bloat.
- Graceful shutdown (SIGTERM handling) — separate, already-deferred roadmap item. This
  feature's use of `exec su-exec` keeps that door open (see Firm Scope) but implements
  nothing toward it.
- `docs/specs/014-deployment-docker-packaging.md` is **not** edited — it's an already-
  `implemented` historical spec/record of that PR's scope; there's no existing precedent in
  this repo for retroactively annotating an old spec's "out of scope" section from a later
  spec (only `docs/app_idea.md` gets that inline-pointer treatment).
- SELinux mount relabeling (`:Z`/`:z`) on rootless-podman+SELinux hosts — an orthogonal
  concern to Unix uid/gid ownership, already documented as a host-specific note in spec014;
  this feature doesn't touch it.

## Related Specs / Code
- `Dockerfile` — currently ends `USER bun` (line 15); this feature removes that line, adds
  the `apk add shadow su-exec` step, and adds the entrypoint `COPY`/`ENTRYPOINT`.
- New file: `docker-entrypoint.sh` (exact name TBD in spec).
- `docker-compose.yml` — bind-mounts `./data:/data`; expected to need no changes (see
  Explicitly Out of Scope).
- `.env.example` — gains three new documented vars.
- `docs/DEPLOYMENT.md` §4 ("Bind-mount permissions") — the section being rewritten; currently
  documents only the manual `chown -R 1000:1000 ./data` method and explicitly says automatic
  `PUID`/`PGID` support is deferred.
- `docs/app_idea.md` Future Roadmap (v2.0) — the bullet being removed/resolved.
- `.github/workflows/pr.yml` — `docker-build-check` job, the CI job gaining the new
  automated-verification step.
- `docs/specs/014-deployment-docker-packaging.md` — prior spec that established the fixed-
  uid Dockerfile/compose/deployment-doc baseline this feature modifies, and originally
  deferred this exact work. Read (not edited) for context on `USER bun`'s original
  rationale and the rootless-podman/SELinux verification notes.
- Host-specific precedent worth carrying into the spec's Design section: spec014's
  verification notes record that on this project's actual dev host (rootless podman +
  SELinux enforcing), a host-side `chown 1000:1000 ./data` didn't reliably match what the
  container perceived as `1000:1000`, requiring a `podman unshare chown` workaround to
  verify manually. Because this feature's `chown`/`usermod` happen *inside* the container's
  own process against its own view of the filesystem, that workaround should no longer be
  necessary — worth confirming during implementation as a concrete verification step, not
  just an assumption.
- `.github/workflows/release.yml` — publishes `linux/amd64,linux/arm64` via
  `docker/build-push-action`. `pr.yml`'s `docker-build-check` only builds/runs natively
  (amd64 GitHub runner), so this feature's new CI verification step (see Firm Scope)
  exercises amd64 only — `su-exec`/`shadow` are standard Alpine main-repo packages expected
  to work identically on arm64, but that's untested by CI either before or after this
  feature, same limitation `docker-build-check` already has today for everything else. Worth
  one manual confirmation during implementation, not a CI gap this feature needs to close.

## Open Questions
None remaining — see Resolved Decisions below.

## Resolved Decisions
- **Default `PUID`/`PGID` when unset**: `1000`/`1000`, matching today's fixed `bun` user
  exactly. Chosen so upgrading is a non-breaking no-op for anyone who sets neither var — the
  project's one current self-hoster already runs `1000:1000` and needs nothing to change.
- **Nothing beyond `/data` needs chowning.** App code under `/app` stays root-owned/
  read-only; the only thing the running app ever writes is the SQLite file(s) under `/data`.
  This is also a small security plus — a compromised app process can't rewrite its own
  source.
- **Manual-chown fallback stays documented, not removed**, and both methods continue to
  work simultaneously: since the default is `1000:1000` (previous bullet), someone who
  still manually `chown`s `./data` to `1000:1000` and sets neither env var gets exactly
  today's behavior unchanged. `docs/DEPLOYMENT.md` leads with `PUID`/`PGID` as the expected
  method (with a worked example of finding your own uid/gid) and keeps manual chown as a
  clearly-labeled advanced/fallback option for restricted runtimes (see next bullet).
- **Entrypoint degrades gracefully when not running as root**, rather than assuming root is
  always available: some setups (a compose override hardcoding `user:`, a runtime that drops
  `CAP_SETUID`/`CAP_SETGID`) never let the container start as root, in which case
  `usermod`/`chown`/`su-exec` would simply fail. The entrypoint checks `id -u` first and, if
  non-root, skips straight to `exec "$@"` (after still applying `UMASK`) — one `if` at the
  top of the script, not two maintained code paths. This is also what makes rootless podman
  work cleanly: the chown happens from inside the container's own (possibly user-namespace-
  remapped) view of the filesystem, which sidesteps the host-side uid-shifting problem
  spec014 had to work around manually (see Related Specs/Code).
- **`PUID=0`/`PGID=0` (running as root)**: warn, don't hard-block. Chosen specifically
  because of what Tubeshelf's scheduler actually does — it parses untrusted YouTube RSS/XML
  on an unattended timer (`fast-xml-parser`), so a container quietly running as root raises
  the blast radius of any future parsing bug or dependency compromise more than most
  self-hosted apps would. But hard-failing would block a legitimate, informed choice: on
  rootless podman (already the project's tested runtime), uid `0` *inside* the container's
  own user namespace isn't actually privileged on the host, so a user who understands that
  could deliberately set `PUID=0` and mean something safe by it. A printed warning catches
  the likely copy-paste mistake without blocking the informed case.
- **`UMASK` is included**, not deferred. Practical payoff is modest for this specific app
  (only the three SQLite files under `/data` are ever created at runtime — no multi-
  container/shared-library scenario like linuxserver.io's typical media-stack use case), but
  it's a one-line addition and matches the convention self-hosters already expect from a
  PUID/PGID-style image.
  - `umask` is a per-process attribute, not an environment variable, so it must be set in
    the same shell process that performs the final `exec` — it applies in **both** branches
    of the root/non-root `if` (unlike the privilege-drop logic, which only applies in the
    root branch), just at a different point in each: right before `exec su-exec bun "$@"`
    in the root branch, right before `exec "$@"` in the non-root fallback branch.
- **Verification approach**: no `bun test` coverage is possible for the entrypoint's actual
  logic (`usermod`/`chown`/`su-exec` require running as root inside a container, not
  something the TypeScript test suite can exercise). Real automated coverage instead comes
  from extending `docker-build-check` in CI (see Firm Scope) to actually run the built image
  with custom and default `PUID`/`PGID` and assert `id` inside the container — genuine
  regression coverage, not manual-only verification. Manual end-to-end verification (per
  CLAUDE.md's Claude-performs/user-performs split) still covers what CI can't: confirming
  host-side file ownership after a real `docker compose up`, and confirming the non-root
  fallback branch with a simulated `user:` override.
- **`docker-compose.yml` and `.dockerignore` are expected to need no changes** —
  `docker-compose.yml` already passes `.env` contents straight through via `env_file:`, and
  `.dockerignore`'s existing patterns (`node_modules`, `.git`, `test`, `docs`, `data`,
  `.devcontainer`, `*.md`, `.env`) don't match a repo-root `docker-entrypoint.sh`, so it's
  included in the build context automatically.
- **`docs/specs/014-deployment-docker-packaging.md` is not edited.** It's a historical
  record of already-`implemented` work; this repo has no precedent for retroactively
  annotating an old spec's scope from a later one (only `docs/app_idea.md` gets inline
  pointers).
- **Entrypoint script must be POSIX `/bin/sh`, not bash.** `oven/bun:1-alpine`'s alpine base
  only ships busybox `ash` as `/bin/sh` — no bash present, and this feature doesn't add one.
  Shebang `#!/bin/sh`, no bashisms (no `[[ ]]`, no arrays, etc.).
- **`docker-compose.yml`'s `HEALTHCHECK` will keep running as root after this change, even
  though the main app process drops to the remapped uid.** `HEALTHCHECK CMD` executes using
  the image's *declared* default user (Dockerfile `USER`, which this feature removes
  entirely — the user-switch now happens only at runtime via the entrypoint's `su-exec`, not
  via a Dockerfile instruction), not whatever uid the entrypoint happened to drop to for PID
  1. Harmless functionally here (the healthcheck only does a `fetch()` to `localhost:3000/
  healthz`, no filesystem access), but means `docker inspect`'s declared user reverts to
  root — worth a one-line note in the spec's Design section so it doesn't look like an
  oversight later if someone notices while auditing the image.
