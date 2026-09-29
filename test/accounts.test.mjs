import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountPool } from "../mimo-accounts.mjs";

// 每个用例用独立的临时池目录，绝不触碰真实 accounts/pool
const TEST_UIDS = ["90020030001", "90020030002", "90020030003"];
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-pool-test-"));
const okDerive = (creds) => ({ ok: true, jar: { serviceToken: "st" }, cookie: `serviceToken=st; userId=${creds.userId}`, hops: 1 });
const okValidate = async () => ({ state: "valid" });
const mkPool = (derive, validate, nowFn = () => Date.now()) => new AccountPool({
  log: () => {}, now: nowFn, derive: derive || okDerive, validate: validate || okValidate,
  dir: fs.mkdtempSync(path.join(tmpRoot, "pool-"))
});
test.after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });

test("addAccount stores credentials, derives a session and dedupes by uid", async () => {
  const pool = mkPool();
  const acc = await pool.addAccount({ userId: TEST_UIDS[0], passToken: "tok1", nickname: "甲", source: "manual" });
  assert.equal(acc.uid, TEST_UIDS[0]);
  assert.ok(fs.existsSync(acc.path), "账号文件应落盘在池目录里");
  await pool.addAccount({ userId: TEST_UIDS[0], passToken: "tok2" });
  assert.equal(pool.count(), 1);
  assert.equal(pool.get(TEST_UIDS[0]).passToken, "tok2");
  await assert.rejects(() => pool.addAccount({ userId: "abc", passToken: "x" }), /userId 不合法/);
  await assert.rejects(() => pool.addAccount({ userId: TEST_UIDS[1], passToken: "" }), /缺少 passToken/);
});

test("pick rotates round-robin and skips disabled / cooling accounts", async () => {
  const pool = mkPool();
  for (const uid of TEST_UIDS) await pool.addAccount({ userId: uid, passToken: "t" });
  const seen = [pool.pick().uid, pool.pick().uid, pool.pick().uid];
  assert.equal(new Set(seen).size, 3);
  pool.setEnabled(TEST_UIDS[0], false);
  pool.noteError(TEST_UIDS[1], "429", 60_000);
  for (let i = 0; i < 3; i++) assert.equal(pool.pick().uid, TEST_UIDS[2]);
  assert.equal(pool.countReady(), 1);
  const other = pool.pick({ excludeUids: [TEST_UIDS[2]] });
  assert.equal(other, null);
});

test("session affinity sticks one key to one account and rebinds after exclusion", async () => {
  const pool = mkPool();
  for (const uid of TEST_UIDS) await pool.addAccount({ userId: uid, passToken: "t" });
  const first = pool.pick({ sessionKey: "client-A" });
  for (let i = 0; i < 4; i++) assert.equal(pool.pick({ sessionKey: "client-A" }).uid, first.uid);
  const rotated = pool.pick({ sessionKey: "client-A", excludeUids: [first.uid] });
  assert.notEqual(rotated.uid, first.uid);
  assert.equal(pool.pick({ sessionKey: "client-A" }).uid, rotated.uid);
});

test("ensureUsable re-derives only on definite invalid, never on unknown", async () => {
  let deriveCalls = 0;
  let state = "invalid";
  const pool = mkPool(
    async () => { deriveCalls++; return { ok: true, cookie: "fresh-" + deriveCalls, hops: 1 }; },
    async () => ({ state })
  );
  const acc = await pool.addAccount({ userId: TEST_UIDS[0], passToken: "t" });
  acc.checkedAt = 0;
  const r = await pool.ensureUsable(acc, { checkIntervalMs: 0 });
  assert.equal(r.ok, true);
  assert.ok(acc.cookie.startsWith("fresh-"));
  state = "unknown";
  acc.checkedAt = 0;
  const before = deriveCalls;
  const r2 = await pool.ensureUsable(acc, { checkIntervalMs: 0 });
  assert.equal(r2.ok, true);
  assert.equal(r2.uncertain, true);
  assert.equal(deriveCalls, before, "429/断网不能触发重派生");
});

test("passToken rejected by passport parks the account with a long cooldown", async () => {
  const pool = mkPool(
    async (creds) => creds.passToken === "dead-token"
      ? { ok: false, error: "未拿到 mimo 会话 cookie", trace: ["hop1 302[passport] +0cookie"] }
      : okDerive(creds),
    async () => ({ state: "invalid", status: 302 })
  );
  await pool.addAccount({ userId: TEST_UIDS[0], passToken: "good" });
  await pool.importDocument([{ uid: TEST_UIDS[1], passToken: "dead-token" }]);
  const acc = pool.get(TEST_UIDS[1]);
  const r = await pool.ensureUsable(acc, { checkIntervalMs: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "passToken-dead");
  assert.ok(acc.cooldownUntil - Date.now() > 5 * 3600 * 1000);
  assert.match(acc.lastError, /重新导入/);
  assert.equal(pool.pick({ excludeUids: [TEST_UIDS[0]] }), null);
});

test("export / import document round-trips the pool", async () => {
  const pool = mkPool();
  for (const [i, uid] of TEST_UIDS.entries()) await pool.addAccount({ userId: uid, passToken: "t" + i });
  const doc = pool.exportDocument();
  assert.equal(doc.format, "mimo-accounts");
  for (const uid of TEST_UIDS) pool.remove(uid);
  const r = await pool.importDocument(JSON.stringify(doc));
  assert.deepEqual(r.added.length, 3);
  assert.equal(pool.get(TEST_UIDS[2]).passToken, "t2");
  const again = await pool.importDocument(doc);
  assert.equal(again.added.length, 0);
  assert.equal(again.skipped.length, 3);
  const bad = await pool.importDocument([{ uid: "bad", passToken: "x" }]);
  assert.equal(bad.invalid.length, 1);
});

test("loginWithPassword detects the retired legacy endpoint and guides to import", async () => {
  const pool = mkPool();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/user/xiaomi/me")) {
      const h = new Headers();
      h.set("location", "https://account.xiaomi.com/pass/serviceLogin?sid=mimopc&callback=https%3A%2F%2Fsts");
      return { status: 302, headers: h };
    }
    return { status: 200, headers: { get: (k) => (k === "content-type" ? "text/html" : null) }, text: async () => "<!doctype html>登录页" };
  };
  try {
    const r = await pool.loginWithPassword("user", "pw");
    assert.equal(r.ok, false);
    assert.equal(r.kind, "endpoint-retired");
    assert.match(r.error, /桌面端导入|手动凭据导入/);
  } finally { globalThis.fetch = origFetch; }
});

test("loginWithPassword succeeds when the legacy endpoint returns JSON", async () => {
  const pool = mkPool();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes("/api/user/xiaomi/me")) {
      const h = new Headers();
      h.set("location", "https://account.xiaomi.com/pass/serviceLogin?sid=mimopc&callback=https%3A%2F%2Fsts");
      return { status: 302, headers: h };
    }
    if (String(url).includes("serviceLoginAuth2")) {
      const body = String(opts.body);
      assert.match(body, /user=user/);
      assert.match(body, new RegExp(`hash=${cryptoMd5("pw")}`));
      return { status: 200, headers: { get: (k) => (k === "content-type" ? "text/html" : null) }, text: async () => '&&&START&&&{"code":0,"location":"https://sts","nonce":"n","ssecurity":"s","userId":"' + TEST_UIDS[0] + '","passToken":"pt","cUserId":""}' };
    }
    throw new Error("unexpected url " + url);
  };
  try {
    const r = await pool.loginWithPassword("user", "pw");
    assert.equal(r.ok, true, r.error || "");
    assert.equal(r.acc.uid, TEST_UIDS[0]);
    assert.equal(r.acc.source, "password");
  } finally { globalThis.fetch = origFetch; }
});

test("public() never leaks passToken or session cookie", async () => {
  const pool = mkPool();
  const acc = await pool.addAccount({ userId: TEST_UIDS[0], passToken: "secret-token" });
  acc.cookie = "serviceToken=secret";
  const j = JSON.stringify(pool.listPublic());
  assert.ok(!j.includes("secret-token"));
  assert.ok(!j.includes("serviceToken=secret"));
});

function cryptoMd5(s) {
  return crypto.createHash("md5").update(s).digest("hex").toUpperCase();
}
