/* ============================================================
   SAFE CYCLE STUDIO — platform rules and handoff

   Publishing stays manual by design. Automating the final submission
   through scraping or browser automation is what puts an account at
   risk; using a model to help write a post does not. So this module
   does two things only: it checks a draft against what each platform
   expects, and it hands the finished text off — to the clipboard, and
   to the platform's own front door.

   CHANGE (schema 3): the handoff is now identical everywhere. It used to
   open a composer, and for Reddit it pushed the draft into that composer
   through URL parameters. Two reasons that went away:

     · It only worked on one platform, so the final step of the workflow
       behaved differently depending on where you were posting — and the
       step where a mistake actually publishes something is the worst
       place to be inconsistent.
     · Prefilling a composer is this app reaching into a submission form.
       It stops short of pressing the button, but it is the first inch of
       a road the project deliberately does not travel, and the stated
       workflow is: open the platform, log in, paste it yourself.

   So every platform offers exactly one link — its home or login page —
   and the text travels by clipboard. A platform added years from now
   works the same way as the ones shipped here.

   No code path in this file, or anywhere in js/, submits a post.
   tests/static.test.mjs enforces that.
   ============================================================ */

import { getOrganization, getPlatform } from "./data.js";
import { ctaBlock, duplicateFindings } from "./signature.js";
import { scanVoice } from "./voice.js";

export function platformLabel(key) {
  return getPlatform(key).label;
}

export function platformColor(key) {
  return getPlatform(key).color;
}

/* Checks, not blocks. Every one of these is something a person should
   look at before publishing; none of them stop a post from going out,
   because the operator knows things this app does not.

   `organization` defaults to the active workspace record and only feeds
   the duplicate-contact check: without one there is no call to action to
   duplicate, so that check is skipped rather than guessed at. Every
   other check here works on the variant alone. */
export function variantChecks(variant, organization = getOrganization()) {
  /* Always an object, even for a platform that has since been removed —
     see getPlatform. The `?.` guards below are kept anyway: they cost
     nothing and this function is called on hand-editable data. */
  const meta = getPlatform(variant.platform);
  const checks = [];
  const body = variant.body || "";

  /* Emptiness is about what the operator wrote, not about what gets
     pasted: a draft with nothing in it but an appended CTA is empty. */
  if (!body.trim()) checks.push({ level: "error", text: "This draft has no body text yet." });

  /* Length, though, is about what gets pasted. The CTA and the hashtags
     both go out with the post and both count against the platform's
     ceiling, so measuring variant.body alone would clear a draft that is
     actually over the limit. */
  const outgoing = buildCopyText(variant).length;

  if (meta?.bodyMax && outgoing > meta.bodyMax) {
    checks.push({ level: "error", text: `${outgoing - meta.bodyMax} characters over ${meta.label}'s limit of ${meta.bodyMax.toLocaleString()}.` });
  } else if (meta?.soft && outgoing > meta.soft) {
    checks.push({ level: "warn", text: `Longer than most ${meta.label} posts. Consider trimming to about ${meta.soft.toLocaleString()} characters.` });
  }

  if (meta?.titleMax) {
    if (!variant.title?.trim()) checks.push({ level: "error", text: `${meta.label} needs a title.` });
    else if (variant.title.length > meta.titleMax) {
      checks.push({ level: "error", text: `Title is ${variant.title.length - meta.titleMax} characters over the ${meta.titleMax}-character limit.` });
    }
  }

  if (/\bguarantee|guaranteed|every device (is|gets) refurbished|100%\b/i.test(body)) {
    checks.push({ level: "warn", text: "Contains an absolute claim. Confirm it is true as written before publishing." });
  }

  /* Numbers are the single most common way a well-meaning draft says
     something the organization cannot back up. */
  if (/\b\d[\d,]{2,}\b|\b\d+(\.\d+)?\s?(tons?|pounds?|lbs?|families|students|devices|computers)\b/i.test(body)) {
    checks.push({ level: "warn", text: "Mentions a figure. Check it against a source you can point to." });
  }

  const hashtags = (body.match(/#\w+/g) || []).length + (variant.hashtags?.length || 0);
  if (hashtags > 5) checks.push({ level: "warn", text: `${hashtags} hashtags is more than most ${meta?.label || "platforms"} posts need.` });

  if (variant.platform === "instagram" && !variant.notes?.trim()) {
    checks.push({ level: "warn", text: "Instagram needs an image. Note which photo goes with this caption." });
  }

  /* Voice comes last so the checks that describe real breakage — empty
     body, over the limit, missing title — stay at the top of the list
     where they are read first. Every voice finding is a warning and
     none of them can block approval; see js/voice.js. */

  /* The title gets scanned too, where the platform has one. It is the
     most-read line of a Reddit post and the likeliest place for a
     generated opener to survive review, and voice.js's OPENERS patterns
     are anchored to the start of the text — built for exactly this field,
     but until now never shown one. Findings are prefixed because "Opens
     with a rhetorical question" is confusing advice if the operator
     cannot tell which box it is about. */
  if (meta?.titleMax && variant.title?.trim()) {
    for (const finding of scanVoice(variant.title)) {
      checks.push({ ...finding, text: `Title: ${finding.text}` });
    }
  }

  /* Contact details the appended CTA already carries. Above the voice
     findings because a post that prints the phone number twice is a
     content problem, and the voice findings are style advice the
     operator may reasonably ignore. */
  checks.push(...duplicateFindings(body, organization));

  checks.push(...scanVoice(body));

  return checks;
}

/**
 * The platform's home or login page — where the operator goes to paste.
 *
 * Takes a platform key or a variant, because roughly half the call sites
 * have one and half the other, and a helper that only accepted one of
 * them just moved the unwrapping outward.
 *
 * Returns "" when the platform has no link: the neutral "Any platform"
 * option has no single home page, and a platform the operator added may
 * not have a URL yet. Callers must treat "" as "no button", never as a
 * reason to invent a destination — the old version of this function
 * fell back to the organization's own website, which sent the operator
 * somewhere they had not asked to go.
 */
export function platformHomeUrl(target) {
  const key = typeof target === "string" ? target : target?.platform;
  return getPlatform(key).homeUrl || "";
}

/* Exactly what goes on the clipboard, and exactly what gets recorded as
   published — one function, so those two can never drift apart.

   This is also the single place the organization's call to action is
   added, which is what keeps it out of variant.body and therefore out of
   the re-run loop: a CTA stored in the body would be fed back to the
   model as a previous draft, come back inside the new one, and be
   appended again on top of itself. See js/signature.js.

   The CTA comes from the active organization rather than an argument
   because this is called from a dozen places that have no reason to hold
   the workspace record, and because the boot tests pin this signature.

   Order is body, then CTA, then hashtags — the tags are metadata and
   belong under everything a person reads. */
export function buildCopyText(variant) {
  const tags = (variant.hashtags || [])
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
    .join(" ");
  return [variant.body?.trim(), ctaBlock(getOrganization()), tags].filter(Boolean).join("\n\n");
}
