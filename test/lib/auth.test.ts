import { afterEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";

// auth.ts operates against the module-level `db` singleton in
// src/db/client.ts, which reads DB_FILE_NAME at import time -- so it must be
// set before that module (or anything importing it) is first loaded.
process.env.DB_FILE_NAME = ":memory:";
// src/lib/auth.ts builds csrfCheck from TRUSTED_ORIGINS at import time, and
// bun test shares one module registry across files -- so importing it here
// first without this would leave test/routes/auth.test.ts with the default
// origin and 403 its requests.
process.env.TRUSTED_ORIGINS = "http://test.local";

const { db } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { users } = await import("../../src/db/schema");
const { seed } = await import("../../src/db/seed");
const { applyRecoveryPasswordFromEnv, ensureAdminPassword, hashPassword } =
  await import("../../src/lib/auth");

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
