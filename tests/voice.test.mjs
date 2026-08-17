import test from "node:test";
import assert from "node:assert/strict";
import {
  VOICE_LEXICON, exemplarSection, rhythmOf, scanVoice, voiceRules, voiceSummary
} from "../js/voice.js";
import {
  VOICE_EVEN_MIN_MEAN, VOICE_EXEMPLAR_CHARS, VOICE_EXEMPLAR_COUNT,
  VOICE_EXEMPLAR_MIN_CHARS, VOICE_MIN_VARIATION
} from "../js/config.js";

/* ------------------------------------------------------------
   This file is the specification of "domain-safe". Until now the only
   record of which phrases must NOT be flagged lived in prose comments
   inside voice.js, which is why a pattern that fired on the phrase
   "community impact" could ship unnoticed. The corpus below is that
   record, executable.

   The rule these tests encode: a warning that fires on correct copy is
   worse than a missed tell, because an operator who is warned about
   "laptops, phones, and tablets" stops reading the warnings.
   ------------------------------------------------------------ */

const textOf = (findings) => findings.map((finding) => finding.text).join(" | ");
const countMatching = (findings, re) => findings.filter((finding) => re.test(finding.text)).length;

/* ------------------------------------------------------------
   CLEAN COPY — the false-positive corpus. Every string here is
   something a real person at this organization would plausibly write.
   ------------------------------------------------------------ */

const MUST_STAY_CLEAN = [
  "We accept phones, laptops, and tablets.",
  "Our community impact grew again last year.",
  "We care about community impact and trust.",
  "We'll take your old phone off your hands.",
  "Take your laptop to the drop-off on Saturday.",
  "Bring us anything in the Apple ecosystem, even the cables.",
  "It comes in a robust case, so the screen survived.",
  "We shoot the landscape photo from the shop roof.",
  "Free pickup across the Bay Area. Call or text us.",
  "We support community, schools, and families across the county.",
  "Drives get wiped to NIST 800-88 standards before anything else.",
  "You can unlock your phone first if you want, but you don't have to.",
  /* Real electronics and logistics vocabulary. These guard the inflection
     matching added in 2026-08b, which widened the word sweep and could
     otherwise have started firing on ordinary shop talk. */
  "The cable harness on that monitor is shot, so we cut it off.",
  "Bring the charger, the dock, and the two spare batteries.",
  "We navigate to the back entrance and load the van there.",
  "The router was dead but the drive inside it was fine.",
  "Ray fostered the whole Saturday crew himself last spring.",
  "That landscape of empty desks is why the school called us.",
  "We picked up nine laptops, two printers and a box of cables."
];

test("ordinary copy for this organization produces no warnings at all", () => {
  for (const copy of MUST_STAY_CLEAN) {
    const findings = scanVoice(copy);
    assert.equal(findings.length, 0, `should be clean: ${JSON.stringify(copy)} → ${textOf(findings)}`);
  }
});

test("a good hand-written multi-line post is not called machine-even", () => {
  /* Measured at lengths [6,7,10,6] · mean 7 · variation 0.226 — under the
     0.45 threshold, and flagged as "uniform" before the mean gate went
     in. This is the regression that mattered most: the check was firing
     on exactly the writing the whole file exists to encourage. */
  const post = `Cleaning out a closet this weekend?

We take old laptops, phones, and tablets. Every drive gets wiped before anything else happens to it.

Drop off Saturday, 9 to noon.`;

  const findings = scanVoice(post);
  assert.equal(countMatching(findings, /same length|uniform/i), 0,
    `short punchy copy must not be called even → ${textOf(findings)}`);
});

test("hashtags, links and bullets are structure and never counted as rhythm", () => {
  const withLayout = `We fix up old laptops for students who need one.

#ewaste #recycling #bayarea
https://safecycletech.com/
- free pickup
* no appointment needed`;

  const prose = rhythmOf(withLayout);
  assert.equal(prose.count, 1, "only the one prose sentence should count");

  /* The same prose with layout attached must measure identically. */
  assert.deepEqual(
    rhythmOf("We fix up old laptops for students who need one."),
    prose,
    "layout lines must not shift the statistics"
  );
});

/* ------------------------------------------------------------
   TELLS — the things that must still be caught.
   ------------------------------------------------------------ */

test("machine-smooth prose is still caught", () => {
  /* Five sentences of 12-15 words with almost no variation: lengths
     [14,14,15,12,14] · mean 14 · variation 0.071. */
  const smooth = "We collect old laptops and phones from neighbors around the north side of town. "
    + "Every device gets wiped to department of defense standards before it goes anywhere else. "
    + "The working ones are refurbished and handed to students who need a computer for school. "
    + "Anything genuinely dead is broken down and recycled through a certified processor. "
    + "You can drop yours at the shop on Saturday morning between nine and noon.";

  const findings = scanVoice(smooth);
  assert.ok(countMatching(findings, /same length/i) === 1, `should be flagged even → ${textOf(findings)}`);
});

test("the slop lexicon still fires on the register it was built for", () => {
  assert.match(textOf(scanVoice("We delve into the tapestry of innovative solutions.")), /AI-register/);
  assert.match(textOf(scanVoice("Let us harness the power of your old phone.")), /Stock phrasing/);
  assert.match(textOf(scanVoice("Our robust solution scales across the digital landscape.")), /Stock phrasing/);
  assert.match(textOf(scanVoice("Join us on our journey toward zero waste.")), /Stock phrasing/);
});

test("regular inflections of a banned word are caught, not just the listed form", () => {
  /* The list spells out "empower" and "empowering"; every other form used
     to walk through untouched, all 22 of 22 in a spot check. */
  for (const form of [
    "empowers", "empowered", "leverages", "leveraged", "elevates", "elevated",
    "streamlines", "streamlined", "utilizes", "utilized",
    "enhances", "enhanced", "facilitates", "facilitated", "optimizes", "optimized",
    "delves", "cultivates", "unpacks", "embarks"
  ]) {
    assert.match(
      textOf(scanVoice(`We ${form} the process here.`)),
      /AI-register/,
      `"${form}" should be caught as an inflection of a listed word`
    );
  }
});

test("stacked transitions warn only as a cluster, never singly", () => {
  assert.equal(countMatching(scanVoice("Moreover, we pick up for free."), /Stacked transitions/), 0);
  assert.match(
    textOf(scanVoice("Moreover, we pick up for free. Furthermore, the drives are wiped.")),
    /Stacked transitions/
  );
});

test("the recognizable rhetorical shapes are caught", () => {
  const cases = {
    "not-just": "It's not just a phone, but a student's first computer.",
    "whether-you": "Whether you're a student or a parent, we can help.",
    "em-dash": "We take them all — even the broken ones.",
    "cta-formula": "Ready to clear out that closet?",
    "hype-emoji": "Big news today 🚀",
    "heres-the-thing": "Here's the thing. Old phones pile up."
  };
  for (const [id, copy] of Object.entries(cases)) {
    assert.ok(scanVoice(copy).length > 0, `${id} should be caught in ${JSON.stringify(copy)}`);
  }
});

test("no-contraction formality is flagged only in copy long enough to judge", () => {
  /* Deliberately varied in sentence length (62 words, variation 0.65) so
     this exercises the contraction check alone and cannot pass or fail
     for a rhythm reason. */
  const formal = "We will collect the equipment from your home at a time that suits you, and there is no charge for the visit anywhere in the service area. "
    + "We do not charge. "
    + "The drives will be erased in accordance with federal standards before anything leaves. "
    + "Working laptops are given to students. "
    + "Residents may request a collection by telephone or by electronic mail today.";
  assert.match(textOf(scanVoice(formal)), /No contractions/);
  assert.equal(countMatching(scanVoice("We will collect it."), /No contractions/), 0);
});

/* ------------------------------------------------------------
   ONE PROBLEM, ONE WARNING
   ------------------------------------------------------------ */

test("the abstract tricolon needs three abstractions, not two adjacent nouns", () => {
  assert.match(
    textOf(scanVoice("It comes down to quality, reliability, and impact.")),
    /three-item/i
  );
  assert.match(
    textOf(scanVoice("We stand for trust, transparency and value.")),
    /three-item/i,
    "the Oxford comma is optional"
  );
  /* The two cases the old pattern got wrong. */
  assert.equal(countMatching(scanVoice("Our community impact grew again."), /three-item/i), 0);
  assert.equal(countMatching(scanVoice("We serve community, schools, and families."), /three-item/i), 0);
});

test("a shape covered by a construction is not also reported as stock phrasing", () => {
  for (const copy of [
    "Here's the thing. We take them.",
    "The truth is we just need volunteers.",
    "The reality is that most of it can be reused.",
    "It's not just about recycling, but about access.",
    "This isn't just about recycling."
  ]) {
    const findings = scanVoice(copy);
    assert.ok(findings.length > 0, `still needs catching: ${copy}`);
    assert.equal(countMatching(findings, /Stock phrasing/), 0,
      `construction already owns this shape → ${textOf(findings)}`);
  }
});

test("an opener suppresses the duplicate phrase warning inside it, but not elsewhere", () => {
  const once = scanVoice("In today's world, old phones pile up in drawers.");
  assert.equal(countMatching(once, /Opens by framing the era/), 1);
  assert.equal(countMatching(once, /Stock phrasing/), 0, "the phrase sits inside the opener");

  /* A second, later occurrence is a real separate instance. */
  const twice = scanVoice("In today's world, phones pile up. Nobody knows what to do in today's economy.");
  assert.equal(countMatching(twice, /Stock phrasing/), 1);
});

test("at most one rhythm warning ever fires", () => {
  const samples = [
    "We collect old laptops and phones from neighbors around the north side of town. Every device gets wiped to department of defense standards before it goes anywhere else. The working ones are refurbished and handed to students who need a computer for school. Anything genuinely dead is broken down and recycled through a certified processor.",
    "Bring in the laptop that no longer starts up properly. We will look at whether the drive can be read. Students in the district receive the machines that still work. Everything else is dismantled by a certified local recycler.",
    "Old phones are collected here every single Saturday morning. Drives get erased using federal wiping standards. Working laptops go to students in the district. Broken screens are separated for certified recycling downstream. Nothing at all goes into a landfill."
  ];
  for (const copy of samples) {
    const rhythmWarnings = countMatching(scanVoice(copy), /same length|short sentence|very short/i);
    assert.ok(rhythmWarnings <= 1, `expected ≤1 rhythm warning, got ${rhythmWarnings} → ${textOf(scanVoice(copy))}`);
  }
});

/* ------------------------------------------------------------
   RHYTHM MATHS
   ------------------------------------------------------------ */

test("rhythm statistics are empty rather than NaN for copy with no prose", () => {
  for (const empty of ["", "   ", "#ewaste #recycling", "https://safecycletech.com/"]) {
    const stats = rhythmOf(empty);
    assert.equal(stats.count, 0);
    assert.equal(stats.variation, 0);
    assert.equal(stats.mean, 0);
  }
  assert.deepEqual(scanVoice("   "), [], "an empty draft is platforms.js's error to report, not ours");
});

test("variation is scale-free, so identical shapes at different scales score alike", () => {
  const short = rhythmOf("One two three. One two three. One two three. One two three.");
  assert.ok(short.variation < 0.01, "identical lengths mean no variation");
  assert.equal(short.count, 4);
  assert.equal(short.mean, 3);
});

test("the evenness gate is exactly VOICE_EVEN_MIN_MEAN, and both sides of it behave", () => {
  /* Uniformly short: under the gate, so silence. */
  const punchy = "We take them. It is all free. Just drop by. Ask for Ray.";
  const punchyStats = rhythmOf(punchy);
  assert.ok(punchyStats.mean < VOICE_EVEN_MIN_MEAN);
  assert.ok(punchyStats.variation < VOICE_MIN_VARIATION, "flat, but that is fine when short");
  assert.equal(countMatching(scanVoice(punchy), /same length/i), 0);
});

/* ------------------------------------------------------------
   THE PROMPT
   ------------------------------------------------------------ */

test("voiceRules leads with positive modeling and keeps the ban lists short", () => {
  const rules = voiceRules();
  const doThis = rules.indexOf("Do this:");
  const doNot = rules.indexOf("Do not use these words:");

  assert.ok(doThis > -1 && doNot > -1);
  assert.ok(doThis < doNot, "positive habits must come before the bans");

  /* The whole point of the 2026-08b split: the prompt is short. If this
     starts failing, someone is pasting the scanner's lists back in. */
  assert.ok(rules.length < 3000, `voiceRules is ${rules.length} chars; it is meant to stay lean`);

  for (const habit of ["out loud", "contractions", "Fragments", "Vague and true"]) {
    assert.match(rules, new RegExp(habit), `positive instruction missing: ${habit}`);
  }
});

test("every word the prompt bans is a word the scanner checks", () => {
  /* This is what preserves "one source, two renderings" now that the two
     renderings are different lengths. Without it the prompt could teach
     the model a rule the scanner has stopped enforcing. */
  for (const word of VOICE_LEXICON.promptWords) {
    assert.ok(VOICE_LEXICON.slopWords.includes(word),
      `voiceRules bans "${word}" but SLOP_WORDS does not contain it`);
  }
  for (const phrase of VOICE_LEXICON.promptPhrases) {
    assert.ok(VOICE_LEXICON.slopPhrases.includes(phrase),
      `voiceRules bans "${phrase}" but SLOP_PHRASES does not contain it`);
  }
});

test("the words relocated out of the unconditional list are really gone from it", () => {
  for (const word of ["robust", "landscape", "ecosystem", "journey", "foster"]) {
    assert.ok(!VOICE_LEXICON.slopWords.includes(word),
      `"${word}" is literal vocabulary here and must only be flagged in context`);
  }
  /* Each still has to be caught in the metaphor. */
  assert.match(textOf(scanVoice("We foster a sense of community here.")), /Stock phrasing/);
  assert.match(textOf(scanVoice("Our robust solution is ready.")), /Stock phrasing/);
  assert.ok(!VOICE_LEXICON.slopPhrases.includes("take your"),
    '"take your" fired on "We\'ll take your old phone"');
  for (const owned of ["here's the thing", "the truth is", "the reality is", "not just about"]) {
    assert.ok(!VOICE_LEXICON.slopPhrases.includes(owned),
      `"${owned}" is owned by a construction; listing it here double-reports`);
  }
});

/* ------------------------------------------------------------
   EXEMPLARS
   ------------------------------------------------------------ */

const LONG = "We picked up nine laptops from a house on Fell Street this morning. "
  + "Three of them still run fine. Those go to students in the district. The rest get stripped for parts.";
const OTHER = "Somebody dropped off a box of tangled cables and two old routers on Tuesday. "
  + "All of it can be recycled. None of it should go in the bin at home.";

const variant = (patch = {}) => ({
  platform: "nextdoor", title: "", body: LONG, aiBody: LONG,
  publishedBody: "", status: "draft", publishedAt: "", ...patch
});
const post = (patch = {}, variants = [variant()]) => ({
  source: "ai", updatedAt: "2026-08-01T00:00:00Z", createdAt: "2026-08-01T00:00:00Z",
  variants, ...patch
});

test("an untouched model draft is never used as a voice example", () => {
  /* The feedback loop this guards against: quoting last week's generated
     output back as "how we sound" entrenches the machine register. */
  assert.equal(exemplarSection([post()], "nextdoor"), "");
});

test("hand-written, published and hand-edited copy all qualify", () => {
  const external = post({ source: "external" }, [variant({ status: "published", publishedBody: LONG })]);
  assert.match(exemplarSection([external], "nextdoor"), /Fell Street/);

  const published = post({}, [variant({ status: "published", publishedBody: LONG })]);
  assert.match(exemplarSection([published], "nextdoor"), /Fell Street/);

  const edited = post({}, [variant({ status: "draft", aiBody: "something else entirely", body: LONG })]);
  assert.match(exemplarSection([edited], "nextdoor"), /Fell Street/);
});

test("hand-written copy outranks a merely approved draft", () => {
  const approved = post({}, [variant({ status: "approved", body: OTHER, aiBody: OTHER })]);
  const handwritten = post({ source: "external" }, [variant({ status: "published", publishedBody: LONG })]);

  const section = exemplarSection([approved, handwritten], "nextdoor");
  assert.ok(section.indexOf("Fell Street") < section.indexOf("tangled cables"),
    "provenance outranks the order posts happen to arrive in");
  assert.match(section, /written by hand/);
});

test("the exemplar section is capped, trimmed, and labelled", () => {
  /* The distinguishing text has to sit at the FRONT: near-duplicate
     detection compares opening text, so a unique tail on an identical
     opening is still a duplicate — which is the behaviour wanted, and
     the reason this fixture is built this way. */
  const many = Array.from({ length: VOICE_EXEMPLAR_COUNT + 3 }, (_, index) =>
    post({ source: "external" }, [variant({
      status: "published",
      publishedBody: `Collection number ${index} on a rainy Tuesday. ${LONG}`
    })])
  );
  const section = exemplarSection(many, "nextdoor");

  assert.equal((section.match(/^\d+\. \(/gm) || []).length, VOICE_EXEMPLAR_COUNT);
  assert.match(section, /Nextdoor, written by hand, published/);
  assert.ok(!/Do not reuse their sentences[\s\S]*Do not reuse their sentences/.test(section));

  const longBody = "word ".repeat(400);
  const trimmed = exemplarSection(
    [post({ source: "external" }, [variant({ status: "published", publishedBody: longBody })])],
    "nextdoor"
  );
  assert.ok(trimmed.includes("..."), "over-long examples are trimmed with an ellipsis");
  assert.ok(trimmed.length < VOICE_EXEMPLAR_CHARS + 400);
});

test("the same message published twice does not take two exemplar slots", () => {
  const duplicated = post({ source: "external" }, [
    variant({ platform: "nextdoor", status: "published", publishedBody: LONG }),
    variant({ platform: "facebook", status: "published", publishedBody: LONG })
  ]);
  assert.equal((exemplarSection([duplicated], "nextdoor").match(/^\d+\. \(/gm) || []).length, 1);
});

test("a caption too short to show a house style is not used", () => {
  const tiny = "Free pickup. Call us.";
  assert.ok(tiny.length < VOICE_EXEMPLAR_MIN_CHARS);
  assert.equal(
    exemplarSection([post({ source: "external" }, [variant({ status: "published", publishedBody: tiny })])], "nextdoor"),
    ""
  );
});

test("the requested platform is preferred when provenance is otherwise equal", () => {
  const nextdoor = post({ source: "external" }, [variant({ platform: "nextdoor", status: "published", publishedBody: LONG })]);
  const reddit = post({ source: "external" }, [variant({ platform: "reddit", status: "published", publishedBody: OTHER })]);

  const forReddit = exemplarSection([nextdoor, reddit], "reddit");
  assert.ok(forReddit.indexOf("tangled cables") < forReddit.indexOf("Fell Street"));
});

test("a Reddit title is carried into the example so title voice is modelled too", () => {
  const withTitle = post({ source: "external" }, [variant({
    platform: "reddit", title: "Picked up nine laptops on Fell Street today", status: "published", publishedBody: LONG
  })]);
  assert.match(exemplarSection([withTitle], "reddit"), /Title: Picked up nine laptops/);
});

test("exemplarSection survives junk input rather than throwing", () => {
  for (const junk of [undefined, null, [], [null], [{}], [{ variants: null }], [{ variants: [null] }]]) {
    assert.equal(exemplarSection(junk, "reddit"), "");
  }
});

/* ------------------------------------------------------------
   SUMMARY LINE
   ------------------------------------------------------------ */

test("voiceSummary agrees with the scan it summarises", () => {
  assert.equal(voiceSummary(""), "");
  assert.match(voiceSummary("We delve into the tapestry."), /voice note/);
  assert.match(voiceSummary("We take them. It is free. Drop by. Ask for Ray."), /reads clean/);

  /* "even" in the summary must mean the same thing as the warning. */
  const smooth = "We collect old laptops and phones from neighbors around the north side of town. "
    + "Every device gets wiped to department of defense standards before it goes anywhere else. "
    + "The working ones are refurbished and handed to students who need a computer for school. "
    + "Anything genuinely dead is broken down and recycled through a certified processor.";
  assert.match(voiceSummary(smooth), /rhythm even/);
  assert.match(voiceSummary("We take them. It is free. Drop by. Ask for Ray."), /rhythm varied/);
});
