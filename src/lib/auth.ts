import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { db } from "../db/client";
import { sessions, users } from "../db/schema";
import { logger } from "./logger";

declare module "hono" {
  interface ContextVariableMap {
    userId: number;
    csrfChecked: boolean;
  }
}

const SESSION_IDLE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

const DUMMY_PASSWORD_HASH = Bun.password.hashSync(
  randomBytes(32).toString("hex"),
  { algorithm: "bcrypt" },
);

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: "bcrypt" });
}

function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return Bun.password.verify(plain, hash);
}

export async function applyRecoveryPasswordFromEnv(): Promise<void> {
  const recoveryPassword = process.env.AUTH_RECOVERY_PASSWORD;
  if (!recoveryPassword) return;

  const passwordHash = await hashPassword(recoveryPassword);
  db.update(users)
    .set({ passwordHash })
    .where(eq(users.username, "admin"))
    .run();
  logger.warn(
    "AUTH_RECOVERY_PASSWORD was applied to the default user's password. Unset this environment variable after use.",
  );
}

export async function ensureAdminPassword(): Promise<void> {
  const admin = db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.username, "admin"))
    .get();
  if (!admin || admin.passwordHash !== null) return;

  const generated = randomBytes(18).toString("base64url");
  const passwordHash = await hashPassword(generated);
  // Conditional so a hash written between the read above and this write is
  // never overwritten, and a password that wasn't stored is never logged.
  const updated = db
    .update(users)
    .set({ passwordHash })
    .where(and(eq(users.username, "admin"), isNull(users.passwordHash)))
    .returning({ id: users.id })
    .all();
  if (updated.length !== 1) return;

  logger.warn(
    `No password was set for the "admin" user, so one was generated: ${generated} -- this won't be shown again. Set AUTH_RECOVERY_PASSWORD to replace it.`,
  );
}

export async function attemptLogin(
  username: string,
  password: string,
): Promise<
  { ok: true; userId: number } | { ok: false; reason: "invalid" | "locked" }
> {
  const user = db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .get();
  if (!user) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    return { ok: false, reason: "invalid" };
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    return { ok: false, reason: "locked" };
  }

  const passwordOk = user.passwordHash
    ? await verifyPassword(password, user.passwordHash)
    : await verifyPassword(password, DUMMY_PASSWORD_HASH).then(() => false);

  if (passwordOk) {
    db.update(users)
      .set({ failedLoginAttempts: 0, lockedUntil: null })
      .where(eq(users.id, user.id))
      .run();
    return { ok: true, userId: user.id };
  }

  const fresh = db.select().from(users).where(eq(users.id, user.id)).get();
  if (fresh?.lockedUntil && fresh.lockedUntil.getTime() > Date.now()) {
    return { ok: false, reason: "locked" };
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

  return { ok: false, reason: "invalid" };
}

export function createSession(userId: number): { token: string } {
  const token = randomBytes(32).toString("base64url");
  db.insert(sessions)
    .values({ userId, tokenHash: hashToken(token) })
    .run();
  return { token };
}

function findValidSession(token: string): { userId: number } | undefined {
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

function getTrustedOrigins(): string[] {
  const raw = process.env.TRUSTED_ORIGINS;
  if (!raw) return ["http://localhost:3000"];
  return raw.split(",").map((origin) => origin.trim());
}

// Origin is checked lazily (per request) so TRUSTED_ORIGINS is never frozen at
// import time -- bun test shares one module registry across files.
const csrfInner = csrf({
  origin: (origin) => getTrustedOrigins().includes(origin),
});

// Each router does use("*", csrfCheck, requireAuth) and app.route("/", ...)
// stacks those wildcards, so this must be a no-op on repeats. The flag is set
// only after the check passes, so a rejected request never reaches it.
export const csrfCheck: MiddlewareHandler = (c, next) => {
  if (c.get("csrfChecked")) return next();
  return csrfInner(c, async () => {
    c.set("csrfChecked", true);
    await next();
  });
};

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
  if (c.get("userId") !== undefined) return next();

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

  setSessionCookie(c, token);
  c.set("userId", session.userId);
  await next();
};

export function safeRedirectTarget(from: string | undefined): string {
  if (!from) return "/queue";
  try {
    const resolved = new URL(from, "http://internal.invalid");
    return resolved.origin === "http://internal.invalid" ? from : "/queue";
  } catch {
    return "/queue";
  }
}

// Fail-secure: Secure iff any TRUSTED_ORIGINS entry is https://, unless the
// request positively matches an http:// entry (Origin header when present,
// otherwise Host). No X-Forwarded-* trust.
export function resolveCookieSecure(c: Context): boolean {
  const origins = getTrustedOrigins();
  if (!origins.some((origin) => origin.startsWith("https://"))) return false;

  const originHeader = c.req.header("Origin");
  const matchesHttpEntry =
    originHeader !== undefined
      ? origins.some(
          (origin) => origin.startsWith("http://") && origin === originHeader,
        )
      : origins.some((origin) => {
          if (!origin.startsWith("http://")) return false;
          try {
            return new URL(origin).host === c.req.header("Host");
          } catch {
            return false;
          }
        });
  return !matchesHttpEntry;
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, "session", token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: resolveCookieSecure(c),
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
  });
}
