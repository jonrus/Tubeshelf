import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

// check() array-callback syntax `(t) => [check(...), ...]` matches installed
// drizzle-orm@0.45.2 (see SQLiteTableExtraConfigValue[] in sqlite-core/table.d.ts).

export const CATEGORY_NAME_MAX_LENGTH = 100;

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash"), // nullable; null = cannot log in with any password
  failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
  lockedUntil: integer("locked_until", { mode: "timestamp" }), // null = not locked
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const categories = sqliteTable(
  "categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull().unique(),
    isSystem: integer("is_system", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    check(
      "name_length_check",
      sql`length(${t.name}) <= ${sql.raw(String(CATEGORY_NAME_MAX_LENGTH))}`,
    ),
  ],
);

export const youtubeChannels = sqliteTable("youtube_channels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  youtubeChannelId: text("youtube_channel_id").notNull().unique(),
  name: text("name").notNull(),
  rssUrl: text("rss_url").notNull(),
  possibleMissedVideosDetectedAt: integer(
    "possible_missed_videos_detected_at",
    { mode: "timestamp" },
  ),
  lastFetchedAt: integer("last_fetched_at", { mode: "timestamp" }), // last *successful* fetch; null = never
  nextFetchDueAt: integer("next_fetch_due_at", { mode: "timestamp" }), // null = due immediately
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    youtubeChannelId: integer("youtube_channel_id")
      .notNull()
      .references(() => youtubeChannels.id),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id),
    unsubscribedAt: integer("unsubscribed_at", { mode: "timestamp" }), // null = active
    missedVideosDismissedAt: integer("missed_videos_dismissed_at", {
      mode: "timestamp",
    }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    unique("subscriptions_user_channel_unique").on(
      t.userId,
      t.youtubeChannelId,
    ),
  ],
);

export const videos = sqliteTable(
  "videos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => youtubeChannels.id),
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
    watchedAt: integer("watched_at", { mode: "timestamp" }), // null unless status === "watched"
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
    check(
      "watched_at_check",
      sql`(${t.status} = 'watched') = (${t.watchedAt} is not null)`,
    ),
    index("videos_status_published_idx").on(t.status, t.publishedAt, t.id),
    index("videos_status_watched_idx").on(t.status, t.watchedAt, t.id),
    index("videos_status_created_idx").on(t.status, t.createdAt, t.id),
  ],
);

export const ignoreRules = sqliteTable("ignore_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  keyword: text("keyword").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});
