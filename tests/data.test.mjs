import test from "node:test";
import assert from "node:assert/strict";
import {
  NEUTRAL_PLATFORM_KEY, SCHEMA_VERSION, addActivity, addRun, countsFor, createDefaultData,
  createExternalPost, createPostFromGeneration, defaultPlatforms, derivePostStatus,
  findSimilarPosts, getPlatform, listPlatforms, migrateData, normalizePlatform, platformKeys,
  setActivePlatforms, splitTags, textSimilarity, uniquePlatformKey, validateData
} from "../js/data.js";
import { ACTIVITY_LIMIT, RUN_LOG_LIMIT } from "../js/config.js";

test("the default workspace is valid and carries the SafeCycle context", () => {
  const data = createDefaultData();
  assert.deepEqual(validateData(data), []);
  assert.equal(data.schemaVersion, SCHEMA_VERSION);
  assert.match(data.organization.mission, /electronics/i);
  assert.ok(data.organization.facts.length >= 5);
  assert.ok(data.organization.prohibitedClaims.length >= 3);
  assert.deepEqual(data.posts, []);
  assert.deepEqual(data.runs, []);
});

test("a schema 1 workspace migrates without losing anything", () => {
  const legacy = {
    schemaVersion: 1,
    revision: 7,
    updatedAt: "2026-01-02T00:00:00.000Z",
    organization: { name: "Safe Cycle Tech", facts: ["Pickup is free."] },
    platformSettings: { reddit: { enabled: false, guidance: "Custom guidance" } },
    posts: [{
      id: "post_1",
      campaign: "Old campaign",
      canonical: "Original copy",
      ai: { model: "some-model-v1", provider: "openai", warnings: ["check me"] },
      variants: [{ id: "v1", platform: "reddit", title: "Title", body: "Edited body", status: "published", publishedUrl: "https://example.com/p" }]
    }],
    activity: [{ id: "a1", type: "x", message: "hello", createdAt: "2026-01-01T00:00:00.000Z" }]
  };

  const data = migrateData(legacy);
  assert.deepEqual(validateData(data), []);
  assert.equal(data.schemaVersion, SCHEMA_VERSION);
  assert.equal(data.revision, 7, "revision is preserved so conflict detection keeps working");
  assert.equal(data.organization.name, "Safe Cycle Tech");

  /* Schema 3 folds platformSettings into the platforms array. The
     operator's own choices have to survive that move. */
  const byKey = Object.fromEntries(data.platforms.map((platform) => [platform.key, platform]));
  assert.equal(byKey.reddit.enabled, false);
  assert.equal(byKey.reddit.guidance, "Custom guidance");
  assert.ok(byKey.instagram, "platforms added since v1 are filled in with defaults");
  assert.ok(byKey.default, "the neutral platform is available after migrating");
  assert.equal(data.platformSettings, undefined, "the old map is gone, not left alongside");

  const post = data.posts[0];
  assert.equal(post.source, "ai");
  assert.equal(post.ai.requestedModel, "some-model-v1");
  assert.equal(post.ai.servedModel, "some-model-v1", "a v1 post has one model string; both slots report it honestly");
  assert.deepEqual(post.ai.warnings, ["check me"]);
  assert.equal(post.variants[0].aiBody, "Edited body", "with no record of the original, the current body is the best answer");
  assert.equal(post.variants[0].publishedUrl, "https://example.com/p");
  assert.ok(Array.isArray(data.runs));
});

test("migration repairs junk instead of throwing", () => {
  const data = migrateData({ posts: "nope", activity: 5, organization: null, platformSettings: { reddit: null }, platforms: "nope" });
  assert.deepEqual(validateData(data), []);
  assert.deepEqual(data.posts, []);
  assert.deepEqual(data.activity, []);
  assert.equal(data.platforms.find((platform) => platform.key === "reddit").enabled, true);
  assert.equal(migrateData(null).schemaVersion, SCHEMA_VERSION);
});

test("validation catches the mistakes a hand-edited gist would introduce", () => {
  const data = createDefaultData();
  data.posts = [{ id: "dup", variants: [] }, { id: "dup", variants: [{ platform: "myspace", body: "x" }] }];
  const errors = validateData(data);
  assert.ok(errors.some((error) => /Duplicate post ID/.test(error)));
  assert.ok(errors.some((error) => /Unknown platform/.test(error)));
  assert.ok(validateData({ schemaVersion: 99 }).length);
});

/* ------------------------------------------------------------
   PLATFORMS (schema 3)
   ------------------------------------------------------------ */

test("LinkedIn is gone from the defaults but never taken away from a post that used it", () => {
  /* The rule this protects: publication history is the least
     recoverable thing in the workspace. Removing a built-in platform
     must not orphan a post or quietly reassign it — schema 2 rewrote an
     unrecognized platform to "facebook", which falsified the record. */
  const fresh = createDefaultData();
  assert.ok(!fresh.platforms.some((platform) => platform.key === "linkedin"),
    "LinkedIn is no longer offered");

  const withHistory = migrateData({
    schemaVersion: 2,
    organization: { name: "Safe Cycle Tech" },
    platformSettings: { linkedin: { enabled: true, guidance: "Mission-led.", account: "@sct" } },
    posts: [{
      id: "post_li",
      campaign: "Partner drive",
      variants: [{ id: "v1", platform: "linkedin", body: "Posted copy", status: "published", publishedUrl: "https://example.com/x" }]
    }]
  });

  assert.deepEqual(validateData(withHistory), [], "a workspace with LinkedIn history is still valid");
  assert.equal(withHistory.posts[0].variants[0].platform, "linkedin", "the record still says LinkedIn");
  assert.equal(withHistory.posts[0].variants[0].publishedUrl, "https://example.com/x");

  const linkedin = withHistory.platforms.find((platform) => platform.key === "linkedin");
  assert.ok(linkedin, "the platform is re-registered so the post is not orphaned");
  assert.equal(linkedin.label, "LinkedIn", "and keeps its real name rather than decaying to a key");
  assert.equal(linkedin.retired, true);
  assert.equal(linkedin.enabled, false, "retired platforms are never offered for new drafts");
  assert.equal(linkedin.account, "@sct", "the operator's own settings come across too");
});

test("any platform a post references survives migration, even an invented one", () => {
  const data = migrateData({
    schemaVersion: 2,
    organization: { name: "x" },
    posts: [{ id: "p", variants: [{ id: "v", platform: "mastodon", body: "hi" }] }]
  });
  assert.deepEqual(validateData(data), []);
  assert.equal(data.posts[0].variants[0].platform, "mastodon");
  assert.ok(data.platforms.some((platform) => platform.key === "mastodon" && platform.retired));
});

test("a schema 3 workspace keeps the operator's own platform list verbatim", () => {
  const custom = [
    { key: "mastodon", label: "Mastodon", homeUrl: "https://mastodon.social/", enabled: true, bodyMax: 500, soft: 400 }
  ];
  const data = migrateData({ schemaVersion: 3, organization: { name: "x" }, platforms: custom, posts: [] });
  assert.equal(data.platforms.length, 1, "the built-ins are not re-added over the top");
  assert.equal(data.platforms[0].key, "mastodon");
  assert.equal(data.platforms[0].homeUrl, "https://mastodon.social/");
});

test("platform normalization repairs what a form or a hand-edited gist can send", () => {
  const clean = normalizePlatform({
    label: "  My Network  ", homeUrl: "mynetwork.example", color: "nope",
    bodyMax: "800", soft: "5000", titleMax: "-4"
  }, "my-network");

  assert.equal(clean.key, "my-network");
  assert.equal(clean.label, "My Network");
  assert.equal(clean.homeUrl, "https://mynetwork.example", "a bare hostname is what people type");
  assert.equal(clean.color, "#7d8279", "a nonsense colour falls back rather than reaching the style attribute");
  assert.equal(clean.soft, 800, "a soft limit above the hard limit could never fire, so it is clamped");
  assert.equal(clean.titleMax, 0);

  /* The dangerous field: this string ends up in an href the operator clicks. */
  for (const hostile of ["javascript:alert(1)", "data:text/html,<script>", "  ", "ftp://x.example/"]) {
    assert.equal(normalizePlatform({ label: "x", homeUrl: hostile }, "x").homeUrl, "",
      `${hostile} must not survive into a link`);
  }
});

test("adding the same platform twice produces two distinct keys", () => {
  assert.equal(uniquePlatformKey("Mastodon", []), "mastodon");
  assert.equal(uniquePlatformKey("Mastodon", ["mastodon"]), "mastodon-2");
  assert.equal(uniquePlatformKey("Mastodon", ["mastodon", "mastodon-2"]), "mastodon-3");
  assert.equal(uniquePlatformKey("!!!", []), "platform", "a name with nothing sluggable still yields a key");
});

test("the registry always answers, including for a platform that no longer exists", () => {
  setActivePlatforms(defaultPlatforms());
  assert.equal(getPlatform("nextdoor").label, "Nextdoor");
  assert.equal(getPlatform(NEUTRAL_PLATFORM_KEY).label, "Any platform");

  /* Every view reads .label/.color/.bodyMax straight off this object, so
     undefined here is a crash while rendering an archived post. */
  const gone = getPlatform("some-removed-thing");
  assert.equal(typeof gone.label, "string");
  assert.ok(gone.label.length > 0);
  assert.equal(typeof gone.color, "string");
  assert.ok(gone.bodyMax > 0, "an archived post is never reported as over a limit that no longer applies");
  assert.equal(gone.retired, true);

  const missing = getPlatform(undefined);
  assert.equal(typeof missing.label, "string");
  assert.equal(typeof missing.bodyMax, "number");
});

test("an unreadable platform list falls back to the built-ins rather than a dead app", () => {
  assert.ok(setActivePlatforms([]).length > 0);
  assert.ok(setActivePlatforms(null).length > 0);
  assert.ok(setActivePlatforms([{ label: "no key" }]).length > 0);
  setActivePlatforms(defaultPlatforms());
});

test("listPlatforms filters the way the pickers need", () => {
  setActivePlatforms([
    { key: "a", label: "A", enabled: true },
    { key: "b", label: "B", enabled: false },
    { key: "c", label: "C", enabled: true, retired: true }
  ]);
  assert.deepEqual(platformKeys(), ["a", "b", "c"]);
  assert.deepEqual(platformKeys({ enabledOnly: true }), ["a", "c"]);
  /* What the brief picker uses: on, and not retired. */
  assert.deepEqual(platformKeys({ enabledOnly: true, includeRetired: false }), ["a"]);
  setActivePlatforms(defaultPlatforms());
});

test("validation catches a workspace that contradicts itself about platforms", () => {
  const data = createDefaultData();
  data.platforms = [...data.platforms, { key: "reddit", label: "Reddit again" }];
  assert.ok(validateData(data).some((error) => /Duplicate platform key/.test(error)));

  const empty = createDefaultData();
  empty.platforms = [];
  assert.ok(validateData(empty).some((error) => /At least one platform/.test(error)));

  const unnamed = createDefaultData();
  unnamed.platforms = [{ key: "x", label: "  " }];
  assert.ok(validateData(unnamed).some((error) => /needs a name/.test(error)));
});

test("post status is derived from its variants, with archive winning", () => {
  const post = { status: "review", variants: [{ status: "draft" }, { status: "approved" }] };
  assert.equal(derivePostStatus(post), "review");

  post.variants = [{ status: "approved" }, { status: "approved" }];
  assert.equal(derivePostStatus(post), "approved");

  post.variants = [{ status: "approved" }, { status: "scheduled" }];
  assert.equal(derivePostStatus(post), "scheduled");

  post.variants = [{ status: "published" }, { status: "approved" }];
  assert.equal(derivePostStatus(post), "partial");

  post.variants = [{ status: "published" }, { status: "published" }];
  assert.equal(derivePostStatus(post), "published");

  post.status = "archived";
  assert.equal(derivePostStatus(post), "archived", "an operator decision outranks a derived state");
});

test("a generated post freezes the model's original text separately from the working copy", () => {
  const brief = { campaign: "Drive", objective: "o", audience: "a", keyMessage: "k", tags: "laptops, reuse", scheduledAt: "" };
  const generation = {
    canonical: "Shared message",
    warnings: ["verify the date"],
    variants: [{ platform: "reddit", title: "T", body: "Model wrote this", hashtags: ["EWaste"], notes: "n" }]
  };
  const receipt = {
    provider: "anthropic", requestedModel: "claude-opus-5", servedModel: "claude-opus-5-20260317",
    promptVersion: "sct-social-3", latencyMs: 1234, usage: { input: 10, output: 20, total: 30 },
    responseId: "msg_1", at: "2026-02-01T00:00:00.000Z"
  };

  const post = createPostFromGeneration(brief, generation, receipt);
  assert.equal(post.source, "ai");
  assert.deepEqual(post.tags, ["laptops", "reuse"]);
  assert.equal(post.ai.requestedModel, "claude-opus-5");
  assert.equal(post.ai.servedModel, "claude-opus-5-20260317");

  const variant = post.variants[0];
  assert.equal(variant.aiBody, "Model wrote this");
  assert.equal(variant.publishedBody, "");

  variant.body = "Human edit";
  assert.equal(variant.aiBody, "Model wrote this", "editing the draft must not touch the model's output");
});

test("an externally recorded post is marked as having no model behind it", () => {
  const post = createExternalPost({ campaign: "Reminder", platform: "facebook", body: "Posted by hand", publishedUrl: "https://example.com/x" });
  assert.equal(post.source, "external");
  assert.equal(post.ai.provider, "none");
  assert.equal(post.variants[0].status, "published");
  assert.equal(post.variants[0].publishedBody, "Posted by hand");
  assert.equal(post.variants[0].aiBody, "", "nothing was generated, so there is no original to keep");
  assert.deepEqual(validateData({ ...createDefaultData(), posts: [post] }), []);
});

test("repetition detection ignores links and short words", () => {
  const a = "Old laptops sitting in closets can become computers for local students https://a.example";
  const b = "Old laptops sitting in closets can become computers for local students https://b.example";
  assert.ok(textSimilarity(a, b) > 0.9);
  assert.equal(textSimilarity("", "anything"), 0);
  assert.ok(textSimilarity("completely unrelated subject matter", "old laptops closets students") < 0.2);

  const posts = [{ campaign: "Earlier", canonical: a }];
  assert.equal(findSimilarPosts(b, posts).length, 1);
  assert.equal(findSimilarPosts("nothing alike whatsoever", posts).length, 0);
});

test("tags are parsed the way a person types them", () => {
  assert.deepEqual(splitTags("laptops, #back-to-school ,, reuse"), ["laptops", "back-to-school", "reuse"]);
  assert.deepEqual(splitTags(["a", " b "]), ["a", "b"]);
  assert.deepEqual(splitTags(""), []);
});

test("trails are capped so one JSON file cannot grow forever", () => {
  const data = createDefaultData();
  for (let index = 0; index < ACTIVITY_LIMIT + 20; index += 1) addActivity(data, "test", `entry ${index}`);
  assert.equal(data.activity.length, ACTIVITY_LIMIT);
  assert.match(data.activity[0].message, new RegExp(`entry ${ACTIVITY_LIMIT + 19}`), "newest first");

  for (let index = 0; index < RUN_LOG_LIMIT + 5; index += 1) addRun(data, { at: new Date().toISOString(), status: "ok" });
  assert.equal(data.runs.length, RUN_LOG_LIMIT);
});

test("counts reflect what the dashboard claims", () => {
  const data = createDefaultData();
  const past = new Date(Date.now() - 86400000).toISOString();
  data.posts = [
    { id: "p1", status: "review", variants: [{ status: "draft" }, { status: "approved" }] },
    { id: "p2", status: "review", variants: [{ status: "scheduled", scheduledAt: past }] },
    { id: "p3", status: "review", variants: [{ status: "published" }] }
  ];
  const counts = countsFor(data);
  assert.equal(counts.posts, 3);
  assert.equal(counts.needsReview, 1);
  assert.equal(counts.approved, 1);
  assert.equal(counts.scheduled, 1);
  assert.equal(counts.published, 1);
  assert.equal(counts.overdue, 1);
});
