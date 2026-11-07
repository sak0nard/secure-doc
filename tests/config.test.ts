import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const valid = {
  DATABASE_URL: "postgres://a",
  DATABASE_OWNER_URL: "postgres://o",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "docs",
  S3_ACCESS_KEY_ID: "k",
  S3_SECRET_ACCESS_KEY: "s",
  S3_REGION: "ap-southeast-2",
  BASE_URL: "http://localhost:3000",
  OTP_PEPPER: "x".repeat(32),
};

test("defaults retention to 2555 days, proxy trust off, outbox off, port 3000", () => {
  const c = loadConfig(valid);
  expect([c.retentionDays, c.trustProxy, c.mockOutboxEnabled, c.port]).toEqual([2555, false, false, 3000]);
});

test("rejects a pepper shorter than 32 characters", () => {
  expect(() => loadConfig({ ...valid, OTP_PEPPER: "short" })).toThrow(/OTP_PEPPER/);
});

test("names every invalid variable at once", () => {
  const { DATABASE_URL, BASE_URL, ...rest } = valid;
  expect(() => loadConfig(rest)).toThrow(/DATABASE_URL[\s\S]*BASE_URL|BASE_URL[\s\S]*DATABASE_URL/);
});

test("parses booleans strictly", () => {
  expect(loadConfig({ ...valid, TRUST_PROXY: "true", MOCK_OUTBOX_ENABLED: "true" }).trustProxy).toBe(true);
  expect(() => loadConfig({ ...valid, TRUST_PROXY: "yes" })).toThrow(/TRUST_PROXY/);
});
