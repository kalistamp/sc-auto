import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
  CONFIDENCE, TIMING_DISCLAIMER, TIMING_RESEARCH_DATE, TIMING_SOURCES,
  bestTimeFor, describeSlot, formatDays, formatHourRange, formatWindow,
  nextSlot, nextSlotIso, researchedPlatformKeys, sourcesFor
} from "../js/timing.js";
import { defaultPlatforms, setActivePlatforms, platformKeys } from "../js/data.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* Wednesday 19 August 2026, 3pm local. Every date assertion below is
   anchored to it rather than to the real clock, because a suite that
   only passes on Tuesdays is worse than no suite. */
const WEDNESDAY_3PM = new Date(2026, 7, 19, 15, 0, 0);

test("the anchor date this suite reasons from really is a Wednesday", () => {
  assert.equal(WEDNESDAY_3PM.getDay(), 3);
});

/* ============================================================
   THE TABLE ITSELF
   ============================================================ */

test("every researched platform declares a complete, coherent window", () => {
  for (const key of researchedPlatformKeys()) {
    const timing = bestTimeFor(key);

    assert.ok(timing.primary, `${key} needs a primary window`);
    assert.ok(timing.primary.days.length, `${key}'s window needs at least one day`);
    for (const day of timing.primary.days) {
      assert.ok(Number.isInteger(day) && day >= 0 && day <= 6, `${key} has a day outside 0-6`);
    }

    const [fromHour] = timing.primary.from;
    const [toHour] = timing.primary.to;
    assert.ok(fromHour < toHour, `${key}'s window must open before it closes`);

    /* The peak is the moment "Use this time" aims at. Outside the window
       it advertises, it would be advice the interface contradicts. */
    const [peakHour, peakMinute] = timing.primary.peak;
    const peak = peakHour * 60 + peakMinute;
    assert.ok(peak >= fromHour * 60 + timing.primary.from[1], `${key}'s peak is before its window opens`);
    assert.ok(peak <= toHour * 60 + timing.primary.to[1], `${key}'s peak is after its window closes`);

    assert.ok(timing.basis, `${key} must say what its window rests on`);
    assert.ok(CONFIDENCE[timing.confidence], `${key} has an unknown confidence level`);
    assert.ok(timing.sources.length, `${key} must cite at least one source`);
  }
});

test("every cited source id resolves to a real record with a real link", () => {
  for (const key of researchedPlatformKeys()) {
    const cited = bestTimeFor(key).sources;
    const resolved = sourcesFor(key);
    assert.equal(resolved.length, cited.length,
      `${key} cites a source id that is not in TIMING_SOURCES`);
  }

  for (const [id, source] of Object.entries(TIMING_SOURCES)) {
    assert.equal(source.id, id, "a source's id must match its key");
    assert.ok(source.org && source.title, `${id} needs an organization and a title`);
    assert.match(source.url, /^https:\/\//, `${id} needs an https link`);
    assert.ok(source.method, `${id} must describe its method, even to say there isn't one published`);
    assert.match(source.retrieved, /^\d{4}-\d{2}-\d{2}$/, `${id} needs a retrieval date`);
  }
});

test("no source is declared and then never cited", () => {
  const cited = new Set(researchedPlatformKeys().flatMap((key) => bestTimeFor(key).sources));
  const orphans = Object.keys(TIMING_SOURCES).filter((id) => !cited.has(id));
  /* sprout-optimal-send-times is deliberately not attached to a window:
     it is the citation for "use your own data instead", which is a
     statement about the whole table rather than about one platform. */
  assert.deepEqual(orphans, ["sprout-optimal-send-times"]);
});

test("Reddit and Nextdoor are not dressed up as better evidenced than they are", () => {
  /* Neither Sprout nor Buffer covers either platform. If a later edit
     ever raises these to "strong evidence" it has to be because a real
     study appeared, and this test is where that gets noticed. */
  assert.equal(bestTimeFor("reddit").confidence, "low");
  assert.notEqual(bestTimeFor("nextdoor").confidence, "high");

  const reddit = bestTimeFor("reddit");
  assert.match(reddit.caveat, /subreddit/i, "Reddit's caveat has to name the subreddit as the real unit");
});

test("Facebook records that its two large sources disagree rather than picking one", () => {
  const facebook = bestTimeFor("facebook");
  assert.ok(facebook.conflict, "Sprout says afternoons, Buffer says mornings; the record has to say so");
  assert.match(facebook.conflict, /Buffer/);
  assert.ok(facebook.secondary, "the losing window is still offered as the second option");
  /* Sprout's afternoon primary and Buffer's morning secondary must not
     be the same band, or the disagreement has been papered over. */
  assert.notDeepEqual(facebook.primary.from, facebook.secondary.from);
});

/* ============================================================
   LOOKUP
   ============================================================ */

test("an unknown platform gets the cross-platform average, flagged as such", () => {
  const custom = bestTimeFor("some-platform-invented-later");
  assert.equal(custom.generic, true);
  assert.ok(custom.headline, "it still has to answer the question");
  assert.match(custom.caveat, /No platform-specific research/i);

  for (const known of researchedPlatformKeys()) {
    assert.equal(bestTimeFor(known).generic, false, `${known} is researched, not generic`);
  }
});

test("a missing or empty key does not throw, because hand-edited data exists", () => {
  for (const input of [undefined, null, "", "   ", 0]) {
    const timing = bestTimeFor(input);
    assert.ok(timing.headline, `bestTimeFor(${JSON.stringify(input)}) must still return a window`);
    assert.equal(timing.generic, true);
  }
});

test("every platform the app ships with has a window", () => {
  setActivePlatforms(defaultPlatforms());
  for (const key of platformKeys()) {
    assert.equal(bestTimeFor(key).generic, false,
      `${key} is a built-in platform and should have researched timing, not the generic fallback`);
  }
});

/* ============================================================
   FORMATTING — the whole point is that it fits on one line
   ============================================================ */

test("a window reads the way a person would say it", () => {
  assert.equal(bestTimeFor("facebook").headline, "Tuesday–Wednesday, 12–8 PM");
  assert.equal(bestTimeFor("nextdoor").headline, "Thursday–Friday, 5–7 PM");
  assert.equal(bestTimeFor("reddit").headline, "Tuesday–Wednesday, 5–7 PM");
  assert.equal(bestTimeFor("default").headline, "Tuesday–Wednesday, 11 AM – 6 PM");
});

test("consecutive days get a dash and non-consecutive days get a list", () => {
  assert.equal(formatDays([3]), "Wednesday");
  assert.equal(formatDays([2, 3]), "Tuesday–Wednesday");
  assert.equal(formatDays([2, 3, 4]), "Tuesday–Thursday");
  /* The one that matters: a dash here would claim Tuesday and Wednesday
     are in the window when the record deliberately excludes them. */
  assert.equal(formatDays([1, 4]), "Monday and Thursday");
  assert.equal(formatDays([1, 3, 5]), "Monday, Wednesday and Friday");
  assert.equal(formatDays([]), "");
  assert.equal(formatDays([3, 2, 3]), "Tuesday–Wednesday", "duplicates and disorder are survivable");
});

test("the meridiem is only printed twice when the range actually crosses noon", () => {
  assert.equal(formatHourRange([12, 0], [20, 0]), "12–8 PM");
  assert.equal(formatHourRange([8, 0], [11, 0]), "8–11 AM");
  assert.equal(formatHourRange([11, 0], [18, 0]), "11 AM – 6 PM");
  assert.equal(formatHourRange([16, 30], [18, 0]), "4:30–6 PM");
});

/* ============================================================
   THE NEXT REAL SLOT
   ============================================================ */

test("the next slot lands on a day the window allows, at the peak", () => {
  const nextdoor = bestTimeFor("nextdoor");
  const slot = nextSlot(nextdoor.primary, WEDNESDAY_3PM);
  assert.equal(slot.getDay(), 4, "Thursday is the first Nextdoor day after a Wednesday");
  assert.equal(slot.getHours(), 17);
  assert.equal(slot.getMinutes(), 30);
  assert.equal(describeSlot(slot), "Thursday 5:30 PM");
});

test("a window still open today is used today, not deferred a week", () => {
  /* Reddit's window is Tue/Wed 5-7pm and the anchor is Wednesday 3pm,
     so the answer is this evening. */
  const slot = nextSlot(bestTimeFor("reddit").primary, WEDNESDAY_3PM);
  assert.equal(slot.getDate(), WEDNESDAY_3PM.getDate());
  assert.equal(describeSlot(slot), "Wednesday 6 PM");
});

test("a peak that has already passed today rolls forward instead of scheduling into the past", () => {
  /* Facebook peaks Wednesday 1pm; the anchor is Wednesday 3pm. */
  const slot = nextSlot(bestTimeFor("facebook").primary, WEDNESDAY_3PM);
  assert.ok(slot.getTime() > WEDNESDAY_3PM.getTime(), "never suggests a moment already gone");
  assert.equal(describeSlot(slot), "Tuesday 1 PM");
  assert.equal(slot.getDate(), 25, "the following Tuesday");
});

test("the next slot is found from any day of the week", () => {
  for (let offset = 0; offset < 7; offset += 1) {
    const from = new Date(2026, 7, 19 + offset, 15, 0, 0);
    for (const key of researchedPlatformKeys()) {
      const timing = bestTimeFor(key);
      const slot = nextSlot(timing.primary, from);
      assert.ok(slot, `${key} found no slot starting from ${from.toDateString()}`);
      assert.ok(timing.primary.days.includes(slot.getDay()), `${key} suggested a day outside its window`);
      assert.ok(slot.getTime() > from.getTime(), `${key} suggested a moment in the past`);
      assert.ok(slot.getTime() - from.getTime() < 8 * 864e5, `${key} suggested a date more than a week out`);
    }
  }
});

test("a window with no days yields nothing rather than a wrong date", () => {
  assert.equal(nextSlot({ days: [], from: [9, 0], to: [11, 0], peak: [9, 0] }, WEDNESDAY_3PM), null);
  assert.equal(nextSlot(null, WEDNESDAY_3PM), null);
  assert.equal(describeSlot(null), "");
  assert.equal(describeSlot(new Date("nonsense")), "");
});

test("nextSlotIso hands back a parseable instant for every platform", () => {
  for (const key of [...researchedPlatformKeys(), "a-platform-with-no-research"]) {
    const iso = nextSlotIso(key, WEDNESDAY_3PM);
    assert.match(iso, /^\d{4}-\d{2}-\d{2}T/, `${key} produced something the date input cannot read`);
    assert.ok(Date.parse(iso) > WEDNESDAY_3PM.getTime());
  }
});

/* ============================================================
   THE PROMISE THE UI MAKES

   A posting window averaged over 307,000 other accounts is a
   hypothesis about this organization, not an answer. Any surface that
   shows one and drops the qualifier is overclaiming, so the wiring is
   checked here rather than left to review.
   ============================================================ */

test("the disclaimer says the two things it has to say", () => {
  assert.match(TIMING_DISCLAIMER, /not guaranteed/i);
  assert.match(TIMING_DISCLAIMER, /audience/i);
  assert.match(TIMING_RESEARCH_DATE, /^\d{4}-\d{2}-\d{2}$/);
});

test("every place the app shows a window also shows the disclaimer and the sources", async () => {
  const app = await read("js/app.js");

  /* The full record renders the disclaimer and the citations. */
  const detail = app.slice(app.indexOf("function timingDetail("), app.indexOf("function openTimingDialog("));
  assert.ok(detail.includes("TIMING_DISCLAIMER"), "timingDetail must carry the disclaimer");
  assert.ok(detail.includes("timingBibliography("), "timingDetail must carry the citations");

  /* The one-line hint is too small for either, so it must offer the way
     through to them instead of standing alone. */
  const hint = app.slice(app.indexOf("function timingHint("), app.indexOf("function timingDetail("));
  assert.ok(hint.includes("timing-detail"), "the hint must link through to the full record");

  /* And the Overview's platform card, which is where the windows are
     read at a glance and where the bibliography lives. */
  const overview = app.slice(app.indexOf("function renderOverview("), app.indexOf("function launcherPlatforms("));
  assert.ok(overview.includes("TIMING_DISCLAIMER"), "the Overview card must carry the disclaimer");
  assert.ok(overview.includes("timingBibliography("), "the Overview card must list the sources");
});

test("the Overview shows a window for every platform it offers a front door to", async () => {
  const app = await read("js/app.js");
  const launcher = app.slice(app.indexOf("function platformLauncher("), app.indexOf("function timingBibliography("));

  assert.ok(launcher.includes("bestTimeFor("), "each front door must carry its platform's window");
  assert.ok(launcher.includes("timing-detail"), "and a way through to the evidence behind it");

  /* A button inside an anchor is dropped by the browser, which would
     make "Why?" permanently unclickable. The link and the timing row
     have to be siblings. */
  const anchor = launcher.indexOf("<a class=\"launch\"");
  const closesAnchor = launcher.indexOf("</a>", anchor);
  const whenRow = launcher.indexOf("launch-when");
  assert.ok(anchor > -1, "the front door is still a real link");
  assert.ok(whenRow > closesAnchor, "the timing row must sit outside the anchor, not inside it");
});

test("the timing feature is no longer buried in Settings", async () => {
  const app = await read("js/app.js");
  const settings = app.slice(app.indexOf("function renderSettings("), app.indexOf("function platformRow("));
  assert.ok(!settings.includes("timingBibliography("),
    "the sources moved to the Overview, where the platforms already are");
  assert.ok(!app.includes("function timingCard("), "the old Settings card should be gone, not orphaned");
});

test("the schedule dialog offers the researched slot rather than an arbitrary one", async () => {
  const app = await read("js/app.js");
  const dialog = app.slice(app.indexOf("function openScheduleDialog("), app.indexOf("function openExternalDialog("));
  assert.ok(dialog.includes("timingDetail("), "the schedule dialog must show the recommendation");
  assert.ok(dialog.includes("nextSlotIso("), "the prefilled date must come from the research, not from a guess");
});

test("nothing in the timing module reaches the network or the DOM", async () => {
  const source = await read("js/timing.js");
  assert.doesNotMatch(source, /\bfetch\s*\(/, "timing data is compiled in, not fetched");
  /* Deliberately narrow. A bare /\bwindow\./ would match this module's
     own prose, which is about posting windows and ends sentences with
     the word — so it is the DOM and storage globals that get named. */
  assert.doesNotMatch(source, /\bdocument\.|localStorage|sessionStorage|innerHTML/,
    "this module renders nothing itself");
});

test("the module is registered everywhere a module has to be registered", async () => {
  const html = await read("index.html");
  const pkg = JSON.parse(await read("package.json"));
  const modules = (await readdir(new URL("../js", import.meta.url))).filter((name) => name.endsWith(".js"));

  assert.ok(modules.includes("timing.js"));
  assert.match(html, /"\.\/js\/timing\.js":/, "the import map has to cover it or a deploy can serve a stale copy");
  assert.ok(pkg.scripts.check.includes("js/timing.js"), "npm run check has to syntax-check it");
});
