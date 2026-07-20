import type { Child, FC } from "hono/jsx";

export const Layout: FC<{ title: string; children?: Child }> = (props) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="stylesheet" href="/css/tailwind.css" />
        <script src="https://unpkg.com/htmx.org@2.0.4" />
      </head>
      <body class="bg-gray-50 text-gray-900">{props.children}</body>
    </html>
  );
};
