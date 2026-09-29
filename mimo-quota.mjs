const ORIGIN = "https://platform.xiaomimimo.com";
const COOKIE_NAMES = new Set(["api-platform_serviceToken", "userId", "api-platform_ph", "api-platform_slh"]);

function unwrap(value) {
  return value && typeof value === "object" && value.data && typeof value.data === "object" ? value.data : value;
}

function valueOf(object, names) {
  const source = unwrap(object);
  if (!source || typeof source !== "object") return null;
  for (const name of names) {
    if (source[name] !== undefined && source[name] !== null && source[name] !== "") return source[name];
  }
  return null;
}

function numberOf(object, names) {
  const value = valueOf(object, names);
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parsePlatformCookieHeader(raw) {
  if (!raw) return null;
  const entries = [];
  const found = new Set();
  for (const part of String(raw).split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!COOKIE_NAMES.has(name) || !value || found.has(name)) continue;
    found.add(name);
    entries.push(`${name}=${value}`);
  }
  if (!found.has("api-platform_serviceToken") || !found.has("userId")) return null;
  return entries.join("; ");
}

export function platformCookieHeaderFromRows(rows) {
  const parts = [];
  for (const row of rows || []) {
    const host = String(row?.host || "").replace(/^\./, "").toLowerCase();
    if (!(host === "xiaomimimo.com" || host.endsWith(".xiaomimimo.com"))) continue;
    if (!COOKIE_NAMES.has(row?.name) || !row?.value) continue;
    parts.push(`${row.name}=${row.value}`);
  }
  return parsePlatformCookieHeader(parts.join("; "));
}

export function normalizeQuota({ balance, detail, usage, fetchedAt }) {
  const totalBalance = numberOf(balance, ["totalBalance", "total_balance", "balance"]);
  const paidBalance = numberOf(balance, ["cashBalance", "paidBalance", "toppedUpBalance", "cash_balance", "paid_balance", "topped_up_balance"]);
  const grantedBalance = numberOf(balance, ["giftBalance", "grantedBalance", "gift_balance", "granted_balance"]);
  const currency = valueOf(balance, ["currency", "currencyCode", "currency_code"]);
  const planTotal = numberOf(usage, ["month_total_token", "monthTotalToken", "totalToken", "total_token", "limit"]);
  const planUsed = numberOf(usage, ["month_used_token", "monthUsedToken", "usedToken", "used_token", "used"]);
  const weeklyTotal = numberOf(usage, ["week_total_token", "weekly_total_token", "weekTotalToken", "weeklyTotalToken", "weekly_limit", "week_limit"]);
  const weeklyUsed = numberOf(usage, ["week_used_token", "weekly_used_token", "weekUsedToken", "weeklyUsedToken", "weekly_used", "week_used"]);
  const weeklyRemaining = numberOf(usage, ["week_remaining_token", "weekly_remaining_token", "weekRemainingToken", "weeklyRemainingToken", "weekly_remaining", "week_remaining"]);
  const planName = valueOf(detail, ["planName", "plan_name", "name"]);
  const resetAt = valueOf(detail, ["expireTime", "expire_time", "endTime", "end_time", "resetAt", "reset_at"]);
  const hasBalance = [totalBalance, paidBalance, grantedBalance].some((value) => value !== null);
  const hasPlan = [planTotal, planUsed, weeklyTotal, weeklyUsed, weeklyRemaining, planName, resetAt].some((value) => value !== null);
  if (!hasBalance && !hasPlan) {
    return {
      state: "unavailable",
      source: "xiaomi-open-platform",
      fetchedAt,
      reason: "Xiaomi quota response contained no recognized balance or token-plan fields"
    };
  }
  const tokenPlan = hasPlan ? {
    name: planName ?? null,
    total: planTotal,
    used: planUsed,
    remaining: planTotal !== null && planUsed !== null ? Math.max(0, planTotal - planUsed) : null,
    resetAt: resetAt ?? null
  } : null;
  if (weeklyTotal !== null || weeklyUsed !== null || weeklyRemaining !== null) {
    tokenPlan.weekly = {
      total: weeklyTotal,
      used: weeklyUsed,
      remaining: weeklyRemaining ?? (weeklyTotal !== null && weeklyUsed !== null ? Math.max(0, weeklyTotal - weeklyUsed) : null),
      resetAt: valueOf(usage, ["week_reset_at", "weekly_reset_at", "weekResetAt", "weeklyResetAt"]) ?? null
    };
  }
  return {
    state: "available",
    source: "xiaomi-open-platform",
    fetchedAt,
    balance: hasBalance ? { total: totalBalance, paid: paidBalance, granted: grantedBalance, currency: currency ?? null } : null,
    tokenPlan
  };
}

class QuotaLoginError extends Error {}

/**
 * 免费通道（桌面端同款）用量查询。
 *
 * 端点（逆向自桌面端，带会话 cookie 轮询）：
 *   GET /api/user/usage                  → {code:0,data:{percent,resetDate}}
 *     percent = 剩余百分比（桌面端 UI 的 "剩余 {{percent}}%" 直接渲染它）
 *     resetDate = 当前周期重置日期（null = 无有效订阅）
 *   GET /api/user/xiaomi/subscription/self → 当前套餐（标题/档位/周期）
 */
export function createFreeUsageProvider({ fetchImpl = fetch, origin = "https://mimo-server-cn.xiaomimimo.com", cookieProvider, now = Date.now, ttlMs = 5 * 60 * 1000, timeoutMs = 15000 } = {}) {
  let cache = null;
  let inflight = null;

  const getJson = async (path, cookie) => {
    const response = await fetchImpl(origin + path, {
      headers: { Accept: "application/json", Cookie: cookie, "User-Agent": "MiClaw/1.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
      throw new QuotaLoginError(`login expired (HTTP ${response.status})`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body && typeof body === "object" && body.code !== undefined && body.code !== 0) {
      throw new Error(`code=${body.code} ${body.message || ""}`.trim());
    }
    return body && typeof body === "object" && body.data !== undefined ? body.data : body;
  };

  const refresh = async () => {
    const fetchedAt = new Date(now()).toISOString();
    const cookie = await cookieProvider?.();
    if (!cookie) {
      return { state: "login_required", source: "free-channel", fetchedAt, reason: "no free-channel session yet" };
    }
    try {
      const usage = await getJson("/api/user/usage", cookie);
      const percent = Number(usage?.percent);
      const resetDate = usage?.resetDate ?? null;
      if (!Number.isFinite(percent) || percent < 0) throw new Error("usage percent invalid");
      if (resetDate === null) {
        return { state: "unavailable", source: "free-channel", fetchedAt, reason: "usage has no active subscription" };
      }
      let plan = null;
      try {
        const sub = await getJson("/api/user/xiaomi/subscription/self", cookie);
        const cur = sub?.current ?? null;
        if (cur) {
          plan = {
            title: cur.title ?? null,
            code: cur.planCode ?? null,
            tier: cur.planTier ?? null,
            status: cur.status ?? null,
            start: cur.startTime ?? null,
            end: cur.endTime ?? null,
            nextReset: cur.nextResetTime ?? null
          };
        }
      } catch { /* 订阅信息尽力而为，不影响用量显示 */ }
      return {
        state: "available",
        source: "free-channel",
        fetchedAt,
        remainingPercent: Math.max(0, Math.min(100, percent)),
        usedPercent: Math.max(0, Math.min(100, Math.round((100 - percent) * 10) / 10)),
        resetDate,
        plan
      };
    } catch (error) {
      if (error instanceof QuotaLoginError) {
        return { state: "login_required", source: "free-channel", fetchedAt, reason: error.message };
      }
      return { state: "unavailable", source: "free-channel", fetchedAt, reason: String(error?.message || error) };
    }
  };

  return {
    async get({ force = false } = {}) {
      if (!force && cache && now() - cache.at < ttlMs) return cache.value;
      if (inflight) return inflight;
      inflight = refresh().then((value) => {
        cache = { at: now(), value };
        return value;
      }).finally(() => { inflight = null; });
      return inflight;
    },
    status() { return cache?.value ?? null; },
    invalidate() { cache = null; }
  };
}

export function createQuotaProvider({ fetchImpl = fetch, cookieProvider, now = Date.now, ttlMs = 5 * 60 * 1000 } = {}) {
  let cache = null;
  let inflight = null;

  const fetchOne = async (path, cookie) => {
    const url = new URL(path, ORIGIN);
    if (url.protocol !== "https:" || url.origin !== ORIGIN) throw new Error("quota endpoint is outside the Xiaomi allowlist");
    const response = await fetchImpl(url.href, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "application/json", Cookie: cookie, "X-Timezone": "Asia/Shanghai" },
      signal: AbortSignal.timeout(15000)
    });
    if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
      throw new QuotaLoginError(`Xiaomi Open Platform login expired (HTTP ${response.status})`);
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Xiaomi quota endpoint returned HTTP ${response.status}`);
    try { return await response.json(); }
    catch { throw new Error("Xiaomi quota endpoint returned invalid JSON"); }
  };

  const refresh = async () => {
    const fetchedAt = new Date(now()).toISOString();
    const cookie = parsePlatformCookieHeader(await cookieProvider?.());
    if (!cookie) {
      return { state: "login_required", source: "xiaomi-open-platform", fetchedAt, reason: "Open Platform cookies api-platform_serviceToken and userId were not found" };
    }
    try {
      const [balance, detail, usage] = await Promise.all([
        fetchOne("/api/v1/balance", cookie),
        fetchOne("/api/v1/tokenPlan/detail", cookie),
        fetchOne("/api/v1/tokenPlan/usage", cookie)
      ]);
      return normalizeQuota({ balance, detail, usage, fetchedAt });
    } catch (error) {
      if (error instanceof QuotaLoginError) {
        return { state: "login_required", source: "xiaomi-open-platform", fetchedAt, reason: error.message };
      }
      return { state: "unavailable", source: "xiaomi-open-platform", fetchedAt, reason: String(error?.message || error) };
    }
  };

  return {
    async get({ force = false } = {}) {
      if (!force && cache && now() - cache.at < ttlMs) return cache.value;
      if (inflight) return inflight;
      inflight = refresh().then((value) => {
        cache = { at: now(), value };
        return value;
      }).finally(() => { inflight = null; });
      return inflight;
    },
    status() { return cache?.value ?? null; },
    invalidate() { cache = null; }
  };
}
