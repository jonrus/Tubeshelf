import { expect, test } from "bun:test";
import { loginAsAdminUser } from "./helpers/auth";

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

test("an authenticated GET sets exactly one session cookie on a late-registered router", async () => {
  const { cookie } = await loginAsAdminUser();
  const res = await app.request("/ignore-rules", {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  expect(res.headers.getSetCookie()).toHaveLength(1);
});

test("a cross-origin POST is still rejected with 403", async () => {
  const { cookie } = await loginAsAdminUser();
  const res = await app.request("/logout", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: "http://evil.example",
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  expect(res.status).toBe(403);
});

const EXPECTED_CSP = [
  "default-src 'self'",
  "img-src 'self' https://i.ytimg.com",
  "script-src 'self'",
  "style-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

function expectSecurityHeaders(res: Response) {
  expect(res.headers.get("content-security-policy")).toBe(EXPECTED_CSP);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("same-origin");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.has("strict-transport-security")).toBe(false);
}

test("security headers are present on /login", async () => {
  const res = await app.request("/login");
  expect(res.status).toBe(200);
  expectSecurityHeaders(res);
});

test("security headers are present on an authenticated page", async () => {
  const { cookie } = await loginAsAdminUser();
  const res = await app.request("/ignore-rules", {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  expectSecurityHeaders(res);
});

test("security headers are present on /healthz", async () => {
  const res = await app.request("/healthz");
  expectSecurityHeaders(res);
});

test("security headers are present on a static file", async () => {
  const res = await app.request("/js/app.js");
  expect(res.status).toBe(200);
  expectSecurityHeaders(res);
});

test("security headers are present on a 500 from onError", async () => {
  const { cookie } = await loginAsAdminUser();
  const throwingApp = buildApp();
  throwingApp.get("/boom", () => {
    throw new Error("boom");
  });
  const res = await throwingApp.request("/boom", {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(500);
  expectSecurityHeaders(res);
});
