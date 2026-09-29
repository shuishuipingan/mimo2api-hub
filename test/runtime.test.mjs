import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadJsonFile,
  writeJsonAtomic,
  isLoopbackHost,
  timingSafeStringEqual,
  initialPasswordState,
  validateExposurePolicy
} from "../mimo-runtime.mjs";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("missing optional JSON returns the supplied first-run default", (t) => {
  const file = path.join(tempDir(t), "missing.json");
  assert.deepEqual(loadJsonFile(file, { missingValue: { first: true }, label: "settings" }), {
    found: false,
    value: { first: true }
  });
});

test("existing malformed JSON throws instead of returning an empty object", (t) => {
  const file = path.join(tempDir(t), "broken.json");
  fs.writeFileSync(file, "{bad");
  assert.throws(() => loadJsonFile(file, { missingValue: {}, label: "proxy config" }), /proxy config.*invalid JSON/i);
});

test("atomic write leaves the original file intact when serialization fails", (t) => {
  const file = path.join(tempDir(t), "config.json");
  fs.writeFileSync(file, "{\"safe\":true}\n");
  const circular = {};
  circular.self = circular;
  assert.throws(() => writeJsonAtomic(file, circular));
  assert.equal(fs.readFileSync(file, "utf8"), "{\"safe\":true}\n");
});

test("loopback accepts local hosts and rejects wildcard hosts", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("::"), false);
});

test("timing-safe string comparison rejects unequal values and lengths", () => {
  assert.equal(timingSafeStringEqual("same-value", "same-value"), true);
  assert.equal(timingSafeStringEqual("same-value", "other-value"), false);
  assert.equal(timingSafeStringEqual("short", "much-longer"), false);
});

test("default password remains marked for change", () => {
  assert.deepEqual(initialPasswordState(undefined), { password: "admin", panelPasswordSet: false, usedDefault: true });
  assert.deepEqual(initialPasswordState("chosen-secret"), { password: "chosen-secret", panelPasswordSet: true, usedDefault: false });
});

test("default dashboard password cannot bind outside loopback", () => {
  assert.throws(() => validateExposurePolicy({ host: "0.0.0.0", panelPasswordSet: false }), /default dashboard password/i);
  assert.doesNotThrow(() => validateExposurePolicy({ host: "127.0.0.1", panelPasswordSet: false }));
  assert.doesNotThrow(() => validateExposurePolicy({ host: "0.0.0.0", panelPasswordSet: true }));
});
