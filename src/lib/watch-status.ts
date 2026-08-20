import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { subscriptions, videos, youtubeChannels } from "../db/schema";

function getCurrentStatus(videoId: number, userId: number) {
  return db
    .select({ status: videos.status })
    .from(videos)
    .innerJoin(youtubeChannels, eq(videos.channelId, youtubeChannels.id))
    .innerJoin(
      subscriptions,
      eq(subscriptions.youtubeChannelId, youtubeChannels.id),
    )
    .where(
      and(
        eq(videos.id, videoId),
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
      ),
    )
    .get();
}

export function setWatching(
  videoId: number,
  userId: number,
): { status: "watching" } | null {
  const current = getCurrentStatus(videoId, userId);
  if (!current) return null;

  db.update(videos)
    .set({
      status: "watching",
      // Only touches watchedAt on the watched -> watching branch (the rewatch flow via
      // the Watching page's "Mark Watching" button) -- the other two source states
      // (unwatched, watching) already have it null, so leaving the key out of `set`
      // avoids a redundant write on the far more common non-rewatch path.
      ...(current.status === "watched" ? { watchedAt: null } : {}),
      ignoreMethod: null,
    })
    .where(eq(videos.id, videoId))
    .run();

  return { status: "watching" };
}

// Used only by POST /videos/:id/toggle -- the queue/continue-watching row's manual
// toggle. Matches app_idea.md: "for Watched/Unwatched videos it flips between the two;
// for a video currently Watching, it clears the video back to Unwatched (this is the
// only path back from Watching)."
export function toggleQueueStatus(
  videoId: number,
  userId: number,
): { status: "watched" | "unwatched" } | null {
  const current = getCurrentStatus(videoId, userId);
  if (!current) return null;

  // unwatched -> watched
  // watched   -> unwatched
  // watching  -> unwatched
  const nextStatus = current.status === "unwatched" ? "watched" : "unwatched";

  db.update(videos)
    .set({
      status: nextStatus,
      watchedAt: nextStatus === "watched" ? new Date() : null,
      ignoreMethod: null,
    })
    .where(eq(videos.id, videoId))
    .run();

  return { status: nextStatus };
}

// Used only by POST /videos/:id/watched-toggle -- the Watching page's "Mark
// Watched/Unwatched & Return to X" button. Matches app_idea.md: "the Watching page
// itself only ever moves a video forward to Watched" -- unwatched AND watching both
// move forward to watched here (unlike toggleQueueStatus, which treats watching as
// "clear to unwatched"). The *only* backward transition this function ever makes is the
// explicitly-named revisit case: an already-Watched video's button flips to "Mark
// Unwatched," i.e. watched -> unwatched.
export function toggleWatchedFromWatchingPage(
  videoId: number,
  userId: number,
): { status: "watched" | "unwatched" } | null {
  const current = getCurrentStatus(videoId, userId);
  if (!current) return null;

  const nextStatus = current.status === "watched" ? "unwatched" : "watched";

  db.update(videos)
    .set({
      status: nextStatus,
      watchedAt: nextStatus === "watched" ? new Date() : null,
      ignoreMethod: null,
    })
    .where(eq(videos.id, videoId))
    .run();

  return { status: nextStatus };
}

export function ignoreVideo(
  videoId: number,
  userId: number,
): { status: "ignored" } | null {
  const current = getCurrentStatus(videoId, userId);
  if (!current) return null;

  db.update(videos)
    .set({ status: "ignored", ignoreMethod: "manual", watchedAt: null })
    .where(eq(videos.id, videoId))
    .run();
  return { status: "ignored" };
}

export function unignoreVideo(
  videoId: number,
  userId: number,
): { status: "unwatched" } | null {
  const current = getCurrentStatus(videoId, userId);
  if (!current) return null;

  db.update(videos)
    .set({ status: "unwatched", ignoreMethod: null, watchedAt: null })
    .where(eq(videos.id, videoId))
    .run();
  return { status: "unwatched" };
}
