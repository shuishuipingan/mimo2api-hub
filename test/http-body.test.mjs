import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import { HttpInputError, createIdleAbortController, readBodyLimited } from "../mimo-runtime.mjs";

test("declared oversized body is rejected before reading", async () => {
  let reads = 0;
  const req = Readable.from((async function* () { reads++; yield Buffer.from("ignored"); })());
  await assert.rejects(
    readBodyLimited(req, { limit: 16, contentLength: "17" }),
    (error) => error instanceof HttpInputError && error.status === 413
  );
  assert.equal(reads, 0);
});

test("chunked body crossing the limit returns a 413 error", async () => {
  const req = Readable.from([Buffer.from("12345678"), Buffer.from("901234567")]);
  await assert.rejects(readBodyLimited(req, { limit: 16 }), (error) => error.status === 413);
});

test("invalid content-length returns 400", async () => {
  const req = Readable.from([Buffer.from("abc")]);
  await assert.rejects(readBodyLimited(req, { limit: 16, contentLength: "invalid" }), (error) => error.status === 400);
});

test("body exactly at the limit succeeds", async () => {
  const body = await readBodyLimited(Readable.from([Buffer.from("12345678"), Buffer.from("90123456")]), { limit: 16 });
  assert.equal(body.toString(), "1234567890123456");
});

test("HTTP caller receives JSON 413 instead of ECONNRESET", async (t) => {
  const server = http.createServer(async (req, res) => {
    try {
      await readBodyLimited(req, { limit: 4, contentLength: req.headers["content-length"] });
      res.writeHead(204).end();
    } catch (error) {
      res.writeHead(error.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: error.code }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "12345" });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { code: "request_too_large" });
});

test("idle controller aborts, touch extends it, and dispose cancels it", async () => {
  const idle = createIdleAbortController({ timeoutMs: 30 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  idle.touch();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(idle.signal.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(idle.signal.aborted, true);
  assert.equal(idle.signal.reason?.code, "UPSTREAM_IDLE_TIMEOUT");

  const disposed = createIdleAbortController({ timeoutMs: 20 });
  disposed.dispose();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(disposed.signal.aborted, false);
});

test("idle controller propagates an outer abort", () => {
  const outer = new AbortController();
  const idle = createIdleAbortController({ outerSignal: outer.signal, timeoutMs: 1000 });
  outer.abort(new Error("client left"));
  assert.equal(idle.signal.aborted, true);
  assert.equal(idle.signal.reason.message, "client left");
  idle.dispose();
});
