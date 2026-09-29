import test from "node:test";
import assert from "node:assert/strict";
import {
  createSseMetricsTracker,
  formatChatDone,
  formatChatStart,
  shortAccountId
} from "../mimo-telemetry.mjs";

test("incremental SSE tracker handles split events and captures reasoning TTFT plus usage", () => {
  let now = 1000;
  const tracker = createSseMetricsTracker({ startedAt: 1000, now: () => now });
  const chunks = [
    Buffer.from('data: {"choices":[{"delta":{"reasoning_con'),
    Buffer.from('tent":"think"}}]}\n\n'),
    Buffer.from('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n'),
    Buffer.from('data: {"choices":[],"usage":{"prompt_tokens":100595,"completion_tokens":9589,"total_tokens":110184}}\n\n'),
    Buffer.from('data: [DONE]\n\n')
  ];
  const forwarded = [];
  now = 1250;
  for (const chunk of chunks) {
    forwarded.push(chunk);
    tracker.push(chunk);
    now += 100;
  }
  assert.equal(Buffer.concat(forwarded).equals(Buffer.concat(chunks)), true);
  assert.deepEqual(tracker.finish(28716), {
    durationMs: 27716,
    ttftMs: 250,
    promptTokens: 100595,
    completionTokens: 9589,
    totalTokens: 110184,
    tokensPerSec: 3975.47
  });
});

test("tool-call delta counts as first meaningful token and malformed events do not throw", () => {
  let now = 1200;
  const tracker = createSseMetricsTracker({ startedAt: 1000, now: () => now });
  tracker.push(Buffer.from("data: not-json\n\n"));
  now = 1400;
  tracker.push(Buffer.from('data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"run","arguments":"{}"}}]}}]}\n\n'));
  const metrics = tracker.finish(2000);
  assert.equal(metrics.ttftMs, 400);
  assert.equal(metrics.promptTokens, null);
  assert.equal(metrics.tokensPerSec, null);
});

test("formats wb-proxy style start and completion lines without secrets", () => {
  const start = formatChatStart({
    at: new Date("2026-09-22T00:07:29+08:00"), requestId: 128,
    model: "xiaomi/mimo-x-pro-preview", clientEffort: "max", upstreamEffort: "max",
    stream: true, messages: 49
  });
  assert.equal(start, "[mimo-proxy] 00:07:29 chat: #128 model=xiaomi/mimo-x-pro-preview client_effort='max' -> upstream_effort='max' stream=true msgs=49");

  const done = formatChatDone({
    at: new Date("2026-09-22T00:08:00+08:00"), requestId: 128,
    model: "xiaomi/mimo-x-pro-preview", mode: "standalone", account: "37352d92",
    status: 200, ok: true, durationMs: 31158, ttftMs: 2914,
    promptTokens: 100595, completionTokens: 9589, totalTokens: 110184,
    tokensPerSec: 350.41
  });
  assert.equal(done, "[mimo-proxy] 00:08:00 chat done: #128 model=xiaomi/mimo-x-pro-preview mode=standalone acct=37352d92 status=200 31158ms ttft=2914ms tokens=110184 (in=100595 out=9589) 350.41t/s");
  assert.equal(start.includes("sk-secret"), false);
  assert.match(formatChatDone({ at: new Date("2026-09-22T00:08:00+08:00"), requestId: 9, model: "m", mode: "engine", account: null, status: 429, ok: false, durationMs: 420, error: "rate limited" }), /chat fail:.*tokens=\?.*t\/s=\?.*error='rate limited'/);
});

test("short account id is stable and does not expose the source id", () => {
  const id = shortAccountId("xiaomi-user-123456789");
  assert.match(id, /^[0-9a-f]{8}$/);
  assert.equal(id.includes("123456789"), false);
  assert.equal(shortAccountId("xiaomi-user-123456789"), id);
  assert.equal(shortAccountId(null), "-");
});
