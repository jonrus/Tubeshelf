import { eq } from "drizzle-orm";

// authRoute reads getTrustedOrigins() (src/lib/auth.ts) at request time, so
// this only needs to be set before loginAsDefaultUser() is first called, not
// before src/db/client is loaded — unlike DB_FILE_NAME, which every
// test/routes/*.test.ts file sets before its own dynamic db/client import.
process.env.TRUSTED_ORIGINS = "http://test.local";

const TEST_ORIGIN = "http://test.local";
const TEST_PASSWORD = "test-helper-password";

export async function loginAsDefaultUser(): Promise<{
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
    .where(eq(users.username, "default"))
    .run();

  const res = await authRoute.request("/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: TEST_ORIGIN,
    },
    body: new URLSearchParams({
      username: "default",
      password: TEST_PASSWORD,
    }),
  });

  const setCookieHeader = res.headers.get("set-cookie");
  if (!setCookieHeader) {
    throw new Error(
      "loginAsDefaultUser: login response had no Set-Cookie header",
    );
  }
  const match = setCookieHeader.match(/session=([^;]+)/);
  const sessionValue = match?.[1];
  if (!sessionValue) {
    throw new Error(
      "loginAsDefaultUser: no session cookie found in Set-Cookie header",
    );
  }

  return { cookie: `session=${sessionValue}`, origin: TEST_ORIGIN };
}
