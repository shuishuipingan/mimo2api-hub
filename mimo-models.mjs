import crypto from "node:crypto";
import fs from "node:fs";

export function catalogFingerprint(catalog) {
  return crypto.createHash("sha256").update(JSON.stringify(catalog ?? {})).digest("hex").slice(0, 16);
}

export function loadDesktopCatalog(file) {
  try {
    const stat = fs.statSync(file);
    const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
    return { found: true, catalog, mtimeMs: stat.mtimeMs, fingerprint: catalogFingerprint(catalog) };
  } catch {
    return { found: false, catalog: { models: [] }, mtimeMs: 0, fingerprint: catalogFingerprint({ models: [] }) };
  }
}

export function mergeModelSources({ catalog = { models: [] }, liveModels = [] } = {}) {
  const catalogById = new Map();
  for (const item of Array.isArray(catalog.models) ? catalog.models : []) {
    if (!item?.id || item.modelType && item.modelType !== "TEXT") continue;
    catalogById.set(String(item.id), item);
  }
  const live = new Set(liveModels.map((id) => String(id).replace(/^xiaomi\//, "")));
  const ids = new Set([...catalogById.keys(), ...live]);
  const models = [...ids].map((bareId) => {
    const catalogItem = catalogById.get(bareId);
    const inCatalog = !!catalogItem;
    const inLive = live.has(bareId);
    return {
      id: `xiaomi/${bareId}`,
      bareId,
      name: catalogItem?.name || bareId,
      source: inCatalog && inLive ? "catalog+live" : inCatalog ? "catalog" : "live",
      catalog: catalogItem || null,
      live: inLive
    };
  }).filter((model) => (model.live || model.source === "catalog") && !/(?:^|[-_.])(asr|tts|voiceclone|voicedesign|image|seedream)(?:$|[-_.])/i.test(model.bareId));
  models.sort((a, b) => a.id.localeCompare(b.id));
  return { models, catalogFingerprint: catalogFingerprint(catalog) };
}

function newest(candidates) {
  return candidates.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) || null;
}

export function resolveDynamicAlias(alias, models = []) {
  const key = String(alias || "").toLowerCase();
  if (key !== "mimo-flash" && key !== "mimo-pro") return alias;
  const needle = key.slice("mimo-".length);
  const candidates = models.map((item) => typeof item === "string" ? item : item.id).filter((id) => new RegExp(`mimo-(?:v[0-9.]+-)?${needle}(?:-|$)`, "i").test(id));
  return newest(candidates) || alias;
}

export function createCapabilityProbeQueue({ probeModel, isBusy = () => false, now = Date.now, idleDelayMs = 1000, retryDelayMs = 2000 } = {}) {
  let catalogHash = null;
  let queue = [];
  let running = false;
  let results = {};
  return {
    enqueue(models, nextHash) {
      if (nextHash === catalogHash && !queue.length) return;
      catalogHash = nextHash;
      queue = [...new Set(models || [])];
    },
    async run() {
      if (running || isBusy()) {
        if (!running && queue.length) {
          const retry = setTimeout(() => this.run(), retryDelayMs);
          retry.unref?.();
        }
        return;
      }
      running = true;
      try {
        while (queue.length && !isBusy()) {
          const model = queue.shift();
          if (idleDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, idleDelayMs));
          if (isBusy()) { queue.unshift(model); break; }
          try { results[model] = await probeModel(model, { deep: true, observedAt: new Date(now()).toISOString() }); }
          catch (error) { results[model] = { model, status: "error", error: String(error?.message || error), observedAt: new Date(now()).toISOString() }; }
        }
      } finally {
        running = false;
        if (queue.length) {
          const retry = setTimeout(() => this.run(), retryDelayMs);
          retry.unref?.();
        }
      }
    },
    snapshot() { return { catalogHash, queue: [...queue], running, results: { ...results } }; }
  };
}
