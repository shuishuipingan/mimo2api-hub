import test from "node:test";
import assert from "node:assert/strict";
import { calculateMetrics } from "../mimo-telemetry.mjs";

test("calculates completion throughput from first token to completion", () => {
  assert.deepEqual(calculateMetrics({
    startedAt: 1000,
    firstTokenAt: 2000,
    finishedAt: 6000,
    promptTokens: 100,
    completionTokens: 200
  }), {
    durationMs: 5000,
    ttftMs: 1000,
    tokensPerSec: 60
  });
});
