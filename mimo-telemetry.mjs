import crypto from "node:crypto";

export function calculateMetrics({
  startedAt,
  firstTokenAt = null,
  finishedAt,
  promptTokens = null,
  completionTokens = null
}) {
  const durationMs = Math.max(0, finishedAt - startedAt);
  const ttftMs = firstTokenAt == null ? null : Math.max(0, firstTokenAt - startedAt);
  const totalTokens = Number.isFinite(promptTokens) && Number.isFinite(completionTokens)
    ? promptTokens + completionTokens
    : completionTokens;
  const tokensPerSec = Number.isFinite(totalTokens) && totalTokens >= 0 && durationMs > 0
    ? +(totalTokens * 1000 / durationMs).toFixed(2)
    : null;
  return { durationMs, ttftMs, tokensPerSec };
}

function meaningfulDelta(delta) {
  if (!delta || typeof delta !== "object") return false;
  if (typeof delta.content === "string" && delta.content.length > 0) return true;
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
  if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) return true;
  if (Array.isArray(delta.tool_calls)) {
    return delta.tool_calls.some((call) => {
      const fn = call?.function;
      return (typeof fn?.name === "string" && fn.name.length > 0)
        || (typeof fn?.arguments === "string" && fn.arguments.length > 0);
    });
  }
  return false;
}

export function createSseMetricsTracker({ startedAt = Date.now(), now = Date.now } = {}) {
  const decoder = new TextDecoder();
  let tail = "";
  let tailStartedAt = null;
  let firstTokenAt = null;
  let promptTokens = null;
  let completionTokens = null;
  let totalTokens = null;

  const consume = (event, receivedAt) => {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;
    let parsed;
    try { parsed = JSON.parse(data); } catch { return; }
    if (firstTokenAt == null && parsed.choices?.some((choice) => meaningfulDelta(choice?.delta))) {
      firstTokenAt = receivedAt;
    }
    if (parsed.usage && typeof parsed.usage === "object") {
      if (Number.isFinite(parsed.usage.prompt_tokens)) promptTokens = parsed.usage.prompt_tokens;
      if (Number.isFinite(parsed.usage.completion_tokens)) completionTokens = parsed.usage.completion_tokens;
      if (Number.isFinite(parsed.usage.total_tokens)) totalTokens = parsed.usage.total_tokens;
    }
  };

  return {
    push(chunk) {
      const receivedAt = now();
      if (!tail) tailStartedAt = receivedAt;
      tail += decoder.decode(chunk, { stream: true });
      const events = tail.split(/\r?\n\r?\n/);
      tail = events.pop() ?? "";
      for (let i = 0; i < events.length; i++) {
        consume(events[i], i === 0 ? (tailStartedAt ?? receivedAt) : receivedAt);
      }
      tailStartedAt = tail ? receivedAt : null;
    },
    finish(finishedAt = now()) {
      tail += decoder.decode();
      if (tail.trim()) consume(tail, tailStartedAt ?? finishedAt);
      const base = calculateMetrics({ startedAt, firstTokenAt, finishedAt, promptTokens, completionTokens });
      return {
        durationMs: base.durationMs,
        ttftMs: base.ttftMs,
        promptTokens,
        completionTokens,
        totalTokens: totalTokens ?? (Number.isFinite(promptTokens) && Number.isFinite(completionTokens) ? promptTokens + completionTokens : null),
        tokensPerSec: base.tokensPerSec
      };
    }
  };
}

export function shortAccountId(userId) {
  if (userId === undefined || userId === null || userId === "") return "-";
  return crypto.createHash("sha256").update(String(userId)).digest("hex").slice(0, 8);
}

function clock(at) {
  const d = at instanceof Date ? at : new Date(at ?? Date.now());
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function shown(value) {
  return value === undefined || value === null ? "?" : String(value);
}

function safeQuoted(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").replace(/'/g, "’").slice(0, 180);
}

export function formatChatStart(record) {
  return `[mimo-proxy] ${clock(record.at)} chat: #${record.requestId} model=${record.model} client_effort='${shown(record.clientEffort)}' -> upstream_effort='${shown(record.upstreamEffort)}' stream=${!!record.stream} msgs=${record.messages ?? 0}`;
}

export function formatChatDone(record) {
  const label = record.ok ? "done" : "fail";
  const total = record.totalTokens ?? (Number.isFinite(record.promptTokens) && Number.isFinite(record.completionTokens)
    ? record.promptTokens + record.completionTokens : null);
  const speed = Number.isFinite(record.tokensPerSec) ? `${record.tokensPerSec.toFixed(2)}t/s` : "t/s=?";
  const error = record.ok || !record.error ? "" : ` error='${safeQuoted(record.error)}'`;
  return `[mimo-proxy] ${clock(record.at)} chat ${label}: #${record.requestId} model=${record.model} mode=${record.mode || "?"} acct=${record.account || "-"} status=${record.status ?? 0} ${shown(record.durationMs)}ms ttft=${record.ttftMs == null ? "?" : `${record.ttftMs}ms`} tokens=${shown(total)} (in=${shown(record.promptTokens)} out=${shown(record.completionTokens)}) ${speed}${error}`;
}
