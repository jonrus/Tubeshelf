import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { loginAsAdminUser } from "../helpers/auth";

// categoriesRoute operates against the module-level `db` singleton in
// src/db/client.ts, which reads DB_FILE_NAME at import time — so it must be
// set before that module (or anything importing it) is first loaded.
process.env.DB_FILE_NAME = ":memory:";

const { db } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const {
  CATEGORY_NAME_MAX_LENGTH,
  categories,
  subscriptions,
  users,
  videos,
  youtubeChannels,
} = await import("../../src/db/schema");
const { seed } = await import("../../src/db/seed");
const { categoriesRoute } = await import("../../src/routes/categories");

migrate(db, { migrationsFolder: "./drizzle" });
seed(db);

const { cookie, origin } = await loginAsAdminUser();
const authHeaders = { Cookie: cookie, Origin: origin };

const systemCategory = db
  .select()
  .from(categories)
  .where(eq(categories.isSystem, true))
  .get();
if (!systemCategory) throw new Error("seed did not create the system category");

const defaultUserRow = db
  .select()
  .from(users)
  .where(eq(users.username, "admin"))
  .get();
if (!defaultUserRow) throw new Error("seed did not create the default user");
const defaultUser = defaultUserRow;

let channelCounter = 0;
function makeChannel(name: string) {
  channelCounter += 1;
  const youtubeChannelId = `UCcategoriesTest${String(channelCounter).padStart(9, "0")}`;
  return db
    .insert(youtubeChannels)
    .values({
      youtubeChannelId,
      name,
      rssUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${youtubeChannelId}`,
    })
    .returning()
    .get();
}

function makeSubscription(channelId: number, categoryId: number) {
  return db
    .insert(subscriptions)
    .values({
      userId: defaultUser.id,
      youtubeChannelId: channelId,
      categoryId,
    })
    .returning()
    .get();
}

let videoCounter = 0;
function makeVideo(
  channelId: number,
  status: "unwatched" | "watching" | "watched" | "ignored",
) {
  videoCounter += 1;
  return db
    .insert(videos)
    .values({
      channelId,
      youtubeVideoId: `vid-categories-test-${videoCounter}`,
      title: `Categories Test Video ${videoCounter}`,
      status,
      watchedAt: status === "watched" ? new Date() : null,
      ignoreMethod: status === "ignored" ? "manual" : null,
    })
    .returning()
    .get();
}

function postCategory(name: string) {
  return categoriesRoute.request("/categories", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...authHeaders,
    },
    body: new URLSearchParams({ name }),
  });
}

function findCategory(name: string) {
  return db.select().from(categories).where(eq(categories.name, name)).get();
}

function postRename(id: number, name: string) {
  return categoriesRoute.request(`/categories/${id}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...authHeaders,
    },
    body: new URLSearchParams({ name }),
  });
}

function getEdit(id: number) {
  return categoriesRoute.request(`/categories/${id}/edit`, {
    headers: authHeaders,
  });
}

test("GET /categories highlights the Categories sidebar link and no other top-level link", async () => {
  const res = await categoriesRoute.request("/categories", {
    headers: authHeaders,
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  const activeLinks = [
    ...html.matchAll(/<a href="[^"]*" data-active="true"[^>]*>([^(<]*)/g),
  ].map((m) => m[1]?.trim());
  expect(activeLinks).toEqual(["Manage Categories"]);
});

test("creating a category over the length limit is rejected and not inserted", async () => {
  const name = "a".repeat(CATEGORY_NAME_MAX_LENGTH + 1);
  const res = await postCategory(name);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(
    `Category name must be ${CATEGORY_NAME_MAX_LENGTH} characters or fewer.`,
  );
  expect(findCategory(name)).toBeUndefined();
});

test("creating a category at exactly the length limit succeeds", async () => {
  const name = "a".repeat(CATEGORY_NAME_MAX_LENGTH);
  const res = await postCategory(name);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(name);
  expect(findCategory(name)).toBeTruthy();
});

test("creating a category with an empty name is rejected", async () => {
  const res = await postCategory("   ");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Category name is required.");
});

test("creating a category with the reserved name is rejected case-insensitively", async () => {
  const res = await postCategory("UnCategorized");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("&quot;Uncategorized&quot; is a reserved name.");
  expect(findCategory("UnCategorized")).toBeUndefined();
});

test("creating a category with a duplicate name is rejected", async () => {
  const name = "Duplicate Category";
  const firstRes = await postCategory(name);
  expect(firstRes.status).toBe(200);

  const secondRes = await postCategory(name);
  expect(secondRes.status).toBe(200);
  const html = await secondRes.text();
  expect(html).toContain("A category with that name already exists.");

  const matches = db
    .select()
    .from(categories)
    .where(eq(categories.name, name))
    .all();
  expect(matches).toHaveLength(1);
});

test("renaming a non-system category succeeds and the new name appears in the list", async () => {
  const original = "Rename Me";
  await postCategory(original);
  const category = findCategory(original);
  if (!category) throw new Error("setup: category not created");

  const res = await postRename(category.id, "Renamed");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Renamed");
  expect(html).not.toContain(original);
  expect(findCategory("Renamed")).toBeTruthy();
  expect(findCategory(original)).toBeUndefined();
});

test("renaming to a name over the length limit is rejected and the name is unchanged", async () => {
  const original = "Rename Too Long";
  await postCategory(original);
  const category = findCategory(original);
  if (!category) throw new Error("setup: category not created");

  const tooLong = "a".repeat(CATEGORY_NAME_MAX_LENGTH + 1);
  const res = await postRename(category.id, tooLong);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(
    `Category name must be ${CATEGORY_NAME_MAX_LENGTH} characters or fewer.`,
  );
  expect(findCategory(original)).toBeTruthy();
  expect(findCategory(tooLong)).toBeUndefined();
});

test("renaming to an empty name is rejected and the name is unchanged", async () => {
  const original = "Rename Empty";
  await postCategory(original);
  const category = findCategory(original);
  if (!category) throw new Error("setup: category not created");

  const res = await postRename(category.id, "   ");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Category name is required.");
  expect(findCategory(original)).toBeTruthy();
});

test("renaming to the reserved name is rejected and the name is unchanged", async () => {
  const original = "Rename Reserved";
  await postCategory(original);
  const category = findCategory(original);
  if (!category) throw new Error("setup: category not created");

  const res = await postRename(category.id, "UnCategorized");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("&quot;Uncategorized&quot; is a reserved name.");
  expect(findCategory(original)).toBeTruthy();
});

test("renaming to an already-used name is rejected and the name is unchanged", async () => {
  const takenName = "Rename Taken";
  await postCategory(takenName);
  const original = "Rename Collide";
  await postCategory(original);
  const category = findCategory(original);
  if (!category) throw new Error("setup: category not created");

  const res = await postRename(category.id, takenName);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("A category with that name already exists.");
  expect(findCategory(original)).toBeTruthy();
});

test("attempting to rename the system category via POST is rejected without changing its name", async () => {
  const res = await postRename(systemCategory.id, "Not Uncategorized");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Cannot rename the system category.");
  const stillThere = db
    .select()
    .from(categories)
    .where(eq(categories.id, systemCategory.id))
    .get();
  expect(stillThere?.name).toBe(systemCategory.name);
});

test("attempting to edit the system category via GET /categories/:id/edit no-ops", async () => {
  const res = await getEdit(systemCategory.id);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).not.toContain(`hx-post="/categories/${systemCategory.id}"`);
});

test("renaming a nonexistent id 404s", async () => {
  const res = await postRename(999999, "Whatever");
  expect(res.status).toBe(404);
});

test("GET /categories renders a category's unwatched count and a link to its filtered queue", async () => {
  const category = db
    .insert(categories)
    .values({ name: "Count Category" })
    .returning()
    .get();
  const channel = makeChannel("Count Category Channel");
  makeSubscription(channel.id, category.id);
  makeVideo(channel.id, "unwatched");
  makeVideo(channel.id, "watching");
  makeVideo(channel.id, "watched");
  makeVideo(channel.id, "ignored");

  const res = await categoriesRoute.request("/categories", {
    headers: authHeaders,
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(
    `<a href="/queue?category=${category.id}">${category.name} (2)</a>`,
  );
  expect(html).not.toContain("No categories yet — add one above.");
});

// Kept as the final test in this file (routes/categories.test.ts also runs
// last across the whole `bun test` run, per the shared in-memory DB note
// below) since it empties the categories table -- including the system
// category every other test above relies on existing -- to exercise the
// true zero-row render path. subscriptions.categoryId FK's to categories,
// so subscriptions accumulated by other test files against this same
// shared DB (see src/db/client.ts: DB_FILE_NAME=":memory:" is read once per
// process, so every test file's dynamic `import("../../src/db/client")`
// resolves to the same module instance/connection) must be cleared first.
test("GET /categories shows the empty-state message when there are no categories", async () => {
  db.delete(subscriptions).run();
  db.delete(categories).run();

  const res = await categoriesRoute.request("/categories", {
    headers: authHeaders,
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("No categories yet — add one above.");

  db.insert(categories).values({ name: "Uncategorized", isSystem: true }).run();
});
