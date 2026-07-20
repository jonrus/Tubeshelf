import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { categories, users } from "./schema";

export function seed(db: BunSQLiteDatabase) {
  const uncategorized = db
    .select()
    .from(categories)
    .where(eq(categories.name, "Uncategorized"))
    .get();
  if (!uncategorized) {
    db.insert(categories)
      .values({ name: "Uncategorized", isSystem: true })
      .run();
  }
  const anyUser = db.select().from(users).get();
  if (!anyUser) {
    db.insert(users).values({ username: "default" }).run();
  }
}
