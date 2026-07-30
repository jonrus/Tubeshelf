import type { FC } from "hono/jsx";

export const EmptyState: FC<{ message: string }> = ({ message }) => (
  <p class="text-text-muted col-span-full py-12 text-center">{message}</p>
);
