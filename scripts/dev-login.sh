#!/usr/bin/env bash
# Dev-only helper for manual verification: logs into a locally running Tubeshelf
# instance and writes a session cookie jar, so Claude (or a human) can curl
# auth-gated routes without re-deriving the login form fields / CSRF Origin
# requirement from src/lib/auth.ts and src/routes/auth.tsx each time.
#
# Not referenced by Dockerfile/docker-entrypoint.sh, so it never ships in the
# build image.
#
# Usage:
#   scripts/dev-login.sh [cookie-jar-path] [base-url]
#
# Password source (first match wins): $DEV_LOGIN_PASSWORD, then
# $AUTH_RECOVERY_PASSWORD (already set to "dev-password-change-me" in
# .devcontainer/devcontainer.json's containerEnv, so no extra setup is needed
# when running via `devcontainer exec`).
#
# Example:
#   devcontainer exec --docker-path podman --workspace-folder . scripts/dev-login.sh
#   devcontainer exec --docker-path podman --workspace-folder . \
#     curl -b /tmp/tubeshelf-dev-cookies.txt http://localhost:3000/queue

set -euo pipefail

COOKIE_JAR="${1:-/tmp/tubeshelf-dev-cookies.txt}"
BASE_URL="${2:-http://localhost:3000}"
USERNAME="${DEV_LOGIN_USERNAME:-admin}"
PASSWORD="${DEV_LOGIN_PASSWORD:-${AUTH_RECOVERY_PASSWORD:-}}"

if [ -z "$PASSWORD" ]; then
  echo "No password available: set DEV_LOGIN_PASSWORD or AUTH_RECOVERY_PASSWORD" >&2
  exit 1
fi

status=$(curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' \
  -H "Origin: $BASE_URL" \
  --data-urlencode "username=$USERNAME" \
  --data-urlencode "password=$PASSWORD" \
  "$BASE_URL/login")

if [ "$status" != "302" ]; then
  echo "Login failed (HTTP $status) — check credentials or that the app is running at $BASE_URL" >&2
  exit 1
fi

echo "Logged in as $USERNAME. Cookie jar: $COOKIE_JAR"
echo "Use with: curl -b $COOKIE_JAR $BASE_URL/..."
