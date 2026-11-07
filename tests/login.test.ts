import { beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditEvents, users, userSessions } from "../src/db/schema";
import { sha256Hex } from "../src/modules/access/crypto";
import { SEED } from "../src/db/seed";
import { verifyChain } from "../src/modules/audit/audit";
import { appDb, config, get, post, resetDb, testApp } from "./helpers";

beforeEach(resetDb);

const cookieValue = (res: Response) => res.headers.get("set-cookie")?.match(/sid=([^;]*)/)?.[1] ?? "";

async function login(
  app: ReturnType<typeof testApp>["app"],
  userId: string = SEED.users.alice,
  headers?: Record<string, string>,
) {
  const res = await post(app, "/login", { userId }, { headers });
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

test("request log records the real status of a redirect", async () => {
  const { app, logs } = testApp();
  await post(app, "/login", { userId: SEED.users.alice });
  await Bun.sleep(5); // the log hook runs after the response is sent
  expect(logs.some((l) => l.startsWith("POST /login 303 "))).toBe(true);
});

const eventsFor = (action: string) => appDb.select().from(auditEvents).where(eq(auditEvents.action, action));

test("sign-in is audited", async () => {
  const { res } = await login(testApp().app);
  const events = await eventsFor("user.signed_in");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    actorType: "user",
    actorId: SEED.users.alice,
    targetType: "user",
    targetId: SEED.users.alice,
    outcome: "success",
  });
  expect(JSON.stringify(events[0]!.detail)).not.toContain(decodeURIComponent(cookieValue(res)));
});

test("failed sign-in is audited without creating a session", async () => {
  const userId = crypto.randomUUID();
  await post(testApp().app, "/login", { userId });
  const events = await eventsFor("user.sign_in_failed");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ actorType: "user", actorId: "anonymous", targetId: userId, outcome: "failure" });
  expect(await appDb.select().from(userSessions)).toHaveLength(0);
});

test("a malformed sign-in id is audited as invalid", async () => {
  await post(testApp().app, "/login", { userId: "' or 1=1 --" });
  const events = await eventsFor("user.sign_in_failed");
  expect(events.map((e) => e.targetId)).toEqual(["invalid"]);
});

test("sign-out is audited", async () => {
  const { app } = testApp();
  const { cookie } = await login(app);
  await post(app, "/logout", {}, { cookie });
  const events = await eventsFor("user.signed_out");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ actorId: SEED.users.alice, targetId: SEED.users.alice, outcome: "success" });
});

test("sign-out without a session writes no event", async () => {
  const res = await post(testApp().app, "/logout", {}, { cookie: "sid=not-a-token" });
  expect(res.headers.get("location")).toBe("/login");
  expect(await appDb.select().from(auditEvents)).toHaveLength(0);
});

test("audit records the client IP from a trusted proxy", async () => {
  const { app } = testApp({ config: { ...config, trustProxy: true } });
  await login(app, SEED.users.alice, { "x-forwarded-for": "10.9.9.9, 203.0.113.7" });
  const [event] = await eventsFor("user.signed_in");
  expect(event!.sourceIp).toBe("203.0.113.7");
});

test("the chain stays intact across sign-in activity", async () => {
  const { app } = testApp();
  const { cookie } = await login(app);
  await post(app, "/login", { userId: crypto.randomUUID() });
  await post(app, "/logout", {}, { cookie });
  expect(await verifyChain(appDb)).toEqual({ ok: true, count: 3 });
});
