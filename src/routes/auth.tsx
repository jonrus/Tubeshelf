import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  attemptLogin,
  createSession,
  csrfCheck,
  deleteSession,
  getSessionFromRequest,
  resolveCookieSecure,
  safeRedirectTarget,
} from "../lib/auth";
import { LoginPage } from "../views/login-page";

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export const authRoute = new Hono();

authRoute.use("*", csrfCheck);

authRoute.get("/login", (c) => {
  const from = c.req.query("from");
  if (getSessionFromRequest(c)) {
    return c.redirect(safeRedirectTarget(from), 302);
  }
  return c.html(<LoginPage from={from} />);
});

authRoute.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const from = typeof body.from === "string" ? body.from : undefined;

  const result = await attemptLogin(username, password);
  if (!result.ok) {
    return c.html(
      <LoginPage from={from} error="Invalid username or password." />,
      401,
    );
  }

  const { token } = createSession(result.userId);
  setCookie(c, "session", token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: resolveCookieSecure(c),
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
  });
  return c.redirect(safeRedirectTarget(from), 302);
});

authRoute.post("/logout", (c) => {
  const token = getCookie(c, "session");
  if (token) deleteSession(token);
  deleteCookie(c, "session", { path: "/" });
  return c.redirect("/login", 302);
});
