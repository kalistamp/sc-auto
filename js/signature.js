/* ============================================================
   SAFE CYCLE STUDIO — the call to action

   Every post ends with the same block, word for word:

     Check out https://safecycletech.com to learn more about our
     organization and how we're helping the community.

     Call or text (415) 612-8520 or email pickup@safecycletech.com
     to schedule a pickup.

   IT IS APPENDED, NOT WRITTEN
   ---------------------------
   The model never writes this. buildCopyText() adds it once, at the
   moment a post is copied or recorded as published, from
   organization.cta — so the wording cannot drift between posts, a
   re-run cannot reword it, and there is exactly one place to edit it.

   That is a deliberate reversal of how the rest of this app treats
   copy. Everywhere else the model writes and a person edits, because
   varied wording is the point. Here the requirement is the opposite:
   the operator asked for this exact text under every post.

   WHY APPENDING AT COPY TIME RATHER THAN AT GENERATION
   ----------------------------------------------------
   If the CTA were written into variant.body, it would be fed back to
   the model as "previousDrafts" on a re-run, come back inside the new
   draft, and be appended again on top. Keeping it out of the body
   entirely makes that impossible rather than merely unlikely. The
   operator still sees it: the ready-to-paste block in the editor is
   built by the same buildCopyText().

   THE DUPLICATION PROBLEM
   -----------------------
   The model is told not to write contact details. It will sometimes
   write them anyway, and then the post would carry the phone number
   twice. Two defences, in order:

     1. stripSignOff() removes a trailing sign-off from what the model
        returned, before it is ever stored. High precision: it only
        takes whole trailing paragraphs and lines that carry a contact
        detail, and never strips a draft down to nothing.

     2. duplicateFindings() warns about anything left — a phone number
        in the middle of a sentence, or one the operator typed in
        themselves later. That case is a judgement call about prose, so
        it goes to the person rather than to a regex.

   Between them, the common shape (model appends its own sign-off) is
   removed automatically, and the rare shape is surfaced before the
   post goes out.
   ============================================================ */

/* Characters that may sit between the digits of a phone number without
   making it a different phone number. Kept narrow on purpose: a comma
   or a slash between digits means something else is going on. */
const PHONE_GAP = "[\\s().+\\u2010-\\u2015-]*";

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* The registrable part of a URL, with the scheme, any www. and
   everything after the host removed, so that a draft writing
   "safecycletech.com" plainly still counts as carrying the website —
   which is how it has to be written on Instagram anyway. */
export function siteHost(url) {
  const bare = String(url || "").trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^www\./i, "");
  return bare.split(/[/?#]/)[0].trim().toLowerCase();
}

/* The last ten digits, which is the number regardless of how it was
   typed and regardless of a +1 in front of it. */
function phoneDigits(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * The contact routes this organization has recorded, each knowing how to
 * recognise itself in text however it has been formatted.
 *
 * Only fields with a value produce a route, so an organization that has
 * never entered an email is never warned about a duplicate one.
 */
export function signatureRoutes(organization = {}) {
  const routes = [];

  const digits = phoneDigits(organization.phone);
  if (digits.length >= 7) {
    routes.push({
      key: "phone",
      label: "phone number",
      display: String(organization.phone).trim(),
      /* Matched on the digits alone, so "(415) 612-8520", "415-612-8520"
         and "+1 415 612 8520" are all the same number. */
      pattern: new RegExp(digits.split("").join(PHONE_GAP), "g")
    });
  }

  const email = String(organization.email || "").trim();
  if (email.includes("@")) {
    routes.push({
      key: "email",
      label: "email address",
      display: email,
      pattern: new RegExp(escapeRegex(email), "gi")
    });
  }

  const host = siteHost(organization.website);
  if (host.includes(".")) {
    routes.push({
      key: "website",
      label: "website",
      /* Without the trailing slash, so every place this is shown to a
         person — or to the model — matches how the CTA writes it. */
      display: String(organization.website).trim().replace(/\/+$/, ""),
      /* The host is enough. Requiring the scheme would miss every draft
         that writes the domain the way a person would say it. */
      pattern: new RegExp(escapeRegex(host), "gi")
    });
  }

  return routes;
}

function hasRoute(text, route) {
  /* Fresh lastIndex every time: these patterns carry /g and are reused
     across calls, and a leftover lastIndex silently skips matches. */
  route.pattern.lastIndex = 0;
  return route.pattern.test(text);
}

/* ------------------------------------------------------------
   THE BLOCK ITSELF
   ------------------------------------------------------------ */

/**
 * The wording a fresh workspace starts with, built from the contact
 * fields so the seeded text and the seeded phone number cannot disagree.
 * Stored as text from then on — it is copy, and the operator edits it as
 * copy in Settings.
 */
export function defaultCtaText(organization = {}) {
  const site = String(organization.website || "").trim().replace(/\/+$/, "");
  const phone = String(organization.phone || "").trim();
  const email = String(organization.email || "").trim();

  const lines = [];
  if (site) lines.push(`Check out ${site} to learn more about our organization and how we’re helping the community.`);

  const reach = [phone && `Call or text ${phone}`, email && `email ${email}`].filter(Boolean).join(" or ");
  if (reach) lines.push(`${reach} to schedule a pickup.`);

  return lines.join("\n\n");
}

/** The exact text appended to every post, or "" if the operator cleared it. */
export function ctaBlock(organization = {}) {
  return String(organization?.cta || "").trim();
}

/**
 * Which recorded contact routes the CTA text does NOT mention.
 *
 * The CTA is free text and the contact fields are separate, so they can
 * drift — an operator who changes the phone number in Settings and not
 * the CTA would quietly start publishing the old one. Surfaced in
 * Settings rather than enforced: the CTA is theirs to word.
 */
export function ctaCoverage(organization = {}) {
  const cta = ctaBlock(organization);
  if (!cta) return [];
  return signatureRoutes(organization).filter((route) => !hasRoute(cta, route));
}

/* ------------------------------------------------------------
   DEFENCE 1 — take the model's own sign-off off the end
   ------------------------------------------------------------ */

/**
 * Remove a trailing sign-off from a generated draft.
 *
 * Only ever removes from the END, and only whole paragraphs and whole
 * lines that carry a contact detail — a trailing paragraph containing
 * the phone number IS the sign-off, whatever else it says. A contact
 * detail in the middle of the copy is left alone and reported by
 * duplicateFindings() instead, because editing someone's prose around
 * it is not a thing a regex should attempt.
 *
 * Never returns an empty string for a non-empty draft: if every
 * paragraph carries a contact detail, the draft is left as it is and
 * the operator gets a warning. Silently deleting the whole post would
 * be much worse than a duplicate phone number.
 */
export function stripSignOff(body, organization = {}) {
  const text = String(body || "");
  if (!text.trim()) return text.trim();

  const routes = signatureRoutes(organization);
  if (!routes.length) return text.trim();

  const carriesContact = (chunk) => routes.some((route) => hasRoute(chunk, route));

  /* Paragraphs first: the usual shape is a blank line and then the
     sign-off as its own block. */
  const paragraphs = text.trim().split(/\n\s*\n/);
  let end = paragraphs.length;
  while (end > 1 && carriesContact(paragraphs[end - 1])) end -= 1;
  const kept = paragraphs.slice(0, end);

  /* Then trailing lines inside what is now the last paragraph, for the
     shape where the sign-off is a line break rather than a blank line. */
  const lines = kept[kept.length - 1].split("\n");
  let lineEnd = lines.length;
  while (lineEnd > 1 && carriesContact(lines[lineEnd - 1])) lineEnd -= 1;
  kept[kept.length - 1] = lines.slice(0, lineEnd).join("\n").trim();

  const result = kept.filter(Boolean).join("\n\n").trim();

  /* The all-contact-details case. Keep the draft whole. */
  return result || text.trim();
}

/* ------------------------------------------------------------
   DEFENCE 2 — report whatever survived
   ------------------------------------------------------------ */

/**
 * Warnings about contact details still in the body.
 *
 * Every one of these means the finished post would say the same thing
 * twice, because the CTA carries it too. Warnings rather than errors,
 * like every other check in this app — the operator may have written
 * "call us on the number below" deliberately.
 *
 * Returns [] when there is no CTA to duplicate against.
 */
export function duplicateFindings(body, organization = {}) {
  const text = String(body || "");
  if (!text.trim()) return [];

  const cta = ctaBlock(organization);
  if (!cta) return [];

  /* Only routes the CTA actually carries can be duplicated by it. */
  const routes = signatureRoutes(organization).filter((route) => hasRoute(cta, route));
  const found = routes.filter((route) => hasRoute(text, route));
  if (!found.length) return [];

  const names = found.map((route) => route.label);
  return [{
    level: "warn",
    text: `The ${listOf(names)} ${found.length === 1 ? "is" : "are"} already in the call to action added to every post. ` +
      `Leaving ${found.length === 1 ? "it" : "them"} in the draft too means the post says ${found.length === 1 ? "it" : "them"} twice.`
  }];
}

/* ------------------------------------------------------------
   THE PROMPT SIDE
   ------------------------------------------------------------ */

/**
 * The section of the generation prompt that keeps the model out of the
 * CTA's way. Returns "" when there is no CTA, in which case the model is
 * given no instruction about one.
 */
export function ctaRules(organization = {}) {
  const cta = ctaBlock(organization);
  if (!cta) return "";

  const routes = signatureRoutes(organization).filter((route) => hasRoute(cta, route));
  const details = routes.map((route) => `${route.label} (${route.display})`);

  return `Contact details and sign-off — leave them out
This post already ends with a fixed call to action. It is added automatically after you are done, word for word, and it reads:

-----
${cta}
-----

So do not write a sign-off, a closing call to action, or any contact details of your own.${details.length ? ` In particular the ${listOf(details)} must not appear anywhere in what you write — ${routes.length === 1 ? "it is" : "they are"} in the block above, and repeating ${routes.length === 1 ? "it" : "them"} makes the post say the same thing twice.` : ""}

Write the post so it reads as finished without one: end on the last thing you actually have to say, not on "get in touch" or "reach out today". The block above supplies that. Do not refer to it either — no "see below", no "details at the bottom".`;
}

/* "a, b and c" — this list is read by a person, and "phone number,
   email address, website" reads like a form label rather than a
   sentence. */
function listOf(items) {
  if (items.length <= 1) return items[0] || "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
