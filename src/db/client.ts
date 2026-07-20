import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

const sqlite = new Database(process.env.DB_FILE_NAME ?? "./data/tubeshelf.db");
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

export const db = drizzle(sqlite);
export { sqlite };
