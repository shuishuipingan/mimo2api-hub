/**
 * mimo-accounts.mjs — 小米账号池（对标 wb-proxy 的 wb_accounts.py）
 *
 * 功能面：
 *   - 多账号管理：每个账号一个 JSON（accounts/pool/<uid>.json，0600）
 *   - 添加方式：桌面端一键导入 / 手动凭据导入（userId+passToken）/ 账号密码登录
 *   - 轮询调度：round-robin 挑选就绪账号（enabled + 未冷却 + 有长效凭据）
 *   - 会话亲和：同一 API Key 的请求固定用同一账号（TTL 2h，上下文连续性）
 *   - 按账号冷却：429 只冷却肇事的那个账号（解析「请约 N 秒后重试」），
 *     其余账号继续服务 —— 单账号限流不再黑洞整个代理
 *   - 会话自愈：会话失效 → 用池里的 passToken 静默重派生；passToken 本身
 *     失效（被 passport 弹回登录页）→ 标记账号待重新登录，长冷却
 *   - 导出/导入：自描述 JSON 文档，账号池可跨机迁移/备份
 *   - 保活：定期校验全部账号会话（免费 GET），死会话静默重派生
 *
 * 登录方式说明（实测 2026-09）：
 *   小米已将账号密码直连接口（/pass/serviceLoginAuth2）整体切换到
 *   account.xiaomi.com/fe/service/login 新前端（AES 加密提交 + 风控），
 *   legacy 端点一律 302 → HTML。本模块仍实现经典流程并在运行时探测端点
 *   可用性：返回 JSON 就走通，返回 HTML 就给出明确指引（用桌面端导入 /
 *   手动凭据导入）。passToken 是账号级长效凭据，两种导入方式都是
 *   「一次操作，长期有效」。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./mimo-runtime.mjs";
import * as STANDALONE from "./mimo-standalone.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 池目录可用 MIMO_POOL_DIR 覆盖（测试隔离用），默认 accounts/pool */
export const POOL_DIR = process.env.MIMO_POOL_DIR
  ? path.resolve(process.env.MIMO_POOL_DIR)
  : path.join(HERE, "accounts", "pool");
fs.mkdirSync(POOL_DIR, { recursive: true });

const CLOUD_BASE = "https://mimo-server-cn.xiaomimimo.com";
const LOGIN_UA = "MiClaw/1.0";
/** passToken 被判定失效后，该账号的冷却时长（避免每请求都去撞 passport） */
const DEAD_CRED_COOLDOWN_MS = 6 * 3600 * 1000;
/** 会话派生失败的普通冷却（网络抖动等，可较快重试） */
const DERIVE_FAIL_COOLDOWN_MS = 60 * 1000;
/** 亲和表默认 TTL（wb-proxy 同款 2h） */
const AFFINITY_TTL_MS = 2 * 3600 * 1000;
const AFFINITY_MAX = 5000;

export const EXPORT_FORMAT = "mimo-accounts";
export const EXPORT_VERSION = 1;

/* ------------------------------------------------------------------ *
 * 账号对象
 * ------------------------------------------------------------------ */

export class Account {
  constructor(data, filePath = null) {
    data = data || {};
    this.path = filePath;
    // 归属目录：加载既有文件用文件所在目录；池新建时由 AccountPool 注入 this.dir。
    // 没有归属就落到默认 POOL_DIR。
    this.dir = data.dir || (filePath ? path.dirname(filePath) : null);
    this.uid = String(data.uid || data.userId || "").trim();
    this.nickname = String(data.nickname || "").trim();
    this.enabled = data.enabled !== false;
    this.source = String(data.source || "manual"); // password | manual | desktop | import | legacy
    this.passToken = String(data.passToken || "");
    this.cUserId = String(data.cUserId || "");
    this.jar = data.jar || {};            // 最近一次派生的 mimo 会话 cookie（名→值）
    this.cookie = String(data.cookie || "");
    this.sessionAt = data.sessionAt || 0;
    this.checkedAt = data.checkedAt || 0;
    this.addedAt = data.addedAt || Date.now();
    this.lastUsedAt = data.lastUsedAt || 0;
    this.lastError = String(data.lastError || "");
    this.cooldownUntil = data.cooldownUntil || 0;
  }

  toDict() {
    return {
      uid: this.uid, nickname: this.nickname, enabled: this.enabled,
      source: this.source, passToken: this.passToken, cUserId: this.cUserId,
      jar: this.jar, cookie: this.cookie, sessionAt: this.sessionAt,
      checkedAt: this.checkedAt, addedAt: this.addedAt, lastUsedAt: this.lastUsedAt,
      lastError: this.lastError, cooldownUntil: this.cooldownUntil
    };
  }

  /** 对外展示：绝不带 passToken / cookie */
  public(now = Date.now()) {
    return {
      uid: this.uid,
      nickname: this.nickname || this.uid,
      enabled: this.enabled,
      source: this.source,
      hasPassToken: !!this.passToken,
      hasSession: !!this.cookie,
      sessionAt: this.sessionAt || null,
      addedAt: this.addedAt,
      lastUsedAt: this.lastUsedAt || null,
      lastError: this.lastError || null,
      inCooldown: this.cooldownUntil > now,
      cooldownForSec: this.cooldownUntil > now ? Math.ceil((this.cooldownUntil - now) / 1000) : null,
      ready: this.enabled && !!this.passToken && this.cooldownUntil <= now
    };
  }

  save() {
    const safe = String(this.uid || "").replace(/[^A-Za-z0-9_-]/g, "_") || crypto.randomUUID();
    const file = path.join(this.dir || POOL_DIR, `${safe}.json`);
    writeJsonAtomic(file, this.toDict());
    this.path = file;
    return this;
  }

  delete() {
    if (this.path) { try { fs.unlinkSync(this.path); } catch {} }
  }
}

/* ------------------------------------------------------------------ *
 * 账号池
 * ------------------------------------------------------------------ */

export class AccountPool {
  constructor({ log = () => {}, now = Date.now, derive, validate, dir } = {}) {
    this.dir = dir || POOL_DIR;
    this.accounts = [];
    this.log = log;
    this.now = now;
    this._cursor = 0;
    this._affinity = new Map(); // sessionKey -> { uid, exp }
    // 可注入的派生/校验函数（测试用）；默认走 STANDALONE 真实现
    this._derive = derive || ((creds) => STANDALONE.loginMimoSession(creds));
    this._validate = validate || ((session) => STANDALONE.validateSession(session));
    this._deriveInflight = new Map(); // uid -> Promise（同一账号并发派生合并）
  }

  /* ---- 载入/存取 ---- */

  load() {
    this.accounts = [];
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return this.accounts; }
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.dir, name);
      try {
        const acc = new Account(JSON.parse(fs.readFileSync(file, "utf8")), file);
        if (acc.uid && acc.passToken) this.accounts.push(acc);
      } catch (e) {
        this.log(`[账号池] ${name} 读取失败: ${String(e?.message || e)}`);
      }
    }
    return this.accounts;
  }

  get(uid) {
    return this.accounts.find((a) => a.uid === String(uid)) || null;
  }

  list() { return [...this.accounts]; }
  listPublic() { const now = this.now(); return this.accounts.map((a) => a.public(now)); }
  count() { return this.accounts.length; }
  countReady() { const now = this.now(); return this.accounts.filter((a) => a.enabled && !!a.passToken && a.cooldownUntil <= now).length; }
  nextReadyMs() {
    const now = this.now();
    const times = this.accounts.filter((a) => a.enabled && a.passToken).map((a) => a.cooldownUntil).filter((t) => t > now);
    return times.length ? Math.min(...times) - now : 0;
  }

  /** 添加/更新账号（按 uid 去重；保留已存在的 addedAt）。成功返回账号。 */
  async addAccount({ userId, passToken, cUserId = "", nickname = "", source = "manual", adoptSession = null }, { log = this.log } = {}) {
    const uid = String(userId || "").trim();
    if (!uid || !/^\d+$/.test(uid)) throw new Error(`userId 不合法: ${JSON.stringify(userId)}（应为纯数字的小米账号 ID）`);
    if (!passToken) throw new Error("缺少 passToken（长效登录凭据）");
    const existing = this.get(uid);
    const acc = new Account({
      uid, passToken, cUserId, nickname: nickname || existing?.nickname || uid,
      source, addedAt: existing?.addedAt || Date.now(),
      jar: existing?.jar || {}, cookie: existing?.cookie || "", sessionAt: existing?.sessionAt || 0,
      lastUsedAt: existing?.lastUsedAt || 0, enabled: existing?.enabled ?? true,
      dir: this.dir
    });
    // 优先直接采用可用会话（避免多打一次 passport）；没有就现派生一次验证凭据
    if (adoptSession?.cookie) {
      acc.jar = adoptSession.jar || {};
      acc.cookie = adoptSession.cookie;
      acc.sessionAt = adoptSession.at || Date.now();
      acc.checkedAt = Date.now();
      acc.lastError = "";
      acc.cooldownUntil = 0;
      log(`[账号池] 已导入账号 ${acc.nickname}（${uid}），会话直接沿用现有缓存`);
    } else {
      const derived = await this._derive({ userId: uid, passToken, cUserId });
      if (!derived.ok) {
        throw new Error(`凭据换会话失败：${derived.error || "未知错误"}`);
      }
      acc.jar = derived.jar || {};
      acc.cookie = derived.cookie || "";
      acc.sessionAt = Date.now();
      acc.checkedAt = Date.now();
      acc.lastError = "";
      acc.cooldownUntil = 0;
      log(`[账号池] 已导入账号 ${acc.nickname}（${uid}，来源=${source}），会话就绪（${derived.hops ?? "?"} 跳）`);
    }
    if (existing) {
      const idx = this.accounts.indexOf(existing);
      this.accounts[idx] = acc;
    } else {
      this.accounts.push(acc);
    }
    acc.save();
    return acc;
  }

  remove(uid) {
    const acc = this.get(uid);
    if (!acc) return false;
    acc.delete();
    this.accounts = this.accounts.filter((a) => a !== acc);
    for (const [key, entry] of this._affinity) {
      if (entry.uid === acc.uid) this._affinity.delete(key);
    }
    return true;
  }

  setEnabled(uid, enabled) {
    const acc = this.get(uid);
    if (!acc) return null;
    acc.enabled = !!enabled;
    if (acc.enabled) { acc.lastError = ""; acc.cooldownUntil = 0; }
    acc.save();
    return acc;
  }

  setAllEnabled(enabled) {
    for (const acc of this.accounts) this.setEnabled(acc.uid, enabled);
    return true;
  }

  setNickname(uid, nickname) {
    const acc = this.get(uid);
    if (!acc) return null;
    acc.nickname = String(nickname || "").slice(0, 60) || acc.uid;
    acc.save();
    return acc;
  }

  /* ---- 调度 ---- */

  /** 会话亲和（wb-proxy 同款）：同一 key 粘住同一账号 */
  _affinityGet(key) {
    if (!key) return null;
    const entry = this._affinity.get(key);
    if (!entry) return null;
    if (this.now() > entry.exp) { this._affinity.delete(key); return null; }
    entry.exp = this.now() + AFFINITY_TTL_MS;
    return entry.uid;
  }

  _affinityBind(key, uid) {
    if (!key || !uid) return;
    if (this._affinity.size >= AFFINITY_MAX) {
      const now = this.now();
      for (const [k, v] of this._affinity) if (v.exp <= now) this._affinity.delete(k);
    }
    this._affinity.set(key, { uid, exp: this.now() + AFFINITY_TTL_MS });
  }

  /**
   * 轮询挑一个就绪账号。excludeUids：本轮已被 429/失效刷掉的。
   * 只看廉价标志（enabled/冷却/有无凭据），会话校验交给 ensureUsable。
   */
  pick({ excludeUids = [], sessionKey = null } = {}) {
    const exclude = new Set(excludeUids.filter(Boolean));
    // 先试亲和
    const boundUid = this._affinityGet(sessionKey);
    if (boundUid && !exclude.has(boundUid)) {
      const acc = this.get(boundUid);
      if (acc && acc.enabled && acc.passToken && acc.cooldownUntil <= this.now()) return acc;
      this._affinity.delete(sessionKey);
    }
    const total = this.accounts.length;
    if (!total) return null;
    for (let offset = 0; offset < total; offset++) {
      const acc = this.accounts[(this._cursor + offset) % total];
      if (exclude.has(acc.uid)) continue;
      if (!acc.enabled || !acc.passToken || acc.cooldownUntil > this.now()) continue;
      this._cursor = (this._cursor + offset + 1) % total;
      if (sessionKey) this._affinityBind(sessionKey, acc.uid);
      return acc;
    }
    return null;
  }

  hasReady(excludeUids = []) {
    return !!this.pick({ excludeUids });
  }

  /** 上一次错误备注（429/会话死/派生失败）：冷却时长取 max(现有, 新冷却) */
  noteError(uid, message, cooldownMs = DERIVE_FAIL_COOLDOWN_MS) {
    const acc = this.get(uid);
    if (!acc) return;
    acc.lastError = String(message || "").slice(0, 200);
    acc.cooldownUntil = Math.max(acc.cooldownUntil, this.now() + cooldownMs);
    acc.save();
    this.log(`[账号池] 账号 ${acc.nickname}（${acc.uid}）冷却 ${Math.round(cooldownMs / 1000)}s：${acc.lastError}`);
  }

  noteSuccess(uid) {
    const acc = this.get(uid);
    if (!acc) return;
    acc.lastError = "";
    acc.cooldownUntil = 0;
    acc.lastUsedAt = Date.now();
    acc.checkedAt = Date.now();
    acc.save();
  }

  /* ---- 会话可用性 ---- */

  /**
   * 确保账号有一个可用会话（带 checkedAt 缓存；invalid 才重派生）。
   * 返回 { ok:true, acc } 或 { ok:false, retryable, error }。
   */
  async ensureUsable(acc, { force = false, checkIntervalMs = 20000, log = this.log } = {}) {
    if (!acc.enabled) return { ok: false, retryable: false, error: "账号已禁用" };
    if (acc.cooldownUntil > this.now()) return { ok: false, retryable: false, error: acc.lastError || "账号冷却中" };

    if (!force && acc.cookie && acc.checkedAt && this.now() - acc.checkedAt < checkIntervalMs) {
      return { ok: true, acc, reused: true };
    }
    if (acc.cookie) {
      const v = await this._validate({ cookie: acc.cookie });
      if (v.state === "valid") { acc.checkedAt = Date.now(); return { ok: true, acc, reused: true }; }
      if (v.state === "unknown") {
        acc.checkedAt = Date.now();
        return { ok: true, acc, reused: true, uncertain: true };
      }
      log(`[账号池] ${acc.nickname}（${acc.uid}）会话失效（${v.status ?? v.error}），用 passToken 静默重派生…`);
    }
    return this.rederive(acc, { log });
  }

  /** 用 passToken 重派生会话（并发合并；passport 弹回 = passToken 已死） */
  async rederive(acc, { log = this.log } = {}) {
    const uid = acc.uid;
    if (this._deriveInflight.has(uid)) return this._deriveInflight.get(uid);
    const p = (async () => {
      const derived = await this._derive({ userId: acc.uid, passToken: acc.passToken, cUserId: acc.cUserId });
      if (derived.ok) {
        acc.jar = derived.jar || {};
        acc.cookie = derived.cookie || "";
        acc.sessionAt = Date.now();
        acc.checkedAt = Date.now();
        acc.lastError = "";
        acc.cooldownUntil = 0;
        acc.save();
        log(`[账号池] ${acc.nickname}（${acc.uid}）会话重派生成功（${derived.hops ?? "?"} 跳）`);
        return { ok: true, acc };
      }
      const passportRejected = (derived.trace || []).some((t) => /passport/i.test(String(t)));
      const kind = passportRejected ? "passToken-dead" : "derive-failed";
      const cooldown = passportRejected ? DEAD_CRED_COOLDOWN_MS : DERIVE_FAIL_COOLDOWN_MS;
      const msg = passportRejected
        ? "passToken 已失效（passport 拒绝），请重新导入凭据或用桌面端重新登录后导入"
        : `会话派生失败：${derived.error || "未知错误"}`;
      acc.lastError = msg;
      acc.cooldownUntil = Date.now() + cooldown;
      acc.save();
      log(`[账号池] ${acc.nickname}（${acc.uid}）${msg}`);
      return { ok: false, retryable: !passportRejected, error: msg, kind };
    })().finally(() => this._deriveInflight.delete(uid));
    this._deriveInflight.set(uid, p);
    return p;
  }

  /* ---- 添加渠道 ---- */

  /** 桌面端一键导入：扫描全部 Chromium cookie 库里的每个账号 */
  async importFromDesktop({ log = this.log } = {}) {
    const credsList = await STANDALONE.extractAllSsoCredentials();
    if (!credsList.length) {
      return { ok: false, added: [], error: "没有从桌面端 cookie 库找到任何小米 SSO 凭据（桌面端可能从没登录过，或库被占用）" };
    }
    const added = [], skipped = [], failed = [];
    for (const creds of credsList) {
      try {
        if (this.get(creds.userId)) { skipped.push(creds.userId); continue; }
        const acc = await this.addAccount({ ...creds, source: "desktop", nickname: creds.userId }, { log });
        added.push(acc.uid);
      } catch (e) {
        failed.push({ uid: creds.userId, error: String(e?.message || e).slice(0, 140) });
      }
    }
    return { ok: added.length > 0, added, skipped, failed };
  }

  /** 手动凭据导入（userId + passToken 从桌面端 cookie 库或浏览器 devtools 复制） */
  async importManual({ userId, passToken, cUserId = "", nickname = "" }, { log = this.log } = {}) {
    try {
      const acc = await this.addAccount({ userId, passToken, cUserId, nickname, source: "manual" }, { log });
      return { ok: true, acc };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  /**
   * 账号密码登录（经典 passport 流程，运行时探测端点可用性）。
   *
   * 流程：未登录访问 /api/user/xiaomi/me → 302 拿到服务器签发的
   * sid/callback → POST /pass/serviceLoginAuth2（user + MD5(password)）→
   * 成功返回 location+nonce+ssecurity → clientSign 跟随 → mimo 会话。
   *
   * ⚠️ 实测（2026-09）：小米已把该端点整体切到 account.xiaomi.com/fe/service/login
   * 新前端（AES 加密提交 + 风控），legacy 端点一律返回 HTML。这里对响应做
   * 形状探测：JSON → 正常解析；HTML → 返回 kind="endpoint-retired" 的明确错误，
   * 指引用户改用桌面端导入 / 手动凭据导入。端点若恢复，本流程立即可用。
   */
  async loginWithPassword(user, password, { log = this.log } = {}) {
    user = String(user || "").trim();
    if (!user || !password) return { ok: false, kind: "bad-input", error: "需要账号和密码" };
    const md5 = crypto.createHash("md5").update(String(password)).digest("hex").toUpperCase();

    // 1) 拿服务器签发的 sid/callback
    let callback = "", sid = "mimopc";
    try {
      const me = await fetch(`${CLOUD_BASE}/api/user/xiaomi/me`, {
        headers: { "User-Agent": LOGIN_UA }, redirect: "manual",
        signal: AbortSignal.timeout(20000)
      });
      const loc = me.headers.get("location");
      if (loc) {
        const u = new URL(loc);
        if (u.searchParams.get("callback")) callback = u.searchParams.get("callback");
        if (u.searchParams.get("sid")) sid = u.searchParams.get("sid");
      }
    } catch (e) {
      return { ok: false, kind: "network", error: `无法连接 mimo 云端：${String(e?.message || e)}` };
    }
    if (!callback) callback = `${CLOUD_BASE}/api/sts`;

    // 2) serviceLoginAuth2
    const form = new URLSearchParams({
      sid, qs: ";", callback, _sign: "",
      user, hash: md5, _locale: "zh_CN"
    });
    let resp;
    try {
      resp = await fetch("https://account.xiaomi.com/pass/serviceLoginAuth2", {
        method: "POST",
        headers: {
          "User-Agent": LOGIN_UA,
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: "deviceId=" + crypto.randomUUID()
        },
        body: form.toString(),
        redirect: "manual",
        signal: AbortSignal.timeout(25000)
      });
    } catch (e) {
      return { ok: false, kind: "network", error: `passport 请求失败：${String(e?.message || e)}` };
    }
    const text = await resp.text();
    const jsonStart = text.indexOf("{");
    const looksJson = resp.headers.get("content-type")?.includes("json") || /^\s*(&&&START&&&)?\s*\{/.test(text);
    if (!looksJson || jsonStart < 0) {
      return {
        ok: false,
        kind: "endpoint-retired",
        error: "小米已关闭账号密码直连接口（serviceLoginAuth2 返回的是登录页而非 JSON，登录已迁移到带风控的新前端）。请改用「桌面端导入」或「手动凭据导入」—— passToken 是长效凭据，导入一次长期有效。"
      };
    }
    let payload;
    try { payload = JSON.parse(text.slice(jsonStart)); } catch {
      return { ok: false, kind: "parse", error: "passport 返回了无法解析的内容" };
    }
    if (payload.code !== 0 || !payload.location) {
      const desc = payload.desc || payload.description || "";
      const needsCaptcha = payload.code === 87001 || (payload.code === 70016 && /captcha|验证码/i.test(desc));
      return {
        ok: false,
        kind: needsCaptcha ? "captcha" : "auth",
        code: payload.code,
        error: `登录被拒绝（code=${payload.code}${desc ? " " + desc : ""}）。可能原因：账号或密码错误、触发验证码/二次验证。请改用「桌面端导入」或「手动凭据导入」。`
      };
    }

    // 3) passport 确认了账号密码 → 拿到账号级长效凭据（userId + passToken）。
    //    mimo 会话统一走 addAccount → loginMimoSession（/api/user/xiaomi/me →
    //    passport → sts 链路，与桌面端导入完全一致），不复用 auth2 的
    //    location —— 少一条特殊路径，行为可预期。
    const creds = {
      userId: String(payload.userId ?? ""),
      passToken: String(payload.passToken ?? ""),
      cUserId: String(payload.cUserId ?? "")
    };
    if (!creds.passToken) {
      return { ok: false, kind: "parse", error: "passport 登录成功但响应里没有 passToken" };
    }
    log(`[账号池] 账号密码登录成功（userId=${creds.userId}）`);
    try {
      const acc = await this.addAccount({ ...creds, nickname: creds.userId, source: "password" }, { log });
      return { ok: true, acc };
    } catch (e) {
      return { ok: false, kind: "derive-failed", error: `登录成功但换 mimo 会话失败：${String(e?.message || e)}` };
    }
  }

  /* ---- 导出 / 导入 ---- */

  exportDocument() {
    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      note: "包含 passToken（账号级长效登录凭据），请像密码一样保管。",
      accounts: this.accounts.map((a) => ({
        uid: a.uid, nickname: a.nickname, enabled: a.enabled, source: a.source,
        passToken: a.passToken, cUserId: a.cUserId, addedAt: a.addedAt
      }))
    };
  }

  /**
   * 从导出文档/裸数组导入。返回 {added, updated, skipped, invalid}。
   * 接受：本模块导出文档、[{uid,passToken,...}] 裸数组、单个账号对象。
   * 注意：导入只落凭据，不主动派生会话 —— 首次使用时 ensureUsable 会按需派生。
   */
  async importDocument(blob, { log = this.log } = {}) {
    if (typeof blob === "string") {
      try { blob = JSON.parse(blob); } catch { return { added: [], updated: [], skipped: [], invalid: [{ index: 1, reason: "不是合法 JSON" }] }; }
    }
    let rows = [];
    if (Array.isArray(blob)) rows = blob;
    else if (Array.isArray(blob?.accounts)) rows = blob.accounts;
    else if (blob && typeof blob === "object") rows = [blob];

    const added = [], skipped = [], invalid = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const uid = String(row.uid || row.userId || "").trim();
      const passToken = String(row.passToken || row.accessToken || "").trim();
      if (!/^\d+$/.test(uid) || !passToken) {
        invalid.push({ index: i + 1, reason: "缺少合法 uid/userId 或 passToken" });
        continue;
      }
      if (this.get(uid)) {
        skipped.push({ uid, reason: "已存在" });
        continue;
      }
      try {
        const acc = new Account({
          uid, passToken, cUserId: String(row.cUserId || ""),
          nickname: String(row.nickname || uid), source: String(row.source || "import"),
          addedAt: row.addedAt || Date.now(), enabled: row.enabled !== false,
          dir: this.dir
        });
        this.accounts.push(acc);
        acc.save();
        added.push(uid);
      } catch (e) {
        invalid.push({ index: i + 1, reason: String(e?.message || e).slice(0, 140) });
      }
    }
    if (added.length) log(`[账号池] 导入 ${added.length} 个账号（${added.join(", ")}）`);
    return { added, skipped, invalid };
  }

  /* ---- 保活 ---- */

  /** 全量保活：逐账号校验会话（免费 GET），失效的静默重派生 */
  async keepalive({ log = this.log } = {}) {
    const results = [];
    for (const acc of [...this.accounts]) {
      if (!acc.enabled) continue;
      try {
        const r = await this.ensureUsable(acc, { force: true, checkIntervalMs: 0, log });
        results.push({ uid: acc.uid, ok: r.ok, error: r.error || null });
      } catch (e) {
        results.push({ uid: acc.uid, ok: false, error: String(e?.message || e).slice(0, 120) });
      }
    }
    const okCount = results.filter((r) => r.ok).length;
    log(`[账号池] 保活完成：${okCount}/${results.length} 个账号会话就绪`);
    return results;
  }
}

/* ------------------------------------------------------------------ *
 * 进程级单例
 * ------------------------------------------------------------------ */

let POOL = null;

export function getPool({ log = console.log } = {}) {
  if (!POOL) {
    POOL = new AccountPool({ log: (m) => log(m) });
    POOL.load();
  }
  return POOL;
}

export function _resetPoolForTest() { POOL = null; }
