---
status: implemented
created: 2026-08-12
---

# Htmx via npm Package Instead of CDN

## Context

`src/views/layout.tsx` currently loads htmx from a CDN:

```html
<script src="https://unpkg.com/htmx.org@2.0.4" />
```

This makes page loads depend on unpkg being reachable at runtime, which is undesirable for
a self-hosted app (see docs/specs/014-deployment-docker-packaging.md and
docs/specs/017-puid-pgid-support.md — this app is meant to run standalone, potentially
behind a tunnel, without assuming outbound internet access from the browser's perspective
being guaranteed at every page load). It's also inconsistent with how the project already
handles Tailwind CSS: Tailwind is a devDependency, built into `public/css/tailwind.css` by
the `css:build`/`css:watch` scripts, and served locally via `serveStatic` (`src/index.ts`,
lines 34-36). htmx should follow the same self-hosted-static-asset pattern.

`docs/app_idea.md` (line 120) names "HTMX + Tailwind CSS" as the frontend choice; this spec
is a delivery-mechanism change only and doesn't alter that decision, so no edit to that doc
is needed.

Confirmed while researching this spec: unpkg's bare `htmx.org@2.0.4` URL resolves via that
package version's `"unpkg": "dist/htmx.min.js"` field in its own `package.json` — i.e. the
CDN was already serving the minified build, not source. The CDN tag also carries no
`integrity`/`crossorigin` attributes, so there's no Subresource Integrity handling to carry
over.

## Scope

**In:**

- Add `htmx.org` as a **devDependency**, pinned to the **exact version already in use,
  `2.0.4`** (no `^` range) — this spec is a delivery-mechanism swap only, not a version
  upgrade (current npm latest is 2.0.10; upgrading is deliberately deferred to a future,
  separate change).
- Add a root-level `"postinstall"` script to `package.json` that creates `public/js/` if
  needed and copies `node_modules/htmx.org/dist/htmx.min.js` to `public/js/htmx.min.js`,
  **only if that source file exists** — e.g. `test -f
  node_modules/htmx.org/dist/htmx.min.js && mkdir -p public/js && cp
  node_modules/htmx.org/dist/htmx.min.js public/js/htmx.min.js || true`. This runs
  automatically after every `bun install` (root-project lifecycle scripts always run under
  Bun; this is distinct from the `trustedDependencies` mechanism, which gates *dependency*
  postinstall scripts and doesn't apply here). The existence guard is required, not
  defensive-for-its-own-sake — see Design for why.
- Add `public/js/htmx.min.js` to `.gitignore`, alongside the existing
  `public/css/tailwind.css` entry — it's a generated artifact, not source.
- Add a `/js/*` `serveStatic` route in `src/index.ts`, mirroring the existing `/css/*`
  route.
- Update `layout.tsx` to reference `/js/htmx.min.js` instead of the CDN URL.
- Update `Dockerfile`'s build stage: it already runs `bun install --frozen-lockfile` (full
  dependency set, including devDependencies) before `bun run css:build`, so the
  `postinstall` copy will have already produced `public/js/htmx.min.js` by that point with
  no extra RUN step needed. Add a `COPY --from=build /app/public/js/htmx.min.js
  ./public/js/htmx.min.js` line to the final stage, mirroring the existing
  `public/css/tailwind.css` copy.
- No change needed to `bun run dev`/the `concurrently` dev command — `bun install` (run
  manually or as part of initial devcontainer setup) already triggers the copy; there is no
  dev-time watcher to add, see Design below.

**Out:**

- Upgrading htmx past `2.0.4`.
- Introducing a bundler (esbuild, webpack, etc.) — htmx's `dist/htmx.min.js` is already a
  standalone script with no build/transform step required beyond the file copy.
- Any change to how htmx is used within the app (attributes, extensions, swap behavior,
  etc.) — purely a delivery-mechanism change.
- Self-hosting htmx's optional extensions (`dist/ext/*.js`) — the app doesn't currently use
  any; only the core `htmx.min.js` is in scope.

## Design

**Why a `postinstall` hook instead of mirroring `css:build`/`css:watch` literally:**
Tailwind's output changes on every class edit during development, which is what
`css:watch` exists for. `htmx.org`'s `dist/htmx.min.js` is static once installed — it only
changes when the *package version* changes, which only happens via an explicit `bun add`/
`bun update`. A file watcher would have nothing to watch for during normal development. A
`postinstall` script fires exactly when the file could change (right after install/update)
with no added dev-time process, so it's a deliberately different mechanism from
`css:build`/`css:watch`, not an inconsistency.

**Why devDependency, not a runtime dependency:** `htmx.org` is only needed to produce the
static file at install/build time; nothing at runtime `import`s or `require`s it. The
production Docker stage's `bun install --frozen-lockfile --production` intentionally skips
devDependencies (as it already does for `tailwindcss`), and the final stage receives the
already-built `public/js/htmx.min.js` via `COPY --from=build`, the same way it receives
`public/css/tailwind.css` today — the final stage doesn't need `htmx.org` installed at all.

**Why the postinstall copy needs an existence guard (caught in red-team review, see Open
Questions):** unlike `css:build`, which is an *explicit* script never invoked in the
Dockerfile's production stage, `postinstall` is a *lifecycle hook* that fires unconditionally
on every `bun install` — including the production stage's `bun install --frozen-lockfile
--production`. At that point `htmx.org` (a devDependency) was deliberately never installed,
so `node_modules/htmx.org/dist/htmx.min.js` won't exist, and an unguarded `cp` would exit
non-zero and fail `RUN bun install --frozen-lockfile --production`, breaking the Docker
build outright — before the build ever reaches the `COPY --from=build` line that was
supposed to supply the real file. The guard makes the production-stage postinstall a
harmless no-op; the actual file still reaches the final image via `COPY --from=build`, same
as `tailwind.css`. `mkdir -p public/js` is included in the same script because `public/js/`
doesn't exist yet in this repo (verified: `public/` currently only has `css/`, `icons/`, and
`manifest.json`) and a bare `cp` won't create its target directory.

**File location and serving:** `public/js/htmx.min.js`, gitignored like
`public/css/tailwind.css`, served by a new `app.use("/js/*", serveStatic({ root: "./public"
}))` route (mirrors the existing `/css/*` and `/icons/*` routes at `src/index.ts:34-35`).
`layout.tsx`'s `<script src="https://unpkg.com/htmx.org@2.0.4" />` becomes `<script
src="/js/htmx.min.js" />`.

**Devcontainer / fresh-checkout behavior:** anyone running `bun install` for the first time
(devcontainer `postCreateCommand`, or a manual install) gets `public/js/htmx.min.js`
produced automatically as a side effect, same as how `public/css/tailwind.css` isn't
present until `css:build`/`css:watch` runs — except htmx's copy needs no separate script
invocation at all, install alone is sufficient.

One asymmetry worth naming: someone pulling this change into an *existing* checkout who
doesn't re-run `bun install` (package.json changed but they skip install) will hit a silent
404 on `/js/htmx.min.js` rather than a build-time error — htmx just won't load and the app
degrades quietly (no interactivity, no crash). This is the same class of gap that already
exists for `public/css/tailwind.css` today (skip `css:build` after a Tailwind config change
and styles are just stale/missing, no error either), so it's consistent with the project's
existing tradeoffs rather than a new one — not fixed as part of this spec, noted here so
`/spec-tasks` can decide whether a task-file verification step should call it out
explicitly.

## Open Questions

None. Settled during this session via three clarifying questions (copy-trigger mechanism,
version pinning strategy, minified vs. unminified dist file) before drafting, then verified
against the actual npm package contents (confirmed `dist/htmx.min.js` exists and is what
unpkg was already serving via the package's own `"unpkg"` field).

**Red-team retrospective:** one independent review pass was run against the initial draft.
It confirmed the `serveStatic` route setup, the Dockerfile stage split, the `.gitignore`
treatment, and the absence of any existing `postinstall` script or other stale CDN
references — but caught a real build-breaking gap: the unguarded `postinstall` copy would
fail (missing source file) during the Docker production stage's `bun install
--frozen-lockfile --production`, since `htmx.org` is deliberately a devDependency skipped
there, causing `RUN bun install ... --production` itself to fail and break the image build
entirely. Fixed by adding an existence guard (`test -f ... && ... || true`) to the
`postinstall` script, documented in Design above, plus a `mkdir -p public/js` since that
directory doesn't exist in the repo yet (also flagged by the same pass). A second,
narrower pass was scoped only to the fixed `postinstall` script and Design rationale (not a
full re-review) and found the guard sound: it makes the production-stage postinstall a
no-op while the real file still reaches the final image via the existing `COPY
--from=build` mechanism.
