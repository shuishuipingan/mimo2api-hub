#!/usr/bin/env node
/**
 * 调用示例：优先用 OpenAI 官方 SDK（npm i openai），没装就退回原生 fetch。
 *
 *   node example-openai-sdk.mjs
 *   node example-openai-sdk.mjs http://127.0.0.1:8788/v1 sk-mimo-123456
 */
const BASE = (process.argv[2] || "http://127.0.0.1:8788/v1").replace(/\/+$/, "");
const KEY = process.argv[3] || "sk-mimo-123456";
const MODEL = process.env.MIMO_MODEL || "xiaomi/mimo-x-pro-preview";

console.log(`base=${BASE}  model=${MODEL}\n`);

let OpenAI = null;
try {
  ({ default: OpenAI } = await import("openai"));
} catch {
  console.log("(未安装 openai 包，退回原生 fetch)\n");
}

if (OpenAI) {
  const client = new OpenAI({ baseURL: BASE, apiKey: KEY });

  const list = await client.models.list();
  console.log("可用模型:", list.data.map((m) => m.id).join(", "), "\n");

  process.stdout.write("流式输出: ");
  const stream = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: "用三句话介绍你自己。" }],
    stream: true,
    max_tokens: 512
  });
  for await (const chunk of stream) {
    const d = chunk.choices?.[0]?.delta;
    if (d?.content) process.stdout.write(d.content);
  }
  console.log("\n");
} else {
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` };

  const models = await (await fetch(`${BASE}/models`, { headers: H })).json();
  console.log("可用模型:", models.data.map((m) => m.id).join(", "), "\n");

  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "用三句话介绍你自己。" }],
      stream: true,
      max_tokens: 512
    })
  });
  if (!r.ok) {
    console.error(`HTTP ${r.status}:`, await r.text());
    process.exit(1);
  }
  process.stdout.write("流式输出: ");
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const d = j.choices?.[0]?.delta;
        if (d?.reasoning_content) process.stderr.write(`\x1b[90m${d.reasoning_content}\x1b[0m`);
        if (d?.content) process.stdout.write(d.content);
      } catch {}
    }
  }
  console.log("\n");
}
