import test from "node:test";
import assert from "node:assert/strict";
import { createCredentialScanner } from "../mimo-standalone.mjs";

test("concurrent credential scans share one asynchronous runner", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const scanner = createCredentialScanner({
    cacheMs: 1000,
    scan: async () => {
      calls++;
      await gate;
      return { ok: true, userId: "u1", passToken: "secret", source: "test" };
    }
  });
  const first = scanner.get({ force: true });
  const second = scanner.get({ force: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, await second);
});

test("credential scan does not block the event loop and status exposes no secret", async () => {
  let timerFired = false;
  const scanner = createCredentialScanner({
    scan: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, userId: "u2", passToken: "do-not-show", source: "test" }), 30))
  });
  const pending = scanner.get({ force: true });
  setTimeout(() => { timerFired = true; }, 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(timerFired, true);
  await pending;
  assert.deepEqual(scanner.status(), { cached: true, scanning: false, cachedAt: scanner.status().cachedAt, source: "test", ok: true, userId: "u2" });
  assert.equal(JSON.stringify(scanner.status()).includes("do-not-show"), false);
});

test("credential cache is reused until invalidated", async () => {
  let calls = 0;
  let now = 100;
  const scanner = createCredentialScanner({ cacheMs: 1000, now: () => now, scan: async () => ({ ok: true, source: `run-${++calls}` }) });
  assert.equal((await scanner.get()).source, "run-1");
  now = 500;
  assert.equal((await scanner.get()).source, "run-1");
  scanner.invalidate();
  assert.equal((await scanner.get()).source, "run-2");
});
