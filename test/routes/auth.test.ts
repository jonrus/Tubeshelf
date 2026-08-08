import { expect, setSystemTime, test } from "bun:test";
import { eq } from "drizzle-orm";

// authRoute/queueRoute operate against the module-level `db` singleton in
// src/db/client.ts, which reads DB_FILE_NAME at import time -- so it must be
// set before that module (or anything importing it) is first loaded.
process.env.DB_FILE_NAME = ":memory:";
// authRoute reads getTrustedOrigins() (src/lib/auth.ts) at request time, so
// this only needs to be set before the first authRoute.request() call below.
process.env.TRUSTED_ORIGINS = "http://test.local";

const { db } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { users } = await import("../../src/db/schema");
const { seed } = await import("../../src/db/seed");
const { hashPassword } = await import("../../src/lib/auth");
const { authRoute } = await import("../../src/routes/auth");
const { queueRoute } = await import("../../src/routes/queue");

migrate(db, { migrationsFolder: "./drizzle" });
seed(db);

const TEST_ORIGIN = "http://test.local";
const DEFAULT_TEST_PASSWORD = "auth-test-default-password";
const LOCKOUT_USERNAME = "auth-test-lockout-user";
const LOCKOUT_PASSWORD = "auth-test-lockout-password";

// A dedicated, non-"admin" user for the lockout tests below, so
// failure-count/lockout state never leaks into other test files' shared use
// of "admin" via loginAsAdminUser (test/helpers/auth.ts).
const lockoutPasswordHash = await hashPassword(LOCKOUT_PASSWORD);
db.insert(users)
  .values({ username: LOCKOUT_USERNAME, passwordHash: lockoutPasswordHash })
  .run();

const defaultPasswordHash = await hashPassword(DEFAULT_TEST_PASSWORD);
db.update(users)
  .set({ passwordHash: defaultPasswordHash })
  .where(eq(users.username, "admin"))
  .run();

function postLogin(
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return authRoute.request("/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: TEST_ORIGIN,
      ...headers,
    },
    body: new URLSearchParams(fields),
  });
}

function extractSessionCookie(res: Response): string {
  const setCookieHeader = res.headers.get("set-cookie");
  if (!setCookieHeader) {
    throw new Error(
      "expected a Set-Cookie header on a successful login response",
    );
  }
  const match = setCookieHeader.match(/session=([^;]+)/);
  const sessionValue = match?.[1];
  if (!sessionValue) {
    throw new Error("expected a session cookie value in the Set-Cookie header");
  }
  return `session=${sessionValue}`;
}

test("a successful login redirects to a validated `from`, falling back to /queue when from is absent or fails the open-redirect guard", async () => {
  const validFromRes = await postLogin({
    username: "admin",
    password: DEFAULT_TEST_PASSWORD,
    from: "/watched?category=3",
  });
  expect(validFromRes.status).toBe(302);
  expect(validFromRes.headers.get("location")).toBe("/watched?category=3");

  const noFromRes = await postLogin({
    username: "admin",
    password: DEFAULT_TEST_PASSWORD,
  });
  expect(noFromRes.status).toBe(302);
  expect(noFromRes.headers.get("location")).toBe("/queue");

  // The login page's hidden `from` field always renders (via `props.from ??
  // ""`), so a login not preceded by an auth-redirect-with-`?from=` (e.g.
  // right after logout, or just visiting /login directly) submits a literal
  // empty string, not an absent field -- must fall back to /queue exactly
  // like the absent case above, not redirect to "".
  const emptyFromRes = await postLogin({
    username: "admin",
    password: DEFAULT_TEST_PASSWORD,
    from: "",
  });
  expect(emptyFromRes.status).toBe(302);
  expect(emptyFromRes.headers.get("location")).toBe("/queue");

  // A literal tab as the second character: WHATWG URL parsing strips it,
  // normalizing this to the protocol-relative (off-site) `//evil.com` -- the
  // open-redirect guard must reject it, not a naive "starts with /" check.
  const unsafeFromRes = await postLogin({
    username: "admin",
    password: DEFAULT_TEST_PASSWORD,
    from: "/\t/evil.com",
  });
  expect(unsafeFromRes.status).toBe(302);
  expect(unsafeFromRes.headers.get("location")).toBe("/queue");
});

test("a failed login re-renders the form with a 401 and a generic error message", async () => {
  const res = await postLogin({
    username: "admin",
    password: "wrong-password",
  });
  expect(res.status).toBe(401);
  const html = await res.text();
  expect(html).toContain("Invalid username or password.");
});

test("5 consecutive failed logins lock the account; further attempts during the window are rejected without checking the password or extending the lock; the lock expires after 15 minutes", async () => {
  for (let i = 0; i < 4; i++) {
    const res = await postLogin({
      username: LOCKOUT_USERNAME,
      password: "wrong",
    });
    expect(res.status).toBe(401);
  }

  const lockingRes = await postLogin({
    username: LOCKOUT_USERNAME,
    password: "wrong",
  });
  expect(lockingRes.status).toBe(401);

  const lockedRow = db
    .select()
    .from(users)
    .where(eq(users.username, LOCKOUT_USERNAME))
    .get();
  if (!lockedRow?.lockedUntil) {
    throw new Error("expected the account to be locked after 5 failures");
  }
  expect(lockedRow.failedLoginAttempts).toBe(0);
  const lockedUntilMs = lockedRow.lockedUntil.getTime();

  // Even the correct password is rejected while locked -- proves the
  // password isn't checked at all once locked, not just that it fails.
  const correctWhileLockedRes = await postLogin({
    username: LOCKOUT_USERNAME,
    password: LOCKOUT_PASSWORD,
  });
  expect(correctWhileLockedRes.status).toBe(401);

  setSystemTime(Date.now() + 5 * 60 * 1000);
  try {
    const stillLockedRes = await postLogin({
      username: LOCKOUT_USERNAME,
      password: "wrong",
    });
    expect(stillLockedRes.status).toBe(401);
    const stillLockedRow = db
      .select()
      .from(users)
      .where(eq(users.username, LOCKOUT_USERNAME))
      .get();
    expect(stillLockedRow?.lockedUntil?.getTime()).toBe(lockedUntilMs);

    setSystemTime(lockedUntilMs + 1000);
    const afterWindowRes = await postLogin({
      username: LOCKOUT_USERNAME,
      password: LOCKOUT_PASSWORD,
    });
    expect(afterWindowRes.status).toBe(302);
    expect(afterWindowRes.headers.get("location")).toBe("/queue");
  } finally {
    setSystemTime();
  }
});

test("a session past the 30-day idle window is rejected; a gated GET with the stale cookie redirects to /login", async () => {
  const loginRes = await postLogin({
    username: "admin",
    password: DEFAULT_TEST_PASSWORD,
  });
  const cookie = extractSessionCookie(loginRes);

  const freshRes = await queueRoute.request("/queue", {
    headers: { Cookie: cookie },
  });
  expect(freshRes.status).toBe(200);

  setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
  try {
    const expiredRes = await queueRoute.request("/queue", {
      headers: { Cookie: cookie },
    });
    expect(expiredRes.status).toBe(302);
    expect(expiredRes.headers.get("location")).toBe("/login?from=%2Fqueue");
  } finally {
    setSystemTime();
  }
});

test("logging out invalidates the session; reusing the old cookie afterward redirects to /login again", async () => {
  const loginRes = await postLogin({
    username: "admin",
    password: DEFAULT_TEST_PASSWORD,
  });
  const cookie = extractSessionCookie(loginRes);

  const authedRes = await queueRoute.request("/queue", {
    headers: { Cookie: cookie },
  });
  expect(authedRes.status).toBe(200);

  const logoutRes = await authRoute.request("/logout", {
    method: "POST",
    headers: { Cookie: cookie, Origin: TEST_ORIGIN },
  });
  expect(logoutRes.status).toBe(302);
  expect(logoutRes.headers.get("location")).toBe("/login");

  const staleRes = await queueRoute.request("/queue", {
    headers: { Cookie: cookie },
  });
  expect(staleRes.status).toBe(302);
  expect(staleRes.headers.get("location")).toBe("/login?from=%2Fqueue");
});

test("csrfCheck rejects a form-encoded mutating request with a missing or mismatched Origin header, but allows a matching one (using POST /logout, which needs no auth)", async () => {
  const missingOriginRes = await authRoute.request("/logout", {
    method: "POST",
  });
  expect(missingOriginRes.status).toBe(403);

  const mismatchedOriginRes = await authRoute.request("/logout", {
    method: "POST",
    headers: { Origin: "http://evil.example" },
  });
  expect(mismatchedOriginRes.status).toBe(403);

  const matchingOriginRes = await authRoute.request("/logout", {
    method: "POST",
    headers: { Origin: TEST_ORIGIN },
  });
  expect(matchingOriginRes.status).toBe(302);
});

test("csrfCheck does not reject a JSON-bodied mutating request, regardless of Origin -- a documented Content-Type dependency, not a gap", async () => {
  const res = await authRoute.request("/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(res.status).not.toBe(403);
  expect(res.status).toBe(302);
});

test("an unauthenticated GET to a gated route redirects to /login", async () => {
  const res = await queueRoute.request("/queue");
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/login?from=%2Fqueue");
});
