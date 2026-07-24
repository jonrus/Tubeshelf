import type { FC } from "hono/jsx";
import type { categories } from "../db/schema";

type Category = typeof categories.$inferSelect;

export const BlankSubscribeForm: FC<{ categories: Category[] }> = (props) => {
  return (
    <div id="confirm-panel">
      <form
        hx-post="/subscriptions/preview"
        hx-target="#confirm-panel"
        hx-swap="outerHTML"
      >
        <input
          type="text"
          name="channelInput"
          placeholder="Channel ID or URL"
        />
        <select name="categoryId">
          <option value="">Uncategorized</option>
          {props.categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <button type="submit">Subscribe</button>
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
    <div id="confirm-panel">
      <p>Subscribe to {props.channelName}?</p>
      <form
        hx-post="/subscriptions"
        hx-target="#confirm-panel"
        hx-swap="outerHTML"
      >
        <input type="hidden" name="channelId" value={props.channelId} />
        <input type="hidden" name="categoryId" value={props.categoryId} />
        <button type="submit">Confirm Subscribe</button>
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
      >
        Cancel
      </button>
    </div>
  );
};

export const ConfirmError: FC<{ message: string }> = (props) => {
  return (
    <div id="confirm-panel">
      <p class="text-red-600">{props.message}</p>
    </div>
  );
};
