import { expect, test } from "bun:test";
import { maskTokens } from "../src/web/http";
import { get, post, testApp } from "./helpers";

test("security headers on every response, including 404", async () => {
  for (const path of ["/login", "/does-not-exist"]) {
    const res = await get(testApp().app, path);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'self'; frame-ancestors 'none'; form-action 'self'",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  }
});

test("maskTokens hides link tokens but keeps fixed customer paths", () => {
  expect(maskTokens("/u/AbC-123_xyz")).toBe("/u/****");
  expect(maskTokens("/u/AbC-123_xyz/verify")).toBe("/u/****/verify");
  expect(maskTokens("/u/upload")).toBe("/u/upload");
  expect(maskTokens("/requests/1")).toBe("/requests/1");
});

test("request log line never contains the raw token", async () => {
  const { app, logs } = testApp();
  await get(app, "/u/SECRETTOKENVALUE");
  await Bun.sleep(5); // the log hook runs after the response is sent
  expect(logs.join("\n")).not.toContain("SECRETTOKENVALUE");
  expect(logs.some((l) => l.includes("GET /u/**** "))).toBe(true);
});

test("POST without Origin is refused", async () => {
  expect((await post(testApp().app, "/logout", {}, { origin: null })).status).toBe(403);
});

test("POST from a foreign Origin is refused", async () => {
  expect((await post(testApp().app, "/logout", {}, { origin: "https://evil.example" })).status).toBe(403);
});
