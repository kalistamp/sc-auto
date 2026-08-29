/* ============================================================
   SAFE CYCLE STUDIO — frontier model gateway

   Three provider adapters behind one call, plus a fourth job on the
   side: asking each provider which models the entered key can actually
   use, so the model picker in Cloud sync is a list the provider gave us
   rather than a list this file was written believing.

   Each generation returns the same normalized draft package plus a
   RECEIPT: provider, the model that was asked for, the model that
   actually answered, prompt version, response id, token usage, and
   latency.

   The receipt is the point. "Which model wrote this" should be a
   recorded fact, not a label typed into a settings box — a provider
   can resolve a family alias to a dated snapshot, or serve a different
   model than the one requested, and the record has to show that
   rather than repeat what was asked for.

   Calls go straight from the browser. That is a deliberate trade: this
   project has no server, so the keys live in your browser instead of
   in a backend you would have to run. The unused worker/ directory is
   there if that trade ever stops being the right one.
   ============================================================ */

import { getPlatform } from "./data.js";
import { PROVIDERS } from "./settings.js";
import { ctaRules, stripSignOff } from "./signature.js";
import { exemplarSection, voiceRules } from "./voice.js";

/* Bump when the instructions or output contract change, so an old post's
   receipt still says which prompt produced it.

   CHANGE (2026-08): sct-social-4 → sct-social-5
   Reason: voiceRules() was substantially rewritten (positive human-habits
   first, expanded lexicon, new constructions/openers, smoothness check).
   Old receipts must continue to report the prompt that actually produced
   them; new generations get the new version string.

   CHANGE (2026-08c): sct-social-5 → sct-social-6
   Reason: the brief shrank to a single line. The model is now asked to
   supply the campaign name, audience and objective itself when the
   operator did not, and to work from a steer plus the previous drafts on
   a re-run. Both change what the instructions say, so the version moves
   with them.

   CHANGE (2026-08d): sct-social-6 → sct-social-7
   Reason: a fixed call to action is now appended to every post after
   generation, so the instructions tell the model NOT to write a sign-off
   or any contact details — the opposite of what earlier versions left it
   free to do. A receipt from before this change describes a prompt that
   allowed both. See js/signature.js. */
export const PROMPT_VERSION = "sct-social-7";

export class ProviderError extends Error {
  constructor(message, { status = 0, hint = "" } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.hint = hint;
  }
}

/* ------------------------------------------------------------
   PUBLIC ENTRY POINT
   ------------------------------------------------------------ */

export async function generateDrafts({ credentials, brief, organization, recentPosts = [], signal }) {
  const provider = credentials.provider;
  const meta = PROVIDERS[provider];
  if (!meta) throw new ProviderError(`Unknown provider: ${provider}.`);

  const apiKey = credentials.keys?.[provider] || "";
  if (!apiKey) {
    throw new ProviderError(`No ${meta.label} API key on this device.`, {
      hint: "Open Cloud sync and paste a key. Keys are stored in this browser only."
    });
  }

  const requestedModel = (credentials.models?.[provider] || meta.defaultModel).trim();
  if (!requestedModel) throw new ProviderError(`Choose a ${meta.label} model in Cloud sync.`);

  const instructions = buildInstructions(organization, brief, recentPosts);
  const input = JSON.stringify({
    brief: {
      /* The only field the operator has to fill in. Everything under it
         may be an empty string, and an empty string means "you decide"
         rather than "leave it out" — see buildInstructions. */
      topic: brief.topic || brief.keyMessage || "",
      campaign: brief.campaign || "",
      objective: brief.objective || "",
      audience: brief.audience || "",
      keyMessage: brief.keyMessage || "",
      tone: brief.tone || "",
      platforms: brief.platforms,
      mustInclude: brief.mustInclude || ""
    },
    /* Present only on a re-run: the message the operator edited by hand
       and the drafts they were not happy with. */
    ...(brief.sharedMessage ? { sharedMessage: brief.sharedMessage } : {}),
    ...(brief.previousDrafts?.length ? { previousDrafts: brief.previousDrafts } : {}),
    /* Recent copy goes in so the model can deliberately vary its
       phrasing instead of rewriting last week's post. */
    recentlyPublished: recentPosts.slice(0, 12).map((post) => ({
      campaign: post.campaign,
      copy: (post.canonical || "").slice(0, 400)
    }))
  });

  const schema = generationSchema(brief.platforms);
  const started = performance.now();

  let raw;
  if (provider === "anthropic") raw = await callAnthropic({ apiKey, model: requestedModel, instructions, input, schema, effort: credentials.effort, signal });
  else if (provider === "openai") raw = await callOpenAI({ apiKey, model: requestedModel, instructions, input, schema, signal });
  else if (provider === "gemini") raw = await callGemini({ apiKey, model: requestedModel, instructions, input, schema, signal });
  else if (provider === "cohere") raw = await callCohere({ apiKey, model: requestedModel, instructions, input, schema, signal });
  else raw = await callOpenAICompatible({ provider, apiKey, model: requestedModel, instructions, input, schema, signal });

  return {
    generation: cleanGeneration(raw.generation, brief.platforms, organization),
    receipt: {
      provider,
      providerLabel: meta.label,
      requestedModel,
      /* Fall back to the requested id only when the provider genuinely
         told us nothing — never invent agreement. */
      servedModel: raw.servedModel || "",
      promptVersion: PROMPT_VERSION,
      responseId: raw.responseId || "",
      usage: raw.usage || null,
      latencyMs: Math.round(performance.now() - started),
      at: new Date().toISOString()
    }
  };
}

/* True when the model that answered is the model that was asked for.
   An empty servedModel means the provider did not say, which is a third
   state — "unverified" — and must not be reported as a match. */
export function receiptState(ai) {
  if (!ai || ai.provider === "none") return "manual";
  if (!ai.servedModel) return "unknown";
  return modelsMatch(ai.requestedModel, ai.servedModel) ? "ok" : "swapped";
}

/* Providers routinely resolve a family alias to a dated snapshot
   (`claude-opus-5` → `claude-opus-5-20260317`). That is the same model,
   not a substitution, so treat a shared prefix as a match. */
export function modelsMatch(requested, served) {
  const a = String(requested || "").toLowerCase();
  const b = String(served || "").toLowerCase();
  if (!a || !b) return false;
  return a === b || b.startsWith(a) || a.startsWith(b);
}

/* ------------------------------------------------------------
   ADAPTERS
   ------------------------------------------------------------ */

async function callAnthropic({ apiKey, model, instructions, input, schema, effort, signal }) {
  const body = {
    model,
    /* Generous, because on current Claude models max_tokens caps
       thinking and response text together — a tight budget truncates
       the JSON mid-object and the parse fails for no visible reason. */
    max_tokens: 16000,
    system: instructions,
    messages: [{ role: "user", content: input }],
    output_config: { format: { type: "json_schema", schema } }
  };
  /* Only sent when explicitly chosen: `effort` is rejected by older
     models, and the default (high) works everywhere. */
  if (effort) body.output_config.effort = effort;

  const payload = await request("https://api.anthropic.com/v1/messages", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body, signal
  });

  if (payload.stop_reason === "refusal") {
    throw new ProviderError("The model declined this request.", {
      hint: payload.stop_details?.explanation || "Rephrase the brief and try again."
    });
  }
  if (payload.stop_reason === "max_tokens") {
    throw new ProviderError("The reply was cut off before the drafts were complete.", {
      hint: "Shorten the brief, or lower the reasoning effort in Cloud sync."
    });
  }

  const text = (payload.content || []).filter((block) => block.type === "text").map((block) => block.text).join("");
  return {
    generation: parseGeneration(text),
    servedModel: payload.model || "",
    responseId: payload.id || "",
    usage: normalizeUsage(payload.usage?.input_tokens, payload.usage?.output_tokens)
  };
}

async function callOpenAI({ apiKey, model, instructions, input, schema, signal }) {
  const payload = await request("https://api.openai.com/v1/responses", {
    headers: { Authorization: `Bearer ${apiKey}` },
    body: {
      model, instructions, input,
      text: { format: { type: "json_schema", name: "social_post_package", strict: true, schema } },
      store: false
    },
    signal
  });

  const text = payload.output_text
    || (payload.output || [])
      .flatMap((item) => item.content || [])
      .filter((part) => part.type === "output_text")
      .map((part) => part.text)
      .join("");

  return {
    generation: parseGeneration(text),
    servedModel: payload.model || "",
    responseId: payload.id || "",
    usage: normalizeUsage(payload.usage?.input_tokens, payload.usage?.output_tokens)
  };
}

async function callGemini({ apiKey, model, instructions, input, schema, signal }) {
  const payload = await request(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      headers: { "x-goog-api-key": apiKey },
      body: {
        system_instruction: { parts: [{ text: instructions }] },
        contents: [{ role: "user", parts: [{ text: input }] }],
        /* Gemini's schema dialect is an OpenAPI subset that does not
           accept `additionalProperties`, so it gets its own copy. */
        generationConfig: { responseMimeType: "application/json", responseSchema: stripUnsupported(schema) }
      },
      signal
    }
  );

  const text = (payload.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("");
  const usage = payload.usageMetadata;
  return {
    generation: parseGeneration(text),
    servedModel: payload.modelVersion || "",
    responseId: payload.responseId || "",
    usage: normalizeUsage(usage?.promptTokenCount, usage?.candidatesTokenCount)
  };
}

/* ------------------------------------------------------------
   OPENAI-COMPATIBLE GATEWAYS

   Nine of the twelve providers speak OpenAI's /chat/completions verbatim, so
   one adapter serves them all and each entry below is only what differs: the
   base URL and how that vendor lists its models. They are kept apart from the
   `openai` adapter above on purpose — that one talks to /v1/responses and
   enforces the schema natively, which none of these do.

   Structured output here is `response_format: { type: "json_object" }` rather
   than a strict json_schema. json_object is the one mode every gateway in this
   set accepts (a strict schema is supported only by some of them, and by only
   some models behind the pass-through providers), so it is the choice that
   works everywhere. It guarantees valid JSON but not the right SHAPE, so the
   shape is supplied to the model in the prompt — see schemaInstruction — and
   the existing parse/clean layer rejects anything that still comes back wrong.
   ------------------------------------------------------------ */

const GATEWAYS = {
  groq:        { base: "https://api.groq.com/openai/v1" },
  cerebras:    { base: "https://api.cerebras.ai/v1" },
  openrouter:  { base: "https://openrouter.ai/api/v1" },
  mistral:     { base: "https://api.mistral.ai/v1", listUsesCapabilities: true },
  huggingface: { base: "https://router.huggingface.co/v1" }
};

/* Cloudflare Workers AI and NVIDIA NIM were removed 2026-08 — both answer no
   CORS headers, so a browser could never reach them from this static site
   without a proxy in front, and there is no such proxy today. GitHub Models
   was removed the same day for a different reason: it was retired 2026-07-30
   and every request now answers 410, permanently.

   The `perAccount` mechanism below (Cloudflare's "account-id:API-token"
   credential split) is left in place rather than deleted with the entry: it
   is generic gateway machinery, unreachable only because no GATEWAYS entry
   sets the flag, and correct as-is whenever Cloudflare is added back — no
   rewrite, just a GATEWAYS entry and a PROVIDERS entry in settings.js. */

/* Cloudflare stores its credential as "account-id:API-token". Tokens carry no
   colon and account ids are hex, so splitting on the first colon is safe. */
function cloudflareAccount(apiKey) {
  const raw = String(apiKey || "");
  const at = raw.indexOf(":");
  if (at < 1) return null;
  const id = raw.slice(0, at).trim();
  const token = raw.slice(at + 1).trim();
  return id && token ? { id, token } : null;
}

/* The shape, handed to the model in words because json_object mode enforces
   "valid JSON" but not "this schema". The word JSON has to appear for
   json_object mode to engage, which it does here. */
function schemaInstruction(schema) {
  return `Return ONE JSON object and nothing else — no prose, no markdown fence. It must match this JSON Schema exactly; every listed property is required:\n${JSON.stringify(schema)}`;
}

async function callOpenAICompatible({ provider, apiKey, model, instructions, input, schema, signal }) {
  const gateway = GATEWAYS[provider];
  if (!gateway) throw new ProviderError(`Unknown provider: ${provider}.`);

  let url = `${gateway.base}/chat/completions`;
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (gateway.perAccount) {
    const account = cloudflareAccount(apiKey);
    if (!account) {
      throw new ProviderError("Cloudflare Workers AI needs its key entered as account-id:API-token.", {
        hint: "The account id is in your Cloudflare dashboard URL; the API token is created under My Profile → API Tokens."
      });
    }
    url = `${gateway.base}/${encodeURIComponent(account.id)}/ai/v1/chat/completions`;
    headers.Authorization = `Bearer ${account.token}`;
  }

  const payload = await request(url, {
    headers,
    body: {
      model,
      messages: [
        { role: "system", content: `${instructions}\n\n${schemaInstruction(schema)}` },
        { role: "user", content: input }
      ],
      /* No temperature and no max_tokens: several models behind these gateways
         reject a non-default temperature, and a request a gateway refuses reads
         to the operator as a dead model. Let each model apply its own. */
      response_format: { type: "json_object" }
    },
    signal
  });

  const message = payload.choices?.[0]?.message;
  const text = typeof message?.content === "string"
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.map((part) => (part && (part.text || part.output_text)) || "").join("")
      : "";

  return {
    generation: parseGeneration(text),
    servedModel: payload.model || "",
    responseId: payload.id || "",
    usage: normalizeUsage(payload.usage?.prompt_tokens, payload.usage?.completion_tokens)
  };
}

/* Cohere borrows OpenAI's request shape but not its reply: /v2/chat returns a
   single `message` whose text arrives as content blocks, and its token counts
   sit one level deeper under usage.tokens. */
async function callCohere({ apiKey, model, instructions, input, schema, signal }) {
  const payload = await request("https://api.cohere.com/v2/chat", {
    headers: { Authorization: `Bearer ${apiKey}` },
    body: {
      model,
      messages: [
        { role: "system", content: `${instructions}\n\n${schemaInstruction(schema)}` },
        { role: "user", content: input }
      ],
      response_format: { type: "json_object" }
    },
    signal
  });

  const content = payload.message?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((block) => block && block.type === "text").map((block) => block.text || "").join("")
      : "";

  const tokens = payload.usage?.tokens || {};
  return {
    generation: parseGeneration(text),
    /* Cohere does not echo the served model, so this stays empty and the
       receipt honestly reports "unverified" rather than inventing a match. */
    servedModel: payload.model || "",
    responseId: payload.id || "",
    usage: normalizeUsage(tokens.input_tokens, tokens.output_tokens)
  };
}

/* ------------------------------------------------------------
   MODEL DISCOVERY

   Every provider publishes what a key may use, and that answer is the
   only trustworthy one: model access is a property of the key's account
   and project, it changes without warning, and a list maintained here
   would start rotting the day it was written.

   Listing also authenticates. A 200 from any of these three endpoints
   means the key reached the provider and was accepted, which is exactly
   what "test this key" has to establish — and it establishes it without
   spending a single token on a throwaway generation.
   ------------------------------------------------------------ */

/* Pages, not models. Each request already asks for the maximum page size,
   so this only exists so a provider that keeps handing back a cursor
   cannot spin here forever. */
const LIST_PAGE_CAP = 5;

export async function listModels({ provider, apiKey, signal }) {
  const meta = PROVIDERS[provider];
  if (!meta) throw new ProviderError(`Unknown provider: ${provider}.`);

  const key = String(apiKey || "").trim();
  if (!key) {
    throw new ProviderError(`Enter a ${meta.label} API key first.`, {
      hint: "The model list comes from the provider, so there has to be a key to ask with."
    });
  }

  let models;
  if (provider === "anthropic") models = await anthropicModels(key, signal);
  else if (provider === "openai") models = await openaiModels(key, signal);
  else if (provider === "gemini") models = await geminiModels(key, signal);
  else if (provider === "cohere") models = await cohereModels(key, signal);
  else models = await gatewayModels(provider, key, signal);

  models = dedupeModels(models);
  if (!models.length) {
    throw new ProviderError(`${meta.label} accepted the key but listed no usable models.`, {
      hint: "The key may belong to a project with no text model access enabled yet."
    });
  }
  return { provider, models, fetchedAt: new Date().toISOString() };
}

/* Anthropic returns newest first and every entry is a text model, so the
   order it gives is the order to show. */
async function anthropicModels(apiKey, signal) {
  const out = [];
  let afterId = "";

  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const url = new URL("https://api.anthropic.com/v1/models");
    url.searchParams.set("limit", "1000");
    if (afterId) url.searchParams.set("after_id", afterId);

    const payload = await request(url.toString(), {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      describe: describeListStatus,
      signal
    });

    for (const entry of payload.data || []) {
      if (!entry?.id) continue;
      out.push({ id: entry.id, label: entry.display_name || entry.id });
    }
    if (!payload.has_more || !payload.last_id) break;
    afterId = payload.last_id;
  }
  return out;
}

/* OpenAI's list is everything on the account — embeddings, speech,
   images, moderation — and none of those can write a social post.
   Offering them would only be a way to pick a model that fails later, at
   generation time, for a reason the picker already knew about. */
const OPENAI_NOT_TEXT = /embedding|moderation|transcribe|whisper|dall-e|sora|tts|-audio|-image|-realtime|^davinci-|^babbage-/i;

async function openaiModels(apiKey, signal) {
  const payload = await request("https://api.openai.com/v1/models", {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
    describe: describeListStatus,
    signal
  });

  /* `created` is a unix timestamp; newest first puts the model someone is
     most likely reaching for at the top of a long list. */
  const all = (payload.data || [])
    .filter((entry) => entry?.id)
    .sort((a, b) => Number(b.created || 0) - Number(a.created || 0));

  const usable = all.filter((entry) => !OPENAI_NOT_TEXT.test(entry.id));
  /* If that pattern ever matches everything — a naming change at OpenAI
     would do it — a noisy picker beats an empty one. */
  return (usable.length ? usable : all).map((entry) => ({ id: entry.id, label: entry.id }));
}

async function geminiModels(apiKey, signal) {
  const out = [];
  let pageToken = "";

  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const payload = await request(url.toString(), {
      method: "GET",
      headers: { "x-goog-api-key": apiKey },
      describe: describeListStatus,
      signal
    });

    for (const entry of payload.models || []) {
      /* Embedding and token-counting models arrive in the same list and
         cannot answer a generateContent call. */
      if (!(entry?.supportedGenerationMethods || []).includes("generateContent")) continue;
      /* callGemini() builds `models/${id}:generateContent`, so what gets
         stored has to be the bare id without that prefix. */
      const id = String(entry.name || "").replace(/^models\//, "");
      if (!id) continue;
      out.push({ id, label: entry.displayName || id });
    }

    pageToken = payload.nextPageToken || "";
    if (!pageToken) break;
  }
  return out;
}

/* The OpenAI-compatible gateways all publish { data: [{ id, created }] } at
   {base}/models — except a `perAccount` gateway, whose list is per-account
   and lives at a different path (see cloudflareAccount() above). The same
   not-text deny-list the OpenAI listing uses applies here: it keys on
   non-chat endpoints (embedding, audio, image), not on family names, so a
   "-instruct" chat model is kept. */
async function gatewayModels(provider, apiKey, signal) {
  const gateway = GATEWAYS[provider];
  if (!gateway) throw new ProviderError(`Unknown provider: ${provider}.`);

  let url = `${gateway.base}/models`;
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (gateway.perAccount) {
    const account = cloudflareAccount(apiKey);
    if (!account) {
      throw new ProviderError("Cloudflare Workers AI needs its key entered as account-id:API-token.", {
        hint: "The account id is in your Cloudflare dashboard URL; the API token is created under My Profile → API Tokens."
      });
    }
    url = `${gateway.base}/${encodeURIComponent(account.id)}/ai/models/search`
      + "?per_page=100&task=Text%20Generation&hide_experimental=true";
    headers.Authorization = `Bearer ${account.token}`;
  }

  const payload = await request(url, { method: "GET", headers, describe: describeListStatus, signal });

  /* Cloudflare answers with its own envelope ({ result: [{ name }] }); the rest
     use OpenAI's ({ data: [{ id, created }] }). */
  if (gateway.perAccount) {
    return (payload.result || [])
      .filter((entry) => entry?.name)
      .map((entry) => ({ id: String(entry.name), label: String(entry.name) }));
  }

  let rows = (payload.data || []).filter((entry) => entry?.id);
  /* Mistral publishes per-model capability flags, so its embedding, OCR and
     moderation models are dropped on the vendor's own say-so. */
  if (gateway.listUsesCapabilities) {
    rows = rows.filter((entry) => !entry.capabilities || entry.capabilities.completion_chat !== false);
  }
  rows.sort((a, b) => Number(b.created || 0) - Number(a.created || 0));
  const usable = rows.filter((entry) => !OPENAI_NOT_TEXT.test(entry.id));
  return (usable.length ? usable : rows).map((entry) => ({ id: String(entry.id), label: String(entry.id) }));
}

/* Cohere lists at /v1/models; endpoint=chat is the vendor's own filter, so
   embedding and rerank models never reach the picker. Names carry no timestamp,
   so the order Cohere returns is kept. */
async function cohereModels(apiKey, signal) {
  const out = [];
  let pageToken = "";

  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const url = new URL("https://api.cohere.com/v1/models");
    url.searchParams.set("page_size", "1000");
    url.searchParams.set("endpoint", "chat");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const payload = await request(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      describe: describeListStatus,
      signal
    });

    for (const entry of payload.models || []) {
      if (!entry?.name) continue;
      out.push({ id: String(entry.name), label: String(entry.name) });
    }
    pageToken = payload.next_page_token || "";
    if (!pageToken) break;
  }
  return out;
}

/* Paging can repeat an entry across a page boundary, and a duplicate in a
   picker looks like a bug in the app rather than in the cursor. */
function dedupeModels(models) {
  const seen = new Set();
  return models.filter((model) => (seen.has(model.id) ? false : seen.add(model.id)));
}

/* ------------------------------------------------------------
   TRANSPORT
   ------------------------------------------------------------ */

/* `describe` is a parameter because the same status code means different
   things to the two callers: a 404 from a generation call is a bad model
   id, a 404 from the model list is a bad endpoint, and telling someone to
   fix the wrong one of those wastes their afternoon. */
async function request(url, { method = "POST", headers, body, signal, describe = describeStatus }) {
  const hasBody = body !== undefined;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { ...(hasBody ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
      signal
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    /* A cross-origin block and an offline machine look identical from
       here, so say both rather than guess. */
    throw new ProviderError("Could not reach the model provider.", {
      hint: isOffline()
        ? "This device appears to be offline."
        : "The browser may be blocking the cross-origin request, or the key's project may not allow browser calls."
    });
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error?.message || payload.error?.status || payload.message || "";
    throw new ProviderError(describe(response.status, detail), { status: response.status, hint: detail });
  }
  return payload;
}

/* `navigator` is not guaranteed to exist outside a browser (older Node,
   some embedded webviews), and this file is unit tested. */
function isOffline() {
  return globalThis.navigator?.onLine === false;
}

function describeStatus(status, detail) {
  if (status === 401) return "The provider rejected that API key.";
  if (status === 410) return "This provider has been retired.";
  if (status === 403) return "That key is not allowed to use this model.";
  if (status === 404) return "That model id was not found on this account.";
  if (status === 429) return "Rate limited or out of quota. Wait a moment and try again.";
  if (status >= 500) return "The provider is having trouble right now.";
  return detail ? `The provider refused the request: ${detail}` : `The provider returned ${status}.`;
}

/* The same codes, read as answers to "is this key good?" rather than to
   "did this generation work?". Gemini reports a bad key as a 400 with the
   reason in the body, so that one case is sniffed rather than mapped. */
function describeListStatus(status, detail) {
  if (status === 401) return "The provider rejected that API key.";
  if (status === 410) return "This provider has been retired.";
  if (status === 400 && /api[\s_-]?key/i.test(detail)) return "The provider rejected that API key.";
  if (status === 403) return "That key is not allowed to list models.";
  if (status === 404) return "The provider has no model list at that address.";
  if (status === 429) return "Rate limited or out of quota. Wait a moment and try again.";
  if (status >= 500) return "The provider is having trouble right now.";
  return detail ? `The provider refused the request: ${detail}` : `The provider returned ${status}.`;
}

function normalizeUsage(input, output) {
  const inTok = Number(input || 0);
  const outTok = Number(output || 0);
  if (!inTok && !outTok) return null;
  return { input: inTok, output: outTok, total: inTok + outTok };
}

/* ------------------------------------------------------------
   PROMPT AND OUTPUT CONTRACT
   ------------------------------------------------------------ */

function buildInstructions(organization, brief, recentPosts = []) {
  const facts = (organization.facts || []).map((fact) => `- ${fact}`).join("\n");
  const rules = (organization.prohibitedClaims || []).map((rule) => `- ${rule}`).join("\n");
  /* The key is what the model must echo back in `platform`, so it leads;
     the label is there because "default" means nothing to a reader and
     "Any platform" explains itself. Custom platforms the operator added
     arrive here exactly like the built-in ones. */
  const perPlatform = brief.platforms
    .map((key) => {
      const platform = getPlatform(key);
      const guidance = brief.guidance?.[key] || platform.guidance || "Write it the way that platform's readers expect.";
      const limit = platform.soft ? ` Aim for roughly ${platform.soft} characters or fewer.` : "";
      const title = platform.titleMax ? ` Needs a title of up to ${platform.titleMax} characters.` : "";
      return `- ${key} (${platform.label}): ${guidance}${limit}${title}`;
    })
    .join("\n");

  /* Real published posts first, then the rules. Showing the model what
     this organization sounds like moves output further than any list of
     forbidden words; the rules exist to stop drift away from the
     examples, not to substitute for them. */
  const exemplars = exemplarSection(recentPosts, brief.platforms?.[0] || "");

  /* Not what to write, but what to leave out: the call to action is
     appended verbatim after generation, so the model has to stay off it
     and off the contact details it carries. Empty when no CTA is set, in
     which case the model is told nothing about one. */
  const signature = ctaRules(organization);

  /* THE BRIEF IS ALLOWED TO BE ONE LINE.
     Asking an operator to type an audience, an objective and a key
     message before they can have a draft is asking them to write most of
     the post — at which point they may as well write the post. So the
     form collects a topic and the model is told, in as many words, to
     fill in the rest of the brief itself and to report what it assumed
     so a person can check it. */
  const thin = `Filling in the brief
The brief may be a single line. Where a field is empty, decide it yourself from the topic, the mission and the service area — do not ask for more, and do not stall on a placeholder. Report what you chose in "campaignName", "audience" and "objective" so the operator can see the assumptions and correct them. Where the brief does give a field, follow it exactly; never overwrite it with your own.`;

  /* A re-run. The operator has read what came back once, edited the
     shared message, and pressed the button again — so the shared message
     is now an instruction rather than a summary, and the previous drafts
     are the thing to move away from. */
  const steer = brief.sharedMessage
    ? `\nRewriting
This is a second pass. "sharedMessage" in the input is the operator's own wording of what this post should say, edited by hand after reading the first attempt — treat it as the spine of every version and keep its meaning and emphasis intact.
"previousDrafts" is what you produced last time. Do not repeat it sentence by sentence: change the opening, change the structure, and find a different way in. Keep anything the operator clearly kept on purpose.\n`
    : "";

  return `You write social posts for ${organization.name || "a small nonprofit"}. Produce one canonical message and one distinct draft per platform.

${thin}
${steer}
Organization
Mission: ${organization.mission || ""}
Service area: ${organization.serviceArea || ""}
Voice: ${organization.voice || "Neighborly, practical, and specific."}
Requested tone for this piece: ${brief.tone || "Neighborly and direct"}

Facts you may state
${facts || "- (none recorded)"}

Rules
${rules || "- (none recorded)"}
- Every factual claim must come from the list above or from the brief. Nothing else.
- Never invent statistics, partnerships, events, certifications, testimonials, or details about a person.
- Write for a reader who has never heard of this organization.

Platforms
${perPlatform}
${exemplars ? `\n${exemplars}\n` : ""}
${signature ? `${signature}\n` : ""}
${voiceRules()}

Return only the requested JSON structure. Put anything the operator should check before publishing in "warnings".`;
}

function generationSchema(platforms) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["campaignName", "campaignAngle", "audience", "objective", "canonical", "variants", "warnings"],
    properties: {
      /* Three fields the operator no longer has to type. They are the
         model's reading of a short brief, stored as such and labelled
         that way in the editor. */
      campaignName: { type: "string", description: "A short name for this campaign, three to six words, no quotes." },
      audience: { type: "string", description: "Who this is written for. Echo the brief's audience if it gave one." },
      objective: { type: "string", description: "What this post is meant to achieve. Echo the brief's objective if it gave one." },
      campaignAngle: { type: "string", description: "One sentence naming the angle taken." },
      canonical: { type: "string", description: "The shared message, platform-neutral." },
      warnings: {
        type: "array",
        description: "Anything the operator should verify before publishing.",
        items: { type: "string" }
      },
      variants: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["platform", "title", "body", "hashtags", "notes"],
          properties: {
            platform: { type: "string", enum: platforms },
            title: { type: "string", description: "Only Reddit uses this; empty string elsewhere." },
            body: { type: "string", description: "The post itself, ending with the sign-off described in the instructions." },
            hashtags: { type: "array", items: { type: "string" } },
            notes: { type: "string", description: "A note to the operator, not part of the post." }
          }
        }
      }
    }
  };
}

/* Gemini's dialect rejects keys it does not know. Rather than maintain
   two hand-written schemas that can drift, derive its copy from the one
   above. */
function stripUnsupported(node) {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "additionalProperties") continue;
    out[key] = stripUnsupported(value);
  }
  return out;
}

function parseGeneration(text) {
  if (!text || !text.trim()) throw new ProviderError("The model returned an empty reply.");
  /* Some models wrap JSON in a markdown fence even under a schema
     constraint. Strip it rather than fail on a formatting habit. */
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new ProviderError("The model's reply was not valid structured draft data.", {
      hint: "This usually means the model does not support structured output. Try a different model id."
    });
  }
}

function cleanGeneration(generation, platforms, organization = {}) {
  if (!generation || !Array.isArray(generation.variants)) {
    throw new ProviderError("The model's reply was missing the platform drafts.");
  }
  /* Reorder to match what was requested, and drop anything extra, so
     the editor's cards always appear in the operator's chosen order. */
  const variants = platforms
    .map((platform) => generation.variants.find((variant) => variant.platform === platform))
    .filter(Boolean);

  const missing = platforms.filter((platform) => !variants.some((variant) => variant.platform === platform));
  if (missing.length) {
    throw new ProviderError(`The model skipped ${missing.join(", ")}.`, {
      hint: "Try again, or generate fewer platforms at once."
    });
  }

  return {
    campaignName: String(generation.campaignName || "").trim().replace(/^["']|["']$/g, ""),
    audience: String(generation.audience || "").trim(),
    objective: String(generation.objective || "").trim(),
    campaignAngle: String(generation.campaignAngle || "").trim(),
    canonical: stripSignOff(generation.canonical, organization),
    warnings: Array.isArray(generation.warnings) ? generation.warnings.map(String).filter(Boolean) : [],
    variants: variants.map((variant) => ({
      platform: variant.platform,
      title: String(variant.title || "").trim(),
      /* The model is told not to write a sign-off; this is what happens
         when it does one anyway. Trailing contact details come off here,
         before the draft is ever stored, so the appended CTA cannot end
         up as the post's second copy of the phone number. Anything left
         mid-copy is reported by variantChecks() instead of edited. */
      body: stripSignOff(variant.body, organization),
      hashtags: Array.isArray(variant.hashtags)
        ? variant.hashtags.map((tag) => String(tag).replace(/^#/, "").trim()).filter(Boolean)
        : [],
      notes: String(variant.notes || "").trim()
    }))
  };
}
