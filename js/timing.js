/* ============================================================
   SAFE CYCLE STUDIO — best time to post

   What this is: a small table of research-backed posting windows, one
   per platform, and the arithmetic to turn a window into the next real
   date on the calendar.

   What this is NOT, and the distinction matters enough to put at the
   top: these are not predictions about Safe Cycle Tech's audience. Every
   window below is an average taken across hundreds of thousands of
   accounts that are mostly not this one. They are a starting point for a
   test, and the moment the workspace has enough of its own publication
   records to compare against, its own data wins. Every surface that
   shows one of these has to say so — see TIMING_DISCLAIMER.

   HOW THE NUMBERS WERE CHOSEN

   Two datasets carry most of the weight because they are the only two
   at a scale where an average means anything:

     · Sprout Social 2026 — ~2 billion engagements across ~307,000 social
       profiles, sampled 27 Nov 2025 to 27 Feb 2026, reported in local
       time. Covers Facebook, Instagram, LinkedIn, X, TikTok, Pinterest.
     · Buffer 2026 — 52 million posts across platforms, with a 14 million
       post cut for Facebook alone.

   Where they agree, confidence is "high". Where they disagree — and on
   Facebook they disagree sharply about the hour — the record says so in
   `conflict` rather than quietly picking a winner, because an operator
   who knows two large studies point opposite ways will run a test, and
   an operator handed a single confident number will not.

   Neither study covers Reddit or Nextdoor, which are two of the three
   platforms this organization actually uses. Those records are honest
   about resting on weaker evidence; see their `basis` and `confidence`.

   No network call, no DOM, no clock read at module scope. Everything is
   a pure function of its arguments so the windows can be tested against
   a fixed date.
   ============================================================ */

/* When this table was last checked against its sources. Shown in the UI
   so a stale recommendation is visibly stale rather than silently so. */
export const TIMING_RESEARCH_DATE = "2026-08-19";

/* The sentence that has to travel with every recommendation. */
export const TIMING_DISCLAIMER =
  "Research-backed starting points, not guaranteed best times. The real answer depends on your audience, "
  + "where they live, what the post is, and how your own past posts did.";

/* ------------------------------------------------------------
   SOURCES

   Every window below points at entries here by id, so a recommendation
   can never appear in the interface without the citation behind it
   being one lookup away. `retrieved` is when the page was read, not when
   it was published — `published` is that, where the page states it.
   ------------------------------------------------------------ */
export const TIMING_SOURCES = {
  "sprout-2026": {
    id: "sprout-2026",
    org: "Sprout Social",
    title: "Best Times to Post on Social Media 2026",
    url: "https://sproutsocial.com/insights/best-times-to-post-on-social-media/",
    method: "~2 billion engagements across ~307,000 social profiles, sampled 27 Nov 2025 to 27 Feb 2026. Local time.",
    retrieved: "2026-08-19"
  },
  "sprout-2026-facebook": {
    id: "sprout-2026-facebook",
    org: "Sprout Social",
    title: "Best Times to Post on Facebook in 2026",
    url: "https://sproutsocial.com/insights/best-times-to-post-on-facebook/",
    method: "Facebook cut of the same ~2 billion engagement dataset, with a per-industry breakdown including nonprofits.",
    retrieved: "2026-08-19"
  },
  "sprout-2026-instagram": {
    id: "sprout-2026-instagram",
    org: "Sprout Social",
    title: "Best Times to Post on Instagram in 2026",
    url: "https://sproutsocial.com/insights/best-times-to-post-on-instagram/",
    method: "Instagram cut of the same ~2 billion engagement dataset, with a nonprofit breakdown.",
    retrieved: "2026-08-19"
  },
  "sprout-2026-linkedin": {
    id: "sprout-2026-linkedin",
    org: "Sprout Social",
    title: "Best Times to Post on LinkedIn in 2026",
    url: "https://sproutsocial.com/insights/best-times-to-post-on-linkedin/",
    method: "LinkedIn cut of the same ~2 billion engagement dataset.",
    retrieved: "2026-08-19"
  },
  "buffer-2026": {
    id: "buffer-2026",
    org: "Buffer",
    title: "Best Time to Post on Social Media in 2026: Every Platform",
    url: "https://buffer.com/resources/best-time-to-post-social-media/",
    method: "52 million posts published through Buffer, 2.5 to 10 million per platform.",
    retrieved: "2026-08-19"
  },
  "buffer-2026-facebook": {
    id: "buffer-2026-facebook",
    org: "Buffer",
    title: "Best Time to Post on Facebook — New Data from 14M Posts",
    url: "https://buffer.com/resources/best-time-to-post-on-facebook/",
    method: "14 million Facebook posts published through Buffer, scored on reactions, comments and shares.",
    retrieved: "2026-08-19"
  },
  "nextdoor-business": {
    id: "nextdoor-business",
    org: "Nextdoor",
    title: "5 steps to success with Nextdoor Business Posts",
    url: "https://business.nextdoor.com/en-us/blog/5-steps-to-success-with-nextdoor-business-posts",
    method: "Nextdoor's own guidance for Business Pages. No dataset size published.",
    published: "17 Jun 2020, updated 31 Jan 2024",
    retrieved: "2026-08-19"
  },
  "singlegrain-reddit-2026": {
    id: "singlegrain-reddit-2026",
    org: "Single Grain",
    title: "Best Times to Post on Reddit (2026 Data)",
    url: "https://www.singlegrain.com/search-everywhere-optimization/best-times-to-post-on-reddit-for-maximum-engagement/",
    method: "Cites 500K+ Reddit posts but does not publish its method. Eastern Time. Treated as weak evidence.",
    retrieved: "2026-08-19"
  },
  "sprout-optimal-send-times": {
    id: "sprout-optimal-send-times",
    org: "Sprout Social",
    title: "Optimal Send Times (product documentation)",
    url: "https://support.sproutsocial.com/hc/en-us/articles/360042762271-Optimal-Send-Times",
    method: "Sprout's own account-level feature reads 16 weeks of a single audience's behaviour, which is the reason a global average is only a starting point.",
    retrieved: "2026-08-19"
  }
};

/* Confidence is a claim about the evidence, not about the outcome. */
export const CONFIDENCE = {
  high:     { label: "Strong evidence",   note: "Two large independent datasets point the same way." },
  moderate: { label: "Moderate evidence", note: "Large dataset, but the sources disagree in part or the data is dated." },
  low:      { label: "Weak evidence",     note: "No large study covers this platform. Treat the window as a hypothesis to test." }
};

/* ------------------------------------------------------------
   THE TABLE

   Days are JavaScript weekday numbers: 0 is Sunday, 6 is Saturday.
   Times are [hour, minute] in the operator's own local time, because
   every source above reports in the reader's local time rather than one
   fixed zone.

   `peak` is the single moment inside the window that the "Use this time"
   button aims at. It is the window's start unless a source names a
   sharper peak inside it.
   ------------------------------------------------------------ */

const GENERIC_KEY = "__generic";

const TABLE = {
  /* The neutral "Any platform" draft, and the fallback for any platform
     the operator adds themselves. Sprout's cross-platform figure. */
  default: {
    primary:   { days: [2, 3], from: [11, 0], to: [18, 0], peak: [13, 0] },
    secondary: null,
    avoid: "Weekends. They are the lowest-engagement days on every platform in both datasets except TikTok and YouTube.",
    cadence: "",
    confidence: "moderate",
    basis: "Sprout Social's cross-platform figure: Tuesdays and Wednesdays, 11 a.m. to 6 p.m. local time. "
      + "Buffer's 52-million-post analysis lands on the same shape — Wednesday is the strongest day on Facebook, "
      + "Instagram, LinkedIn, X and Threads, and weekends are the weakest.",
    conflict: "",
    vertical: "",
    caveat: "A neutral draft is going somewhere specific in the end. Once you know where, use that platform's window instead.",
    sources: ["sprout-2026", "buffer-2026"]
  },

  facebook: {
    primary:   { days: [2, 3], from: [12, 0], to: [20, 0], peak: [13, 0] },
    secondary: { days: [3, 4], from: [8, 0], to: [11, 0], peak: [9, 0] },
    avoid: "Saturday and Sunday. Both datasets put the weekend last, and Buffer puts Saturday last of all.",
    cadence: "",
    confidence: "moderate",
    basis: "Sprout Social: Tuesdays and Wednesdays, 12 to 8 p.m. local. Mondays and Thursdays also perform, in narrower "
      + "bands — Monday noon to 1 p.m., Thursday noon to 2 p.m.",
    conflict: "The two largest datasets agree on the day and disagree on the hour. Buffer's 14-million-post cut finds the "
      + "opposite of Sprout on time of day: mornings 6 to 11 a.m. strongest, Thursday 9 a.m. the single best slot, and "
      + "noon to 5 p.m. consistently the weakest window of the day. Sprout's afternoon peak comes from a wider, mostly "
      + "brand-account sample; Buffer's from posts scheduled through one tool. Test both before trusting either — the "
      + "morning window is offered as the second option below.",
    vertical: "Sprout's nonprofit breakdown narrows to Tuesday through Thursday, roughly 10 a.m. to 4 p.m. That band is "
      + "the one stretch of the day both datasets support, so it is the safest place to start.",
    caveat: "Meta Business Suite reports when this Page's own followers are online. That reading beats every number here.",
    sources: ["sprout-2026-facebook", "buffer-2026-facebook", "sprout-2026"]
  },

  instagram: {
    primary:   { days: [2, 3], from: [13, 0], to: [19, 0], peak: [14, 0] },
    secondary: { days: [4], from: [9, 0], to: [11, 0], peak: [9, 0] },
    avoid: "Weekends, which Sprout puts last across almost every industry. Buffer's worst day is Friday.",
    cadence: "",
    confidence: "moderate",
    basis: "Sprout Social: Tuesdays 1 to 7 p.m. and Wednesdays noon to 9 p.m. local. Its nonprofit cut runs Tuesday "
      + "through Thursday, 10 a.m. to 5 p.m.",
    conflict: "Buffer's dataset puts the single best slot at Thursday 9 a.m. and finds twin peaks at 9 a.m. and 6 p.m. on "
      + "weekdays. The 9 a.m. reading is the second option below.",
    vertical: "Nonprofits, per Sprout: Tuesday through Thursday 10 a.m. to 5 p.m., Monday 1 p.m., Friday 11 a.m. to noon "
      + "and 3 p.m.",
    caveat: "Instagram needs the image to be ready. A good photo posted at a mediocre hour beats the reverse.",
    sources: ["sprout-2026-instagram", "buffer-2026"]
  },

  /* Reddit is the weakest record in this table and says so. Neither
     Sprout nor Buffer covers it at all, and the figure that circulates
     everywhere else — Tuesday to Thursday, 6 to 9 a.m. Eastern — is 3 to
     6 a.m. on this coast, drawn from business and SaaS subreddits, and
     traceable to pages that do not publish their method. It is not
     advice for a Bay Area city subreddit. */
  reddit: {
    primary:   { days: [2, 3], from: [17, 0], to: [19, 0], peak: [18, 0] },
    secondary: { days: [1, 4], from: [16, 30], to: [18, 0], peak: [17, 15] },
    avoid: "Cross-posting the same text to several subreddits at once, which reads as spam and buries all of them. "
      + "Stagger by a day or two and rewrite the title for each community.",
    cadence: "Reddit rewards being in the comments for the first hour far more than it rewards the posting hour itself.",
    confidence: "low",
    basis: "No large-scale study covers Reddit — neither Sprout nor Buffer includes it. The widely repeated "
      + "\"Tuesday to Thursday, 6 to 9 a.m. Eastern\" is 3 to 6 a.m. Pacific, comes from business and SaaS subreddits, "
      + "and traces back to pages that never publish their method. This early-evening window instead reflects the one "
      + "pattern the Reddit sources do agree on — local and leisure communities peak outside working hours — together "
      + "with this workspace's own results, where the strongest post so far went up on a Tuesday just after 6 p.m.",
    conflict: "",
    vertical: "",
    caveat: "On Reddit the real unit is the subreddit, not the platform. A city subreddit and a national one do not share "
      + "a rhythm. Check the community's own activity before trusting any of this, and rely on your own record first.",
    sources: ["singlegrain-reddit-2026"]
  },

  /* The only platform here whose timing guidance comes from the platform
     itself. That is worth a lot — and it is undercut by the page giving
     no sample size and dating to 2020. Hence moderate, not high. */
  nextdoor: {
    primary:   { days: [4, 5], from: [17, 0], to: [19, 0], peak: [17, 30] },
    secondary: null,
    avoid: "Early in the week, and weekends. Nextdoor states plainly that later in the week does better than either.",
    cadence: "About one business post every two weeks. Nextdoor reports engagement falling off after roughly two weeks, "
      + "so a post every other week keeps a page present without wearing out the neighbourhood.",
    confidence: "moderate",
    basis: "Nextdoor's own guidance for Business Pages: \"Businesses that post between their local hours of 5-7pm tend to "
      + "see higher engagement rates than posts made at different times,\" and \"posts later in the week tend to see "
      + "higher engagement rates than those made earlier in the week or on the weekend.\"",
    conflict: "",
    vertical: "Nextdoor also reports that Business Pages with five or more recommendations see about 30% higher "
      + "engagement, and that posts carrying a real photo hold attention better. Both are larger levers than the hour.",
    caveat: "First-party, which is the strongest kind of evidence here — but the page publishes no sample size and dates "
      + "to 2020, last updated January 2024. Treat the 5 to 7 p.m. window as well-founded and the precision as not.",
    sources: ["nextdoor-business"]
  },

  /* Retired from the platform list, but recorded posts still point at it
     and still render. A record without a window would fall through to
     the generic fallback and quietly imply LinkedIn was never
     researched. */
  linkedin: {
    primary:   { days: [2, 3, 4], from: [11, 0], to: [17, 0], peak: [11, 0] },
    secondary: { days: [3], from: [15, 0], to: [18, 0], peak: [15, 0] },
    avoid: "Weekends, which Sprout puts last.",
    cadence: "",
    confidence: "moderate",
    basis: "Sprout Social: Tuesdays through Thursdays, 11 a.m. to 5 p.m. local.",
    conflict: "Buffer reads it differently and reports that evening engagement has overtaken the working day — 3 to "
      + "6 p.m., Wednesday through Sunday. That later band is the second option.",
    vertical: "",
    caveat: "",
    sources: ["sprout-2026-linkedin", "buffer-2026"]
  }
};

/* What an unknown platform gets. Deliberately the same window as the
   neutral draft, but flagged `generic` so the interface can say the
   window is a cross-platform average rather than research about that
   platform — a custom platform showing a confident-looking Facebook
   number would be a straightforward lie. */
const GENERIC = {
  ...TABLE.default,
  caveat: "No platform-specific research covers this one. This is the cross-platform average, which is a place to start "
    + "and nothing more. Your own publication records will beat it quickly."
};

/* ------------------------------------------------------------
   LOOKUP
   ------------------------------------------------------------ */

/* Always an object, never null — every call site renders it directly.
   An unrecognised key (a platform the operator added, a key from a
   hand-edited workspace) gets the generic record rather than nothing,
   because "no advice" and "no such platform" look identical in a UI and
   only one of them is true. */
export function bestTimeFor(platformKey) {
  const key = String(platformKey || "").trim();
  const found = Object.prototype.hasOwnProperty.call(TABLE, key) ? TABLE[key] : null;
  const record = found || GENERIC;
  return {
    ...record,
    key: found ? key : GENERIC_KEY,
    generic: !found,
    headline: formatWindow(record.primary),
    confidenceLabel: CONFIDENCE[record.confidence].label,
    confidenceNote: CONFIDENCE[record.confidence].note
  };
}

/* Every platform key this module has real research for, in table order.
   Used by the settings view to list what is covered. */
export function researchedPlatformKeys() {
  return Object.keys(TABLE);
}

/* The source records behind a platform's window, in the order the
   recommendation leans on them. Unknown ids are dropped rather than
   rendered as blanks. */
export function sourcesFor(platformKey) {
  return bestTimeFor(platformKey).sources
    .map((id) => TIMING_SOURCES[id])
    .filter(Boolean);
}

/* ------------------------------------------------------------
   FORMATTING

   "Tuesday–Wednesday, 12–8 PM" rather than a paragraph. The whole point
   of the feature is that the answer fits on one line.
   ------------------------------------------------------------ */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function formatWindow(window) {
  if (!window) return "";
  return `${formatDays(window.days)}, ${formatHourRange(window.from, window.to)}`;
}

/* Three cases, because "Tuesday, Wednesday" reads worse than
   "Tuesday–Wednesday" and "Monday–Thursday" would be a lie about a
   window that skips Tuesday and Wednesday. */
export function formatDays(days) {
  const list = [...new Set(days)].sort((a, b) => a - b);
  if (!list.length) return "";
  if (list.length === 1) return DAY_NAMES[list[0]];

  const consecutive = list.every((day, index) => index === 0 || day === list[index - 1] + 1);
  if (consecutive) return `${DAY_NAMES[list[0]]}–${DAY_NAMES[list[list.length - 1]]}`;

  const names = list.map((day) => DAY_NAMES[day]);
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/* "12–8 PM" when both ends share a meridiem, "10 AM – 4 PM" when they do
   not. The spaces around the dash in the second case are deliberate:
   "10 AM–4 PM" is genuinely hard to read at a glance. */
export function formatHourRange(from, to) {
  const sameHalf = meridiem(from[0]) === meridiem(to[0]);
  return sameHalf
    ? `${clock(from, false)}–${clock(to, true)}`
    : `${clock(from, true)} – ${clock(to, true)}`;
}

export function formatTime(time) {
  return clock(time, true);
}

function clock([hour, minute], withMeridiem) {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const body = minute ? `${h}:${String(minute).padStart(2, "0")}` : `${h}`;
  return withMeridiem ? `${body} ${meridiem(hour)}` : body;
}

function meridiem(hour) {
  return hour < 12 ? "AM" : "PM";
}

/* ------------------------------------------------------------
   THE NEXT REAL SLOT

   A window is a rule; the schedule dialog needs a date. This walks
   forward from `from` to the first moment that satisfies the rule.

   `from` is an argument rather than a call to new Date() so the whole
   thing is testable against a fixed clock, and so the schedule dialog
   and the hint under the draft cannot disagree by a millisecond.

   Local time throughout, on purpose: the sources report in the reader's
   local time, and the operator schedules in theirs. The ISO string
   handed back is the UTC instant that local moment corresponds to,
   which is exactly what the workspace stores.
   ------------------------------------------------------------ */

/* Returns a Date, or null if the window has no days (which the table
   never produces, but a hand-edited record could). Searches at most
   eight days ahead, which is one full week plus the wrap. */
export function nextSlot(window, from = new Date()) {
  if (!window || !window.days?.length) return null;
  const days = new Set(window.days);
  const [hour, minute] = window.peak || window.from;

  for (let ahead = 0; ahead <= 8; ahead += 1) {
    const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate() + ahead, hour, minute, 0, 0);
    if (!days.has(candidate.getDay())) continue;
    /* Strictly after `from`: a window that opened an hour ago is not a
       slot to schedule into, it is a slot that was missed. */
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  return null;
}

/* What the schedule dialog prefills, as an ISO string. Falls back to the
   generic window for an unknown platform, and to "" only if a record has
   been edited into having no days at all — callers treat that the same
   as having no suggestion. */
export function nextSlotIso(platformKey, from = new Date()) {
  const slot = nextSlot(bestTimeFor(platformKey).primary, from);
  return slot ? slot.toISOString() : "";
}

/* "Wednesday 1 PM" — the one-line answer to "so when, then". Separate
   from formatWindow because a window is advice and a slot is a date the
   operator is about to commit to. */
export function describeSlot(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return `${DAY_NAMES[date.getDay()]} ${clock([date.getHours(), date.getMinutes()], true)}`;
}
