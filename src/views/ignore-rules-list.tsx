import type { FC } from "hono/jsx";
import type { ignoreRules } from "../db/schema";
import { EmptyState } from "./empty-state";

type IgnoreRule = typeof ignoreRules.$inferSelect;

const INPUT_CLASS =
  "rounded border border-border bg-surface-raised px-3 py-1.5 text-sm text-text placeholder:text-text-muted";
const PRIMARY_BUTTON_CLASS =
  "rounded bg-accent-strong px-3 py-1 text-sm text-bg hover:bg-accent";
const SECONDARY_BUTTON_CLASS =
  "rounded border border-border px-3 py-1 text-sm hover:bg-surface-raised";

export const IgnoreRulesList: FC<{
  rules: IgnoreRule[];
  editingId?: number;
  error?: string;
}> = (props) => (
  <div
    id="ignore-rules-list"
    class="rounded-lg border border-border bg-surface"
  >
    <form
      hx-post="/ignore-rules"
      hx-target="#ignore-rules-list"
      hx-swap="outerHTML"
      class="flex gap-2 p-4"
    >
      <input
        type="text"
        name="keyword"
        placeholder="New keyword"
        class={`flex-1 ${INPUT_CLASS}`}
      />
      <button type="submit" class={PRIMARY_BUTTON_CLASS}>
        Add
      </button>
    </form>
    {props.rules.length === 0 ? (
      <EmptyState message="No ignore rules yet — add one below." />
    ) : (
      <ul class="divide-y divide-border">
        {props.rules.map((rule) =>
          props.editingId === rule.id ? (
            <li key={rule.id} class="flex items-center gap-2 px-4 py-3">
              <form
                hx-post={`/ignore-rules/${rule.id}`}
                hx-target="#ignore-rules-list"
                hx-swap="outerHTML"
                class="flex flex-1 gap-2"
              >
                <input
                  type="text"
                  name="keyword"
                  value={rule.keyword}
                  class={INPUT_CLASS}
                />
                <button type="submit" class={PRIMARY_BUTTON_CLASS}>
                  Save
                </button>
              </form>
              <button
                type="button"
                hx-get="/ignore-rules"
                hx-select="#ignore-rules-list"
                hx-target="#ignore-rules-list"
                hx-swap="outerHTML"
                class={SECONDARY_BUTTON_CLASS}
              >
                Cancel
              </button>
            </li>
          ) : (
            <li
              key={rule.id}
              class="flex items-center justify-between gap-2 px-4 py-3 hover:bg-surface-raised"
            >
              {rule.keyword}
              <span class="flex items-center gap-2">
                <button
                  type="button"
                  hx-get={`/ignore-rules/${rule.id}/edit`}
                  hx-target="#ignore-rules-list"
                  hx-swap="outerHTML"
                  class={SECONDARY_BUTTON_CLASS}
                >
                  Edit
                </button>
                <button
                  type="button"
                  hx-delete={`/ignore-rules/${rule.id}`}
                  hx-target="#ignore-rules-list"
                  hx-swap="outerHTML"
                  class={SECONDARY_BUTTON_CLASS}
                >
                  Delete
                </button>
              </span>
            </li>
          ),
        )}
      </ul>
    )}
    {props.error ? (
      <p class="px-4 pt-2 text-sm text-danger">{props.error}</p>
    ) : null}
  </div>
);
