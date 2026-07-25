import type { FC } from "hono/jsx";
import type { ignoreRules } from "../db/schema";

type IgnoreRule = typeof ignoreRules.$inferSelect;

export const IgnoreRulesList: FC<{
  rules: IgnoreRule[];
  editingId?: number;
  error?: string;
}> = (props) => (
  <div id="ignore-rules-list">
    <ul>
      {props.rules.map((rule) =>
        props.editingId === rule.id ? (
          <li key={rule.id}>
            <form
              hx-post={`/ignore-rules/${rule.id}`}
              hx-target="#ignore-rules-list"
              hx-swap="outerHTML"
            >
              <input type="text" name="keyword" value={rule.keyword} />
              <button type="submit">Save</button>
            </form>
            <button
              type="button"
              hx-get="/ignore-rules"
              hx-select="#ignore-rules-list"
              hx-target="#ignore-rules-list"
              hx-swap="outerHTML"
            >
              Cancel
            </button>
          </li>
        ) : (
          <li key={rule.id}>
            {rule.keyword}{" "}
            <button
              type="button"
              hx-get={`/ignore-rules/${rule.id}/edit`}
              hx-target="#ignore-rules-list"
              hx-swap="outerHTML"
            >
              Edit
            </button>{" "}
            <button
              type="button"
              hx-delete={`/ignore-rules/${rule.id}`}
              hx-target="#ignore-rules-list"
              hx-swap="outerHTML"
            >
              Delete
            </button>
          </li>
        ),
      )}
    </ul>
    {props.error ? <p class="text-red-600">{props.error}</p> : null}
    <form
      hx-post="/ignore-rules"
      hx-target="#ignore-rules-list"
      hx-swap="outerHTML"
    >
      <input type="text" name="keyword" placeholder="New keyword" />
      <button type="submit">Add</button>
    </form>
  </div>
);
