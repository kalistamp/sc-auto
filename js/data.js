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

import {
  ACTIVITY_LIMIT, DELETED_LIMIT, DELETED_RETENTION_DAYS, DRAFT_HISTORY_LIMIT,
  RUN_LOG_LIMIT, SIMILARITY_THRESHOLD
} from "./config.js";
import { defaultCtaText } from "./signature.js";

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

/* ---- the active organization -------------------------------------

   Same arrangement as the active platform list below, adopted for the
   same reason: buildCopyText() has to append the operator's call to
   action, and it is called from a dozen places that have no reason to
   know about the organization record.

   Set from adoptData() in app.js, which is the one chokepoint every
   path that swaps the workspace already goes through.
   ------------------------------------------------------------------ */

let activeOrganization = {};

export function setOrganization(organization) {
  activeOrganization = organization && typeof organization === "object" ? organization : {};
  return activeOrganization;
}

export function getOrganization() {
  return activeOrganization;
}

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
  const data = {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    organization: {
      name: "Safe Cycle Tech",
      website: "https://safecycletech.com/",
      /* The sign-off every generated post closes with. js/signature.js
         renders these into the prompt and checks the drafts against
         them; an empty field is simply left out of both. */
      phone: "(415) 612-8520",
      email: "pickup@safecycletech.com",
      serviceArea: "Bay Area, California",
      mission: "Collect unwanted electronics, refurbish what can be saved for local students and families, and responsibly recycle the rest.",
      voice: "Neighborly, practical, trustworthy, specific, and never pushy.",
      /* The exact block appended to the bottom of every post. Seeded from
         the contact fields above so the two cannot disagree on day one;
         plain text from then on, because it is copy and the operator
         edits it as copy. See js/signature.js. */
      cta: "",
      facts: [...DEFAULT_FACTS],
      prohibitedClaims: [...DEFAULT_RULES]
    },
    platforms: defaultPlatforms(),
    posts: [],
    /* The bin. Posts deleted within the retention window, newest first,
       each carrying the moment it was deleted. */
    deleted: [],
    runs: [],
    activity: []
  };
  data.organization.cta = defaultCtaText(data.organization);
  return data;
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
  /* The CTA replaced defaultCta, which was a one-line hint the model was
     asked to work in. This one is appended verbatim instead, so an old
     workspace takes the new seeded block rather than carrying forward a
     sentence that was written for a different job. */
  if (typeof data.organization.cta !== "string" || !data.organization.cta.trim()) {
    data.organization.cta = defaultCtaText(data.organization);
  }
  delete data.organization.defaultCta;
  data.organization.facts = asStringList(data.organization.facts, DEFAULT_FACTS);
  data.organization.prohibitedClaims = asStringList(data.organization.prohibitedClaims, DEFAULT_RULES);

  data.platforms = migratePlatforms(data);
  delete data.platformSettings;   /* folded into data.platforms above */

  data.posts = (Array.isArray(data.posts) ? data.posts : []).map(migratePost);
  /* A deleted post is a post plus the moment it went in the bin, so it
     migrates the same way anything else does — a workspace that has sat
     unopened through a schema change must not restore a post the rest of
     the app cannot read. */
  data.deleted = (Array.isArray(data.deleted) ? data.deleted : []).map((entry) => ({
    ...migratePost(entry),
    deletedAt: entry?.deletedAt || nowIso()
  }));
  /* Opening the workspace is the moment the clock is read. Nothing else
     runs on a schedule here — there is no server — so expiry happens
     wherever the operator next opens the studio, on any device. */
  purgeExpiredDeleted(data);

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

/* Deleted posts count. A post in the bin can be restored for thirty
   days, and it comes back referencing whatever platform it was written
   for — so that platform has to still be in the list, or the restored
   post fails validation and the workspace stops saving entirely. */
function referencedPlatformKeys(data) {
  const keys = new Set();
  const all = [
    ...(Array.isArray(data.posts) ? data.posts : []),
    ...(Array.isArray(data.deleted) ? data.deleted : [])
  ];
  for (const post of all) {
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
    /* The one thing a brief now has to say. Older posts predate it and
       carried the same information in keyMessage, so that is where their
       topic comes from rather than leaving the field blank. */
    topic: String(post?.topic || post?.keyMessage || ""),
    objective: String(post?.objective || ""),
    audience: String(post?.audience || ""),
    keyMessage: String(post?.keyMessage || ""),
    canonical: String(post?.canonical || ""),
    status: String(post?.status || "review"),
    source: post?.source === "external" ? "external" : "ai",
    createdAt: post?.createdAt || nowIso(),
    updatedAt: post?.updatedAt || post?.createdAt || nowIso(),
    tags: asStringList(post?.tags, []),
    /* Which brief fields the model filled in for itself. Recorded so the
       editor can label them as the model's reading rather than passing
       them off as something the operator said. */
    derived: asStringList(post?.derived, []),
    /* Superseded drafts, newest first. See snapshotGeneration. */
    generations: (Array.isArray(post?.generations) ? post.generations : [])
      .map(migrateGeneration)
      .slice(0, DRAFT_HISTORY_LIMIT),
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

function migrateGeneration(entry) {
  return {
    id: entry?.id || createId("gen"),
    at: entry?.at || nowIso(),
    note: String(entry?.note || ""),
    canonical: String(entry?.canonical || ""),
    ai: entry?.ai && typeof entry.ai === "object" ? entry.ai : null,
    variants: (Array.isArray(entry?.variants) ? entry.variants : []).map((variant) => ({
      variantId: String(variant?.variantId || ""),
      platform: String(variant?.platform || NEUTRAL_PLATFORM_KEY),
      title: String(variant?.title || ""),
      body: String(variant?.body || ""),
      aiBody: String(variant?.aiBody || ""),
      hashtags: asStringList(variant?.hashtags, []),
      notes: String(variant?.notes || ""),
      status: VARIANT_STATES.includes(variant?.status) ? variant.status : "draft"
    }))
  };
}

function migrateVariant(variant) {
  const body = String(variant?.body || "");
  const status = VARIANT_STATES.includes(variant?.status) ? variant.status : "draft";
  const scheduledAt = String(variant?.scheduledAt || "");
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
    /* An approved variant that carries a date IS scheduled, and older
       workspaces are full of ones that say otherwise: the date could be
       set from the brief or typed into the editor without ever going
       through the Schedule dialog, which was the only thing that moved
       the status. Normalizing on load is what stops the same post
       appearing in the Queue while the Overview counts nothing. */
    status: status === "approved" && scheduledAt ? "scheduled" : status,
    scheduledAt,
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
  if (!Array.isArray(data.deleted)) errors.push("Deleted posts must be an array.");
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
  const variants = post.variants || [];
  const states = variants.map((variant) => variant.status);
  if (!states.length) return "review";
  if (states.every((state) => state === "published")) return "published";
  if (states.some((state) => state === "published")) return "partial";
  /* A date makes it scheduled even where the status says otherwise —
     the same rule the Overview tile and the Queue read. */
  if (variants.some((variant) => variant.status === "scheduled" || isScheduled(variant))) return "scheduled";
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

/* A brief is one sentence plus whatever else the operator felt like
   typing, so the model is asked to fill in the rest of it — a name for
   the campaign, who it is aimed at, what it is for. Anything the operator
   DID supply always wins; the model only ever fills a blank.
   `derived` records which blanks it filled, because a reader of the
   Brief card is entitled to know which lines are the operator's own
   words and which are the model's reading of a one-line prompt. */
export function createPostFromGeneration(brief, generation, receipt) {
  const now = nowIso();
  const derived = [];
  const fill = (given, inferred, field) => {
    const own = String(given || "").trim();
    if (own) return own;
    const guess = String(inferred || "").trim();
    if (guess) derived.push(field);
    return guess;
  };

  return {
    id: createId("post"),
    campaign: fill(brief.campaign, generation.campaignName, "campaign") || "Untitled campaign",
    topic: brief.topic || brief.keyMessage || "",
    objective: fill(brief.objective, generation.objective, "objective"),
    audience: fill(brief.audience, generation.audience, "audience"),
    keyMessage: brief.keyMessage || "",
    canonical: generation.canonical || "",
    status: "review",
    source: "ai",
    createdAt: now,
    updatedAt: now,
    tags: splitTags(brief.tags),
    derived,
    generations: [],
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
    topic: "",
    objective: "",
    audience: "",
    keyMessage: "",
    canonical: body || "",
    status: "published",
    source: "external",
    createdAt: now,
    updatedAt: now,
    tags: [],
    derived: [],
    generations: [],
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

/* ------------------------------------------------------------
   THE BIN

   Deleting is a decision, and decisions get revisited. A post deleted
   here is moved rather than destroyed: it keeps everything it had —
   every platform version, its receipt, its publication record, its
   draft history — and comes back whole.

   The window is fixed at DELETED_RETENTION_DAYS. After that the entry
   is gone for good, and gone means gone: this app has no server, so
   there is no other copy but the gist's own revision history.
   ------------------------------------------------------------ */

const DAY_MS = 86400000;

export function deletionExpiresAt(entry) {
  const at = Date.parse(entry?.deletedAt || "");
  return Number.isNaN(at) ? 0 : at + DELETED_RETENTION_DAYS * DAY_MS;
}

/** Whole days left before this is removed for good; never below zero. */
export function deletionDaysLeft(entry, now = Date.now()) {
  return Math.max(0, Math.ceil((deletionExpiresAt(entry) - now) / DAY_MS));
}

/** How many entries were removed for good. Callers save when it is >0. */
export function purgeExpiredDeleted(data, now = Date.now()) {
  const current = Array.isArray(data.deleted) ? data.deleted : [];
  const before = current.length;
  data.deleted = current
    .filter((entry) => deletionExpiresAt(entry) > now)
    /* Newest first, so the cap below trims the oldest. */
    .sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt))
    .slice(0, DELETED_LIMIT);
  return before - data.deleted.length;
}

/* Out of the library, into the bin. Returns the entry so the caller can
   offer an immediate undo as well as the 30 days. */
export function softDeletePost(data, post) {
  const index = data.posts.indexOf(post);
  if (index >= 0) data.posts.splice(index, 1);
  const entry = { ...post, deletedAt: nowIso() };
  data.deleted.unshift(entry);
  purgeExpiredDeleted(data);
  return entry;
}

/* Back out of the bin, at the top of the library. The id is re-minted
   only if something has taken it in the meantime — an imported backup
   can reintroduce a post that was deleted here, and two posts sharing an
   id is a workspace that fails validation. */
export function restoreDeletedPost(data, postId) {
  const index = data.deleted.findIndex((entry) => entry.id === postId);
  if (index < 0) return null;

  const [entry] = data.deleted.splice(index, 1);
  const { deletedAt, ...post } = entry;
  if (data.posts.some((existing) => existing.id === post.id)) post.id = createId("post");
  post.updatedAt = nowIso();
  data.posts.unshift(post);
  return post;
}

export function removeDeletedForever(data, postId) {
  const index = data.deleted.findIndex((entry) => entry.id === postId);
  if (index < 0) return null;
  return data.deleted.splice(index, 1)[0];
}

/* ------------------------------------------------------------
   DRAFT HISTORY

   Re-running the model over a post replaces text the operator may have
   spent time on, and "I liked the last one better" is not a recoverable
   position unless the last one was kept. So every re-run — and every
   restore — snapshots what it is about to overwrite first.

   A snapshot is a copy, not a reference: the whole point is that later
   edits to the live post must not reach back and change what the record
   says the earlier draft looked like.
   ------------------------------------------------------------ */

export function snapshotGeneration(post, { note = "" } = {}) {
  return {
    id: createId("gen"),
    at: nowIso(),
    note,
    /* The receipt of the run that produced this text, so an old draft can
       still say which model wrote it after a newer run has moved
       post.ai on. */
    ai: post.ai ? structuredClone(post.ai) : null,
    canonical: post.canonical || "",
    variants: (post.variants || []).map((variant) => ({
      variantId: variant.id,
      platform: variant.platform,
      title: variant.title || "",
      body: variant.body || "",
      aiBody: variant.aiBody || "",
      hashtags: [...(variant.hashtags || [])],
      notes: variant.notes || "",
      status: variant.status
    }))
  };
}

export function pushGeneration(post, snapshot) {
  post.generations = [snapshot, ...(post.generations || [])].slice(0, DRAFT_HISTORY_LIMIT);
  return post.generations;
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

/* ------------------------------------------------------------
   WHAT COUNTS AS SCHEDULED

   These two predicates exist because the Overview tile, the sidebar
   badge, the Up next list and the Queue page each used to decide for
   themselves, and they disagreed. The visible symptom: a post given a
   date on the New draft form sat in the Queue under its day heading
   while the Overview said "Scheduled 0" — the tile was counting the
   variant STATUS, and a variant can carry a date while its status is
   still draft or approved.

   A date is the whole of what "scheduled" means here. Nothing in this
   app publishes on a timer, so the date is a note in a diary: if it is
   set and the post has not gone out yet, it is on the calendar,
   whatever else is true about it. Everything that reports a schedule
   now reads these.
   ------------------------------------------------------------ */

export function isScheduled(variant) {
  return Boolean(variant?.scheduledAt) && variant.status !== "published";
}

/* The Queue also carries approved posts with no date yet — they are
   waiting on a person, which is what that page is for. */
export function isQueued(variant) {
  return variant?.status !== "published" && (Boolean(variant?.scheduledAt) || variant?.status === "approved");
}

export function isOverdue(variant) {
  return isScheduled(variant) && Date.parse(variant.scheduledAt) < Date.now();
}

export function countsFor(data) {
  const pairs = allVariants(data);
  return {
    posts: data.posts.length,
    needsReview: data.posts.filter((post) => derivePostStatus(post) === "review").length,
    approved: pairs.filter(({ variant }) => variant.status === "approved").length,
    scheduled: pairs.filter(({ variant }) => isScheduled(variant)).length,
    /* What the Queue page shows, so the sidebar badge and that page can
       never report different numbers. */
    queued: pairs.filter(({ variant }) => isQueued(variant)).length,
    published: pairs.filter(({ variant }) => variant.status === "published").length,
    overdue: pairs.filter(({ variant }) => isOverdue(variant)).length,
    deleted: (data.deleted || []).length
  };
}
