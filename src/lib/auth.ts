import { createHash, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { db } from "../db/client";
import { sessions, users } from "../db/schema";

declare module "hono" {
  interface ContextVariableMap {
    userId: number;
  }
}

const SESSION_IDLE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: "bcrypt" });
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return Bun.password.verify(plain, hash);
}

export async function applyRecoveryPasswordFromEnv(): Promise<void> {
  const recoveryPassword = process.env.AUTH_RECOVERY_PASSWORD;
  if (!recoveryPassword) return;

  const passwordHash = await hashPassword(recoveryPassword);
  db.update(users)
    .set({ passwordHash })
    .where(eq(users.username, "default"))
    .run();
  console.warn(
    "AUTH_RECOVERY_PASSWORD was applied to the default user's password. Unset this environment variable after use.",
  );
}

export async function attemptLogin(
  username: string,
  password: string,
): Promise<{ ok: true; userId: number } | { ok: false }> {
  const user = db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .get();
  if (!user) return { ok: false };

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    return { ok: false };
  }

  const passwordOk = user.passwordHash
    ? await verifyPassword(password, user.passwordHash)
    : false;

  if (passwordOk) {
    db.update(users)
      .set({ failedLoginAttempts: 0, lockedUntil: null })
      .where(eq(users.id, user.id))
      .run();
    return { ok: true, userId: user.id };
  }

  const fresh = db.select().from(users).where(eq(users.id, user.id)).get();
  if (fresh?.lockedUntil && fresh.lockedUntil.getTime() > Date.now()) {
    return { ok: false };
  }

  const lockedUntilSeconds = Math.floor(
    (Date.now() + LOCKOUT_DURATION_MS) / 1000,
  );
  db.update(users)
    .set({
      failedLoginAttempts: sql`CASE WHEN ${users.failedLoginAttempts} + 1 >= ${LOCKOUT_THRESHOLD} THEN 0 ELSE ${users.failedLoginAttempts} + 1 END`,
      lockedUntil: sql`CASE WHEN ${users.failedLoginAttempts} + 1 >= ${LOCKOUT_THRESHOLD} THEN ${lockedUntilSeconds} ELSE ${users.lockedUntil} END`,
    })
    .where(eq(users.id, user.id))
    .run();

  return { ok: false };
}

export function createSession(userId: number): { token: string } {
  const token = randomBytes(32).toString("base64url");
  db.insert(sessions)
    .values({ userId, tokenHash: hashToken(token) })
    .run();
  return { token };
}

export function findValidSession(
  token: string,
): { userId: number } | undefined {
  const tokenHash = hashToken(token);
  const session = db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .get();
  if (!session) return undefined;
  if (Date.now() - session.lastSeenAt.getTime() > SESSION_IDLE_TIMEOUT_MS) {
    return undefined;
  }
  db.update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.tokenHash, tokenHash))
    .run();
  return { userId: session.userId };
}

export function deleteSession(token: string): void {
  db.delete(sessions)
    .where(eq(sessions.tokenHash, hashToken(token)))
    .run();
}

export function getTrustedOrigins(): string[] {
  const raw = process.env.TRUSTED_ORIGINS;
  if (!raw) return ["http://localhost:3000"];
  return raw.split(",").map((origin) => origin.trim());
}

export const csrfCheck = csrf({ origin: getTrustedOrigins() });

export function getSessionFromRequest(
  c: Context,
): { userId: number } | undefined {
  const token = getCookie(c, "session");
  if (!token) return undefined;
  return findValidSession(token);
}

function buildLoginRedirect(c: Context): string {
  const url = new URL(c.req.url);
  const currentPath = url.pathname + url.search;
  return `/login?from=${encodeURIComponent(currentPath)}`;
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const token = getCookie(c, "session");
  const session = token ? findValidSession(token) : undefined;
  if (!session || !token) {
    const location = buildLoginRedirect(c);
    if (c.req.header("HX-Request")) {
      c.header("HX-Redirect", location);
      return c.body(null, 401);
    }
    return c.redirect(location, 302);
  }

  setCookie(c, "session", token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: resolveCookieSecure(c),
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
  });
  c.set("userId", session.userId);
  await next();
};

export function resolveCookieSecure(c: Context): boolean {
  const originHeader = c.req.header("Origin");
  if (originHeader !== undefined) {
    const match = getTrustedOrigins().find((origin) => origin === originHeader);
    return match?.startsWith("https://") ?? false;
  }

  const hostHeader = c.req.header("Host");
  const match = getTrustedOrigins().find((origin) => {
    try {
      return new URL(origin).host === hostHeader;
    } catch {
      return false;
    }
  });
  return match?.startsWith("https://") ?? false;
}
