import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { loginAsAdminUser } from "../helpers/auth";

// ignoreRulesRoute operates against the module-level `db` singleton in
// src/db/client.ts, which reads DB_FILE_NAME at import time -- so it must be
// set before that module (or anything importing it) is first loaded.
process.env.DB_FILE_NAME = ":memory:";

const { db } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { ignoreRules, videos, youtubeChannels } = await import(
  "../../src/db/schema"
);
const { seed } = await import("../../src/db/seed");
const { ignoreRulesRoute } = await import("../../src/routes/ignore-rules");

migrate(db, { migrationsFolder: "./drizzle" });
seed(db);

const { cookie, origin } = await loginAsAdminUser();
const authHeaders = { Cookie: cookie, Origin: origin };

const channel = db
  .insert(youtubeChannels)
  .values({
    youtubeChannelId: "UCignorerulesroute01",
    name: "Ignore Rules Route Test Channel",
    rssUrl:
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCignorerulesroute01",
  })
  .returning()
  .get();

let videoCounter = 0;
function makeVideo(options: {
  title: string;
  status?: "unwatched" | "watching" | "watched" | "ignored";
  ignoreMethod?: "manual" | "auto" | null;
}) {
  videoCounter += 1;
  return db
    .insert(videos)
    .values({
      channelId: channel.id,
      youtubeVideoId: `vid-ignore-rules-route-${videoCounter}`,
      title: options.title,
      status: options.status ?? "unwatched",
      ignoreMethod: options.ignoreMethod ?? null,
    })
    .returning()
    .get();
}

function makeRule(keyword: string) {
  return db.insert(ignoreRules).values({ keyword }).returning().get();
}

function videoRow(id: number) {
  const row = db.select().from(videos).where(eq(videos.id, id)).get();
  if (!row) throw new Error(`video ${id} not found`);
  return row;
}

function postAdd(keyword: string) {
  return ignoreRulesRoute.request("/ignore-rules", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...authHeaders,
    },
    body: new URLSearchParams({ keyword }),
  });
}

function postEdit(id: number, keyword: string) {
  return ignoreRulesRoute.request(`/ignore-rules/${id}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...authHeaders,
    },
    body: new URLSearchParams({ keyword }),
  });
}

function deleteRule(id: number) {
  return ignoreRulesRoute.request(`/ignore-rules/${id}`, {
    method: "DELETE",
    headers: authHeaders,
  });
}

test("GET /ignore-rules highlights the Ignore Rules sidebar link and no other top-level link", async () => {
  const res = await ignoreRulesRoute.request("/ignore-rules", {
    headers: authHeaders,
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  const activeLinks = [
    ...html.matchAll(/<a href="[^"]*" data-active="true"[^>]*>([^(<]*)/g),
  ].map((m) => m[1]?.trim());
  expect(activeLinks).toEqual(["Ignore Rules"]);
});

test("GET /ignore-rules shows the empty-state message when there are no rules yet", async () => {
  // The dev DB is a single shared `:memory:` connection across every test
  // file in this `bun test` run (src/db/client.ts reads DB_FILE_NAME once
  // per process), so an earlier-run file may have already left rows behind
  // -- clear the table explicitly rather than relying on file/test order.
  db.delete(ignoreRules).run();

  const res = await ignoreRulesRoute.request("/ignore-rules", {
    headers: authHeaders,
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("No ignore rules yet — add one below.");
});

test("GET /ignore-rules lists existing rules", async () => {
  makeRule("list-test-keyword");

  const res = await ignoreRulesRoute.request("/ignore-rules", {
    headers: authHeaders,
  });
  const html = await res.text();

  expect(res.status).toBe(200);
  expect(html).toContain("list-test-keyword");
  expect(html).not.toContain("No ignore rules yet — add one below.");
});

test("POST /ignore-rules rejects an empty keyword with an inline error and adds no rule", async () => {
  const before = db.select().from(ignoreRules).all().length;

  const res = await postAdd("");
  const html = await res.text();

  expect(html).toContain("Keyword is required.");
  expect(db.select().from(ignoreRules).all().length).toBe(before);
});

test("POST /ignore-rules rejects a whitespace-only keyword with an inline error and adds no rule", async () => {
  const before = db.select().from(ignoreRules).all().length;

  const res = await postAdd("   ");
  const html = await res.text();

  expect(html).toContain("Keyword is required.");
  expect(db.select().from(ignoreRules).all().length).toBe(before);
});

test("POST /ignore-rules adds a rule and triggers reconciliation of newly-matching videos", async () => {
  const video = makeVideo({
    title: "Video about reconcile-add-keyword",
    status: "unwatched",
  });

  const res = await postAdd("reconcile-add-keyword");
  const html = await res.text();

  expect(res.status).toBe(200);
  expect(html).toContain("reconcile-add-keyword");

  const row = videoRow(video.id);
  expect(row.status).toBe("ignored");
  expect(row.ignoreMethod).toBe("auto");
});

test("GET /ignore-rules/:id/edit renders that row in edit mode", async () => {
  const rule = makeRule("edit-mode-keyword");

  const res = await ignoreRulesRoute.request(`/ignore-rules/${rule.id}/edit`, {
    headers: authHeaders,
  });
  const html = await res.text();

  expect(res.status).toBe(200);
  expect(html).toContain(
    '<input type="text" name="keyword" value="edit-mode-keyword" class="rounded border border-border bg-surface-raised px-3 py-1.5 text-sm text-text placeholder:text-text-muted"/>',
  );
});

test("POST /ignore-rules/:id renames a rule and triggers reconciliation", async () => {
  const rule = makeRule("reconcile-rename-old-keyword");
  const video = makeVideo({
    title: "Video about reconcile-rename-old-keyword",
    status: "ignored",
    ignoreMethod: "auto",
  });

  const res = await postEdit(rule.id, "reconcile-rename-new-keyword");
  const html = await res.text();

  expect(res.status).toBe(200);
  expect(html).toContain("reconcile-rename-new-keyword");

  const updatedRule = db
    .select()
    .from(ignoreRules)
    .where(eq(ignoreRules.id, rule.id))
    .get();
  expect(updatedRule?.keyword).toBe("reconcile-rename-new-keyword");

  // The video no longer matches the renamed keyword, so reconciliation
  // should revert it back to unwatched.
  const row = videoRow(video.id);
  expect(row.status).toBe("unwatched");
  expect(row.ignoreMethod).toBeNull();
});

test("POST /ignore-rules/:id rejects an empty keyword, staying in edit mode with an error", async () => {
  const rule = makeRule("rename-empty-reject-keyword");

  const res = await postEdit(rule.id, "");
  const html = await res.text();

  expect(html).toContain("Keyword is required.");
  expect(html).toContain(
    '<input type="text" name="keyword" value="rename-empty-reject-keyword" class="rounded border border-border bg-surface-raised px-3 py-1.5 text-sm text-text placeholder:text-text-muted"/>',
  );

  const unchangedRule = db
    .select()
    .from(ignoreRules)
    .where(eq(ignoreRules.id, rule.id))
    .get();
  expect(unchangedRule?.keyword).toBe("rename-empty-reject-keyword");
});

test("POST /ignore-rules/:id against a nonexistent id 404s", async () => {
  const res = await postEdit(999999, "does-not-matter");
  expect(res.status).toBe(404);
});

test("DELETE /ignore-rules/:id removes a rule and triggers reconciliation", async () => {
  const rule = makeRule("reconcile-delete-keyword");
  const video = makeVideo({
    title: "Video about reconcile-delete-keyword",
    status: "ignored",
    ignoreMethod: "auto",
  });

  const res = await deleteRule(rule.id);
  const html = await res.text();

  expect(res.status).toBe(200);
  expect(html).not.toContain("reconcile-delete-keyword");

  const deletedRule = db
    .select()
    .from(ignoreRules)
    .where(eq(ignoreRules.id, rule.id))
    .get();
  expect(deletedRule).toBeUndefined();

  // No other rule matches, so reconciliation should revert the video.
  const row = videoRow(video.id);
  expect(row.status).toBe("unwatched");
  expect(row.ignoreMethod).toBeNull();
});

test("DELETE /ignore-rules/:id against a nonexistent id 404s", async () => {
  const res = await deleteRule(999999);
  expect(res.status).toBe(404);
});
