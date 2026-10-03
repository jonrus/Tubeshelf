import { afterEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";

// runDurationEnrichmentSweep operates against the module-level `db` singleton in
// src/db/client.ts, which reads DB_FILE_NAME at import time -- so it must be set
// before that module (or anything importing it) is first loaded.
process.env.DB_FILE_NAME = ":memory:";

const { db } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { categories, subscriptions, users, videos, youtubeChannels } =
  await import("../../src/db/schema");
const { seed } = await import("../../src/db/seed");

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

// duration-enrichment.ts caches YOUTUBE_API_KEY and a `latched` flag at module
// load -- both need to vary per test (unset vs. set, unlatched vs. latched
// after a bad-key response). A cache-busting query string on the specifier
// forces Bun to load a fresh module instance -- and therefore a fresh module
// scope -- each time, so each test gets independent state instead of sharing
// one process-lifetime singleton the way production code intentionally does.
let moduleInstanceCounter = 0;
async function loadSweepModule(apiKey: string | undefined) {
  if (apiKey === undefined) delete process.env.YOUTUBE_API_KEY;
  else process.env.YOUTUBE_API_KEY = apiKey;
  moduleInstanceCounter++;
  return import(
    `../../src/lib/duration-enrichment?instance=${moduleInstanceCounter}`
  );
}

// YOUTUBE_API_KEY is unset in every real environment this suite runs in.
// Bun's test runner shares one process (and module registry) across all test
// files in a run, so leaving this set after the last test here would corrupt
// whichever *other* file first imports the real, non-instance-suffixed
// src/lib/duration-enrichment.ts (via src/lib/scheduler.ts) -- that shared
// singleton reads and caches this var at its own module-load time, which
// could happen after this file has already mutated it.
afterEach(() => {
  delete process.env.YOUTUBE_API_KEY;
});

let channelCounter = 0;
function makeChannel() {
  channelCounter++;
  const youtubeChannelId = `UCdurenr${String(channelCounter).padStart(15, "0")}`;
  return db
    .insert(youtubeChannels)
    .values({
      youtubeChannelId,
      name: `Duration Channel ${channelCounter}`,
      rssUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${youtubeChannelId}`,
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

let videoCounter = 0;
function makeVideo(
  channelId: number,
  overrides: {
    status?: "unwatched" | "watching" | "watched" | "ignored";
    watchedAt?: Date | null;
    publishedAt?: Date | null;
    durationSeconds?: number | null;
  } = {},
) {
  videoCounter++;
  return db
    .insert(videos)
    .values({
      channelId,
      youtubeVideoId: `vid-durenr-${videoCounter}`,
      title: `Duration Video ${videoCounter}`,
      status: overrides.status ?? "unwatched",
      watchedAt: overrides.watchedAt ?? null,
      publishedAt: overrides.publishedAt ?? new Date(),
      durationSeconds: overrides.durationSeconds ?? null,
    })
    .returning()
    .get();
}

function videoRow(id: number) {
  const row = db.select().from(videos).where(eq(videos.id, id)).get();
  if (!row) throw new Error(`video ${id} not found`);
  return row;
}

// An eligible video that's deliberately left unconsumed by a test (bad-key
// latch, transient failure, the one ID a stubbed response omits) must be
// removed afterward -- otherwise it lingers in the eligible pool and
// contaminates a later test's batch (in particular the 50-row-cap test, which
// depends on the pool being empty save for what it inserts itself).
function discard(id: number) {
  db.delete(videos).where(eq(videos.id, id)).run();
}

function requestedIds(fetchSpy: ReturnType<typeof spyOn>): string[] {
  const call = fetchSpy.mock.calls.at(-1);
  const url = call?.[0] as URL;
  const id = url.searchParams.get("id");
  return id ? id.split(",") : [];
}

function okResponse(items: { id: string; duration: string }[]) {
  return new Response(
    JSON.stringify({
      items: items.map((item) => ({
        id: item.id,
        contentDetails: { duration: item.duration },
      })),
    }),
    { status: 200 },
  );
}

function badKeyResponse() {
  return new Response(
    JSON.stringify({ error: { errors: [{ reason: "keyInvalid" }] } }),
    { status: 403 },
  );
}

// Google's real invalid-key response: HTTP 400, generic errors[0].reason, the
// specific reason only in details[].
function realShapeBadKeyResponse() {
  return new Response(
    JSON.stringify({
      error: {
        code: 400,
        errors: [{ reason: "badRequest" }],
        details: [{ reason: "API_KEY_INVALID" }],
      },
    }),
    { status: 400 },
  );
}

function transientResponse() {
  return new Response(JSON.stringify({ error: { errors: [] } }), {
    status: 500,
  });
}

// The `videos` table is a process-wide singleton shared by every test file in
// this run (all resolve "../../src/db/client" to the same cached module), so
// other files' unwatched/watching videos on active subscriptions are already
// sitting in the eligible pool by the time this file's tests run -- there is
// no natural "nothing eligible yet" moment to rely on. Drain whatever's
// currently eligible (answering every request with a real-looking duration)
// until a sweep finds nothing left, so a test that needs true emptiness can
// establish it itself rather than assume it.
async function drainEligiblePool() {
  for (;;) {
    const { runDurationEnrichmentSweep } = await loadSweepModule("drain-key");
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      url: URL,
    ) => {
      const requested = (url.searchParams.get("id") ?? "")
        .split(",")
        .filter(Boolean);
      return okResponse(requested.map((id) => ({ id, duration: "PT1M" })));
    }) as unknown as typeof fetch);
    await runDurationEnrichmentSweep();
    const calledThisPass = fetchSpy.mock.calls.length > 0;
    fetchSpy.mockRestore();
    if (!calledThisPass) break;
  }
}

test("no-op (no fetch call) when YOUTUBE_API_KEY is unset", async () => {
  const channel = makeChannel();
  subscribe(channel.id, true);
  const video = makeVideo(channel.id);

  const { runDurationEnrichmentSweep } = await loadSweepModule(undefined);
  // Never left as a bare passthrough spy: if the no-key short-circuit were
  // ever broken, a passthrough would let this call escape to the real
  // network instead of failing the assertion cleanly.
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    transientResponse(),
  );

  await runDurationEnrichmentSweep();

  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  discard(video.id);
});

test.each([
  ["empty", ""],
  ["whitespace-only", "   "],
])("no-op (no fetch call) when YOUTUBE_API_KEY is %s", async (_label, key) => {
  const channel = makeChannel();
  subscribe(channel.id, true);
  const video = makeVideo(channel.id);

  const { runDurationEnrichmentSweep } = await loadSweepModule(key);
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    transientResponse(),
  );

  await runDurationEnrichmentSweep();

  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  discard(video.id);
});

test("no-op (no fetch call) when the eligibility query is empty", async () => {
  await drainEligiblePool();

  const { runDurationEnrichmentSweep } = await loadSweepModule("test-key");
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    transientResponse(),
  );

  await runDurationEnrichmentSweep();

  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

test("eligibility query excludes watched and ignored videos", async () => {
  const channel = makeChannel();
  subscribe(channel.id, true);
  const eligible = makeVideo(channel.id, { status: "unwatched" });
  const watching = makeVideo(channel.id, { status: "watching" });
  const watched = makeVideo(channel.id, {
    status: "watched",
    watchedAt: new Date(),
  });
  const ignored = makeVideo(channel.id, { status: "ignored" });

  const { runDurationEnrichmentSweep } = await loadSweepModule("test-key");
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    okResponse([
      { id: eligible.youtubeVideoId, duration: "PT1M" },
      { id: watching.youtubeVideoId, duration: "PT2M" },
    ]),
  );

  await runDurationEnrichmentSweep();

  const ids = requestedIds(fetchSpy);
  expect(ids).toContain(eligible.youtubeVideoId);
  expect(ids).toContain(watching.youtubeVideoId);
  expect(ids).not.toContain(watched.youtubeVideoId);
  expect(ids).not.toContain(ignored.youtubeVideoId);
  expect(videoRow(eligible.id).durationSeconds).toBe(60);
  expect(videoRow(watching.id).durationSeconds).toBe(120);

  fetchSpy.mockRestore();
});

test("eligibility query excludes a video whose channel's only subscription is unsubscribed", async () => {
  const unsubscribedChannel = makeChannel();
  subscribe(unsubscribedChannel.id, false);
  const excluded = makeVideo(unsubscribedChannel.id);

  const activeChannel = makeChannel();
  subscribe(activeChannel.id, true);
  const included = makeVideo(activeChannel.id);

  const { runDurationEnrichmentSweep } = await loadSweepModule("test-key");
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    okResponse([{ id: included.youtubeVideoId, duration: "PT3M" }]),
  );

  await runDurationEnrichmentSweep();

  const ids = requestedIds(fetchSpy);
  expect(ids).not.toContain(excluded.youtubeVideoId);
  expect(ids).toContain(included.youtubeVideoId);
  expect(videoRow(included.id).durationSeconds).toBe(180);

  fetchSpy.mockRestore();
  discard(excluded.id);
});

test("eligibility query orders newest-publishedAt-first", async () => {
  const channel = makeChannel();
  subscribe(channel.id, true);
  const now = Date.now();
  const oldest = makeVideo(channel.id, {
    publishedAt: new Date(now - 3 * 60 * 60 * 1000),
  });
  const middle = makeVideo(channel.id, {
    publishedAt: new Date(now - 60 * 60 * 1000),
  });
  const newest = makeVideo(channel.id, {
    publishedAt: new Date(now - 10 * 60 * 1000),
  });

  const { runDurationEnrichmentSweep } = await loadSweepModule("test-key");
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    okResponse([
      { id: oldest.youtubeVideoId, duration: "PT1M" },
      { id: middle.youtubeVideoId, duration: "PT1M" },
      { id: newest.youtubeVideoId, duration: "PT1M" },
    ]),
  );

  await runDurationEnrichmentSweep();

  const ourVideoIds = new Set([
    oldest.youtubeVideoId,
    middle.youtubeVideoId,
    newest.youtubeVideoId,
  ]);
  const ids = requestedIds(fetchSpy).filter((id) => ourVideoIds.has(id));
  expect(ids).toEqual([
    newest.youtubeVideoId,
    middle.youtubeVideoId,
    oldest.youtubeVideoId,
  ]);

  fetchSpy.mockRestore();
});

test("eligibility query caps the batch at 50 rows", async () => {
  const channel = makeChannel();
  subscribe(channel.id, true);
  const created = Array.from({ length: 55 }, () => makeVideo(channel.id));

  const { runDurationEnrichmentSweep } = await loadSweepModule("test-key");
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    url: URL,
  ) => {
    const requested = (url.searchParams.get("id") ?? "").split(",");
    return okResponse(requested.map((id) => ({ id, duration: "PT1M" })));
  }) as unknown as typeof fetch);

  await runDurationEnrichmentSweep();

  expect(requestedIds(fetchSpy)).toHaveLength(50);
  fetchSpy.mockRestore();

  // Drain the remaining 5 so this pool doesn't leak into later tests.
  const fetchSpy2 = spyOn(globalThis, "fetch").mockImplementation((async (
    url: URL,
  ) => {
    const requested = (url.searchParams.get("id") ?? "").split(",");
    return okResponse(requested.map((id) => ({ id, duration: "PT1M" })));
  }) as unknown as typeof fetch);
  await runDurationEnrichmentSweep();
  fetchSpy2.mockRestore();

  for (const video of created) {
    expect(videoRow(video.id).durationSeconds).toBe(60);
  }
});

test("writes durationSeconds on a successful response, matched by id field even when one requested id is missing from the response", async () => {
  const channel = makeChannel();
  subscribe(channel.id, true);
  const first = makeVideo(channel.id);
  const missing = makeVideo(channel.id);
  const second = makeVideo(channel.id);

  const { runDurationEnrichmentSweep } = await loadSweepModule("test-key");
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    // Deliberately out of request order, and omits `missing` entirely -- a
    // positional match would shift `second`'s duration onto the wrong video.
    okResponse([
      { id: second.youtubeVideoId, duration: "PT2M" },
      { id: first.youtubeVideoId, duration: "PT1M" },
    ]),
  );

  await runDurationEnrichmentSweep();

  expect(videoRow(first.id).durationSeconds).toBe(60);
  expect(videoRow(second.id).durationSeconds).toBe(120);
  expect(videoRow(missing.id).durationSeconds).toBeNull();

  fetchSpy.mockRestore();
  discard(missing.id);
});

test("a bad-key response latches: a second sweep call makes no further fetch call", async () => {
  const channel = makeChannel();
  subscribe(channel.id, true);
  const video = makeVideo(channel.id);

  const { runDurationEnrichmentSweep } = await loadSweepModule("test-key");
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    badKeyResponse(),
  );

  await runDurationEnrichmentSweep();
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  await runDurationEnrichmentSweep();
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  expect(videoRow(video.id).durationSeconds).toBeNull();

  fetchSpy.mockRestore();
  discard(video.id);
});

test("Google's real 400 API_KEY_INVALID response latches: a second sweep call makes no further fetch call", async () => {
  const channel = makeChannel();
  subscribe(channel.id, true);
  const video = makeVideo(channel.id);

  const { runDurationEnrichmentSweep } = await loadSweepModule("test-key");
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    realShapeBadKeyResponse(),
  );

  await runDurationEnrichmentSweep();
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  await runDurationEnrichmentSweep();
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  fetchSpy.mockRestore();
  discard(video.id);
});

test("a transient failure does not latch: a second sweep call makes another fetch call", async () => {
  const channel = makeChannel();
  subscribe(channel.id, true);
  const video = makeVideo(channel.id);

  const { runDurationEnrichmentSweep } = await loadSweepModule("test-key");
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    transientResponse(),
  );

  await runDurationEnrichmentSweep();
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  await runDurationEnrichmentSweep();
  expect(fetchSpy).toHaveBeenCalledTimes(2);

  expect(videoRow(video.id).durationSeconds).toBeNull();

  fetchSpy.mockRestore();
  discard(video.id);
});
