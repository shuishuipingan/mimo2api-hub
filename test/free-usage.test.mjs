import test from "node:test";
import assert from "node:assert/strict";
import { createFreeUsageProvider } from "../mimo-quota.mjs";

const jsonResponse = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => JSON.parse(JSON.stringify(body))
});
const loginRedirect = () => ({ status: 302, ok: false, headers: { get: () => "https://account.xiaomi.com/fe/service/login" }, json: async () => { throw new Error("no body"); } });

test("free usage: parses percent as remaining and fetches plan metadata", async () => {
  const provider = createFreeUsageProvider({
    cookieProvider: async () => "serviceToken=x",
    fetchImpl: async (url) => {
      if (String(url).includes("/api/user/usage")) {
        return jsonResponse({ code: 0, data: { percent: 99.3, resetDate: "2026-09-30" } });
      }
      if (String(url).includes("subscription/self")) {
        return jsonResponse({ code: 0, data: { current: { title: "MiMo 高阶", planCode: "mimo-cn-pro", planTier: 3, status: "ACTIVE", startTime: "s", endTime: "e", nextResetTime: "n" } } });
      }
      throw new Error("unexpected url " + url);
    }
  });
  const r = await provider.get({ force: true });
  assert.equal(r.state, "available");
  assert.equal(r.remainingPercent, 99.3);
  assert.equal(r.usedPercent, 0.7);
  assert.equal(r.resetDate, "2026-09-30");
  assert.equal(r.plan.title, "MiMo 高阶");
  assert.equal(r.plan.status, "ACTIVE");
});

test("free usage: subscription failure does not break usage display", async () => {
  const provider = createFreeUsageProvider({
    cookieProvider: async () => "serviceToken=x",
    fetchImpl: async (url) => {
      if (String(url).includes("/api/user/usage")) return jsonResponse({ code: 0, data: { percent: 40, resetDate: "2026-10-07" } });
      return { status: 500, ok: false, json: async () => ({}) };
    }
  });
  const r = await provider.get({ force: true });
  assert.equal(r.state, "available");
  assert.equal(r.remainingPercent, 40);
  assert.equal(r.plan, null);
});

test("free usage: login redirect and auth errors map to login_required", async () => {
  for (const responder of [
    loginRedirect,
    () => jsonResponse({ code: 0 }, 401),
    () => jsonResponse({ code: 40100, message: "auth" })
  ]) {
    const provider = createFreeUsageProvider({
      cookieProvider: async () => "serviceToken=x",
      fetchImpl: responder
    });
    const r = await provider.get({ force: true });
    assert.ok(["login_required", "unavailable"].includes(r.state), JSON.stringify(r));
  }
});

test("free usage: no cookie → login_required; null resetDate → no subscription", async () => {
  const noCookie = createFreeUsageProvider({ cookieProvider: async () => null });
  assert.equal((await noCookie.get({ force: true })).state, "login_required");

  const noSub = createFreeUsageProvider({
    cookieProvider: async () => "serviceToken=x",
    fetchImpl: async () => jsonResponse({ code: 0, data: { percent: 50, resetDate: null } })
  });
  const r = await noSub.get({ force: true });
  assert.equal(r.state, "unavailable");
  assert.match(r.reason, /no active subscription/);
});

test("free usage: caches within ttl unless forced", async () => {
  let calls = 0;
  let fakeNow = 1_000_000;
  const provider = createFreeUsageProvider({
    cookieProvider: async () => "c",
    now: () => fakeNow,
    ttlMs: 300_000,
    fetchImpl: async () => { calls++; return jsonResponse({ code: 0, data: { percent: 80, resetDate: "2026-10-01" } }); }
  });
  await provider.get({ force: true });
  await provider.get();
  await provider.get();
  assert.ok(calls <= 2, `TTL 内应命中缓存（usage+subscription 各一次 = ${calls}）`);
  fakeNow += 301_000;
  const before = calls;
  await provider.get();
  assert.equal(calls, before + 2, "TTL 过期后应重新拉取（usage + subscription）");
  const before2 = calls;
  await provider.get({ force: true });
  assert.equal(calls, before2 + 2, "force 应绕过缓存");
});
