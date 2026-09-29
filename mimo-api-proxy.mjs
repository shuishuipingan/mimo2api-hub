#!/usr/bin/env node
/**
 * mimo-api-proxy
 * ------------------------------------------------------------------
 * 把「Xiaomi MiMo 桌面版」内置引擎里免费的 MiMo 文本模型
 * （xiaomi/mimo-x-flash-preview、xiaomi/mimo-x-pro-preview）反代成
 * 一个标准 OpenAI 兼容 API，任何 OpenAI SDK / Cherry Studio / NextChat /
 * LobeChat / Cursor / Cline / Dify 都能直接填 base_url 调用。
 *
 * 原理（逆向结论，见 README.md）：
 *   Xiaomi MiMo.exe (Electron) 启动时会拉起内置 mimocode 引擎，
 *   引擎在回环地址上开一个 HTTP 端口（本项目实测 127.0.0.1:4096），
 *   并提供官方 "Capability API"：
 *       GET  /v1/models
 *       POST /v1/chat/completions      (stream / 非 stream 都支持)
 *   鉴权用 `Authorization: Bearer <llmk_ token>`，token 的 SHA-256 存在
 *       %APPDATA%\Xiaomi MiMo\mimocode\llm-server\<sha1(dir)>\tokens.json
 *   本代理自己 mint 一个 llmk_ token 写进去（等价于 `mimo llm-server issue`），
 *   然后对公网/局域网暴露一个带自有 API Key 校验的 OpenAI 兼容端点。
 *
 * 零依赖，只需要 Node >= 22（推荐 Node 24 LTS）。
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import net from "node:net";
import * as GUI from "./mimo-gui.mjs";
import * as STANDALONE from "./mimo-standalone.mjs";
import * as ACCOUNTS from "./mimo-accounts.mjs";
import { HttpInputError, buildFailureDump, createIdleAbortController, loadJsonFile, readBodyLimited, sanitizeDiagnosticText, timingSafeStringEqual, validateExposurePolicy, writeJsonAtomic } from "./mimo-runtime.mjs";
import { calculateMetrics, createSseMetricsTracker, formatChatDone, formatChatStart, shortAccountId } from "./mimo-telemetry.mjs";
import { createQuotaProvider, createFreeUsageProvider, parsePlatformCookieHeader } from "./mimo-quota.mjs";
import * as MODELING from "./mimo-models.mjs";

const execFileP = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

const DEFAULTS = {
  /** 代理监听地址。0.0.0.0 = 局域网可访问 */
  listenHost: "127.0.0.1",
  /** 代理监听端口 */
  listenPort: 8788,
  /** 访问代理需要的 API Key 列表；留空 = 不校验（仅本机使用时可以留空） */
  apiKeys: [],
  /** 上游不给 key 时，自动 mint 的 token 作用域；[] = 引擎支持的全部模型 */
  modelScope: [],
  /** 对外暴露的模型白名单；[] = 全部暴露 */
  exposeModels: [],
  /** 找不到在跑的引擎时，自动启动 MiMo 桌面版 */
  autoStart: true,
  /** MiMo 桌面版 exe 路径，留空则自动探测 */
  appPath: "",
  /** 强制指定上游引擎地址，例如 "http://127.0.0.1:4096"；留空 = 自动发现 */
  engineBase: "",
  /** 引擎启动后等待就绪的最长秒数 */
  startTimeoutSec: 120,
  /** 启动后后台预热（pro 模型空闲后首个请求可能要 2~3 分钟） */
  warmup: true,
  /** 要预热的模型；留空 = 两个免费文本模型 */
  warmupModels: [],
  /** 已确认可用的上游多久重新验证一次（毫秒） */
  upstreamCheckMs: 20000,
  /** 请求日志 */
  logRequests: true,
  /** wb-proxy 风格的请求开始、HTTP 状态、TTFT 与 token 速度日志 */
  requestMetrics: true,
  /** 监听桌面模型目录并自动探测新增/变更模型能力 */
  autoDeepProbe: true,
  /** 模型目录轮询间隔（毫秒） */
  modelCatalogPollMs: 30000,
  /** 单次深度探测允许消耗的最大输入 token 预算 */
  deepProbeTokenBudget: 200000,
  /** 同一目录哈希再次深测的最小间隔（小时） */
  deepProbeCooldownHours: 24,
  /**
   * 运行模式：
   *   "auto"       —— 优先免桌面端（直连云端免费通道），失败再回退到本地引擎
   *   "standalone" —— 只用免桌面端模式
   *   "engine"     —— 只用本地引擎（即原来必须开桌面端的模式）
   */
  mode: "auto",
  /** 免桌面端：会话失效时自动重新登录 */
  standaloneAutoLogin: true,
  /** 免桌面端登录失败后的节流秒数：期间不再打 passport，防止登录风暴 */
  loginCooldownSec: 30,
  /** 云端 429 限流时最多替客户端等多久（毫秒）；超过就直接回 429 + Retry-After */
  rateLimitHoldMs: 45000,
  /** 云端限流冷却上限（秒）：上游让等再久也最多等这么久 */
  rateLimitMaxWaitSec: 120,
  /** 同类上游错误落盘 failed-requests/ 的去重间隔（秒），防止 429 风暴刷爆磁盘 */
  dumpDedupSec: 60,
  /** 上游报错时把完整请求落到 failed-requests/ 便于定位 */
  dumpFailedRequests: true,
  /** 显式保存完整对话正文；默认关闭以免 system prompt/用户内容落盘 */
  dumpFailedRequestBodies: false,
  /** failed-requests/ 最多保留几个文件（防无限增长） */
  dumpKeepMax: 40,
  /** failed-requests/ 最多占多少字节（防无限增长） */
  dumpKeepBytes: 20 * 1024 * 1024,
  /** 看板登录：连续失败多少次后开始退避锁定 */
  loginMaxFails: 5,
  /** 看板登录：首次锁定时长（毫秒），之后指数增长 */
  loginLockBaseMs: 5000,
  /** 看板登录：锁定时长上限（毫秒） */
  loginLockMaxMs: 15 * 60 * 1000,
  /** 模型被上游判定「不在可用列表」后的冷却时长（毫秒），到期自动重试 */
  unavailableModelTtlMs: 6 * 3600 * 1000,
  /** 账号池保活周期（小时）：定期校验全部账号会话，失效的静默重派生；0 = 关闭 */
  poolKeepaliveHours: 12,
  /** 云端 429 时是否自动轮换到下一个就绪账号（账号池 ≥2 个账号时才有意义） */
  poolRotateOn429: true,
  /** 把不支持 reasoning_effort 的模型上的该参数自动丢掉（默认开） */
  stripUnsupportedReasoningEffort: true,
  /** 额外声明哪些模型不支持 reasoning_effort；支持 `*` 通配前缀 */
  noReasoningEffort: ["xiaomi/mimo-x-flash-preview", "xiaomi/mimo-x-pro-preview"],
  /** 把超限的 max_tokens / max_completion_tokens 夹到上游上限（默认开） */
  clampMaxTokens: true,
  /** 全局最大输出 token；上游硬上限实测为 131072 */
  maxOutputTokens: 131072,
  /** 按模型覆盖，例如 { "xiaomi/mimo-x-pro-preview": 65536 } */
  modelMaxOutputTokens: {},
  /**
   * 服务端 keep-alive 空闲窗口（毫秒）。
   * Node 默认 5000 —— 空闲 5 秒服务端就单向断开，客户端连接池不知情，
   * 下次复用即 ECONNRESET，只能重连重发（「每次都要重连几次」的根因）。
   */
  keepAliveMs: 120000,
  /** OpenAI 请求体上限（字节） */
  maxRequestBodyBytes: 16 * 1024 * 1024,
  /** 单个请求的总时长上限（毫秒）；0 = 显式不限制 */
  requestTimeoutMs: 15 * 60 * 1000,
  /** 上游连续无任何响应数据的超时（毫秒）；0 = 显式不限制 */
  upstreamIdleTimeoutMs: 3 * 60 * 1000,
  /** 模型别名：让客户端可以写短名字 */
  aliases: {
    "mimo-flash": "xiaomi/mimo-x-flash-preview",
    "mimo-pro": "xiaomi/mimo-x-pro-preview",
    "mimo-auto": "xiaomi/mimo-auto",
    "mimo-x-flash-preview": "xiaomi/mimo-x-flash-preview",
    "mimo-x-pro-preview": "xiaomi/mimo-x-pro-preview",
    "flash": "xiaomi/mimo-x-flash-preview",
    "pro": "xiaomi/mimo-x-pro-preview"
  }
};

function loadConfig() {
  const cfgPath = process.env.MIMO_PROXY_CONFIG || path.join(HERE, "config.json");
  const loaded = loadJsonFile(cfgPath, { missingValue: {}, label: "proxy config" });
  const fileCfg = loaded.value;
  if (!fileCfg || typeof fileCfg !== "object" || Array.isArray(fileCfg)) {
    throw new Error("proxy config must be a JSON object");
  }
  const cfg = { ...DEFAULTS, ...fileCfg, aliases: { ...DEFAULTS.aliases, ...(fileCfg.aliases || {}) } };

  // 环境变量覆盖（给 Docker / 脚本用）
  const env = process.env;
  if (env.MIMO_PROXY_HOST) cfg.listenHost = env.MIMO_PROXY_HOST;
  if (env.MIMO_PROXY_PORT) cfg.listenPort = Number(env.MIMO_PROXY_PORT);
  if (env.MIMO_PROXY_KEYS) cfg.apiKeys = env.MIMO_PROXY_KEYS.split(",").map((s) => s.trim()).filter(Boolean);
  if (env.MIMO_PROXY_ENGINE) cfg.engineBase = env.MIMO_PROXY_ENGINE;
  if (env.MIMO_APP_PATH) cfg.appPath = env.MIMO_APP_PATH;
  // argv: --port 8788 --host 0.0.0.0 --key sk-xxx --engine http://127.0.0.1:4096
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") cfg.listenPort = Number(argv[++i]);
    else if (a === "--host") cfg.listenHost = argv[++i];
    else if (a === "--key") cfg.apiKeys = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    // ⚠️ `--engine` 历史上被写了两次（先当「指定引擎地址」，后当「切 engine 模式」），
    // 第二分支永远覆盖第一分支 —— 于是 `--engine http://127.0.0.1:4096` 会
    // 把地址吃掉、mode 还留在 auto，且地址根本没生效（死代码）。
    // 文档（GUI使用说明.md）把 `--engine` 定义为**模式开关**，所以保留该含义；
    // 若后面跟的是一个 http 地址，则按「指定引擎地址」处理，两种用法都能工作。
    else if (a === "--engine") {
      const next = argv[i + 1];
      if (next && /^https?:\/\//i.test(next)) { cfg.engineBase = argv[++i]; }
      else cfg.mode = "engine";
    }
    else if (a === "--app") cfg.appPath = argv[++i];
    else if (a === "--no-autostart") cfg.autoStart = false;
    else if (a === "--no-warmup") cfg.warmup = false;
    else if (a === "--panel-password") cfg.panelPassword = argv[++i];
    else if (a === "--mode") cfg.mode = argv[++i];
    else if (a === "--standalone") cfg.mode = "standalone";
  }
  return cfg;
}

const CFG = loadConfig();
const STATE_FILE = path.join(HERE, ".proxy-state.json");
const STARTED_AT = Date.now();
/**
 * 开放平台 Cookie 的取用顺序：
 *   1. MIMO_PLATFORM_COOKIE 环境变量 / 桌面端 Chromium 里的现成 cookie
 *   2. 看板「登录开放平台」粘贴后存档的 Cookie（accounts/mimo-platform.json）
 *   3. 账号池 passToken 自动派生（SSO 直通；开放平台要求过一次交互登录，
 *      所以通常第 2 步先落地，之后这里可能自动成功）
 * 派生尝试有 10 分钟冷却，避免每次额度刷新都去撞 passport。
 */
const PLATFORM_DERIVE_COOLDOWN_MS = 10 * 60 * 1000;
let lastPlatformDeriveAt = 0;
let lastPlatformCookieSource = null;
let lastPlatformDeriveError = null;

async function platformCookieProvider() {
  const auto = await STANDALONE.extractPlatformCookieHeader();
  if (auto) { lastPlatformCookieSource = "desktop-cookie"; return auto; }
  const saved = GUI.loadPlatformCookie();
  if (saved?.cookie) { lastPlatformCookieSource = saved.source || "manual"; return saved.cookie; }
  if (Date.now() - lastPlatformDeriveAt < PLATFORM_DERIVE_COOLDOWN_MS) return null;
  lastPlatformDeriveAt = Date.now();
  const pool = ACCOUNTS.getPool({ log });
  const acc = pool.list().find((a) => a.enabled && a.passToken);
  if (!acc) return null;
  const cookie = await STANDALONE.derivePlatformCookieHeader(
    { userId: acc.uid, passToken: acc.passToken, cUserId: acc.cUserId }, { log }
  );
  if (!cookie) {
    lastPlatformCookieSource = null;
    lastPlatformDeriveError = "SSO 直通未完成（开放平台要求先在浏览器登录一次）";
    log("[额度] 开放平台自动登录未成功；可在看板「账户额度状态」里粘贴 Cookie");
    return null;
  }
  GUI.savePlatformCookie(cookie, "sso-derive");
  lastPlatformCookieSource = "sso-derive";
  lastPlatformDeriveError = null;
  log("[额度] 开放平台会话已通过账号池 SSO 自动派生");
  return cookie;
}

const QUOTA = createQuotaProvider({ cookieProvider: platformCookieProvider });

/** 免费通道（桌面端同款）用量：跟随当前服务的账号会话查询剩余百分比/重置日期/套餐 */
const FREE_USAGE = createFreeUsageProvider({
  cookieProvider: async () => {
    if (STANDALONE_UP?.session?.cookie) return STANDALONE_UP.session.cookie;
    const pool = ACCOUNTS.getPool({ log });
    const acc = pool.list().find((a) => a.enabled && a.cookie);
    return acc?.cookie ?? null;
  }
});
const DESKTOP_CATALOG_FILE = path.join(process.env.APPDATA || os.homedir(), "Xiaomi MiMo", "model-catalog.json");
let DESKTOP_CATALOG = MODELING.loadDesktopCatalog(DESKTOP_CATALOG_FILE);
let DYNAMIC_MODEL_RECORDS = MODELING.mergeModelSources({ catalog: DESKTOP_CATALOG.catalog, liveModels: [] }).models;
let DYNAMIC_CATALOG_HASH = DESKTOP_CATALOG.fingerprint;

function refreshDynamicModelCatalog(liveModels = []) {
  const next = MODELING.loadDesktopCatalog(DESKTOP_CATALOG_FILE);
  const merged = MODELING.mergeModelSources({ catalog: next.catalog, liveModels });
  const changed = next.fingerprint !== DYNAMIC_CATALOG_HASH;
  DESKTOP_CATALOG = next;
  DYNAMIC_CATALOG_HASH = next.fingerprint;
  DYNAMIC_MODEL_RECORDS = merged.models;
  if (STANDALONE_UP && merged.models.length) STANDALONE_UP.models = dynamicModelIds();
  if (changed) log(`[模型目录] 检测到 MiMo Desktop 模型目录更新（${DYNAMIC_CATALOG_HASH}），${DYNAMIC_MODEL_RECORDS.length} 个文本模型待探测`);
  if (changed) setTimeout(() => scheduleModelCapabilityProbe(), 1000).unref?.();
  return { changed, ...merged };
}

function dynamicModelIds() { return DYNAMIC_MODEL_RECORDS.map((item) => item.id); }

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */

const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);
const warn = (...a) => console.warn(`[${new Date().toLocaleTimeString()}] !`, ...a);

/* ------------------------------------------------------------------ *
 * 引擎发现：读 llm-server 下每个 bucket 的 server-PID-PORT.json 公告文件
 * ------------------------------------------------------------------ */

function candidateStateRoots() {
  const roots = [];
  const push = (p) => p && !roots.includes(p) && roots.push(p);
  if (CFG.stateRoot) push(CFG.stateRoot);
  if (process.env.MIMOCODE_HOME) push(path.join(process.env.MIMOCODE_HOME, "llm-server"));
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  // MiMo 桌面版：%APPDATA%\Xiaomi MiMo\mimocode\llm-server
  push(path.join(appdata, "Xiaomi MiMo", "mimocode", "llm-server"));
  push(path.join(local, "Xiaomi MiMo", "mimocode", "llm-server"));
  // MiMoCode CLI / 引擎默认 state 目录
  push(path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), "mimocode", "llm-server"));
  push(path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "mimocode", "llm-server"));
  push(path.join(appdata, "mimocode", "llm-server"));
  push(path.join(local, "mimocode", "llm-server"));
  return roots.filter((r) => {
    try { return fs.statSync(r).isDirectory(); } catch { return false; }
  });
}

function pidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 扫描所有活的引擎实例，按启动时间从新到旧 */
function discoverEngines() {
  const out = [];
  for (const root of candidateStateRoots()) {
    let buckets = [];
    try { buckets = fs.readdirSync(root); } catch { continue; }
    for (const bucket of buckets) {
      const dir = path.join(root, bucket);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!n.startsWith("server-") || !n.endsWith(".json")) continue;
        try {
          const addr = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
          if (typeof addr.port !== "number" || !addr.hostname) continue;
          if (!pidAlive(addr.pid)) continue;
          out.push({
            url: `http://${addr.hostname}:${addr.port}`,
            hostname: addr.hostname,
            port: addr.port,
            pid: addr.pid,
            started: Number(addr.started) || 0,
            bucketDir: dir,
            bucket,
            stateRoot: root,
            addrFile: path.join(dir, n)
          });
        } catch { /* 忽略坏文件 */ }
      }
    }
  }
  return out.sort((a, b) => b.started - a.started);
}

/** 所有已知 state root 下的 bucket 目录（每个 bucket 对应一个「实例目录」） */
function allBucketDirs() {
  const out = [];
  for (const root of candidateStateRoots()) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) if (e.isDirectory()) out.push(path.join(root, e.name));
  }
  return out;
}

/**
 * 引擎有时**不写** server-<pid>-<port>.json 公告文件（实测：桌面版内嵌引擎
 * 走动态端口时就没有公告），这时退化为：找出 MiMo 进程监听的回环端口，逐个探测。
 */
async function appPids() {
  const pids = new Set();
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileP("tasklist", ["/FO", "CSV", "/NH"], {
        maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 15000
      });
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /mimo/i.test(m[1])) pids.add(Number(m[2]));
      }
    } catch { /* ignore */ }
  } else {
    try {
      const { stdout } = await execFileP("ps", ["-axo", "pid=,comm="], { maxBuffer: 16 * 1024 * 1024, timeout: 15000 });
      for (const line of stdout.split("\n")) {
        const m = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (m && /mimo/i.test(m[2])) pids.add(Number(m[1]));
      }
    } catch { /* ignore */ }
  }
  return pids;
}

async function listeningPortsForPids(pids) {
  const ports = new Set();
  if (!pids.size) return [];
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileP("netstat", ["-ano", "-p", "TCP"], {
        maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 20000
      });
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line.trim());
        if (!m) continue;
        const host = m[1], port = Number(m[2]), pid = Number(m[3]);
        if (!pids.has(pid)) continue;
        if (!["127.0.0.1", "0.0.0.0", "[::1]", "[::]"].includes(host)) continue;
        if (port > 0) ports.add(port);
      }
    } catch { /* ignore */ }
  }
  return [...ports];
}

/** 端口上真的有人在听吗（比 fetch 更轻，用来判死公告文件） */
function isPortOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

/**
 * 汇总所有可能的上游候选。
 *
 * 两级发现：公告文件（更准，带 bucket） + 进程端口扫描（兜底）。
 *
 * ⚠️ 公告文件必须验活，否则会踩 PID 复用：
 * 重启后 Windows 把 pid 7412 分给了 RuntimeBroker，于是 `process.kill(pid,0)`
 * 成功、公告文件看起来「活着」，代理就死等一个没人听的 4096 端口，
 * 而因为 candidates 非空，startApp() 永远不会被调用 —— 表现就是「突然启动不起来」。
 * 所以公告文件要同时满足：pid 属于 MiMo 进程，或者那个端口真的开着。
 */
async function candidateUpstreams() {
  const seen = new Set();
  const out = [];
  const pids = await appPids();

  for (const e of discoverEngines()) {
    const pidIsMimo = pids.has(e.pid);
    if (!pidIsMimo) {
      const open = await isPortOpen(e.hostname || "127.0.0.1", e.port);
      if (!open) {
        const key = e.addrFile || `${e.pid}:${e.port}`;
        if (!staleNoticed.has(key)) {
          staleNoticed.add(key);
          warn(`忽略失效公告文件 ${path.basename(key)}: pid ${e.pid} 已不是 MiMo 进程（PID 复用），且端口 ${e.port} 无人监听`);
        }
        continue;
      }
    }
    const url = e.url.replace(/\/+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, bucketDir: e.bucketDir, source: "address-file", pid: e.pid, addrFile: e.addrFile });
  }

  const ports = await listeningPortsForPids(pids);
  for (const port of ports) {
    const url = `http://127.0.0.1:${port}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, bucketDir: null, source: "port-scan", pid: null });
  }
  return out;
}

/** 只提示一次，避免刷屏 */
const staleNoticed = new Set();
const reasoningWarned = new Set();

/* ------------------------------------------------------------------ *
 * 云端限流（TPM 429）全局冷却
 *
 * 上游回了带「请约 N 秒后重试」的 429 后，把后续请求按住到冷却结束：
 *   - 剩余等待 ≤ rateLimitHoldMs 的请求替客户端等（对客户端透明）；
 *   - 等待太久的直接回 429 + Retry-After，让客户端自己安排重试。
 * ⚠️ 绝不因为 429 重新登录 —— 限流不是会话失效。
 * ------------------------------------------------------------------ */

const CLOUD_LIMIT = { until: 0, reason: "", notifiedAt: 0, waiters: 0 };

function armCloudCooldown(sec, reason) {
  const wait = Math.max(1, Math.min(CFG.rateLimitMaxWaitSec ?? 120, Number(sec) || 1));
  const until = Date.now() + (wait + 2) * 1000; // +2s 余量
  if (until > CLOUD_LIMIT.until) {
    CLOUD_LIMIT.until = until;
    CLOUD_LIMIT.reason = String(reason || "TPM 429").slice(0, 160);
    if (Date.now() - CLOUD_LIMIT.notifiedAt > 5000) {
      CLOUD_LIMIT.notifiedAt = Date.now();
      warn(`云端限流（TPM），全局冷却到 ${new Date(CLOUD_LIMIT.until).toLocaleTimeString()}（${wait + 2}s）。期间请求自动等待，不会重新登录。来源: ${CLOUD_LIMIT.reason}`);
    }
  }
  return wait + 2;
}

function cloudCooldownRemainingMs() {
  return Math.max(0, CLOUD_LIMIT.until - Date.now());
}

/** 可中断的 sleep：客户端断开就立刻返回 */
function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener?.("abort", done); resolve(); }
    signal?.addEventListener?.("abort", done);
  });
}

/* ------------------------------------------------------------------ *
 * Token：自己 mint 一个 llmk_ 写进 bucket（等价 `mimo llm-server issue`）
 * ------------------------------------------------------------------ */

function readStore(bucketDir) {
  const file = path.join(bucketDir, "tokens.json");
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s && s.version === 1 && Array.isArray(s.tokens)) return { file, store: s };
  } catch { /* 不存在或损坏 */ }
  return { file, store: { version: 1, tokens: [] } };
}

function writeStoreAtomic(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 直接写 tokens.json 完成签发。
 * 验证逻辑（引擎 src/llm-server/tokens.ts）只比对 sha256(presented) 与 record.hash，
 * 所以自己造 token + 写入 hash 即可通过鉴权，无需重启引擎。
 *
 * targets 可以是单个 bucket 目录，也可以是数组 —— 引擎不公告地址、我们算不出它
 * 用的是哪个 bucket 时，就往所有已知 bucket 都写一份，保证总有一个命中。
 */
function mintToken(targets, { label = "mimo-api-proxy", models = [], idleMs = 604800000, maxAgeMs = 2592000000 } = {}) {
  const dirs = [...new Set((Array.isArray(targets) ? targets : [targets]).filter(Boolean))];
  const token = crypto.randomBytes(32).toString("base64url");
  const record = {
    id: "llmk_" + crypto.randomUUID().replaceAll("-", "").slice(0, 16),
    hash: crypto.createHash("sha256").update(token).digest("hex"),
    label,
    models: [...models],
    created: Date.now(),
    idle_ms: idleMs,
    max_age_ms: maxAgeMs
  };
  const now = Date.now();
  const files = [];
  for (const dir of dirs) {
    try {
      // read-modify-write，保留引擎自己签发的 token（语音/ASR 等）
      const { file, store } = readStore(dir);
      store.tokens = store.tokens.filter((t) => !(t.idle_ms && now - (t.last_used ?? t.created) > t.idle_ms));
      // 清掉本代理上一次签的，避免无限膨胀
      store.tokens = store.tokens.filter((t) => t.label !== label);
      store.tokens.push(record);
      writeStoreAtomic(file, store);
      files.push(file);
    } catch (e) {
      warn("写入 token 失败:", dir, String(e?.message || e));
    }
  }
  return { token, record, files };
}

async function probe(base, token) {
  try {
    const r = await fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    return { ok: true, models: (j.data || []).map((m) => m.id) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(patch) {
  const s = { ...loadState(), ...patch };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 }); } catch {}
  return s;
}

/* ------------------------------------------------------------------ *
 * 引擎生命周期
 * ------------------------------------------------------------------ */

function findAppPath() {
  if (CFG.appPath && fs.existsSync(CFG.appPath)) return CFG.appPath;
  const home = os.homedir();
  const cands = [];
  const local = process.env.LOCALAPPDATA;
  if (local) cands.push(path.join(local, "Programs", "Xiaomi MiMo", "Xiaomi MiMo.exe"));
  for (const drive of ["C:", "D:", "E:"]) {
    cands.push(`${drive}\\Users\\${path.basename(home)}\\AppData\\Local\\Programs\\Xiaomi MiMo\\Xiaomi MiMo.exe`);
    cands.push(`${drive}\\Program Files\\Xiaomi MiMo\\Xiaomi MiMo.exe`);
  }
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return "";
}

let startPromise = null;
let lastStartAttempt = 0;
async function startApp() {
  if (startPromise) return startPromise;
  // 冷却：别在每个失败请求上反复 spawn 应用
  const cooldownMs = (CFG.startCooldownSec ?? 60) * 1000;
  if (lastStartAttempt && Date.now() - lastStartAttempt < cooldownMs) return false;
  lastStartAttempt = Date.now();
  startPromise = (async () => {
    const exe = findAppPath();
    if (!exe) {
      warn("找不到 Xiaomi MiMo.exe，请在 config.json 里设置 appPath");
      return false;
    }
    log("启动 MiMo 桌面版:", exe);
    try {
      const child = spawn(exe, [], { detached: true, stdio: "ignore" });
      child.unref();
    } catch (e) {
      warn("启动失败:", String(e?.message || e));
      return false;
    }
    // 这里只等「应用进程起来了」。真正的引擎端口由上层 resolveUpstream 重探决定 ——
    // 应用刚启动时先出现的是 Electron 内部端口（会被探成 404/401），不能当成就绪。
    const deadline = Date.now() + CFG.startTimeoutSec * 1000;
    const t0 = Date.now();
    let lastBeat = 0;
    while (Date.now() < deadline) {
      await sleep(1500);
      if ((await appPids()).size > 0) {
        log(`MiMo 桌面版已启动（等待 ${((Date.now() - t0) / 1000).toFixed(1)}s），继续等引擎端口…`);
        return true;
      }
      const waited = Math.round((Date.now() - t0) / 1000);
      if (waited - lastBeat >= 10) {
        lastBeat = waited;
        log(`等待 MiMo 桌面版启动中… ${waited}s / ${CFG.startTimeoutSec}s`);
      }
    }
    return (await appPids()).size > 0;
  })().finally(() => { startPromise = null; });
  return startPromise;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 免桌面端模式（standalone）
 *
 * 桌面端的免费额度靠的是它自己的小米 SSO 登录态。这条通道在云端是同一套：
 * 只要拿到小米账号的 SSO cookie（存在 Chromium cookie 库里，明文），
 * 走一遍 passport 换到 mimo 域会话，就能直接调 /api/route/chat/completions，
 * 完全不需要 MiMo 桌面端进程。
 *
 * 实测：登录一次后 passToken 长期有效，会话缓存在 accounts/mimo-session.json。
 * ------------------------------------------------------------------ */

let STANDALONE_UP = null; // { mode:"standalone", session, models, checkedAt, credSource }
let POOL_WAIT_NOTIFIED_AT = 0; // 「账号池全部冷却中」的提示节流

/**
 * 免桌面端上游解析。
 *
 * 账号池非空 → 走池：按亲和+轮询挑账号，逐个 ensureUsable（免费校验，
 * 失效用 passToken 静默重派生）；全部冷却时若剩余等待 ≤ rateLimitHoldMs
 * 就替客户端等（对客户端透明），否则抛 kind="rate-limited"（上层转 429+Retry-After）。
 * 池为空 → 保留旧的单会话路径（mimo-session.json + mimo-sso.json），行为不变。
 */
async function resolveStandalone({ force = false, ignoreThrottle = false, sessionKey = null, excludeUids = [], holdSignal = null } = {}) {
  const pool = ACCOUNTS.getPool({ log });
  if (pool.count() > 0) {
    const checkIntervalMs = CFG.upstreamCheckMs ?? 20000;
    const exclude = [...excludeUids];
    let lastError = null;
    for (let round = 0; round < Math.min(3, pool.count()); round++) {
      const acc = pool.pick({ sessionKey, excludeUids: exclude });
      if (!acc) break;
      const r = await pool.ensureUsable(acc, { force: force && round === 0, checkIntervalMs, log });
      if (r.ok) {
        return {
          mode: "standalone",
          session: { cookie: acc.cookie, userId: acc.uid, jar: acc.jar },
          models: dynamicModelIds().length ? dynamicModelIds() : [...STANDALONE.STANDALONE_MODELS],
          checkedAt: Date.now(),
          credSource: `pool:${acc.source}`,
          account: acc,
          poolUsed: true
        };
      }
      exclude.push(acc.uid);
      lastError = r.error;
    }

    // 没有就绪账号：能等就等（透明），等不了就 429。waitRounds 限制递归深度。
    const holdMs = Math.max(pool.nextReadyMs(), cloudCooldownRemainingMs());
    if (holdMs > 0) {
      const holdCap = CFG.rateLimitHoldMs ?? 45000;
      if (holdMs <= holdCap) {
        if (Date.now() - POOL_WAIT_NOTIFIED_AT > 10000) {
          POOL_WAIT_NOTIFIED_AT = Date.now();
          warn(`账号池全部冷却中，本请求等 ${(holdMs / 1000).toFixed(1)}s 后自动重试（不重新登录）`);
        }
        await abortableSleep(holdMs + 500, holdSignal);
        return resolveStandalone({ force: false, ignoreThrottle, sessionKey, excludeUids, holdSignal });
      }
      const retry = Math.max(1, Math.ceil(holdMs / 1000));
      throw Object.assign(new Error(`账号池全部账号冷却中（约 ${retry}s 后恢复）`), { kind: "rate-limited", retrySec: retry });
    }
    throw Object.assign(
      new Error(`账号池没有可用账号${lastError ? "：" + lastError : ""}（可在看板「账号池」里检查/启用）`),
      { kind: "pool-empty", retrySec: 0 }
    );
  }

  // ---- 旧单会话路径（池为空时保持原行为） ----
  if (STANDALONE_UP && !force) {
    if (Date.now() - (STANDALONE_UP.checkedAt || 0) < (CFG.upstreamCheckMs ?? 20000)) return STANDALONE_UP;
  }

  let knownInvalid = false;
  if (STANDALONE_UP) {
    // 免费校验（GET /api/user/xiaomi/me，不烧额度）。
    // 429 / 5xx / 断网都属于 "unknown"：不能证明会话失效，绝不重登。
    const v = await STANDALONE.validateSession(STANDALONE_UP.session);
    if (v.state === "valid") { STANDALONE_UP.checkedAt = Date.now(); return STANDALONE_UP; }
    if (v.state === "unknown") {
      if (!STANDALONE_UP.uncertainWarned) {
        STANDALONE_UP.uncertainWarned = true;
        warn(`免桌面端会话校验结果不确定（${v.status ?? v.error}），按「仍有效」继续使用（限流/网络波动≠会话失效）`);
      }
      STANDALONE_UP.checkedAt = Date.now();
      return STANDALONE_UP;
    }
    warn("免桌面端会话确定失效:", v.status ?? v.error, "→ 用本地凭据静默重登");
    STANDALONE_UP = null;
    knownInvalid = true; // 文件里缓存的同一个会话也已死，不必再走一遍文件缓存探测
  }

  if (!CFG.standaloneAutoLogin) throw new Error("免桌面端会话失效，且 standaloneAutoLogin=false");

  const r = await STANDALONE.ensureSession({
    // knownInvalid（内存会话刚被判定死亡）→ 直接重登；
    // 进程刚启动 → force=false，让 ensureSession 先用文件缓存会话做免费校验，
    // 有效就直接复用 —— 重启不再触发登录。
    force: knownInvalid,
    log: (m) => log(m),
    minIntervalMs: (CFG.loginCooldownSec ?? 30) * 1000,
    ignoreThrottle
  });
  if (!r.ok) {
    throw Object.assign(new Error(`免桌面端登录失败：${r.error}`), { kind: r.kind || "login-failed", retryAfterMs: r.retryAfterMs });
  }

  STANDALONE_UP = {
    mode: "standalone",
    session: r.session,
    models: dynamicModelIds().length ? dynamicModelIds() : [...STANDALONE.STANDALONE_MODELS],
    checkedAt: Date.now(),
    reused: r.reused,
    credSource: r.credSource ?? null,
    uncertainWarned: false
  };
  if (!r.reused) log("免桌面端模式就绪（直连云端免费通道，无需 MiMo 桌面端）");
  return STANDALONE_UP;
}

/* ------------------------------------------------------------------ *
 * 上游连接管理（引擎可能重启换端口，所以每次按需刷新）
 * ------------------------------------------------------------------ */

let UP = null; // { base, token, bucketDir, models, checkedAt }

/**
 * 本地引擎的发现与签发（原 resolveUpstream 的引擎分支）。
 * 返回 { ok:true, up } 或 { ok:false, errors, hadCandidates }。
 * autoStart 参数允许调用方禁止自动拉起桌面版。
 */
async function resolveEngine({ force = false, autoStart } = {}) {
  const allowAutoStart = autoStart ?? true;

  if (UP && !force) {
    // 已确认可用就别每个请求都探一次；失效靠 401 / 连接失败的重试路径兜底
    if (Date.now() - (UP.checkedAt || 0) < (CFG.upstreamCheckMs ?? 20000)) return { ok: true, up: UP };
    const p = await probe(UP.base, UP.token);
    if (p.ok) { UP.checkedAt = Date.now(); return { ok: true, up: UP }; }
    warn("上游不可用:", p.status ?? p.error, "→ 重新发现引擎");
  }

  const st = loadState();
  const buckets = allBucketDirs();

  /** 对一批候选逐个探测；成功返回 UP，失败返回错误清单 */
  const tryCandidates = async (candidates) => {
    const errors = [];
    for (const c of candidates) {
      const base = c.url.replace(/\/+$/, "");

      if (st.token && st.base === base) {
        const p = await probe(base, st.token);
        if (p.ok) {
          UP = { base, token: st.token, bucketDir: c.bucketDir || st.bucketDir, models: p.models, checkedAt: Date.now(), source: c.source };
          return { ok: true, up: UP };
        }
      }

      const targets = c.bucketDir ? [...new Set([c.bucketDir, ...buckets])] : buckets;
      if (!targets.length) { errors.push(`${base}: 找不到任何 llm-server bucket 目录`); continue; }

      const { token, files } = mintToken(targets, { models: CFG.modelScope });
      if (!files.length) { errors.push(`${base}: token 写入失败`); continue; }

      const p = await probe(base, token);
      if (!p.ok) {
        errors.push(`${base}: 签发后仍失败 (${p.status ?? p.error})，尝试过 ${files.length} 个 bucket`);
        continue;
      }

      saveState({ token, base, bucketDir: c.bucketDir || st.bucketDir || null });
      UP = { base, token, bucketDir: c.bucketDir || st.bucketDir || null, models: p.models, checkedAt: Date.now(), source: c.source };
      log(`上游就绪 ${base} (${c.source}) · 签发到 ${files.length} 个 bucket · ${p.models.length} 个模型`);
      return { ok: true, up: UP };
    }
    return { ok: false, errors };
  };

  const collect = async () => (CFG.engineBase
    ? [{ url: CFG.engineBase.replace(/\/+$/, ""), bucketDir: st.bucketDir || null, source: "config" }]
    : await candidateUpstreams());

  // 第一轮：现有候选
  let candidates = await collect();
  let outcome = await tryCandidates(candidates);

  // 第二轮：候选全挂（或压根没有）且允许自动启动 → 拉起桌面版，然后**持续重试**
  //   ⚠️ 这里必须无条件兜底。旧版只在 candidates 为空时才 startApp()，
  //   一旦存在「看起来活着但其实没人听」的失效公告文件（PID 复用），
  //   就永远进不了这个分支 —— 表现就是「突然启动不起来」。
  //   另外，应用刚起来时它那些 Electron 内部端口（1199/1200）会先出现并
  //   返回 404/401，真正的引擎端口要再等几秒；所以启动后要循环重探，不能只试一次。
  if (!outcome.ok && allowAutoStart && CFG.autoStart) {
    const why = candidates.length ? `${candidates.length} 个候选都不可用` : "没有发现候选端口";
    log(`${why}，尝试自动启动 MiMo 桌面版…`);
    await startApp(); // 冷却期内会直接返回 false，不影响下面的重试循环

    const deadline = Date.now() + (CFG.startTimeoutSec ?? 120) * 1000;
    const t0 = Date.now();
    let lastBeat = 0;
    while (Date.now() < deadline) {
      candidates = await collect();
      if (candidates.length) {
        outcome = await tryCandidates(candidates);
        if (outcome.ok) {
          log(`MiMo 引擎已就绪（等待 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
          break;
        }
      }
      await sleep(2000);
      const waited = Math.round((Date.now() - t0) / 1000);
      if (waited - lastBeat >= 10) {
        lastBeat = waited;
        log(`等待 MiMo 引擎就绪… ${waited}s / ${CFG.startTimeoutSec ?? 120}s`);
      }
    }
  }

  if (outcome.ok) return { ok: true, up: outcome.up };
  return { ok: false, errors: outcome.errors, hadCandidates: candidates.length > 0 };
}

async function resolveUpstream({ force = false, allowAutoStart, sessionKey = null, excludeUids = [], holdSignal = null } = {}) {
  // ---- 免桌面端优先 ----
  if (CFG.mode !== "engine") {
    try {
      return await resolveStandalone({ force, sessionKey, excludeUids, holdSignal });
    } catch (e) {
      // 限流标记（等不了了）：直接上抛，由 attempt 转成 429 + Retry-After
      if (e?.kind === "rate-limited") throw e;
      if (CFG.mode === "standalone") throw e;

      const msg = String(e?.message || e).slice(0, 120);
      const kind = e?.kind || "login-failed";
      // 只有「本机真的没有 SSO 凭据」才走老路（回退引擎 + 允许拉起桌面版）。
      // 有凭据却失败的（限流/网络/passport 波动）都是临时的：此时去启动
      // 桌面版只会把它自己的 Chromium cookie 库锁死、把 standalone 彻底
      // 顶掉 —— 所以只允许回退到「已经在运行」的引擎，绝不 spawn。
      const noCreds = kind === "no-credentials" || kind === "api-key-only";
      warn(noCreds
        ? `免桌面端不可用（${msg}），回退到本地引擎`
        : `免桌面端临时故障（${msg}）；不自动拉起桌面版，只尝试已在运行的本地引擎`);

      const eng = await resolveEngine({ force, autoStart: noCreds ? (allowAutoStart ?? true) : false });
      if (eng.ok) return eng.up;

      if (!noCreds) {
        // 有 SSO 凭据时的临时故障：把 standalone 的原始错误抛给客户端
        // （比「找不到引擎」更有指导性；客户端稍后重试即可，冷却结束自动恢复）
        throw e;
      }
      if (!eng.hadCandidates) {
        throw new Error(CFG.autoStart
          ? "没有找到 MiMo 引擎的监听端口（自动启动也没等到）"
          : "没有发现正在运行的 MiMo 引擎，且 autoStart=false");
      }
      throw new Error(`找到了 ${eng.hadCandidates ? "若干" : "0"} 个候选端口，但都拿不到 /v1 鉴权：\n  ` + (eng.errors || []).join("\n  "));
    }
  }

  const eng = await resolveEngine({ force, autoStart: allowAutoStart ?? true });
  if (eng.ok) return eng.up;
  if (!eng.hadCandidates) {
    throw new Error(CFG.autoStart
      ? "没有找到 MiMo 引擎的监听端口（自动启动也没等到）"
      : "没有发现正在运行的 MiMo 引擎，且 autoStart=false");
  }
  throw new Error(`找到了若干候选端口，但都拿不到 /v1 鉴权：\n  ` + (eng.errors || []).join("\n  "));
}

/* ------------------------------------------------------------------ *
 * 预热
 * 实测：xiaomi/mimo-x-pro-preview 空闲一段时间后，首个请求可能要 2~3 分钟
 * 才吐第一个 token（上游冷启动）；flash 只要 1 秒左右。启动时后台先打一发
 * 1-token 请求，把这个冷启动成本挪到用户看不见的地方。
 * ------------------------------------------------------------------ */

async function warmup() {
  if (!CFG.warmup) return;
  let up;
  try { up = await resolveUpstream(); } catch { return; }
  const list = exposedModels(up.models);
  const dynamicWarmup = dynamicModelIds().filter((id) => /mimo-v[0-9.]+-(?:pro|flash)$/i.test(id));
  const targets = (CFG.warmupModels?.length ? CFG.warmupModels : (dynamicWarmup.length ? dynamicWarmup : ["xiaomi/mimo-x-pro-preview", "xiaomi/mimo-x-flash-preview"]))
    .filter((m) => list.includes(m));
  for (const m of targets) {
    const t0 = Date.now();
    const bare = m.includes("/") ? m.slice(m.indexOf("/") + 1) : m;
    const req = up.mode === "standalone"
      ? STANDALONE.cloudChat(up.session, { model: bare, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }, { signal: AbortSignal.timeout(300000) })
      : fetch(`${up.base}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.token}` },
          body: JSON.stringify({ model: m, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
          signal: AbortSignal.timeout(300000)
        });
    req
      .then((r) => log(`预热 ${m}: ${r.ok ? "OK" : "HTTP " + r.status} ${((Date.now() - t0) / 1000).toFixed(1)}s`))
      .catch((e) => warn(`预热 ${m} 失败: ${String(e?.message || e)}`));
  }
}

/* ------------------------------------------------------------------ *
 * 对外暴露的模型
 * ------------------------------------------------------------------ */

/**
 * 对外暴露的模型 id 统一带 provider 前缀。
 * 引擎模式返回的就是 `xiaomi/mimo-x-flash-preview`，
 * 而免桌面端直连云端时返回的是裸名 `mimo-x-flash-preview` ——
 * 这里统一补齐，客户端看到的永远是一套 id。
 */
function normalizeModelId(id) {
  const s = String(id || "");
  if (!s) return s;
  return s.includes("/") ? s : `xiaomi/${s}`;
}

function exposedModels(all) {
  let list = all.map(normalizeModelId);
  // 剔掉「上游已明确说不可用」的模型（自学习，见 learnModelUnavailable）。
  // 否则 mimo-auto 这类被云端按 region 拦截的模型会一直挂在 /v1/models 里，
  // 客户端选中就必挂，而且是 400 而非 404，很难判断是代理的问题。
  list = list.filter((m) => !learnedUnavailable(m));
  if (CFG.exposeModels.length) list = list.filter((m) => CFG.exposeModels.includes(m));
  return [...new Set(list)].sort();
}

function resolveModelAlias(model) {
  if (typeof model !== "string" || !model) return model;
  if (model.includes("/")) return model; // 已经是 provider/model
  const key = model.toLowerCase();
  // 动态别名：mimo-flash / mimo-pro / flash / pro 都指向当前目录里最新的对应模型
  if (key === "mimo-flash" || key === "mimo-pro" || key === "flash" || key === "pro") {
    const dynamic = MODELING.resolveDynamicAlias(key.startsWith("mimo-") ? key : `mimo-${key}`, DYNAMIC_MODEL_RECORDS);
    if (dynamic && dynamic !== (key.startsWith("mimo-") ? key : `mimo-${key}`)) return dynamic;
  }
  const hit = CFG.aliases[key] || CFG.aliases[model];
  if (hit) return hit;
  return model;
}

/* ------------------------------------------------------------------ *
 * 能力自学习
 * 上游一旦明确拒绝某参数组合（例如 400 "Model does not support
 * reasoning_effort"、502 "Param Incorrect"），就把结论记到
 * accounts/model-capabilities.json，之后自动规避，不再撞同一堵墙 ——
 * 新模型上线 / 上游规则变化时无需改代码。
 * ------------------------------------------------------------------ */

const CAPS_FILE = path.join(HERE, "accounts", "model-capabilities.json");
let LEARNED = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(CAPS_FILE, "utf8"));
    return {
      noReasoningEffort: j.noReasoningEffort || {},
      maxOutput: j.maxOutput || {},
      unavailableModels: j.unavailableModels || {}
    };
  } catch { return { noReasoningEffort: {}, maxOutput: {}, unavailableModels: {} }; }
})();

const CAPABILITIES_FILE = CAPS_FILE;
let CAPABILITY_META = { catalogHash: null, catalogAt: 0 };
let CAPABILITIES = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(CAPABILITIES_FILE, "utf8"));
    CAPABILITY_META = { catalogHash: j.catalogHash || null, catalogAt: Date.parse(j.catalogAt || "") || 0 };
    return j.models || {};
  } catch { return {}; }
})();

const DECLARED_MODEL_SPECS = {
  "mimo-v2.6-flash": { contextWindow: 1048576, maxOutput: 131072, declaredBy: "xiaomi-model-catalog" },
  "mimo-v2.6-pro": { contextWindow: 1048576, maxOutput: 131072, declaredBy: "xiaomi-model-catalog" },
  "mimo-v2.6-pro-ultraspeed": { contextWindow: 1048576, maxOutput: 131072, declaredBy: "xiaomi-model-catalog" }
};

function capabilityFor(model) {
  const bare = String(model).replace(/^xiaomi\//, "");
  return {
    model,
    declared: DECLARED_MODEL_SPECS[bare] || DYNAMIC_MODEL_RECORDS.find((item) => item.id === model)?.catalog?.capabilities || null,
    ...(CAPABILITIES[model] || {})
  };
}

function saveCapabilities() {
  try {
    const current = loadJsonFile(CAPABILITIES_FILE, { missingValue: {}, label: "model capabilities" }).value || {};
    const catalogAt = new Date().toISOString();
    CAPABILITY_META = { catalogHash: DYNAMIC_CATALOG_HASH, catalogAt: Date.parse(catalogAt) };
    writeJsonAtomic(CAPABILITIES_FILE, { ...current, catalogHash: DYNAMIC_CATALOG_HASH, catalogAt, models: CAPABILITIES });
  } catch (error) { warn("模型能力缓存写入失败:", String(error?.message || error)); }
}

async function probeModelCapability(model, { deep = true, observedAt = new Date().toISOString() } = {}) {
  log(`[能力探测] 开始 ${model}${deep ? "（自动深测）" : "（快速）"}`);
  const up = await resolveUpstream();
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  const call = async (body) => up.mode === "standalone"
    ? STANDALONE.cloudChat(up.session, body, { signal: AbortSignal.timeout(120000) })
    : fetch(`${up.base}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.token}` }, body: JSON.stringify({ ...body, model }), signal: AbortSignal.timeout(120000) });
  const body = { model: bare, messages: [{ role: "user", content: "Reply with OK" }], max_tokens: 8, stream: false, reasoning_effort: "max" };
  const response = await call(body);
  const text = await response.text();
  let jsonBody = null;
  try { jsonBody = JSON.parse(text); } catch {}
  const usage = jsonBody?.usage || null;
  const record = {
    model,
    observedAt,
    status: response.status,
    available: response.ok,
    usage,
    reasoningEffort: response.ok ? "accepted" : /reasoning_effort/i.test(text) ? "rejected" : "unknown",
    declared: capabilityFor(model).declared,
    confidence: response.ok ? "probed" : "declared"
  };
  // 探测即学习：上游明确说该模型不可用（region 裁剪/套餐档位不足）→ 从对外列表移除
  if (!response.ok && isModelUnavailableError(response.status, text)) {
    learnModelUnavailable(model, text);
  }
  if (deep && response.ok) {
    const declared = record.declared || {};
    const target = Math.min(Number(declared.contextWindow || 0) || 0, Number(CFG.deepProbeTokenBudget || 0) || 0);
    let spent = 0;
    let verifiedInputTokens = 0;
    if (target > 0) {
      for (const size of [8192, 32768, 131072]) {
        if (spent + size > target) break;
        const filler = "context-probe ".repeat(Math.ceil(size / 2));
        const r = await call({ model: bare, messages: [{ role: "user", content: filler }], max_tokens: 1, stream: false });
        const t = await r.text();
        let j = null; try { j = JSON.parse(t); } catch {}
        const used = Number(j?.usage?.prompt_tokens) || size;
        spent += used;
        if (!r.ok) break;
        verifiedInputTokens = Math.max(verifiedInputTokens, used);
      }
    }
    record.deepProbe = {
      status: verifiedInputTokens > 0 ? "bounded-verified" : "declared-only",
      note: "Automatic deep probe verifies progressively larger live inputs within the configured token budget; the declared full boundary remains visible separately.",
      contextWindow: record.declared?.contextWindow ?? null,
      maxOutput: record.declared?.maxOutput ?? null,
      verifiedInputTokens,
      budgetTokens: Number(CFG.deepProbeTokenBudget || 0)
    };
  }
  CAPABILITIES[model] = record;
  saveCapabilities();
  log(`[能力探测] 完成 ${model}: HTTP ${record.status} context>=${record.deepProbe?.verifiedInputTokens || "?"} declared=${record.declared?.contextWindow || "?"} output=${record.declared?.maxOutput || "?"}`);
  return record;
}

let MODEL_PROBE_QUEUE;
function scheduleModelCapabilityProbe() {
  if (CFG.autoDeepProbe === false || !DYNAMIC_MODEL_RECORDS.length) return;
  const cooldown = Number(CFG.deepProbeCooldownHours || 24) * 3600000;
  if (CAPABILITY_META.catalogHash === DYNAMIC_CATALOG_HASH && Date.now() - CAPABILITY_META.catalogAt < cooldown) return;
  if (!MODEL_PROBE_QUEUE) {
    MODEL_PROBE_QUEUE = MODELING.createCapabilityProbeQueue({
      probeModel: probeModelCapability,
      isBusy: () => ACTIVE_CHAT > 0 || cloudCooldownRemainingMs() > 0,
      idleDelayMs: 1500
    });
  }
  MODEL_PROBE_QUEUE.enqueue(DYNAMIC_MODEL_RECORDS.map((item) => item.id), DYNAMIC_CATALOG_HASH);
  setTimeout(() => MODEL_PROBE_QUEUE?.run().catch((error) => warn("模型能力探测失败:", String(error?.message || error))), 5000).unref?.();
}

function saveLearned() {
  try {
    fs.mkdirSync(path.dirname(CAPS_FILE), { recursive: true });
    const current = loadJsonFile(CAPS_FILE, { missingValue: {}, label: "model capabilities" }).value || {};
    writeJsonAtomic(CAPS_FILE, {
      ...current,
      ...LEARNED,
      catalogHash: current.catalogHash || DYNAMIC_CATALOG_HASH,
      catalogAt: current.catalogAt || new Date().toISOString(),
      models: current.models || CAPABILITIES
    });
  } catch { /* 学习失败不影响主流程 */ }
}

function learnNoReasoningEffort(model) {
  if (!model || LEARNED.noReasoningEffort[model]) return;
  LEARNED.noReasoningEffort[model] = Date.now();
  saveLearned();
  warn(`[能力自学习] ${model} 被上游明确拒绝 reasoning_effort，已记录并自动剥离后续请求中的该参数`);
}

/**
 * 模型级不可用自学习。
 *
 * 背景：`mimo-standalone.mjs` 的 STANDALONE_MODELS 是一个**写死的目录**，
 * 而云端会按 region/country 动态裁剪可用模型。实测本机：
 *   mimo-auto → 400「模型不在对外可用模型列表: mimo-auto（region=CN, country=CN）」
 * 但代理照样把它列进 /v1/models 和 /api/stats，客户端选中就必挂 —— 且报错
 * 说的是「模型不在列表」，很容易被误判成代理 bug。
 *
 * 这里沿用本项目既有的「能力自学习」思路：上游一旦明确说某模型不在可用列表，
 * 就记为不可用并持久化，之后不再对外暴露；TTL 到期自动重新试（模型会随
 * 账号/地区策略变化）。
 */
const UNAVAILABLE_TTL_MS = Number(CFG.unavailableModelTtlMs ?? 6 * 3600 * 1000); // 6 小时

function learnModelUnavailable(model, detail) {
  if (!model) return;
  const rec = LEARNED.unavailableModels[model];
  if (rec && Date.now() - rec.at < 60000) return;   // 一分钟内不重复记
  LEARNED.unavailableModels[model] = { at: Date.now(), detail: String(detail || "").slice(0, 200) };
  saveLearned();
  warn(`[能力自学习] ${model} 当前不可用（${String(detail || "").slice(0, 120)}）→ 已从对外模型列表移除，${Math.round(UNAVAILABLE_TTL_MS / 3600000)} 小时后自动重试`);
}

function learnedUnavailable(model) {
  const rec = LEARNED.unavailableModels[model];
  if (!rec) return false;
  if (Date.now() - rec.at > UNAVAILABLE_TTL_MS) {
    delete LEARNED.unavailableModels[model];   // 过期，放它回来重试
    saveLearned();
    return false;
  }
  return true;
}

/** 上游明确说「模型不在可用列表」的特征（各语言/形态都覆盖一下） */
function isModelUnavailableError(status, msg) {
  if (!msg) return false;
  if (status !== 400 && status !== 404) return false;
  const t = String(msg);
  // 覆盖实测的三种云端拒绝形状：
  //   1. region 裁剪：模型不在对外可用模型列表（biz_code 41105）
  //   2. 套餐档位不足：邀测套餐不支持该模型，请购买付费套餐后使用（biz_code 41106）
  //   3. 通用 model_not_found / region 文案
  return /不在对外可用模型列表|not in the (?:available|supported) model list|model_not_found|not available in your (?:region|country)|套餐不支持该模型|chat_model_not_public|chat_model_not_for_plan_tier|biz_code[":\s]+4110[56]/i.test(t);
}
// 注：不做「502 Param Incorrect → 收缩 max_tokens 上限」的学习 —— 该错误不指明
// 是哪个字段引起的，误学会把正常的输出上限悄悄压低。max_tokens 超限由
// clampMaxTokens（默认开）在请求前夹住，不需要事后学习。

/**
 * 该模型支持 reasoning_effort 吗？
 *
 * 实测（每个模型各打 low/high）：
 *   xiaomi/mimo-x-flash-preview   ❌ 400 Model does not support reasoning_effort
 *   xiaomi/mimo-x-pro-preview     ❌ 400
 *   xiaomi/mimo-auto              ✅
 *   xiaomi/mimo-flash             ✅
 *   xiaomi/mimo-pro               ✅
 *
 * 客户端（DSH / Cline / 各类 agent）经常会自动带上 reasoning_effort，
 * 撞到 preview 模型就是硬 400。而且丢掉它没有任何损失 —— 思考输出
 * （reasoning_content）所有模型都是默认就有的，实测都返回同样的长度。
 */
function reasoningEffortSupported(model) {
  if (!CFG.stripUnsupportedReasoningEffort) return true;
  if (LEARNED.noReasoningEffort[model]) return false; // 自学习：上游明确拒绝过
  if (/(-|^)(x-)?preview$/i.test(String(model || ""))) return false;
  for (const m of CFG.noReasoningEffort || []) {
    const pat = String(m || "");
    if (!pat) continue;
    if (pat.endsWith("*")) { if (model.startsWith(pat.slice(0, -1))) return false; }
    else if (pat === model) return false;
  }
  return true;
}

/**
 * 每个模型允许的最大输出 token。
 * 实测：上游对 max_tokens > 131072 直接回 "Param Incorrect"（502），
 * 131072 及以下正常。131072 = 128 * 1024。
 * （max_tokens 超限由 clampMaxTokens 在请求前夹住，不做事后学习——
 *   "Param Incorrect" 不指明字段，事后学习会误伤正常上限。）
 */
function maxOutputFor(model) {
  const per = CFG.modelMaxOutputTokens || {};
  const cfgV = Number(per[model] ?? CFG.maxOutputTokens ?? 131072);
  const learned = Number(LEARNED.maxOutput?.[model]);
  const v = Number.isFinite(learned) && learned > 0 ? Math.min(cfgV, learned) : cfgV;
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 131072;
}

/* ------------------------------------------------------------------ *
 * HTTP 代理
 * ------------------------------------------------------------------ */

/**
 * 服务端 keep-alive 空闲窗口。
 *
 * Node 的 http.Server 默认 keepAliveTimeout = 5000ms：连接空闲超过 5 秒就被
 * 服务端单方面关闭，而客户端连接池并不知道，下次把请求写进这个半死 socket
 * 就会 ECONNRESET / socket hang up，只能重开连接重发 —— 表现为「每次都要重连
 * 几次才能干活」。agent 场景里一次「思考 + 工具执行」之间空闲 5 秒太常见了。
 *
 * 实测（repro-reconnect.mjs，同一条 TCP 连接隔 N 秒发两次请求）：
 *   gap=2000/4000/5500ms → 复用成功
 *   gap=7000/15000/30000ms → 复用失败（server closed idle keep-alive socket）
 *
 * 这里把窗口抬到 2 分钟并保持 sockets 常驻，同时用 Keep-Alive 响应头
 * 把这个窗口宣告给客户端，让双方对连接寿命的看法一致。
 */
const KEEP_ALIVE_MS = Number(CFG.keepAliveMs || process.env.MIMO_KEEPALIVE_MS || 120000);

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,x-api-key,api-key,anthropic-version,x-goog-api-key");
  res.setHeader("Access-Control-Max-Age", "86400");
  // 明确告诉客户端这条连接可以复用多久（与 server.keepAliveTimeout 对齐）。
  // agent 客户端在一次工具调用之后常有几秒到几十秒的空闲，
  // 不宣告窗口的话它们（或中间层）容易提前把连接判死。
  res.setHeader("Keep-Alive", `timeout=${Math.round(KEEP_ALIVE_MS / 1000)}`);
}

function json(res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    ...extraHeaders
  });
  res.end(body);
}

function presentedKey(req) {
  const auth = req.headers["authorization"];
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    return (m ? m[1] : auth).trim();
  }
  return (req.headers["x-api-key"] || req.headers["api-key"] || "").trim();
}

function clientAuthorized(req) {
  // config.json 里的静态 Key（向后兼容）
  if (CFG.apiKeys.length) {
    const k = presentedKey(req);
    if (k && CFG.apiKeys.some((candidate) => timingSafeStringEqual(candidate, k))) return true;
  }
  // 看板里管理的多 Key
  try {
    if (GUI.validateApiKey(presentedKey(req))) return true;
  } catch (error) {
    warn("看板设置读取失败，API 鉴权按拒绝处理:", String(error?.message || error));
    return false;
  }
  // 两边都没有配置 → 本机免密
  try {
    return CFG.apiKeys.length === 0 && GUI.loadSettings().apiKeys.length === 0;
  } catch {
    return false;
  }
}

function apiAuthRequired() {
  if (CFG.apiKeys.length > 0) return true;
  try { return GUI.loadSettings().apiKeys.some((k) => k.enabled !== false); }
  catch { return true; }
}

/** 解析出这次请求用的是哪个 Key（用于用量归属） */
function keyNameFor(req) {
  const k = presentedKey(req);
  if (!k) return "(免密)";
  const hit = GUI.loadSettings().apiKeys.find((x) => x.key === k);
  return hit ? hit.name : "(config.json)";
}

function readBody(req, limit = Number(CFG.maxRequestBodyBytes || 16 * 1024 * 1024)) {
  return readBodyLimited(req, { limit, contentLength: req.headers["content-length"] });
}

async function handleModels(req, res) {
  const up = await resolveUpstream();
  const ids = exposedModels(up.models);
  json(res, 200, {
    object: "list",
    data: ids.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: id.slice(0, id.indexOf("/")) || "xiaomi"
    }))
  });
}

let CHAT_REQUEST_SEQ = 0;
let ACTIVE_CHAT = 0;

async function handleChat(req, res, rawBody) {
  const requestId = ++CHAT_REQUEST_SEQ;
  const t0 = Date.now();
  let body;
  try {
    body = rawBody.length ? JSON.parse(rawBody.toString("utf8")) : {};
  } catch {
    return json(res, 400, { error: { message: "invalid JSON body", type: "invalid_request_error" } });
  }

  if (body.model) body.model = resolveModelAlias(body.model);
  if (!body.model) return json(res, 400, { error: { message: "`model` is required", type: "invalid_request_error" } });
  ACTIVE_CHAT++;

  // ⚡ 上游句柄只解析一次，下面 attempt() 直接复用。
  //   旧代码在这里解析一次、attempt() 里又解析一次：空闲超过 upstreamCheckMs(20s)
  //   时，每个请求都要多走一轮会话校验（多一次到云端的 RTT + TLS），
  //   是「歇一会儿再问就变慢」的一个来源。
  //   sessionKey = 调用方 Key 名：账号池按它做会话亲和（同一客户端粘同一账号）。
  const sessionKey = keyNameFor(req);
  let preUp = null;
  try { preUp = await resolveUpstream({ sessionKey }); } catch { /* 交给 attempt() 抛更准确的错 */ }

  if (CFG.exposeModels.length && preUp) {
    const allow = exposedModels(preUp.models);
    if (!allow.includes(body.model)) {
      return json(res, 404, {
        error: { message: `Model \`${body.model}\` is not exposed by this proxy`, type: "invalid_request_error", code: "model_not_found" },
        available: allow
      });
    }
  }

  // 上游硬上限：max_tokens > 131072 会被小米网关拒成
  //   502 {"message":"Param Incorrect","type":"api_error"}
  // 很多客户端默认给一个很大的值（200000 / 999999 / -1），直接透传必挂，
  // 所以在代理这一层夹到上限，对客户端透明。
  if (CFG.clampMaxTokens !== false) {
    const cap = maxOutputFor(body.model);
    const fixes = [];
    for (const key of ["max_tokens", "max_completion_tokens"]) {
      const v = body[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > cap) {
        fixes.push(`${key}=${JSON.stringify(v)} -> ${cap}`);
        body[key] = cap;
      }
    }
    if (fixes.length) warn(`已夹住超限参数（上游上限 ${cap}）: ${fixes.join(", ")}`);
  }

  // 实测：两个 preview 模型都不支持 reasoning_effort（400），
  // 但思考输出(reasoning_content)本身默认就有 —— 丢掉这个参数没有任何损失。
  // 不丢的话，DSH / Cline 这类客户端自动带上就必挂。
  // ⚠️ 按「当前用的是哪条上游」决定丢不丢，不能一刀切：
  //   - 本地引擎（engine 模式）：两个 -preview 模型会硬 400，必须丢；
  //   - 免桌面端（standalone 直连云端）：实测 reasoning_effort=high/none
  //     一律 200，云端是接受的 —— 再丢就等于白扔用户显式设置的思考力度。
  //   （实测见 probe-capabilities.mjs / probe-capabilities.json）
  const clientEffort = body.reasoning_effort ?? null;
  const upstreamIsEngine = preUp ? preUp.mode !== "standalone" : CFG.mode === "engine";
  if (body.reasoning_effort !== undefined && body.reasoning_effort !== null
      && upstreamIsEngine && !reasoningEffortSupported(body.model)) {
    const eff = body.reasoning_effort;
    delete body.reasoning_effort;
    const key = `${body.model}|reasoning_effort`;
    if (!reasoningWarned.has(key)) {
      reasoningWarned.add(key);
      warn(`已丢弃 reasoning_effort=${JSON.stringify(eff)}：${body.model} 不支持该参数（思考输出本身默认开启，无需设置）。若确实需要调节思考力度，请改用 xiaomi/mimo-pro / xiaomi/mimo-flash / xiaomi/mimo-auto`);
    }
  }

  const payload = Buffer.from(JSON.stringify(body));
  const stream = body.stream === true;
  const usageBase = {
    at: new Date().toISOString(),
    model: body.model,
    stream,
    keyName: keyNameFor(req),
    messages: Array.isArray(body.messages) ? body.messages.length : 0,
    tools: Array.isArray(body.tools) ? body.tools.length : 0
  };
  if (CFG.requestMetrics !== false) {
    console.log(formatChatStart({
      at: new Date(t0), requestId, model: body.model,
      clientEffort, upstreamEffort: body.reasoning_effort ?? null,
      stream, messages: usageBase.messages
    }));
  }

  let httpStatusLogged = false;
  const originalWriteHead = res.writeHead;
  res.writeHead = function metricsWriteHead(statusCode, ...args) {
    if (!httpStatusLogged && CFG.requestMetrics !== false) {
      httpStatusLogged = true;
      console.log(`[mimo-proxy] ${new Date().toTimeString().slice(0, 8)} "${req.method} ${req.url} HTTP/${req.httpVersion}" ${statusCode} -`);
    }
    return originalWriteHead.call(this, statusCode, ...args);
  };

  let requestFinished = false;
  // 最近一次 attempt 实际使用的账号 uid（完整值，落 usage.jsonl 供按账号聚合；
  // record.account 里放的是脱敏短哈希，仅供展示）
  let lastAccountUid = null;
  const finishRequest = ({ mode, account, ok, status, error = null, metrics = null, promptTokens = null, completionTokens = null, accountUid } = {}) => {
    if (requestFinished) return;
    requestFinished = true;
    ACTIVE_CHAT = Math.max(0, ACTIVE_CHAT - 1);
    const finalMetrics = metrics || {
      ...calculateMetrics({ startedAt: t0, finishedAt: Date.now(), promptTokens, completionTokens }),
      promptTokens,
      completionTokens,
      totalTokens: Number.isFinite(promptTokens) && Number.isFinite(completionTokens) ? promptTokens + completionTokens : null
    };
    const record = {
      ...usageBase,
      requestId,
      mode: mode || "unknown",
      account: account || "-",
      accountUid: accountUid !== undefined ? accountUid : lastAccountUid,
      ok: !!ok,
      status: status ?? 0,
      promptTokens: finalMetrics.promptTokens,
      completionTokens: finalMetrics.completionTokens,
      totalTokens: finalMetrics.totalTokens,
      ttftMs: finalMetrics.ttftMs,
      tokensPerSec: finalMetrics.tokensPerSec,
      durationMs: finalMetrics.durationMs,
      latencyMs: finalMetrics.durationMs,
      error: error ? String(error).slice(0, 200) : null
    };
    GUI.recordUsage(record);
    if (CFG.requestMetrics !== false) console.log(formatChatDone({ ...record, at: new Date() }));
  };
  res.once("close", () => {
    if (!requestFinished && !res.writableEnded) {
      finishRequest({ mode: "unknown", account: "-", ok: false, status: 499, error: "client cancelled" });
    }
  });

  const attempt = async (isRetry, { force = isRetry, relogin = false, excludeUid = null } = {}) => {
    if (relogin) { STANDALONE.clearSession(); STANDALONE_UP = null; }
    const ac = new AbortController();
    req.on("aborted", () => ac.abort());
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });
    const totalMs = Number(CFG.requestTimeoutMs || 0);
    const outerSignal = totalMs > 0 ? AbortSignal.any([ac.signal, AbortSignal.timeout(totalMs)]) : ac.signal;
    const idle = createIdleAbortController({ outerSignal, timeoutMs: Number(CFG.upstreamIdleTimeoutMs || 0) });

    // 复用 handleChat 顶部已经解析好的上游句柄，省掉每个请求一次重复解析。
    // 只有显式 force（401/连接失败后的重试）、指定了排除账号（429 轮换）
    // 或缓存缺失时才重新解析。
    const needFresh = force || excludeUid;
    let up;
    try {
      up = (!needFresh && preUp) ? preUp : await resolveUpstream({
        force: needFresh ? true : false,
        sessionKey,
        excludeUids: excludeUid ? [excludeUid] : [],
        holdSignal: ac.signal
      });
    } catch (e) {
      idle.dispose();
      // 账号池全部冷却且剩余等待超过持有窗口：转为 429 + Retry-After
      if (e?.kind === "rate-limited") {
        const retry = Math.max(1, Number(e.retrySec) || 1);
        finishRequest({ mode: "standalone", account: "-", ok: false, status: 429, error: String(e?.message || e) });
        cors(res);
        return json(res, 429, {
          error: { message: String(e?.message || e), type: "rate_limit_error", code: "rate_limited" }
        }, { "Retry-After": String(retry) });
      }
      throw e;
    }
    const mode = up.mode === "standalone" ? "standalone" : "engine";
    const account = up.mode === "standalone" ? shortAccountId(up.account?.uid || up.session?.userId) : "-";
    lastAccountUid = up.account?.uid || up.session?.userId || null;
    const pool = up.account ? ACCOUNTS.getPool({ log }) : null;

    // ---- 免桌面端：直连云端免费通道 ----
    if (up.mode === "standalone") {
      // 云端只认裸模型名（不带 provider 前缀）
      const cloudBody = { ...body };
      const bare = String(cloudBody.model || "").includes("/")
        ? String(cloudBody.model).slice(String(cloudBody.model).indexOf("/") + 1)
        : cloudBody.model;
      cloudBody.model = bare;

      // ---- 云端限流冷却：把请求按住到窗口结束（对客户端透明） ----
      // 池模式有自己的按账号冷却（resolveStandalone 里已经等过了），
      // 这里只对旧单会话路径生效 —— 否则账号明明就绪还要白等全局冷却。
      const waitMs = up.poolUsed ? 0 : cloudCooldownRemainingMs();
      if (waitMs > 0) {
        if (ac.signal.aborted) return;
        const hold = CFG.rateLimitHoldMs ?? 45000;
        if (waitMs <= hold) {
          CLOUD_LIMIT.waiters++;
          try {
            const stagger = Math.min(5000, (CLOUD_LIMIT.waiters - 1) * 400); // 放行错峰，避免惊群再撞限流
            if (Date.now() - CLOUD_LIMIT.notifiedAt > 10000) {
              CLOUD_LIMIT.notifiedAt = Date.now();
              warn(`云端限流冷却中，本请求等 ${((waitMs + stagger) / 1000).toFixed(1)}s 后自动放行（当前在等 ${CLOUD_LIMIT.waiters} 个）`);
            }
            await abortableSleep(waitMs + stagger, ac.signal);
          } finally { CLOUD_LIMIT.waiters--; }
          if (ac.signal.aborted || res.writableEnded || res.destroyed) return;
        } else {
          const retry = Math.max(1, Math.ceil(waitMs / 1000));
          idle.dispose();
          finishRequest({ mode, account, ok: false, status: 429, error: `云端限流冷却中（剩 ${retry}s）` });
          cors(res);
          return json(res, 429, {
            error: { message: `MiMo 云端限流冷却中（${CLOUD_LIMIT.reason}），请约 ${retry}s 后重试`, type: "rate_limit_error", code: "rate_limited" }
          }, { "Retry-After": String(retry) });
        }
      }

      let upstream;
      try {
        upstream = await STANDALONE.cloudChat(up.session, cloudBody, { stream, signal: idle.signal });
        idle.touch();
      } catch (e) {
        if (!isRetry && !ac.signal.aborted) {
          // 网络错误 ≠ 会话失效：不重登，只重试一次（会话校验走免费 GET，不确定就复用）
          warn("免桌面端请求网络失败，重试一次（不重新登录）:", String(e?.message || e));
          idle.dispose();
          return attempt(true, { force: false });
        }
        idle.dispose();
        finishRequest({ mode, account, ok: false, status: 0, error: String(e?.message || e) });
        throw e;
      }

      // 会话确定过期（401）：
      //   池模式 → 用该账号的 passToken 静默重派生；凭据已死就轮换下一个账号
      //   旧路径 → 清本地会话重新登录（原行为）
      if (upstream.status === 401 && !isRetry) {
        try { await upstream.body?.cancel(); } catch {}
        idle.dispose();
        if (pool && up.account) {
          warn(`免桌面端 401（账号 ${up.account.nickname} 会话过期），静默重派生…`);
          const r = await pool.rederive(up.account, { log });
          if (r.ok) return attempt(true, { force: true });
          if (CFG.poolRotateOn429 !== false && pool.hasReady([up.account.uid])) {
            warn(`账号 ${up.account.nickname} 凭据已失效，轮换到下一个账号`);
            return attempt(true, { force: true, excludeUid: up.account.uid });
          }
          finishRequest({ mode, account, ok: false, status: 401, error: r.error || "会话过期且无可用账号" });
          cors(res);
          return json(res, 401, {
            error: { message: `MiMo 账号池无可用会话：${r.error || "会话过期"}`, type: "api_error", code: "upstream_auth" }
          });
        }
        warn("免桌面端 401（会话过期），用本地缓存凭据静默重登后重试");
        return attempt(true, { force: true, relogin: true });
      }

      // 云端限流（TPM, biz_code 30014）：
      //   池模式 → 只冷却肇事的账号（解析「请约 N 秒后重试」），并轮换下一个就绪账号；
      //             全部账号都在冷却时才升级为全局冷却 + 429
      //   旧路径 → 全局冷却 + Retry-After（原行为）。绝不重登 —— 限流不是会话失效。
      if (upstream.status === 429 && !ac.signal.aborted) {
        const buf429 = Buffer.from(await upstream.arrayBuffer().catch(() => new Uint8Array()));
        const txt = buf429.toString("utf8");
        const sec = STANDALONE.parseRetrySeconds(txt) ?? 10;
        if (pool && up.account) {
          pool.noteError(up.account.uid, txt.replace(/\s+/g, " ").slice(0, 140), (sec + 2) * 1000);
          if (CFG.poolRotateOn429 !== false && !isRetry && pool.hasReady([up.account.uid])) {
            log(`云端限流（约 ${sec}s），账号 ${up.account.nickname} 冷却，轮换下一个账号重试`);
            idle.dispose();
            return attempt(true, { force: true, excludeUid: up.account.uid });
          }
        }
        armCloudCooldown(sec, txt.replace(/\s+/g, " ").slice(0, 140));
        const retry = Math.max(1, Math.ceil(cloudCooldownRemainingMs() / 1000));
        logUpstreamError(429, body, buf429);
        idle.dispose();
        finishRequest({ mode, account, ok: false, status: 429, error: txt.slice(0, 200) });
        cors(res);
        return json(res, 429, {
          error: { message: txt.slice(0, 300) || "MiMo 云端限流（TPM）", type: "rate_limit_error", code: "rate_limited" },
          retryAfterSec: retry
        }, { "Retry-After": String(retry) });
      }

      if (upstream.ok && pool && up.account) pool.noteSuccess(up.account.uid);

      const h2 = { "Content-Type": "application/json; charset=utf-8" };
      cors(res);
      if (stream && upstream.ok) {
        h2["Content-Type"] = "text/event-stream; charset=utf-8";
        h2["Cache-Control"] = "no-cache, no-transform";
        h2["X-Accel-Buffering"] = "no";
        res.writeHead(200, h2);
        res.flushHeaders?.();
        if (!upstream.body) {
          idle.dispose();
          finishRequest({ mode, account, ok: true, status: 200 });
          return res.end();
        }
        const tracker = createSseMetricsTracker({ startedAt: t0 });
        for await (const chunk of Readable.fromWeb(upstream.body)) {
          idle.touch();
          res.write(chunk);
          tracker.push(chunk);
        }
        idle.dispose();
        finishRequest({ mode, account, ok: true, status: 200, metrics: tracker.finish() });
        return res.end();
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (!upstream.ok) logUpstreamError(upstream.status, body, buf);
      let pt = null, ct = null;
      if (upstream.ok) {
        try { const j = JSON.parse(buf.toString("utf8")); pt = j.usage?.prompt_tokens ?? null; ct = j.usage?.completion_tokens ?? null; } catch {}
      }
      idle.dispose();
      finishRequest({ mode, account, ok: upstream.ok, status: upstream.status, promptTokens: pt, completionTokens: ct, error: upstream.ok ? null : buf.toString("utf8").slice(0, 200) });
      res.writeHead(upstream.status, h2);
      return res.end(buf);
    }

    let upstream;
    try {
      upstream = await fetch(`${up.base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${up.token}`,
          Accept: stream ? "text/event-stream" : "application/json"
        },
        body: payload,
        signal: idle.signal
      });
      idle.touch();
    } catch (e) {
      // 引擎换了端口 / 被关了 → 重新发现一次再试
      if (!isRetry && !ac.signal.aborted) {
        warn("上游连接失败，重新发现引擎后重试:", String(e?.message || e));
        idle.dispose();
        return attempt(true);
      }
      idle.dispose();
      finishRequest({ mode, account, ok: false, status: 0, error: String(e?.message || e) });
      throw e;
    }

    // token 被引擎清掉 / 过期 → 重签一次
    if (upstream.status === 401 && !isRetry) {
      try { await upstream.body?.cancel(); } catch {}
      warn("上游 401，重新签发 token 后重试");
      idle.dispose();
      return attempt(true);
    }

    const headers = {};
    for (const [k, v] of upstream.headers) {
      if (["content-length", "content-encoding", "transfer-encoding", "connection"].includes(k.toLowerCase())) continue;
      headers[k] = v;
    }
    cors(res);
    if (stream) {
      // 上游直接报错（不是流中断）：落盘 + 以 JSON 返回，别把它塞进 SSE 里
      if (!upstream.ok) {
        const ebuf = Buffer.from(await upstream.arrayBuffer());
        logUpstreamError(upstream.status, body, ebuf);
        idle.dispose();
        finishRequest({ mode, account, ok: false, status: upstream.status, error: ebuf.toString("utf8").slice(0, 200) });
        res.writeHead(upstream.status, { ...headers, "Content-Type": "application/json; charset=utf-8" });
        return res.end(ebuf);
      }
      // 关掉缓冲，保证 SSE 逐帧下发
      headers["Cache-Control"] = "no-cache, no-transform";
      headers["X-Accel-Buffering"] = "no";
      headers["Content-Type"] = "text/event-stream; charset=utf-8";
      res.writeHead(upstream.status, headers);
      res.flushHeaders?.();
      if (!upstream.body) {
        idle.dispose();
        finishRequest({ mode, account, ok: true, status: upstream.status });
        return res.end();
      }

      const tracker = createSseMetricsTracker({ startedAt: t0 });
      for await (const chunk of Readable.fromWeb(upstream.body)) {
        idle.touch();
        res.write(chunk);
        tracker.push(chunk);
      }
      idle.dispose();
      finishRequest({ mode, account, ok: true, status: upstream.status, metrics: tracker.finish() });
      return res.end();
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (!upstream.ok) logUpstreamError(upstream.status, body, buf);
    let promptTokens = null, completionTokens = null;
    if (upstream.ok) {
      try {
        const j = JSON.parse(buf.toString("utf8"));
        promptTokens = j.usage?.prompt_tokens ?? null;
        completionTokens = j.usage?.completion_tokens ?? null;
      } catch {}
    }
    idle.dispose();
    finishRequest({ mode, account, ok: upstream.ok, status: upstream.status, promptTokens, completionTokens, error: upstream.ok ? null : buf.toString("utf8").slice(0, 200) });
    res.writeHead(upstream.status, headers);
    res.end(buf);
  };

  try {
    await attempt(false);
  } catch (error) {
    finishRequest({ mode: "unknown", account: "-", ok: false, status: 0, error: String(error?.message || error) });
    throw error;
  }
}

/**
 * 上游报错时把「请求参数 + 上游原文」留下来。
 * 502 "Param Incorrect" 这类错误引擎只说一句，不给是哪个字段 —— 这里补上。
 * 同时负责能力自学习（reasoning_effort / max_tokens 被上游明确拒绝时记录），
 * 以及落盘去重：同类错误 dumpDedupSec 秒内只写一次，429 风暴不再刷爆磁盘。
 */
const lastDumpAt = new Map();

function logUpstreamError(status, body, respBuf) {
  let upstreamMsg = "";
  try { upstreamMsg = respBuf.toString("utf8").slice(0, 500); } catch {}
  upstreamMsg = sanitizeDiagnosticText(upstreamMsg);
  const summary = buildFailureDump({ request: body, status, upstreamText: upstreamMsg, includeBodies: false }).summary;
  warn(`上游 ${status}: ${upstreamMsg.replace(/\s+/g, " ").slice(0, 200)}`);
  warn("  请求概要:", JSON.stringify(summary));

  // ---- 能力自学习：上游明确点名拒绝的参数，记下来以后自动规避 ----
  if (status === 400 && /reasoning_effort/i.test(upstreamMsg) && /not support|不支持/i.test(upstreamMsg)) {
    learnNoReasoningEffort(body.model);
  }
  // ---- 能力自学习：模型不在云端可用列表（按 region/country 裁剪）----
  if (isModelUnavailableError(status, upstreamMsg)) {
    learnModelUnavailable(body.model, upstreamMsg);
  }

  // ---- 落盘（去重） ----
  if (CFG.dumpFailedRequests !== false) {
    const key = `${status}:${body.model}`;
    const last = lastDumpAt.get(key) || 0;
    if (Date.now() - last < (CFG.dumpDedupSec ?? 60) * 1000) {
      warn(`  (同类错误 ${CFG.dumpDedupSec}s 内已落盘过，跳过重复转储)`);
      if (lastDumpAt.size > 100) lastDumpAt.clear();
      return;
    }
    lastDumpAt.set(key, Date.now());
    try {
      const dir = path.join(HERE, "failed-requests");
      fs.mkdirSync(dir, { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${status}.json`;
      const dump = buildFailureDump({ request: body, status, upstreamText: upstreamMsg, includeBodies: CFG.dumpFailedRequestBodies === true });
      fs.writeFileSync(path.join(dir, name), JSON.stringify(dump, null, 2));
      warn(`  ${CFG.dumpFailedRequestBodies === true ? "完整请求" : "脱敏诊断"}已存到 failed-requests/${name}`);
      pruneFailedRequests(dir);
    } catch (e) {
      warn("  落盘失败:", String(e?.message || e));
    }
  }
}

/**
 * 清理 failed-requests/，防止无限增长。
 *
 * 原实现只做「同类错误 N 秒内去重」，但没有**总量**上限：每次换模型/换状态码
 * 的键都不一样，文件会一直堆下去。实测已经堆到 86 个文件 / 80MB
 * （单个最大 9MB —— 因为落的是完整请求体，含 system prompt + 全部对话）。
 *
 * 策略：按「条数」和「总字节」双上限裁剪，优先删最旧的；至少保留最近 3 个。
 */
const DUMP_KEEP_MAX = Number(CFG.dumpKeepMax ?? 40);              // 最多保留几个
const DUMP_KEEP_BYTES = Number(CFG.dumpKeepBytes ?? 20 * 1024 * 1024); // 最多占用多少字节
let lastPruneAt = 0;

function pruneFailedRequests(dir) {
  // 落盘本身就是异常路径，别每次都扫目录；30 秒最多扫一次
  if (Date.now() - lastPruneAt < 30000) return;
  lastPruneAt = Date.now();
  try {
    const files = fs.readdirSync(dir)
      .filter((n) => n.endsWith(".json") && n !== "example-502-param-incorrect.json")
      .map((n) => {
        const full = path.join(dir, n);
        try { const st = fs.statSync(full); return { full, name: n, size: st.size, mtime: st.mtimeMs }; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtime - b.mtime);   // 旧 → 新

    let total = files.reduce((s, f) => s + f.size, 0);
    let removed = 0;
    // 从最旧的开始删，直到同时满足「条数」和「字节」两个上限
    while (files.length - removed > DUMP_KEEP_MAX || total > DUMP_KEEP_BYTES) {
      if (files.length - removed <= 3) break;   // 至少留最近 3 个便于排查
      const victim = files[removed];
      try {
        fs.unlinkSync(victim.full);
        total -= victim.size;
        removed++;
      } catch { removed++; }
    }
    if (removed) {
      log(`failed-requests 已清理 ${removed} 个旧文件（保留 ${files.length - removed} 个 / ${(total / 1024 / 1024).toFixed(1)}MB）`);
    }
  } catch { /* 清理失败不影响主流程 */ }
}

/* ------------------------------------------------------------------ *
 * Web 看板（按 wb-proxy 的标准：单文件 dashboard.html + 面板密码 + JSON API）
 * ------------------------------------------------------------------ */

const DASHBOARD_FILE = path.join(HERE, "dashboard.html");

/**
 * 登录失败退避。
 *
 * 原实现只有 sleep(400) —— 只让单个请求慢，并发爆破完全不受影响。
 * 这里按来源 IP 计数：5 次失败后开始指数退避，最多锁 15 分钟。
 * 成功登录即清零。
 */
const LOGIN_MAX_FAILS = Number(CFG.loginMaxFails ?? 5);
const LOGIN_LOCK_BASE_MS = Number(CFG.loginLockBaseMs ?? 5000);
const LOGIN_LOCK_MAX_MS = Number(CFG.loginLockMaxMs ?? 15 * 60 * 1000);
const loginFails = new Map();   // ip -> { count, until }

function clientIp(req) {
  return req.socket?.remoteAddress || "unknown";
}

function loginGate(req) {
  const rec = loginFails.get(clientIp(req));
  if (!rec || !rec.until) return { locked: false };
  const left = rec.until - Date.now();
  if (left > 0) return { locked: true, retryAfterMs: left };
  rec.until = 0;                // 锁到期，允许再试（计数保留，继续指数退避）
  return { locked: false };
}

function recordLoginFailure(req) {
  const ip = clientIp(req);
  const rec = loginFails.get(ip) || { count: 0, until: 0 };
  rec.count++;
  if (rec.count >= LOGIN_MAX_FAILS) {
    const over = rec.count - LOGIN_MAX_FAILS;
    const ms = Math.min(LOGIN_LOCK_MAX_MS, LOGIN_LOCK_BASE_MS * Math.pow(2, over));
    rec.until = Date.now() + ms;
    warn(`[看板] 登录失败 ${rec.count} 次（来自 ${ip}），锁定 ${Math.ceil(ms / 1000)}s`);
  }
  loginFails.set(ip, rec);
  // 防内存无上限增长
  if (loginFails.size > 500) {
    for (const [k, v] of loginFails) {
      if (!v.until || v.until < Date.now()) loginFails.delete(k);
      if (loginFails.size <= 200) break;
    }
  }
}

function clearLoginFailures(req) {
  loginFails.delete(clientIp(req));
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const raw = await readBodyLimited(req, { limit, contentLength: req.headers["content-length"] });
  try {
    return JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    throw new HttpInputError(400, "Invalid JSON body", "invalid_json");
  }
}

function panelCookie(req) {
  const raw = req.headers.cookie || "";
  const m = /(?:^|;\s*)mimo_panel=([^;]+)/.exec(raw);
  return m ? decodeURIComponent(m[1]) : null;
}

function quotaPayload(exact, free) {
  const saved = GUI.loadPlatformCookie();
  return {
    ...exact,
    free: free ?? null,
    cookieSource: lastPlatformCookieSource ?? null,
    cookieSavedAt: saved?.savedAt ?? null,
    cookieHint: lastPlatformCookieSource
      ? null
      : (lastPlatformDeriveError
        ? "开放平台需要交互登录：请在浏览器登录 platform.xiaomimimo.com 后，于看板粘贴 Cookie（一次即可长期使用）"
        : "尚未配置开放平台 Cookie：可在看板「登录开放平台」里导入"),
    local: {
      label: "本代理本地累计（不是账户剩余额度）",
      usage: GUI.getSummary(),
      cloudCooldownSec: Math.ceil(cloudCooldownRemainingMs() / 1000),
      cloudCooldownReason: CLOUD_LIMIT.until > Date.now() ? CLOUD_LIMIT.reason : ""
    }
  };
}

function logQuotaStatus(quota) {
  if (quota.state === "available") {
    const balance = quota.balance?.total == null ? "?" : `${quota.balance.total}${quota.balance.currency ? ` ${quota.balance.currency}` : ""}`;
    const plan = quota.tokenPlan?.remaining == null ? "?" : `${quota.tokenPlan.remaining.toLocaleString("en-US")} / ${quota.tokenPlan.total?.toLocaleString("en-US") ?? "?"}`;
    log(`[额度] 小米开放平台余额=${balance}，Token Plan 剩余=${plan}（来源与桌面免费通道可能独立）`);
  } else {
    log(`[额度] 精确账户额度不可用：${quota.reason || quota.state}；看板仍显示本地累计和限流冷却，二者不是剩余额度。`);
  }
}

async function handleGui(req, res, url, p) {
  // 静态看板
  if (p === "/" || p === "/dashboard") {
    try {
      const html = fs.readFileSync(DASHBOARD_FILE);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    } catch {
      return json(res, 500, { error: "dashboard.html 缺失" });
    }
  }

  let body = {};
  if (req.method === "POST") {
    try { body = await readJsonBody(req); }
    catch (error) {
      if (error instanceof HttpInputError) {
        return json(res, error.status, { error: { message: error.message, type: "invalid_request_error", code: error.code } });
      }
      throw error;
    }
  }
  const sid = panelCookie(req);

  // ---- 登录 / 登出（不需要会话）----
  if (p === "/api/login") {
    const s = GUI.loadSettings();
    // ⚠️ 原来的 `sleep(400)` 挡不住并发爆破：它只是让每个请求慢一点，
    // 100 个并发照样能同时打进来（延迟是「各自等待」，不是「串行排队」）。
    // 这里加真正的失败计数 + 退避锁定。
    const gate = loginGate(req);
    if (gate.locked) {
      return json(res, 429, {
        ok: false,
        error: `密码错误次数过多，请 ${Math.ceil(gate.retryAfterMs / 1000)} 秒后再试`,
        retryAfterSec: Math.ceil(gate.retryAfterMs / 1000)
      }, { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) });
    }
    if (!GUI.verifyPassword(String(body.password || ""), s.panelPasswordHash)) {
      recordLoginFailure(req);
      await sleep(400); // 保留轻微延迟
      return json(res, 401, { ok: false, error: "密码错误" });
    }
    clearLoginFailures(req);
    const token = GUI.newSession();
    res.setHeader("Set-Cookie", `mimo_panel=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}`);
    return json(res, 200, { ok: true, mustChangePassword: s.panelPasswordSet === false });
  }

  if (p === "/api/logout") {
    GUI.dropSession(sid);
    res.setHeader("Set-Cookie", "mimo_panel=; Path=/; HttpOnly; Max-Age=0");
    return json(res, 200, { ok: true });
  }

  if (p === "/api/session") {
    const ok = GUI.checkSession(sid);
    const s = GUI.loadSettings();
    return json(res, 200, { ok, mustChangePassword: ok && s.panelPasswordSet === false });
  }

  // ---- 以下都要登录 ----
  if (!GUI.checkSession(sid)) return json(res, 401, { ok: false, error: "未登录" });

  if (p === "/api/stats") {
    const up = UP;
    const sa = STANDALONE_UP;
    const active = sa || up;
    return json(res, 200, {
      ok: true,
      service: "mimo-api-proxy",
      pid: process.pid,
      port: CFG.listenPort,
      upstream: sa ? "cloud://mimo-server-cn.xiaomimimo.com" : (up?.base ?? null),
      upstreamReady: !!active?.models,
      upstreamSource: sa ? "standalone" : (up?.source ?? null),
      models: active?.models ? exposedModels(active.models) : [],
      usage: GUI.getSummary(),
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      keyCount: GUI.listKeys().length,
      autoStart: CFG.autoStart,
      warmup: !!CFG.warmup,
      maxOutputTokens: CFG.maxOutputTokens,
      // 免桌面端状态
      mode: CFG.mode,
      standaloneActive: !!sa,
      standaloneSession: sa ? {
        userId: sa.session?.userId ?? null,
        cookieCount: Object.keys(sa.session?.jar || {}).length,
        at: sa.session?.at ?? null,
        credSource: sa.credSource ?? null
      } : null,
      // 账号池状态（对标 wb-proxy 的 accounts/credits 面板数据）
      pool: {
        size: ACCOUNTS.getPool({ log }).count(),
        ready: ACCOUNTS.getPool({ log }).countReady(),
        rotateOn429: CFG.poolRotateOn429 !== false,
        keepaliveHours: CFG.poolKeepaliveHours ?? 0
      },
      // 云端限流冷却状态
      cloudCooldownUntil: CLOUD_LIMIT.until > Date.now() ? new Date(CLOUD_LIMIT.until).toISOString() : null,
      cloudCooldownSec: Math.ceil(cloudCooldownRemainingMs() / 1000),
      cloudCooldownReason: CLOUD_LIMIT.until > Date.now() ? CLOUD_LIMIT.reason : "",
      cloudCooldownWaiters: CLOUD_LIMIT.waiters
    });
  }

  /* ---------------- 账号池 API（对标 wb-proxy 的 /accounts/* 全家桶） ---------------- */

  if (p === "/api/accounts" && req.method === "GET") {
    const pool = ACCOUNTS.getPool({ log });
    return json(res, 200, {
      ok: true,
      accounts: pool.listPublic(),
      ready: pool.countReady(),
      size: pool.count()
    });
  }

  if (p === "/api/accounts/add-password" && req.method === "POST") {
    const pool = ACCOUNTS.getPool({ log });
    const r = await pool.loginWithPassword(String(body.user || ""), String(body.password || ""), { log });
    return json(res, r.ok ? 200 : 400, { ok: r.ok, account: r.acc?.public() ?? null, error: r.error ?? null, kind: r.kind ?? null });
  }

  if (p === "/api/accounts/add-manual" && req.method === "POST") {
    const pool = ACCOUNTS.getPool({ log });
    const r = await pool.importManual({
      userId: body.userId, passToken: body.passToken, cUserId: body.cUserId, nickname: body.nickname
    }, { log });
    return json(res, r.ok ? 200 : 400, { ok: r.ok, account: r.acc?.public() ?? null, error: r.error ?? null });
  }

  if (p === "/api/accounts/import-desktop" && req.method === "POST") {
    const pool = ACCOUNTS.getPool({ log });
    const r = await pool.importFromDesktop({ log });
    return json(res, r.ok ? 200 : 400, { ...r });
  }

  if (p === "/api/accounts/refresh" && req.method === "POST") {
    const pool = ACCOUNTS.getPool({ log });
    const targets = body.uid ? [pool.get(body.uid)].filter(Boolean) : pool.list().filter((a) => a.enabled);
    if (!targets.length) return json(res, 404, { ok: false, error: "账号不存在或池为空" });
    const results = [];
    for (const acc of targets) {
      const r = await pool.rederive(acc, { log });
      results.push({ uid: acc.uid, ok: r.ok, error: r.error ?? null });
    }
    return json(res, 200, { ok: results.every((r) => r.ok), results });
  }

  if (p === "/api/accounts/test" && req.method === "POST") {
    const pool = ACCOUNTS.getPool({ log });
    const acc = pool.get(body.uid);
    if (!acc) return json(res, 404, { ok: false, error: "账号不存在" });
    const t0 = Date.now();
    try {
      const ensured = await pool.ensureUsable(acc, { force: true, checkIntervalMs: 0, log });
      if (!ensured.ok) return json(res, 200, { ok: false, error: ensured.error, latencyMs: Date.now() - t0 });
      const r = await STANDALONE.cloudChat(acc, {
        model: (dynamicModelIds()[0] || STANDALONE.STANDALONE_MODELS[0] || "mimo-v2.6-flash").replace(/^xiaomi\//, ""),
        messages: [{ role: "user", content: "只回复：OK" }],
        max_tokens: 32
      }, { signal: AbortSignal.timeout(60000) });
      const txt = await r.text();
      let content = null;
      try { content = JSON.parse(txt).choices?.[0]?.message?.content ?? null; } catch {}
      if (r.ok) pool.noteSuccess(acc.uid);
      return json(res, 200, { ok: r.ok, status: r.status, content, latencyMs: Date.now() - t0, error: r.ok ? null : txt.slice(0, 200) });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e?.message || e).slice(0, 200), latencyMs: Date.now() - t0 });
    }
  }

  if (p === "/api/accounts/set" && req.method === "POST") {
    const acc = ACCOUNTS.getPool({ log }).setNickname(body.uid, body.nickname);
    return acc ? json(res, 200, { ok: true, account: acc.public() }) : json(res, 404, { ok: false, error: "账号不存在" });
  }

  if (p === "/api/accounts/enabled" && req.method === "POST") {
    const acc = ACCOUNTS.getPool({ log }).setEnabled(body.uid, body.enabled !== false);
    return acc ? json(res, 200, { ok: true, account: acc.public() }) : json(res, 404, { ok: false, error: "账号不存在" });
  }

  if (p === "/api/accounts/enabled-all" && req.method === "POST") {
    ACCOUNTS.getPool({ log }).setAllEnabled(body.enabled !== false);
    return json(res, 200, { ok: true });
  }

  if (p === "/api/accounts/delete" && req.method === "POST") {
    return json(res, 200, { ok: ACCOUNTS.getPool({ log }).remove(body.uid) });
  }

  if (p === "/api/accounts/export" && req.method === "GET") {
    const doc = ACCOUNTS.getPool({ log }).exportDocument();
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="mimo-accounts-${new Date().toISOString().slice(0, 10)}.json"`
    });
    return res.end(JSON.stringify(doc, null, 2));
  }

  if (p === "/api/accounts/import" && req.method === "POST") {
    const pool = ACCOUNTS.getPool({ log });
    const r = await pool.importDocument(body.json ?? body, { log });
    return json(res, 200, { ok: (r.added?.length ?? 0) > 0, ...r });
  }

  if (p === "/api/usage/by-account" && req.method === "GET") {
    // 按账号聚合最近用量（wb-proxy 的 /usage/by-account 对标）
    const rows = GUI.readRecentUsage(Math.min(2000, Number(url.searchParams.get("limit") || 500)));
    const byAccount = new Map();
    for (const row of rows) {
      const key = row.accountUid || row.account || "-";
      if (!byAccount.has(key)) byAccount.set(key, { account: row.account || "-", accountUid: row.accountUid || null, requests: 0, ok: 0, fail: 0, tokensIn: 0, tokensOut: 0, lastAt: null });
      const agg = byAccount.get(key);
      agg.requests++;
      if (row.ok) agg.ok++; else agg.fail++;
      agg.tokensIn += row.promptTokens || 0;
      agg.tokensOut += row.completionTokens || 0;
      if (row.at && (!agg.lastAt || row.at > agg.lastAt)) agg.lastAt = row.at;
    }
    return json(res, 200, { ok: true, rows: [...byAccount.values()].sort((a, b) => b.requests - a.requests) });
  }

  if (p === "/api/standalone/login" && req.method === "POST") {
    try {
      STANDALONE.clearSession();
      STANDALONE.invalidateCredentialsCache();   // 用户点登录 = 想要最新的凭据
      STANDALONE_UP = null;
      // 看板手动登录不受自动登录节流限制（用户点了按钮就是要现在登）
      const up = await resolveStandalone({ force: true, ignoreThrottle: true });
      UP = null;
      return json(res, 200, {
        ok: true,
        models: up.models,
        userId: up.session?.userId,
        cookieCount: Object.keys(up.session?.jar || {}).length,
        credSource: up.credSource ?? null
      });
    } catch (e) {
      return json(res, 500, {
        ok: false,
        error: String(e?.message || e),
        kind: e?.kind ?? null,
        retryAfterMs: e?.retryAfterMs ?? null
      });
    }
  }

  if (p === "/api/standalone/logout" && req.method === "POST") {
    STANDALONE.clearSession();
    STANDALONE_UP = null;
    return json(res, 200, { ok: true });
  }

  if (p === "/api/standalone/status") {
    const creds = STANDALONE.credentialStatus();
    const cached = STANDALONE.loadSession();
    const cachedCreds = STANDALONE.loadCachedCredentials();
    return json(res, 200, {
      ok: true,
      mode: CFG.mode,
      credentials: {
        found: creds.ok,
        source: creds.source ?? null,
        userId: creds.userId ?? null,
        hasPassToken: creds.ok,
        scanning: creds.scanning,
        cachedAt: creds.cachedAt,
        error: creds.ok ? null : "尚未扫描或未找到凭据"
      },
      // 本机所有可能的凭据来源扫描（对齐 wb-proxy 的 scan_desktop_credentials）
      sources: STANDALONE.listCredentialSources(),
      durableCredentials: cachedCreds ? {
        userId: cachedCreds.userId,
        source: cachedCreds.source,
        at: cachedCreds.at,
        note: "长效 passToken 缓存（登录一次后不再依赖桌面端 cookie 库）"
      } : null,
      session: cached ? {
        at: cached.at,
        userId: cached.userId,
        cookieCount: Object.keys(cached.jar || {}).length,
        cookies: Object.keys(cached.jar || {})
      } : null,
      active: !!STANDALONE_UP
    });
  }

  if (p === "/api/standalone/refresh-credentials" && req.method === "POST") {
    try {
      const creds = await STANDALONE.extractSsoCredentials({ force: true });
      return json(res, 200, {
        ok: true,
        credentials: {
          found: !!creds.ok,
          source: creds.source ?? null,
          userId: creds.userId ?? null,
          hasPassToken: !!creds.passToken,
          error: creds.ok ? null : creds.reason
        }
      });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message || error) });
    }
  }

  if (p === "/api/models") {
    const active = STANDALONE_UP || UP;
    const all = active?.models ? exposedModels(active.models) : dynamicModelIds();
    return json(res, 200, {
      ok: true,
      mode: STANDALONE_UP ? "standalone" : "engine",
      source: STANDALONE_UP
        ? `desktop-catalog（${DYNAMIC_CATALOG_HASH}；目录变化会自动刷新）`
        : "live-engine（实时读取本地引擎 /v1/models）",
      models: all.map((id) => ({
        id,
        alias: ["mimo-flash", "mimo-pro"].filter((alias) => resolveModelAlias(alias) === id)
          .concat(Object.entries(CFG.aliases).filter(([, v]) => v === id).map(([k]) => k)),
        maxOutput: maxOutputFor(id),
        reasoningEffort: reasoningEffortSupported(id),
        capability: capabilityFor(id),
        learned: {
          noReasoningEffort: !!LEARNED.noReasoningEffort[id],
          maxOutput: LEARNED.maxOutput[id] ?? null
        },
        note: id.endsWith("-preview") ? "免费 · 思考默认开启 · 不支持 reasoning_effort" : ""
      })),
      defaultMaxOutput: CFG.maxOutputTokens
    });
  }

  if (p === "/api/models/capabilities" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      catalog: { file: DESKTOP_CATALOG_FILE, hash: DYNAMIC_CATALOG_HASH, mtimeMs: DESKTOP_CATALOG.mtimeMs, autoDeepProbe: CFG.autoDeepProbe !== false },
      models: dynamicModelIds().map((id) => capabilityFor(id))
    });
  }

  if (p === "/api/models/probe" && req.method === "POST") {
    const model = resolveModelAlias(String(body.model || ""));
    if (!model || !dynamicModelIds().includes(model)) return json(res, 404, { ok: false, error: "模型不在当前动态目录中" });
    try {
      const result = await probeModelCapability(model, { deep: true });
      return json(res, 200, { ok: true, result });
    } catch (error) {
      return json(res, 502, { ok: false, error: String(error?.message || error) });
    }
  }

  if (p === "/api/usage") {
    const limit = Math.min(1000, Number(url.searchParams.get("limit") || 200));
    return json(res, 200, { ok: true, rows: GUI.readRecentUsage(limit), summary: GUI.getSummary() });
  }

  if (p === "/api/quota" && req.method === "GET") {
    const [exact, free] = await Promise.all([QUOTA.get(), FREE_USAGE.get().catch(() => null)]);
    return json(res, 200, { ok: true, quota: quotaPayload(exact, free) });
  }

  if (p === "/api/quota/refresh" && req.method === "POST") {
    const [quota, free] = await Promise.all([QUOTA.get({ force: true }), FREE_USAGE.get({ force: true }).catch(() => null)]);
    logQuotaStatus(quota);
    return json(res, 200, { ok: true, quota: quotaPayload(quota, free) });
  }

  /** 看板「登录开放平台」：粘贴浏览器里的 Cookie → 校验 → 存档 → 立即刷新额度 */
  if (p === "/api/platform/cookie" && req.method === "POST") {
    const raw = String(body.cookie || "").trim();
    const parsed = parsePlatformCookieHeader(raw);
    if (!parsed) {
      return json(res, 400, {
        ok: false,
        error: "Cookie 里缺少 api-platform_serviceToken 或 userId。请在已登录 platform.xiaomimimo.com 的浏览器里，从 devtools → Application/网络请求 复制 Cookie（至少包含 api-platform_serviceToken 和 userId 两项，直接粘贴整段 Cookie 头也可以）。"
      });
    }
    GUI.savePlatformCookie(parsed);
    QUOTA.invalidate();
    lastPlatformCookieSource = "manual";
    lastPlatformDeriveError = null;
    const quota = await QUOTA.get({ force: true });
    logQuotaStatus(quota);
    return json(res, 200, { ok: quota.state === "available", state: quota.state, quota: quotaPayload(quota), error: quota.state === "available" ? null : (quota.reason || `开放平台返回状态 ${quota.state}（Cookie 已存档，若账号未开通开放平台请先在网页端完成开通）`) });
  }

  if (p === "/api/platform/cookie" && req.method === "DELETE") {
    GUI.clearPlatformCookie();
    QUOTA.invalidate();
    lastPlatformCookieSource = null;
    return json(res, 200, { ok: true });
  }

  /**
   * 看板自己发一次真实请求做「测试」。
   * 走服务端内部调用，不经过 API Key 校验 ——
   * 否则面板没配 Key（或配了 Key）时前端直连 /v1 会永远 401。
   */
  if (p === "/api/test" && req.method === "POST") {
    const model = String(body.model || dynamicModelIds()[0] || "xiaomi/mimo-v2.6-flash");
    const prompt = String(body.prompt || "只回复：OK");
    const t0 = Date.now();
    const logRec = (ok, status, err) => GUI.recordUsage({
      at: new Date().toISOString(), model, stream: false, keyName: "(看板测试)",
      messages: 1, tools: 0, ok, status,
      promptTokens: 0, completionTokens: 0,
      error: err || null, latencyMs: Date.now() - t0
    });
    try {
      const up = await resolveUpstream();
      let r, mode;
      if (up.mode === "standalone") {
        mode = "standalone";
        const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
        r = await STANDALONE.cloudChat(up.session, {
          model: bare, messages: [{ role: "user", content: prompt }], max_tokens: 64
        }, { signal: AbortSignal.timeout(120000) });
      } else {
        mode = "engine";
        r = await fetch(`${up.base}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.token}` },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 64 }),
          signal: AbortSignal.timeout(120000)
        });
      }
      const txt = await r.text();
      let content = null;
      try { content = JSON.parse(txt).choices?.[0]?.message?.content ?? null; } catch {}
      logRec(r.ok, r.status, r.ok ? null : txt.slice(0, 200));
      return json(res, 200, {
        ok: r.ok, mode, status: r.status,
        latencyMs: Date.now() - t0, content,
        error: r.ok ? null : txt.slice(0, 300)
      });
    } catch (e) {
      const msg = String(e?.message || e);
      logRec(false, 0, msg.slice(0, 200));
      return json(res, 200, { ok: false, error: msg.slice(0, 300), latencyMs: Date.now() - t0 });
    }
  }

  /** 切换运行模式：写回 config.json 并热生效（不需要重启进程） */
  if (p === "/api/mode" && req.method === "POST") {
    const next = String(body.mode || "").trim();
    if (!["auto", "standalone", "engine"].includes(next)) {
      return json(res, 400, { ok: false, error: "mode 必须是 auto / standalone / engine" });
    }
    try {
      const cfgPath = path.join(HERE, "config.json");
      let cfg = {};
      const loaded = loadJsonFile(cfgPath, { missingValue: {}, label: "proxy config" });
      cfg = loaded.value;
      cfg.mode = next;
      writeJsonAtomic(cfgPath, cfg);
      // 热生效
      CFG.mode = next;
      UP = null;
      STANDALONE_UP = null;
      let ready = false, models = 0, err = null;
      try {
        const up = await resolveUpstream({ force: true });
        ready = true;
        models = exposedModels(up.models).length;
      } catch (e) { err = String(e?.message || e).slice(0, 200); }
      return json(res, 200, { ok: true, mode: next, ready, models, error: err });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (p === "/api/usage/reset" && req.method === "POST") {
    GUI.resetUsage();
    return json(res, 200, { ok: true });  }

  if (p === "/api/keys" && req.method === "GET") {
    return json(res, 200, { ok: true, keys: GUI.listKeys() });
  }

  if (p === "/api/keys/add" && req.method === "POST") {
    const rec = GUI.addKey(body.name, body.note);
    return json(res, 200, { ok: true, key: { ...rec, masked: rec.key.slice(0, 12) + "…" } });
  }

  if (p === "/api/keys/reveal" && req.method === "POST") {
    const k = GUI.revealKey(body.id);
    return k ? json(res, 200, { ok: true, key: k }) : json(res, 404, { ok: false, error: "不存在" });
  }

  if (p === "/api/keys/toggle" && req.method === "POST") {
    return json(res, 200, { ok: GUI.toggleKey(body.id, body.enabled) });
  }

  if (p === "/api/keys/remove" && req.method === "POST") {
    return json(res, 200, { ok: GUI.removeKey(body.id) });
  }

  if (p === "/api/password" && req.method === "POST") {
    const pw = String(body.password || "");
    if (pw.length < 4) return json(res, 400, { ok: false, error: "密码至少 4 位" });
    GUI.setPanelPassword(pw);
    return json(res, 200, { ok: true });
  }

  if (p === "/api/upstream/restart" && req.method === "POST") {
    try {
      const up = await resolveUpstream({ force: true });
      return json(res, 200, { ok: true, upstream: up.base, models: exposedModels(up.models) });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (p === "/api/upstream/warmup" && req.method === "POST") {
    warmup();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { ok: false, error: `未知 API: ${p}` });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }
  cors(res);

  /* ---------------- 看板 API（走面板密码，不走 API Key） ---------------- */
  if (p.startsWith("/api/") || p === "/" || p === "/dashboard") {
    return handleGui(req, res, url, p);
  }

  // 秒回的存活探测：不碰上游，health 检查专用
  if (p === "/ping") {
    return json(res, 200, {
      service: "mimo-api-proxy",
      ok: true,
      pid: process.pid,
      port: CFG.listenPort,
      auth_required: apiAuthRequired()
    });
  }

  if (p === "/" || p === "/health" || p === "/healthz") {
    // 默认不阻塞、无副作用；?deep=1 才真的去解析上游（可能触发自动拉起应用）
    if (url.searchParams.get("deep") === "1") {
      try { await resolveUpstream(); } catch {}
    }
    const up = UP || STANDALONE_UP;
    const ready = !!(up && up.models);
    return json(res, ready ? 200 : 503, {
      ok: ready,
      service: "mimo-api-proxy",
      mode: CFG.mode,
      active_mode: up?.mode === "standalone" ? "standalone" : (up ? "engine" : null),
      upstream: up?.mode === "standalone" ? "cloud://mimo-server-cn.xiaomimimo.com (免桌面端)" : (up?.base ?? null),
      upstream_error: ready ? null : "上游尚未就绪",
      models: up?.models ? exposedModels(up.models) : [],
      auth_required: apiAuthRequired()
    });
  }

  if (!clientAuthorized(req)) {
    return json(res, 401, { error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" } });
  }

  try {
    if (req.method === "GET" && (p === "/v1/models" || p === "/models")) return await handleModels(req, res);

    if (req.method === "POST" && (p === "/v1/chat/completions" || p === "/chat/completions")) {
      const raw = await readBody(req);
      if (CFG.logRequests) {
        let m = "?";
        try { m = JSON.parse(raw.toString("utf8")).model; } catch {}
        log(`${req.method} ${p} model=${m}`);
      }
      return await handleChat(req, res, raw);
    }

    // 显式不支持：让客户端早点报错，不要静默拿到错误形状
    return json(res, 404, {
      error: {
        message: `Unknown route ${p}. Supported: GET /v1/models, POST /v1/chat/completions`,
        type: "invalid_request_error"
      }
    });
  } catch (e) {
    const msg = String(e?.message || e);
    warn("代理错误:", msg);
    if (!res.headersSent) {
      const status = e instanceof HttpInputError ? e.status : 502;
      json(res, status, { error: { message: msg, type: e instanceof HttpInputError ? "invalid_request_error" : "api_error", code: e.code } });
    }
    else try { res.end(); } catch {}
  }
});

const modelCatalogPoll = setInterval(() => {
  try { refreshDynamicModelCatalog(STANDALONE_UP?.models || []); } catch (error) { warn("模型目录刷新失败:", String(error?.message || error)); }
}, Number(CFG.modelCatalogPollMs || 30000));
modelCatalogPoll.unref?.();

/* ------------------------------------------------------------------ *
 * 连接层调优 —— 解决「每次任务前都要重连几次」以及长流被掐断
 *
 * 1) keepAliveTimeout：默认 5000ms，空闲 5 秒即由服务端单向断开，
 *    客户端连接池不知情 → 下次复用撞 ECONNRESET → 只能重连重发。
 *    agent 一次「工具调用 → 下一步」之间的空闲远超 5 秒，必然踩中。
 *    实测：gap=7s/15s/30s 时同一条 TCP 连接上的第二个请求全部失败。
 * 2) headersTimeout 必须严格大于 keepAliveTimeout（Node 的要求），
 *    否则连接会比 keep-alive 窗口更早被掐掉。
 * 3) requestTimeout = 0：不限制单个请求的总时长。长思考 / 长流式输出
 *    实测有 292s 的请求，默认 300s 的 requestTimeout 会把长任务打断。
 * 4) setNoDelay：关掉 Nagle，让 SSE 小块立即下发，首字更快。
 * ------------------------------------------------------------------ */
server.keepAliveTimeout = KEEP_ALIVE_MS;
server.headersTimeout = KEEP_ALIVE_MS + 30000;
server.requestTimeout = Number(CFG.requestTimeoutMs ?? 0);
server.timeout = 0;
server.on("connection", (sock) => {
  try { sock.setNoDelay(true); } catch {}
});

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

function probeHost() {
  return CFG.listenHost === "0.0.0.0" || CFG.listenHost === "::" ? "127.0.0.1" : CFG.listenHost;
}

/** 端口上是不是已经有一个本代理在跑？（用秒回的 /ping，绝不阻塞） */
async function alreadyRunning() {
  try {
    const r = await fetch(`http://${probeHost()}:${CFG.listenPort}/ping`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json().catch(() => null);
    return j && j.service === "mimo-api-proxy" ? j : null;
  } catch {
    return null;
  }
}

function printReady(extra = "") {
  const shown = CFG.listenHost === "0.0.0.0" ? "<本机局域网IP>" : CFG.listenHost;
  log("============================================================");
  log(`  Base URL  : http://${shown}:${CFG.listenPort}/v1`);
  log(`  Web 看板  : http://${shown}:${CFG.listenPort}/`);
  const guiKeys = GUI.listKeys().filter((k) => k.enabled);
  if (CFG.apiKeys.length) log(`  API Key   : config.json 中已配置 ${CFG.apiKeys.length} 个（内容不显示）`);
  else if (guiKeys.length) log(`  API Key   : 看板里管理了 ${guiKeys.length} 个（${guiKeys.map((k) => k.name).join(", ")}）`);
  else log("  API Key   : (未设置，本机可直接调用)");
  log("------------------------------------------------------------");
  log("  可用模型（模型目录会自动刷新，也支持短别名 mimo-pro / mimo-flash）:");
  for (const id of (dynamicModelIds().length ? dynamicModelIds() : ["xiaomi/mimo-v2.6-pro", "xiaomi/mimo-v2.6-flash"])) log(`    ${id}`);
  log("============================================================");
  log("  看板默认密码 admin（首次登录后请到「设置」修改）");
  log("  完整说明见同目录 使用说明.md ；自检：node test.mjs");
  if (extra) log(extra);
}

async function main() {
  // 初始化看板密码（首次启动默认 admin，与 wb-proxy 一致）
  const pw = GUI.ensurePanelPassword(CFG.panelPassword || undefined);
  validateExposurePolicy({ host: CFG.listenHost, panelPasswordSet: pw.settings.panelPasswordSet });

  const existing = await alreadyRunning();
  if (existing) {
    log(`端口 ${CFG.listenPort} 上已经有一个 mimo-api-proxy 在运行了（pid ${existing.pid ?? "?"}），无需重复启动。`);
    printReady();
    log("它已经在正常工作，直接按上面的地址调用即可。");
    process.exit(0);
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(CFG.listenPort, CFG.listenHost, () => {
      server.removeListener("error", reject);
      resolve();
    });
  }).catch(async (e) => {
    if (e && e.code === "EADDRINUSE") {
      const again = await alreadyRunning();
      if (again) {
        log(`端口 ${CFG.listenPort} 已被另一个 mimo-api-proxy 占用（pid ${again.pid ?? "?"}），它正在正常工作，本次启动跳过。`);
        printReady();
        process.exit(0);
      }
      warn(`端口 ${CFG.listenPort} 被别的程序占用了。`);
      warn("改 config.json 里的 listenPort（例如 8790），或关掉占用该端口的程序，然后重试。");
      process.exit(2);
    }
    throw e;
  });

  printReady();
  QUOTA.get().then(logQuotaStatus).catch((error) => warn("额度查询失败:", String(error?.message || error)));

  // ---- 账号池：旧登录态迁移 + 保活定时器 ----
  await migrateLegacyToPool();
  schedulePoolKeepalive();

  if (pw.created) {
    log(`[看板] 已初始化面板密码：${pw.defaultPassword ? pw.defaultPassword + "（默认，请尽快修改）" : "（使用 --panel-password 指定）"}`);
  }
  log(`[看板] 访问 http://${CFG.listenHost === "0.0.0.0" ? "127.0.0.1" : CFG.listenHost}:${CFG.listenPort}/ 管理 Key 与查看用量`);

  try {
    const up = await resolveUpstream();
    if (up.mode === "standalone") {
      log("运行模式: 免桌面端（直连云端免费通道，不需要 MiMo 桌面端）");
      log(`可用模型: ${exposedModels(up.models).join(", ")}`);
    } else {
      log(`上游引擎就绪: ${up.base}`);
    }
    warmup();
    scheduleModelCapabilityProbe();
  } catch (e) {
    warn(`上游还没就绪: ${String(e?.message || e)}`);
    warn("首次调用时会自动重试 / 自动拉起 MiMo 桌面版");
  }
}

/**
 * 旧登录态 → 账号池迁移（只跑一次，池非空就跳过）。
 * 有现成的可用会话文件就直接沿用（免打 passport），否则用长效凭据现派生。
 */
async function migrateLegacyToPool() {
  const pool = ACCOUNTS.getPool({ log });
  if (pool.count() > 0) return;
  try {
    const creds = await STANDALONE.extractSsoCredentials();
    if (!creds?.ok || !creds.passToken) return;
    await pool.addAccount({
      userId: creds.userId, passToken: creds.passToken,
      cUserId: creds.cUserId || "", nickname: creds.userId, source: "legacy"
    }, { log, adoptSession: STANDALONE.loadSession() });
    log(`[账号池] 已把既有登录态迁移为账号池账号（${creds.userId}）；之后可在看板添加更多账号`);
  } catch (e) {
    warn(`[账号池] 旧登录态迁移失败（不影响启动）: ${String(e?.message || e).slice(0, 120)}`);
  }
}

/** 账号池保活定时器：定期校验全部账号会话，死会话静默重派生（wb-proxy scheduler 的对标） */
function schedulePoolKeepalive() {
  const hours = Number(CFG.poolKeepaliveHours || 0);
  if (!(hours > 0)) return;
  const tick = async () => {
    try {
      const pool = ACCOUNTS.getPool({ log });
      if (pool.count() > 0) await pool.keepalive({ log });
    } catch (e) {
      warn(`[账号池] 保活失败: ${String(e?.message || e).slice(0, 120)}`);
    }
  };
  // 启动 1 分钟后先跑一次轻量校验，之后按周期执行
  setTimeout(tick, 60 * 1000).unref?.();
  setInterval(tick, hours * 3600 * 1000).unref?.();
}

server.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") return; // 已在 main() 里友好处理
  warn("服务出错:", String(e?.message || e));
});

/* ------------------------------------------------------------------ *
 * 进程级兜底
 *
 * Node 15+ 默认 unhandledRejection = throw → 直接杀掉进程。
 * 本进程里有大量「即发即忘」的异步（warmup、看板侧的后台任务、
 * 各处 .catch 漏网的路径），任意一处漏掉 rejection 都会让整个代理
 * 静默退出 —— 表现就是「用着用着就连不上了，得重启」。
 *
 * 这里兜住并记账，不让它宕机；但明确打日志，方便定位真正的问题。
 * ------------------------------------------------------------------ */

let softErrors = 0;
const SOFT_ERROR_LOG_MAX = 20;

process.on("unhandledRejection", (reason) => {
  softErrors++;
  if (softErrors <= SOFT_ERROR_LOG_MAX) {
    warn("未处理的 Promise rejection（已忽略，代理继续运行）:", String(reason?.stack || reason?.message || reason).slice(0, 500));
  } else if (softErrors === SOFT_ERROR_LOG_MAX + 1) {
    warn(`未处理的 rejection 已超过 ${SOFT_ERROR_LOG_MAX} 次，后续同类日志折叠`);
  }
});

process.on("uncaughtException", (err) => {
  softErrors++;
  warn("未捕获异常（已忽略，代理继续运行）:", String(err?.stack || err?.message || err).slice(0, 500));
});

// 客户端中途断开是**正常**的（agent 超时、用户关页面），
// 但 socket 层会把它抛成 ECONNRESET —— 不处理会变成 uncaughtException。
server.on("clientError", (err, socket) => {
  if (err && (err.code === "ECONNRESET" || err.code === "EPIPE")) {
    try { socket.destroy(); } catch {}
    return;
  }
  try { if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch {}
});

main().catch((e) => {
  warn("启动失败:", String(e?.message || e));
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log("退出");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
