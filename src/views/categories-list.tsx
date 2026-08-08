import type { FC } from "hono/jsx";
import type { CategoryWithCount } from "../lib/categories";
import { EmptyState } from "./empty-state";

const INPUT_CLASS =
  "rounded border border-border bg-surface-raised px-3 py-1.5 text-sm text-text placeholder:text-text-muted";
const PRIMARY_BUTTON_CLASS =
  "rounded bg-accent-strong px-3 py-1 text-sm text-bg hover:bg-accent";
const SECONDARY_BUTTON_CLASS =
  "rounded border border-border px-3 py-1 text-sm hover:bg-surface-raised";

export const CategoriesList: FC<{
  categories: CategoryWithCount[];
  editingId?: number;
  error?: string;
}> = (props) => {
  return (
    <div id="category-list" class="rounded-lg border border-border bg-surface">
      <form
        hx-post="/categories"
        hx-target="#category-list"
        hx-swap="outerHTML"
        class="flex gap-2 p-4"
      >
        <input
          type="text"
          name="name"
          placeholder="New category"
          class={`flex-1 ${INPUT_CLASS}`}
        />
        <button type="submit" class={PRIMARY_BUTTON_CLASS}>
          Add
        </button>
      </form>
      {props.categories.length === 0 ? (
        <EmptyState message="No categories yet — add one above." />
      ) : (
        <ul class="divide-y divide-border">
          {props.categories.map((category) =>
            props.editingId === category.id ? (
              <li key={category.id} class="flex items-center gap-2 px-4 py-3">
                <form
                  hx-post={`/categories/${category.id}`}
                  hx-target="#category-list"
                  hx-swap="outerHTML"
                  class="flex flex-1 gap-2"
                >
                  <input
                    type="text"
                    name="name"
                    value={category.name}
                    class={`flex-1 ${INPUT_CLASS}`}
                  />
                  <button type="submit" class={PRIMARY_BUTTON_CLASS}>
                    Save
                  </button>
                </form>
                <button
                  type="button"
                  hx-get="/categories"
                  hx-select="#category-list"
                  hx-target="#category-list"
                  hx-swap="outerHTML"
                  class={SECONDARY_BUTTON_CLASS}
                >
                  Cancel
                </button>
              </li>
            ) : (
              <li
                key={category.id}
                class="flex items-center justify-between gap-2 px-4 py-3 hover:bg-surface-raised"
              >
                <a href={`/queue?category=${category.id}`}>
                  {category.name} ({category.unwatchedCount})
                </a>
                <span class="flex items-center gap-2 text-sm text-text-muted">
                  {category.isSystem ? "[system]" : null}
                  {category.isSystem ? null : (
                    <button
                      type="button"
                      hx-get={`/categories/${category.id}/edit`}
                      hx-target="#category-list"
                      hx-swap="outerHTML"
                      class={SECONDARY_BUTTON_CLASS}
                    >
                      Edit
                    </button>
                  )}
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
};
