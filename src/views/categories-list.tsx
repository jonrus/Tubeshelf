import type { FC } from "hono/jsx";
import type { CategoryWithCount } from "../lib/categories";

export const CategoriesList: FC<{
  categories: CategoryWithCount[];
  editingId?: number;
  error?: string;
}> = (props) => {
  return (
    <div id="category-list">
      <ul>
        {props.categories.map((category) =>
          props.editingId === category.id ? (
            <li key={category.id}>
              <form
                hx-post={`/categories/${category.id}`}
                hx-target="#category-list"
                hx-swap="outerHTML"
              >
                <input type="text" name="name" value={category.name} />
                <button type="submit">Save</button>
              </form>
              <button
                type="button"
                hx-get="/categories"
                hx-select="#category-list"
                hx-target="#category-list"
                hx-swap="outerHTML"
              >
                Cancel
              </button>
            </li>
          ) : (
            <li key={category.id}>
              <a href={`/queue?category=${category.id}`}>
                {category.name} ({category.unwatchedCount})
              </a>
              {category.isSystem ? " [system]" : ""}{" "}
              {category.isSystem ? null : (
                <button
                  type="button"
                  hx-get={`/categories/${category.id}/edit`}
                  hx-target="#category-list"
                  hx-swap="outerHTML"
                >
                  Edit
                </button>
              )}
            </li>
          ),
        )}
      </ul>
      {props.error ? <p class="text-red-600">{props.error}</p> : null}
      <form
        hx-post="/categories"
        hx-target="#category-list"
        hx-swap="outerHTML"
      >
        <input type="text" name="name" placeholder="New category" />
        <button type="submit">Add</button>
      </form>
    </div>
  );
};
