import type { FC } from "hono/jsx";

const INPUT_CLASS =
  "rounded border border-border bg-surface-raised px-3 py-1.5 text-sm text-text placeholder:text-text-muted";
const PRIMARY_BUTTON_CLASS =
  "rounded bg-accent-strong px-3 py-1.5 text-sm text-bg hover:bg-accent";

export const LoginPage: FC<{
  from?: string;
  error?: string;
}> = (props) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Log in — Tubeshelf</title>
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/icons/icon-32.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href="/icons/icon-16.png"
        />
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href="/icons/icon-180.png"
        />
        <link rel="manifest" href="/manifest.json" />
        <link rel="stylesheet" href="/css/tailwind.css" />
      </head>
      <body class="flex min-h-screen items-center justify-center bg-bg text-text">
        <div class="w-full max-w-sm rounded-lg border border-border bg-surface p-6">
          <h1 class="mb-4 text-lg font-semibold">Log in</h1>
          {props.error ? (
            <p class="mb-4 text-sm text-danger">{props.error}</p>
          ) : null}
          <form method="post" action="/login" class="flex flex-col gap-3">
            <input type="hidden" name="from" value={props.from ?? ""} />
            <label class="flex flex-col gap-1 text-sm text-text-muted">
              Username
              <input
                type="text"
                name="username"
                autofocus
                class={INPUT_CLASS}
              />
            </label>
            <label class="flex flex-col gap-1 text-sm text-text-muted">
              Password
              <input type="password" name="password" class={INPUT_CLASS} />
            </label>
            <button type="submit" class={`mt-2 ${PRIMARY_BUTTON_CLASS}`}>
              Log in
            </button>
          </form>
        </div>
      </body>
    </html>
  );
};
