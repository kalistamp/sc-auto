import test from "node:test";
import assert from "node:assert/strict";
import { PROMPT_VERSION, ProviderError, generateDrafts, modelsMatch, receiptState } from "../js/providers.js";

/* ------------------------------------------------------------
   A recording fetch. Every test asserts on the request that was
   built as well as the receipt that came back, because the whole
   point of this module is that the receipt is trustworthy.
   ------------------------------------------------------------ */

function mockFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const { status = 200, payload = {} } = responder(url, JSON.parse(options.body)) || {};
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
  campaignAngle: "angle",
  canonical: "Shared message",
  warnings: [],
  variants: [
    { platform: "facebook", title: "", body: "FB body", hashtags: ["EWaste"], notes: "" },
    { platform: "reddit", title: "R title", body: "R body", hashtags: [], notes: "check rules" }
  ]
};

const credentialsFor = (provider, patch = {}) => ({
  provider,
  effort: "",
  keys: { anthropic: "sk-ant-test", openai: "sk-test", gemini: "AIza-test" },
  models: { anthropic: "claude-opus-5", openai: "gpt-5.6-luna", gemini: "gemini-3.6-flash" },
  ...patch
});

test("Anthropic: request shape, and the receipt records what actually answered", async () => {
  const calls = mockFetch(() => ({
    payload: {
      id: "msg_01",
      model: "claude-opus-5-20260317",
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(goodPackage) }],
      usage: { input_tokens: 120, output_tokens: 340 }
    }
  }));

  const { generation, receipt } = await generateDrafts({ credentials: credentialsFor("anthropic"), brief, organization });

  const call = calls[0];
  assert.equal(call.url, "https://api.anthropic.com/v1/messages");
  assert.equal(call.options.headers["x-api-key"], "sk-ant-test");
  assert.equal(call.options.headers["anthropic-version"], "2023-06-01");
  assert.equal(call.options.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(call.body.output_config.format.type, "json_schema");
  assert.ok(call.body.max_tokens >= 16000, "thinking and text share max_tokens, so it needs headroom");
  assert.equal(call.body.output_config.effort, undefined, "effort is omitted unless chosen; older models reject it");

  assert.equal(receipt.requestedModel, "claude-opus-5");
  assert.equal(receipt.servedModel, "claude-opus-5-20260317");
  assert.equal(receipt.provider, "anthropic");
  assert.equal(receipt.promptVersion, PROMPT_VERSION);
  assert.equal(receipt.responseId, "msg_01");
  assert.deepEqual(receipt.usage, { input: 120, output: 340, total: 460 });
  assert.ok(receipt.latencyMs >= 0);

  assert.deepEqual(generation.variants.map((v) => v.platform), ["reddit", "facebook"],
    "variants come back in the order the operator asked for");
  assert.equal(generation.variants[1].hashtags[0], "EWaste");
});

test("Anthropic: effort is sent only when explicitly chosen", async () => {
  const calls = mockFetch(() => ({
    payload: { id: "m", model: "claude-opus-5", content: [{ type: "text", text: JSON.stringify(goodPackage) }] }
  }));
  await generateDrafts({ credentials: credentialsFor("anthropic", { effort: "low" }), brief, organization });
  assert.equal(calls[0].body.output_config.effort, "low");
});

test("Anthropic: a refusal or a truncated reply is reported as such, not as bad JSON", async () => {
  mockFetch(() => ({ payload: { stop_reason: "refusal", stop_details: { explanation: "declined" }, content: [] } }));
  await assert.rejects(
    () => generateDrafts({ credentials: credentialsFor("anthropic"), brief, organization }),
    (error) => error instanceof ProviderError && /declined/i.test(error.message)
  );

  mockFetch(() => ({ payload: { stop_reason: "max_tokens", content: [{ type: "text", text: "{\"canoni" }] } }));
  await assert.rejects(
    () => generateDrafts({ credentials: credentialsFor("anthropic"), brief, organization }),
    (error) => /cut off/i.test(error.message)
  );
});

test("OpenAI: reads output_text and reports the served model", async () => {
  const calls = mockFetch(() => ({
    payload: { id: "resp_1", model: "gpt-5.6-luna-2026-01-01", output_text: JSON.stringify(goodPackage), usage: { input_tokens: 5, output_tokens: 6 } }
  }));
  const { receipt } = await generateDrafts({ credentials: credentialsFor("openai"), brief, organization });
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0].options.headers.Authorization, "Bearer sk-test");
  assert.equal(calls[0].body.text.format.strict, true);
  assert.equal(receipt.servedModel, "gpt-5.6-luna-2026-01-01");
  assert.deepEqual(receipt.usage, { input: 5, output: 6, total: 11 });
});

test("OpenAI: falls back to the structured output blocks when output_text is absent", async () => {
  mockFetch(() => ({
    payload: { id: "r", model: "m", output: [{ content: [{ type: "output_text", text: JSON.stringify(goodPackage) }] }] }
  }));
  const { generation } = await generateDrafts({ credentials: credentialsFor("openai"), brief, organization });
  assert.equal(generation.canonical, "Shared message");
});

test("Gemini: gets a schema without additionalProperties, and modelVersion is the served model", async () => {
  const calls = mockFetch(() => ({
    payload: {
      modelVersion: "gemini-3.6-flash-002",
      candidates: [{ content: { parts: [{ text: JSON.stringify(goodPackage) }] } }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22 }
    }
  }));
  const { receipt } = await generateDrafts({ credentials: credentialsFor("gemini"), brief, organization });

  assert.match(calls[0].url, /gemini-3\.6-flash:generateContent$/);
  assert.equal(calls[0].options.headers["x-goog-api-key"], "AIza-test");
  const schemaText = JSON.stringify(calls[0].body.generationConfig.responseSchema);
  assert.ok(!schemaText.includes("additionalProperties"), "Gemini's dialect rejects keys it does not know");
  assert.ok(schemaText.includes("campaignAngle"), "the rest of the contract survives the strip");
  assert.equal(receipt.servedModel, "gemini-3.6-flash-002");
  assert.deepEqual(receipt.usage, { input: 11, output: 22, total: 33 });
});

test("a markdown-fenced reply still parses", async () => {
  mockFetch(() => ({
    payload: { id: "m", model: "claude-opus-5", content: [{ type: "text", text: "```json\n" + JSON.stringify(goodPackage) + "\n```" }] }
  }));
  const { generation } = await generateDrafts({ credentials: credentialsFor("anthropic"), brief, organization });
  assert.equal(generation.canonical, "Shared message");
});

test("a missing key never reaches the network", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; };
  await assert.rejects(
    () => generateDrafts({ credentials: credentialsFor("anthropic", { keys: { anthropic: "" } }), brief, organization }),
    (error) => error instanceof ProviderError && /API key/i.test(error.message)
  );
  assert.equal(called, false);
});

test("a skipped platform is an error naming the platform", async () => {
  mockFetch(() => ({
    payload: { id: "m", model: "m", content: [{ type: "text", text: JSON.stringify({ ...goodPackage, variants: [goodPackage.variants[0]] }) }] }
  }));
  await assert.rejects(
    () => generateDrafts({ credentials: credentialsFor("anthropic"), brief, organization }),
    (error) => /skipped reddit/i.test(error.message)
  );
});

test("HTTP failures are translated into something a person can act on", async () => {
  for (const [status, pattern] of [[401, /rejected that API key/i], [404, /model id was not found/i], [429, /Rate limited/i], [500, /having trouble/i]]) {
    mockFetch(() => ({ status, payload: { error: { message: "raw provider text" } } }));
    await assert.rejects(
      () => generateDrafts({ credentials: credentialsFor("anthropic"), brief, organization }),
      (error) => error instanceof ProviderError && pattern.test(error.message) && error.status === status
    );
  }
});

test("the instructions carry the org's facts and rules and nothing invented", async () => {
  const calls = mockFetch(() => ({
    payload: { id: "m", model: "m", content: [{ type: "text", text: JSON.stringify(goodPackage) }] }
  }));
  await generateDrafts({ credentials: credentialsFor("anthropic"), brief, organization });
  const system = calls[0].body.system;
  assert.match(system, /Pickup is free\./);
  assert.match(system, /No invented numbers\./);
  assert.match(system, /Never invent statistics/);
});

/* ------------------------------------------------------------
   A ONE-LINE BRIEF, AND A SECOND PASS OVER IT
   ------------------------------------------------------------ */

test("a one-line brief is sent whole, and the model is told to fill in the rest", async () => {
  const calls = mockFetch(() => ({
    payload: { id: "m", model: "m", content: [{ type: "text", text: JSON.stringify(goodPackage) }] }
  }));

  await generateDrafts({
    credentials: credentialsFor("anthropic"),
    brief: { topic: "Old laptops in closets", platforms: ["reddit", "facebook"], guidance: {} },
    organization
  });

  const call = calls[0];
  assert.match(call.body.system, /Filling in the brief/);
  assert.match(call.body.system, /may be a single line/i);
  assert.doesNotMatch(call.body.system, /Rewriting/, "a first pass has nothing to rewrite");

  const input = JSON.parse(call.body.messages[0].content);
  assert.equal(input.brief.topic, "Old laptops in closets");
  assert.equal(input.brief.audience, "", "an empty field is sent as empty rather than guessed at here");
  assert.equal(input.sharedMessage, undefined);

  /* The three fields the operator no longer has to type have to be part
     of the contract, or there is nothing to fill the blanks with. */
  const schema = call.body.output_config.format.schema;
  for (const field of ["campaignName", "audience", "objective"]) {
    assert.ok(schema.required.includes(field), `${field} must be required of the model`);
    assert.ok(schema.properties[field], `${field} must be in the output schema`);
  }
});

test("a re-run passes the edited shared message as the steer and the old drafts as what not to repeat", async () => {
  const calls = mockFetch(() => ({
    payload: { id: "m", model: "m", content: [{ type: "text", text: JSON.stringify(goodPackage) }] }
  }));

  await generateDrafts({
    credentials: credentialsFor("anthropic"),
    brief: {
      topic: "Old laptops", platforms: ["reddit", "facebook"], guidance: {},
      sharedMessage: "Lead with the free pickup, not the students.",
      previousDrafts: [{ platform: "reddit", copy: "The first attempt" }]
    },
    organization
  });

  const call = calls[0];
  assert.match(call.body.system, /Rewriting/);
  assert.match(call.body.system, /Do not repeat it sentence by sentence/);

  const input = JSON.parse(call.body.messages[0].content);
  assert.equal(input.sharedMessage, "Lead with the free pickup, not the students.");
  assert.equal(input.previousDrafts[0].copy, "The first attempt");
});

test("alias resolution counts as a match; a genuine swap does not", () => {
  assert.equal(modelsMatch("claude-opus-5", "claude-opus-5-20260317"), true);
  assert.equal(modelsMatch("claude-opus-5", "claude-opus-5"), true);
  assert.equal(modelsMatch("claude-opus-5", "claude-opus-4-8"), false);
  assert.equal(modelsMatch("claude-opus-5", ""), false, "no report is not the same as agreement");
  assert.equal(modelsMatch("", "claude-opus-5"), false);
});

test("receipt state distinguishes verified, swapped, unreported and hand-written", () => {
  assert.equal(receiptState({ provider: "anthropic", requestedModel: "claude-opus-5", servedModel: "claude-opus-5-20260317" }), "ok");
  assert.equal(receiptState({ provider: "anthropic", requestedModel: "claude-opus-5", servedModel: "claude-opus-4-8" }), "swapped");
  assert.equal(receiptState({ provider: "openai", requestedModel: "gpt-5.6-luna", servedModel: "" }), "unknown");
  assert.equal(receiptState({ provider: "none" }), "manual");
  assert.equal(receiptState(null), "manual");
});
