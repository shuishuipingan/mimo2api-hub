import test from "node:test";
import assert from "node:assert/strict";
import { parsePlatformCookieHeader } from "../mimo-quota.mjs";
import { loadPlatformCookie, savePlatformCookie, clearPlatformCookie } from "../mimo-gui.mjs";

test("parsePlatformCookieHeader extracts required names from a full browser cookie header", () => {
  const raw = "_ga=GA1.1.1; api-platform_serviceToken=abc123; userId=123456; theme=dark; api-platform_ph=p1; api-platform_slh=s1; other=x";
  const parsed = parsePlatformCookieHeader(raw);
  assert.ok(parsed);
  assert.match(parsed, /api-platform_serviceToken=abc123/);
  assert.match(parsed, /userId=123456/);
  assert.match(parsed, /api-platform_ph=p1/);
  assert.ok(!parsed.includes("_ga"), "无关 cookie 不应带入");
  assert.ok(!parsed.includes("theme="));
});

test("parsePlatformCookieHeader rejects headers without the service token or userId", () => {
  assert.equal(parsePlatformCookieHeader("api-platform_serviceToken=abc"), null, "缺 userId");
  assert.equal(parsePlatformCookieHeader("userId=1; theme=dark"), null, "缺 serviceToken");
  assert.equal(parsePlatformCookieHeader(""), null);
});

test("platform cookie store saves, reloads and clears", () => {
  clearPlatformCookie();
  assert.equal(loadPlatformCookie(), null);
  savePlatformCookie("api-platform_serviceToken=t; userId=1");
  const loaded = loadPlatformCookie();
  assert.equal(loaded.cookie, "api-platform_serviceToken=t; userId=1");
  assert.ok(loaded.savedAt > 0);
  clearPlatformCookie();
  assert.equal(loadPlatformCookie(), null);
});
