import type { FC } from "hono/jsx";
import type { categories } from "../db/schema";

type Category = typeof categories.$inferSelect;

export const CategoriesList: FC<{ categories: Category[]; error?: string }> = (props) => {
  return (
    <div id="category-list">
      <ul>
        {props.categories.map((category) => (
          <li key={category.id}>
            {category.name}
            {category.isSystem ? " [system]" : ""}
          </li>
        ))}
      </ul>
      {props.error ? <p class="text-red-600">{props.error}</p> : null}
      <form hx-post="/categories" hx-target="#category-list" hx-swap="outerHTML">
        <input type="text" name="name" placeholder="New category" />
        <button type="submit">Add</button>
      </form>
    </div>
  );
};
