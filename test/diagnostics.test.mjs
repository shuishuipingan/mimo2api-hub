import test from "node:test";
import assert from "node:assert/strict";
import { buildFailureDump, sanitizeDiagnosticText } from "../mimo-runtime.mjs";

test("metadata-only failure dump excludes prompts, tools, media, and secrets", () => {
  const request = {
    model: "xiaomi/mimo-x-pro-preview",
    stream: true,
    messages: [
      { role: "system", content: "SYSTEM-SECRET-INSTRUCTION" },
      { role: "user", content: [{ type: "text", text: "USER-PRIVATE-TEXT" }, { type: "image_url", image_url: { url: "https://private/image.png" } }] }
    ],
    tools: [{ type: "function", function: { name: "privateTool", description: "TOOL-PRIVATE-SCHEMA" } }],
    temperature: 0.5,
    api_key: "sk-super-secret"
  };
  const dump = buildFailureDump({ request, status: 502, upstreamText: "bad parameter", includeBodies: false });
  const text = JSON.stringify(dump);
  for (const secret of ["SYSTEM-SECRET-INSTRUCTION", "USER-PRIVATE-TEXT", "private/image.png", "TOOL-PRIVATE-SCHEMA", "sk-super-secret"]) {
    assert.equal(text.includes(secret), false);
  }
  assert.equal(dump.summary.model, "xiaomi/mimo-x-pro-preview");
  assert.equal(dump.summary.messages, 2);
  assert.equal(dump.summary.tools, 1);
  assert.deepEqual(dump.summary.parameters, ["api_key", "stream", "temperature"]);
  assert.match(dump.requestHash, /^[0-9a-f]{64}$/);
  assert.equal(dump.status, 502);
});

test("full body dump remains explicit and diagnostic text is sanitized", () => {
  const dump = buildFailureDump({ request: { model: "m", messages: [{ role: "user", content: "hello" }] }, status: 400, upstreamText: "Authorization: Bearer abc Cookie: sid=xyz sk-secret-value tp-secret-value", includeBodies: true });
  assert.equal(dump.request.messages[0].content, "hello");
  assert.equal(dump.response.includes("abc"), false);
  assert.equal(dump.response.includes("xyz"), false);
  assert.equal(dump.response.includes("sk-secret-value"), false);
  assert.equal(sanitizeDiagnosticText("api-platform_serviceToken=hidden"), "api-platform_serviceToken=[REDACTED]");
});
