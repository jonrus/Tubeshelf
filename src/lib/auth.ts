import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { users } from "../db/schema";

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
