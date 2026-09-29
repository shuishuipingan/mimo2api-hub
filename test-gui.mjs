/**
 * 看板端到端自检：登录 → 概览 → Key 管理 → 模型 → 用量 → 改密码
 */
const BASE = process.argv[2] || "http://127.0.0.1:8788";
const PW = process.argv[3] || "admin";

let pass = 0, fail = 0;
const ok = (n, e = "") => { pass++; console.log(`  PASS  ${n}${e ? "  " + e : ""}`); };
const no = (n, w) => { fail++; console.log(`  FAIL  ${n}  ${w}`); };

console.log(`\n== 看板自检 @ ${BASE} ==\n`);

let cookie = "";
const H = () => ({ "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) });
async function call(p, body) {
  const r = await fetch(`${BASE}${p}`, {
    method: body === undefined ? "GET" : "POST",
    headers: H(),
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual"
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const s of sc) { const m = /^(mimo_panel=[^;]+)/.exec(s); if (m) cookie = m[1]; }
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, j };
}

// 1) 未登录应被拒
{
  const r = await call("/api/stats");
  r.status === 401 ? ok("未登录访问 /api/stats 被拒 (401)") : no("未登录被拒", `HTTP ${r.status}`);
}

{
  const r = await call("/api/quota");
  r.status === 401 ? ok("未登录访问 /api/quota 被拒 (401)") : no("未登录额度被拒", `HTTP ${r.status}`);
}

// 2) 错密码
{
  const r = await call("/api/login", { password: "wrong-password-xyz" });
  r.status === 401 ? ok("错误密码被拒 (401)") : no("错误密码被拒", `HTTP ${r.status}`);
}

// 3) 正确密码
{
  const r = await call("/api/login", { password: PW });
  r.j?.ok && cookie ? ok("登录成功", r.j.mustChangePassword ? "(标记：使用默认密码)" : "") : no("登录成功", JSON.stringify(r.j));
}

// 4) 概览
{
  const r = await call("/api/stats");
  if (r.j?.ok) ok("GET /api/stats", `上游=${r.j.upstreamReady ? r.j.upstream : "未就绪"}, 模型=${r.j.models.length}, Key=${r.j.keyCount}`);
  else no("GET /api/stats", JSON.stringify(r.j));
}

// 5) 模型列表
{
  const r = await call("/api/models");
  if (r.j?.ok) {
    const preferredModel = r.j.models.find((m) => /mimo-.*flash/i.test(m.id))?.id || r.j.models[0]?.id;
    globalThis.__preferredModel = preferredModel;
    const has = r.j.models.some((m) => /mimo-.*flash/i.test(m.id));
    ok("GET /api/models", `${r.j.models.length} 个模型${has ? "，含免费模型" : ""}`);
  } else no("GET /api/models", JSON.stringify(r.j));
}

// 5.5) 额度接口必须明确返回 available/login_required/unavailable 之一
{
  const r = await call("/api/quota");
  const state = r.j?.quota?.state;
  ["available", "login_required", "unavailable"].includes(state)
    ? ok("GET /api/quota", `state=${state}`)
    : no("GET /api/quota", JSON.stringify(r.j).slice(0, 200));
}

// 5.6) 超大看板 JSON 返回 413，不应重置连接
{
  const r = await call("/api/keys/add", { name: "x".repeat(1024 * 1024 + 100) });
  r.status === 413 ? ok("超大看板 JSON 返回 413") : no("超大看板 JSON", `HTTP ${r.status}`);
}

// 6) Key 管理
let newKeyId = null;
{
  const r = await call("/api/keys/add", { name: "自检Key" });
  if (r.j?.ok) { newKeyId = r.j.key.id; ok("生成 API Key", r.j.key.key.slice(0, 16) + "…"); }
  else no("生成 API Key", JSON.stringify(r.j));
}
{
  const r = await call("/api/keys");
  r.j?.keys?.some((k) => k.id === newKeyId) ? ok("Key 出现在列表里") : no("Key 列表", JSON.stringify(r.j).slice(0, 120));
}
{
  const r = await call("/api/keys/reveal", { id: newKeyId });
  r.j?.ok ? ok("取回明文 Key", r.j.key.slice(0, 16) + "…") : no("取回明文 Key", JSON.stringify(r.j));
}
{
  const r = await call("/api/keys/toggle", { id: newKeyId, enabled: false });
  r.j?.ok ? ok("停用 Key") : no("停用 Key", JSON.stringify(r.j));
}

// 7) 用量（先用新 Key 发一次真实请求，再看流水）
{
  const kr = await call("/api/keys/reveal", { id: newKeyId });
  const key = kr.j?.key;
  await call("/api/keys/toggle", { id: newKeyId, enabled: true });
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "mimo-flash", messages: [{ role: "user", content: "只回复：OK" }], max_tokens: 16 }),
    signal: AbortSignal.timeout(180000)
  });
  const t = await r.text();
  r.ok ? ok("用看板生成的 Key 调用模型", `HTTP ${r.status}`) : no("用看板生成的 Key 调用模型", `HTTP ${r.status} ${t.slice(0, 150)}`);

  const u = await call("/api/usage?limit=20");
  if (u.j?.ok) {
    const hit = (u.j.rows || []).find((x) => x.keyName === "自检Key");
    hit ? ok("用量流水记录了这次调用", `model=${hit.model} latency=${hit.latencyMs}ms`) : no("用量流水", "没找到自检Key 的记录");
    ok("用量汇总", `总 ${u.j.summary.total} 次, 成功率 ${u.j.summary.successRate}%`);
  } else no("GET /api/usage", JSON.stringify(u.j));
}

// 7.5) 看板「测试」按钮的后端端点
//      （回归：旧版前端直接打 /v1/chat/completions，配了 API Key 时永远 401）
{
  const r = await call("/api/test", {});
  if (r.j?.ok) ok("POST /api/test 内部测试调用", `mode=${r.j.mode} ${r.j.latencyMs}ms content="${String(r.j.content||'').slice(0,16)}"`);
  else no("POST /api/test 内部测试调用", JSON.stringify(r.j).slice(0, 200));
  // 该端点必须走服务端内部调用，不受 API Key 校验影响
  const r2 = await call("/api/test", { model: globalThis.__preferredModel || "xiaomi/mimo-v2.6-flash", prompt: "只回复：HI" });
  r2.j?.ok ? ok("POST /api/test 可指定模型", `"${String(r2.j.content||'').slice(0,16)}"`) : no("POST /api/test 可指定模型", JSON.stringify(r2.j).slice(0, 200));
}

// 8) 停用后该 Key 应失效
{
  await call("/api/keys/toggle", { id: newKeyId, enabled: false });
  const kr = await call("/api/keys/reveal", { id: newKeyId });
  const r = await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${kr.j.key}` }, signal: AbortSignal.timeout(20000) });
  r.status === 401 ? ok("停用后 Key 立即失效 (401)") : no("停用后 Key 失效", `HTTP ${r.status}`);
}

// 9) 清理
{
  const r = await call("/api/keys/remove", { id: newKeyId });
  r.j?.ok ? ok("删除 Key") : no("删除 Key", JSON.stringify(r.j));
}

// 10) 改密码 + 回改
{
  const r1 = await call("/api/password", { password: "selfcheck-pw-123" });
  const r2 = await call("/api/login", { password: "selfcheck-pw-123" });
  const r3 = await call("/api/password", { password: PW });
  (r1.j?.ok && r2.j?.ok && r3.j?.ok) ? ok("修改面板密码并改回") : no("修改面板密码", JSON.stringify([r1.j, r2.j, r3.j]));
}

// 11) 运行模式切换（写 config.json + 热生效）
{
  const orig = (await call("/api/stats")).j?.mode || "auto";
  const bad = await call("/api/mode", { mode: "bogus" });
  bad.status === 400 ? ok("非法模式被拒 (400)") : no("非法模式被拒", `HTTP ${bad.status}`);

  const target = orig === "standalone" ? "auto" : "standalone";
  const r1 = await call("/api/mode", { mode: target });
  r1.j?.ok && r1.j?.mode === target ? ok(`切换到 ${target}`, `ready=${r1.j.ready} models=${r1.j.models}`) : no(`切换到 ${target}`, JSON.stringify(r1.j));

  const r2 = await call("/api/stats");
  r2.j?.mode === target ? ok("模式已热生效", `stats.mode=${r2.j.mode}`) : no("模式热生效", `stats.mode=${r2.j?.mode}`);

  const r3 = await call("/api/mode", { mode: orig });
  r3.j?.ok && r3.j?.mode === orig ? ok(`切回 ${orig}`) : no(`切回 ${orig}`, JSON.stringify(r3.j));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
