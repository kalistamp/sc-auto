/* ============================================================
   SAFE CYCLE STUDIO — voice

   Everything in this file exists to answer one question: does this
   draft read like a person at this organization wrote it, or like a
   language model produced it?

   That question matters commercially, not just aesthetically. Reddit
   and Nextdoor communities punish copy that reads as machine-written —
   downvotes, removals, and a reputation the organization then has to
   repair. The failure is not "a detector flagged it"; the failure is
   "a neighbor read it and rolled their eyes".

   ONE SOURCE, TWO RENDERINGS
   --------------------------
   The tells below are stored as data, then rendered two ways:

     · voiceRules()  turns them into instructions for the model, at
       generation time, where the leverage is highest.
     · scanVoice()   turns them into a checker for what actually came
       back, and for whatever the operator types afterwards.

   Keeping both on one list is the point. The usual failure of a
   house-style system is telling the model one thing and checking for
   another; here that cannot happen, because the prompt text and the
   regexes are built from the same arrays.

   WHY EVERY FINDING IS A WARNING
   ------------------------------
   None of these block approval. Style is a judgment call and the
   operator knows things this file does not — a phrase on the list may
   be exactly right once. `error` stays reserved for the checks in
   platforms.js that describe real breakage: an empty draft, a missing
   Reddit title, copy over the platform's hard ceiling.

   THE SPECIFICITY TRAP
   --------------------
   The standard advice for making text sound human is "add concrete
   detail". Applied to this organization that advice is dangerous: the
   fastest way to sound specific is to invent a number, a partner, or a
   family, and the standing rules forbid exactly that. So the rule here
   is narrower and is stated in the prompt as well: specificity is
   drawn from the brief and the approved facts, and where neither
   supplies one, the draft stays plainly general. Vague and true beats
   vivid and invented.

   ============================================================
   UPGRADE NOTES (2026-08)
   ============================================================
   Goal: move generated posts further from "polished LLM marketing"
   toward the imperfect, direct, slightly uneven prose a real person
   types when they are busy and actually care about the neighbor reading.

   What was already working and was preserved:
   - Single source of truth for bans → both prompt and scanner.
   - Context-bound patterns for domain words (harness, unlock).
   - Rule-of-three left as prompt-only (listing real devices is normal
     copy for this org; automated detection produced constant noise).
   - All findings remain warnings; never block approval.
   - Exemplar ranking that prefers human-edited published posts.
   - Rhythm measured as coefficient of variation (stdev/mean).

   What the previous rules/prompt were still doing poorly:
   1. Heavy negative lists without enough positive "write like this"
      modeling. Models obey bans but then fall back to other polished
      habits (perfect parallel structure, tidy wrap-ups, "here's the
      thing", soft CTA formulas, evenly paced paragraphs).
   2. Lexicon coverage lagged common 2025–2026 tells: leverage,
      streamline, robust, foster, landscape (metaphorical), journey,
      unpack, curated, thoughtfully, "it's not just about", etc.
   3. voiceRules() still read a bit like a style guide. Current models
      respond more reliably to short, concrete, almost conversational
      instructions that describe the *feeling* of human typing than to
      long rulebooks.
   4. Missing checks for a few high-signal shapes that survived the
      earlier list: "Here's the thing", stacked formal connectors, and
      the "Looking for a way to…" opener family.

   What this upgrade does:
   - Expands the lexicon with documented new entries and keeps domain
     safety (false positives on real electronics language are worse
     than a missed tell).
   - Rewrites voiceRules() around positive human habits first
     (imperfect rhythm, direct address, fragments, ending on the ask,
     small true details only), then the bans.
   - Adds a handful of new constructions and openers that were
     slipping through.
   - Adds a light "smoothness" heuristic: too many medium-long
     sentences with no short punch still reads machine-smooth even
     when variation numbers look acceptable.
   - Documents every significant change inline so future edits know
     the tradeoffs.

   Tradeoffs / limitations accepted:
   - More patterns = slightly higher chance of a false positive on an
     unusual but legitimate phrase. Mitigated by keeping everything
     warn-only and by domain-aware phrasing.
   - Positive instructions can still be ignored by a model that is
     over-optimized for "helpful assistant" tone. Exemplars remain the
     strongest counter-signal; rules only prevent drift.
   - Rhythm and "smoothness" heuristics are statistical, not semantic.
     A deliberately even short Instagram caption can still trip them;
     that is why VOICE_MIN_SENTENCES exists.

   ============================================================
   UPGRADE NOTES (2026-08b) — read this before the notes above
   ============================================================
   The 2026-08 pass above never ran. The file was truncated mid-comment
   at the PROMPT RENDERING banner, which left an unterminated block
   comment: a SyntaxError, so voice.js failed to parse, so platforms.js
   and providers.js failed to import, so app.js never booted. The
   application was a blank page and two test files could not load.
   voiceRules() and exemplarSection() described in those notes did not
   exist in the file at all. Both are now written.

   Because nothing was ever generated under it, PROMPT_VERSION stays at
   sct-social-5: no receipt anywhere claims that string, so it is free to
   describe the prompt that actually works. Receipts reading sct-social-4
   still describe the last prompt that really shipped.

   Beyond restoring the tail, this pass reverses one of the decisions
   above and fixes measurement bugs that were firing on good writing:

   1. THE BAN LISTS SHRANK IN THE PROMPT, not in the scanner. Growing the
      prompt to ~130 forbidden strings was the wrong trade — see the
      PROMPT_WORDS comment. The prompt now carries the worst ~15 of each
      plus positive modeling; the scanner keeps everything.

   2. FIVE WORDS MOVED to context-bound patterns: robust, landscape,
      ecosystem, journey, foster. All five have literal meanings in an
      electronics charity's copy and were flagging correct sentences.

   3. RHYTHM WAS MIS-CALIBRATED for short social copy and was flagging
      good hand-written posts as machine-even. Layout lines are no longer
      counted as prose, and evenness is only a tell above a mean sentence
      length. See the RHYTHM section.

   4. ONE PROBLEM NOW PRODUCES ONE WARNING. Overlaps between the phrase
      list, the constructions and the openers were double-reporting, and
      the three rhythm checks could all fire at once.

   5. THE WORD SWEEP MATCHES INFLECTIONS. "empower" was banned while
      "empowers" and "empowered" passed freely — 22 of 22 in a spot check.

   6. TESTS EXIST NOW: tests/voice.test.mjs. The corpus of copy that must
      NOT be flagged is the valuable half; it was previously recorded only
      in prose here, which is how a pattern that fired on the phrase
      "community impact" shipped unnoticed. voice.js is also in
      `npm run check`, which had omitted it — the reason a syntax error
      could ship at all.
   ============================================================ */

import {
  VOICE_EXEMPLAR_COUNT, VOICE_EXEMPLAR_CHARS, VOICE_EXEMPLAR_MIN_CHARS,
  VOICE_EVEN_MIN_MEAN, VOICE_MIN_SENTENCES, VOICE_MIN_VARIATION
} from "./config.js";
/* Only for the platform labels on exemplars. data.js imports nothing
   from here, so this does not create a cycle: platforms.js → voice.js →
   data.js → config.js. */
import { getPlatform } from "./data.js";

/* ------------------------------------------------------------
   THE LEXICON

   Split by how confidently each entry can be flagged, because a false
   positive on this organization's real vocabulary is worse than a
   missed tell. An operator who is warned about "laptops, phones, and
   tablets" stops reading the warnings.
   ------------------------------------------------------------ */

/* Words that essentially never belong in a neighborhood post about
   collecting old electronics. No legitimate reading to protect.

   CHANGE (2026-08): expanded from the original ~28 entries.
   Previous list caught classic "delve / tapestry / paradigm" tells but
   missed a large set of softer corporate-LLM words that still read as
   generated on Nextdoor and Reddit: leverage, streamline, foster,
   cultivate, unpack, curated, thoughtfully, intentionally, etc.
   Why: models stopped using the most obvious slop and shifted to this
   milder register.

   CHANGE (2026-08b): removed "robust", "landscape", "ecosystem",
   "journey" and "foster" from this unconditional list and moved them
   into the context-bound phrases below. Reason: this file's own rule is
   that a word with a real meaning in this domain gets flagged only in the
   metaphorical construction that makes it a tell — "harness" is a cable
   harness here, and by exactly the same logic "the Apple ecosystem", "a
   robust case" and "landscape photo" are ordinary, literal copy for an
   electronics charity. "foster" is the sharpest of the five: an
   organization whose stated mission serves underprivileged families will
   write "foster families" and "foster youth" in earnest, and flagging
   that is worse than missing a metaphor. All five were filed in the wrong
   bucket and would have fired on correct writing. Also dropped
   "deepdive", which is not a token anyone actually types. */
const SLOP_WORDS = [
  /* original core */
  "delve", "tapestry", "realm", "paradigm", "synergy", "holistic",
  "multifaceted", "pivotal", "catalyze", "underscore", "underscores",
  "embark", "intricate", "nuanced", "myriad", "plethora", "bespoke",
  "seamless", "seamlessly", "transformative", "innovative", "cutting-edge",
  "game-changer", "game-changing", "empower", "empowering", "unparalleled",
  "elevate", "elevating", "revolutionize", "revolutionizing",
  /* 2026-08 additions — softer but still machine-flavored */
  "leverage", "leveraging", "streamline", "streamlining", "optimize", "optimizing",
  "cultivate", "cultivating",
  "unpack", "unpacking", "curated", "thoughtfully", "intentionally",
  "impactful", "actionable", "scalable",
  "deep-dive", "utilize", "utilizing",
  "facilitate", "facilitating", "enhance", "enhancing",
  "comprehensive", "groundbreaking", "state-of-the-art",
  "world-class", "best-in-class", "next-level"
];

/* Words with a real meaning in this domain, so they are only flagged
   in the metaphorical construction that makes them a tell. "Harness"
   is a cable harness here; "unlock" is something you do to a phone.

   CHANGE (2026-08): added several high-frequency LLM bridges that
   were still appearing in drafts ("looking for a way to", "if you're
   looking to", etc.). Previous list stopped many classic phrases but
   left these softer templates intact. Kept the context-bound approach
   so "unlock your phone" never fires.

   CHANGE (2026-08b) — three corrections, all made because a warning
   that fires on correct copy trains the operator to ignore warnings:

   1. Removed the entries that the CONSTRUCTIONS below already cover, so
      one problem produces one warning instead of two. Gone from here:
      "here's the thing", "here is the thing", "the reality is",
      "the truth is" (all now owned by the heres-the-thing shape) and
      "it's not just about" / "it is not just about" / "not just about"
      (now owned by a widened not-just shape, which was extended to
      catch the "not just about X" form that has no trailing "but").
      No coverage was lost; only the double-reporting.

   2. Removed bare "take your". It was meant as "take your X to the next
      level", but as written it fired on the single most ordinary
      sentence this organization writes — "We'll take your old phone."
      "to the next level" is listed separately and catches the real tell.

   3. Added the context-bound forms of the four words relocated out of
      SLOP_WORDS, so the metaphor is still caught while the literal
      electronics usage stays clean. */
const SLOP_PHRASES = [
  /* original */
  "harness the", "harness your", "unlock the potential", "unlock new",
  "navigate the", "navigating the", "a testament to", "in the realm of",
  "at its core", "when it comes to", "it is important to note",
  "it's important to note", "it is worth noting", "plays a crucial role",
  "plays a vital role", "plays a key role", "a wide range of",
  "a wide variety of", "in today's", "in this day and age",
  "now more than ever", "look no further", "let's dive", "dive into",
  "that's where", "imagine a world", "picture this",
  "more than just", "at the end of the day", "the bottom line is",
  "we've got you covered", "rest assured", "one thing is clear",
  /* 2026-08 additions */
  "looking for a way to", "if you're looking to", "if you are looking to",
  "whether you're looking", "whether you are looking",
  "in a world where", "in an age where", "as we navigate",
  "to the next level", "makes all the difference",
  "what sets us apart", "what makes us different",
  "we're passionate about", "we are passionate about",
  "dedicated to providing", "committed to delivering",
  "our mission is to", "at the heart of",
  "simply put", "put simply", "needless to say",
  "it goes without saying", "the fact of the matter is",
  /* 2026-08b — metaphorical uses of words that are literal here */
  "robust solution", "robust platform", "robust process", "robust system",
  "the landscape of", "changing landscape", "evolving landscape",
  "digital landscape", "current landscape",
  "digital ecosystem", "broader ecosystem", "entire ecosystem",
  "ecosystem of", "our journey", "your journey", "the journey of",
  "journey toward", "journey towards", "recycling journey",
  "foster a sense", "foster a culture", "foster community",
  "foster growth", "foster innovation", "foster connection",
  "fostering a sense", "fostering community", "fostering innovation",
  "fostering connection", "fostering growth"
];

/* Fine once. A cluster is the tell, which is why these are counted
   rather than flagged individually.

   CHANGE (2026-08): added a few more formal connectors that models
   still reach for when trying to sound "structured". Threshold remains
   ≥2 before warning. */
const TRANSITIONS = [
  "moreover", "furthermore", "additionally", "ultimately",
  "in conclusion", "that being said", "with that said", "in essence",
  "consequently", "accordingly", "hence", "thus",
  "in summary", "to summarize", "all in all"
];

/* The abstraction vocabulary used by the tricolon shape below. Kept as
   its own constant so the same nouns fill all three slots of the
   pattern and cannot drift apart. */
const ABSTRACT_NOUNS = [
  "quality", "reliability", "sustainability", "innovation", "community",
  "impact", "convenience", "trust", "value", "integrity", "transparency",
  "excellence", "responsibility", "accessibility", "affordability",
  "peace of mind", "peace-of-mind"
].join("|");

/* Rhetorical shapes rather than vocabulary. Each is a construction the
   model reaches for by default and a person almost never does.

   CHANGE (2026-08):
   - Tightened the "not just / but" pattern slightly.
   - Added "here's the thing / the reality is" as a construction.
   - Left the original rule-of-three decision intact: real device lists
     are never auto-flagged.

   CHANGE (2026-08b):
   - not-just now also owns the "not just about X" form, which used to
     live in SLOP_PHRASES and double-reported against this shape. The
     phrase list only matched the literal words; this pattern also
     catches the contracted subjects a person writes ("isn't just
     about", "aren't only about"), so widening it gained coverage as
     well as removing a duplicate warning.
   - abstract-tricolon was rewritten. The previous pattern claimed to
     find three-item lists but required only two adjacent nouns with an
     OPTIONAL comma, so it fired on the bare phrase "community impact" —
     ordinary charity vocabulary, flagged on every post that used it.
     It now requires a real three-item list whose items are ALL
     abstractions, which is the actual tell. Mixed and concrete lists
     ("community, schools, and families", "phones, laptops, and
     tablets") stay clean. */
const CONSTRUCTIONS = [
  {
    id: "not-just",
    /* Two shapes, one tell:
         "not just a phone, but a student's first computer"
         "this isn't just about recycling"                    */
    pattern: /\b(?:not|isn'?t|aren'?t|wasn'?t|weren'?t)\s+(?:just|only|merely)\b[^.!?]{0,80}?\b(?:but|it'?s)\b|\b(?:not|isn'?t|aren'?t)\s+(?:just|only|merely)\s+about\b/gi,
    text: 'The "not just X, but Y" construction is one of the most recognizable AI shapes.',
    advice: "Say the second half on its own."
  },
  {
    id: "whether-you",
    pattern: /\bwhether\s+you(?:'re|\s+are)\b[^.!?]{0,60}?\bor\b/gi,
    text: '"Whether you\'re X or Y" is a template opener, not a sentence.',
    advice: "Pick the one reader you are actually talking to."
  },
  {
    id: "em-dash",
    pattern: /—|--/g,
    text: "Em dashes read as machine punctuation and the standing style rules exclude them.",
    advice: "A period, a comma, or parentheses."
  },
  {
    id: "cta-formula",
    pattern: /\b(ready to|want to|looking to)\s+[^.!?]{0,50}\?\s*$/gim,
    text: 'A "Ready to …?" / "Looking to …?" sign-off is the stock AI call to action.',
    advice: "Ask for the thing directly: call, text, drop it off."
  },
  {
    id: "hype-emoji",
    pattern: /[\u{1F680}\u{1F525}\u{2728}\u{1F4A1}\u{1F389}\u{1F4AF}]/gu,
    text: "Rocket, fire, sparkle, and 100 emoji are the visual signature of generated marketing copy.",
    advice: "Cut them, or use one plain emoji a person would actually type."
  },
  {
    id: "heres-the-thing",
    pattern: /\b(here'?s the thing|here is the thing|the reality is|the truth is)\b/gi,
    text: '"Here\'s the thing" / "The reality is" is a common LLM bridge into a point.',
    advice: "Just state the point. No wind-up."
  },
  {
    id: "abstract-tricolon",
    /* All three items must be abstractions AND the list must actually
       have three items joined by "and". Anything less is not the tell:
       "community impact" is a normal phrase, and a three-item list of
       real objects is normal copy for this organization. */
    pattern: new RegExp(
      String.raw`\b(?:${ABSTRACT_NOUNS})\s*,\s*(?:${ABSTRACT_NOUNS})\s*,?\s+and\s+(?:${ABSTRACT_NOUNS})\b`,
      "gi"
    ),
    text: "Abstract three-item lists (quality, reliability, and impact) are a classic generated rhythm.",
    advice: "Name the concrete thing instead, or drop the list."
  }
];

/* Formulaic openers. A person starts with the thing that happened; a
   model starts by framing why the topic matters.

   CHANGE (2026-08): added several more high-frequency generated openers
   that were still slipping past ("Looking for a way to…", "If you're
   like many…", "As someone who…", "In our experience…"). */
const OPENERS = [
  { pattern: /^\s*(in today's|in an age|in a world|these days|nowadays)\b/i, text: "Opens by framing the era rather than the news." },
  { pattern: /^\s*(are you|do you|have you|did you know|ever wondered|what if)\b/i, text: "Opens with a rhetorical question, the stock generated hook." },
  { pattern: /^\s*(attention|calling all|listen up|hey there)\b/i, text: "Opens with an advertising hail." },
  { pattern: /^\s*(we're excited to|we are excited to|we're thrilled|we are thrilled|we're proud to|we are proud to)\b/i, text: "Opens with excitement about the announcement instead of the announcement." },
  { pattern: /^\s*(looking for a way to|if you're looking|if you are looking|if you're like|if you are like)\b/i, text: "Opens with a template 'looking for / if you're like' hook." },
  { pattern: /^\s*(as someone who|as a [a-z]+ who|in our experience|from our experience)\b/i, text: "Opens with a manufactured authority frame." },
  { pattern: /^\s*(it's no secret|it is no secret|let's face it|lets face it)\b/i, text: "Opens with a throat-clearing cliché." }
];

/* ------------------------------------------------------------
   WHAT THE PROMPT GETS, AS OPPOSED TO WHAT THE SCANNER GETS

   CHANGE (2026-08b). The scanner and the prompt now read the same
   lexicon at different depths, and this is a deliberate reversal of the
   previous direction of travel.

   The 2026-08 upgrade grew the ban lists to ~130 entries and rendered
   the whole thing into the system prompt. That is the wrong trade. A
   long proscription list buys obedience on the listed words and pays for
   it in blandness: a model spending its attention avoiding 130 forbidden
   strings writes hedged, short-clause, evasive prose, which is *more*
   recognizably machine-made, not less. You cannot ban your way to a
   voice — the only things that positively shape voice are the exemplars
   and a short description of how a person actually types.

   So the split is:
     · the prompt gets the ~15 worst offenders per list, plus positive
       modeling (see voiceRules)
     · the scanner keeps all of them, because catching a rare tell after
       the fact costs the operator nothing

   These subsets are literal members of the arrays above, and
   tests/voice.test.mjs asserts that they are. That assertion is what
   preserves this file's founding promise — one source, two renderings —
   now that the two renderings are no longer the same length. If someone
   edits a word out of SLOP_WORDS, the test fails rather than the prompt
   quietly teaching the model a rule the scanner no longer checks.
   ------------------------------------------------------------ */

const PROMPT_WORDS = [
  "delve", "tapestry", "realm", "seamless", "seamlessly", "transformative",
  "innovative", "cutting-edge", "empower", "elevate", "leverage",
  "streamline", "impactful", "curated", "comprehensive"
];

const PROMPT_PHRASES = [
  "when it comes to", "in today's", "now more than ever", "look no further",
  "dive into", "at the end of the day", "we've got you covered",
  "more than just", "to the next level", "what sets us apart",
  "we're passionate about", "our mission is to", "it's important to note",
  "a wide range of"
];

/* Exposed for the test that enforces the subset relationship described
   above. Not used by the app at runtime. */
export const VOICE_LEXICON = Object.freeze({
  slopWords: Object.freeze([...SLOP_WORDS]),
  slopPhrases: Object.freeze([...SLOP_PHRASES]),
  transitions: Object.freeze([...TRANSITIONS]),
  promptWords: Object.freeze([...PROMPT_WORDS]),
  promptPhrases: Object.freeze([...PROMPT_PHRASES]),
  constructionIds: Object.freeze(CONSTRUCTIONS.map((shape) => shape.id))
});

/* Built once. The lexicon is fixed at module load, and scanVoice runs
   on every keystroke in the editor, so nothing here is rebuilt per call. */
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternation = (list) => list.map(escapeRe).join("|");

/* CHANGE (2026-08b): the word sweep now also matches regular inflections.

   The list enumerates specific forms — "empower", "empowering" — and the
   \b at the end meant every other form walked straight through: all of
   "empowers", "empowered", "leverages", "streamlined", "utilizes",
   "enhanced", "fosters", "optimized" and their siblings were invisible,
   which is 22 of 22 in a spot check. The ban list was therefore much
   weaker than its length suggested, and weaker than voiceRules() implies
   when it tells the model these words are off limits.

   Matching the suffix instead of listing thirty more entries keeps the
   array readable and cannot fall out of date. Only -s/-es/-d/-ed are
   allowed here: the -ing forms are already spelled out in the list,
   because dropping a silent "e" ("cultivate" → "cultivating") is not
   something a suffix group can do correctly. */
const INFLECTION = "(?:s|es|d|ed)?";
const SLOP_WORD_RE = new RegExp(`\\b(${alternation(SLOP_WORDS)})${INFLECTION}\\b`, "gi");
const SLOP_PHRASE_RE = new RegExp(`(${alternation(SLOP_PHRASES)})`, "gi");
const TRANSITION_RE = new RegExp(`\\b(${alternation(TRANSITIONS)})\\b`, "gi");
const CONTRACTION_RE = /\b[\w]+['’](s|t|re|ve|ll|d|m)\b/i;

/* ------------------------------------------------------------
   RHYTHM

   The blueprint's "burstiness": humans mix a four-word sentence with a
   thirty-word one; models hold a steady medium. Measured as the
   coefficient of variation of sentence length, which is scale-free —
   a Reddit post and an Instagram caption are judged the same way.

   CHANGE (2026-08): added a lightweight "smoothness" signal. Even when
   variation numbers pass, a run of medium-long sentences with no short
   punch or fragment still reads machine-smooth.

   ============================================================
   CHANGE (2026-08b) — two real bugs in how rhythm was measured
   ============================================================
   This section was calibrated on prose paragraphs and then applied to
   short multi-line social posts, which is not the same distribution.
   Measured against a genuinely good hand-written Nextdoor post:

     "Cleaning out a closet this weekend?
      We take old laptops, phones, and tablets. Every drive gets
      wiped before anything else happens to it.
      Drop off Saturday, 9 to noon."

     lengths [6,7,10,6] · mean 7 · variation 0.226 → FLAGGED "uniform"

   That is a false positive on exactly the kind of writing the whole
   file exists to encourage, and by this file's own argument ("an
   operator who is warned about 'laptops, phones, and tablets' stops
   reading the warnings") it was the most damaging bug present.

   Two causes, two fixes:

   1. LAYOUT WAS BEING COUNTED AS PROSE. Splitting on \n+ turned every
      hashtag block, bare URL, address line and list bullet into a
      "sentence". Those are structure, not rhythm, and they drag the
      mean down until the coefficient of variation collapses. Fixed by
      dropping non-prose lines before measuring — see isProseLine.

   2. LOW VARIATION IS ONLY A TELL WHEN THE SENTENCES ARE LONGISH.
      This is the substantive insight. Uniformly SHORT sentences are
      what a punchy human writes; uniformly MEDIUM-LONG sentences are
      what an unedited model writes. The old check could not tell those
      apart because it looked at variation alone. The evenness warning
      is now gated behind a mean of VOICE_EVEN_MIN_MEAN words, which is
      also what makes the 0.45 threshold defensible: it is now only ever
      applied to the prose shape it was calibrated on.

   Line breaks still delimit sentences — in social copy a line with no
   full stop is genuinely a sentence — so only the filtering and the
   gating changed, not the segmentation.
   ------------------------------------------------------------ */

/* Structure, not prose: hashtag runs, bare links, @handle lines, list
   bullets, and pure punctuation/emoji separators. Excluded from rhythm
   because none of them says anything about how the writing moves. */
function isProseLine(line) {
  const bare = line.trim();
  if (!bare) return false;
  if (/^#\S+(\s+#\S+)*$/.test(bare)) return false;          /* #a #b #c   */
  if (/^@?\S+@\S+\.\S+$/.test(bare)) return false;          /* an email   */
  if (/^(https?:\/\/|www\.)\S+$/i.test(bare)) return false; /* a bare URL */
  if (/^[-*•·–]\s*/.test(bare)) return false;               /* a bullet   */
  if (!/[a-z]/i.test(bare)) return false;                   /* "———", ":)" */
  return true;
}

function sentencesOf(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(isProseLine);
}

const wordCount = (value) => (String(value).trim() ? String(value).trim().split(/\s+/).length : 0);

/** Sentence-length statistics. `variation` is stdev / mean: roughly
 *  0.25–0.40 for unedited model prose, 0.55+ for people writing quickly. */
export function rhythmOf(text) {
  const lengths = sentencesOf(text).map(wordCount).filter((n) => n > 0);
  if (!lengths.length) return { count: 0, mean: 0, variation: 0, shortest: 0, longest: 0 };
  const mean = lengths.reduce((sum, n) => sum + n, 0) / lengths.length;
  const spread = Math.sqrt(lengths.reduce((sum, n) => sum + (n - mean) ** 2, 0) / lengths.length);
  return {
    count: lengths.length,
    mean: Math.round(mean),
    variation: mean ? spread / mean : 0,
    shortest: Math.min(...lengths),
    longest: Math.max(...lengths)
  };
}

/* ------------------------------------------------------------
   THE SCANNER
   ------------------------------------------------------------ */

/* Matches are deduplicated case-insensitively and capped, because a
   list of fourteen findings is one nobody reads.

   CHANGE (2026-08b): `skip` suppresses matches inside a span that another
   finding already owns. It exists for one specific overlap: several
   phrases ("in today's", "looking for a way to") are also OPENERS, so a
   post beginning with one used to earn two warnings about the same six
   words — an opener finding telling the operator to rewrite the first
   line, and a stock-phrasing finding quoting a fragment of that same
   line. The opener finding is the more useful of the two, so it wins and
   the phrase match inside its span is dropped. Later occurrences of the
   same phrase elsewhere in the post still report normally. */
function hits(text, regex, cap = 4, skip = null) {
  const seen = new Map();
  for (const match of String(text).matchAll(regex)) {
    if (skip && match.index >= skip.start && match.index < skip.end) continue;
    const key = match[0].toLowerCase().trim();
    if (key && !seen.has(key)) seen.set(key, match[0].trim());
    if (seen.size >= cap) break;
  }
  return [...seen.values()];
}

const quote = (list) => list.map((item) => `“${item}”`).join(", ");

/**
 * Style findings for one piece of copy. Every finding is `warn` — see
 * the header. Returns [] for an empty draft, because platforms.js
 * already reports that as an error and two complaints about the same
 * empty box is noise.
 *
 * CHANGE (2026-08): added a "smoothness" check after the existing
 * rhythm tests. Previous scanner could pass a draft whose sentence
 * lengths varied just enough numerically but still felt like one long
 * polished paragraph. The new check looks for the absence of any short
 * sentence (< 8 words) in longer posts. Still warn-only.
 *
 * CHANGE (2026-08b): the three rhythm checks are now one exclusive
 * chain, and the opener is resolved before the word and phrase sweeps so
 * its span can suppress the duplicate matches inside it. Both changes
 * exist to hold the whole scan to one warning per underlying problem.
 */
export function scanVoice(text) {
  const body = String(text || "");
  if (!body.trim()) return [];
  const findings = [];

  /* Resolved first, reported in its usual place further down: the span
     is needed before the sweeps below so they can skip inside it. */
  let opener = null;
  let openerSpan = null;
  for (const entry of OPENERS) {
    const match = entry.pattern.exec(body);
    if (match) {
      opener = entry;
      openerSpan = { start: match.index, end: match.index + match[0].length };
      break;
    }
  }

  const words = hits(body, SLOP_WORD_RE, 4, openerSpan);
  if (words.length) {
    findings.push({
      level: "warn", kind: "voice",
      text: `AI-register wording: ${quote(words)}. Say it the way you would out loud.`
    });
  }

  const phrases = hits(body, SLOP_PHRASE_RE, 4, openerSpan);
  if (phrases.length) {
    findings.push({
      level: "warn", kind: "voice",
      text: `Stock phrasing: ${quote(phrases)}. Cut the wind-up and state the thing.`
    });
  }

  /* One transition is ordinary writing; a cluster is the tell. */
  const transitions = hits(body, TRANSITION_RE, 6);
  if (transitions.length >= 2) {
    findings.push({
      level: "warn", kind: "voice",
      text: `Stacked transitions (${quote(transitions)}). Keep one at most — short posts rarely need any.`
    });
  }

  for (const shape of CONSTRUCTIONS) {
    shape.pattern.lastIndex = 0;
    if (shape.pattern.test(body)) {
      findings.push({ level: "warn", kind: "voice", text: `${shape.text} ${shape.advice}` });
    }
  }

  if (opener) {
    findings.push({
      level: "warn", kind: "voice",
      text: `${opener.text} Start with the concrete thing instead: the date, the object, or the ask.`
    });
  }

  /* Rhythm is only meaningful with enough sentences to have a rhythm.
     One chain, so at most one of these three ever fires: they are three
     descriptions of the same underlying flatness, ordered worst first,
     and firing two of them at once said nothing extra. */
  const rhythm = rhythmOf(body);
  if (rhythm.count >= VOICE_MIN_SENTENCES) {
    if (rhythm.mean >= VOICE_EVEN_MIN_MEAN && rhythm.variation < VOICE_MIN_VARIATION) {
      /* Uniform AND longish. Uniformly short is a punchy human post, so
         the mean gate is what keeps this off good short copy. */
      findings.push({
        level: "warn", kind: "voice",
        text: `Every sentence is about the same length (~${rhythm.mean} words). Uniform rhythm is the clearest sign of generated text — break one in half and let another run long.`
      });
    } else if (rhythm.shortest > 12) {
      findings.push({
        level: "warn", kind: "voice",
        text: `No short sentence anywhere (shortest is ${rhythm.shortest} words). One blunt line changes how the whole post reads.`
      });
    } else if (rhythm.count >= 5 && rhythm.shortest >= 8 && rhythm.mean >= 14) {
      /* Smoothness: variation can look acceptable while the post still
         has no blunt line in it anywhere. */
      findings.push({
        level: "warn", kind: "voice",
        text: `No very short sentence (under ~8 words). A two- or three-word punch ("We take them.") breaks the smooth generated feel.`
      });
    }
  }

  /* Formality is a tell on these platforms specifically. */
  if (wordCount(body) > 55 && !CONTRACTION_RE.test(body)) {
    findings.push({
      level: "warn", kind: "voice",
      text: "No contractions anywhere, which reads like a press release. “We’ll pick it up” beats “We will pick it up”."
    });
  }

  return findings;
}

/** One-line summary for a compact UI slot. */
export function voiceSummary(text) {
  const findings = scanVoice(text);
  const rhythm = rhythmOf(text);
  if (!rhythm.count) return "";
  /* Same gate as the scanner, so the word in the summary and the warning
     in the list can never disagree about whether a post reads even. */
  const rhythmWord = rhythm.count < VOICE_MIN_SENTENCES ? "short"
    : (rhythm.mean >= VOICE_EVEN_MIN_MEAN && rhythm.variation < VOICE_MIN_VARIATION) ? "even"
      : "varied";
  return findings.length
    ? `${findings.length} voice ${findings.length === 1 ? "note" : "notes"} · rhythm ${rhythmWord}`
    : `reads clean · rhythm ${rhythmWord}`;
}

/* ------------------------------------------------------------
   PROMPT RENDERING

   The blueprint is explicit that generation-time constraints beat
   post-hoc correction, so this is where the leverage is. Two pieces go
   into the system prompt, and they are not equal in strength:

     exemplarSection()  real posts this organization has published.
                        The strongest signal available, by a wide margin.
     voiceRules()       a short description of how a person types, then
                        the worst of the tells.

   Order matters in buildInstructions: examples first, rules second. The
   rules are there to stop drift away from the examples, not to stand in
   for them.
   ------------------------------------------------------------ */

/**
 * The voice instruction block.
 *
 * CHANGE (2026-08b): rewritten, and deliberately much shorter than the
 * version this replaces. Positive modeling comes first and takes up most
 * of the room; the bans are trimmed to the ~15 worst per list and pushed
 * to the bottom. The reasoning is in the PROMPT_WORDS comment above —
 * briefly, a model rationing its attention across 130 forbidden strings
 * writes carefully rather than naturally, and careful is the exact
 * failure this file is trying to prevent. The scanner still holds the
 * long lists, which is the right place for them: catching a rare tell
 * after the fact is free, whereas prompt space is not.
 *
 * Written as flat imperative lines rather than headed prose because the
 * previous version read like a style guide, and a style guide invites a
 * model to produce style-guide output.
 */
export function voiceRules() {
  return `How to write it

Write like one person typing a quick note to a neighbor, not like a brand addressing an audience. Read it back out loud before you finish. If a sentence would sound strange said aloud, rewrite it.

Do this:
- Vary your sentence lengths. Put a long sentence next to a three-word one. Let at least one line be blunt: "We take them." "It's free."
- Open with the thing itself: the date, the object, the ask. Never open by framing why the topic matters in general.
- Talk to one reader as "you". Use contractions.
- Fragments are fine. So is starting a sentence with "And" or "But".
- End on the ask, plainly. Call, text, drop it off Saturday.
- Use small true details only, taken from the facts above or from the brief. Where neither gives you one, stay general. Vague and true beats vivid and invented.
- Leave it slightly uneven. Real posts are not evenly paced and do not tie themselves up in a neat closing line.

Do not use these words:
${PROMPT_WORDS.join(", ")}

Do not use these phrasings:
${PROMPT_PHRASES.join(", ")}

Also avoid:
- Em dashes and double hyphens. Use a period, a comma, or parentheses.
- "Not just X, but Y", and "Whether you're X or Y".
- Opening with a rhetorical question. Signing off with "Ready to ...?".
- Three-item lists of abstractions (quality, reliability, and impact). Listing actual devices is normal copy and perfectly fine.
- More than one formal connector (moreover, furthermore, additionally, ultimately).
- Rocket, fire, sparkle, and 100 emoji.
- A tidy summarising sentence at the end. Stop when you have said the thing.`;
}

/* ------------------------------------------------------------
   EXEMPLARS

   CHANGE (2026-08b): this function is new in its current form, and the
   selection rule is the part worth reading.

   WHAT MAY BE USED AS AN EXAMPLE
   Only copy a person had a hand in. An untouched model draft is
   excluded on purpose: quoting last week's generated output back to the
   model as "how we sound" is a feedback loop that entrenches the machine
   register instead of correcting it, and it would quietly defeat
   everything else in this file. So a variant qualifies only if a human
   wrote it, edited it, approved it, or published it — see isHumanShaped.

   RANKING
   Provenance outranks recency, because the point is voice rather than
   news. Hand-written external posts score highest (no model was ever
   involved), then published, then hand-edited, with a small nudge for
   the platform being drafted. Recency is only the tie-break.
   ------------------------------------------------------------ */

/** Did a person change what the model wrote? */
function wasEdited(variant) {
  const original = String(variant.aiBody || "").trim();
  const kept = String(variant.publishedBody || variant.body || "").trim();
  return Boolean(original && kept && original !== kept);
}

/** Eligibility gate. See the note above on the feedback loop. */
function isHumanShaped(post, variant) {
  if (post.source === "external") return true;
  if (variant.status === "published" || variant.status === "approved") return true;
  return wasEdited(variant);
}

function scoreExemplar(post, variant, platform) {
  let score = 0;
  if (post.source === "external") score += 8;
  if (variant.status === "published") score += 5;
  else if (variant.status === "approved") score += 1;
  if (wasEdited(variant)) score += 4;
  if (platform && variant.platform === platform) score += 2;
  return score;
}

/* What the model is looking at, stated plainly. A hand-written published
   Nextdoor post and a barely-approved draft are both examples, but they
   are not the same kind of example, and saying which is which costs one
   line. */
function describeExemplar(post, variant) {
  const label = getPlatform(variant.platform).label;
  const notes = [];
  if (post.source === "external") notes.push("written by hand");
  else if (wasEdited(variant)) notes.push("edited by hand");
  if (variant.status === "published") notes.push("published");
  else if (variant.status === "approved") notes.push("approved");
  return notes.length ? `${label}, ${notes.join(", ")}` : String(label);
}

/** Published text if it exists, otherwise what was approved. */
function exemplarBody(variant) {
  return String(variant.publishedBody || variant.body || "").trim();
}

function trimTo(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const boundary = cut.lastIndexOf(" ");
  const kept = boundary > limit * 0.6 ? cut.slice(0, boundary) : cut;
  return `${kept.trimEnd()}...`;
}

const recencyOf = (post, variant) =>
  Date.parse(variant.publishedAt || post.updatedAt || post.createdAt || "") || 0;

function pickExemplars(posts, platform) {
  const candidates = [];
  const seen = new Set();

  for (const post of Array.isArray(posts) ? posts : []) {
    if (!post || typeof post !== "object") continue;
    for (const variant of Array.isArray(post.variants) ? post.variants : []) {
      if (!variant || typeof variant !== "object") continue;
      if (!isHumanShaped(post, variant)) continue;

      const body = exemplarBody(variant);
      if (body.length < VOICE_EXEMPLAR_MIN_CHARS) continue;

      /* One message published to several platforms would otherwise take
         two of the three slots and teach the model nothing the first
         copy did not. */
      const key = body.slice(0, 120).toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);

      candidates.push({
        label: describeExemplar(post, variant),
        title: String(variant.title || "").trim(),
        body: trimTo(body, VOICE_EXEMPLAR_CHARS),
        score: scoreExemplar(post, variant, platform),
        at: recencyOf(post, variant)
      });
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score || b.at - a.at)
    .slice(0, VOICE_EXEMPLAR_COUNT);
}

/**
 * Real published copy, rendered for the system prompt. Returns "" when
 * the workspace has nothing a person has touched yet, in which case
 * buildInstructions omits the section entirely rather than printing an
 * empty heading.
 *
 * @param posts     workspace posts, newest first
 * @param platform  the platform being drafted, nudged up the ranking
 */
export function exemplarSection(posts = [], platform = "") {
  const chosen = pickExemplars(posts, platform);
  if (!chosen.length) return "";

  const blocks = chosen
    .map((item, index) => {
      const head = `${index + 1}. (${item.label})`;
      const title = item.title ? `\nTitle: ${item.title}` : "";
      return `${head}${title}\n${item.body}`;
    })
    .join("\n\n");

  return `How this organization actually sounds

These are real posts of ours, closest match first. Copy the voice: the rhythm, the plainness, where a post starts and how it signs off. Do not reuse their sentences, their opening, or their angle. Write something new that reads like the same person wrote it.

${blocks}`;
}