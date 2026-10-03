import { expect, test } from "bun:test";
import "./helpers/auth";

// buildApp() mounts every router, which pulls in src/db/client; it reads
// DB_FILE_NAME at import time, so set it before the dynamic import.
process.env.DB_FILE_NAME = ":memory:";

const { db } = await import("../src/db/client");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { seed } = await import("../src/db/seed");
const { buildApp } = await import("../src/app");

migrate(db, { migrationsFolder: "./drizzle" });
seed(db);

const app = buildApp();

test("GET /healthz returns 200 on the full app", async () => {
  const res = await app.request("/healthz");
  expect(res.status).toBe(200);
});

test("unauthenticated GET /queue redirects to /login on the full app", async () => {
  const res = await app.request("/queue");
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toStartWith("/login?from=");
});
