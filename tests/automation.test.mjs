import test from "node:test";
import assert from "node:assert/strict";
import { defaultAutomation, autonomousGate, approvalMaterial, listingErrors, automationErrors, claimRisks } from "../js/automation.js";
import { cadenceDecision, jitteredSlot } from "../js/cadence.js";
import { createDefaultData, migrateData, setOrganization, setActivePlatforms, createExternalPost } from "../js/data.js";
import { flattenWorkspace, unflattenWorkspace } from "../js/sync.js";
import { recordPublication } from "../js/publication.js";
import { buildCopyText } from "../js/platforms.js";

test("schema 4 migration preserves publication records and does not enroll old schedules", () => {
  const data = createDefaultData();
  data.schemaVersion = 3;
  delete data.automation;
  const post = createExternalPost({ platform: "facebook", body: "old", publishedUrl: "https://example.com/p" });
  data.posts.push(post);
  const next = migrateData(data);
  assert.equal(next.schemaVersion, 4);
  assert.equal(next.automation.dryRun, true);
  assert.equal(next.automation.enabled, false);
  assert.equal(next.posts[0].variants[0].automation.optIn, false);
  assert.equal(next.posts[0].variants[0].publishedBody, post.variants[0].publishedBody);
  assert.deepEqual(unflattenWorkspace(flattenWorkspace(next)).automation, next.automation);
});
test("unreviewed warnings and invented claims fail; exact-copy approval cannot override errors", () => {
  const organization = { facts: ["Pickup is free."], prohibitedClaims: ["No invented partnerships."] };
  const variant = { platform: "facebook", body: "Pickup is free.", automation: {} };
  const args = { organization, variant, copy: variant.body, destination: "page" };
  assert.equal(autonomousGate(args).ok, true);
  assert.equal(autonomousGate({ ...args, checks: [{ level: "warn", text: "Voice finding" }] }).ok, false);
  assert.equal(autonomousGate({ ...args, warnings: ["Confirm the service area."] }).ok, false);
  assert.equal(autonomousGate({ ...args, variant: { ...variant, body: "We partner with NASA." } }).ok, false);
  variant.automation.approval = approvalMaterial(variant, organization, "page", args.copy);
  assert.equal(autonomousGate({ ...args, checks: [{ level: "warn", text: "Reviewed" }] }).ok, true);
  assert.equal(autonomousGate({ ...args, checks: [{ level: "error", text: "Too long" }] }).ok, false);
  // An edit voids the approval, so the edited copy's warnings hold it again.
  assert.equal(autonomousGate({ ...args, copy: "changed", checks: [{ level: "warn", text: "Reviewed" }] }).ok, false);
});

test("clean model wording goes out on its own; claim-shaped wording nobody approved is held", () => {
  const organization = { facts: ["Drives are wiped to NIST 800-88 standards.", "Equipment goes to certified California electronics recyclers."],
    mission: "Refurbish what can be saved for local students.", serviceArea: "Bay Area, California" };
  const gate = (body, extra = {}) => autonomousGate({ organization, destination: "page", copy: body,
    variant: { platform: "facebook", body, automation: {}, ...extra.variant }, ...extra });
  assert.equal(gate("That old laptop in the closet could be a student's next computer.").ok, true);
  // A number or a certification is fine where an approved fact carries it...
  assert.equal(gate("Every drive is wiped to NIST 800-88 standards first.", { checks: [{ level: "warn", text: "Mentions a figure. Check it against a source you can point to." }] }).ok, true);
  assert.equal(gate("What cannot be fixed goes to certified California electronics recyclers.").ok, true);
  // ...and held where it does not.
  for (const body of ["We are a certified recycler.", "We have collected 4 tons so far.", "Proud to partner with the city.",
    "Join our drop-off event this Saturday.", "Donations are tax-deductible.", "\"It changed my life,\" one parent said.",
    "Meet Maria, a student in Oakland.", "The Bay Area's leading recycler.", "Pickup is free for [CITY] residents.",
    "Details at https://example.org/drive."]) {
    const result = gate(body);
    assert.equal(result.ok, false, body);
    assert.match(result.reasons.join(" "), /Mentions/, body);
  }
  // The operator's own topic counts as approved wording.
  assert.equal(gate("Saturday drop-off at the Berkeley library.", { brief: { topic: "Saturday drop-off at the Berkeley library" } }).ok, true);
  // A model note asking for a check means the model was unsure.
  assert.equal(gate("Old phones are welcome too.", { variant: { notes: "Confirm we accept phones before posting." } }).ok, false);
  assert.equal(gate("Old phones are welcome too.", { variant: { notes: "Pairs well with a photo of a phone." } }).ok, true);
  // Placeholders are never waived, even when the brief repeats them.
  assert.equal(gate("Pickup in [CITY].", { brief: { topic: "Pickup in [CITY]" } }).ok, false);
  assert.deepEqual(claimRisks("That said, the choice is yours.", ""), []);
});

test("the gate holds reworded and hidden claims an independent review found slipping through", async () => {
  const { createDefaultData, setOrganization, setActivePlatforms } = await import("../js/data.js");
  const { variantChecks } = await import("../js/platforms.js");
  const data = createDefaultData(); setOrganization(data.organization); setActivePlatforms(data.platforms);
  const gate = (body, title = "") => {
    const variant = { platform: title ? "reddit" : "facebook", title, body, hashtags: [], notes: "", automation: {} };
    return autonomousGate({ variant, organization: data.organization, destination: "page", copy: buildCopyText(variant), checks: variantChecks(variant, data.organization) });
  };
  for (const body of [
    "We've refurbished 800 laptops for local students.",            // part of "800-88" is not a number anyone approved
    "We have recycled 8 tons of electronics.", "We helped 80 families this year.",
    "Every donated device is refurbished.", "All donated devices are refurbished for local students.",
    "Last month we gave refurbished laptops to students at Lincoln Elementary.",
    "We work with Oakland Unified to get laptops to kids.", "Thanks to our friends at Google for the support.",
    "We've collected hundreds of laptops.", "Our team is fully certified.", "Yesterday we picked up forty monitors."
  ]) assert.equal(gate(body).ok, false, body);
  for (const body of [
    "Worried about what's still on that old hard drive? Before any device goes anywhere, the drive is wiped to NIST 800-88 standards or physically destroyed. Your old files don't travel with it.",
    "Neighbors, if you've got a pile of old cables, a dead router or a monitor that won't turn on, we'll take it off your hands. Pickup is free across the Bay Area.",
    "Fair question before handing over an old machine. Drives are wiped to NIST 800-88 standards, or physically destroyed when wiping is not possible."
  ]) assert.equal(gate(body).ok, true, body);
  // A Reddit title in Title Case is not a list of names.
  assert.equal(gate("Pickup is free across the Bay Area.", "Free E-Waste Pickup Across The Bay Area").ok, true);
});
test("cadence enforces global lock, rolling caps, minimum gap and quiet hours", () => {
  const automation = defaultAutomation();
  const args = { automation, platform: "facebook", now: "2026-09-22T19:00:00Z" };
  assert.equal(cadenceDecision(args).ok, true);
  for (const phase of ["claimed", "submitting", "verifying", "uncertain"])
    assert.equal(cadenceDecision({ ...args, attempts: [{ phase }] }).ok, false);
  assert.equal(cadenceDecision({ ...args, now: "2026-09-22T05:00:00Z" }).ok, false);
  assert.equal(cadenceDecision({ ...args, history: [{ platform: "reddit", at: "2026-09-21T20:00:00Z" }] }).ok, false);
  assert.equal(cadenceDecision({ ...args, history: [{ platform: "facebook", at: "2026-09-20T19:00:00Z" }] }).ok, false);
  automation.policy.gapHours = 1;
  automation.platforms.facebook.gapHours = 1;
  assert.match(cadenceDecision({ ...args, history: [{ platform: "reddit", at: "2026-09-22T17:00:00Z" }] }).reason, /daily/);
  automation.policy.daily = 20;
  automation.platforms.facebook.daily = 20;
  assert.match(cadenceDecision({ ...args, history: [2, 3].map((days) => ({ platform: "facebook", at: new Date(Date.parse(args.now) - days * 86400000).toISOString() })) }).reason, /weekly/);
});
test("quiet hours follow DST and jitter varies repeated minutes", () => {
  const automation = defaultAutomation();
  for (const now of ["2026-03-08T09:30:00Z", "2026-11-01T09:30:00Z"])
    assert.equal(cadenceDecision({ automation, platform: "facebook", now }).ok, false);
  const slot = "2026-09-22T19:00:00Z";
  assert.equal(jitteredSlot(slot, 0, 0), "2026-09-22T19:01:00.000Z");
  assert.equal(jitteredSlot(slot, 0.5), "2026-09-22T19:15:00.000Z");
  assert.throws(() => jitteredSlot(slot, 1));
  automation.policy.daily = 0;
  assert.ok(automationErrors(automation).length);
});
test("service listings need area/category/images, not fictitious item condition", () => {
  const service = { platform: "offerup", kind: "service", title: "Pickup", body: "Pickup service", category: "approved category", area: "94101", photos: ["owner/logo.png"], operation: "create" };
  assert.deepEqual(listingErrors(service), []);
  assert.ok(listingErrors({ ...service, photos: [] }).length);
  assert.ok(listingErrors({ ...service, kind: "item" }).length);
  assert.ok(listingErrors({ ...service, operation: "renew" }).length);
});
test("recording matches manual fields and freezes outgoing CTA", () => {
  const data = createDefaultData(); setOrganization(data.organization); setActivePlatforms(data.platforms);
  const post = createExternalPost({ platform: "facebook", body: "Pickup is free." });
  const variant = post.variants[0]; variant.status = "scheduled"; variant.publishedBody = "";
  variant.scheduledAt = "2026-09-22T19:00:00Z";
  const copy = buildCopyText(variant);
  recordPublication(data, post, variant, { url: " https://example.com/post ", at: variant.scheduledAt, account: " Page ", now: variant.scheduledAt });
  assert.equal(variant.publishedBody, copy); assert.equal(variant.account, "Page");
  assert.equal(variant.status, "published"); assert.equal(data.activity[0].type, "publish");
  variant.body = "changed";
  recordPublication(data, post, variant, { url: "https://example.com/post", at: variant.publishedAt, account: "Page", now: variant.publishedAt });
  assert.equal(variant.publishedBody, copy);
});

test("each Reddit post goes to one subreddit: the free one that has waited longest", async () => {
  const { pickSubreddit, destinationFor, normalizeAutomation } = await import("../js/automation.js");
  const DAY = 86400000, now = Date.parse("2026-10-01T12:00:00Z");
  const automation = normalizeAutomation({ platforms: { reddit: { enabled: true, subreddits: [
    { name: "r/bayarea", gapDays: 30, enabled: true }, { name: "oakland", gapDays: 30, enabled: true },
    { name: "marin", gapDays: 7, enabled: true }, { name: "sanfrancisco", enabled: false }] } } });
  assert.deepEqual(automation.platforms.reddit.subreddits.map((s) => s.name), ["bayarea", "oakland", "marin", "sanfrancisco"], "r/ prefixes are dropped");
  const post = (variants) => ({ status: "review", variants });
  const published = (subreddit, daysAgo) => ({ id: `p-${subreddit}`, platform: "reddit", subreddit, status: "published", publishedAt: new Date(now - daysAgo * DAY).toISOString() });
  // Never posted anywhere: list order decides.
  assert.equal(pickSubreddit(automation, [], now), "bayarea");
  // The one that waited longest wins; one inside its own gap is skipped.
  const history = [post([published("bayarea", 40), published("oakland", 45), published("marin", 3)])];
  assert.equal(pickSubreddit(automation, history, now), "oakland");
  // A subreddit with a post already waiting is not given another.
  history.push(post([{ id: "w1", platform: "reddit", subreddit: "oakland", status: "scheduled" }]));
  assert.equal(pickSubreddit(automation, history, now), "bayarea");
  // ...unless that waiting post is the one being scheduled.
  assert.equal(pickSubreddit(automation, history, now, "w1"), "oakland");
  // Switched-off and busy subreddits exhausted: nothing is free.
  history.push(post([{ id: "w2", platform: "reddit", subreddit: "bayarea", status: "scheduled" }]));
  assert.equal(pickSubreddit(automation, history, now), null);
  assert.equal(destinationFor(automation, { platform: "reddit", subreddit: "oakland" }), "https://www.reddit.com/r/oakland/submit");
  assert.equal(destinationFor(automation, { platform: "reddit" }), "", "no subreddit chosen means nowhere to post");
  assert.equal(destinationFor({ platforms: { facebook: { destination: "https://www.facebook.com/x" } } }, { platform: "facebook" }), "https://www.facebook.com/x");
});

test("a chosen subreddit survives the workspace being saved and loaded", () => {
  const data = createDefaultData();
  const post = createExternalPost({ platform: "reddit", title: "t", body: "b" });
  post.variants[0].subreddit = "marin";
  data.posts.push(post);
  data.automation.platforms.reddit.subreddits = [{ name: "marin", flair: "Community", gapDays: 14, enabled: true, note: "" }];
  const back = unflattenWorkspace(flattenWorkspace(data));
  assert.equal(back.posts[0].variants[0].subreddit, "marin");
  assert.deepEqual(back.automation.platforms.reddit.subreddits[0], { name: "marin", flair: "Community", gapDays: 14, enabled: true, note: "" });
  data.automation.platforms.reddit.subreddits.push({ name: "not a sub!", gapDays: 30, enabled: false, note: "" });
  assert.match(automationErrors(data.automation).join(" "), /not a subreddit name/);
});
