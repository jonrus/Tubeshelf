import { and, asc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { categories, subscriptions, youtubeChannels } from "../db/schema";
import {
  CHANNEL_ID_PATTERN,
  parseChannelInput,
  rssUrlFor,
} from "../lib/channel-input";
import { getCurrentUser } from "../lib/current-user";
import { applyFeedToChannel, ingestChannel } from "../lib/ingest";
import { fetchChannelFeed } from "../lib/rss";
import { upsertSubscription, upsertYoutubeChannel } from "../lib/subscribe";
import { ChannelsPage } from "../views/channels-page";
import {
  BlankSubscribeForm,
  ConfirmError,
  ConfirmPanel,
} from "../views/subscribe-confirm";
import { SubscriptionList } from "../views/subscription-list";

type CategoryResolution =
  | { ok: true; categoryId: number }
  | { ok: false; error: string };

function resolveCategoryId(categoryIdRaw: string): CategoryResolution {
  if (categoryIdRaw === "") {
    const systemCategory = db
      .select()
      .from(categories)
      .where(eq(categories.isSystem, true))
      .get();
    if (!systemCategory)
      throw new Error("seed did not create the system category");
    return { ok: true, categoryId: systemCategory.id };
  }
  const category = db
    .select()
    .from(categories)
    .where(eq(categories.id, Number(categoryIdRaw)))
    .get();
  if (!category || category.isSystem) {
    return { ok: false, error: "Invalid category." };
  }
  return { ok: true, categoryId: category.id };
}

function listNonSystemCategories() {
  return db
    .select()
    .from(categories)
    .where(eq(categories.isSystem, false))
    .orderBy(asc(categories.name))
    .all();
}

function hasUndismissedGap(
  detectedAt: Date | null,
  dismissedAt: Date | null,
): boolean {
  return (
    detectedAt !== null && (dismissedAt === null || dismissedAt < detectedAt)
  );
}

function listActiveSubscriptions(userId: number) {
  return db
    .select({
      id: subscriptions.id,
      channelName: youtubeChannels.name,
      categoryName: categories.name,
      possibleMissedVideosDetectedAt:
        youtubeChannels.possibleMissedVideosDetectedAt,
      missedVideosDismissedAt: subscriptions.missedVideosDismissedAt,
    })
    .from(subscriptions)
    .innerJoin(
      youtubeChannels,
      eq(subscriptions.youtubeChannelId, youtubeChannels.id),
    )
    .innerJoin(categories, eq(subscriptions.categoryId, categories.id))
    .where(
      and(
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
      ),
    )
    .orderBy(asc(youtubeChannels.name))
    .all()
    .map(
      ({
        possibleMissedVideosDetectedAt,
        missedVideosDismissedAt,
        ...rest
      }) => ({
        ...rest,
        showMissedVideosBadge: hasUndismissedGap(
          possibleMissedVideosDetectedAt,
          missedVideosDismissedAt,
        ),
      }),
    );
}

export const channelsRoute = new Hono();

channelsRoute.get("/channels", (c) => {
  const user = getCurrentUser();
  return c.html(
    <ChannelsPage
      categories={listNonSystemCategories()}
      subscriptions={listActiveSubscriptions(user.id)}
    />,
  );
});

channelsRoute.post("/subscriptions/preview", async (c) => {
  const body = await c.req.parseBody();
  const channelInput =
    typeof body.channelInput === "string" ? body.channelInput : "";
  const categoryIdRaw =
    typeof body.categoryId === "string" ? body.categoryId : "";

  const parsed = parseChannelInput(channelInput);
  if (!parsed) {
    return c.html(
      <ConfirmError message="Couldn't parse that as a channel ID or URL." />,
    );
  }

  const resolvedCategory = resolveCategoryId(categoryIdRaw);
  if (!resolvedCategory.ok) {
    return c.html(<ConfirmError message={resolvedCategory.error} />);
  }

  const existing = db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.youtubeChannelId, parsed.channelId))
    .get();

  let channelName: string;
  if (existing) {
    channelName = existing.name;
  } else {
    const feed = await fetchChannelFeed(parsed.rssUrl);
    if (!feed) {
      return c.html(
        <ConfirmError message="Couldn't fetch that channel's feed." />,
      );
    }
    channelName = feed.title;
  }

  return c.html(
    <ConfirmPanel
      channelId={parsed.channelId}
      categoryId={categoryIdRaw}
      channelName={channelName}
    />,
  );
});

channelsRoute.post("/subscriptions", async (c) => {
  const user = getCurrentUser();
  const body = await c.req.parseBody();
  const channelId = typeof body.channelId === "string" ? body.channelId : "";
  const categoryIdRaw =
    typeof body.categoryId === "string" ? body.categoryId : "";

  if (!CHANNEL_ID_PATTERN.test(channelId)) {
    return c.html(<ConfirmError message="Invalid channel." />);
  }

  const resolvedCategory = resolveCategoryId(categoryIdRaw);
  if (!resolvedCategory.ok) {
    return c.html(<ConfirmError message={resolvedCategory.error} />);
  }

  const rssUrl = rssUrlFor(channelId);
  const result = await upsertYoutubeChannel(channelId, rssUrl);
  if (!result) {
    return c.html(
      <ConfirmError message="Couldn't fetch that channel's feed." />,
    );
  }

  const { channel, feed } = result;
  if (feed) {
    applyFeedToChannel(channel.id, feed);
  } else {
    await ingestChannel(channel);
  }

  const subscribeResult = upsertSubscription(
    user.id,
    channel.id,
    resolvedCategory.categoryId,
  );
  if (subscribeResult.outcome === "already-subscribed") {
    return c.html(
      <ConfirmError message="Already subscribed to that channel." />,
    );
  }

  return c.html(
    <>
      <BlankSubscribeForm categories={listNonSystemCategories()} />
      <SubscriptionList subscriptions={listActiveSubscriptions(user.id)} oob />
    </>,
  );
});

channelsRoute.delete("/subscriptions/:id", (c) => {
  const user = getCurrentUser();
  const id = Number(c.req.param("id"));

  const updated = db
    .update(subscriptions)
    .set({ unsubscribedAt: new Date() })
    .where(
      and(
        eq(subscriptions.id, id),
        eq(subscriptions.userId, user.id),
        isNull(subscriptions.unsubscribedAt),
      ),
    )
    .returning()
    .get();

  if (!updated) {
    return c.notFound();
  }

  return c.html(
    <SubscriptionList subscriptions={listActiveSubscriptions(user.id)} />,
  );
});

channelsRoute.post("/subscriptions/:id/dismiss-missed-videos", (c) => {
  const user = getCurrentUser();
  const id = Number(c.req.param("id"));

  const updated = db
    .update(subscriptions)
    .set({ missedVideosDismissedAt: new Date() })
    .where(
      and(
        eq(subscriptions.id, id),
        eq(subscriptions.userId, user.id),
        isNull(subscriptions.unsubscribedAt),
      ),
    )
    .returning()
    .get();

  if (!updated) {
    return c.notFound();
  }

  return c.html(
    <SubscriptionList subscriptions={listActiveSubscriptions(user.id)} />,
  );
});
