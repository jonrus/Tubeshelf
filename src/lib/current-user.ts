import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { users } from "../db/schema";

export function getCurrentUser() {
  const user = db
    .select()
    .from(users)
    .where(eq(users.username, "admin"))
    .get();
  if (!user) throw new Error("seed did not create the default user");
  return user;
}
