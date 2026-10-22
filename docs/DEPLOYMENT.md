# Deploying Tubeshelf

Tubeshelf ships as a prebuilt image on GHCR, run via `docker-compose.yml`. Examples use
`docker compose`; with podman, substitute `podman compose` (or `podman-compose`, whichever
your host has).

## 1. Quick start

1. Clone the repo and `cd` into it.
2. Optional: copy `.env.example` to `.env` and fill in the values you need (see Configuration
   below). The stack starts without one, using defaults:
   ```
   cp .env.example .env
   ```
   A missing `.env` is tolerated via `env_file`'s `required: false`, which needs Docker
   Compose 2.24 or newer.
3. Start the stack:
   ```
   docker compose up -d
   ```
   The app listens on the host port from `docker-compose.yml`'s `ports:` mapping (`3000` by
   default). Change the host-side (left) number freely if `3000` is taken; leave the
   container-side (right) `3000` alone — the app always listens on it.
4. Unless you set `AUTH_RECOVERY_PASSWORD`, find the generated admin password in the logs
   (see Initial login below):
   ```
   docker compose logs tubeshelf
   ```

## 2. Configuration

All configuration is via environment variables, set in `.env` (loaded by `docker-compose.yml`'s
optional `env_file:` entry). `.env.example` has the full comments on each; this table is a
quick reference:

| Variable | Purpose |
| :--- | :--- |
| `DB_FILE_NAME` | Path to the SQLite database file. Already set to `/data/tubeshelf.db` in `docker-compose.yml` to match the bind mount — leave unset in `.env`. |
| `AUTH_RECOVERY_PASSWORD` | If set, the admin user's password is forced to this value on startup (and all sessions are signed out). If unset, a random password is generated and logged once on first boot. See Initial login. |
| `TRUSTED_ORIGINS` | Comma-separated list of origins allowed to make CSRF-protected requests. Defaults to `http://localhost:3000`. Must include every public origin you access the app through. Also decides the session cookie's `Secure` flag: Secure iff any entry is `https://`, unless the request matches an `http://` entry (`Origin`, else `Host`). So with an `https://` entry, plain-http access at a non-listed host (LAN IP, `127.0.0.1`) loses its session, because browsers drop the cookie. Mixed http+https lists are for local development only; in production list only `https://` origins. |
| `PUID` | User ID the app process runs as inside the container. Defaults to `1000` if unset. |
| `PGID` | Group ID the app process runs as inside the container. Defaults to `1000` if unset. |
| `UMASK` | Permission mask applied to files created under `/data`. Defaults to `022` if unset. |
| `LOG_LEVEL` | Minimum level that prints: `debug`, `info`, `warn`, or `error`. Defaults to `info`. `debug` adds troubleshooting detail (full error stack traces, raw malformed-feed-entry payloads). |
| `LOG_FORMAT` | `text` (human-readable, the default) or `json` (one object per line, for log aggregators such as Loki or CloudWatch). |
| `TZ` | IANA timezone name (e.g. `America/Chicago`) for log timestamps and the absolute dates shown for videos/watches older than 4 weeks. Defaults to UTC. The relative "Xh/Xd/Xw ago" text is timezone-independent, so most of the UI won't visibly change. |
| `YOUTUBE_API_KEY` | Optional. Enables background enrichment of video duration via the YouTube Data API v3 (`videos.list`). Unset (or blank) disables the feature entirely. |

## 3. Initial login

Tubeshelf has no signup, and no in-app way to change or reset the password. Two ways to get
a working `admin` login:

**Generated password (default).** If the `admin` user has no password yet — i.e. a fresh
database — Tubeshelf generates a random one on first boot and logs it once, at WARN level:

```
docker compose logs tubeshelf
```

Look for the line naming the `admin` user and the generated password. Log in as `admin` with
it. It is shown only that one time; the hash is stored immediately, so later boots don't
repeat it. If you run with `LOG_LEVEL=error`, the WARN line is hidden and will not be
re-emitted on the next boot — use the recovery flow below instead.

**Choosing or recovering a password (`AUTH_RECOVERY_PASSWORD`).** To set your own password,
or replace a generated or lost one:

1. Set `AUTH_RECOVERY_PASSWORD` in `.env` to a password of your choosing.
2. Start (or restart) the container.
3. Log in as `admin` with that password.
4. Remove `AUTH_RECOVERY_PASSWORD` from `.env` and restart the container.

Step 4 matters: leaving the variable set keeps the password in plaintext in `.env` and logs
a warning on every boot.

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
docker compose pull
docker compose up -d
```

`docker-compose.yml` uses the `ghcr.io/jonrus/tubeshelf:latest` image, so `docker compose
pull` fetches the newest release; database migrations run automatically on startup. Check
the [release notes](https://github.com/jonrus/Tubeshelf/releases) before updating if you
want to know what's changing. To hold back upgrades, pin a specific tag in the compose file
instead (`:1` for the major version, `:1.6` or `:1.6.3` for tighter control). Re-download
`docker-compose.yml` (or `git pull`, if you cloned the repo) only to pick up compose-file
changes. No `docker login` step is needed: the GHCR package is public.

## 7. Reverse proxy

Fronting Tubeshelf with a reverse proxy and TLS termination is your own responsibility — this
guide doesn't include example configuration for any specific proxy tool, since the right
choice depends heavily on your own network setup.

Whatever proxy (or tunnel) you use, make sure `TRUSTED_ORIGINS` (see Configuration above)
lists every public origin you access the app through, exactly as it appears in the browser's
address bar (scheme, host, and port). If a request's `Origin` header isn't on that list,
CSRF-protected (state-changing) requests will be rejected.
