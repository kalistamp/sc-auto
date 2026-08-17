/* ============================================================
   SAFE CYCLE STUDIO — workspace data model

   One JSON document holds everything: the organization's standing
   context, per-platform defaults, every post, every generation run,
   and an activity trail. It is small enough to live in a single gist
   file and be rewritten on every save.

   Schema 2 adds the recordkeeping the workflow actually needs:
     · three separate texts per variant — what the model wrote
       (aiBody), what the operator approved (body), and what was
       actually published (publishedBody). Editing a draft can no
       longer quietly erase the model's original output.
     · a `runs` log, so "which model produced this" is a fact on
       record rather than a label that can drift.
     · `source`, so a post recorded straight from a platform is
       distinguishable from one this app drafted.

   Schema 3 makes the platform list the operator's own:
     · `platforms` replaces the frozen built-in table AND the old
       `platformSettings` map. One ordered array, one object per
       platform, holding both what the platform is (label, colour,
       limits, home page) and how this organization uses it (enabled,
       guidance, account).
     · every platform carries a `homeUrl`, so the workflow — copy,
       open the platform, paste it yourself — works the same way for a
       platform added years from now as for the ones shipped here.
   ============================================================ */

import { ACTIVITY_LIMIT, RUN_LOG_LIMIT, SIMILARITY_THRESHOLD } from "./config.js";

export const SCHEMA_VERSION = 3;

/* ============================================================
   PLATFORMS

   These used to be a frozen constant compiled into this file, which
   meant the set of networks this organization could post to was a code
   change. They are workspace data now: the operator adds the ones they
   use, removes the ones they do not, and the whole app reads the list
   through the registry below.

   WHAT DOES NOT CHANGE: nothing here publishes anything. A platform is
   a label, a set of limits to check copy against, and a link to the
   platform's own front door. The operator opens it, logs in, and pastes
   the text themselves. `homeUrl` is a home page or login page on
   purpose — not a composer endpoint and not an API — because the moment
   this app starts submitting posts it becomes the thing that gets an
   account banned. See the note in js/platforms.js.
   ============================================================ */

/* The neutral option, and the reason it exists: most of the time a small
   organization wants ONE post it can put anywhere, not five bespoke
   ones. Drafting against this key tells the model to avoid anything
   platform-specific.

   The limits are deliberately the tightest of the mainstream networks
   rather than generous ones. 2,200 characters is Instagram's ceiling; a
   "works anywhere" draft that runs past it does not work anywhere, so it
   is a real error rather than a nudge. */
export const NEUTRAL_PLATFORM_KEY = "default";

const BUILT_IN_PLATFORMS = [
  {
    key: NEUTRAL_PLATFORM_KEY,
    label: "Any platform",
    color: "#7d8279",
    homeUrl: "",
    titleMax: 0,
    bodyMax: 2200,
    soft: 800,
    blurb: "One draft, usable anywhere",
    note: "Platform-neutral copy. Paste it into whatever you are posting to.",
    guidance: "Platform-neutral. Assume nothing about the audience or the interface: no hashtags unless they read naturally in a sentence, no references to features only one network has, no 'link in bio'.",
    enabled: true
  },
  {
    key: "reddit",
    label: "Reddit",
    color: "#d93a00",
    homeUrl: "https://www.reddit.com/",
    titleMax: 300,
    bodyMax: 40000,
    soft: 2500,
    blurb: "Title plus community copy",
    note: "Check the subreddit's self-promotion and flair rules before posting.",
    guidance: "Community-first, specific, transparent, and adapted to each subreddit's rules.",
    enabled: true
  },
  {
    key: "facebook",
    label: "Facebook",
    color: "#1877f2",
    homeUrl: "https://www.facebook.com/",
    titleMax: 0,
    bodyMax: 63206,
    soft: 900,
    blurb: "Page post",
    note: "Post from the Page or Meta Business Suite, not a personal profile.",
    guidance: "Warm and informative with a clear local call to action.",
    enabled: true
  },
  {
    key: "nextdoor",
    label: "Nextdoor",
    color: "#5a9c22",
    homeUrl: "https://nextdoor.com/",
    titleMax: 0,
    bodyMax: 8192,
    soft: 1200,
    blurb: "Neighborhood post",
    note: "Neighbors downvote anything that reads like an advertisement.",
    guidance: "Neighborly, locally relevant, concise, and trust-building.",
    enabled: true
  },
  {
    key: "instagram",
    label: "Instagram",
    color: "#c13584",
    homeUrl: "https://www.instagram.com/",
    titleMax: 0,
    bodyMax: 2200,
    soft: 1500,
    blurb: "Caption for an image post",
    note: "Instagram needs an image; the caption is what this drafts.",
    guidance: "Short, concrete, and written to sit under a real photo.",
    enabled: false
  }
];

/* Platforms that used to ship as built-ins and no longer do.
   LinkedIn was removed in schema 3 at the operator's request.

   This table is not a fallback list and nothing here is ever offered for
   a new draft. It exists for one case only: a workspace that already has
   a published LinkedIn post. Migration re-registers that platform as
   retired so the record keeps its real label, colour and limits instead
   of decaying into a bare key — and, critically, so the post is not
   silently reassigned to some other platform. */
const REMOVED_BUILT_INS = {
  linkedin: {
    label: "LinkedIn",
    color: "#0a66c2",
    homeUrl: "https://www.linkedin.com/feed/",
    titleMax: 0,
    bodyMax: 3000,
    soft: 1300,
    blurb: "Organization page post",
    note: "No longer in the platform list. Kept so existing posts keep their record."
  }
};

export function defaultPlatforms() {
  return BUILT_IN_PLATFORMS.map((platform) => ({ ...platform, account: "" }));
}

/* Fields, and what happens when a value is missing or nonsense. Written
   defensively because a platform can arrive from a hand-edited gist as
   easily as from the Add platform form. */
export function normalizePlatform(input, fallbackKey = "") {
  const source = input && typeof input === "object" ? input : {};
  const key = slugifyPlatformKey(source.key || fallbackKey);
  const label = String(source.label || "").trim() || titleCase(key) || "Untitled";
  const bodyMax = positiveInt(source.bodyMax, 10000);
  return {
    key,
    label,
    color: /^#[0-9a-f]{3,8}$/i.test(String(source.color || "")) ? String(source.color) : "#7d8279",
    /* Only http(s). A javascript: or data: URL in a link the operator
       clicks is the one genuinely dangerous field on this object. */
    homeUrl: safeHttpUrl(source.homeUrl),
    titleMax: Math.max(0, positiveInt(source.titleMax, 0)),
    bodyMax,
    /* A soft limit above the hard one could never fire; clamp instead of
       trusting the input. */
    soft: Math.min(positiveInt(source.soft, 0), bodyMax),
    blurb: String(source.blurb || "").trim(),
    note: String(source.note || "").trim(),
    guidance: String(source.guidance || "").trim(),
    account: String(source.account || "").trim(),
    enabled: typeof source.enabled === "boolean" ? source.enabled : false,
    retired: source.retired === true
  };
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function safeHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    /* Bare hostnames are what people actually type. */
    return /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(raw) ? `https://${raw}` : "";
  }
}

export function slugifyPlatformKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function titleCase(value) {
  return String(value || "").replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim();
}

/** A key that is not already taken, so adding "Mastodon" twice works. */
export function uniquePlatformKey(label, taken = []) {
  const base = slugifyPlatformKey(label) || "platform";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/* ------------------------------------------------------------
   THE REGISTRY

   One mutable list, set once from the workspace after it loads. The
   alternative — threading the platform list through every function that
   needs a label — would touch roughly forty call sites across four
   files to no benefit, because there is exactly one workspace open at a
   time. The setter is explicit rather than implicit so tests can control
   it, and the default is the built-in list so every module still works
   standalone.
   ------------------------------------------------------------ */

let activePlatforms = defaultPlatforms();

export function setActivePlatforms(list) {
  const next = (Array.isArray(list) ? list : []).map((item) => normalizePlatform(item)).filter((item) => item.key);
  /* An empty or unreadable list would leave the operator with no way to
     draft anything and no obvious cause; the built-ins are a better
     answer than a blank screen. */
  activePlatforms = next.length ? next : defaultPlatforms();
  return activePlatforms;
}

export function listPlatforms({ enabledOnly = false, includeRetired = true } = {}) {
  return activePlatforms.filter((platform) =>
    (!enabledOnly || platform.enabled) && (includeRetired || !platform.retired));
}

export function platformKeys(options) {
  return listPlatforms(options).map((platform) => platform.key);
}

/**
 * Never returns undefined. Every call site that reads `.label`,
 * `.bodyMax` or `.color` off a platform used to guard against a missing
 * one with `?.` and a fallback, inconsistently — one of them did not,
 * and a variant whose platform had been removed would throw while
 * rendering. A retired stand-in is always safer than a crash in a view.
 */
export function getPlatform(key) {
  const found = activePlatforms.find((platform) => platform.key === key);
  if (found) return found;
  return normalizePlatform({
    ...(REMOVED_BUILT_INS[key] || {}),
    key: String(key || ""),
    /* Generous, so an archived post is never reported as over a limit
       that no longer applies to it. */
    bodyMax: REMOVED_BUILT_INS[key]?.bodyMax || 100000,
    enabled: false,
    retired: true
  }, String(key || "unknown"));
}

/* Every state a single platform variant can be in. The order is the
   workflow order, which is what lets the UI show progress. */
export const VARIANT_STATES = ["draft", "approved", "scheduled", "published"];

const DEFAULT_FACTS = [
  "Pickup is free across the Bay Area.",
  "Working devices are refurbished for local students and underprivileged families.",
  "Drives are wiped to NIST 800-88 standards or physically destroyed when wiping is not possible.",
  "Equipment that cannot be refurbished goes to certified California electronics recyclers.",
  "Safe Cycle Tech accepts broken phones, laptops, desktop computers, tablets, monitors, DVRs, game consoles, routers, cables, and most other electronics."
];

const DEFAULT_RULES = [
  "Do not invent impact numbers, partnerships, certifications, testimonials, or recipient stories.",
  "Do not identify students, families, or donors without explicit written permission.",
  "Do not claim every donated device is refurbished; unusable equipment is responsibly recycled.",
  "Do not promise a pickup window, price, or tax outcome that has not been confirmed."
];

export function createId(prefix = "id") {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${random}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function createDefaultData() {
  const now = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    organization: {
      name: "Safe Cycle Tech",
      website: "https://safecycletech.com/",
      serviceArea: "Bay Area, California",
      mission: "Collect unwanted electronics, refurbish what can be saved for local students and families, and responsibly recycle the rest.",
      voice: "Neighborly, practical, trustworthy, specific, and never pushy.",
      defaultCta: "Call or text (415) 612-8520 to schedule a free pickup.",
      facts: [...DEFAULT_FACTS],
      prohibitedClaims: [...DEFAULT_RULES]
    },
    platforms: defaultPlatforms(),
    posts: [],
    runs: [],
    activity: []
  };
}

/* ------------------------------------------------------------
   MIGRATION

   Read defensively. A workspace written by an older build — or hand
   edited in the gist — should open in a newer build without a separate
   migration step, and without losing anything it does carry.
   ------------------------------------------------------------ */

export function migrateData(input) {
  if (!input || typeof input !== "object") return createDefaultData();
  const base = createDefaultData();
  const data = structuredClone(input);

  data.schemaVersion = SCHEMA_VERSION;
  data.revision = Number.isInteger(data.revision) ? data.revision : 0;
  data.createdAt ||= data.updatedAt || nowIso();
  data.updatedAt ||= nowIso();

  data.organization = { ...base.organization, ...(data.organization || {}) };
  data.organization.facts = asStringList(data.organization.facts, DEFAULT_FACTS);
  data.organization.prohibitedClaims = asStringList(data.organization.prohibitedClaims, DEFAULT_RULES);

  data.platforms = migratePlatforms(data);
  delete data.platformSettings;   /* folded into data.platforms above */

  data.posts = (Array.isArray(data.posts) ? data.posts : []).map(migratePost);
  data.runs = (Array.isArray(data.runs) ? data.runs : []).slice(0, RUN_LOG_LIMIT);
  data.activity = (Array.isArray(data.activity) ? data.activity : []).slice(0, ACTIVITY_LIMIT);
  return data;
}

/* ------------------------------------------------------------
   Platform migration, in three steps and one hard rule.

   THE HARD RULE: a platform key that any post references must end up in
   the list. Publication history is the most valuable thing in this
   workspace and the least recoverable — the gist is the only copy — so
   removing a platform from the built-ins must never orphan or silently
   reassign a post that used it. Schema 2 handled the same situation by
   rewriting the variant's platform to "facebook", which quietly falsified
   the record; that is exactly what the retired entries below prevent.
   ------------------------------------------------------------ */
function migratePlatforms(data) {
  const legacy = data.platformSettings && typeof data.platformSettings === "object"
    ? data.platformSettings
    : null;

  /* 1. Schema 3 onwards stores the whole list. Trust it, but normalize. */
  let list = Array.isArray(data.platforms)
    ? data.platforms.map((platform) => normalizePlatform(platform)).filter((platform) => platform.key)
    : [];

  /* 2. Schema 1/2 stored definitions in code and settings in
        platformSettings. Rebuild from the built-ins, folding the
        operator's own enabled/guidance/account choices back in. */
  if (!list.length) {
    list = defaultPlatforms().map((seed) => {
      const saved = legacy?.[seed.key];
      if (!saved || typeof saved !== "object") return normalizePlatform(seed);
      return normalizePlatform({
        ...seed,
        enabled: typeof saved.enabled === "boolean" ? saved.enabled : seed.enabled,
        guidance: saved.guidance ?? seed.guidance,
        account: saved.account ?? ""
      });
    });
  }

  /* 3. The hard rule. */
  const known = new Set(list.map((platform) => platform.key));
  for (const key of referencedPlatformKeys(data)) {
    if (!key || known.has(key)) continue;
    known.add(key);
    const saved = legacy?.[key];
    list.push(normalizePlatform({
      ...(REMOVED_BUILT_INS[key] || {}),
      key,
      guidance: saved?.guidance ?? REMOVED_BUILT_INS[key]?.guidance ?? "",
      account: saved?.account ?? "",
      /* Retired, not enabled: the record stays readable and the platform
         is not offered for anything new. */
      enabled: false,
      retired: true
    }, key));
  }

  return list;
}

function referencedPlatformKeys(data) {
  const keys = new Set();
  for (const post of Array.isArray(data.posts) ? data.posts : []) {
    for (const variant of Array.isArray(post?.variants) ? post.variants : []) {
      if (variant?.platform) keys.add(String(variant.platform));
    }
  }
  return keys;
}

function migratePost(post) {
  const ai = post?.ai || {};
  return {
    id: post?.id || createId("post"),
    campaign: String(post?.campaign || "Untitled campaign"),
    objective: String(post?.objective || ""),
    audience: String(post?.audience || ""),
    keyMessage: String(post?.keyMessage || ""),
    canonical: String(post?.canonical || ""),
    status: String(post?.status || "review"),
    source: post?.source === "external" ? "external" : "ai",
    createdAt: post?.createdAt || nowIso(),
    updatedAt: post?.updatedAt || post?.createdAt || nowIso(),
    tags: asStringList(post?.tags, []),
    /* Schema 1 stored a single `model` string. Carry it into both slots
       so the receipt for an old post still reads truthfully: we know
       what was asked for, and we have no separate record of what
       answered, so they are the same value. */
    ai: {
      provider: String(ai.provider || "unknown"),
      requestedModel: String(ai.requestedModel || ai.model || ""),
      servedModel: String(ai.servedModel || ai.model || ""),
      promptVersion: String(ai.promptVersion || ""),
      responseId: String(ai.responseId || ""),
      usage: ai.usage || null,
      latencyMs: Number(ai.latencyMs || 0),
      at: ai.at || post?.createdAt || "",
      warnings: asStringList(ai.warnings, [])
    },
    variants: (Array.isArray(post?.variants) ? post.variants : []).map(migrateVariant)
  };
}

function migrateVariant(variant) {
  const body = String(variant?.body || "");
  return {
    id: variant?.id || createId("variant"),
    /* Kept exactly as recorded. Schema 2 replaced an unrecognized key
       with "facebook", which turned "I do not know this platform" into
       the false statement "this was posted to Facebook". migratePlatforms
       guarantees the key is registered instead. */
    platform: String(variant?.platform || NEUTRAL_PLATFORM_KEY),
    title: String(variant?.title || ""),
    body,
    /* Schema 1 had no record of the model's untouched output. The best
       available answer for an old variant is its current body — stated
       as such rather than left blank, so the diff view is honest. */
    aiBody: typeof variant?.aiBody === "string" ? variant.aiBody : body,
    publishedBody: String(variant?.publishedBody || ""),
    hashtags: asStringList(variant?.hashtags, []),
    notes: String(variant?.notes || ""),
    status: VARIANT_STATES.includes(variant?.status) ? variant.status : "draft",
    scheduledAt: String(variant?.scheduledAt || ""),
    publishedAt: String(variant?.publishedAt || ""),
    publishedUrl: String(variant?.publishedUrl || ""),
    account: String(variant?.account || "")
  };
}

function asStringList(value, fallback) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return value.split("\n").map((line) => line.trim()).filter(Boolean);
  }
  return [...fallback];
}

/* ------------------------------------------------------------
   VALIDATION — run before every write, and on every import.
   ------------------------------------------------------------ */

export function validateData(data) {
  const errors = [];
  if (!data || typeof data !== "object") return ["The workspace file must contain a JSON object."];
  if (data.schemaVersion !== SCHEMA_VERSION) errors.push(`Unsupported schema version: ${data.schemaVersion}.`);
  if (!data.organization || typeof data.organization !== "object") errors.push("Organization settings are missing.");
  if (!Array.isArray(data.posts)) errors.push("Posts must be an array.");
  if (!Array.isArray(data.runs)) errors.push("Runs must be an array.");
  if (!Array.isArray(data.activity)) errors.push("Activity must be an array.");

  /* Platforms are the operator's own list now, so "is this a real
     platform" is answered by the workspace rather than by this file. What
     is still worth catching is a workspace that contradicts itself: a
     duplicate key, or a post pointing at a platform the list does not
     contain. Migration cannot produce either; a hand-edited gist can. */
  const known = new Set();
  if (!Array.isArray(data.platforms)) {
    errors.push("Platforms must be an array.");
  } else {
    if (!data.platforms.length) errors.push("At least one platform is needed to draft anything.");
    for (const platform of data.platforms) {
      if (!platform?.key) { errors.push("Every platform needs a key."); continue; }
      if (known.has(platform.key)) errors.push(`Duplicate platform key: ${platform.key}.`);
      known.add(platform.key);
      if (!String(platform.label || "").trim()) errors.push(`Platform ${platform.key} needs a name.`);
    }
  }

  if (Array.isArray(data.posts)) {
    const ids = new Set();
    for (const post of data.posts) {
      if (!post?.id) { errors.push("Every post needs an ID."); continue; }
      if (ids.has(post.id)) errors.push(`Duplicate post ID: ${post.id}.`);
      ids.add(post.id);
      if (!Array.isArray(post.variants)) { errors.push(`Post ${post.id} has no variants array.`); continue; }
      for (const variant of post.variants) {
        if (!variant?.platform || !known.has(variant.platform)) {
          errors.push(`Unknown platform on post ${post.id}: ${variant?.platform}.`);
        }
        if (typeof variant?.body !== "string") errors.push(`A variant on post ${post.id} is missing body text.`);
      }
    }
  }
  return errors;
}

/* ------------------------------------------------------------
   DERIVED STATE
   ------------------------------------------------------------ */

/* A post has no status of its own worth trusting — it is whatever its
   variants add up to. Archived is the one operator-set state that wins,
   because it is a decision rather than a consequence. */
export function derivePostStatus(post) {
  if (post.status === "archived") return "archived";
  const states = (post.variants || []).map((variant) => variant.status);
  if (!states.length) return "review";
  if (states.every((state) => state === "published")) return "published";
  if (states.some((state) => state === "published")) return "partial";
  if (states.some((state) => state === "scheduled")) return "scheduled";
  if (states.every((state) => state === "approved")) return "approved";
  return "review";
}

export const STATUS_LABELS = {
  draft: "Draft",
  review: "Needs review",
  approved: "Approved",
  scheduled: "Scheduled",
  published: "Published",
  partial: "Partly published",
  archived: "Archived"
};

export function createPostFromGeneration(brief, generation, receipt) {
  const now = nowIso();
  return {
    id: createId("post"),
    campaign: brief.campaign || "Untitled campaign",
    objective: brief.objective || "",
    audience: brief.audience || "",
    keyMessage: brief.keyMessage || "",
    canonical: generation.canonical || "",
    status: "review",
    source: "ai",
    createdAt: now,
    updatedAt: now,
    tags: splitTags(brief.tags),
    ai: {
      provider: receipt.provider,
      requestedModel: receipt.requestedModel,
      servedModel: receipt.servedModel,
      promptVersion: receipt.promptVersion,
      responseId: receipt.responseId || "",
      usage: receipt.usage || null,
      latencyMs: receipt.latencyMs || 0,
      at: receipt.at || now,
      warnings: [...(generation.warnings || [])]
    },
    variants: generation.variants.map((variant) => {
      const body = variant.body || "";
      return {
        id: createId("variant"),
        platform: variant.platform,
        title: variant.title || "",
        body,
        aiBody: body,          /* frozen: the model's untouched output */
        publishedBody: "",
        hashtags: Array.isArray(variant.hashtags) ? variant.hashtags : [],
        notes: variant.notes || "",
        status: "draft",
        scheduledAt: brief.scheduledAt || "",
        publishedAt: "",
        publishedUrl: "",
        account: ""
      };
    })
  };
}

/* A post the operator wrote directly on a platform. It never had a
   model in the loop, and the record should say so rather than leave an
   empty model field that reads like missing data. */
export function createExternalPost({ campaign, platform, body, title, publishedAt, publishedUrl, account, notes }) {
  const now = nowIso();
  return {
    id: createId("post"),
    campaign: campaign || "Recorded post",
    objective: "",
    audience: "",
    keyMessage: "",
    canonical: body || "",
    status: "published",
    source: "external",
    createdAt: now,
    updatedAt: now,
    tags: [],
    ai: {
      provider: "none", requestedModel: "", servedModel: "", promptVersion: "",
      responseId: "", usage: null, latencyMs: 0, at: "", warnings: []
    },
    variants: [{
      id: createId("variant"),
      platform,
      title: title || "",
      body: body || "",
      aiBody: "",
      publishedBody: body || "",
      hashtags: [],
      notes: notes || "",
      status: "published",
      scheduledAt: "",
      publishedAt: publishedAt || now,
      publishedUrl: publishedUrl || "",
      account: account || ""
    }]
  };
}

export function splitTags(value) {
  if (Array.isArray(value)) return value.map((tag) => String(tag).trim()).filter(Boolean);
  return String(value || "").split(",").map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean);
}

/* ------------------------------------------------------------
   REPETITION CHECK

   Publishing the same paragraph to the same neighborhood three weeks
   running is the failure mode this catches. Set overlap on words longer
   than three characters, ignoring links and punctuation.
   ------------------------------------------------------------ */

export function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function textSimilarity(left, right) {
  const a = new Set(normalizeText(left).split(" ").filter((word) => word.length > 3));
  const b = new Set(normalizeText(right).split(" ").filter((word) => word.length > 3));
  if (!a.size || !b.size) return 0;
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared / new Set([...a, ...b]).size;
}

export function findSimilarPosts(candidate, posts, threshold = SIMILARITY_THRESHOLD) {
  return posts
    .map((post) => ({ post, score: textSimilarity(candidate, post.canonical || post.variants?.[0]?.body || "") }))
    .filter(({ score }) => score >= threshold)
    .sort((a, b) => b.score - a.score);
}

/* ------------------------------------------------------------
   TRAILS
   ------------------------------------------------------------ */

export function addActivity(data, type, message, postId = "") {
  data.activity.unshift({ id: createId("act"), type, message, postId, at: nowIso() });
  data.activity = data.activity.slice(0, ACTIVITY_LIMIT);
}

export function addRun(data, run) {
  data.runs.unshift({ id: createId("run"), ...run });
  data.runs = data.runs.slice(0, RUN_LOG_LIMIT);
}

/* ------------------------------------------------------------
   QUERIES used by more than one view
   ------------------------------------------------------------ */

export function allVariants(data) {
  return data.posts.flatMap((post) => post.variants.map((variant) => ({ post, variant })));
}

export function countsFor(data) {
  const pairs = allVariants(data);
  return {
    posts: data.posts.length,
    needsReview: data.posts.filter((post) => derivePostStatus(post) === "review").length,
    approved: pairs.filter(({ variant }) => variant.status === "approved").length,
    scheduled: pairs.filter(({ variant }) => variant.status === "scheduled").length,
    published: pairs.filter(({ variant }) => variant.status === "published").length,
    overdue: pairs.filter(({ variant }) =>
      variant.status === "scheduled" && variant.scheduledAt && Date.parse(variant.scheduledAt) < Date.now()).length
  };
}
