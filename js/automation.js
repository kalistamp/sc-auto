/* Shared automation schema and content policy. No browser or clock dependencies. */
export const AUTOMATION_PLATFORMS = ["facebook", "reddit", "nextdoor", "craigslist", "offerup"];
/* Craigslist and OfferUp are listings, not entries in the draft platform
   list, so their names live here rather than in the platform registry. */
export const AUTOMATION_LABELS = { facebook: "Facebook", reddit: "Reddit", nextdoor: "Nextdoor", craigslist: "Craigslist", offerup: "OfferUp" };
export const ACTIVE_ATTEMPTS = ["claimed", "submitting", "verifying", "uncertain"];

export function defaultAutomation() {
  return {
    enabled: false, dryRun: true, timezone: "America/Los_Angeles",
    generationEnabled: false, generationLimit: 1, repeatDays: 0, images: [],
    policy: { daily: 1, weekly: 4, gapHours: 24, quietStart: 20, quietEnd: 8 },
    platforms: Object.fromEntries(AUTOMATION_PLATFORMS.map((key) => [key, {
      enabled: false, destination: "", gapHours: key === "nextdoor" ? 336 : key === "facebook" ? 72 : 168,
      daily: 1, weekly: key === "facebook" ? 2 : 1, ...(key === "reddit" ? { subreddits: [] } : {})
    }])),
    topics: [], listings: []
  };
}

export function normalizeAutomation(value) {
  const base = defaultAutomation();
  if (!value || typeof value !== "object") return base;
  return {
    ...base, ...value, enabled: value.enabled === true, dryRun: value.dryRun !== false,
    generationEnabled: value.generationEnabled === true,
    policy: { ...base.policy, ...value.policy },
    platforms: Object.fromEntries(AUTOMATION_PLATFORMS.map((key) => [key,
      { ...base.platforms[key], ...value.platforms?.[key], enabled: value.platforms?.[key]?.enabled === true,
        ...(key === "reddit" ? { subreddits: normalizeSubreddits(value.platforms?.reddit?.subreddits) } : {}) }])),
    topics: Array.isArray(value.topics) ? value.topics : [],
    images: Array.isArray(value.images) ? value.images : [],
    listings: Array.isArray(value.listings) ? value.listings : []
  };
}

/* ------------------------------------------------------------
   REDDIT — one post, one subreddit

   Reddit treats the same post in several subreddits as spam, and each
   subreddit sets its own rules. So a Reddit post goes to exactly one
   subreddit from the operator's list: the enabled one that has waited
   longest since its last post, provided its own waiting time has passed and
   nothing else is already queued for it. The choice is made when the post is
   scheduled, shown in the Queue, and bound into the approval.
   ------------------------------------------------------------ */
export const SUBREDDIT_NAME = /^[A-Za-z0-9_]{2,21}$/;

function normalizeSubreddits(list) {
  return (Array.isArray(list) ? list : []).map((entry) => ({
    name: String(entry?.name || "").trim().replace(/^\/?r\//i, ""),
    flair: String(entry?.flair || "").trim(),
    gapDays: Number.isInteger(entry?.gapDays) && entry.gapDays >= 1 ? entry.gapDays : 30,
    enabled: entry?.enabled === true,
    note: String(entry?.note || "").trim()
  })).filter((entry) => entry.name);
}

export function subredditsOf(automation) { return automation?.platforms?.reddit?.subreddits || []; }

/* The page a version is posted from. For Reddit with a subreddit list, the
   chosen subreddit's own submit page — or nothing until one is chosen. */
export function destinationFor(automation, variant) {
  if (variant?.platform === "reddit" && subredditsOf(automation).length)
    return variant.subreddit ? `https://www.reddit.com/r/${variant.subreddit}/submit` : "";
  return automation?.platforms?.[variant?.platform]?.destination || "";
}

export function pickSubreddit(automation, posts, now = Date.now(), exceptVariantId = "") {
  const key = (name) => String(name || "").toLowerCase();
  const reddit = (posts || []).filter((post) => post.status !== "archived").flatMap((post) => post.variants || [])
    .filter((variant) => variant.platform === "reddit" && variant.subreddit && variant.id !== exceptVariantId);
  const waiting = new Set(reddit.filter((variant) => variant.status !== "published").map((variant) => key(variant.subreddit)));
  const lastPost = (name) => Math.max(0, ...reddit.filter((variant) => variant.status === "published" && key(variant.subreddit) === key(name))
    .map((variant) => Date.parse(variant.publishedAt) || 0));
  const free = subredditsOf(automation).filter((entry) => entry.enabled && !waiting.has(key(entry.name))
    && lastPost(entry.name) + entry.gapDays * 86400000 <= now);
  free.sort((a, b) => lastPost(a.name) - lastPost(b.name));
  return free[0]?.name || null;
}

export function automationErrors(value) {
  const errors = [];
  for (const entry of subredditsOf(value)) {
    if (!SUBREDDIT_NAME.test(entry.name)) errors.push(`"${entry.name}" is not a subreddit name (letters, numbers and _ only, like bayarea).`);
  }
  try { new Intl.DateTimeFormat("en", { timeZone: value.timezone }); }
  catch { errors.push("Choose a valid automation timezone."); }
  for (const policy of [value.policy, ...Object.values(value.platforms)]) {
    for (const key of ["daily", "weekly", "gapHours"]) {
      if (!Number.isInteger(policy[key]) || policy[key] < 1) errors.push(`${key} must be a positive integer.`);
    }
  }
  for (const key of ["quietStart", "quietEnd"]) {
    if (!Number.isInteger(value.policy[key]) || value.policy[key] < 0 || value.policy[key] > 23) errors.push("Quiet hours must be 0–23.");
  }
  // Equal ends would make every hour quiet, and nothing would ever post.
  if (value.policy.quietStart === value.policy.quietEnd) errors.push("Quiet hours must start and end at different hours.");
  if (!Number.isInteger(value.generationLimit) || value.generationLimit < 1 || value.generationLimit > 10) errors.push("Generation limit must be 1–10 per day.");
  if (!Number.isInteger(value.repeatDays) || value.repeatDays < 0 || (value.repeatDays > 0 && value.repeatDays < 30)) errors.push("Topic repeats must be disabled (0) or at least 30 days apart.");
  return errors;
}

/* Stable serialized approval material, not a security token. The runner hashes it
   with SHA-256 for the durable journal. Include CTA, rules and destination. */
export function approvalMaterial(variant, organization, destination, copy) {
  return JSON.stringify({ platform: variant.platform, title: variant.title || "", copy,
    destination, organization, photos: variant.photos || [],
    listing: variant.kind ? { kind: variant.kind, category: variant.category, area: variant.area, price: variant.price, condition: variant.condition } : null });
}

/* ------------------------------------------------------------
   CLAIM RISKS — what organization.prohibitedClaims forbids inventing.

   No regex can prove a sentence true. What it can do is notice wording of
   the kinds the rules name — a partnership, a certification, a testimonial,
   a person's story, a number, a date or event, a price or time promise — and
   hold the post for a person unless a person already wrote the same words:
   in the approved facts, the mission, or the brief's topic. The check is on
   the matched phrase plus the word after it (or before it, at the end of a
   sentence), so "certified California electronics recyclers" (an approved
   fact) passes while "a certified recycler" and "fully certified." do not.
   A number must match a whole number in the approved text, and a name — a
   capitalised word inside a sentence — must appear there too, which is what
   catches an invented school, business, partner or person. Placeholders are
   never waived.
   ------------------------------------------------------------ */
const CLAIM_RISKS = [
  ["a partnership", true, [/\b(?:partner(?:s|ed|ing|ships?)?|teamed up|team(?:ing)? up|in collaboration|collaborat\w*|sponsor\w*|affiliated|endorse\w*|work(?:s|ing)? with|joined forces|friends at|supported by|backed by|funded by|grants?)\b/gi]],
  ["a certification or award", true, [/\b(?:certif\w*|accredit\w*|licensed|awards?|award[- ]winning|approved by|recogni[sz]ed by|compliant|e-?stewards)\b/gi, /\bR2\b/g, /\bISO\s?\d+/gi]],
  ["a quote or testimonial", true, [/[“"][^”"\n]{12,}[”"]/g, /\b(?:testimonials?|five[- ]star|told us)\b/gi, /(?<!\bthat )\bsaid\b/gi]],
  ["a person's story", true, [/\b(?:[Mm]eet|[Tt]hanks to|[Tt]hank you to)\s+[A-Z][a-z]+/g, /\b(?:a|one|this|our)\s+(?:student|family|mom|mother|dad|father|parent|teacher|donor|neighbor|resident|veteran|senior|kid|child)\s+(?:named|who)\b/gi]],
  ["a date, day or event", true, [/\b(?:mon|tues|wednes|thurs|fri|satur|sun)days?\b/gi, /\b(?:january|february|march|april|june|july|august|september|october|november|december)\b/gi,
    /\b(?:today|tonight|tomorrow|yesterday|recently|this weekend|this week|this month|this year|next week(?:end)?|last (?:week(?:end)?|month|year))\b/gi,
    /\b(?:events?|workshops?|festivals?|open house|drop-?offs?|deadlines?)\b/gi]],
  ["a price, time promise or tax outcome", true, [/\$\s?\d/g, /\b(?:tax\w*|deductib\w*|receipts?|same[- ]day|next[- ]day|24\/7|within an? (?:hour|day|week)|guarantee\w*|promise\w*)\b/gi]],
  // The standing rule: never claim every device is refurbished.
  ["a claim about every device", true, [/\b(?:every|all|each)\b[^.!?\n]{0,40}?\b(?:refurbish\w*|reused|restored|given to|goes? to (?:a )?(?:student|famil))/gi, /\b100\s?%/g]],
  ["a number", true, [/\b(?:dozens?|hundreds?|thousands?|millions?|countless|tons of|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi]],
  ["a superlative", true, [/\b(?:leading|largest|biggest|number one|top[- ]rated|premier|most trusted)\b|#1\b/gi]],
  ["a link or handle", true, [/https?:\/\/\S+|\bwww\.\S+|(?:^|\s)@\w+/gi]],
  ["an unfinished placeholder", false, [/\[[^\]\n]*\]|\{[^}\n]*\}|\bTBD\b|\bTODO\b|\bXX+\b|lorem ipsum/gi]]
];
const squash = (text) => String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
const wholeNumbers = (text) => new Set([...String(text || "").matchAll(/\d[\d,.:/-]*/g)].map((match) => match[0].replace(/[.,:/-]+$/, "")));
const wordsOf = (text) => new Set(squash(text).split(/[^\p{L}\p{N}'’-]+/u).filter(Boolean));
/* How a post refers to where it is, not a claim. */
const PLATFORM_NAMES = new Set(["facebook", "reddit", "nextdoor", "craigslist", "offerup", "instagram"]);

/* Capitalised words inside a sentence that the approved text never uses.
   A line in Title Case (typically a Reddit title) is skipped: there every
   word is capitalised, so capitals say nothing about names. */
function unapprovedNames(source, approvedWords) {
  const found = [];
  for (const line of source.split("\n")) {
    const long = (line.match(/\p{L}[\p{L}'’-]*/gu) || []).filter((token) => token.length >= 4);
    if (long.length >= 3 && long.filter((token) => /^\p{Lu}/u.test(token)).length / long.length >= 0.6) continue;
    for (const match of line.matchAll(/(?<![#@\p{L}\p{N}'’-])\p{Lu}[\p{L}'’-]*/gu)) {
      const before = line.slice(0, match.index).trimEnd();
      if (!before || /[.!?:;…"“(\[—–-]$/.test(before)) continue;   // the start of a sentence
      const word = match[0].replace(/['’]s$/, "");
      if (word === "I" || /^I['’]/.test(match[0])) continue;
      if (approvedWords.has(word.toLowerCase()) || PLATFORM_NAMES.has(word.toLowerCase())) continue;
      found.push(word);
    }
  }
  return found;
}

/** Findings, as review reasons, for claim-shaped wording nobody approved. */
export function claimRisks(text, approvedText) {
  const source = String(text || ""), approved = squash(approvedText), found = new Map();
  const note = (label, value) => found.set(label, new Set([...(found.get(label) || []), value.trim()]));
  for (const [label, waivable, patterns] of CLAIM_RISKS) {
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        // Context is the next word, or at the end of a sentence the previous one.
        const next = source.slice(match.index + match[0].length).match(/^[^\w\n.!?]{0,3}(\w[\w'-]*)/)?.[1];
        const previous = source.slice(0, match.index).match(/(\w[\w'-]*)[^\w\n]{0,3}$/)?.[1];
        const phrase = next ? `${match[0]} ${next}` : previous ? `${previous} ${match[0]}` : match[0];
        if (waivable && approved.includes(squash(phrase))) continue;
        note(label, match[0]);
      }
    }
  }
  // Every number is a claim; each must be a whole number the approved text uses.
  const approvedNumbers = wholeNumbers(approvedText);
  for (const number of wholeNumbers(source)) if (!approvedNumbers.has(number)) note("a number", number);
  for (const name of unapprovedNames(source, wordsOf(approvedText))) note("a name (a person, school, business or partner)", name);
  return [...found].map(([label, values]) => `Mentions ${label} that is not in your approved facts or the brief: ${[...values].slice(0, 3).map((value) => `"${value}"`).join(", ")}.`);
}

/* Text a person wrote, which a draft may repeat without further review. */
export function approvedText(organization = {}, brief = null) {
  return [...(organization.facts || []), organization.mission, organization.serviceArea, organization.name,
    organization.website, brief?.topic, brief?.keyMessage].filter(Boolean).join("\n");
}

/* A model's note to the operator that asks for something to be checked
   means the model itself was not sure. */
const UNSURE_NOTE = /\b(?:confirm|verify|check|make sure|double[- ]check|placeholder|replace|fill in|insert)\b/i;

/* Policy for posts nobody reads before they go out.
   · Structural errors always block, approval or not.
   · Exact-copy approval by a person clears everything else, because a
     person has read these words for this destination.
   · Otherwise every warning holds the post: over-length, absolute claims,
     unverified figures, voice findings, duplicated contacts, the model's own
     warnings, a repeat of an earlier post, a note asking for a check, and any
     claim-shaped wording that nobody approved (claimRisks above).
   A held post goes to review with its reasons; it is never dropped. */
export function autonomousGate({ variant, organization, destination, copy, checks = [], warnings = [], brief = null }) {
  const errors = checks.filter((check) => check.level === "error").map((check) => check.text);
  if (!destination) errors.push("Account destination is not configured.");
  if (!copy?.trim()) errors.push("The outgoing copy is empty.");
  if (errors.length) return { ok: false, reasons: errors };
  const material = approvalMaterial(variant, organization, destination, copy);
  if (variant.automation?.approval === material) return { ok: true, reasons: [] };
  const allowed = approvedText(organization, brief);
  const wording = [variant.title, variant.body, ...(variant.hashtags || [])].filter(Boolean).join("\n");
  const risks = claimRisks(wording, allowed);
  const reasons = [
    // The generic figure warning is settled here instead: a number that
    // appears in an approved fact has a source, and any other is in `risks`.
    ...checks.filter((check) => check.level !== "error" && !/^Mentions a figure\./.test(check.text)).map((check) => check.text),
    ...warnings, ...risks,
    ...(UNSURE_NOTE.test(variant.notes || "") ? [`The draft's note asks for a check: "${String(variant.notes).trim().slice(0, 200)}"`] : [])
  ];
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function listingErrors(listing) {
  const errors = [];
  if (!["craigslist", "offerup"].includes(listing.platform)) errors.push("Choose a listing platform.");
  if (!["item", "service"].includes(listing.kind)) errors.push("Choose item or service.");
  for (const key of ["title", "body", "category", "area"]) if (!listing[key]?.trim()) errors.push(`Listing needs ${key}.`);
  if (listing.kind === "item" && (!listing.condition || !Number.isFinite(listing.price) || listing.price < 0)) errors.push("Items need condition and a nonnegative price.");
  if (!listing.photos?.length) errors.push("Supply real photos or a service logo on the runner host.");
  if (!["create", "renew"].includes(listing.operation)) errors.push("Choose create or renew.");
  if (listing.operation === "renew" && !listing.publishedUrl) errors.push("Renewal needs the existing permalink.");
  const renew = listing.renewDays ?? 0;
  if (!Number.isInteger(renew) || renew < 0 || (renew > 0 && renew < 7)) errors.push("Renew every 7 days or more, or 0 for never.");
  return errors;
}
