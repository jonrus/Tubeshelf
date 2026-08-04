import { expect, test } from "bun:test";

process.env.DB_FILE_NAME = ":memory:";

const { db } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { healthRoute } = await import("../../src/routes/health");

migrate(db, { migrationsFolder: "./drizzle" });

test("GET /healthz returns 200 when the DB is reachable", async () => {
  const res = await healthRoute.request("/healthz");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});
