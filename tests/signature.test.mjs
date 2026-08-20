import test from "node:test";
import assert from "node:assert/strict";
import {
  ctaBlock, ctaCoverage, ctaRules, defaultCtaText, duplicateFindings, signatureRoutes, siteHost, stripSignOff
} from "../js/signature.js";
import { buildCopyText, variantChecks } from "../js/platforms.js";
import {
  createDefaultData, defaultPlatforms, getPlatform, migrateData, setActivePlatforms, setOrganization
} from "../js/data.js";
import { PROMPT_VERSION, generateDrafts } from "../js/providers.js";

/* ============================================================
   THE CALL TO ACTION

   Two requirements, and the second is the hard one:

     1. Every post ends with this exact block.
     2. Nothing in it is ever printed twice — not the phone number, not
        the email, not the website, not the block itself — even when the
        model writes its own sign-off despite being told not to.

   The design that makes (2) achievable is that the CTA never enters
   variant.body. It is appended by buildCopyText() at the moment the post
   is copied or published. Most of what follows is checking that the body
   really does stay clean, on the paths where it would be easiest for a
   copy to sneak in: generation, and a re-run that feeds drafts back.
   ============================================================ */

const EXACT_CTA =
  "Check out https://safecycletech.com to learn more about our organization and how we’re helping the community." +
  "\n\n" +
  "Call or text (415) 612-8520 or email pickup@safecycletech.com to schedule a pickup.";

const org = {
  name: "Safe Cycle Tech",
  phone: "(415) 612-8520",
  email: "pickup@safecycletech.com",
  website: "https://safecycletech.com/",
  cta: EXACT_CTA
};

/* ------------------------------------------------------------
   THE EXACT WORDING
   ------------------------------------------------------------ */

test("a fresh workspace ships the CTA exactly as specified", () => {
  const fresh = createDefaultData();
  assert.equal(fresh.organization.cta, EXACT_CTA);
  assert.equal(defaultCtaText(fresh.organization), EXACT_CTA);

  /* The trailing slash on the stored website must not reach the copy. */
  assert.ok(!fresh.organization.cta.includes("safecycletech.com/ "));
  assert.match(fresh.organization.cta, /https:\/\/safecycletech\.com to learn/);
});

test("a workspace written before this change adopts the new block and drops the old field", () => {
  const old = migrateData({
    organization: {
      name: "Safe Cycle Tech", mission: "m",
      defaultCta: "Call or text (415) 612-8520 to schedule a free pickup."
    }
  });
  assert.equal(old.organization.cta, EXACT_CTA);
  assert.ok(!("defaultCta" in old.organization), "the superseded field must not linger in the workspace");

  /* A CTA the operator has deliberately worded is never overwritten. */
  const mine = migrateData({ organization: { ...org, cta: "Just call us." } });
  assert.equal(mine.organization.cta, "Just call us.");

  /* ...but a cleared one falls back rather than publishing posts with
     no way to reach anyone. */
  assert.equal(migrateData({ organization: { ...org, cta: "   " } }).organization.cta, EXACT_CTA);
});

test("the CTA is flagged when it drifts from the contact fields", () => {
  assert.deepEqual(ctaCoverage(org), []);

  const drifted = ctaCoverage({ ...org, phone: "(415) 999-0000" });
  assert.deepEqual(drifted.map((route) => route.key), ["phone"]);

  assert.deepEqual(ctaCoverage({ ...org, cta: "" }), [], "no CTA, nothing to cover");
});

/* ------------------------------------------------------------
   IT IS APPENDED EXACTLY ONCE
   ------------------------------------------------------------ */

test("buildCopyText appends the CTA once, under the body and above the hashtags", () => {
  setActivePlatforms(defaultPlatforms());
  setOrganization(org);

  const text = buildCopyText({ platform: "facebook", body: "We collect old laptops.", hashtags: ["ewaste"], notes: "" });
  assert.equal(text, `We collect old laptops.\n\n${EXACT_CTA}\n\n#ewaste`);

  /* Once, not twice — the count that the whole design exists to protect. */
  assert.equal(text.split("(415) 612-8520").length - 1, 1);
  assert.equal(text.split("pickup@safecycletech.com").length - 1, 1);
  assert.equal(text.split("safecycletech.com to learn more").length - 1, 1);

  setOrganization({});
  assert.equal(
    buildCopyText({ platform: "facebook", body: "We collect old laptops.", hashtags: [], notes: "" }),
    "We collect old laptops.",
    "no organization adopted, nothing appended"
  );
});

test("the CTA counts against the platform's character limit", () => {
  setActivePlatforms(defaultPlatforms());
  setOrganization(org);

  const max = getPlatform("instagram").bodyMax;
  /* A body that fits on its own but not once the CTA is under it. */
  const body = "x".repeat(max - 20);
  const checks = variantChecks({ platform: "instagram", title: "", body, hashtags: [], notes: "" }, org);
  assert.ok(checks.some((check) => check.level === "error" && /over/.test(check.text)),
    "measuring variant.body alone would have cleared a post that is actually too long");

  setOrganization({});
});

/* ------------------------------------------------------------
   DEFENCE 1 — the model's own sign-off comes off
   ------------------------------------------------------------ */

test("a trailing sign-off paragraph is removed from a generated draft", () => {
  const body = [
    "We pick up old electronics anywhere in the Bay Area.",
    "Working machines go to local students; the rest is recycled properly.",
    "Call (415) 612-8520 or email pickup@safecycletech.com. More at safecycletech.com."
  ].join("\n\n");

  const cleaned = stripSignOff(body, org);
  assert.equal(cleaned, [
    "We pick up old electronics anywhere in the Bay Area.",
    "Working machines go to local students; the rest is recycled properly."
  ].join("\n\n"));
  assert.deepEqual(duplicateFindings(cleaned, org), []);
});

test("a sign-off on trailing lines rather than its own paragraph is also removed", () => {
  const body = "We refurbish what we can.\nCall (415) 612-8520\npickup@safecycletech.com\nsafecycletech.com";
  assert.equal(stripSignOff(body, org), "We refurbish what we can.");
});

test("contact details mid-copy are left alone for a person to judge", () => {
  const body = "Call (415) 612-8520 before you haul anything to the dump.\n\nWe take almost everything with a plug on it.";
  assert.equal(stripSignOff(body, org), body, "a regex must not edit someone's prose around a phone number");

  const findings = duplicateFindings(body, org);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "warn", "never blocks publishing");
  assert.match(findings[0].text, /twice/);
  assert.match(findings[0].text, /phone number/);
});

test("stripping never empties a draft, however much of it is contact details", () => {
  const allContact = "Call (415) 612-8520.\n\nEmail pickup@safecycletech.com.";
  const kept = stripSignOff(allContact, org);
  assert.ok(kept.trim().length > 0, "deleting the whole post is worse than a duplicate");
  assert.ok(duplicateFindings(kept, org).length, "and what survives has to be reported");

  assert.equal(stripSignOff("", org), "");
  assert.equal(stripSignOff("Nothing to strip here.", org), "Nothing to strip here.");
  assert.equal(stripSignOff("Call (415) 612-8520.", {}), "Call (415) 612-8520.", "no routes, no stripping");
});

/* ------------------------------------------------------------
   DEFENCE 2 — what is reported
   ------------------------------------------------------------ */

test("only details the CTA actually carries are reported as duplicates", () => {
  /* A CTA with no email in it cannot duplicate an email in the body. */
  const phoneOnly = { ...org, cta: "Call (415) 612-8520." };
  const body = "Email pickup@safecycletech.com to book.";
  assert.deepEqual(duplicateFindings(body, phoneOnly), []);
  assert.ok(duplicateFindings("Call 415-612-8520 to book.", phoneOnly).length);

  assert.deepEqual(duplicateFindings("Call (415) 612-8520.", { ...org, cta: "" }), [],
    "with nothing appended there is nothing to duplicate");
  assert.deepEqual(duplicateFindings("", org), []);
});

test("the phone number is matched on its digits, not its punctuation", () => {
  for (const shape of ["(415) 612-8520", "415-612-8520", "415.612.8520", "4156128520", "+1 (415) 612-8520"]) {
    assert.ok(duplicateFindings(`Reach us on ${shape}.`, org).length, `should have matched: ${shape}`);
  }
  assert.deepEqual(duplicateFindings("Reach us on 415-612-8521.", org), [], "a different number is a different number");
});

test("routes are only built from contact details that are actually recorded", () => {
  assert.deepEqual(signatureRoutes(org).map((route) => route.key), ["phone", "email", "website"]);
  assert.deepEqual(signatureRoutes({}), []);
  assert.deepEqual(signatureRoutes({ phone: "call us", email: "nope", website: "nope" }), []);
  assert.equal(siteHost("http://www.safecycletech.com/donate?x=1"), "safecycletech.com");
  assert.equal(ctaBlock({}), "");
});

/* ------------------------------------------------------------
   THE PROMPT KEEPS THE MODEL OFF IT
   ------------------------------------------------------------ */

test("the model is told to leave the CTA and the contact details out", () => {
  const rules = ctaRules(org);
  assert.match(rules, /leave them out/i);
  assert.ok(rules.includes("(415) 612-8520"), "it has to know which number not to write");
  assert.ok(rules.includes("pickup@safecycletech.com"));
  assert.match(rules, /do not write a sign-off/i);
  assert.match(rules, /no "see below"/i, "referring to the appended block is its own kind of broken");
  assert.equal(ctaRules({ ...org, cta: "" }), "", "nothing appended, nothing to warn the model about");
});

/* ------------------------------------------------------------
   END TO END
   ------------------------------------------------------------ */

test("a model that writes its own sign-off anyway does not produce a doubled post", async () => {
  setActivePlatforms(defaultPlatforms());
  setOrganization(org);

  /* Exactly the failure this is built to survive: the model ignores the
     instruction and appends contact details of its own. */
  const disobedient = {
    campaignName: "c", campaignAngle: "a", audience: "aud", objective: "o",
    canonical: "We pick up old electronics.\n\nCall (415) 612-8520 to book.",
    warnings: [],
    variants: [{
      platform: "facebook", title: "",
      body: "We pick up old electronics across the Bay Area.\n\nCall or text (415) 612-8520 or email pickup@safecycletech.com. See safecycletech.com.",
      hashtags: ["ewaste"], notes: ""
    }]
  };

  globalThis.fetch = async () => new Response(
    JSON.stringify({ id: "m", model: "m", content: [{ type: "text", text: JSON.stringify(disobedient) }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

  const { generation } = await generateDrafts({
    credentials: { provider: "anthropic", keys: { anthropic: "k" }, models: { anthropic: "claude-opus-5" } },
    brief: { topic: "free pickup", platforms: ["facebook"] },
    organization: { ...org, mission: "m", facts: [], prohibitedClaims: [] }
  });

  const variant = generation.variants[0];
  assert.equal(variant.body, "We pick up old electronics across the Bay Area.",
    "the model's sign-off must be gone before the draft is ever stored");
  assert.equal(generation.canonical, "We pick up old electronics.");

  /* And the finished post carries each detail exactly once. */
  const posted = buildCopyText(variant);
  for (const detail of ["(415) 612-8520", "pickup@safecycletech.com"]) {
    assert.equal(posted.split(detail).length - 1, 1, `${detail} appears more than once in the finished post`);
  }
  assert.ok(posted.endsWith("#ewaste"));
  assert.ok(posted.includes(EXACT_CTA), "and the exact block is the thing that closes it");

  setOrganization({});
});

test("the instructions and the receipt both move with this change", async () => {
  const calls = [];
  const good = {
    campaignName: "c", campaignAngle: "a", audience: "aud", objective: "o",
    canonical: "text", warnings: [],
    variants: [{ platform: "facebook", title: "", body: "b", hashtags: [], notes: "" }]
  };
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: "m", model: "m", content: [{ type: "text", text: JSON.stringify(good) }] }),
      { status: 200, headers: { "content-type": "application/json" } });
  };

  const { receipt } = await generateDrafts({
    credentials: { provider: "anthropic", keys: { anthropic: "k" }, models: { anthropic: "claude-opus-5" } },
    brief: { topic: "free pickup", platforms: ["facebook"] },
    organization: { ...org, mission: "m", facts: [], prohibitedClaims: [] }
  });

  assert.match(calls[0].system, /leave them out/i);
  assert.ok(calls[0].system.includes(EXACT_CTA), "the model must see the exact block it has to stay off");

  /* The brief no longer asks for a call to action at all; one is
     appended regardless, and asking for a second is how posts double. */
  assert.ok(!("callToAction" in JSON.parse(calls[0].messages[0].content)?.brief),
    "the brief must not still carry a callToAction field");

  assert.equal(receipt.promptVersion, PROMPT_VERSION);
  assert.equal(PROMPT_VERSION, "sct-social-7");
});
