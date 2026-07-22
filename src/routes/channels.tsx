import { and, asc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import {
  categories,
  subscriptions,
  users,
  youtubeChannels,
} from "../db/schema";
import { parseChannelInput } from "../lib/channel-input";
import { upsertSubscription, upsertYoutubeChannel } from "../lib/subscribe";
import { ChannelsPage } from "../views/channels-page";
import { SubscriptionList } from "../views/subscription-list";

function getCurrentUser() {
  const user = db
    .select()
    .from(users)
    .where(eq(users.username, "default"))
    .get();
  if (!user) throw new Error("seed did not create the default user");
  return user;
}

function listNonSystemCategories() {
  return db
    .select()
    .from(categories)
    .where(eq(categories.isSystem, false))
    .orderBy(asc(categories.name))
    .all();
}

function listActiveSubscriptions(userId: number) {
  return db
    .select({
      id: subscriptions.id,
      channelName: youtubeChannels.name,
      categoryName: categories.name,
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
    .all();
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

channelsRoute.post("/subscriptions", async (c) => {
  const user = getCurrentUser();
  const body = await c.req.parseBody();
  const channelInput =
    typeof body.channelInput === "string" ? body.channelInput : "";
  const categoryIdRaw =
    typeof body.categoryId === "string" ? body.categoryId : "";

  const parsed = parseChannelInput(channelInput);
  if (!parsed) {
    return c.html(
      <SubscriptionList
        subscriptions={listActiveSubscriptions(user.id)}
        error="Couldn't parse that as a channel ID or URL."
      />,
    );
  }

  let categoryId: number;
  if (categoryIdRaw === "") {
    const systemCategory = db
      .select()
      .from(categories)
      .where(eq(categories.isSystem, true))
      .get();
    if (!systemCategory)
      throw new Error("seed did not create the system category");
    categoryId = systemCategory.id;
  } else {
    const category = db
      .select()
      .from(categories)
      .where(eq(categories.id, Number(categoryIdRaw)))
      .get();
    if (!category || category.isSystem) {
      return c.html(
        <SubscriptionList
          subscriptions={listActiveSubscriptions(user.id)}
          error="Invalid category."
        />,
      );
    }
    categoryId = category.id;
  }

  const channel = await upsertYoutubeChannel(parsed.channelId, parsed.rssUrl);
  if (!channel) {
    return c.html(
      <SubscriptionList
        subscriptions={listActiveSubscriptions(user.id)}
        error="Couldn't fetch that channel's feed."
      />,
    );
  }

  const result = upsertSubscription(user.id, channel.id, categoryId);
  if (result.outcome === "already-subscribed") {
    return c.html(
      <SubscriptionList
        subscriptions={listActiveSubscriptions(user.id)}
        error="Already subscribed to that channel."
      />,
    );
  }

  return c.html(
    <SubscriptionList subscriptions={listActiveSubscriptions(user.id)} />,
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
