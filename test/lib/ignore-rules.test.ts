import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";

// listIgnoreRules/reconcileIgnoreRules operate against the module-level `db` singleton
// in src/db/client.ts, which reads DB_FILE_NAME at import time -- so it must be set
// before that module (or anything importing it) is first loaded.
process.env.DB_FILE_NAME = ":memory:";

const { db } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { ignoreRules, videos, youtubeChannels } = await import(
  "../../src/db/schema"
);
const { matchesAnyRule, reconcileIgnoreRules } = await import(
  "../../src/lib/ignore-rules"
);

migrate(db, { migrationsFolder: "./drizzle" });

const channel = db
  .insert(youtubeChannels)
  .values({
    youtubeChannelId: "UCignorerules0001",
    name: "Test Channel",
    rssUrl:
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCignorerules0001",
  })
  .returning()
  .get();

let videoCounter = 0;

function makeVideo(options: {
  title: string;
  description?: string | null;
  status: "unwatched" | "watching" | "watched" | "ignored";
  ignoreMethod?: "manual" | "auto" | null;
  watchedAt?: Date | null;
}) {
  videoCounter += 1;
  return db
    .insert(videos)
    .values({
      channelId: channel.id,
      youtubeVideoId: `vid-ignore-rules-${videoCounter}`,
      title: options.title,
      description: options.description ?? null,
      status: options.status,
      ignoreMethod: options.ignoreMethod ?? null,
      watchedAt: options.watchedAt ?? null,
    })
    .returning()
    .get();
}

function makeRule(keyword: string) {
  return db.insert(ignoreRules).values({ keyword }).returning().get();
}

function videoRow(id: number) {
  const row = db.select().from(videos).where(eq(videos.id, id)).get();
  if (!row) throw new Error(`video ${id} not found`);
  return row;
}

test("matchesAnyRule matches a title substring case-insensitively", () => {
  expect(
    matchesAnyRule({ title: "Breaking NEWS Update", description: null }, [
      { keyword: "news" },
    ]),
  ).toBe(true);
});

test("matchesAnyRule matches a description substring", () => {
  expect(
    matchesAnyRule(
      { title: "Some Video", description: "Contains Spoilers ahead" },
      [{ keyword: "spoilers" }],
    ),
  ).toBe(true);
});

test("matchesAnyRule does not match when neither field contains any rule's keyword", () => {
  expect(
    matchesAnyRule({ title: "Some Video", description: "A description" }, [
      { keyword: "xyz" },
    ]),
  ).toBe(false);
});

test("matchesAnyRule never matches anything against an empty rule set", () => {
  expect(
    matchesAnyRule({ title: "Anything", description: "Anything else" }, []),
  ).toBe(false);
});

test("reconcileIgnoreRules reverts an ignored+auto video to unwatched when its matching rule is deleted", () => {
  const rule = makeRule("reconcile-deleted-rule");
  const video = makeVideo({
    title: "Video about reconcile-deleted-rule",
    status: "ignored",
    ignoreMethod: "auto",
  });

  db.delete(ignoreRules).where(eq(ignoreRules.id, rule.id)).run();
  reconcileIgnoreRules();

  const row = videoRow(video.id);
  expect(row.status).toBe("unwatched");
  expect(row.ignoreMethod).toBeNull();
});

test("reconcileIgnoreRules auto-ignores an unwatched video that newly matches a just-added rule", () => {
  const video = makeVideo({
    title: "Video about newly-added-keyword",
    status: "unwatched",
  });

  makeRule("newly-added-keyword");
  reconcileIgnoreRules();

  const row = videoRow(video.id);
  expect(row.status).toBe("ignored");
  expect(row.ignoreMethod).toBe("auto");
});

test("reconcileIgnoreRules auto-ignores a watching video that newly matches a just-added rule", () => {
  const video = makeVideo({
    title: "Video about newly-added-watching-keyword",
    status: "watching",
  });

  makeRule("newly-added-watching-keyword");
  reconcileIgnoreRules();

  const row = videoRow(video.id);
  expect(row.status).toBe("ignored");
  expect(row.ignoreMethod).toBe("auto");
});

test("reconcileIgnoreRules leaves a watched video untouched even if it would match a rule", () => {
  const video = makeVideo({
    title: "Video about watched-keyword",
    status: "watched",
    watchedAt: new Date("2026-07-01T00:00:00Z"),
  });

  makeRule("watched-keyword");
  reconcileIgnoreRules();

  const row = videoRow(video.id);
  expect(row.status).toBe("watched");
  expect(row.ignoreMethod).toBeNull();
});

test("reconcileIgnoreRules leaves an ignored+manual video untouched in both directions", () => {
  const rule = makeRule("manual-keyword");
  const matchingVideo = makeVideo({
    title: "Video about manual-keyword",
    status: "ignored",
    ignoreMethod: "manual",
  });
  const nonMatchingVideo = makeVideo({
    title: "Video with no matching keyword at all",
    status: "ignored",
    ignoreMethod: "manual",
  });

  // Direction 1: still matches a current rule -- should stay exactly as-is.
  reconcileIgnoreRules();
  expect(videoRow(matchingVideo.id).status).toBe("ignored");
  expect(videoRow(matchingVideo.id).ignoreMethod).toBe("manual");

  // Direction 2: its matching rule is deleted -- manual ignores are never
  // reverted by reconciliation either.
  db.delete(ignoreRules).where(eq(ignoreRules.id, rule.id)).run();
  reconcileIgnoreRules();
  expect(videoRow(matchingVideo.id).status).toBe("ignored");
  expect(videoRow(matchingVideo.id).ignoreMethod).toBe("manual");

  expect(videoRow(nonMatchingVideo.id).status).toBe("ignored");
  expect(videoRow(nonMatchingVideo.id).ignoreMethod).toBe("manual");
});
