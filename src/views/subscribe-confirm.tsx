import type { FC } from "hono/jsx";
import type { categories } from "../db/schema";

type Category = typeof categories.$inferSelect;

const INPUT_CLASS =
  "rounded border border-border bg-surface-raised px-3 py-1.5 text-sm text-text placeholder:text-text-muted";
const PRIMARY_BUTTON_CLASS =
  "rounded bg-accent-strong px-3 py-1 text-sm text-bg hover:bg-accent";
const SECONDARY_BUTTON_CLASS =
  "rounded border border-border px-3 py-1 text-sm hover:bg-surface-raised";
const PANEL_CLASS = "mb-4 rounded-lg border border-border bg-surface p-4";

export const BlankSubscribeForm: FC<{ categories: Category[] }> = (props) => {
  return (
    <div id="confirm-panel" class={PANEL_CLASS}>
      <form
        hx-post="/subscriptions/preview"
        hx-target="#confirm-panel"
        hx-swap="outerHTML"
        class="flex flex-col gap-2"
      >
        <p class="text-sm text-text-muted">
          Paste the channel's ID (starts with <code>UC</code>), a URL containing{" "}
          <code>/channel/UC.../</code>, or the channel's RSS feed URL. To find
          the ID: open the channel's page, view source, and search for{" "}
          <code>channelId</code>.
        </p>
        <input
          type="text"
          name="channelInput"
          placeholder="Channel ID or URL"
          class={INPUT_CLASS}
        />
        <select name="categoryId" class={INPUT_CLASS}>
          <option value="">Uncategorized</option>
          {props.categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <button type="submit" class={`self-start ${PRIMARY_BUTTON_CLASS}`}>
          Subscribe
        </button>
      </form>
    </div>
  );
};

export const ConfirmPanel: FC<{
  channelId: string;
  categoryId: string;
  channelName: string;
}> = (props) => {
  return (
    <div id="confirm-panel" class={PANEL_CLASS}>
      <p class="text-text">Subscribe to {props.channelName}?</p>
      <form
        hx-post="/subscriptions"
        hx-target="#confirm-panel"
        hx-swap="outerHTML"
        class="mt-2"
      >
        <input type="hidden" name="channelId" value={props.channelId} />
        <input type="hidden" name="categoryId" value={props.categoryId} />
        <button type="submit" class={PRIMARY_BUTTON_CLASS}>
          Confirm Subscribe
        </button>
      </form>
      {/* Reuses GET /channels (which always renders the blank form as the
          panel's default state) rather than adding a dedicated cancel route --
          hx-select pulls just #confirm-panel back out of that full-page response. */}
      <button
        type="button"
        hx-get="/channels"
        hx-select="#confirm-panel"
        hx-target="#confirm-panel"
        hx-swap="outerHTML"
        class={`mt-2 ${SECONDARY_BUTTON_CLASS}`}
      >
        Cancel
      </button>
    </div>
  );
};

export const ConfirmError: FC<{ message: string }> = (props) => {
  return (
    <div id="confirm-panel" class={PANEL_CLASS}>
      <p class="text-danger">{props.message}</p>
    </div>
  );
};
