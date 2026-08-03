import { expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";

// dueChannels/runGuardedTick operate against the module-level `db` singleton in
// src/db/client.ts, which reads DB_FILE_NAME at import time -- so it must be set
// before that module (or anything importing it) is first loaded.
process.env.DB_FILE_NAME = ":memory:";

const { db } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { categories, subscriptions, users, youtubeChannels } = await import(
  "../../src/db/schema"
);
const { seed } = await import("../../src/db/seed");
const { dueChannels, runGuardedTick } = await import("../../src/lib/scheduler");

migrate(db, { migrationsFolder: "./drizzle" });
seed(db);

const userRow = db
  .select()
  .from(users)
  .where(eq(users.username, "admin"))
  .get();
if (!userRow) throw new Error("seed did not create the default user");
const user = userRow;

const categoryRow = db
  .select()
  .from(categories)
  .where(eq(categories.isSystem, true))
  .get();
if (!categoryRow) throw new Error("seed did not create the system category");
const category = categoryRow;

let channelCounter = 0;
function makeChannel(overrides: { nextFetchDueAt?: Date | null } = {}) {
  channelCounter++;
  const youtubeChannelId = `UCsched${String(channelCounter).padStart(17, "0")}`;
  return db
    .insert(youtubeChannels)
    .values({
      youtubeChannelId,
      name: `Scheduler Channel ${channelCounter}`,
      rssUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${youtubeChannelId}`,
      ...overrides,
    })
    .returning()
    .get();
}

function subscribe(youtubeChannelId: number, active: boolean) {
  db.insert(subscriptions)
    .values({
      userId: user.id,
      youtubeChannelId,
      categoryId: category.id,
      unsubscribedAt: active ? null : new Date(0),
    })
    .run();
}

function channelRow(id: number) {
  const row = db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.id, id))
    .get();
  if (!row) throw new Error(`channel ${id} not found`);
  return row;
}

test("dueChannels only returns channels with an active subscription", () => {
  const subscribedActive = makeChannel();
  subscribe(subscribedActive.id, true);
  const subscribedInactive = makeChannel();
  subscribe(subscribedInactive.id, false);
  const neverSubscribed = makeChannel();

  const ids = dueChannels(new Date(), 1000).map((c) => c.id);

  expect(ids).toContain(subscribedActive.id);
  expect(ids).not.toContain(subscribedInactive.id);
  expect(ids).not.toContain(neverSubscribed.id);
});

test("dueChannels excludes a channel with a future nextFetchDueAt", () => {
  const future = makeChannel({
    nextFetchDueAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  subscribe(future.id, true);

  const ids = dueChannels(new Date(), 1000).map((c) => c.id);

  expect(ids).not.toContain(future.id);
});

test("dueChannels includes a channel with a null nextFetchDueAt", () => {
  const neverFetched = makeChannel();
  subscribe(neverFetched.id, true);

  const ids = dueChannels(new Date(), 1000).map((c) => c.id);

  expect(ids).toContain(neverFetched.id);
});

test("dueChannels respects the batch limit", () => {
  const channels = [makeChannel(), makeChannel(), makeChannel()];
  for (const c of channels) subscribe(c.id, true);

  // Earlier tests in this file already left at least a couple of due, actively
  // subscribed channels behind, so the DB has more than enough matching rows
  // for a limit of 2 to actually constrain the result.
  const result = dueChannels(new Date(), 2);

  expect(result).toHaveLength(2);
});

test("dueChannels orders oldest-overdue-first", () => {
  const now = new Date();
  const middle = makeChannel({
    nextFetchDueAt: new Date(now.getTime() - 60 * 60 * 1000), // 1h ago
  });
  const oldest = makeChannel({
    nextFetchDueAt: new Date(now.getTime() - 3 * 60 * 60 * 1000), // 3h ago
  });
  const newest = makeChannel({
    nextFetchDueAt: new Date(now.getTime() - 10 * 60 * 1000), // 10m ago
  });
  for (const c of [middle, oldest, newest]) subscribe(c.id, true);

  // Large limit so all three of our rows are guaranteed to be present in the
  // result regardless of how many other rows earlier tests left behind.
  const result = dueChannels(now, 1000);
  const ourIds = new Set([middle.id, oldest.id, newest.id]);
  const ourOrder = result.filter((c) => ourIds.has(c.id)).map((c) => c.id);

  expect(ourOrder).toEqual([oldest.id, middle.id, newest.id]);
});

// Earlier tests in this file leave several channels with a null/past
// nextFetchDueAt behind in the shared in-memory DB, and tick() uses the
// default BATCH_SIZE (5) -- so a freshly created due channel isn't
// guaranteed to be among the batch a tick actually processes. Push every
// existing channel's due date far into the future first so each guard test's
// own channel is unambiguously the (only) one a tick picks up.
function parkAllExistingChannels() {
  db.update(youtubeChannels)
    .set({ nextFetchDueAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) })
    .run();
}

test("runGuardedTick's re-entrancy guard skips a call made while a tick is still pending", async () => {
  parkAllExistingChannels();
  const channel = makeChannel();
  subscribe(channel.id, true);

  let resolveFetch!: (value: Response) => void;
  const pendingFetch = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    (() => pendingFetch) as unknown as typeof fetch,
  );

  // runGuardedTick's synchronous prefix (the ticking guard check/set, plus
  // every awaited call down to the actual pending fetch) runs before this
  // statement returns control here -- so by the time the second call below is
  // made, `ticking` is already true.
  const firstCall = runGuardedTick();
  await runGuardedTick(); // should be a no-op: previous tick still in flight

  expect(fetchSpy).toHaveBeenCalledTimes(1);

  resolveFetch(new Response("", { status: 500 }));
  await firstCall; // let the mocked tick settle so `ticking` doesn't leak into later tests
  fetchSpy.mockRestore();

  expect(channelRow(channel.id).nextFetchDueAt).not.toBeNull();
});

test("runGuardedTick runs normally again once the pending tick resolves", async () => {
  parkAllExistingChannels();
  const channel = makeChannel();
  subscribe(channel.id, true);

  let resolveFetch!: (value: Response) => void;
  const pendingFetch = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    (() => pendingFetch) as unknown as typeof fetch,
  );

  const firstCall = runGuardedTick();
  resolveFetch(new Response("", { status: 500 }));
  await firstCall;
  fetchSpy.mockRestore();

  // The first tick's failed ingest already advanced nextFetchDueAt into the
  // future -- force the channel due again so the second tick has something to
  // actually process.
  db.update(youtubeChannels)
    .set({ nextFetchDueAt: null })
    .where(eq(youtubeChannels.id, channel.id))
    .run();

  const fetchSpy2 = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 500 }),
  );
  await runGuardedTick();

  // Assert before restoring -- mockRestore() clears recorded calls.
  expect(fetchSpy2).toHaveBeenCalledTimes(1);
  fetchSpy2.mockRestore();
});
