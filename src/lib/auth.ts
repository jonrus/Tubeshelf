import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { sessions, users } from "../db/schema";

const SESSION_IDLE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;

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
