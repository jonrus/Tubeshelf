---
status: implemented
created: 2026-07-18
---

# Bootstrap Repo Scaffold

## Context

The repo currently contains only `docs/app_idea.md` — no code exists yet. Before
sequencing any MVP feature work (subscribe/channels, RSS ingestion, watch flow, ignore
rules, auth), the technical skeleton needs to be wired end-to-end and proven with one
real (if minimal) page, so later feature specs build on working infrastructure instead of
discovering integration problems mid-feature. This project also doubles as the user's
first exposure to Bun and HTMX (`docs/app_idea.md` §3), so the scaffold favors
conventional, easy-to-reason-about choices over clever ones.

This spec formalizes decisions that were reached in an earlier ad hoc planning session —
before this repo's Spec-Driven Development pattern existed — that were never written down
anywhere durable. Where this spec makes a technology choice, it resolves an open TBD in
`docs/app_idea.md` (see the cross-reference added there).

## Scope

**In:**
- Devcontainer (`.devcontainer/devcontainer.json`, `oven/bun:1` base image) — since `bun`
  isn't installed on either dev host machine, this is the only way to actually run the
  project during development.
- Repo directory scaffold (see Design).
- Bun + TypeScript project setup, Hono web framework, Hono's built-in JSX SSR for
  templating.
- Drizzle ORM (`drizzle-orm/bun-sqlite` + `drizzle-kit`) as the migration tool — resolves
  `docs/app_idea.md` §4's "migration tooling TBD" note.
- Full DB schema for all 5 MVP entities (User, Category, Channel, Video, IgnoreRule) per
  `docs/app_idea.md` §4, with enum CHECK constraints and FK enforcement.
- Idempotent boot-time seed step (default user + "Uncategorized" category).
- Biome for lint + format.
- Tailwind v4 (CSS-first, no bundler) wired via Hono's `serveStatic`.
- `bun test` wired with one real smoke test (migration + seed idempotency).
- One skeleton page (Category list + add) proving the full
  HTMX → Hono → Drizzle → SQLite → JSX round trip.

**Out (deferred to later specs):**
- Production Dockerfile / docker-compose (deployment shape) — no app exists yet to
  containerize for production.
- Auth, CSRF protection.
- RSS ingestion job.
- Watch flow (Watching page, status transitions).
- Ignore-rule matching logic.
- Category rename/delete, channel/video CRUD beyond what the skeleton needs.
- CI/CD pipeline.

## Design

### Stack decisions
- **Web framework: Hono** — Bun-native, ships built-in JSX SSR, so no separate templating
  library or client-side hydration is needed for this server-rendered app.
- **ORM/migrations: Drizzle** (`drizzle-orm/bun-sqlite` driver + `drizzle-kit` for
  migration generation), chosen over hand-rolled versioned SQL + a bespoke runner for
  TS-level type safety across schema and queries, plus `drizzle-kit`'s migration
  generation instead of writing a migration runner from scratch.
- **Templating:** Hono's built-in JSX SSR — no separate templating engine.
- **Lint/format: Biome** — a single tool covers both lint and format, replacing the
  ESLint+Prettier combo the user is used to from their day job.
- **Test runner:** `bun test` (Bun-native, no extra dependency).

### Repo layout

```
Tubeshelf/
├── .devcontainer/devcontainer.json
├── data/.gitkeep                  # dev sqlite file lives here, gitignored
├── docs/app_idea.md               # existing
├── drizzle/                       # drizzle-kit generated SQL migrations — committed
│   ├── 0000_init.sql
│   └── meta/_journal.json
├── public/css/tailwind.css        # build output, gitignored
├── src/
│   ├── index.ts                   # Hono app entry; runs migrate()+seed() at boot
│   ├── db/
│   │   ├── client.ts              # bun:sqlite Database + PRAGMAs + drizzle() wrapper
│   │   ├── schema.ts              # users, categories, channels, videos, ignore_rules
│   │   ├── migrate.ts             # programmatic migrator wrapper
│   │   └── seed.ts                # idempotent seed: Uncategorized category + default user
│   ├── routes/categories.tsx      # GET / (full page), POST /categories (partial swap)
│   ├── views/
│   │   ├── layout.tsx             # <html> shell, Tailwind link, htmx script tag
│   │   ├── categories-page.tsx    # full-page JSX wrapping the list partial
│   │   └── categories-list.tsx    # <div id="category-list"> partial: <ul> + add form
│   └── styles/input.css           # `@import "tailwindcss";`
├── test/smoke.test.ts
├── .env.example
├── .gitignore
├── biome.json
├── drizzle.config.ts
├── package.json
├── tsconfig.json
└── README.md
```

### Database schema (`src/db/schema.ts`)

Models the `docs/app_idea.md` §4 data model directly: `User` (single implicit row for
MVP, real table so v2 multi-user needs no breaking migration), `Category` (`isSystem`
boolean flags the one Uncategorized row — more robust than string-matching the name,
since renames are allowed), `Channel` (FK to Category and User, unique
`youtube_channel_id`), `Video` (FK to Channel, unique `youtube_video_id` for
upsert-based ingestion later, `status` enum `unwatched|watching|watched|ignored`,
`ignore_method` enum `manual|auto|null`), `IgnoreRule` (global keyword list).

SQLite has no native enum: use Drizzle's `text(..., { enum: [...] })` for TS-level
narrowing, plus an explicit SQL `CHECK` constraint per enum column for DB-level
enforcement (Drizzle's TS enum alone doesn't emit a CHECK). Foreign keys need
`PRAGMA foreign_keys = ON` set per-connection in `client.ts` — SQLite doesn't enforce FKs
by default even when declared in the schema.

```ts
import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash"), // nullable now; auth is out of scope
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

export const channels = sqliteTable("channels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  categoryId: integer("category_id").notNull().references(() => categories.id),
  youtubeChannelId: text("youtube_channel_id").notNull().unique(),
  name: text("name").notNull(),
  rssUrl: text("rss_url").notNull(),
  possibleMissedVideos: integer("possible_missed_videos", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

export const videos = sqliteTable("videos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  channelId: integer("channel_id").notNull().references(() => channels.id),
  youtubeVideoId: text("youtube_video_id").notNull().unique(), // upsert key
  title: text("title").notNull(),
  description: text("description"),
  publishedAt: integer("published_at", { mode: "timestamp" }),
  status: text("status", { enum: ["unwatched", "watching", "watched", "ignored"] }).notNull().default("unwatched"),
  ignoreMethod: text("ignore_method", { enum: ["manual", "auto"] }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (t) => [
  check("status_check", sql`${t.status} in ('unwatched','watching','watched','ignored')`),
  check("ignore_method_check", sql`${t.ignoreMethod} is null or ${t.ignoreMethod} in ('manual','auto')`),
]);

export const ignoreRules = sqliteTable("ignore_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  keyword: text("keyword").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
```

> Implementation note: verify the `check()` array-callback syntax (`(t) => [check(...), ...]`,
> shown above) against whatever Drizzle version actually resolves — this callback shape has
> shifted between Drizzle releases, so double-check the installed version's docs rather than
> trusting this snippet blindly. (Also tracked in Open Questions.)

### Seed strategy: idempotent seed step run at boot, separate from migrations

`drizzle-kit generate` migrations should stay pure schema DDL — hand-editing a generated
migration file to add seed `INSERT`s is fragile, since future `generate` runs diff against
`schema.ts` and have no awareness of manually-added data statements. Instead,
`src/db/seed.ts` runs every boot, right after migrations, and is idempotent (checks before
inserting):

```ts
// src/db/seed.ts
import { eq } from "drizzle-orm";
import { categories, users } from "./schema";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

export function seed(db: BunSQLiteDatabase) {
  const uncategorized = db.select().from(categories).where(eq(categories.name, "Uncategorized")).get();
  if (!uncategorized) {
    db.insert(categories).values({ name: "Uncategorized", isSystem: true }).run();
  }
  const anyUser = db.select().from(users).get();
  if (!anyUser) {
    db.insert(users).values({ username: "default" }).run();
  }
}
```

`bun:sqlite`/`drizzle-orm/bun-sqlite` is a synchronous driver — no `async`/`await` needed
here or in the migrator call. Boot sequence in `src/index.ts`: run migrations → `seed(db)`
→ start the Hono server. Running seed every boot (not a one-time install step) is what
makes `docker compose pull && restart` safe for both fresh installs and existing ones, per
`docs/app_idea.md`'s scalability note.

### Skeleton page: real `categories` table, list + create only

Uses the actual `Category` entity rather than a throwaway demo table — it's genuinely
future-shaped code, has no dependent FKs to fake, and still exercises the full
HTMX → Hono → Drizzle → SQLite → JSX round trip.

- `GET /` — full page: queries all categories (system row first, then alphabetical),
  renders a `<ul>` (Uncategorized tagged `[system]`) plus an add-category `<form>`, wrapped
  in `<div id="category-list">…</div>`.
- Form: `hx-post="/categories" hx-target="#category-list" hx-swap="outerHTML"`.
- `POST /categories` (`src/routes/categories.tsx`): trims the name; rejects empty and
  rejects case-insensitive `"uncategorized"` (reserved) with an inline error instead of a
  500; catches the unique-constraint violation for duplicate names the same way; on
  success, re-queries the list and returns just the list partial (including the form again,
  so the next submit still has a target).

No rename/delete/update logic — out of scope for this skeleton.

### Devcontainer

No official Bun devcontainer feature exists (oven-sh declined to add one to
devcontainers/features). Use the official `oven/bun:1` image directly as the base image —
simpler than a third-party community feature, and self-contained regardless of host OS
(works identically on both the user's Bazzite and plain Fedora machines since everything
runs inside the container).

```jsonc
{
  "name": "Tubeshelf",
  "image": "oven/bun:1",
  "features": {
    "ghcr.io/devcontainers/features/git:1": {},
    "ghcr.io/devcontainers/features/github-cli:1": {}
  },
  "customizations": {
    "vscode": {
      "extensions": ["biomejs.biome", "bradlc.vscode-tailwindcss", "eamodio.gitlens"],
      "settings": {
        "editor.defaultFormatter": "biomejs.biome",
        "editor.formatOnSave": true,
        "[typescript]": { "editor.defaultFormatter": "biomejs.biome" },
        "[typescriptreact]": { "editor.defaultFormatter": "biomejs.biome" }
      }
    }
  },
  "postCreateCommand": "bun install && bun run css:build",
  "forwardPorts": [3000],
  "portsAttributes": { "3000": { "label": "Tubeshelf web" } }
}
```

At implementation time, check whether `oven/bun:1` has a non-root user to set via
`remoteUser` — not confirmed in research, verify when the container actually builds.
(Also tracked in Open Questions.)

`.gitignore`: `node_modules/`, `data/*.db*`, `public/css/tailwind.css`, `.env`.

**Operational note — accessing `bun` from Claude Code sessions:** Claude Code runs on the
host, not inside an editor-integrated devcontainer, so `/work-task` sessions reach `bun`
via the `devcontainer` CLI (`@devcontainers/cli`, installed via `brew install devcontainer`
on this host — pulls in `node`) pointed at podman: `devcontainer up --docker-path podman
--workspace-folder .` to build/start (idempotent, safe to rerun), then `devcontainer exec
--docker-path podman --workspace-folder . <command>` to run anything inside it. `up` exits
non-zero whenever `postCreateCommand` fails (e.g. before `package.json` exists) but the
container keeps running regardless, so `exec` still works.

### Tailwind wiring (no bundler)

Tailwind v4, CSS-first config (no `tailwind.config.js` needed for this simple case).
`bun add -D tailwindcss @tailwindcss/cli`. `src/styles/input.css` contains
`@import "tailwindcss";`. Build/watch scripts write to `public/css/tailwind.css`, served
via Hono's `serveStatic` (`import { serveStatic } from "hono/bun"`, mounted at `/css/*`).
`layout.tsx` links that stylesheet and pulls htmx from a version-pinned CDN tag
(`https://unpkg.com/htmx.org@2.0.4`) — vendoring can happen later. Tailwind v4 auto-scans
`.tsx` files for class usage by default; if detection ever misses files, add an explicit
`@source` line to `input.css`. `bun add -D concurrently` so `bun run dev` runs the Hono
`--hot` server and the Tailwind watcher together.

### Biome (`biome.json`)

Start with the `recommended` rule preset only, format settings matching common TS
conventions (2-space indent, double quotes, semicolons), ignoring `drizzle/**` and the
generated Tailwind CSS output. No custom rule tuning yet — revisit once real feature code
exists.

### Testing (`test/smoke.test.ts`)

One real smoke test (not a no-op): spins up an isolated **in-memory** SQLite DB, runs the
actual committed migrations against it, then runs `seed()` **twice** to prove idempotency,
then asserts there's exactly one `Uncategorized`/`isSystem` category and exactly one user
row. This is genuinely small but exercises the real migration files and seed logic
together, and never touches the dev-time `data/` database.

### package.json scripts

```json
{
  "scripts": {
    "dev": "concurrently -k -n server,css \"bun run dev:server\" \"bun run css:watch\"",
    "dev:server": "bun run --hot src/index.ts",
    "start": "bun run src/index.ts",
    "css:build": "tailwindcss -i ./src/styles/input.css -o ./public/css/tailwind.css --minify",
    "css:watch": "tailwindcss -i ./src/styles/input.css -o ./public/css/tailwind.css --watch",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "format": "biome format --write .",
    "test": "bun test",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio"
  }
}
```

Dependencies: `hono`, `drizzle-orm`. Dev dependencies: `drizzle-kit`, `tailwindcss`,
`@tailwindcss/cli`, `concurrently`, `@biomejs/biome`, `@types/bun`. `db:migrate` (the
drizzle-kit CLI) is a manual dev-time convenience; actual auto-migration on
`docker compose pull` happens via the programmatic migrator baked into `src/index.ts`'s
boot sequence, consuming the same committed `drizzle/*.sql` files either way.

`drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DB_FILE_NAME ?? "./data/tubeshelf.db" },
});
```

`src/db/client.ts`:
```ts
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

const sqlite = new Database(process.env.DB_FILE_NAME ?? "./data/tubeshelf.db");
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

export const db = drizzle(sqlite);
export { sqlite };
```

`tsconfig.json` key fields: `"jsx": "react-jsx"`, `"jsxImportSource": "hono/jsx"`,
`"moduleResolution": "bundler"`, `"strict": true`, `"types": ["bun-types"]`.

### Verification (end-to-end proof the skeleton works)

1. `bun install`.
2. `bun run db:generate` — confirm `drizzle/0000_*.sql` contains `CREATE TABLE` for all
   five tables, including the two `CHECK` constraints on `videos`.
3. `bun run css:build` — confirm `public/css/tailwind.css` is created and non-empty.
4. `bun run dev:server` — server logs migration/seed completion, listens on port 3000.
5. Open `http://localhost:3000/` — page shows "Uncategorized [system]" and an add-category
   form, visibly Tailwind-styled; Network tab shows `GET /css/tailwind.css` → 200.
6. Submit a new category (e.g. `Podcasts`) — Network tab shows `POST /categories`
   returning an HTML fragment with no full navigation/URL change; the list updates in
   place.
7. Reload with a full `GET /` — `Podcasts` still appears (proves it's not just an
   in-memory DOM update).
8. Kill the dev server, restart it, reload the page — `Podcasts` still appears (proves
   it's on disk, not held in process memory).
9. Confirm WAL mode is active two ways while the server runs: `ls data/` shows
   `tubeshelf.db`, `tubeshelf.db-wal`, and `tubeshelf.db-shm` together; and
   `bun -e "import { Database } from 'bun:sqlite'; console.log(new Database('./data/tubeshelf.db').query('PRAGMA journal_mode').get())"`
   prints `{ journal_mode: 'wal' }`.
10. Submit `Uncategorized` (any case) into the form — expect an inline error in the
    returned fragment, not a 500, confirming the reserved-name and unique-constraint
    checks.
11. `bun test` — the smoke test passes independently of whatever state steps 5–10 left in
    `data/tubeshelf.db`.
12. `bun run lint` and `bun run format` — freshly scaffolded code is Biome-clean.

## Open Questions

- Whether `oven/bun:1` has a non-root user to wire via `remoteUser` — unconfirmed in prior
  research; verify when the container actually builds.
- Confirm Drizzle's `check()` array-callback syntax (`(t) => [check(...), ...]`) against
  whatever Drizzle version resolves at install time — this shape has shifted across
  Drizzle releases.
