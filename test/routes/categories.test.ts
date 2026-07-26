import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";

// categoriesRoute operates against the module-level `db` singleton in
// src/db/client.ts, which reads DB_FILE_NAME at import time — so it must be
// set before that module (or anything importing it) is first loaded.
process.env.DB_FILE_NAME = ":memory:";

const { db } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { CATEGORY_NAME_MAX_LENGTH, categories } = await import(
  "../../src/db/schema"
);
const { seed } = await import("../../src/db/seed");
const { categoriesRoute } = await import("../../src/routes/categories");

migrate(db, { migrationsFolder: "./drizzle" });
seed(db);

const systemCategory = db
  .select()
  .from(categories)
  .where(eq(categories.isSystem, true))
  .get();
if (!systemCategory) throw new Error("seed did not create the system category");

function postCategory(name: string) {
  return categoriesRoute.request("/categories", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name }),
  });
}

function findCategory(name: string) {
  return db.select().from(categories).where(eq(categories.name, name)).get();
}

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
