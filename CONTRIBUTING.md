# Contributing

Tubeshelf isn't accepting outside pull requests yet — this file exists so a fork is
workable in the meantime, not as an open invitation to PR.

## Dev environment

Development happens inside a devcontainer (`.devcontainer/devcontainer.json`, based on the
`oven/bun:1` image), so `bun` doesn't need to be installed on the host. Podman works as the
Dev Containers backend as well as Docker.

1. Open the repo in your editor and reopen it in the devcontainer (Dev Containers
   extension).
2. Install dependencies:
   ```
   bun install
   ```
3. Start the dev server (Hono with hot reload + Tailwind watcher):
   ```
   bun run dev
   ```
   The app listens on [http://localhost:3000](http://localhost:3000).

## Development pattern

This project uses Spec-Driven Development — see `CLAUDE.md` at the repo root.

## Running checks locally

```
bun test
bun run lint
bunx tsc --noEmit
bun run fallow
```
(Run these inside the devcontainer.)

## Building and running from source

Instead of the published `ghcr.io/jonrus/tubeshelf` image:
```
docker build -t ghcr.io/jonrus/tubeshelf:latest .
docker compose up -d
```
`docker compose up` only builds or pulls when no local image already matches
`docker-compose.yml`'s `image:` tag — a locally-built image tagged to match
short-circuits the pull, so this works with no other changes to `docker-compose.yml`.
