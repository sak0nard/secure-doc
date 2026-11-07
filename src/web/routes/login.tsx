import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import { users } from "../../db/schema";
import type { Deps } from "../../deps";
import { createUserSession, endUserSession, USER_SESSION_TTL_MS } from "../../modules/access/sessions";
import { Layout, page } from "../render";
import { readCookie, requireUser, SESSION_COOKIE } from "../session";

const LoginForm = z.object({ userId: z.uuid() });

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ location });
  if (cookie) headers.set("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export function loginRoutes(deps: Deps) {
  const secure = deps.config.baseUrl.protocol === "https:" ? "; Secure" : "";
  const sessionCookie = (value: string, maxAgeSeconds: number) =>
    `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;

  return new Elysia()
    .get("/login", async () => {
      const all = await deps.db.select().from(users).orderBy(users.name);
      return page(
        <Layout title="Sign in">
          <h1>Sign in</h1>
          <p>Mock sign-in for the demo. Production uses the bank's single sign-on.</p>
          <form method="post" action="/login">
            {all.map((u, i) => (
              <label key={u.id}>
                <input type="radio" name="userId" value={u.id} required defaultChecked={i === 0} /> {u.name} ({u.role})
              </label>
            ))}
            <button type="submit">Sign in</button>
          </form>
        </Layout>,
      );
    })
    .post("/login", async ({ body }) => {
      const parsed = LoginForm.safeParse(body);
      const user = parsed.success
        ? (await deps.db.select().from(users).where(eq(users.id, parsed.data.userId)))[0]
        : undefined;
      if (!user) {
        return page(
          <Layout title="Sign in">
            <p>Unknown user. <a href="/login">Try again</a>.</p>
          </Layout>,
          { status: 400 },
        );
      }
      const { token } = await createUserSession(deps.db, user.id, deps.now());
      return redirect("/", sessionCookie(token, USER_SESSION_TTL_MS / 1000));
    })
    .post("/logout", async ({ request }) => {
      await endUserSession(deps.db, readCookie(request, SESSION_COOKIE), deps.now());
      return redirect("/login", sessionCookie("", 0));
    })
    .use(requireUser(deps))
    .get("/", ({ user }) =>
      page(
        <Layout title="Home">
          <p>
            Signed in as {user!.name} ({user!.role})
          </p>
          <form method="post" action="/logout">
            <button type="submit">Sign out</button>
          </form>
        </Layout>,
      ),
    );
}
