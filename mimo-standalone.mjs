/**
 * mimo-standalone.mjs — 免桌面端模式
 *
 * 让 mimo-api-proxy 完全脱离 MiMo 桌面端运行：
 *
 *   1. 从 Chromium 的 cookie 库读出小米 SSO 凭据（passToken / userId / cUserId）
 *      —— 明文存在 sqlite 的 value 列；加密列是空的，不需要 DPAPI。
 *   2. 走小米 passport 的完整 SSO 链路，换到 mimo 域的会话 cookie：
 *        GET  https://mimo-server-cn.xiaomimimo.com/api/user/xiaomi/me   → 302 passport
 *        →    跟随重定向（带 SSO cookie），passport 用 clientSign 校验
 *        →    回跳 /api/sts → 种下 mimo 会话 cookie
 *   3. 用该会话直接调云端免费通道 /api/route/chat/completions
 *      （就是桌面端走的那条免费通道）
 *
 * 会话会缓存到 accounts/mimo-session.json；SSO 凭据（passToken 等长期凭据）
 * 另存到 accounts/mimo-sso.json。这样：
 *   - 登录一次后，即使 MiMo 桌面端在运行（Chromium cookie 库被锁死）、
 *     或者代理重启，都能用本地缓存的 passToken 静默换新会话，不再依赖
 *     cookie 库 —— 真正做到「登录一次，之后不再打扰 passport」。
 *   - 会话校验用 GET /api/user/xiaomi/me（免费、不消耗 TPM），
 *     429/5xx/断网一律视为「会话仍有效」，绝不让限流触发重新登录。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parsePlatformCookieHeader, platformCookieHeaderFromRows } from "./mimo-quota.mjs";

// 同 mimo-gui.mjs：必须用 fileURLToPath —— 路径含中文时 URL.pathname 会被百分号编码，
// 会把 accounts/ 写到影子目录（Desktop\%E9%A1%B9%E7%9B%AEdamo\...）。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS = path.join(HERE, "accounts");
const SESSION_FILE = path.join(ACCOUNTS, "mimo-session.json");
const CREDS_FILE = path.join(ACCOUNTS, "mimo-sso.json");
fs.mkdirSync(ACCOUNTS, { recursive: true });

const CLOUD_BASE = "https://mimo-server-cn.xiaomimimo.com";
const USER_AGENT = "MiClaw/1.0";
const execFileP = promisify(execFile);

/* ------------------------------------------------------------------ *
 * 1. 从 Chromium cookie 库提取 SSO 凭据
 * ------------------------------------------------------------------ */

function mimoUserDataDirs() {
  const out = [];
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  out.push(path.join(appdata, "Xiaomi MiMo"));
  out.push(path.join(local, "Xiaomi MiMo"));
  out.push(path.join(home, ".config", "Xiaomi MiMo"));
  return out.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

function cookieDbPaths() {
  const out = [];
  for (const root of mimoUserDataDirs()) {
    out.push(path.join(root, "Network", "Cookies"));
    out.push(path.join(root, "Partitions", "xiaomi-account", "Network", "Cookies"));
    // 其它 partition 也扫一下
    const parts = path.join(root, "Partitions");
    try {
      for (const p of fs.readdirSync(parts)) out.push(path.join(parts, p, "Network", "Cookies"));
    } catch {}
  }
  return [...new Set(out)].filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
}

/** 用 python 的 sqlite3 只读打开（Node 无内置 sqlite），库被占用时先复制 */
async function readCookies(dbPath) {
  const suffix = crypto.randomBytes(6).toString("hex");
  const tmp = path.join(os.tmpdir(), `mimo-ck-${process.pid}-${suffix}.db`);
  let target = dbPath;
  try {
    await fs.promises.copyFile(dbPath, tmp);      // 应用在跑时库会被锁，复制一份更稳
    target = tmp;
  } catch { /* 复制失败就直接只读打开 */ }

  const py = `
import sqlite3, json, sys
out=[]
try:
    con=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro", uri=True)
    for host,name,val,created in con.execute("SELECT host_key,name,value,creation_utc FROM cookies"):
        if val: out.append({"host":host,"name":name,"value":val,"created":created})
    con.close()
except Exception as e:
    try:
        # 老库没有 creation_utc 列时退回三列查询
        con=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro", uri=True)
        for host,name,val in con.execute("SELECT host_key,name,value FROM cookies"):
            if val: out.append({"host":host,"name":name,"value":val,"created":0})
        con.close()
    except Exception:
        pass
print(json.dumps(out))
`;
  const script = path.join(os.tmpdir(), `mimo-rd-${process.pid}-${suffix}.py`);
  await fs.promises.writeFile(script, py, "utf8");
  try {
    const { stdout } = await execFileP("python", [script, target], { encoding: "utf8", timeout: 20000, windowsHide: true });
    return JSON.parse(stdout);
  } catch {
    return [];
  } finally {
    try { await fs.promises.unlink(script); } catch {}
    if (target === tmp) try { await fs.promises.unlink(tmp); } catch {}
  }
}

/**
 * 提取 SSO 凭据：{ userId, passToken, cUserId }
 *
 * ⚠️ 性能：本函数是**同步**的 —— 它要复制 Chromium cookie 库、写一个临时 .py、
 * 再 execFileSync 起一个 python 进程读 sqlite，实测单次阻塞事件循环约 110-150ms。
 * 而看板会每 8 秒打一次 /api/standalone/status（它调本函数），
 * 于是整个代理周期性卡顿，正在流式输出的 SSE 也被冻住。
 *
 * 这里加一层内存缓存：TTL 内直接返回，不再动磁盘/进程。
 * 凭据本身是长效的（passToken 有效期极长），短 TTL 完全不影响正确性；
 * 真需要强制重读时传 { force: true }。
 */
const CREDS_CACHE_MS = Number(process.env.MIMO_CREDS_CACHE_MS || 5 * 60 * 1000); // 5 分钟
export function createCredentialScanner({ scan, cacheMs = CREDS_CACHE_MS, now = Date.now } = {}) {
  let cache = null;
  let inflight = null;
  let misses = 0;
  return {
    async get({ force = false } = {}) {
      if (!force && cache && now() - cache.at < cacheMs) return cache.value;
      if (inflight) return inflight;
      misses++;
      inflight = Promise.resolve().then(scan).then((value) => {
        cache = { at: now(), value };
        return value;
      }).finally(() => { inflight = null; });
      return inflight;
    },
    invalidate() { cache = null; },
    status() {
      const value = cache?.value;
      return {
        cached: !!cache,
        scanning: !!inflight,
        cachedAt: cache?.at ?? null,
        source: value?.source ?? null,
        ok: value?.ok ?? false,
        userId: value?.userId ?? null
      };
    },
    stats() { return { cacheMs, misses, cachedAt: cache?.at ?? null, scanning: !!inflight }; }
  };
}

const credentialScanner = createCredentialScanner({ scan: extractSsoCredentialsUncached });

export async function extractSsoCredentials({ force = false } = {}) {
  return credentialScanner.get({ force });
}

export function credentialStatus() { return credentialScanner.status(); }

export async function extractPlatformCookieHeader() {
  const explicit = parsePlatformCookieHeader(process.env.MIMO_PLATFORM_COOKIE || "");
  if (explicit) return explicit;
  const groups = await Promise.all(cookieDbPaths().map((db) => readCookies(db)));
  return platformCookieHeaderFromRows(groups.flat());
}

/** 强制下次调用重新读盘（凭据轮换 / 用户手动刷新时用） */
export function invalidateCredentialsCache() {
  credentialScanner.invalidate();
}

/** 诊断用：缓存命中统计 */
export function credentialsCacheStats() {
  return credentialScanner.stats();
}

async function extractSsoCredentialsUncached() {
  const found = {};
  const groups = await Promise.all(cookieDbPaths().map((db) => readCookies(db)));
  for (const rows of groups) {
    for (const row of rows) {
      if (!/xiaomi\.com$/.test(row.host)) continue;
      if (row.name === "passToken" && row.value) found.passToken = row.value;
      if (row.name === "userId" && row.value) found.userId = row.value;
      if (row.name === "cUserId" && row.value) found.cUserId = row.value;
    }
  }
  if (found.passToken && found.userId) {
    const creds = { ok: true, ...found, source: "chromium-cookie" };
    saveCachedCredentials(creds);   // 挖到一次就永久缓存，桌面端锁库也能继续用
    return creds;
  }

  // 桌面端在跑 / cookie 库读不出来 → 用上次缓存的长效凭据（passToken 长期有效）
  const cached = loadCachedCredentials();
  if (cached) {
    return {
      ok: true,
      userId: cached.userId,
      passToken: cached.passToken,
      cUserId: cached.cUserId || "",
      source: "local-cache",
      cachedAt: cached.at
    };
  }

  // 退路：从 opencode/mimocode 的 auth.json 读（如果是普通 api key 则不可用于免费通道）
  const authPaths = [
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
    path.join(os.homedir(), ".local", "share", "mimocode", "auth.json"),
    path.join(process.env.APPDATA || "", "Xiaomi MiMo", "mimocode", "auth.json")
  ];
  for (const p of authPaths) {
    try {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      const x = j.xiaomi;
      if (x?.key && x.key !== "xiaomi-sso-session" && /^sk-/.test(x.key)) {
        return { ok: true, apiKey: x.key, baseUrl: x.metadata?.base_url || "", source: "auth.json" };
      }
    } catch {}
  }
  return { ok: false, reason: "未找到小米登录凭据（请先在 MiMo 桌面端登录一次）" };
}

/**
 * 扫描全部 Chromium cookie 库，按 userId 归组，返回每个账号的 SSO 凭据
 * （账号池「桌面端一键导入」用 —— 桌面端切换过账号时库里可能留有多份）。
 *
 * 归组规则：单库只有一个 userId 时，该库所有 passToken/cUserId 都归它；
 * 多账号并存时按 cookie 创建时间排序后顺序配对（Chromium 同一登录会话
 * 写入的 cookie 时间戳彼此接近，实测足够可靠）。
 */
export async function extractAllSsoCredentials() {
  const groups = await Promise.all(cookieDbPaths().map(async (db) => ({ db, rows: await readCookies(db) })));
  const out = new Map(); // uid -> creds
  for (const { rows } of groups) {
    const sso = rows.filter((r) => /xiaomi\.com$/.test(r.host)
      && ["userId", "passToken", "cUserId"].includes(r.name) && r.value);
    if (!sso.length) continue;
    const userIds = sso.filter((r) => r.name === "userId");
    const passTokens = sso.filter((r) => r.name === "passToken");
    const cUserIds = sso.filter((r) => r.name === "cUserId");
    if (!passTokens.length) continue;

    const pairInOrder = (tokens, ids) => {
      // 按 creation_utc 升序配对；created=0（老库）退化为文件内出现顺序
      const byCreated = (arr) => [...arr].sort((a, b) => (a.created || 0) - (b.created || 0));
      const sortedIds = byCreated(ids);
      const sortedTokens = byCreated(tokens);
      const pairs = new Map();
      if (sortedIds.length === 1) {
        pairs.set(sortedIds[0].value, sortedTokens.map((t) => t.value));
      } else {
        sortedTokens.forEach((t, i) => {
          const uid = sortedIds[Math.min(i, sortedIds.length - 1)].value;
          if (!pairs.has(uid)) pairs.set(uid, []);
          pairs.get(uid).push(t.value);
        });
      }
      return pairs;
    };

    const uidToTokens = pairInOrder(passTokens, userIds);
    const uidToC = userIds.length ? pairInOrder(cUserIds, userIds) : new Map();
    for (const [uid, tokens] of uidToTokens) {
      const passToken = tokens[0]; // 取最早创建的一条（重登录会写新行，但旧行同样可用时以稳为主）
      if (!passToken) continue;
      const prev = out.get(uid);
      if (prev?.passToken) continue;
      out.set(uid, { userId: uid, passToken, cUserId: uidToC.get(uid)?.[0] || "", source: "chromium-cookie" });
    }
  }
  return [...out.values()];
}

/** 罗列本机所有可能的凭据来源及状态（看板「凭证探测」展示用，只读不写） */
export function listCredentialSources() {
  const out = [];
  for (const [index] of cookieDbPaths().entries()) {
    out.push({ type: "chromium-cookie", location: `Xiaomi MiMo cookie store ${index + 1}`, ok: true, note: "MiMo 桌面端 cookie 库" });
  }
  const cached = loadCachedCredentials();
  out.push({
    type: "local-cache",
    location: "accounts/mimo-sso.json",
    ok: !!cached,
    userId: cached?.userId ?? null,
    at: cached?.at ?? null,
    note: cached ? "本机缓存的长效凭据（passToken）" : "尚无缓存"
  });
  const authPaths = [
    [path.join(os.homedir(), ".local", "share", "opencode", "auth.json"), "opencode auth.json"],
    [path.join(os.homedir(), ".local", "share", "mimocode", "auth.json"), "mimocode auth.json"],
    [path.join(process.env.APPDATA || "", "Xiaomi MiMo", "mimocode", "auth.json"), "MiMo 桌面端 auth.json"]
  ];
  for (const [p, label] of authPaths) {
    const exists = (() => { try { return fs.statSync(p).isFile(); } catch { return false; } })();
    out.push({ type: "auth-json", location: label, ok: exists, note: exists ? `${label}（可能是普通 API Key）` : `${label}（不存在）` });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 2. 走 SSO 链路换 mimo 会话
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cookieHeaderFor(creds) {
  const p = [`userId=${creds.userId}`, `passToken=${creds.passToken}`];
  if (creds.cUserId) p.push(`cUserId=${creds.cUserId}`);
  return p.join("; ");
}

/**
 * 跟随重定向链，收集 Set-Cookie。
 * passport 那一步会用 clientSign 校验（sha1(nonce&ssecurity) → base64 → urlencode），
 * 但实测直接跟随 302/307 也能走通，所以这里优先跟随，解析 JSON 作为兜底。
 * bouncedToLogin：passport 把我们弹回新版登录页（fe/service/login）——凭据没有被
 * 接受（假 passToken / 凭据失效），调用方必须据此判失败，否则拿到的只是个
 * 调不了 API 的假会话。
 */
async function followChain(startUrl, initialCookie, maxHops = 10) {
  const jar = {};
  const absorb = (resp) => {
    const sc = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
    for (const s of sc) {
      const m = /^([^=]+)=([^;]*)/.exec(s);
      if (m && m[2]) jar[m[1]] = m[2];
    }
    return sc.length;
  };
  const jarStr = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

  let url = startUrl;
  let hops = 0;
  let bouncedToLogin = false;
  const trace = [];

  while (url && hops < maxHops) {
    hops++;
    const isPassport = /account\.xiaomi\.com/.test(url);
    const headers = { "User-Agent": USER_AGENT, Accept: "*/*" };
    if (isPassport) headers.Cookie = initialCookie;
    else if (jarStr()) headers.Cookie = jarStr();

    let resp;
    try {
      resp = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(30000) });
    } catch (e) {
      trace.push(`hop${hops} ERR ${String(e?.message || e).slice(0, 80)}`);
      break;
    }
    const added = absorb(resp);
    let next = resp.headers.get("location");
    const ct = (resp.headers.get("content-type") || "").split(";")[0];
    trace.push(`hop${hops} ${resp.status}${isPassport ? "[passport]" : ""} +${added}cookie ${ct}`);
    if (/fe\/service\/login|serviceLoginApp/i.test(String(next))) bouncedToLogin = true;

    // passport 返回 JSON 时，用 clientSign 拼下一步
    if (isPassport && (ct.includes("json") || ct === "text/plain" || ct === "application/octet-stream")) {
      try {
        const body = await resp.text();
        const b = body.indexOf("{");
        if (b >= 0) {
          const j = JSON.parse(body.slice(b));
          if (j.code === 0 && j.location) {
            const sign = encodeURIComponent(
              crypto.createHash("sha1").update(`nonce=${j.nonce}&${j.ssecurity}`).digest("base64")
            );
            next = `${j.location}&clientSign=${sign}`;
            trace.push(`  passport code=0 → clientSign 已计算`);
          } else if (j.code && j.code !== 0) {
            trace.push(`  passport code=${j.code} ${j.desc || j.description || ""}`);
          }
        }
      } catch {}
    }
    url = next;
  }
  return { jar, jarStr: jarStr(), trace, hops, bouncedToLogin };
}

/** 用 SSO 凭据换 mimo 会话（返回 jar） */
export async function loginMimoSession(creds) {  const sso = cookieHeaderFor(creds);
  // 第 1 步：触发登录，拿到带 sign 的 callback
  let start = `${CLOUD_BASE}/api/user/xiaomi/me`;
  let first;
  try {
    first = await fetch(start, { headers: { "User-Agent": USER_AGENT }, redirect: "manual", signal: AbortSignal.timeout(30000) });
  } catch (e) {
    return { ok: false, error: "无法连接 mimo 云端: " + String(e?.message || e) };
  }
  let loc = first.headers.get("location");
  if (!loc) {
    // 没重定向：可能直接就是 sts 流程
    loc = `${CLOUD_BASE}/api/sts`;
  }
  const { jar, jarStr, trace, hops, bouncedToLogin } = await followChain(loc, sso);
  const hasSession = !bouncedToLogin && !!(jar.serviceToken || jar.passInfo || jar.mimopc_slh);
  return {
    ok: hasSession,
    jar,
    cookie: jarStr,
    trace,
    hops,
    userId: creds.userId,
    at: Date.now(),
    error: bouncedToLogin
      ? "passport 弹回登录页（passToken 未被接受）"
      : hasSession ? null : "未拿到 mimo 会话 cookie"
  };
}

const PLATFORM_ORIGIN = "https://platform.xiaomimimo.com";

/**
 * 用 SSO 凭据尝试自动派生「小米开放平台」(platform.xiaomimimo.com) 会话 Cookie。
 *
 * 链路（实测）：GET /api/v1/genLoginUrl → 302 → passport serviceLogin
 * （sid=api-platform，callback 指向平台 /sts）→ 带 SSO cookie 跟链 →
 * 平台 /sts 种下 api-platform_serviceToken 等 cookie。
 *
 * ⚠️ 实测（2026-09）：开放平台服务配置了首次交互登录 —— passToken 直通会被
 * passport 弹回 fe/service/login。用户在浏览器里登录过一次开放平台后，此直通
 * 通常即可生效；失败时返回 null，由上层降级为「看板粘贴 Cookie」。
 */
export async function derivePlatformCookieHeader(creds, { log = console.log } = {}) {
  try {
    const r1 = await fetch(`${PLATFORM_ORIGIN}/api/v1/genLoginUrl?currentPath=%2F`, {
      headers: { "User-Agent": USER_AGENT }, redirect: "manual", signal: AbortSignal.timeout(20000)
    });
    const loc = r1.headers.get("location");
    if (!loc || !/account\.xiaomi\.com/.test(loc)) return null;
    const { jar, jarStr } = await followChain(loc, cookieHeaderFor(creds));
    if (!jar["api-platform_serviceToken"]) {
      log?.("[额度] 开放平台 SSO 直通未完成（passport 弹回登录页）——需要先在浏览器登录一次开放平台");
      return null;
    }
    return jarStr;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 3. 会话缓存
 * ------------------------------------------------------------------ */

export function loadSession() {
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    if (s?.cookie && s?.at) return s;
  } catch {}
  return null;
}

export function saveSession(s) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  } catch {}
  return s;
}

export function clearSession() {
  try { fs.unlinkSync(SESSION_FILE); } catch {}
}

/* ---- 长效 SSO 凭据缓存（passToken 有效期极长，见文件头说明） ---- */

export function loadCachedCredentials() {
  try {
    const c = JSON.parse(fs.readFileSync(CREDS_FILE, "utf8"));
    if (c?.passToken && c?.userId) return c;
  } catch {}
  return null;
}

export function saveCachedCredentials(creds) {
  if (!creds?.passToken || !creds?.userId) return;
  try {
    fs.writeFileSync(CREDS_FILE, JSON.stringify({
      userId: creds.userId,
      passToken: creds.passToken,
      cUserId: creds.cUserId || "",
      source: creds.source || "chromium-cookie",
      at: Date.now()
    }, null, 2), { mode: 0o600 });
  } catch (e) {
    // 写失败只影响「下次免读 cookie 库」，不该拖垮登录主流程
    console.warn?.(`[standalone] 凭据缓存写入失败: ${String(e?.message || e)}`);
  }
}

export function clearCachedCredentials() {
  try { fs.unlinkSync(CREDS_FILE); } catch {}
}

/* ------------------------------------------------------------------ *
 * 4. 云端调用
 * ------------------------------------------------------------------ */

/** 云端免费通道认的裸模型名（对外会补上 xiaomi/ 前缀，见 mimo-api-proxy.exposedModels） */
export const STANDALONE_MODELS = [
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
  "mimo-v2.6-pro-ultraspeed"
];

/** 直接调云端免费通道 */
export async function cloudChat(session, body, { stream = false, signal } = {}) {
  const r = await fetch(`${CLOUD_BASE}/api/route/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "X-Mimo-Source": "mimocode-desktop",
      Cookie: session.cookie
    },
    body: JSON.stringify(body),
    signal
  });
  return r;
}

/** 探测会话是否还有效（发一个 1-token 请求；消耗极少量额度，仅在需要强确认时用） */
export async function probeSession(session) {
  try {
    const r = await cloudChat(session, {
      model: "mimo-x-flash-preview",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1
    }, { signal: AbortSignal.timeout(20000) });
    if (r.ok) { try { await r.json(); } catch {} return { ok: true }; }
    const txt = await r.text().catch(() => "");
    return { ok: false, status: r.status, error: txt.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * 便宜的会话校验：GET /api/user/xiaomi/me（不消耗任何模型额度）。
 * 返回 state:
 *   "valid"    —— 会话确定有效
 *   "invalid"  —— 会话确定失效（401/403），可以重登
 *   "unknown"  —— 无法判断（429 限流 / 5xx / 网络波动）。
 *                 ⚠️ 限流 ≠ 会话失效：绝不能因为 429 就重新登录，
 *                 否则限流风暴会演变成登录风暴。
 */
export async function validateSession(session) {
  try {
    const r = await fetch(`${CLOUD_BASE}/api/user/xiaomi/me`, {
      headers: { "User-Agent": USER_AGENT, Cookie: session.cookie, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000)
    });
    if (r.ok) { try { await r.json(); } catch {} return { state: "valid", status: r.status }; }
    const txt = await r.text().catch(() => "");
    // 实测：会话失效时该端点回 302 跳 passport（不是 401！）。
    // 只认「重定向到 passport 登录页」这一种 3xx，网关类的其它 3xx 仍算 unknown。
    const loc = r.headers.get("location") || "";
    const passportRedirect = r.status >= 300 && r.status < 400 && /account\.xiaomi\.com|passport|serviceLogin/i.test(loc);
    if (r.status === 401 || r.status === 403 || passportRedirect) {
      return {
        state: "invalid",
        status: r.status,
        error: passportRedirect ? `被重定向到 passport（会话已死）: ${loc.slice(0, 80)}` : txt.slice(0, 200)
      };
    }
    return { state: "unknown", status: r.status, error: txt.slice(0, 200) };
  } catch (e) {
    // 网络错误同样说明不了会话失效
    return { state: "unknown", error: String(e?.message || e) };
  }
}

/**
 * 从上游报错里解析「请约 N 秒后重试」；解析不出返回 null。
 * TPM 限流（biz_code 30014）的 message 形如：
 *   用户 每人 触发 TPM 限流（上限 5000000），请约 11 秒后重试
 */
export function parseRetrySeconds(text) {
  if (!text) return null;
  const min = /请约\s*(\d+)\s*分钟/.exec(text);
  if (min) return Number(min[1]) * 60;
  const sec = /请约\s*(\d+)\s*秒/.exec(text) || /retry\s*(?:in|after)\s*(\d+)\s*s/i.exec(text);
  if (sec) return Number(sec[1]);
  const ra = Number(text); // 也接受纯数字（Retry-After 头的值）
  return Number.isFinite(ra) && ra > 0 ? ra : null;
}

/**
 * 拿到可用会话：优先缓存，确定失效才重新登录。
 *
 * - 会话校验走免费 GET（validateSession），不烧模型额度；
 *   429 / 5xx / 断网都按「会话仍有效」处理，返回缓存会话继续用。
 * - 登录有节流：上次登录失败后 minIntervalMs 内不再打 passport，
 *   并发请求共享同一次登录（loginInflight），避免登录风暴。
 * - 失败返回带 kind，供上层决定要不要回退本地引擎：
 *     no-credentials / api-key-only —— 本机真的没有 SSO 凭据
 *     login-failed / cooldown       —— 有凭据但临时失败（网络、passport、节流）
 */
let loginInflight = null;
let lastLoginAttemptAt = 0;
let lastLoginError = null;

export async function ensureSession({ force = false, log = console.log, minIntervalMs = 30000, ignoreThrottle = false } = {}) {
  if (!force) {
    const cached = loadSession();
    if (cached) {
      const v = await validateSession(cached);
      if (v.state === "valid") return { ok: true, session: cached, reused: true, credSource: "cached-session" };
      if (v.state === "unknown") {
        log(`[standalone] 会话校验结果不确定（${v.status ?? v.error}），暂按有效继续用，不重新登录`);
        return { ok: true, session: cached, reused: true, uncertain: true, credSource: "cached-session" };
      }
      log(`[standalone] 缓存会话已确定失效（${v.status ?? v.error}），用本地凭据重新登录…`);
    }
  }

  if (loginInflight) return loginInflight;

  const sinceFail = Date.now() - lastLoginAttemptAt;
  if (!ignoreThrottle && lastLoginError && sinceFail < minIntervalMs) {
    const waitS = Math.ceil((minIntervalMs - sinceFail) / 1000);
    return {
      ok: false,
      kind: "cooldown",
      error: `${waitS}s 后才允许再次登录（上次登录失败: ${lastLoginError}）`,
      retryAfterMs: minIntervalMs - sinceFail
    };
  }

  lastLoginAttemptAt = Date.now();
  loginInflight = (async () => {
    const creds = await extractSsoCredentials();
    if (!creds.ok) {
      lastLoginError = creds.reason;
      return { ok: false, kind: "no-credentials", error: creds.reason };
    }
    if (creds.apiKey) {
      lastLoginError = "只找到普通 API Key";
      return { ok: false, kind: "api-key-only", error: "只找到普通 API Key（免费通道需要 SSO 登录态）", apiKey: creds.apiKey };
    }

    log(`[standalone] 正在登录（userId=${creds.userId}，凭据来源=${creds.source}）…`);
    const res = await loginMimoSession(creds);
    if (!res.ok) {
      lastLoginError = res.error || "未知错误";
      return { ok: false, kind: "login-failed", error: res.error, trace: res.trace };
    }
    lastLoginError = null;
    saveSession(res);
    log(`[standalone] 登录成功（${res.hops} 跳，cookie: ${Object.keys(res.jar).join(", ")}）`);
    return { ok: true, session: res, reused: false, credSource: creds.source };
  })().finally(() => { loginInflight = null; });

  return loginInflight;
}
