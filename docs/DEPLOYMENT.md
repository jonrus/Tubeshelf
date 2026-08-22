# Deploying Tubeshelf

Tubeshelf ships as a prebuilt container image published to GHCR and run via
`docker-compose.yml`. This guide covers running it as a self-hosted Docker Compose service.
Examples use `docker compose`; substitute `podman compose` (or `podman-compose`, whichever
`podman compose version` / `command -v podman-compose` shows is available on your host) if
you're using podman instead of Docker.

## 1. Quick start

1. Clone the repo and `cd` into it.
2. Copy `.env.example` to `.env` and fill in the values you need (see Configuration below):
   ```
   cp .env.example .env
   ```
3. Start the stack:
   ```
   docker compose up -d
   ```
   The app listens on the host port from `docker-compose.yml`'s `ports:` mapping (`3000` by
   default). You can change the host-side (left) number freely if `3000` is already taken on
   your host, but leave the container-side (right) `3000` alone — it must match the port the
   app listens on inside the container.

## 2. Configuration

All configuration is via environment variables, set in `.env` (loaded by `docker-compose.yml`'s
`env_file:` entry). See `.env.example` for full comments on each — this table is just a
quick reference:

| Variable | Purpose |
| :--- | :--- |
| `DB_FILE_NAME` | Path to the SQLite database file. Already set to `/data/tubeshelf.db` in `docker-compose.yml` to match the bind mount — leave unset in `.env`. |
| `AUTH_RECOVERY_PASSWORD` | If set, forces the admin user's password to this value on every startup. Used only for initial login / password recovery — see below. |
| `TRUSTED_ORIGINS` | Comma-separated list of origins allowed to make CSRF-protected requests. Must include whatever public origin(s) you access the app through. |
| `PUID` | User ID the app process runs as inside the container. Defaults to `1000` if unset. |
| `PGID` | Group ID the app process runs as inside the container. Defaults to `1000` if unset. |
| `UMASK` | Permission mask applied to files created under `/data`. Defaults to `022` if unset. |
| `LOG_LEVEL` | Minimum log level that prints — `debug`, `info`, `warn`, or `error`. Defaults to `info` if unset. Set to `debug` for verbose troubleshooting detail (includes full error stack traces and raw malformed-feed-entry payloads, both hidden above this level). |
| `LOG_FORMAT` | Log line format — `text` (human-readable) or `json` (one JSON object per line, for log aggregators). Defaults to `text` if unset. |
| `TZ` | IANA timezone name (e.g. `America/Chicago`) applied to log timestamps and to the app's own date displays (e.g. the absolute date shown for videos/watches older than 4 weeks). Defaults to UTC if unset. |

### Timezone and log format

`TZ` defaults to UTC if unset. It affects log timestamps and the absolute month/day date
shown for videos/watches that are 4+ weeks old, but it does **not** affect the relative
"Xh/Xd/Xw ago" text most queue items show — that text is computed purely from an
epoch-millisecond difference and is timezone-independent by construction, so most of the UI
won't visibly change even if you set `TZ`.

`LOG_FORMAT=json` is available if you're feeding logs into an aggregator (Loki, CloudWatch,
etc.) that expects one JSON object per line. `LOG_LEVEL=debug` turns on verbose
troubleshooting detail, including full error stack traces that are hidden by default.

## 3. Initial login

Tubeshelf currently has no signup or password-reset flow (real signup/reset is a v2.0
feature — see `docs/app_idea.md`'s Future Roadmap). `AUTH_RECOVERY_PASSWORD` is the *only*
way to set the `admin` user's password:

1. Set `AUTH_RECOVERY_PASSWORD` in `.env` to a password of your choosing.
2. Start (or restart) the container.
3. Log in as `admin` with that password.
4. Remove `AUTH_RECOVERY_PASSWORD` from `.env` and restart the container.

Step 4 matters: as long as `AUTH_RECOVERY_PASSWORD` is set, it overwrites the `admin` user's
password on *every* startup, silently discarding any password you later set through the UI.

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

## 5. Backups

Tubeshelf runs SQLite in WAL mode (`PRAGMA journal_mode = WAL`), which means a live database
isn't just `tubeshelf.db` — it's that file plus `tubeshelf.db-wal` and `tubeshelf.db-shm`
alongside it. To back up correctly:

1. Stop the container: `docker compose stop`
2. Copy all three files from `./data`
3. Restart: `docker compose start`

Stopping first matters: copying just the main `tubeshelf.db` file while the container is
running can capture an inconsistent snapshot, since recently-committed writes may still be
sitting in the `-wal` file rather than the main file.

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

## 7. Reverse proxy

Fronting Tubeshelf with a reverse proxy and TLS termination is your own responsibility — this
guide doesn't include example configuration for any specific proxy tool, since the right
choice depends heavily on your own network setup.

Whatever proxy (or tunnel) you use, make sure `TRUSTED_ORIGINS` (see Configuration above)
lists every public origin you access the app through, exactly as it appears in the browser's
address bar (scheme, host, and port). If a request's `Origin` header isn't on that list,
CSRF-protected (state-changing) requests will be rejected.
