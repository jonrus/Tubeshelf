# Deploying Tubeshelf

Tubeshelf ships as a container image built from source (`Dockerfile`) and run via
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

## 4. Bind-mount permissions

The container runs as the image's non-root `bun` user (uid `1000`). Before first run, make
sure the host directory bind-mounted to `/data` (`./data`, per `docker-compose.yml`) is
writable by that uid:

```
mkdir -p ./data
chown -R 1000:1000 ./data
```

If you skip this, the container fails to boot with a `SQLITE_CANTOPEN` error, since it can't
create `tubeshelf.db` in a directory it doesn't own.

Automatic `PUID`/`PGID` support (linuxserver.io-style, so the container could run as an
arbitrary host uid/gid instead of a fixed `1000`) is deferred — see the corresponding entry
in `docs/app_idea.md`'s Future Roadmap.

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

There's no published registry image yet (that's a later step on the project's roadmap — see
`docs/app_idea.md`'s Path to v1.0), so updating means rebuilding from source:

```
git pull
docker compose up -d --build
```

This section will change once an image is published — at that point, updating will be a
plain `docker compose pull && docker compose up -d` with no local build required.

## 7. Reverse proxy

Fronting Tubeshelf with a reverse proxy and TLS termination is your own responsibility — this
guide doesn't include example configuration for any specific proxy tool, since the right
choice depends heavily on your own network setup.

Whatever proxy (or tunnel) you use, make sure `TRUSTED_ORIGINS` (see Configuration above)
lists every public origin you access the app through, exactly as it appears in the browser's
address bar (scheme, host, and port). If a request's `Origin` header isn't on that list,
CSRF-protected (state-changing) requests will be rejected.
