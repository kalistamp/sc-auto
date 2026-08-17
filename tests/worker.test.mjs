import test from "node:test";
import assert from "node:assert/strict";
import worker, { testHelpers } from "../worker/src/index.js";
import { createDefaultData } from "../js/data.js";

const baseEnv = {
  APP_PASSKEY: "a-long-test-passkey",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  GIST_ID: "test-gist",
  GIST_FILENAME: "data.json",
  GITHUB_TOKEN: "test-token",
  OPENAI_API_KEY: "test-openai",
  ALLOWED_ORIGINS: "https://example.github.io"
};

test("session tokens are signed, expire, and reject tampering", async () => {
  const token = await testHelpers.signToken({ sub: "safecycle-admin", exp: Math.floor(Date.now() / 1000) + 60 }, baseEnv.SESSION_SECRET);
  assert.equal(await testHelpers.verifyToken(token, baseEnv.SESSION_SECRET), true);
  assert.equal(await testHelpers.verifyToken(`${token}x`, baseEnv.SESSION_SECRET), false);
  const expired = await testHelpers.signToken({ sub: "safecycle-admin", exp: 1 }, baseEnv.SESSION_SECRET);
  assert.equal(await testHelpers.verifyToken(expired, baseEnv.SESSION_SECRET), false);
});

test("allowed origins include configured production and local testing", () => {
  assert.equal(testHelpers.isAllowedOrigin("https://example.github.io", baseEnv), true);
  assert.equal(testHelpers.isAllowedOrigin("http://localhost:8000", baseEnv), true);
  assert.equal(testHelpers.isAllowedOrigin("https://attacker.example", baseEnv), false);
});

test("health reports configuration without leaking secrets", async () => {
  const request = new Request("https://worker.example/api/health", { headers: { Origin: "https://example.github.io" } });
  const response = await worker.fetch(request, baseEnv);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.configured.gist, true);
  assert.equal(JSON.stringify(payload).includes(baseEnv.GITHUB_TOKEN), false);
});

test("session endpoint accepts the right passkey and rejects a wrong one", async () => {
  const good = new Request("https://worker.example/api/session", {
    method: "POST",
    headers: { Origin: "https://example.github.io", "Content-Type": "application/json" },
    body: JSON.stringify({ passkey: baseEnv.APP_PASSKEY })
  });
  const goodResponse = await worker.fetch(good, baseEnv);
  const goodPayload = await goodResponse.json();
  assert.equal(goodResponse.status, 200);
  assert.ok(goodPayload.token);

  const bad = new Request("https://worker.example/api/session", {
    method: "POST",
    headers: { Origin: "https://example.github.io", "Content-Type": "application/json" },
    body: JSON.stringify({ passkey: "wrong" })
  });
  assert.equal((await worker.fetch(bad, baseEnv)).status, 401);
});

test("workspace write rejects stale revisions and accepts the current revision", async (t) => {
  const workspace = createDefaultData();
  workspace.revision = 4;
  const originalFetch = globalThis.fetch;
  let patchedData = null;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("api.github.com/gists/") && (!init.method || init.method === "GET")) {
      return Response.json({ files: { "data.json": { content: JSON.stringify(workspace), truncated: false } } });
    }
    if (String(url).includes("api.github.com/gists/") && init.method === "PATCH") {
      patchedData = JSON.parse(JSON.parse(init.body).files["data.json"].content);
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const token = await testHelpers.signToken({ sub: "safecycle-admin", exp: Math.floor(Date.now() / 1000) + 60 }, baseEnv.SESSION_SECRET);

  const staleRequest = new Request("https://worker.example/api/data", {
    method: "PUT",
    headers: { Origin: "https://example.github.io", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ baseRevision: 3, data: workspace })
  });
  assert.equal((await worker.fetch(staleRequest, baseEnv)).status, 409);

  const currentRequest = new Request("https://worker.example/api/data", {
    method: "PUT",
    headers: { Origin: "https://example.github.io", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ baseRevision: 4, data: workspace })
  });
  const response = await worker.fetch(currentRequest, baseEnv);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.data.revision, 5);
  assert.equal(patchedData.revision, 5);
});

test("generation schema requires every requested platform", () => {
  const schema = testHelpers.generationSchema(["reddit", "facebook"]);
  assert.equal(schema.properties.variants.minItems, 2);
  assert.deepEqual(schema.properties.variants.items.properties.platform.enum, ["reddit", "facebook"]);
  const errors = testHelpers.validateGeneration({ canonical: "Hello", variants: [{ platform: "reddit", title: "Title", body: "Body" }] }, ["reddit", "facebook"]);
  assert.ok(errors.some((error) => error.includes("facebook")));
});

test("output extraction supports REST Responses API message content", () => {
  const output = testHelpers.extractOutputText({ output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }] });
  assert.equal(output, "{\"ok\":true}");
});
