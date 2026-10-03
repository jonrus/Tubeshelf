import { afterEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

// auth.ts operates against the module-level `db` singleton in
// src/db/client.ts, which reads DB_FILE_NAME at import time -- so it must be
// set before that module (or anything importing it) is first loaded.
process.env.DB_FILE_NAME = ":memory:";
process.env.TRUSTED_ORIGINS = "http://test.local";

const { db } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { sessions, users } = await import("../../src/db/schema");
const { seed } = await import("../../src/db/seed");
const {
  applyRecoveryPasswordFromEnv,
  attemptLogin,
  createSession,
  ensureAdminPassword,
  hashPassword,
  purgeIdleSessions,
  requireAuth,
  resolveCookieSecure,
  setSessionCookie,
} = await import("../../src/lib/auth");

migrate(db, { migrationsFolder: "./drizzle" });
seed(db);

let errorSpy: ReturnType<typeof spyOn> | undefined;
let savedRecovery: string | undefined;

afterEach(() => {
  errorSpy?.mockRestore();
  errorSpy = undefined;
  if (savedRecovery === undefined) delete process.env.AUTH_RECOVERY_PASSWORD;
  else process.env.AUTH_RECOVERY_PASSWORD = savedRecovery;
});

function adminHash(): string | null | undefined {
  return db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.username, "admin"))
    .get()?.passwordHash;
}

function setAdminHash(passwordHash: string | null): void {
  db.update(users)
    .set({ passwordHash })
    .where(eq(users.username, "admin"))
    .run();
}

test("ensureAdminPassword generates, stores, and logs a password once when the admin hash is null", async () => {
  const original = adminHash() ?? null;
  setAdminHash(null);
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    await ensureAdminPassword();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0]?.[0]);
    expect(line).toContain("[WARN]");
    const match = line.match(/generated: (\S+) --/);
    const plaintext = match?.[1];
    expect(plaintext).toBeDefined();
    expect(plaintext).toHaveLength(24);

    const hash = adminHash();
    expect(hash).toBeTruthy();
    expect(await Bun.password.verify(plaintext as string, hash as string)).toBe(
      true,
    );

    await ensureAdminPassword();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  } finally {
    setAdminHash(original);
  }
});

test("ensureAdminPassword is a silent no-op when the admin already has a hash", async () => {
  const original = adminHash() ?? null;
  const existing = await hashPassword("existing-password");
  setAdminHash(existing);
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    await ensureAdminPassword();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(adminHash()).toBe(existing);
  } finally {
    setAdminHash(original);
  }
});

test("ensureAdminPassword leaves a hash set by applyRecoveryPasswordFromEnv untouched", async () => {
  const original = adminHash() ?? null;
  setAdminHash(null);
  savedRecovery = process.env.AUTH_RECOVERY_PASSWORD;
  process.env.AUTH_RECOVERY_PASSWORD = "recovery-test-password";
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    await applyRecoveryPasswordFromEnv();
    const afterRecovery = adminHash();
    errorSpy.mockClear();

    await ensureAdminPassword();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(adminHash()).toBe(afterRecovery as string);
    expect(
      await Bun.password.verify(
        "recovery-test-password",
        afterRecovery as string,
      ),
    ).toBe(true);
  } finally {
    setAdminHash(original);
  }
});

test("ensureAdminPassword is a silent no-op when there is no admin row", async () => {
  const original = adminHash() ?? null;
  const row = db.select().from(users).where(eq(users.username, "admin")).get();
  expect(row).toBeDefined();
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  db.update(users)
    .set({ username: "admin-renamed-for-test" })
    .where(eq(users.username, "admin"))
    .run();
  try {
    await ensureAdminPassword();
    expect(errorSpy).not.toHaveBeenCalled();
  } finally {
    db.update(users)
      .set({ username: "admin" })
      .where(eq(users.username, "admin-renamed-for-test"))
      .run();
    setAdminHash(original);
  }
});

function adminId(): number {
  const row = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, "admin"))
    .get();
  return row?.id as number;
}

function sessionCount(): number {
  return db.select().from(sessions).all().length;
}

test("purgeIdleSessions deletes only sessions idle past the timeout", () => {
  db.delete(sessions).run();
  const stale = createSession(adminId());
  const fresh = createSession(adminId());
  expect(stale.token).not.toBe(fresh.token);
  const rows = db.select().from(sessions).all();
  const staleRow = rows[0];
  db.update(sessions)
    .set({ lastSeenAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
    .where(eq(sessions.id, staleRow?.id as number))
    .run();

  purgeIdleSessions();

  const remaining = db.select().from(sessions).all();
  expect(remaining).toHaveLength(1);
  expect(remaining[0]?.id).not.toBe(staleRow?.id);
  db.delete(sessions).run();
});

async function recoveryScenario(
  initialHash: string | null,
  envPassword: string,
): Promise<{ before: string | null; after: string | null; kept: number }> {
  const original = adminHash() ?? null;
  setAdminHash(initialHash);
  db.delete(sessions).run();
  createSession(adminId());
  savedRecovery = process.env.AUTH_RECOVERY_PASSWORD;
  process.env.AUTH_RECOVERY_PASSWORD = envPassword;
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    await applyRecoveryPasswordFromEnv();
    return {
      before: initialHash,
      after: adminHash() ?? null,
      kept: sessionCount(),
    };
  } finally {
    setAdminHash(original);
    db.delete(sessions).run();
  }
}

test("recovery purge deletes all sessions when the stored hash is null", async () => {
  const result = await recoveryScenario(null, "recovery-pw");
  expect(result.after).toBeTruthy();
  expect(result.kept).toBe(0);
});

test("recovery purge deletes all sessions when the stored hash differs", async () => {
  const result = await recoveryScenario(
    await hashPassword("some-other-password"),
    "recovery-pw",
  );
  expect(result.after).not.toBe(result.before);
  expect(result.kept).toBe(0);
});

test("recovery keeps the hash and sessions when the env password already verifies", async () => {
  const existing = await hashPassword("recovery-pw");
  const result = await recoveryScenario(existing, "recovery-pw");
  expect(result.after).toBe(existing);
  expect(result.kept).toBe(1);
});

test("recovery with no admin row neither updates nor purges", async () => {
  db.delete(sessions).run();
  createSession(adminId());
  savedRecovery = process.env.AUTH_RECOVERY_PASSWORD;
  process.env.AUTH_RECOVERY_PASSWORD = "recovery-pw";
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  db.update(users)
    .set({ username: "admin-renamed-for-test" })
    .where(eq(users.username, "admin"))
    .run();
  try {
    await applyRecoveryPasswordFromEnv();
    expect(sessionCount()).toBe(1);
  } finally {
    db.update(users)
      .set({ username: "admin" })
      .where(eq(users.username, "admin-renamed-for-test"))
      .run();
    db.delete(sessions).run();
  }
});

test("requireAuth is idempotent: running it twice on one request touches the session once", async () => {
  const admin = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, "admin"))
    .get();
  const { token } = createSession(admin?.id as number);
  const app = new Hono();
  app.use("*", requireAuth, requireAuth);
  app.get("/", (c) => c.text("ok"));
  const updateSpy = spyOn(db, "update");
  try {
    const res = await app.request("/", {
      headers: { Cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(res.headers.getSetCookie()).toHaveLength(1);
  } finally {
    updateSpy.mockRestore();
  }
});

async function cookieSecureFor(
  origins: string,
  headers: Record<string, string>,
): Promise<boolean> {
  const saved = process.env.TRUSTED_ORIGINS;
  process.env.TRUSTED_ORIGINS = origins;
  try {
    const app = new Hono();
    app.get("/", (c) => c.text(String(resolveCookieSecure(c))));
    const res = await app.request("/", { headers });
    return (await res.text()) === "true";
  } finally {
    process.env.TRUSTED_ORIGINS = saved;
  }
}

test("resolveCookieSecure is never Secure without an https entry", async () => {
  expect(await cookieSecureFor("http://localhost:3000", {})).toBe(false);
  expect(
    await cookieSecureFor("http://localhost:3000", { Host: "evil.example" }),
  ).toBe(false);
});

test("resolveCookieSecure is Secure for an https-only list, even with a rewritten Host", async () => {
  const origins = "https://t.example.com";
  expect(await cookieSecureFor(origins, { Host: "t.example.com" })).toBe(true);
  expect(await cookieSecureFor(origins, { Host: "localhost:3000" })).toBe(true);
  expect(
    await cookieSecureFor(origins, { Origin: "https://t.example.com" }),
  ).toBe(true);
});

test("resolveCookieSecure with a mixed list is not Secure only when an http entry matches", async () => {
  const origins = "http://localhost:3000,https://t.example.com";
  expect(await cookieSecureFor(origins, { Host: "localhost:3000" })).toBe(
    false,
  );
  expect(
    await cookieSecureFor(origins, { Origin: "http://localhost:3000" }),
  ).toBe(false);
  expect(await cookieSecureFor(origins, { Host: "192.168.1.5:3000" })).toBe(
    true,
  );
  expect(await cookieSecureFor(origins, { Host: "t.example.com" })).toBe(true);
  expect(
    await cookieSecureFor(origins, { Origin: "https://t.example.com" }),
  ).toBe(true);
});

test("setSessionCookie sets httpOnly, Lax, path, max-age and the resolved Secure flag", async () => {
  const saved = process.env.TRUSTED_ORIGINS;
  process.env.TRUSTED_ORIGINS = "https://t.example.com";
  try {
    const app = new Hono();
    app.get("/", (c) => {
      setSessionCookie(c, "tok");
      return c.text("ok");
    });
    const res = await app.request("/");
    const cookie = res.headers.getSetCookie()[0] ?? "";
    expect(cookie).toContain("session=tok");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).toContain("Secure");
  } finally {
    process.env.TRUSTED_ORIGINS = saved;
  }
});

test('attemptLogin reports reason "invalid" for unknown users and wrong passwords, and "locked" once locked (even with the correct password)', async () => {
  const username = "attempt-login-reason-user";
  const password = "attempt-login-reason-password";
  db.insert(users)
    .values({ username, passwordHash: await hashPassword(password) })
    .run();

  expect(await attemptLogin("no-such-user", password)).toEqual({
    ok: false,
    reason: "invalid",
  });

  // The 5th wrong attempt trips the lock but still reports "invalid".
  for (let i = 0; i < 5; i++) {
    expect(await attemptLogin(username, "wrong")).toEqual({
      ok: false,
      reason: "invalid",
    });
  }

  expect(await attemptLogin(username, "wrong")).toEqual({
    ok: false,
    reason: "locked",
  });
  expect(await attemptLogin(username, password)).toEqual({
    ok: false,
    reason: "locked",
  });
});
