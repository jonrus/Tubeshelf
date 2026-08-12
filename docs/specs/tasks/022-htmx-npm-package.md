# Tasks: Htmx via npm Package Instead of CDN
Spec: docs/specs/022-htmx-npm-package.md
Generated: 2026-08-12

- [x] 1. Add `htmx.org` as an exact-pinned devDependency. Via `devcontainer exec
  --docker-path podman --workspace-folder . bun add -D htmx.org@2.0.4`, then confirm
  `package.json`'s `devDependencies` gained `"htmx.org": "2.0.4"` (exact, no `^`) and
  `bun.lock` was updated. Done when: `package.json` shows the exact pin and `bun.lock`
  contains a resolved `htmx.org@2.0.4` entry.

- [x] 2. Add the guarded `postinstall` script to `package.json`'s `"scripts"` block (adjacent
  to the existing `css:build`/`css:watch` entries), matching the spec's Design section
  exactly:
  ```json
  "postinstall": "test -f node_modules/htmx.org/dist/htmx.min.js && mkdir -p public/js && cp node_modules/htmx.org/dist/htmx.min.js public/js/htmx.min.js || true"
  ```
  Done when: this exact script is present in `package.json`.

- [x] 3. Trigger and verify the copy. Via `devcontainer exec --docker-path podman
  --workspace-folder . bun install`, then check `public/js/htmx.min.js` was created (e.g.
  `devcontainer exec --docker-path podman --workspace-folder . test -f public/js/htmx.min.js
  && echo OK`). Done when: `public/js/htmx.min.js` exists after a normal install. (The
  guard's no-op path — `postinstall` running where `htmx.org` was never installed — is
  verified separately in task 8 via the Dockerfile's actual `--production` install in a
  disposable container, not by mutating this devcontainer's `node_modules` directly.)

- [x] 4. Add `public/js/htmx.min.js` to `.gitignore`, on its own line near the existing
  `public/css/tailwind.css` entry. Done when: `.gitignore` contains both lines and `git
  status` no longer lists `public/js/htmx.min.js` as untracked.

- [x] 5. Add the `/js/*` static route in `src/index.ts`, immediately after the existing
  `app.use("/css/*", serveStatic({ root: "./public" }));` line (currently line 34): `app.use("/js/*", serveStatic({ root: "./public" }));`. Done when: the line is present and
  `bunx tsc --noEmit` still passes.

- [x] 6. Update `src/views/layout.tsx` line 121, replacing
  `<script src="https://unpkg.com/htmx.org@2.0.4" />` with
  `<script src="/js/htmx.min.js" />`. Done when: no reference to `unpkg.com` remains in
  `src/views/layout.tsx`.

- [x] 7. Update `Dockerfile`'s final stage: add a new `COPY --from=build
  /app/public/js/htmx.min.js ./public/js/htmx.min.js` line immediately after the existing
  `COPY --from=build /app/public/css/tailwind.css ./public/css/tailwind.css` line (currently
  line 17). Done when: the line is present in that position.

- [x] 8. Local Docker build verification — this is also the real verification of the
  `postinstall` guard's no-op path, since the final stage's `RUN bun install
  --frozen-lockfile --production` is a genuinely fresh install where `htmx.org` (a
  devDependency) is never installed. Run `podman build -t tubeshelf:htmx-check .` from the
  repo root (host, not inside the devcontainer — this builds the production image itself)
  and confirm it completes with no errors, in particular that neither the build stage's `RUN
  bun install --frozen-lockfile` nor the final stage's `RUN bun install --frozen-lockfile
  --production` fails on the `postinstall` hook. Done when: `podman build` exits 0.

- [x] 9. Verify `public/js/htmx.min.js` actually made it into the built image. Run `podman
  run --rm tubeshelf:htmx-check test -f /app/public/js/htmx.min.js && echo OK`. Done when:
  it prints `OK`.

- [x] 10. Full verification suite. Via `devcontainer exec --docker-path podman
  --workspace-folder .`, run `bun test`, `bun run lint`, and `bunx tsc --noEmit` — all three
  must pass clean. Done when: all three commands exit 0 with no errors/warnings.

- [x] 11. Manual end-to-end verification.

  **Claude performs directly** (via `devcontainer exec --docker-path podman
  --workspace-folder . curl ...` against the running dev server, per the port-forwarding
  gotcha in CLAUDE.md — start `bun run dev` in the container first if not already running):
  - `curl -s -o /dev/null -w "%{http_code}"  http://localhost:3000/js/htmx.min.js` returns
    `200`.
  - `curl -s http://localhost:3000/` (or any authenticated page, adjusting for the
    auth/CSRF flow from spec012 if needed) does **not** contain the string `unpkg.com`.
  - `curl -s http://localhost:3000/js/htmx.min.js | head -c 100` returns recognizable
    minified JS (not an HTML 404 page).

  **User performs live in a browser** (things `curl` can't observe):
  - Load the app, open devtools' Network tab, confirm `htmx.min.js` loads from
    `/js/htmx.min.js` (same-origin, status 200) and there's no request to `unpkg.com`.
  - Confirm no console errors/warnings related to htmx failing to load or initialize.
  - Exercise one htmx-driven interaction that already existed before this change (e.g. mark
    a video watched from the queue view, or toggle a category filter) and confirm it still
    works exactly as before — this spec changes delivery only, not behavior, so this is a
    regression check, not new functionality.

- [x] 12. Update `docs/specs/022-htmx-npm-package.md` frontmatter to `status: implemented`.

- [ ] 13. Open the PR: branch `spec/htmx-npm-package` (already created and holding the spec
  commit), push, and open a GitHub PR with a summary + test plan covering tasks 8-11 above.
  Per CLAUDE.md, check this box *before* pushing so the pushed branch and opened PR both
  reflect a fully-checked-off task file.
