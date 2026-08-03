import { expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";

// upsertYoutubeChannel/upsertSubscription operate against the module-level `db`
// singleton in src/db/client.ts, which reads DB_FILE_NAME at import time — so it
// must be set before that module (or anything importing it) is first loaded.
process.env.DB_FILE_NAME = ":memory:";

const { db } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { categories, subscriptions, users, youtubeChannels } = await import(
  "../../src/db/schema"
);
const { seed } = await import("../../src/db/seed");
const { upsertSubscription, upsertYoutubeChannel } = await import(
  "../../src/lib/subscribe"
);

migrate(db, { migrationsFolder: "./drizzle" });
seed(db);

const user = db.select().from(users).where(eq(users.username, "admin")).get();
if (!user) throw new Error("seed did not create the default user");

const category = db
  .select()
  .from(categories)
  .where(eq(categories.isSystem, true))
  .get();
if (!category) throw new Error("seed did not create the system category");

test("upsertYoutubeChannel recovers when a concurrent insert wins the race", async () => {
  const channelId = "UCraceRaceRaceRaceRace01";
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><feed><title>Slow Fetcher</title></feed>`;

  // fetchChannelFeed's await is the only yield point in upsertYoutubeChannel;
  // simulate a second request's insert landing during that window.
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
    db.insert(youtubeChannels)
      .values({
        youtubeChannelId: channelId,
        name: "Concurrent Insert",
        rssUrl,
      })
      .run();
    return new Response(xml, { status: 200 });
  }) as unknown as typeof fetch);

  const result = await upsertYoutubeChannel(channelId, rssUrl);
  fetchSpy.mockRestore();

  expect(result?.channel.name).toBe("Concurrent Insert");
  expect(result?.feed).toBeNull();

  const rows = db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.youtubeChannelId, channelId))
    .all();
  expect(rows).toHaveLength(1);
});

test("upsertYoutubeChannel returns the fetched feed for a brand-new channel", async () => {
  const channelId = "UCbrandNewChannel0000001";
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><feed><title>Brand New Channel</title></feed>`;

  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(xml, { status: 200 }),
  );

  const result = await upsertYoutubeChannel(channelId, rssUrl);

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  fetchSpy.mockRestore();

  expect(result?.channel.name).toBe("Brand New Channel");
  expect(result?.feed).toEqual({ title: "Brand New Channel", entries: [] });
});

test("upsertYoutubeChannel returns a null feed and skips the fetch for an existing channel", async () => {
  const channelId = "UCalreadyKnownChannel001";
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

  db.insert(youtubeChannels)
    .values({ youtubeChannelId: channelId, name: "Already Known", rssUrl })
    .run();

  const fetchSpy = spyOn(globalThis, "fetch");

  const result = await upsertYoutubeChannel(channelId, rssUrl);

  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();

  expect(result?.channel.name).toBe("Already Known");
  expect(result?.feed).toBeNull();
});

test("upsertSubscription recovers by reactivating when a concurrent insert wins the race", () => {
  const channel = db
    .insert(youtubeChannels)
    .values({
      youtubeChannelId: "UCraceRaceRaceRaceRace02",
      name: "Sub Race Channel",
      rssUrl:
        "https://www.youtube.com/feeds/videos.xml?channel_id=UCraceRaceRaceRaceRace02",
    })
    .returning()
    .get();

  // Pre-insert the row a "concurrent" request would have created, inactive so
  // the recovery path exercises reactivation (not just already-subscribed).
  const conflicting = db
    .insert(subscriptions)
    .values({
      userId: user.id,
      youtubeChannelId: channel.id,
      categoryId: category.id,
      unsubscribedAt: new Date(0),
    })
    .returning()
    .get();

  // upsertSubscription is fully synchronous, so there's no natural await gap to
  // race through — stub away only the *first* existence check so the function
  // proceeds to INSERT and hits the real UNIQUE constraint, then falls through
  // to its catch-and-requery recovery path (the second db.select call, which
  // this mock leaves untouched).
  const selectSpy = spyOn(db, "select").mockImplementationOnce((() => ({
    from: () => ({ where: () => ({ get: () => undefined }) }),
  })) as unknown as typeof db.select);

  const result = upsertSubscription(user.id, channel.id, category.id);
  selectSpy.mockRestore();

  expect(result.outcome).toBe("reactivated");
  if (result.outcome === "reactivated") {
    expect(result.subscription.id).toBe(conflicting.id);
    expect(result.subscription.unsubscribedAt).toBeNull();
  }

  const rows = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.youtubeChannelId, channel.id))
    .all();
  expect(rows).toHaveLength(1);
});

test("upsertSubscription dismisses a pre-existing gap for a first-time subscriber", () => {
  const channel = db
    .insert(youtubeChannels)
    .values({
      youtubeChannelId: "UCpreExistingGapChannel1",
      name: "Pre-Existing Gap Channel",
      rssUrl:
        "https://www.youtube.com/feeds/videos.xml?channel_id=UCpreExistingGapChannel1",
    })
    .returning()
    .get();

  const detectedAt = new Date(Date.now() - 60_000);
  db.update(youtubeChannels)
    .set({ possibleMissedVideosDetectedAt: detectedAt })
    .where(eq(youtubeChannels.id, channel.id))
    .run();

  const result = upsertSubscription(user.id, channel.id, category.id);

  expect(result.outcome).toBe("created");
  if (result.outcome === "created") {
    const dismissedAt = result.subscription.missedVideosDismissedAt;
    expect(dismissedAt).not.toBeNull();
    expect(dismissedAt?.getTime()).toBeGreaterThanOrEqual(detectedAt.getTime());
  }
});

test("upsertSubscription returns already-subscribed when the recovered row is still active", () => {
  const channel = db
    .insert(youtubeChannels)
    .values({
      youtubeChannelId: "UCraceRaceRaceRaceRace03",
      name: "Active Race Channel",
      rssUrl:
        "https://www.youtube.com/feeds/videos.xml?channel_id=UCraceRaceRaceRaceRace03",
    })
    .returning()
    .get();

  db.insert(subscriptions)
    .values({
      userId: user.id,
      youtubeChannelId: channel.id,
      categoryId: category.id,
    })
    .run();

  const selectSpy = spyOn(db, "select").mockImplementationOnce((() => ({
    from: () => ({ where: () => ({ get: () => undefined }) }),
  })) as unknown as typeof db.select);

  const result = upsertSubscription(user.id, channel.id, category.id);
  selectSpy.mockRestore();

  expect(result.outcome).toBe("already-subscribed");

  const rows = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.youtubeChannelId, channel.id))
    .all();
  expect(rows).toHaveLength(1);
});
