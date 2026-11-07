import { beforeEach, expect, test } from "bun:test";
import { users, userSessions } from "../src/db/schema";
import { sha256Hex } from "../src/modules/access/crypto";
import { SEED } from "../src/db/seed";
import { appDb, get, post, resetDb, testApp } from "./helpers";

beforeEach(resetDb);

const cookieValue = (res: Response) => res.headers.get("set-cookie")?.match(/sid=([^;]*)/)?.[1] ?? "";

async function login(app: ReturnType<typeof testApp>["app"], userId: string = SEED.users.alice) {
  const res = await post(app, "/login", { userId });
  return { res, cookie: `sid=${cookieValue(res)}` };
}

test("login sets a hardened session cookie and lands on home", async () => {
  const { app } = testApp();
  const { res, cookie } = await login(app);
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/");
  const setCookie = res.headers.get("set-cookie")!;
  expect(setCookie).toMatch(/sid=[^;]+/);
  expect(setCookie).toMatch(/HttpOnly/i);
  expect(setCookie).toMatch(/SameSite=Strict/i);
  expect(setCookie).toMatch(/Path=\//);
  expect(setCookie).not.toMatch(/Secure/i);
  const home = await get(app, "/", { cookie });
  expect(home.status).toBe(200);
  expect(await home.text()).toContain("Alice Banker");
});

test("session token is stored only as a hash", async () => {
  const { res } = await login(testApp().app);
  const token = decodeURIComponent(cookieValue(res));
  const rows = await appDb.select().from(userSessions);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.tokenHash).toBe(sha256Hex(token));
  expect(JSON.stringify(rows)).not.toContain(token);
});

test("home without a session redirects to login", async () => {
  const res = await get(testApp().app, "/");
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/login");
});

test("garbage or unknown cookie is treated as signed out", async () => {
  for (const cookie of ["sid=not-a-token", "sid=", "sid=%E0%A4%A"]) {
    const res = await get(testApp().app, "/", { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
  }
});

test("expired session is refused", async () => {
  let now = new Date("2026-11-07T00:00:00Z");
  const { app } = testApp({ now: () => now });
  const { cookie } = await login(app);
  now = new Date(now.getTime() + 8 * 3600_000 - 1000);
  expect((await get(app, "/", { cookie })).status).toBe(200);
  now = new Date(now.getTime() + 2000);
  expect((await get(app, "/", { cookie })).headers.get("location")).toBe("/login");
});

test("logout ends the session", async () => {
  const { app } = testApp();
  const { cookie } = await login(app);
  const out = await post(app, "/logout", {}, { cookie });
  expect(out.status).toBe(303);
  expect(out.headers.get("location")).toBe("/login");
  expect((await get(app, "/", { cookie })).headers.get("location")).toBe("/login");
});

test("login rejects unknown or malformed user ids", async () => {
  const { app } = testApp();
  for (const userId of ["nope", crypto.randomUUID()]) {
    const res = await post(app, "/login", { userId });
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  }
});

test("user names are escaped in pages", async () => {
  const [u] = await appDb.insert(users).values({ name: "<script>x</script>", role: "banker" }).returning();
  const { app } = testApp();
  const { cookie } = await login(app, u!.id);
  const body = await (await get(app, "/", { cookie })).text();
  expect(body).toContain("&lt;script&gt;");
  expect(body).not.toContain("<script>x");
});

test("login page lists every seeded user", async () => {
  const body = await (await get(testApp().app, "/login")).text();
  for (const name of ["Alice Banker", "Bob Banker", "Carol Compliance"]) expect(body).toContain(name);
});
