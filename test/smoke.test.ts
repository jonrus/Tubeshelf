import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { expect, test } from "bun:test";
import { seed } from "../src/db/seed";
import { categories, users } from "../src/db/schema";

test("migrations + seed are idempotent and produce one system category and one user", () => {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "./drizzle" });

  seed(db);
  seed(db);

  const uncategorized = db.select().from(categories).where(eq(categories.isSystem, true)).all();
  expect(uncategorized).toHaveLength(1);
  expect(uncategorized[0].name).toBe("Uncategorized");

  const allUsers = db.select().from(users).all();
  expect(allUsers).toHaveLength(1);
});
