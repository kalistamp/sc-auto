import test from "node:test";
import assert from "node:assert/strict";
import { ProviderError, generateDrafts, listModels } from "../js/providers.js";

/* The nine providers added on top of Anthropic/OpenAI/Gemini. Eight speak
   OpenAI's /chat/completions; Cohere has its own /v2/chat. This mirrors the
   recording-fetch harness in providers.test.mjs — every test asserts on the
   request that was built as well as the reply that came back. */

function mockFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), options, body });
    const { status = 200, payload = {} } = responder(String(url), body) || {};
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

const organization = { name: "Safe Cycle Tech", mission: "m", facts: ["Pickup is free."], prohibitedClaims: ["No invented numbers."] };
const brief = {
  campaign: "Drive", objective: "o", audience: "a", keyMessage: "k",
  cta: "call", tone: "Neighborly and direct", platforms: ["reddit", "facebook"], guidance: {}
};
const goodPackage = {
  campaignName: "E-waste drive", audience: "neighbors", objective: "awareness",
  campaignAngle: "angle", canonical: "Shared message", warnings: [],
  variants: [
    { platform: "facebook", title: "", body: "FB body", hashtags: ["EWaste"], notes: "" },
    { platform: "reddit", title: "R title", body: "R body", hashtags: [], notes: "check rules" }
  ]
};

/* Every provider keyed, with the compound Cloudflare credential included. */
const KEYS = {
  anthropic: "sk-ant-x", openai: "sk-x", gemini: "AIza-x",
  groq: "gsk_test", cerebras: "csk-test", openrouter: "sk-or-test",
  mistral: "mist-test", nvidia: "nvapi-test", cloudflare: "acct123:cftoken",
  cohere: "co-test", github: "github_pat_test", huggingface: "hf_test"
};
const MODELS = {
  groq: "llama-3.3-70b-versatile", cerebras: "llama-3.3-70b", openrouter: "openai/gpt-4.1-mini",
  mistral: "mistral-large-latest", nvidia: "meta/llama-3.3-70b-instruct",
  cloudflare: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", cohere: "command-a-03-2025",
  github: "openai/gpt-4.1-mini", huggingface: "openai/gpt-oss-120b"
};
const credsFor = (provider, patch = {}) => ({
  provider, effort: "",
  keys: { ...KEYS, ...(patch.keys || {}) },
  models: { anthropic: "claude-opus-5", openai: "gpt-5.6-luna", gemini: "gemini-3.6-flash", ...MODELS },
  ...patch
});

const chatReply = (model = "served-model-1") => ({
  payload: {
    id: "chatcmpl-1", model,
    choices: [{ message: { role: "assistant", content: JSON.stringify(goodPackage) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 40, completion_tokens: 60, total_tokens: 100 }
  }
});

const OPENAI_COMPAT = {
  groq:        { host: "api.groq.com/openai/v1/chat/completions", token: "gsk_test" },
  cerebras:    { host: "api.cerebras.ai/v1/chat/completions", token: "csk-test" },
  openrouter:  { host: "openrouter.ai/api/v1/chat/completions", token: "sk-or-test" },
  mistral:     { host: "api.mistral.ai/v1/chat/completions", token: "mist-test" },
  nvidia:      { host: "integrate.api.nvidia.com/v1/chat/completions", token: "nvapi-test" },
  huggingface: { host: "router.huggingface.co/v1/chat/completions", token: "hf_test" },
  cloudflare:  { host: "api.cloudflare.com/client/v4/accounts/acct123/ai/v1/chat/completions", token: "cftoken" }
};

for (const [provider, { host, token }] of Object.entries(OPENAI_COMPAT)) {
  test(`${provider}: posts an OpenAI-shaped body with JSON output and records the served model`, async () => {
    const calls = mockFetch(() => chatReply("served-xyz"));
    const { generation, receipt } = await generateDrafts({ credentials: credsFor(provider), brief, organization });

    const call = calls[0];
    assert.equal(call.url, `https://${host}`);
    assert.equal(call.options.headers.Authorization, `Bearer ${token}`);
    assert.equal(call.body.model, MODELS[provider]);
    assert.deepEqual(call.body.response_format, { type: "json_object" });
    assert.equal(call.body.messages[0].role, "system");
    assert.equal(call.body.messages[1].role, "user");
    /* The schema is carried in the prompt because json_object enforces valid
       JSON but not the shape. */
    assert.match(call.body.messages[0].content, /Return ONE JSON object/);
    assert.match(call.body.messages[0].content, /campaignName/);
    assert.match(call.body.messages[0].content, /Pickup is free\./);
    /* Neither may be sent — several gateway models reject them. */
    assert.equal("temperature" in call.body, false);
    assert.equal("max_tokens" in call.body, false);

    assert.equal(receipt.provider, provider);
    assert.equal(receipt.servedModel, "served-xyz");
    assert.equal(receipt.requestedModel, MODELS[provider]);
    assert.deepEqual(receipt.usage, { input: 40, output: 60, total: 100 });
    assert.deepEqual(generation.variants.map((v) => v.platform), ["reddit", "facebook"]);
    assert.equal(generation.variants[1].hashtags[0], "EWaste");
  });
}

test("cohere: uses /v2/chat and reads block content and usage.tokens", async () => {
  const calls = mockFetch(() => ({
    payload: {
      id: "co-1", model: "command-a-03-2025",
      message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(goodPackage) }] },
      usage: { tokens: { input_tokens: 12, output_tokens: 34 } }
    }
  }));
  const { generation, receipt } = await generateDrafts({ credentials: credsFor("cohere"), brief, organization });
  assert.equal(calls[0].url, "https://api.cohere.com/v2/chat");
  assert.equal(calls[0].options.headers.Authorization, "Bearer co-test");
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
  assert.equal(receipt.servedModel, "command-a-03-2025");
  assert.deepEqual(receipt.usage, { input: 12, output: 34, total: 46 });
  assert.equal(generation.canonical, "Shared message");
});

test("cloudflare: the account id builds the URL and the token is the bearer", async () => {
  const calls = mockFetch(() => chatReply());
  await generateDrafts({ credentials: credsFor("cloudflare"), brief, organization });
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1/chat/completions");
  assert.equal(calls[0].options.headers.Authorization, "Bearer cftoken");
});

test("cloudflare: a key without the account:token shape never reaches the network", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response("{}"); };
  await assert.rejects(
    () => generateDrafts({ credentials: credsFor("cloudflare", { keys: { cloudflare: "no-colon" } }), brief, organization }),
    (e) => e instanceof ProviderError && /account-id:API-token/.test(e.message)
  );
  assert.equal(called, false);
  await assert.rejects(
    () => listModels({ provider: "cloudflare", apiKey: "no-colon" }),
    (e) => /account-id:API-token/.test(e.message)
  );
});

test("github: retired, so generation and listing fail clearly without a request", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response("{}"); };
  await assert.rejects(
    () => generateDrafts({ credentials: credsFor("github"), brief, organization }),
    (e) => e instanceof ProviderError && /retired/i.test(e.message)
  );
  await assert.rejects(
    () => listModels({ provider: "github", apiKey: "github_pat_test" }),
    (e) => e instanceof ProviderError && /retired/i.test(e.message)
  );
  assert.equal(called, false, "a retired provider must not spend a round trip");
});

test("a CORS block or offline machine is reported as unreachable, not as bad data", async () => {
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(
    () => generateDrafts({ credentials: credsFor("nvidia"), brief, organization }),
    (e) => e instanceof ProviderError && /Could not reach/i.test(e.message)
  );
});

test("gateway HTTP failures map onto the same actionable messages as the core three", async () => {
  for (const [status, pattern] of [[401, /rejected that API key/i], [404, /model id was not found/i],
                                   [410, /retired/i], [429, /Rate limited/i], [500, /having trouble/i]]) {
    mockFetch(() => ({ status, payload: { error: { message: "raw" } } }));
    await assert.rejects(
      () => generateDrafts({ credentials: credsFor("groq"), brief, organization }),
      (e) => e instanceof ProviderError && pattern.test(e.message) && e.status === status
    );
  }
});

test("an empty or non-JSON gateway reply is a clean error, not a crash", async () => {
  mockFetch(() => ({ payload: { id: "x", model: "m", choices: [{ message: { content: "" } }] } }));
  await assert.rejects(
    () => generateDrafts({ credentials: credsFor("groq"), brief, organization }),
    (e) => e instanceof ProviderError && /empty reply/i.test(e.message)
  );
  mockFetch(() => ({ payload: { id: "x", model: "m", choices: [{ message: { content: "not json" } }] } }));
  await assert.rejects(
    () => generateDrafts({ credentials: credsFor("groq"), brief, organization }),
    (e) => e instanceof ProviderError && /structured draft data/i.test(e.message)
  );
});

test("a markdown-fenced gateway reply still parses", async () => {
  mockFetch(() => ({
    payload: { id: "x", model: "m", choices: [{ message: { content: "```json\n" + JSON.stringify(goodPackage) + "\n```" } }] }
  }));
  const { generation } = await generateDrafts({ credentials: credsFor("cerebras"), brief, organization });
  assert.equal(generation.canonical, "Shared message");
});

/* ---------------- model discovery ---------------- */

test("groq discovery: parses data[].id and drops non-text endpoints", async () => {
  const calls = mockFetch(() => ({ payload: { data: [
    { id: "llama-3.3-70b-versatile", created: 3 },
    { id: "whisper-large-v3", created: 2 },
    { id: "text-embedding-3-small", created: 1 }
  ] } }));
  const { models } = await listModels({ provider: "groq", apiKey: "gsk_test" });
  assert.equal(calls[0].url, "https://api.groq.com/openai/v1/models");
  assert.equal(calls[0].options.headers.Authorization, "Bearer gsk_test");
  const ids = models.map((m) => m.id);
  assert.ok(ids.includes("llama-3.3-70b-versatile"));
  assert.ok(!ids.includes("whisper-large-v3"), "audio model hidden");
  assert.ok(!ids.includes("text-embedding-3-small"), "embedding model hidden");
});

test("mistral discovery: drops models the vendor flags as non-chat", async () => {
  mockFetch(() => ({ payload: { data: [
    { id: "mistral-large-latest", created: 2, capabilities: { completion_chat: true } },
    { id: "mistral-embed", created: 1, capabilities: { completion_chat: false } }
  ] } }));
  const { models } = await listModels({ provider: "mistral", apiKey: "mist-test" });
  assert.deepEqual(models.map((m) => m.id), ["mistral-large-latest"]);
});

test("cloudflare discovery: per-account search endpoint, result[].name", async () => {
  const calls = mockFetch(() => ({ payload: { success: true, result: [
    { name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }, { name: "@cf/meta/llama-3.1-8b-instruct" }
  ] } }));
  const { models } = await listModels({ provider: "cloudflare", apiKey: "acct123:cftoken" });
  assert.match(calls[0].url, /\/accounts\/acct123\/ai\/models\/search\?/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer cftoken");
  assert.deepEqual(models.map((m) => m.id), ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct"]);
});

test("cohere discovery: /v1/models filtered to chat, models[].name", async () => {
  const calls = mockFetch(() => ({ payload: { models: [
    { name: "command-a-03-2025" }, { name: "command-r-plus-08-2024" }
  ] } }));
  const { models } = await listModels({ provider: "cohere", apiKey: "co-test" });
  assert.match(calls[0].url, /api\.cohere\.com\/v1\/models\?/);
  assert.match(calls[0].url, /endpoint=chat/);
  assert.deepEqual(models.map((m) => m.id), ["command-a-03-2025", "command-r-plus-08-2024"]);
});

test("huggingface discovery: newest-first from the router catalogue", async () => {
  mockFetch(() => ({ payload: { data: [
    { id: "meta-llama/Llama-3.3-70B-Instruct", created: 10 },
    { id: "openai/gpt-oss-120b", created: 20 }
  ] } }));
  const { models } = await listModels({ provider: "huggingface", apiKey: "hf_test" });
  assert.deepEqual(models.map((m) => m.id), ["openai/gpt-oss-120b", "meta-llama/Llama-3.3-70B-Instruct"]);
});

test("a missing gateway key never reaches the network", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response("{}"); };
  await assert.rejects(
    () => generateDrafts({ credentials: credsFor("groq", { keys: { groq: "" } }), brief, organization }),
    (e) => e instanceof ProviderError && /API key/i.test(e.message)
  );
  await assert.rejects(() => listModels({ provider: "groq", apiKey: "" }),
    (e) => e instanceof ProviderError && /API key/i.test(e.message));
  assert.equal(called, false);
});
