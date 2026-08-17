const GIST_API_VERSION = "2022-11-28";
const PROMPT_VERSION = "sct-social-3";
const DEFAULT_MODEL = "gpt-5.6-luna";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(origin, env)) return json({ error: "Origin is not allowed." }, 403, cors);
      return new Response(null, { status: 204, headers: cors });
    }

    if (origin && !isAllowedOrigin(origin, env)) return json({ error: "Origin is not allowed." }, 403, cors);

    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/health" && request.method === "GET") return health(env, cors);
      if (url.pathname === "/api/session" && request.method === "POST") return await createSession(request, env, cors);

      const session = await requireSession(request, env);
      if (!session) return json({ error: "Your session is missing or expired. Sign in again." }, 401, cors);

      if (url.pathname === "/api/data" && request.method === "GET") return await getData(env, cors);
      if (url.pathname === "/api/data" && request.method === "PUT") return await putData(request, env, cors);
      if (url.pathname === "/api/generate" && request.method === "POST") return await generateDrafts(request, env, cors);
      return json({ error: "Route not found." }, 404, cors);
    } catch (error) {
      console.error("Worker request failed", error);
      const status = error.status || 500;
      const publicMessage = status >= 500 ? "The secure worker could not complete the request." : error.message;
      return json({ error: publicMessage, details: status >= 500 ? undefined : error.details }, status, cors);
    }
  }
};

function health(env, headers) {
  return json({
    ok: true,
    service: "safecycle-social-worker",
    configured: {
      gist: Boolean(env.GIST_ID && env.GITHUB_TOKEN),
      openai: Boolean(env.OPENAI_API_KEY),
      auth: Boolean(env.APP_PASSKEY && env.SESSION_SECRET)
    }
  }, 200, headers);
}

async function createSession(request, env, headers) {
  requireEnv(env, ["APP_PASSKEY", "SESSION_SECRET"]);
  const body = await readJson(request);
  if (!body.passkey || !(await constantTimeEqual(String(body.passkey), String(env.APP_PASSKEY)))) {
    return json({ error: "The passkey is not correct." }, 401, headers);
  }
  const now = Math.floor(Date.now() / 1000);
  const hours = clamp(Number(env.SESSION_HOURS || 8), 1, 24);
  const payload = { sub: "safecycle-admin", iat: now, exp: now + hours * 3600 };
  const token = await signToken(payload, env.SESSION_SECRET);
  return json({ token, expiresAt: new Date(payload.exp * 1000).toISOString() }, 200, headers);
}

async function requireSession(request, env) {
  if (!env.SESSION_SECRET) return false;
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return false;
  return verifyToken(authorization.slice(7), env.SESSION_SECRET);
}

async function getData(env, headers) {
  const data = await readGistData(env);
  return json({ data }, 200, headers);
}

async function putData(request, env, headers) {
  const body = await readJson(request);
  if (!body.data || typeof body.data !== "object") throw httpError(400, "The request is missing workspace data.");
  const incoming = body.data;
  const validation = validateWorkspace(incoming);
  if (validation.length) throw httpError(400, "The workspace data is not valid.", validation);

  const current = await readGistData(env);
  const expected = Number(body.baseRevision);
  if (!Number.isInteger(expected) || expected !== Number(current.revision || 0)) {
    throw httpError(409, "The workspace changed on another device. Reload before saving.", { currentRevision: current.revision || 0 });
  }

  const saved = structuredClone(incoming);
  saved.revision = expected + 1;
  saved.updatedAt = new Date().toISOString();
  await writeGistData(env, saved);
  return json({ data: saved }, 200, headers);
}

async function generateDrafts(request, env, headers) {
  requireEnv(env, ["OPENAI_API_KEY", "GIST_ID", "GITHUB_TOKEN"]);
  const body = await readJson(request);
  const brief = validateBrief(body.brief);
  const workspace = await readGistData(env);
  const organization = workspace.organization || {};
  const requestedIds = new Set(Array.isArray(body.recentPostIds) ? body.recentPostIds : []);
  const recentPosts = (workspace.posts || [])
    .filter((post) => !requestedIds.size || requestedIds.has(post.id))
    .slice(0, 20)
    .map((post) => ({ campaign: post.campaign, canonical: post.canonical, platforms: (post.variants || []).map((variant) => variant.platform) }));

  const schema = generationSchema(brief.platforms);
  const instructions = buildInstructions(organization, brief.platforms);
  const apiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "X-Client-Request-Id": crypto.randomUUID()
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || DEFAULT_MODEL,
      instructions,
      input: JSON.stringify({ brief, recentPosts }),
      reasoning: { effort: env.OPENAI_REASONING_EFFORT || "low" },
      text: { format: { type: "json_schema", name: "social_post_package", strict: true, schema } },
      store: false,
      safety_identifier: await safetyIdentifier(env.SESSION_SECRET)
    })
  });

  const responsePayload = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) {
    console.error("OpenAI API error", apiResponse.status, responsePayload?.error?.code || "unknown");
    const message = apiResponse.status === 429
      ? "The AI service is temporarily rate-limited. Wait a moment and try again."
      : "The AI drafting service returned an error.";
    throw httpError(apiResponse.status >= 500 ? 502 : 400, message, responsePayload?.error?.code || undefined);
  }

  const outputText = extractOutputText(responsePayload);
  if (!outputText) throw httpError(502, "The AI response did not contain a completed draft.");

  let generation;
  try {
    generation = JSON.parse(outputText);
  } catch {
    throw httpError(502, "The AI response could not be read as structured draft data.");
  }
  const outputErrors = validateGeneration(generation, brief.platforms);
  if (outputErrors.length) throw httpError(502, "The AI response was incomplete.", outputErrors);

  generation = cleanGeneration(generation, brief.platforms);
  return json({
    generation,
    metadata: {
      model: responsePayload.model || env.OPENAI_MODEL || DEFAULT_MODEL,
      promptVersion: PROMPT_VERSION,
      responseId: responsePayload.id || "",
      warnings: [],
      usage: responsePayload.usage || null
    }
  }, 200, headers);
}

function buildInstructions(organization, platforms) {
  const facts = (organization.facts || []).map((fact) => `- ${fact}`).join("\n");
  const prohibited = (organization.prohibitedClaims || []).map((rule) => `- ${rule}`).join("\n");
  return `You are the social media drafting team for ${organization.name || "Safe Cycle Tech"}.

Create one truthful canonical message and a distinct draft for each requested platform: ${platforms.join(", ")}.

Organization mission:
${organization.mission || "Collect unwanted electronics, refurbish usable devices for local students and families, and responsibly recycle the rest."}

Service area: ${organization.serviceArea || "Bay Area, California"}
Voice: ${organization.voice || "Neighborly, practical, trustworthy, specific, and never pushy."}

Approved facts—the drafts may use only claims supported here or explicitly supplied in the brief:
${facts}

Rules:
${prohibited}
- Never invent statistics, events, deadlines, neighborhoods, partnerships, testimonials, recipient details, or certifications.
- Never imply that the draft has been published or that the organization performed an action not stated in the brief.
- Keep Reddit community-first and include a useful title. Avoid hashtags on Reddit.
- Keep Facebook warm, clear, and easy to scan.
- Keep Nextdoor neighborly, local, and low-pressure.
- Keep LinkedIn mission-led and partnership-friendly.
- Put platform-specific cautions in notes and factual concerns in warnings.
- Return only data matching the supplied JSON schema.`;
}

function generationSchema(platforms) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["campaignAngle", "canonical", "variants", "warnings"],
    properties: {
      campaignAngle: { type: "string", minLength: 1, maxLength: 180 },
      canonical: { type: "string", minLength: 1, maxLength: 4000 },
      warnings: { type: "array", maxItems: 8, items: { type: "string", maxLength: 300 } },
      variants: {
        type: "array",
        minItems: platforms.length,
        maxItems: platforms.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["platform", "title", "body", "hashtags", "notes"],
          properties: {
            platform: { type: "string", enum: platforms },
            title: { type: "string", maxLength: 300 },
            body: { type: "string", minLength: 1, maxLength: 12000 },
            hashtags: { type: "array", maxItems: 8, items: { type: "string", maxLength: 60 } },
            notes: { type: "string", maxLength: 500 }
          }
        }
      }
    }
  };
}

function validateBrief(input) {
  if (!input || typeof input !== "object") throw httpError(400, "A campaign brief is required.");
  const platforms = Array.isArray(input.platforms) ? [...new Set(input.platforms)] : [];
  const allowed = new Set(["reddit", "facebook", "nextdoor", "linkedin"]);
  if (!platforms.length || platforms.some((platform) => !allowed.has(platform))) throw httpError(400, "Choose at least one supported platform.");
  const required = ["objective", "audience", "keyMessage"];
  for (const field of required) if (!String(input[field] || "").trim()) throw httpError(400, `The brief is missing ${field}.`);
  return {
    campaign: limitText(input.campaign || "General outreach", 100),
    objective: limitText(input.objective, 220),
    audience: limitText(input.audience, 180),
    keyMessage: limitText(input.keyMessage, 1200),
    cta: limitText(input.cta || "", 240),
    tone: limitText(input.tone || "Neighborly and direct", 100),
    tags: limitText(input.tags || "", 160),
    scheduledAt: limitText(input.scheduledAt || "", 40),
    platforms
  };
}

function validateGeneration(generation, platforms) {
  const errors = [];
  if (!generation || typeof generation !== "object") return ["Generation is not an object."];
  if (!String(generation.canonical || "").trim()) errors.push("Canonical message is missing.");
  if (!Array.isArray(generation.variants)) errors.push("Variants are missing.");
  const received = new Set((generation.variants || []).map((variant) => variant.platform));
  for (const platform of platforms) if (!received.has(platform)) errors.push(`${platform} variant is missing.`);
  if (received.size !== platforms.length) errors.push("A platform was returned more than once or was not requested.");
  for (const variant of generation.variants || []) {
    if (!String(variant.body || "").trim()) errors.push(`${variant.platform || "Unknown"} body is empty.`);
    if (variant.platform === "reddit" && !String(variant.title || "").trim()) errors.push("Reddit title is empty.");
  }
  return errors;
}

function cleanGeneration(generation, platforms) {
  const order = new Map(platforms.map((platform, index) => [platform, index]));
  generation.campaignAngle = limitText(generation.campaignAngle, 180);
  generation.canonical = limitText(generation.canonical, 4000);
  generation.warnings = (generation.warnings || []).map((warning) => limitText(warning, 300)).slice(0, 8);
  generation.variants = generation.variants
    .sort((a, b) => order.get(a.platform) - order.get(b.platform))
    .map((variant) => ({
      platform: variant.platform,
      title: limitText(variant.title || "", 300),
      body: limitText(variant.body, 12000),
      hashtags: (variant.hashtags || []).map((tag) => limitText(String(tag).replace(/^#/, ""), 60)).filter(Boolean).slice(0, 8),
      notes: limitText(variant.notes || "", 500)
    }));
  return generation;
}

function extractOutputText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;
  for (const item of payload.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) if (content.type === "output_text" && content.text) return content.text;
  }
  return "";
}

async function readGistData(env) {
  requireEnv(env, ["GIST_ID", "GITHUB_TOKEN"]);
  const response = await githubRequest(env, `https://api.github.com/gists/${encodeURIComponent(env.GIST_ID)}`);
  const gist = await response.json();
  const filename = env.GIST_FILENAME || "sc_data.json";
  const file = gist.files?.[filename];
  if (!file) return emptyWorkspace();
  let content = file.content;
  if (file.truncated && file.raw_url) {
    const raw = await githubRequest(env, file.raw_url, { headers: { Accept: "application/vnd.github.raw" } });
    content = await raw.text();
  }
  try {
    const parsed = JSON.parse(content);
    if (!Number.isInteger(parsed.revision)) parsed.revision = 0;
    return parsed;
  } catch {
    throw httpError(502, `The Gist file ${filename} does not contain valid JSON.`);
  }
}

async function writeGistData(env, data) {
  const filename = env.GIST_FILENAME || "sc_data.json";
  const response = await githubRequest(env, `https://api.github.com/gists/${encodeURIComponent(env.GIST_ID)}`, {
    method: "PATCH",
    body: JSON.stringify({ files: { [filename]: { content: JSON.stringify(data, null, 2) } } })
  });
  await response.arrayBuffer();
}

async function githubRequest(env, url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Accept", headers.get("Accept") || "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${env.GITHUB_TOKEN}`);
  headers.set("X-GitHub-Api-Version", GIST_API_VERSION);
  headers.set("User-Agent", "SafeCycle-Social-Studio/1.0");
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    console.error("GitHub API error", response.status, details?.message || "unknown");
    if (response.status === 401) throw httpError(502, "The worker's GitHub token was rejected.");
    if (response.status === 403) throw httpError(502, "GitHub denied Gist access. Confirm that the token has Gists read and write permission.");
    if (response.status === 404) throw httpError(502, "The configured Gist could not be found.");
    throw httpError(502, "GitHub could not complete the Gist request.");
  }
  return response;
}

/* Kept in step with SCHEMA_VERSION in js/data.js. The worker is not
   wired up today (the app talks to the providers directly), but a
   validator that rejects the current schema would be a trap for
   whoever turns it on later. */
const WORKSPACE_SCHEMA_VERSION = 3;

function emptyWorkspace() {
  return { schemaVersion: WORKSPACE_SCHEMA_VERSION, revision: 0, updatedAt: new Date().toISOString(), posts: [], runs: [], activity: [] };
}

function validateWorkspace(data) {
  const errors = [];
  if (data.schemaVersion !== WORKSPACE_SCHEMA_VERSION) errors.push(`schemaVersion must be ${WORKSPACE_SCHEMA_VERSION}.`);
  if (!data.organization || typeof data.organization !== "object") errors.push("organization is required.");
  if (!Array.isArray(data.posts)) errors.push("posts must be an array.");
  if (!Array.isArray(data.activity)) errors.push("activity must be an array.");
  if (JSON.stringify(data).length > 8_000_000) errors.push("Workspace exceeds the 8 MB application safety limit.");
  return errors;
}

function requireEnv(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw httpError(503, "The secure worker is not fully configured.", { missing });
}

function corsHeaders(origin, env) {
  const allowed = isAllowedOrigin(origin, env);
  return {
    "Access-Control-Allow-Origin": allowed && origin ? origin : "null",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  };
}

function isAllowedOrigin(origin, env) {
  if (!origin) return true;
  const configured = String(env.ALLOWED_ORIGINS || "").split(",").map((item) => item.trim().replace(/\/$/, "")).filter(Boolean);
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return local || configured.includes(origin.replace(/\/$/, ""));
}

function json(payload, status = 200, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), { status, headers });
}

async function readJson(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) throw httpError(415, "Send requests as application/json.");
  try {
    return await request.json();
  } catch {
    throw httpError(400, "The request body is not valid JSON.");
  }
}

function httpError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

async function signToken(payload, secret) {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmac(encoded, secret);
  return `${encoded}.${base64UrlFromBytes(signature)}`;
}

async function verifyToken(token, secret) {
  try {
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) return false;
    const expected = base64UrlFromBytes(await hmac(encoded, secret));
    if (!(await constantTimeEqual(signature, expected))) return false;
    const payload = JSON.parse(base64UrlDecode(encoded));
    return payload.sub === "safecycle-admin" && Number(payload.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function hmac(value, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

async function constantTimeEqual(left, right) {
  const encoder = new TextEncoder();
  const a = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(left)));
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(right)));
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}

function base64UrlEncode(value) {
  return base64UrlFromBytes(new TextEncoder().encode(value));
}

function base64UrlFromBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

async function safetyIdentifier(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`safecycle:${secret}`));
  return `sc_${base64UrlFromBytes(new Uint8Array(digest)).slice(0, 32)}`;
}

function limitText(value, max) {
  return String(value || "").trim().slice(0, max);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

export const testHelpers = {
  buildInstructions,
  cleanGeneration,
  constantTimeEqual,
  corsHeaders,
  emptyWorkspace,
  extractOutputText,
  generationSchema,
  isAllowedOrigin,
  signToken,
  validateBrief,
  validateGeneration,
  validateWorkspace,
  verifyToken
};
