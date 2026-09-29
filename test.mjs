#!/usr/bin/env node
/**
 * 自检脚本：验证 mimo-api-proxy 的 OpenAI 兼容面是否真的能用。
 *   node test.mjs                       # 默认打 http://127.0.0.1:8788
 *   node test.mjs http://127.0.0.1:8788 sk-mimo-123456
 */
const BASE = (process.argv[2] || "http://127.0.0.1:8788").replace(/\/+$/, "");
const KEY = process.argv[3] || "";
const H = { "Content-Type": "application/json", ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) };
// pro 模型非流式偶尔要 1~2 分钟（上游特性），超时给足
const TIMEOUT_MS = Number(process.env.MIMO_TEST_TIMEOUT_MS || 300000);

let pass = 0, fail = 0;
const ok = (name, extra = "") => { pass++; console.log(`  PASS  ${name}${extra ? "  " + extra : ""}`); };
const no = (name, why) => { fail++; console.log(`  FAIL  ${name}  ${why}`); };
const secs = (t0) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

console.log(`\n== mimo-api-proxy 自检 @ ${BASE} ==\n`);

// 1) /v1/models
let models = [];
try {
  const r = await fetch(`${BASE}/v1/models`, { headers: H, signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  if (r.ok && Array.isArray(j.data)) { models = j.data.map((m) => m.id); ok("GET /v1/models", `HTTP ${r.status}, ${models.length} 个模型`); }
  else no("GET /v1/models", `HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
} catch (e) { no("GET /v1/models", String(e.message)); }

// 2) 当前 Flash / Pro 模型在列表里（兼容旧 Preview 目录）
const FLASH_MODEL = models.find((m) => /mimo-.*flash/i.test(m)) || "xiaomi/mimo-v2.6-flash";
const PRO_MODEL = models.find((m) => /mimo-.*pro/i.test(m)) || "xiaomi/mimo-v2.6-pro";
for (const m of [FLASH_MODEL, PRO_MODEL]) {
  models.includes(m) ? ok(`模型已暴露: ${m}`) : no(`模型已暴露: ${m}`, "不在 /v1/models 里");
}

// 2.5) 健康检查应准确报告配置模式和鉴权
try {
  const r = await fetch(`${BASE}/health`, { headers: H, signal: AbortSignal.timeout(10000) });
  const j = await r.json();
  if (typeof j.mode === "string" && "active_mode" in j && typeof j.auth_required === "boolean") {
    ok("GET /health 状态字段", `mode=${j.mode} active=${j.active_mode} auth=${j.auth_required}`);
  } else no("GET /health 状态字段", JSON.stringify(j).slice(0, 200));
} catch (e) { no("GET /health 状态字段", String(e.message)); }

// 3) 非流式 chat
async function chat(model, stream) {
  const body = {
    model,
    messages: [{ role: "user", content: "用一句话说明你是什么模型。" }],
    max_tokens: 128,
    stream
  };
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  return r;
}

try {
  const t0 = Date.now();
  const r = await chat(FLASH_MODEL, false);
  const j = await r.json();
  const text = j?.choices?.[0]?.message?.content;
  if (r.ok && text) ok("POST /v1/chat/completions (非流式)", `${secs(t0)} "${String(text).slice(0, 40)}" usage=${JSON.stringify(j.usage)}`);
  else no("POST /v1/chat/completions (非流式)", `HTTP ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
} catch (e) { no("POST /v1/chat/completions (非流式)", String(e.message)); }

// 4) 别名（用流式测，避免 pro 非流式偶发的长尾延迟掩盖别名本身的问题）
try {
  const t0 = Date.now();
  const r = await chat("mimo-pro", true);
  if (!r.ok) no(`模型别名 mimo-pro -> ${PRO_MODEL}`, `HTTP ${r.status}`);
  else {
    let frames = 0, text = "", done = false, buf = "";
    const dec = new TextDecoder();
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const p = t.slice(5).trim();
        if (p === "[DONE]") { done = true; continue; }
        try { const j = JSON.parse(p); frames++; text += j?.choices?.[0]?.delta?.content || ""; } catch {}
      }
    }
    if (frames > 0 && done) ok(`模型别名 mimo-pro -> ${PRO_MODEL}`, `首帧 ${secs(t0)}, ${frames} 帧, "${text.slice(0, 30)}"`);
    else no("模型别名 mimo-pro", `frames=${frames} done=${done}`);
  }
} catch (e) { no("模型别名 mimo-pro", String(e.message)); }

// 5) 流式
try {
  const t0 = Date.now();
  const r = await chat(FLASH_MODEL, true);
  if (!r.ok) no("POST /v1/chat/completions (流式)", `HTTP ${r.status}`);
  else {
    const contentType = r.headers.get("content-type") || "";
    contentType.toLowerCase().startsWith("text/event-stream")
      ? ok("流式响应 Content-Type", contentType)
      : no("流式响应 Content-Type", contentType || "缺失");
    let frames = 0, text = "", done = false, firstAt = null;
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of r.body) {
      if (firstAt === null) firstAt = Date.now();
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") { done = true; continue; }
        try {
          const j = JSON.parse(payload);
          frames++;
          text += j?.choices?.[0]?.delta?.content || "";
        } catch {}
      }
    }
    if (frames > 0 && done) ok("POST /v1/chat/completions (流式 SSE)", `首帧 ${secs(firstAt)} 总 ${secs(t0)}, ${frames} 帧, 文本 "${text.slice(0, 30)}", 以 [DONE] 收尾`);
    else no("POST /v1/chat/completions (流式 SSE)", `frames=${frames} done=${done}`);
  }
} catch (e) { no("POST /v1/chat/completions (流式 SSE)", String(e.message)); }

// 6) reasoning_effort 兼容性（agent 框架常自动带这个参数）
//    preview 模型不支持 → 代理必须自动丢掉并返回 200，而不是 400
try {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST", headers: H, signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model: FLASH_MODEL,
      messages: [{ role: "user", content: "13*7=?" }],
      max_tokens: 128,
      reasoning_effort: "high"
    })
  });
  const j = await r.json();
  if (r.ok) ok("preview 模型 + reasoning_effort 被自动丢弃", `${secs(t0)} HTTP 200（不再 400）`);
  else no("preview 模型 + reasoning_effort 被自动丢弃", `HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
} catch (e) { no("preview 模型 + reasoning_effort 被自动丢弃", String(e.message)); }

// 7) 支持 reasoning_effort 的模型，参数应照常透传
try {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST", headers: H, signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model: "mimo-pro",
      messages: [{ role: "user", content: "13*7=?" }],
      max_tokens: 128,
      reasoning_effort: "low"
    })
  });
  if (r.ok) ok("mimo-pro + reasoning_effort 正常透传", `${secs(t0)} HTTP 200`);
  else no("mimo-pro + reasoning_effort 正常透传", `HTTP ${r.status} ${JSON.stringify(await r.json()).slice(0, 200)}`);
} catch (e) { no("mimo-pro + reasoning_effort 正常透传", String(e.message)); }

// 8) 坏 key 应被拒
if (KEY) {
  try {
    const r = await fetch(`${BASE}/v1/models`, { headers: { Authorization: "Bearer definitely-wrong" }, signal: AbortSignal.timeout(20000) });
    r.status === 401 ? ok("错误 API Key 被拒 (401)") : no("错误 API Key 被拒", `HTTP ${r.status}`);
  } catch (e) { no("错误 API Key 被拒", String(e.message)); }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
