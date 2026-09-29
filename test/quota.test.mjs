import test from "node:test";
import assert from "node:assert/strict";
import { createQuotaProvider, normalizeQuota, parsePlatformCookieHeader, platformCookieHeaderFromRows } from "../mimo-quota.mjs";

test("normalizes combined balance and monthly token-plan usage", () => {
  assert.deepEqual(normalizeQuota({
    balance: { code: 0, data: { totalBalance: "12.50", cashBalance: "8.25", giftBalance: "4.25", currency: "CNY" } },
    detail: { code: 0, data: { planName: "Pro", expireTime: "2026-10-01T00:00:00Z" } },
    usage: { code: 0, data: { month_total_token: 4100000000, month_used_token: 1000000000 } },
    fetchedAt: "2026-09-22T00:00:00.000Z"
  }), {
    state: "available",
    source: "xiaomi-open-platform",
    fetchedAt: "2026-09-22T00:00:00.000Z",
    balance: { total: 12.5, paid: 8.25, granted: 4.25, currency: "CNY" },
    tokenPlan: { name: "Pro", total: 4100000000, used: 1000000000, remaining: 3100000000, resetAt: "2026-10-01T00:00:00Z" }
  });
});

test("missing optional quota fields stay null instead of becoming zero", () => {
  const result = normalizeQuota({ balance: { data: { total_balance: "2.00" } }, detail: null, usage: null, fetchedAt: "now" });
  assert.equal(result.state, "available");
  assert.deepEqual(result.balance, { total: 2, paid: null, granted: null, currency: null });
  assert.equal(result.tokenPlan, null);
});

test("changed envelopes are unavailable rather than reporting zero remaining", () => {
  assert.deepEqual(normalizeQuota({ balance: { surprise: true }, detail: { x: 1 }, usage: { y: 2 }, fetchedAt: "now" }), {
    state: "unavailable", source: "xiaomi-open-platform", fetchedAt: "now", reason: "Xiaomi quota response contained no recognized balance or token-plan fields"
  });
});

test("platform cookie parser allowlists fields and excludes desktop passToken", () => {
  assert.equal(parsePlatformCookieHeader("api-platform_serviceToken=svc; userId=123; api-platform_ph=ph; passToken=desktop; random=x"), "api-platform_serviceToken=svc; userId=123; api-platform_ph=ph");
  assert.equal(parsePlatformCookieHeader("userId=123; passToken=desktop"), null);
});

test("platform cookie rows require the Xiaomi platform domain and never include passToken", () => {
  const header = platformCookieHeaderFromRows([
    { host: ".xiaomimimo.com", name: "api-platform_serviceToken", value: "svc" },
    { host: "platform.xiaomimimo.com", name: "userId", value: "123" },
    { host: ".xiaomi.com", name: "passToken", value: "desktop" },
    { host: ".evil.example", name: "api-platform_ph", value: "evil" },
    { host: ".xiaomimimo.com", name: "api-platform_ph", value: "good" }
  ]);
  assert.equal(header, "api-platform_serviceToken=svc; userId=123; api-platform_ph=good");
});

test("quota provider uses only fixed Xiaomi HTTPS endpoints and caches the result", async () => {
  const calls = [];
  const fixtures = {
    "/api/v1/balance": { data: { totalBalance: 3 } },
    "/api/v1/tokenPlan/detail": { data: { planName: "Lite" } },
    "/api/v1/tokenPlan/usage": { data: { month_total_token: 100, month_used_token: 25 } }
  };
  const provider = createQuotaProvider({
    now: () => 1000,
    cookieProvider: async () => "api-platform_serviceToken=svc; userId=123",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(fixtures[new URL(url).pathname]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  const first = await provider.get();
  const second = await provider.get();
  assert.equal(first.tokenPlan.remaining, 75);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, "https://platform.xiaomimimo.com");
    assert.equal(call.options.redirect, "manual");
    assert.equal(call.options.headers.Cookie.includes("passToken"), false);
  }
});

test("quota provider distinguishes login required and malformed upstream", async () => {
  const noCookie = createQuotaProvider({ cookieProvider: async () => null, fetchImpl: async () => { throw new Error("must not call"); } });
  assert.equal((await noCookie.get()).state, "login_required");

  const expired = createQuotaProvider({ cookieProvider: async () => "api-platform_serviceToken=svc; userId=123", fetchImpl: async () => new Response("", { status: 401 }) });
  assert.equal((await expired.get()).state, "login_required");

  const malformed = createQuotaProvider({ cookieProvider: async () => "api-platform_serviceToken=svc; userId=123", fetchImpl: async () => new Response("not-json", { status: 200 }) });
  assert.equal((await malformed.get()).state, "unavailable");
});
