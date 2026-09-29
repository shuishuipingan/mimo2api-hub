import test from "node:test";
import assert from "node:assert/strict";
import { catalogFingerprint, createCapabilityProbeQueue, mergeModelSources, resolveDynamicAlias } from "../mimo-models.mjs";

const catalog = {
  models: [
    { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash", modelType: "TEXT" },
    { id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro", modelType: "TEXT" },
    { id: "mimo-v2.5-tts", name: "MiMo TTS", modelType: "TTS" }
  ]
};

test("merges catalog and live models while exposing only text models", () => {
  const result = mergeModelSources({ catalog, liveModels: ["mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.5-asr"] });
  assert.deepEqual(result.models.map((m) => m.id), ["xiaomi/mimo-v2.6-flash", "xiaomi/mimo-v2.6-pro"]);
  assert.equal(result.models.find((m) => m.id.endsWith("flash")).source, "catalog+live");
  assert.equal(resolveDynamicAlias("mimo-flash", result.models), "xiaomi/mimo-v2.6-flash");
  assert.equal(resolveDynamicAlias("mimo-pro", result.models), "xiaomi/mimo-v2.6-pro");
});

test("catalog fingerprint changes when model metadata changes", () => {
  assert.notEqual(catalogFingerprint(catalog), catalogFingerprint({ ...catalog, models: [...catalog.models, { id: "mimo-v2.6-pro-ultraspeed", modelType: "TEXT" }] }));
  assert.equal(catalogFingerprint(catalog), catalogFingerprint(JSON.parse(JSON.stringify(catalog))));
});

test("probe queue runs one model at a time and deduplicates catalog hashes", async () => {
  const calls = [];
  let busy = false;
  const queue = createCapabilityProbeQueue({
    probeModel: async (model, options) => {
      assert.equal(busy, false);
      busy = true;
      calls.push([model, options.deep]);
      await new Promise((resolve) => setTimeout(resolve, 1));
      busy = false;
      return { model, observedAt: "now", confidence: "probed" };
    },
    isBusy: () => busy,
    idleDelayMs: 0
  });
  queue.enqueue(["xiaomi/mimo-v2.6-flash", "xiaomi/mimo-v2.6-pro"], "hash-a");
  await queue.run();
  await queue.run();
  assert.deepEqual(calls, [["xiaomi/mimo-v2.6-flash", true], ["xiaomi/mimo-v2.6-pro", true]]);
  assert.equal(queue.snapshot().catalogHash, "hash-a");
});

test("probe queue waits while user traffic is busy and resumes after it clears", async () => {
  let busy = true;
  let calls = 0;
  const queue = createCapabilityProbeQueue({ probeModel: async () => { calls++; return {}; }, isBusy: () => busy, idleDelayMs: 0 });
  queue.enqueue(["xiaomi/mimo-v2.6-flash"], "hash-b");
  await queue.run();
  assert.equal(calls, 0);
  busy = false;
  await queue.run();
  assert.equal(calls, 1);
});
