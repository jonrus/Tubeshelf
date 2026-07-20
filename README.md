# Tubeshelf

See `docs/app_idea.md` for the product spec.

## Development

This project runs inside a devcontainer (`.devcontainer/devcontainer.json`), based on the
`oven/bun:1` image, since `bun` isn't installed on the host. On this project's dev machines
(Bazzite/Fedora), the Dev Containers extension is already configured to use **podman**
rather than Docker as its backend — no extra setup is needed beyond that.

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
4. Run tests:
   ```
   bun test
   ```
