/**
 * mimo-gui.mjs — 给 mimo-api-proxy 提供 Web 看板所需的服务端能力
 *
 * 按 wb-proxy 的标准实现：
 *   - 单文件 dashboard.html 托管在 /
 *   - 面板访问密码（PBKDF2-SHA256，存 accounts/settings.json，不存明文）
 *   - API Key 多 Key 管理（增删/启停/复制）
 *   - 用量流水 usage/usage.jsonl + 聚合快照 usage/usage-summary.json
 *   - 看板用 JSON API：/api/stats /api/usage /api/settings /api/logs /api/models
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { initialPasswordState, loadJsonFile, timingSafeStringEqual, writeJsonAtomic } from "./mimo-runtime.mjs";

/**
 * ⚠️ 必须用 fileURLToPath，不能用 `new URL(import.meta.url).pathname`。
 * pathname 是 URL 编码的：本项目路径里含中文「项目damo」，
 * 用 pathname 会得到 %E9%A1%B9%E7%9B%AEdamo，于是 accounts/usage 全被写到
 * 一个影子目录里（真实数据在 Desktop\%E9%A1%B9%E7%9B%AEdamo\...），
 * 表面上功能正常，实际文件全错位。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DIRS = {
  root: HERE,
  accounts: path.join(HERE, "accounts"),
  usage: path.join(HERE, "usage")
};
const SETTINGS = path.join(DIRS.accounts, "settings.json");
const USAGE_JSONL = path.join(DIRS.usage, "usage.jsonl");
const USAGE_SUMMARY = path.join(DIRS.usage, "usage-summary.json");

for (const d of [DIRS.accounts, DIRS.usage]) fs.mkdirSync(d, { recursive: true });

/* ------------------------------------------------------------------ *
 * 设置（面板密码 + API Keys）
 * ------------------------------------------------------------------ */

const DEFAULTS = {
  panelPasswordHash: null,   // { salt, hash, iter }
  panelPasswordSet: false,
  apiKeys: [],               // [{ id, name, key, enabled, createdAt, note }]
  updatedAt: 0
};

// 设置文件很小但每个请求都要读（鉴权/Key 归属），mtime 没变就直接用缓存，
// 省掉每个 API 请求 2~3 次同步 readFileSync
let settingsCache = null;
let settingsCacheMtimeMs = -1;

const SETTINGS_BAK = SETTINGS + ".bak";

/**
 * 读取看板设置。文件损坏（实测发生过 NTFS 零填充导致代理拒启）时：
 * 先尝试从 .bak 恢复；不行就把坏文件隔离成 settings.json.corrupt-<ts>
 * 并回退默认值 —— 网关必须能起来，非回环监听仍由 validateExposurePolicy 把关。
 */
export function loadSettings() {
  let raw;
  try {
    const st = fs.statSync(SETTINGS);
    if (settingsCache && st.mtimeMs === settingsCacheMtimeMs) return settingsCache;
    raw = fs.readFileSync(SETTINGS, "utf8");
    settingsCacheMtimeMs = st.mtimeMs;
  } catch (error) {
    if (error?.code === "ENOENT") return { ...DEFAULTS };
    // stat 失败的其它情况按无设置处理并告警
    console.warn?.(`[看板] settings.json 不可读: ${String(error?.message || error)}`);
    return { ...DEFAULTS };
  }

  const parse = (text) => {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("settings must be a JSON object");
    return { ...DEFAULTS, ...value, apiKeys: Array.isArray(value.apiKeys) ? value.apiKeys : [] };
  };

  try {
    settingsCache = parse(raw);
    return settingsCache;
  } catch (error) {
    // ① 尝试 .bak
    try {
      const bak = fs.readFileSync(SETTINGS_BAK, "utf8");
      const restored = parse(bak);
      // 恢复成功：回写主文件
      writeJsonAtomic(SETTINGS, restored);
      settingsCache = restored;
      console.warn?.(`[看板] settings.json 已损坏（${String(error?.message || error).slice(0, 80)}），已从 settings.json.bak 恢复 ${restored.apiKeys?.length ?? 0} 个 Key`);
      return settingsCache;
    } catch { /* 没有 bak 或 bak 也坏 */ }
    // ② 隔离坏文件，回退默认
    try { fs.renameSync(SETTINGS, `${SETTINGS}.corrupt-${Date.now()}`); } catch {}
    settingsCache = null;
    settingsCacheMtimeMs = -1;
    console.warn?.(`[看板] settings.json 已损坏且无备份，已隔离并回退默认值（面板密码将回到 admin，请重新设置）。原因: ${String(error?.message || error).slice(0, 100)}`);
    return { ...DEFAULTS };
  }
}

function saveSettings(s) {
  // 写前快照当前有效内容到 .bak（供损坏恢复）
  try {
    const current = fs.readFileSync(SETTINGS, "utf8");
    JSON.parse(current); // 只备份有效 JSON
    const tmp = `${SETTINGS_BAK}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, current, { mode: 0o600 });
    fs.renameSync(tmp, SETTINGS_BAK);
  } catch { /* 当前文件不存在/损坏时没有可备份的 */ }
  s.updatedAt = Date.now();
  writeJsonAtomic(SETTINGS, s);
  settingsCache = null;      // 失效化，下次 loadSettings 重新读盘（拿到真实 mtime）
  settingsCacheMtimeMs = -1;
  return s;
}

export function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex"), iter = 120000) {
  const hash = crypto.pbkdf2Sync(pw, salt, iter, 32, "sha256").toString("hex");
  return { salt, hash, iter };
}

export function verifyPassword(pw, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const h = crypto.pbkdf2Sync(pw, rec.salt, rec.iter || 120000, 32, "sha256");
  const want = Buffer.from(rec.hash, "hex");
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

/** 首次启动：默认密码 admin（与 wb-proxy 一致），强制提示改 */
export function ensurePanelPassword(initial) {
  const s = loadSettings();
  if (s.panelPasswordHash) {
    // 迁移旧版本：旧逻辑把默认 admin 错标成了「已设置」。
    if (verifyPassword("admin", s.panelPasswordHash) && s.panelPasswordSet !== false) {
      s.panelPasswordSet = false;
      saveSettings(s);
    }
    return { created: false, settings: s };
  }
  const state = initialPasswordState(initial);
  s.panelPasswordHash = hashPassword(state.password);
  s.panelPasswordSet = state.panelPasswordSet;
  saveSettings(s);
  return { created: true, settings: s, defaultPassword: state.usedDefault ? "admin" : null };
}

export function setPanelPassword(pw) {
  const s = loadSettings();
  s.panelPasswordHash = hashPassword(pw);
  s.panelPasswordSet = true;
  saveSettings(s);
  return true;
}

/* ------------------------------------------------------------------ *
 * 会话（内存，重启即失效 —— 与 wb-proxy 行为一致）
 * ------------------------------------------------------------------ */

const sessions = new Map();
const SESSION_TTL = 12 * 3600 * 1000;

export function newSession() {
  const sid = crypto.randomBytes(24).toString("base64url");
  sessions.set(sid, Date.now() + SESSION_TTL);
  return sid;
}
export function checkSession(sid) {
  if (!sid) return false;
  const exp = sessions.get(sid);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(sid); return false; }
  return true;
}
export function dropSession(sid) { sessions.delete(sid); }

/* ------------------------------------------------------------------ *
 * API Key 管理
 * ------------------------------------------------------------------ */

export function genKey() {
  return "sk-mimo-" + crypto.randomBytes(24).toString("hex");
}

export function listKeys() {
  return loadSettings().apiKeys.map((k) => ({
    id: k.id, name: k.name, enabled: k.enabled !== false,
    createdAt: k.createdAt, note: k.note || "",
    masked: k.key.slice(0, 12) + "…" + k.key.slice(-4)
  }));
}

export function addKey(name, note) {
  const s = loadSettings();
  const rec = {
    id: crypto.randomUUID(),
    name: String(name || "未命名").slice(0, 60),
    key: genKey(),
    enabled: true,
    createdAt: Date.now(),
    note: String(note || "").slice(0, 200)
  };
  s.apiKeys.push(rec);
  saveSettings(s);
  return rec;
}

export function toggleKey(id, enabled) {
  const s = loadSettings();
  const k = s.apiKeys.find((x) => x.id === id);
  if (!k) return false;
  k.enabled = !!enabled;
  saveSettings(s);
  return true;
}

export function removeKey(id) {
  const s = loadSettings();
  const n = s.apiKeys.length;
  s.apiKeys = s.apiKeys.filter((x) => x.id !== id);
  saveSettings(s);
  return s.apiKeys.length < n;
}

/** 拿到明文 key（只在「显示/复制」时用） */
export function revealKey(id) {
  const k = loadSettings().apiKeys.find((x) => x.id === id);
  return k ? k.key : null;
}

/** 校验调用方给的 API Key */
export function validateApiKey(presented) {
  if (!presented) return false;
  const keys = loadSettings().apiKeys.filter((k) => k.enabled !== false);
  return keys.some((k) => timingSafeStringEqual(k.key, presented));
}

/* ------------------------------------------------------------------ *
 * 用量流水
 * ------------------------------------------------------------------ */

export function recordUsage(rec) {
  try {
    fs.appendFileSync(USAGE_JSONL, JSON.stringify(rec) + "\n");
    bumpSummary(rec);
  } catch { /* 别因为日志失败影响主流程 */ }
}

let summaryCache = null;
function bumpSummary(rec) {
  const s = summaryCache || loadSummaryFile();
  s.total = (s.total || 0) + 1;
  s.byModel = s.byModel || {};
  s.byModel[rec.model] = (s.byModel[rec.model] || 0) + 1;
  s.byKey = s.byKey || {};
  const kn = rec.keyName || "(未知)";
  s.byKey[kn] = (s.byKey[kn] || 0) + 1;
  // 按账号聚合（账号池）：优先完整 uid，老流水退回短哈希/占位
  s.byAccount = s.byAccount || {};
  const au = rec.accountUid || rec.account || "-";
  s.byAccount[au] = s.byAccount[au] || { requests: 0, ok: 0, fail: 0, tokensIn: 0, tokensOut: 0 };
  s.byAccount[au].requests++;
  s.byAccount[au].ok += rec.ok ? 1 : 0;
  s.byAccount[au].fail += rec.ok ? 0 : 1;
  s.byAccount[au].tokensIn += rec.promptTokens || 0;
  s.byAccount[au].tokensOut += rec.completionTokens || 0;
  s.ok = (s.ok || 0) + (rec.ok ? 1 : 0);
  s.fail = (s.fail || 0) + (rec.ok ? 0 : 1);
  s.tokensIn = (s.tokensIn || 0) + (rec.promptTokens || 0);
  s.tokensOut = (s.tokensOut || 0) + (rec.completionTokens || 0);
  s.latencySum = (s.latencySum || 0) + (rec.latencyMs || 0);
  s.lastAt = rec.at;
  summaryCache = s;
  try {
    const tmp = `${USAGE_SUMMARY}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, USAGE_SUMMARY);
  } catch {}
}

function loadSummaryFile() {
  try { return JSON.parse(fs.readFileSync(USAGE_SUMMARY, "utf8")); } catch { return {}; }
}

export function getSummary() {
  const s = summaryCache || loadSummaryFile();
  const total = s.total || 0;
  return {
    total,
    ok: s.ok || 0,
    fail: s.fail || 0,
    successRate: total ? +(((s.ok || 0) / total) * 100).toFixed(1) : 0,
    tokensIn: s.tokensIn || 0,
    tokensOut: s.tokensOut || 0,
    avgLatencyMs: total ? Math.round((s.latencySum || 0) / total) : 0,
    byModel: s.byModel || {},
    byKey: s.byKey || {},
    byAccount: s.byAccount || {},
    lastAt: s.lastAt || null
  };
}

/** 倒序读取日志尾部（大文件也不卡）—— 对齐 wb-proxy 的 PR#14 做法 */
export function readRecentUsage(limit = 200) {
  if (!fs.existsSync(USAGE_JSONL)) return [];
  let fd;
  try {
    const size = fs.statSync(USAGE_JSONL).size;
    const CHUNK = 256 * 1024;
    let readBytes = Math.min(size, CHUNK * 4);
    let offset = Math.max(0, size - readBytes);
    const buf = Buffer.alloc(readBytes);
    fd = fs.openSync(USAGE_JSONL, "r");
    fs.readSync(fd, buf, 0, readBytes, offset);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    // 首行可能是截断的，丢掉
    if (offset > 0) lines.shift();
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try { out.push(JSON.parse(lines[i])); } catch {}
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

export function resetUsage() {
  summaryCache = {};
  try { fs.writeFileSync(USAGE_JSONL, ""); } catch {}
  try { fs.writeFileSync(USAGE_SUMMARY, "{}"); } catch {}
  return true;
}

/* ------------------------------------------------------------------ *
 * 小米开放平台 Cookie 存档（额度查询用）
 * 用户在浏览器登录 platform.xiaomimimo.com 后把 Cookie 粘贴进看板，
 * 存这里（0600）。也可能由 SSO 自动派生后写入（见 mimo-standalone）。
 * ------------------------------------------------------------------ */

const PLATFORM_FILE = path.join(DIRS.accounts, "mimo-platform.json");

export function loadPlatformCookie() {
  try {
    const j = JSON.parse(fs.readFileSync(PLATFORM_FILE, "utf8"));
    if (j?.cookie) return j;
  } catch {}
  return null;
}

export function savePlatformCookie(cookie, source = "manual") {
  writeJsonAtomic(PLATFORM_FILE, { cookie: String(cookie), source: String(source), savedAt: Date.now() });
  return true;
}

export function clearPlatformCookie() {
  try { fs.unlinkSync(PLATFORM_FILE); } catch {}
  return true;
}

export { USAGE_JSONL, USAGE_SUMMARY, SETTINGS };
