# Tasks: Queue as Root Route
Spec: docs/specs/010-queue-as-root-route.md
Generated: 2026-07-28

- [x] 1. Move Categories' index page from `GET /` to `GET /categories`, and repoint its nav
  link:
  - `src/routes/categories.tsx`: change `categoriesRoute.get("/", (c) => { ... })` (currently
    lines 49-57) to `categoriesRoute.get("/categories", (c) => { ... })`, body unchanged.
    This now sits alongside the router's existing `POST /categories`
    (`categoriesRoute.post("/categories", ...)`), `GET /categories/:id/edit`, and
    `POST /categories/:id` handlers.
  - `src/views/layout.tsx:32`: change `<a href="/">Categories</a>` to
    `<a href="/categories">Categories</a>`. Leave the rest of the nav (including the
    `<a href="/queue">Queue (...)</a>` link) untouched.
  - `test/routes/categories.test.ts:275`: change `categoriesRoute.request("/")` to
    `categoriesRoute.request("/categories")` in the
    `"GET / renders a category's unwatched count and a link to its filtered queue"` test.
    Rename that test's description to `"GET /categories renders a category's unwatched
    count and a link to its filtered queue"` for accuracy. No assertion logic changes.
  Done when: `bun test test/routes/categories.test.ts` passes, and
  `categoriesRoute.request("/")` no longer appears anywhere in the test suite.

- [x] 2. Add the root redirect on `queueRoute`:
  - `src/routes/queue.tsx`: immediately before the existing
    `queueRoute.get("/queue", (c) => { ... })` handler (currently at line 276), add:
    ```ts
    queueRoute.get("/", (c) => c.redirect("/queue", 302));
    ```
    No other changes to this file — this handler has no business logic, matching the
    spec's Design section.
  - `test/routes/queue.test.ts`: add a new test (place it near the top of the file, before
    the first `/queue`-view test, since it doesn't depend on any seeded fixtures):
    ```ts
    test("GET / redirects to /queue", async () => {
      const res = await queueRoute.request("/");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/queue");
    });
    ```
    This matches the existing status/location assertion pattern already used in this file
    (e.g. the `POST /videos/:id/watched-toggle` redirect tests around line 532).
  Done when: `bun test test/routes/queue.test.ts` passes, including the new test above.

- [x] 3. Final verification. Run `bun test`, `bun run lint`, and `bunx tsc --noEmit` clean
  across the repo (all three, per CLAUDE.md's requirement on a spec's last task-file step).
  Then do manual end-to-end verification, split per CLAUDE.md's convention:
  - **Claude performs directly** (via `curl` inside the devcontainer, per the
    port-forwarding gotcha in CLAUDE.md):
    - `curl -i http://localhost:3000/` returns `HTTP/1.1 302` with a `location: /queue`
      response header (use `-i`/`-D -` so redirect headers are visible; a bare `curl`
      would silently follow the redirect and only show `/queue`'s body).
    - `curl http://localhost:3000/categories` returns 200 with the Categories page HTML
      (category list, `Uncategorized` system row present).
    - `curl http://localhost:3000/` **without** `-L`/follow-redirects behavior does *not*
      return the Categories page body (confirms `/` no longer serves Categories directly).
    - `curl http://localhost:3000/channels` still returns 200 (confirms the nav-adjacent
      `channelsRoute` mount was unaffected by this change).
  - **User performs live in a browser**:
    - Visit the bare app root (e.g. `http://localhost:3000/`) and confirm the browser lands
      on the Queue page — URL bar shows `/queue` after the redirect, page content is the
      queue list, not Categories.
    - Click the "Categories" nav link from the Queue page and confirm it navigates to
      `/categories` showing the same Categories management page as before (category list,
      create/rename still work — this logic didn't change, just its path).
  Done when: all three commands are clean, Claude's curl-based checks above all pass, and
  the user confirms the browser-only checks. Then update
  `docs/specs/010-queue-as-root-route.md`'s frontmatter to `status: implemented`.
