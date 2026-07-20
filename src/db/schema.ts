import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// check() array-callback syntax `(t) => [check(...), ...]` matches installed
// drizzle-orm@0.45.2 (see SQLiteTableExtraConfigValue[] in sqlite-core/table.d.ts).

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash"), // nullable now; auth is out of scope
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const channels = sqliteTable("channels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  categoryId: integer("category_id")
    .notNull()
    .references(() => categories.id),
  youtubeChannelId: text("youtube_channel_id").notNull().unique(),
  name: text("name").notNull(),
  rssUrl: text("rss_url").notNull(),
  possibleMissedVideos: integer("possible_missed_videos", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const videos = sqliteTable(
  "videos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id),
    youtubeVideoId: text("youtube_video_id").notNull().unique(), // upsert key
    title: text("title").notNull(),
    description: text("description"),
    publishedAt: integer("published_at", { mode: "timestamp" }),
    status: text("status", {
      enum: ["unwatched", "watching", "watched", "ignored"],
    })
      .notNull()
      .default("unwatched"),
    ignoreMethod: text("ignore_method", { enum: ["manual", "auto"] }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    check(
      "status_check",
      sql`${t.status} in ('unwatched','watching','watched','ignored')`,
    ),
    check(
      "ignore_method_check",
      sql`${t.ignoreMethod} is null or ${t.ignoreMethod} in ('manual','auto')`,
    ),
  ],
);

export const ignoreRules = sqliteTable("ignore_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  keyword: text("keyword").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});
