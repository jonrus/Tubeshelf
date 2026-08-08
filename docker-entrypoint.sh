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
