import { eq } from "drizzle-orm";

// csrfCheck and resolveCookieSecure read getTrustedOrigins() (src/lib/auth.ts)
// lazily, at request time, so this only needs to be set before the first
// request, not before src/lib/auth is imported — unlike DB_FILE_NAME, which
// every test/routes/*.test.ts file sets before its own dynamic db/client import.
process.env.TRUSTED_ORIGINS = "http://test.local";

const TEST_ORIGIN = "http://test.local";
const TEST_PASSWORD = "test-helper-password";

export async function loginAsAdminUser(): Promise<{
  cookie: string;
  origin: string;
}> {
  const { db } = await import("../../src/db/client");
  const { users } = await import("../../src/db/schema");
  const { hashPassword } = await import("../../src/lib/auth");
  const { authRoute } = await import("../../src/routes/auth");

  const passwordHash = await hashPassword(TEST_PASSWORD);
  db.update(users)
    .set({ passwordHash })
    .where(eq(users.username, "admin"))
    .run();

  const res = await authRoute.request("/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: TEST_ORIGIN,
    },
    body: new URLSearchParams({
      username: "admin",
      password: TEST_PASSWORD,
    }),
  });

  const setCookieHeader = res.headers.get("set-cookie");
  if (!setCookieHeader) {
    throw new Error(
      "loginAsAdminUser: login response had no Set-Cookie header",
    );
  }
  const match = setCookieHeader.match(/session=([^;]+)/);
  const sessionValue = match?.[1];
  if (!sessionValue) {
    throw new Error(
      "loginAsAdminUser: no session cookie found in Set-Cookie header",
    );
  }

  return { cookie: `session=${sessionValue}`, origin: TEST_ORIGIN };
}
