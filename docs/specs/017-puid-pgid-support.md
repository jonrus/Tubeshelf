---
status: in-progress
created: 2026-08-08
---

# PUID/PGID Environment Variable Support

## Context

`docs/app_idea.md`'s Future Roadmap (v2.0) lists `PUID`/`PGID` env var support
(linuxserver.io-style) as deferred work, and spec014
(`docs/specs/014-deployment-docker-packaging.md`) explicitly excluded it from MVP
deployment packaging in favor of a fixed `USER bun` (uid/gid `1000:1000`, baked into
`oven/bun:1-alpine`) plus a manual `chown -R 1000:1000 ./data` step documented in
`docs/DEPLOYMENT.md` §4. That's real, recurring friction for any self-hoster whose host uid
isn't `1000` — they either have to run a spare `1000:1000` user just for this container, or
`chown` their real data directory to a uid unrelated to their own account.

This spec originates from `docs/features/008-puid-pgid-support.md` (`status: refined`),
which resolved scope through a `/new-feature` pass grounded directly in spec014's Dockerfile/
`docker-compose.yml`/`docs/DEPLOYMENT.md` and in this project's own prior verification notes
about rootless podman. That file's `Resolved Decisions` are taken as settled; this spec adds
the concrete mechanics (exact entrypoint script, exact Dockerfile/CI diffs) the same way
spec014's Design section added concrete Dockerfile stages on top of feature file 005, and
spec013 added squash mechanics on top of feature file 004.

## Scope

**In scope:**
- A new `docker-entrypoint.sh` at the repo root, copied into the runtime image and set as
  `ENTRYPOINT`, replacing the Dockerfile's fixed `USER bun`. At container start, running as
  root, it remaps the image's `bun` user/group to `PUID`/`PGID` (default `1000`/`1000` if
  unset), `chown`s `/data`, applies `UMASK` (default `022`), and execs the real `bun run
  start` process as the remapped user via `su-exec`. If the container isn't running as root
  to begin with, all of the above is skipped and it execs directly — see Design.
- `Dockerfile` changes: `apk add shadow su-exec` in the runtime stage, `COPY` +
  executable-bit for the entrypoint script, `ENTRYPOINT` added, `USER bun` removed.
- `.env.example`: `PUID`, `PGID`, `UMASK` documented, matching the existing one-var-per-block
  comment style.
- `docs/DEPLOYMENT.md` §4 rewritten: `PUID`/`PGID` (with a worked `id -u`/`id -g` example) as
  the primary method; manual `chown` kept as a labeled advanced/fallback method for runtimes
  that never grant the container root. §2's Configuration table gains rows for the three new
  vars.
- `docs/app_idea.md`: the Future Roadmap bullet for this gets an inline pointer to this spec
  (existing text kept, per this project's established convention — see e.g. the Auth/CSRF
  and CI/CD Pipeline bullets, which append a pointer rather than rewrite the original line).
- `.github/workflows/pr.yml`'s `docker-build-check` job gains two verification steps: build
  the image, run it with custom `PUID`/`PGID` and assert the remapped `bun` user's `id -u`/
  `id -g` match, then run it with neither set and assert they default to `1000`/`1000`.

**Explicitly out of scope** (both already logged in `docs/features/008-puid-pgid-support.md`,
carried forward unchanged):
- Any change to `docker-compose.yml` — it already does `env_file: .env`, so `PUID`/`PGID`/
  `UMASK` set there flow straight through as container env vars with no compose-file edit
  needed. (Verified during this spec's writing: `docker-compose.yml`'s `env_file: [.env]`
  entry has no allowlist/filter — every key in `.env` is passed through as-is.)
- Documenting an upgrade path for existing deployments — the default (`1000:1000`) is
  unchanged from today's fixed behavior, so there's nothing to document; the project's one
  current self-hoster already runs `1000:1000`.
- Graceful shutdown (`SIGTERM` handling) — separate, already-deferred roadmap item. This
  spec's use of `exec su-exec` (rather than a forked wrapper) keeps that door open for a
  future spec but implements nothing toward it.
- `docs/specs/014-deployment-docker-packaging.md` is not edited — historical record of
  already-`implemented` work; this repo has no precedent for retroactively annotating an old
  spec's scope from a later one.
- SELinux mount relabeling (`:Z`/`:z`) on rootless-podman+SELinux hosts — orthogonal to Unix
  uid/gid ownership, already documented as a host-specific note in spec014.
- Any UMASK/ownership handling for multi-architecture correctness beyond the amd64 CI check
  below — `su-exec`/`shadow` are standard Alpine main-repo packages available for `arm64`
  same as `amd64`, but `docker-build-check` only builds/runs natively (amd64 runner); the
  `arm64` image `release.yml` also publishes isn't exercised by this spec's new CI steps.
  Flagged for one manual confirmation during implementation, not a CI gap this spec needs to
  close.

## Design

### `docker-entrypoint.sh` (new file, repo root)

```sh
#!/bin/sh
set -e

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"

  if [ "$PUID" = "0" ] || [ "$PGID" = "0" ]; then
    echo "Warning: PUID/PGID resolved to 0 (root) — this is almost never what you want." >&2
  fi

  groupmod -o -g "$PGID" bun >/dev/null
  usermod -o -u "$PUID" bun >/dev/null

  mkdir -p /data
  chown "$PUID:$PGID" /data
  for f in /data/tubeshelf.db /data/tubeshelf.db-wal /data/tubeshelf.db-shm; do
    [ -e "$f" ] && chown "$PUID:$PGID" "$f"
  done
  chown -R "$PUID:$PGID" /home/bun

  export HOME=/home/bun
  umask "${UMASK:-022}"
  exec su-exec bun "$@"
fi

umask "${UMASK:-022}"
exec "$@"
```

Notes:
- `#!/bin/sh`, not bash — confirmed `oven/bun:1-alpine`'s alpine base only ships busybox
  `ash` as `/bin/sh`; no bash present and this spec doesn't add one. No bashisms (`[[ ]]`,
  arrays, etc.) anywhere in the script.
- Single `if` at the top, no `else` — the root branch ends in `exec`, which replaces the
  shell process entirely, so nothing after the `if` block runs when that branch is taken.
  When not running as root, the `if` body is skipped and execution falls straight through to
  the two lines at the bottom. This is what keeps the non-root fallback to "one shared code
  path minus a few lines," not two branches to maintain in parallel.
- `groupmod`/`usermod` come from the `shadow` apk package (alpine's busybox does not include
  either); `-o`/`--non-unique` permits the target uid/gid to collide with an existing
  `/etc/passwd`/`/etc/group` entry in the minimal base image, which matters specifically for
  the `PUID=0`/`PGID=0` case (colliding with `root`) but is harmless to apply unconditionally.
- `mkdir -p /data` runs before the `chown`, **not** assumed to already exist. **Caught during
  this spec's red-team pass:** a bare `docker run` (no `-v`/bind mount, exactly what the new
  CI steps below do) never creates `/data` — only `docker-compose.yml`'s bind mount does that
  automatically. Without this line, `set -e` + a `chown` on a nonexistent path would abort
  the script before ever reaching `exec`, which would make the CI steps below fail on every
  PR, unconditionally. `mkdir -p` is a no-op once the real bind mount is layered over it in
  production, so this is free defensive behavior, not just a CI workaround.
- `groupmod`/`usermod` redirect their own stdout to `/dev/null`. **Caught during this spec's
  second red-team pass, via an actual `podman build`/`podman run` of the script against
  `oven/bun:1-alpine`** (not just static reading): `usermod -o -u "$PUID" bun` prints
  `usermod: no changes` to stdout — exit code `0`, so it doesn't trip `set -e`, but it *does*
  leak into the container's combined stdout stream — whenever `$PUID` already equals the
  user's current uid, which is exactly the CI default-value check below (`bun` ships at uid
  `1000`, `PUID` defaults to `1000`). Reproduced live: `$(docker run ... id -u)` came back as
  `"usermod: no changes\n1000"` instead of `"1000"`, which fails `test "$uid" = "1000"`
  outright. The custom-`PUID` CI case (`1234`) is unaffected since a real uid change occurs
  there and `usermod` stays silent. `groupmod` was empirically confirmed silent on a no-op
  too, but redirected for symmetry/future-proofing rather than relying on that holding across
  `shadow` package versions.
- `chown` is scoped to the `/data` directory itself plus the three known SQLite artifact
  names, **not** a blind `chown -R /data`. **Also caught during red-team:** a self-hoster can
  put arbitrary content under the bind-mounted `./data` (e.g. manually-copied backups, per
  `docs/DEPLOYMENT.md` §5's own "copy the three files from `./data`" backup procedure being
  easy to invert), and a recursive chown on every restart would silently re-own anything
  found there. The three explicit filenames match the one fixed, non-customizable path this
  project's own `docker-compose.yml` sets (`DB_FILE_NAME=/data/tubeshelf.db`, and
  `docs/DEPLOYMENT.md` already documents that side of the bind mount as not meant to be
  edited per-deployment) — the directory itself still needs chowning (so newly-created files
  land with the right owner), and any of the three files needs re-chowning if it already
  exists from a prior, differently-configured `PUID`/`PGID`, but nothing else does.
- `chown -R "$PUID:$PGID" /home/bun` and `export HOME=/home/bun` address a real `su-exec`
  gotcha caught during red-team: unlike `su`/`sudo`, `su-exec` (like `gosu`) deliberately does
  *not* reset environment variables on privilege drop — `$HOME` stays whatever the root
  parent process had (typically `/root` or unset) unless set explicitly. Verified live
  (`podman run --rm docker.io/oven/bun:1-alpine sh -c 'getent passwd bun'` →
  `bun:x:1000:1000::/home/bun:/bin/sh`) that `/home/bun` exists and is `bun`'s declared home
  in `/etc/passwd` already; `usermod -u` changes only the uid number, not the home path, but
  does *not* itself re-chown existing files at that path, so after a uid remap `/home/bun`
  would otherwise stay owned by the old uid. No code under `src`/`test` reads
  `process.env.HOME`/`getuid`/`userInfo` (confirmed by grep during red-team), so this is
  precautionary against Bun-runtime-internal use of `$HOME` (e.g. its own cache/config
  discovery) rather than a confirmed app-level bug — cheap enough to fix regardless of
  whether it would ever actually bite.
- `PUID=0`/`PGID=0` gets a warning printed to stderr, not stdout as
  `docs/features/008-puid-pgid-support.md` originally worded it, and not a hard failure —
  see that file's Resolved Decisions for the warn-vs-block reasoning (Tubeshelf's scheduler
  parses untrusted RSS/XML unattended, raising the cost of an accidental root container more
  than most self-hosted apps; but rootless podman's user-namespace remapping makes `PUID=0`
  a potentially legitimate, informed choice this spec shouldn't block). The stdout→stderr
  switch is a deliberate correction made while writing this spec, not an oversight: warning/
  diagnostic output conventionally goes to stderr, and `docker logs` captures and interleaves
  both streams identically, so there's no practical difference for a self-hoster tailing
  logs. The feature file is annotated with a pointer to this correction rather than rewritten
  in place, per this project's discovered-during-implementation correction convention.
- `umask` is set in **both** the root and non-root paths (right before each path's own final
  `exec`), unlike the privilege-drop logic which only applies in the root branch — umask is a
  per-process attribute, not something `su-exec`/`exec` can inherit from a step that ran
  before it in a different process, so it has to be set immediately before whichever `exec`
  actually runs.

### `Dockerfile`

Runtime stage only changes (build stage untouched):

```dockerfile
FROM oven/bun:1-alpine
RUN apk add --no-cache shadow su-exec
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY drizzle ./drizzle
COPY --from=build /app/public/css/tailwind.css ./public/css/tailwind.css
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "run", "start"]
```

- `USER bun` is removed entirely — the image now starts as root by default, with the
  entrypoint script responsible for dropping privileges before the actual app process runs.
  This is the standard shape for a PUID/PGID-remapping image (postgres, linuxserver.io's
  images, etc. all follow it): root briefly at container start, never for the long-running
  process.
- Entrypoint installed at `/usr/local/bin/docker-entrypoint.sh`, not the image's `WORKDIR` —
  keeps it discoverable independent of `WORKDIR` and matches the convention used by most
  official images that ship an entrypoint script. Verified `/usr/local/bin` is on `$PATH`
  rather than assumed (same rigor spec014 applied to its own image claims): `podman run --rm
  docker.io/oven/bun:1-alpine sh -c 'echo $PATH'` →
  `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bun-node-fallback-bin`.
- `docker-compose.yml`'s `HEALTHCHECK` will keep running as root after this change, even
  though the main app process (PID 1, via the entrypoint's `su-exec`) drops to the remapped
  uid. `HEALTHCHECK CMD` executes using the image's *declared* default user — previously set
  by the now-removed `USER bun` Dockerfile instruction, and with no replacement `USER`
  instruction added (the user-switch now happens only at runtime, inside the entrypoint, not
  via a Dockerfile instruction) that default reverts to root. Harmless functionally: the
  healthcheck only does a `fetch()` to `localhost:3000/healthz`, no filesystem access. Noted
  here so it doesn't read as an oversight if a security-conscious reader later notices
  `docker inspect`'s declared user is root despite the app itself running non-root.
- `apk add --no-cache shadow su-exec` added as the first line of the runtime stage,
  before `WORKDIR`, so it's cached independently of anything that changes more often
  (`package.json`, `src/`) — this ordering is Docker layer-caching hygiene consistent with
  the general shape of the existing multi-stage Dockerfile, not a functional requirement.
- No `--chown` needed on any `COPY` — app files stay root-owned, matching spec014's existing
  reasoning for why `USER bun` (now the entrypoint's `su-exec bun`) needed no `--chown`
  upstream of it: the one real permission concern is `/data`, handled by the entrypoint's
  `chown` at runtime.

### `docker-compose.yml`

No change. `env_file: [.env]` already passes every key present in `.env` straight through
as a container environment variable with no allowlist — confirmed by inspecting the current
file, which has no `environment:` entries filtering or overriding what `env_file` provides.
A self-hoster adds `PUID`/`PGID`/`UMASK` to their own `.env`; nothing in the committed compose
file needs to change for that to take effect.

### `.env.example`

New block appended, matching the file's existing one-var-per-block comment style:

```
# PUID: user ID the app process runs as inside the container. Defaults to 1000 if unset —
# matches the previous fixed-uid behavior, so leaving this unset changes nothing. Set to
# your host user's uid (`id -u`) if you want files under ./data owned by a specific user.
# PUID=1000

# PGID: group ID the app process runs as inside the container. Defaults to 1000 if unset,
# same rationale as PUID. Set to your host user's gid (`id -g`).
# PGID=1000

# UMASK: permission mask applied to files the app creates under /data. Defaults to 022
# (owner read/write, group/other read-only) if unset.
# UMASK=022
```

### `docs/DEPLOYMENT.md`

§4 replaces its current manual-chown-only content. (Shown here as the literal Markdown to
land in the file, not wrapped in an outer fence — nesting a ` ```markdown ` fence around the
two code examples below would prematurely close on the first inner ` ``` `, corrupting the
render; **caught during this spec's red-team pass**, since the earlier draft made exactly
that mistake.)

## 4. File ownership (PUID/PGID)

The container remaps its runtime user at startup to match the `PUID`/`PGID` environment
variables, so files under the bind-mounted `./data` directory end up owned by whatever host
user you choose — no need for `./data` to already be owned by a fixed uid.

1. Find your host user's uid/gid:
   ```
   id -u   # → PUID
   id -g   # → PGID
   ```
2. Set `PUID`/`PGID` in `.env` to those values. Leaving them unset defaults to `1000`/`1000`.
3. `mkdir -p ./data` if it doesn't already exist, then start (or restart) the container —
   ownership is handled automatically on boot.

### Advanced: runtimes that never grant the container root

The above relies on the container briefly starting as root before dropping to the
`PUID`/`PGID` user. If your setup never grants that (e.g. you set `user:` directly in a
compose override, or run under a policy that drops `CAP_SETUID`/`CAP_SETGID`), the container
detects this and skips the remap step entirely, running as whatever user it's given instead.
In that case, `chown` the host directory yourself before first run, matching whatever
uid/gid your override actually runs the container as — for example, if your override sets
`user: "1000:1000"`:

```
mkdir -p ./data
chown -R 1000:1000 ./data
```

Substitute your override's actual uid/gid if it isn't `1000:1000`.

Either way, if the container ends up running as a uid that doesn't own `./data`, it fails to
boot with a `SQLITE_CANTOPEN` error, since it can't create `tubeshelf.db` in a directory it
doesn't own.

§2's Configuration table gains three rows (`PUID`, `PGID`, `UMASK`), same one-line-purpose
style as the existing three.

### `docs/app_idea.md`

The existing Future Roadmap (v2.0) bullet keeps its current text and gains a trailing
pointer, matching this file's established convention (e.g. the Auth/CSRF and CI/CD Pipeline
bullets):

> `PUID`/`PGID` env var support (linuxserver.io-style) so the container can run as an
> arbitrary host UID/GID and avoid bind-mount permission friction on the `/data` volume. MVP
> deployment docs instead just document manually `chown`-ing the data directory to match the
> container's user before first run (refined in docs/specs/017-puid-pgid-support.md)

### `.github/workflows/pr.yml` — `docker-build-check`

```yaml
  docker-build-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t tubeshelf:pr-check .
      - name: Verify PUID/PGID remap
        run: |
          uid=$(docker run --rm -e PUID=1234 -e PGID=5678 tubeshelf:pr-check id -u)
          gid=$(docker run --rm -e PUID=1234 -e PGID=5678 tubeshelf:pr-check id -g)
          test "$uid" = "1234"
          test "$gid" = "5678"
      - name: Verify PUID/PGID default to 1000
        run: |
          uid=$(docker run --rm tubeshelf:pr-check id -u)
          gid=$(docker run --rm tubeshelf:pr-check id -g)
          test "$uid" = "1000"
          test "$gid" = "1000"
```

- Overriding the container's `CMD` with `id -u`/`id -g` (instead of the default `bun run
  start`) works because `ENTRYPOINT`/`CMD` compose normally: `docker run ... tubeshelf:pr-check
  id -u` passes `id -u` as `"$@"` to `docker-entrypoint.sh`, which — after remapping — execs
  `su-exec bun id -u`, printing just the numeric uid to stdout. This exercises the full real
  remap path (not a mocked/simplified version of it) without needing to boot the actual app
  or touch the DB, keeping the check fast and self-contained.
- Neither `docker run` here passes `-v`/`--mount` for `/data` — deliberately relying on the
  entrypoint's own `mkdir -p /data` (see the script's notes above) rather than giving CI a
  scratch volume. **Caught during red-team**: without that `mkdir -p` in the script, these
  exact commands would have failed unconditionally on every PR (`chown` on a nonexistent
  `/data` aborts the script under `set -e`, so `id -u`/`id -g` would never run and
  `docker-build-check` — one of `pr.yml`'s four required, unbypassable checks — would stay
  red permanently). The script-level fix doubles as what makes this CI check pass at all.
- Uses `test "$uid" = "1234"` (exact equality), not `grep`/substring matching — a substring
  check like `echo "$out" | grep -q "uid=1234"` would false-positive against `uid=12345`;
  caught while drafting this spec, not left for a later red-team pass to find.
- Both steps are separate `docker run` invocations (not one container reused for two `id`
  calls) since each needs a different environment (`PUID`/`PGID` set vs. unset) — `--rm`
  keeps this from leaving containers behind on the runner.

### Test coverage

No `bun test` coverage is possible or appropriate here — the logic under test is shell
running as root inside a container (`usermod`, `chown`, `su-exec`), not TypeScript
`bun test` can import and exercise directly, same reasoning spec014 gave for why its
Dockerfile/`docker-compose.yml` had no automated test surface of their own. Real automated
regression coverage instead comes from the two new `docker-build-check` CI steps above,
which exercise the actual entrypoint script inside the actual built image on every PR — a
stronger guarantee than a unit test mocking the shell logic would give anyway.

What CI can't cover, left to `/spec-tasks`' manual end-to-end verification section (per
CLAUDE.md's Claude-performs/user-performs split):
- **Claude performs directly**: build the image locally, run `docker compose up -d` (or
  `podman compose`, per this host's setup) with `PUID`/`PGID` set in `.env` to something
  other than `1000`/`1000`, and confirm via a host-side `ls -ln ./data` that the SQLite files
  are actually owned by the configured uid/gid — the thing CI's `id`-inside-container check
  can't observe from outside the container. Also confirms the rootless-podman note under
  Related Specs/Code in the feature file: that this no longer needs the `podman unshare
  chown` half of spec014's verification workaround. **Scope correction caught during
  red-team**: spec014's actual workaround was two-part — `podman unshare chown` *and* a
  separate `podman unshare chcon -Rt container_file_t` SELinux relabel (see spec014's
  extended verification note). This feature only eliminates the uid-mapping half; the
  SELinux relabel is an orthogonal concern (already correctly out of scope elsewhere in this
  spec) and will likely still be needed on this rootless-podman+SELinux host. If this
  verification step still hits `Permission denied` after confirming ownership is correct,
  that's the still-needed, unrelated SELinux step — not a sign this feature is broken.
- **Claude performs directly**: simulate the non-root fallback branch (e.g. `docker run
  --user 1000:1000 ...` or a one-off compose override with `user: "1000:1000"`) and confirm
  the container still boots successfully against a pre-chowned `./data`, exercising the `if`
  branch CI's checks above don't reach (both CI steps run as root by construction).
- **User performs live in a browser**: none needed — this feature has no UI surface;
  everything observable lives at the filesystem/process level, which Claude can verify
  directly per the two bullets above.

## Open Questions

None. `/new-feature`'s scoping pass and this spec's own drafting resolved every open item
from `docs/features/008-puid-pgid-support.md`; see that file's Resolved Decisions for the
reasoning behind the ones not restated in full here (default values, `PUID=0` handling, why
`UMASK` was included, why `docker-compose.yml`/`.dockerignore` need no changes).

**Red-team retrospective**: one independent review pass (fresh subagent, no memory of the
drafting conversation) found nine issues, all fixed directly in this draft rather than left
as follow-ups:
1. **Critical** — the entrypoint script had no `mkdir -p /data`, so a bare `docker run` with
   no bind mount (exactly what the new CI steps do) would hit `set -e` aborting on a `chown`
   to a nonexistent path, failing `docker-build-check` — a required, unbypassable check —
   on every PR. Fixed by adding `mkdir -p /data` before the `chown` in the script.
2. **Moderate-high** — the proposed `docs/DEPLOYMENT.md` §4 replacement wrapped the whole
   section in an outer ` ```markdown ` fence containing two more inner fenced examples;
   CommonMark's fence matching would close the outer fence on the first inner one,
   corrupting the render. Fixed by dropping the outer wrapper.
3. **Moderate** — the feature file's Resolved Decision that `HEALTHCHECK` keeps running as
   root after `USER bun` is removed (and should get a one-line spec note) was dropped
   entirely from the first draft. Added under the Dockerfile section.
4. **Moderate** — the script printed the `PUID=0`/`PGID=0` warning to stderr; the feature
   file said stdout. Kept stderr (the better choice — `docker logs` interleaves both, no
   practical difference) but called it out explicitly as a deliberate correction rather than
   an unacknowledged divergence, with a pointer added to the feature file (see below).
5. **Moderate** — `chown -R "$PUID:$PGID" /data` was unscoped, and would silently re-own any
   arbitrary content a self-hoster stored under the bind mount (e.g. manual backups) on every
   restart. Scoped to the `/data` directory itself plus the three known, fixed SQLite
   filenames instead of a blind recursive chown.
6. **Minor-moderate** — the "Advanced" fallback doc example said to `chown` "matching
   whatever uid/gid your override runs as" but then hard-coded `1000:1000` with no caveat.
   Reworded to frame the example as illustrative and added a substitute-your-own-values note.
7. **Minor** — `su-exec` (unlike `su`) doesn't reset `$HOME` on privilege drop, a known
   gotcha with this exact pattern (postgres's own entrypoint works around it the same way).
   Verified live that `/home/bun` exists and is `bun`'s declared home, then added
   `chown -R /home/bun` + `export HOME=/home/bun` before the final exec.
8. **Minor** — the manual-verification section implied this feature fully closes the
   `podman unshare` workaround spec014 needed on this host; that workaround was actually
   two-part (uid remap *and* SELinux relabel), and only the uid half is addressed here. Added
   an explicit caveat so a future `Permission denied` isn't mistaken for this feature being
   broken.
9. **Minor** — `/usr/local/bin` being on `$PATH` was asserted without the empirical
   verification this project's specs otherwise apply to image claims (spec014's own
   precedent). Verified live (`podman run --rm docker.io/oven/bun:1-alpine sh -c 'echo
   $PATH'`) and the citation added.

A second, narrower pass — scoped to whether these nine fixes were applied correctly, plus an
end-to-end sanity check of the entrypoint script and Dockerfile diff via an actual
`podman build`/`podman run` against `oven/bun:1-alpine` (not just re-reading the spec) — found
all nine fixes correctly applied, but caught one new, real bug in the process: `usermod -o -u`
prints `usermod: no changes` to stdout (exit `0`, doesn't trip `set -e`) whenever `$PUID`
already matches the current uid, which is exactly the CI default-value check's scenario
(`bun` ships at uid `1000`, `PUID` defaults to `1000`) — corrupting the `$(docker run ... id
-u)` capture and failing that check on every PR. Fixed by redirecting `groupmod`/`usermod`'s
own stdout to `/dev/null` (see the script notes above). A third pass, scoped only to that one
fix plus re-confirming nothing else regressed, found nothing further — a reasonable stopping
point per the skill's guidance that a clean pass after a substantive one is the signal to
stop, not a fixed pass count.
