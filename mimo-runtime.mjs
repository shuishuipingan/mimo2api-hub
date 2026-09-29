import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export class HttpInputError extends Error {
  constructor(status, message, code = "invalid_request") {
    super(message);
    this.name = "HttpInputError";
    this.status = status;
    this.code = code;
  }
}

export function loadJsonFile(file, { missingValue, label = "JSON file" } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { found: false, value: missingValue };
    throw new Error(`${label} cannot be read: ${error.message}`, { cause: error });
  }
  try {
    return { found: true, value: JSON.parse(raw) };
  } catch (error) {
    throw new Error(`${label} contains invalid JSON: ${error.message}`, { cause: error });
  }
}

export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let wrote = false;
  try {
    const body = JSON.stringify(value, null, 2) + "\n";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 先写临时文件并 fsync 落盘，再 rename —— 防止进程被强杀/断电时
    // 出现「元数据已提交、数据块还是零」的损坏文件（实测发生过）
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    wrote = true;
    fs.renameSync(tmp, file);
  } catch (error) {
    if (wrote || fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp); } catch {}
    }
    throw error;
  }
}

export function isLoopbackHost(host) {
  const value = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}

export function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function initialPasswordState(initial) {
  const chosen = typeof initial === "string" && initial.length > 0;
  return {
    password: chosen ? initial : "admin",
    panelPasswordSet: chosen,
    usedDefault: !chosen
  };
}

export function validateExposurePolicy({ host, panelPasswordSet }) {
  if (!isLoopbackHost(host) && panelPasswordSet === false) {
    throw new Error("Refusing non-loopback binding with the default dashboard password; set a dashboard password first");
  }
}

export function readBodyLimited(req, { limit, contentLength } = {}) {
  const max = Number(limit);
  if (!Number.isSafeInteger(max) || max < 0) throw new TypeError("body limit must be a non-negative integer");
  if (contentLength !== undefined) {
    const raw = String(contentLength).trim();
    if (!/^\d+$/.test(raw)) {
      return Promise.reject(new HttpInputError(400, "Invalid Content-Length", "invalid_content_length"));
    }
    if (Number(raw) > max) {
      return Promise.reject(new HttpInputError(413, `Request body exceeds ${max} bytes`, "request_too_large"));
    }
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAborted);
    };
    const fail = (error, drain = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain && typeof req.resume === "function") req.resume();
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > max) {
        fail(new HttpInputError(413, `Request body exceeds ${max} bytes`, "request_too_large"), true);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error) => fail(error);
    const onAborted = () => fail(new HttpInputError(400, "Request body was aborted", "request_aborted"));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

export function createIdleAbortController({ outerSignal, timeoutMs = 0 } = {}) {
  const controller = new AbortController();
  let timer = null;
  const abortFromOuter = () => controller.abort(outerSignal.reason);
  const arm = () => {
    if (timer) clearTimeout(timer);
    if (!(timeoutMs > 0) || controller.signal.aborted) return;
    timer = setTimeout(() => {
      const error = new Error(`Upstream produced no data for ${timeoutMs}ms`);
      error.code = "UPSTREAM_IDLE_TIMEOUT";
      controller.abort(error);
    }, timeoutMs);
    timer.unref?.();
  };
  if (outerSignal) {
    if (outerSignal.aborted) abortFromOuter();
    else outerSignal.addEventListener("abort", abortFromOuter, { once: true });
  }
  arm();
  return {
    signal: controller.signal,
    touch: arm,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      outerSignal?.removeEventListener("abort", abortFromOuter);
    }
  };
}

export function sanitizeDiagnosticText(text) {
  return String(text ?? "")
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(Cookie\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|tp)-[A-Za-z0-9._-]+\b/g, "[REDACTED_KEY]")
    .replace(/\b(passToken|api-platform_serviceToken|mimo_panel)\s*=\s*[^;\s]+/gi, "$1=[REDACTED]");
}

export function buildFailureDump({ request, status, upstreamText, includeBodies = false }) {
  const raw = JSON.stringify(request ?? {});
  const summary = {
    model: request?.model ?? null,
    stream: request?.stream === true,
    messages: Array.isArray(request?.messages) ? request.messages.length : 0,
    tools: Array.isArray(request?.tools) ? request.tools.length : 0,
    parameters: Object.keys(request || {}).filter((key) => !["model", "messages", "tools"].includes(key)).sort(),
    requestBytes: Buffer.byteLength(raw)
  };
  const dump = {
    status,
    summary,
    requestHash: crypto.createHash("sha256").update(raw).digest("hex"),
    response: sanitizeDiagnosticText(upstreamText).slice(0, 2000)
  };
  if (includeBodies) dump.request = request;
  return dump;
}
