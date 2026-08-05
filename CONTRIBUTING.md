# Contributing

Tubeshelf isn't accepting outside pull requests yet — this file exists so a fork is
workable in the meantime, not as an open invitation to PR.

## Dev environment

See `README.md`'s Development section for the devcontainer setup.

## Development pattern

This project uses Spec-Driven Development — see `CLAUDE.md` at the repo root.

## Running checks locally

```
bun test
bun run lint
bunx tsc --noEmit
```
(Run these inside the devcontainer — see `README.md`'s Development section.)

## Building and running from source

Instead of the published `ghcr.io/jonrus/tubeshelf` image:
```
docker build -t ghcr.io/jonrus/tubeshelf:1 .
docker compose up -d
```
`docker compose up` only builds or pulls when no local image already matches
`docker-compose.yml`'s `image:` tag — a locally-built image tagged to match
short-circuits the pull, so this works with no other changes to `docker-compose.yml`.
