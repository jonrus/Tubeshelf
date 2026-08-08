# Tasks: PUID/PGID Environment Variable Support
Spec: docs/specs/017-puid-pgid-support.md
Generated: 2026-08-08

- [x] 1. Create `docker-entrypoint.sh` at the repo root and update the `Dockerfile`'s runtime
  stage to use it, then build and verify the remap behavior locally — per the spec's
  "Operational note" precedent (spec014), building/running the production image happens
  directly on the host via `podman`, not `devcontainer exec`.

  Create `docker-entrypoint.sh` with exactly this content:
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
  Make it executable: `chmod +x docker-entrypoint.sh`.

  Update the `Dockerfile`'s runtime stage (the second `FROM oven/bun:1-alpine` block — the
  first `FROM oven/bun:1-alpine AS build` block above it is untouched). Replace this exact
  current block:
  ```dockerfile
  FROM oven/bun:1-alpine
  WORKDIR /app
  COPY package.json bun.lock tsconfig.json ./
  RUN bun install --frozen-lockfile --production
  COPY src ./src
  COPY drizzle ./drizzle
  COPY --from=build /app/public/css/tailwind.css ./public/css/tailwind.css
  USER bun
  EXPOSE 3000
  CMD ["bun", "run", "start"]
  ```
  with exactly:
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
  (This removes the previous `USER bun` line entirely — see the spec's Design section for
  why: the entrypoint now does the privilege drop at runtime instead.)

  Build the image: `podman build -t tubeshelf:puid-check .` — must complete with no errors.

  Then run the exact two checks the spec's Design section adds to CI (running them here
  first, by hand, is what lets task 5 below just copy known-working commands into the CI
  YAML):
  ```
  uid=$(podman run --rm -e PUID=1234 -e PGID=5678 tubeshelf:puid-check id -u)
  gid=$(podman run --rm -e PUID=1234 -e PGID=5678 tubeshelf:puid-check id -g)
  test "$uid" = "1234" && test "$gid" = "5678" && echo "custom PUID/PGID: PASS"

  uid=$(podman run --rm tubeshelf:puid-check id -u)
  gid=$(podman run --rm tubeshelf:puid-check id -g)
  test "$uid" = "1000" && test "$gid" = "1000" && echo "default PUID/PGID: PASS"
  ```
  Both `uid`/`gid` captures must be *exactly* the numeric value with nothing else in them
  (this is the specific bug the spec's second red-team pass caught and fixed via the
  `>/dev/null` redirects on `groupmod`/`usermod` above — if either capture instead contains
  something like `usermod: no changes\n1000`, the redirects are missing or misplaced).

  Also confirm the `PUID=0` warning path: `podman run --rm -e PUID=0 -e PGID=0
  tubeshelf:puid-check id 2>&1 1>/dev/null` must print the "Warning: PUID/PGID resolved to
  0 (root)" message (stderr only — confirm nothing about it appears when stdout is checked
  alone).

  Done when: both files exist with the exact content above, `podman build` succeeds, all
  three runtime checks above print their expected `PASS`/warning output, and `bun run lint`
  / `bunx tsc --noEmit` (via `devcontainer exec --docker-path podman --workspace-folder .`)
  are still clean (neither file is TypeScript, but this confirms nothing else regressed).

- [x] 2. Confirm the entrypoint's `shadow`/`su-exec` packages and remap logic also work
  under `linux/arm64` — the one manual confirmation the spec flags as needed since
  `release.yml` publishes `linux/amd64,linux/arm64` but `docker-build-check`/task 1 above
  only exercise the runner's native `amd64`. This host's `podman` already has working QEMU
  emulation for this (confirmed during spec writing: `podman run --rm --platform linux/arm64
  docker.io/oven/bun:1-alpine sh -c 'uname -m'` → `aarch64`).

  Rebuild for arm64 and repeat the custom-`PUID`/`PGID` check from task 1:
  ```
  podman build --platform linux/arm64 -t tubeshelf:puid-check-arm64 .
  uid=$(podman run --rm --platform linux/arm64 -e PUID=1234 -e PGID=5678 tubeshelf:puid-check-arm64 id -u)
  gid=$(podman run --rm --platform linux/arm64 -e PUID=1234 -e PGID=5678 tubeshelf:puid-check-arm64 id -g)
  test "$uid" = "1234" && test "$gid" = "5678" && echo "arm64 custom PUID/PGID: PASS"
  ```
  Clean up afterward: `podman rmi tubeshelf:puid-check-arm64`.

  Done when: the arm64 build succeeds and the check prints `PASS`. If QEMU emulation turns
  out to be unavailable/broken in this session's environment despite the above, note that
  explicitly in this file (don't silently skip) and fall back to noting `shadow`/`su-exec`
  are both standard packages in Alpine's `main` repository (not `community` or
  architecture-limited) as the best available evidence instead.

- [ ] 3. Add `PUID`/`PGID`/`UMASK` to `.env.example`. Append, after the existing
  `TRUSTED_ORIGINS` block:
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
  Done when: `.env.example` contains this block appended after the existing three vars, and
  `grep -c '^# [A-Z_]*:' .env.example` returns `6` (3 existing + 3 new).

- [ ] 4. Rewrite `docs/DEPLOYMENT.md` §4 and add rows to §2's Configuration table.

  Replace all of current §4 ("## 4. Bind-mount permissions", currently the manual-chown-only
  content) with:
  ```markdown
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
  ```
  (Note: the section number stays `## 4.` even though the heading text changes from "Bind-mount
  permissions" to "File ownership (PUID/PGID)" — don't renumber surrounding sections.)

  In §2's Configuration table, add three rows after the existing `TRUSTED_ORIGINS` row:
  ```
  | `PUID` | User ID the app process runs as inside the container. Defaults to `1000` if unset. |
  | `PGID` | Group ID the app process runs as inside the container. Defaults to `1000` if unset. |
  | `UMASK` | Permission mask applied to files created under `/data`. Defaults to `022` if unset. |
  ```

  Done when: §4's heading and content match the above exactly, §2's table has 6 data rows
  total (3 existing + 3 new), and `bun run lint` (via `devcontainer exec`) is still clean
  (Biome doesn't lint Markdown, but confirms nothing else broke).

- [ ] 5. Add two verification steps to `docker-build-check` in `.github/workflows/pr.yml`,
  reusing the exact commands already confirmed working by hand in task 1. Replace the job's
  current two-line `steps:` list with:
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
  Done when: `.github/workflows/pr.yml` contains this exact job definition (rest of the
  file — `lint`/`test`/`typecheck` jobs — untouched), and the YAML is valid (`podman run
  --rm -v "$PWD/.github/workflows/pr.yml:/f.yml:Z" docker.io/library/python:alpine python3 -c
  "import yaml; yaml.safe_load(open('/f.yml'))"` exits 0, or any equivalent local YAML
  parse check).

- [ ] 6. Manual end-to-end verification of the two things CI's `id`-inside-container checks
  can't observe: real bind-mount ownership on disk, and the non-root fallback branch. Uses
  the image built in task 1 (rebuild with `podman build -t tubeshelf:puid-check .` if it was
  since removed).

  **Bind-mount ownership**, custom `PUID`/`PGID`:
  ```
  mkdir -p /tmp/tubeshelf-puid-verify
  podman run --rm -d --name tubeshelf-puid-verify -p 3001:3000 \
    -e PUID=1234 -e PGID=5678 -e DB_FILE_NAME=/data/tubeshelf.db \
    -v /tmp/tubeshelf-puid-verify:/data tubeshelf:puid-check
  sleep 2
  curl -i http://localhost:3001/healthz   # expect: 200, body "ok"
  podman exec tubeshelf-puid-verify id                # expect: uid=1234 gid=5678
  podman exec tubeshelf-puid-verify ls -ln /data       # expect: tubeshelf.db* owned 1234:5678
  ls -ln /tmp/tubeshelf-puid-verify                    # host-side view — see note below
  podman stop tubeshelf-puid-verify
  rm -rf /tmp/tubeshelf-puid-verify
  ```
  Note for the host-side `ls -ln`: this host runs rootless podman, which remaps container
  uids through `/etc/subuid` — per the spec's Design section, this feature fixes ownership
  from *inside* the container's own namespace (confirmed by the `podman exec` checks above),
  but the raw host-side number may still appear shifted rather than literally `1234`. That's
  expected rootless-podman behavior, not a bug in this feature — don't treat a shifted
  host-side number as a failure if both `podman exec` checks above show the correct values.
  If a `Permission denied` shows up instead (distinct from an ownership mismatch), that's
  the still-needed, unrelated SELinux relabel (`:Z`) the spec's Design section flags as out
  of scope — not a sign this feature is broken.

  **Non-root fallback branch** — simulate a runtime that never grants the container root:
  ```
  mkdir -p /tmp/tubeshelf-puid-fallback
  podman unshare chown 1000:1000 /tmp/tubeshelf-puid-fallback
  podman run --rm -d --name tubeshelf-puid-fallback -p 3002:3000 --user 1000:1000 \
    -e DB_FILE_NAME=/data/tubeshelf.db -v /tmp/tubeshelf-puid-fallback:/data tubeshelf:puid-check
  sleep 2
  curl -i http://localhost:3002/healthz   # expect: 200, body "ok" — confirms the script's
                                            # non-root branch skipped usermod/chown/su-exec
                                            # and exec'd the app directly, and that it still
                                            # boots successfully against a pre-chowned dir
  podman logs tubeshelf-puid-fallback | head -20   # expect: no usermod/groupmod/chown errors
  podman stop tubeshelf-puid-fallback
  rm -rf /tmp/tubeshelf-puid-fallback
  ```

  **User performs live in a browser**: not applicable — this feature has no UI surface;
  everything observable lives at the filesystem/process level, fully covered above.

  Done when: both scenarios boot successfully and return `200 ok` from `/healthz`, the
  bind-mount ownership checks show the expected uid/gid via `podman exec`, the fallback
  scenario's logs show no privilege-drop errors, and all temp containers/directories/images
  from this task and tasks 1–2 are cleaned up (`podman rmi tubeshelf:puid-check`).

- [ ] 7. Final verification, spec status, and PR. Run `bun test`, `bun run lint`, and
  `bunx tsc --noEmit` clean across the whole repo (all via `devcontainer exec
  --docker-path podman --workspace-folder .`) — confirms nothing in tasks 1–6 broke the
  application itself, even though this spec touches no `src`/`test` files directly.

  Once that's clean and tasks 1–6 all pass: update
  `docs/specs/017-puid-pgid-support.md`'s frontmatter to `status: implemented`, then check
  off this task in this file, and commit both changes together — **before** pushing, per
  `CLAUDE.md`'s branch/PR workflow (the box-check commit must ride along in the same push as
  everything else, not trail it). Then ask the user whether they're pushing the
  `spec/puid-pgid-support` branch themselves or want Claude to; once it's on the remote
  (however it got there), open the PR (`gh pr create`) with a summary of the spec and a
  test-plan checklist (`bun test` / `bun run lint` / `bunx tsc --noEmit`, the amd64 and
  arm64 remap checks, the bind-mount-ownership and non-root-fallback manual checks — all per
  this task file), and tell the user it's ready for `main-checks`' four required checks and
  their review/merge. Do not merge it — merging is always manual.

  Done when: all three of `bun test`/`bun run lint`/`bunx tsc --noEmit` are clean; the
  spec's frontmatter reads `status: implemented`; this task is checked off; the branch is
  pushed; and the PR is open.
