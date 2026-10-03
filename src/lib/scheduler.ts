import { and, asc, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "../db/client";
import { subscriptions, youtubeChannels } from "../db/schema";
import { purgeIdleSessions } from "./auth";
import { runDurationEnrichmentSweep } from "./duration-enrichment";
import { ingestChannel } from "./ingest";
import { logger } from "./logger";

const TICK_INTERVAL_MS = 60 * 1000; // 1 minute
const BATCH_SIZE = 5; // cap per tick so a post-downtime backlog drains gradually
const SESSION_PURGE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

type YoutubeChannelRow = typeof youtubeChannels.$inferSelect;

// Pure-ish query, separated from the setInterval wiring so it's directly testable
// without waiting on real timers.
export function dueChannels(
  now: Date,
  limit = BATCH_SIZE,
): YoutubeChannelRow[] {
  const activelySubscribed = db
    .select({ id: subscriptions.youtubeChannelId })
    .from(subscriptions)
    .where(isNull(subscriptions.unsubscribedAt));
  return db
    .select()
    .from(youtubeChannels)
    .where(
      and(
        inArray(youtubeChannels.id, activelySubscribed),
        or(
          isNull(youtubeChannels.nextFetchDueAt),
          lte(youtubeChannels.nextFetchDueAt, now),
        ),
      ),
    )
    .orderBy(asc(youtubeChannels.nextFetchDueAt)) // oldest-overdue-first
    .limit(limit)
    .all();
}

// Initialised at module load: index.ts's startup purge has just run (or is about to).
let lastSessionPurgeAt = Date.now();

// Throttled to once per hour so the 60s tick doesn't sweep sessions every time;
// `now` is injectable so the throttle is testable without real timers.
export function maybePurgeSessions(now: Date = new Date()): void {
  if (now.getTime() - lastSessionPurgeAt < SESSION_PURGE_INTERVAL_MS) return;
  purgeIdleSessions(now);
  lastSessionPurgeAt = now.getTime();
}

async function tick(): Promise<void> {
  for (const channel of dueChannels(new Date())) {
    await ingestChannel(channel); // never throws -- see ingestChannel's try/catch
  }

  // Separate try/catch from the ingest loop above so an enrichment failure is
  // never conflated with (or logged as) an ingestion failure.
  try {
    await runDurationEnrichmentSweep();
  } catch (err) {
    logger.error("Duration enrichment sweep failed", { err });
  }

  try {
    maybePurgeSessions();
  } catch (err) {
    logger.error("Session purge failed", { err });
  }
}

// Wraps tick() with the re-entrancy guard, factored out from startScheduler's
// setInterval wiring specifically so it's directly callable from a test (invoke it
// twice back-to-back with a slow/pending tick() and assert the second call is a
// no-op) without needing real 60s timers.
let ticking = false;
let inFlightTick: Promise<void> | null = null;
export async function runGuardedTick(): Promise<void> {
  if (ticking) return; // previous tick still in flight -- skip rather than overlap
  ticking = true;
  inFlightTick = tick()
    .catch((err) => {
      logger.error("Ingestion tick failed", { err });
    })
    .finally(() => {
      ticking = false;
      inFlightTick = null;
    });
  await inFlightTick;
}

// Lets code outside this module (the shutdown routine) await any tick that's
// currently in flight, without exposing the internal `ticking`/`inFlightTick` state.
export function waitForSchedulerIdle(): Promise<void> {
  return inFlightTick ?? Promise.resolve();
}

export function startScheduler(): Timer {
  return setInterval(() => {
    void runGuardedTick();
  }, TICK_INTERVAL_MS);
}
