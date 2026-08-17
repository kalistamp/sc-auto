import test from "node:test";
import assert from "node:assert/strict";
import { buildCopyText, platformColor, platformHomeUrl, platformLabel, variantChecks } from "../js/platforms.js";
import {
  NEUTRAL_PLATFORM_KEY, defaultPlatforms, getPlatform, listPlatforms, platformKeys, setActivePlatforms
} from "../js/data.js";

const variant = (patch = {}) => ({
  platform: "facebook", title: "", body: "Some copy", hashtags: [], notes: "", ...patch
});

test("every platform declares the facts the UI reads off it", () => {
  setActivePlatforms(defaultPlatforms());
  for (const key of platformKeys()) {
    const meta = getPlatform(key);
    assert.ok(meta.label, `${key} needs a label`);
    assert.match(meta.color, /^#[0-9a-f]{6}$/i, `${key} needs a colour for its pip`);
    assert.ok(meta.bodyMax > 0, `${key} needs a body limit`);
    assert.ok(meta.soft > 0 && meta.soft <= meta.bodyMax, `${key}'s soft limit must sit under its hard limit`);
    assert.equal(platformLabel(key), meta.label);
    assert.equal(platformColor(key), meta.color);
  }
});

test("the neutral platform is offered, has no home page, and is sized to fit anywhere", () => {
  setActivePlatforms(defaultPlatforms());
  const neutral = getPlatform(NEUTRAL_PLATFORM_KEY);
  assert.equal(neutral.enabled, true, "it is on by default; it is the common case");
  assert.equal(neutral.homeUrl, "", "there is no single home page for 'anywhere'");
  assert.equal(platformHomeUrl(NEUTRAL_PLATFORM_KEY), "");

  /* Sized to the tightest mainstream ceiling, so a draft that passes here
     really can be pasted anywhere. */
  const others = listPlatforms().filter((platform) => platform.key !== NEUTRAL_PLATFORM_KEY && platform.homeUrl);
  assert.ok(others.length);
  assert.ok(others.every((platform) => neutral.bodyMax <= platform.bodyMax),
    "the neutral limit must not exceed any real platform's limit");
});

test("every platform that has a home page offers an https link and no publishing endpoint", () => {
  setActivePlatforms(defaultPlatforms());
  for (const platform of listPlatforms()) {
    if (!platform.homeUrl) continue;
    assert.match(platform.homeUrl, /^https:\/\//, `${platform.key} needs an https link`);
    /* A home or login page, never a submit endpoint or an API. */
    assert.doesNotMatch(platform.homeUrl, /\/submit|\/api\/|\/compose|\/share|graph\.|oauth/i,
      `${platform.key}'s link must be a front door, not a submission route`);
  }
});

test("LinkedIn is not in the platform list", () => {
  setActivePlatforms(defaultPlatforms());
  assert.ok(!platformKeys().includes("linkedin"));
});

test("an empty draft is an error, a long one is only a warning", () => {
  const empty = variantChecks(variant({ body: "   " }));
  assert.ok(empty.some((check) => check.level === "error"));

  const long = variantChecks(variant({ body: "x".repeat(getPlatform("facebook").soft + 10) }));
  assert.ok(long.some((check) => check.level === "warn"));
  assert.ok(!long.some((check) => check.level === "error"), "over the soft limit must not block approval");

  const tooLong = variantChecks(variant({ body: "x".repeat(getPlatform("facebook").bodyMax + 1) }));
  assert.ok(tooLong.some((check) => check.level === "error"));
});

test("Reddit needs a title and nothing else does", () => {
  assert.ok(variantChecks(variant({ platform: "reddit", title: "" })).some((check) => /needs a title/i.test(check.text)));
  assert.ok(!variantChecks(variant({ platform: "facebook" })).some((check) => /needs a title/i.test(check.text)));

  const over = variantChecks(variant({ platform: "reddit", title: "t".repeat(getPlatform("reddit").titleMax + 5) }));
  assert.ok(over.some((check) => check.level === "error" && /Title is/.test(check.text)));
});

test("claims a nonprofit should not make without checking are flagged", () => {
  assert.ok(variantChecks(variant({ body: "We guarantee your data is destroyed." })).some((check) => /absolute claim/i.test(check.text)));
  assert.ok(variantChecks(variant({ body: "We have refurbished 4,200 laptops." })).some((check) => /figure/i.test(check.text)));
  assert.ok(variantChecks(variant({ body: "We helped 300 students this year." })).some((check) => /figure/i.test(check.text)));
  assert.ok(!variantChecks(variant({ body: "We pick up old electronics for free." })).some((check) => /figure|absolute/i.test(check.text)));
});

test("too many hashtags is noticed across both places they can hide", () => {
  const checks = variantChecks(variant({ body: "#a #b #c #d", hashtags: ["e", "f"] }));
  assert.ok(checks.some((check) => /hashtags/i.test(check.text)));
});

test("copy text joins body and hashtags exactly once, and adds the missing #", () => {
  assert.equal(buildCopyText(variant({ body: "Hello", hashtags: ["EWaste", "#BayArea"] })), "Hello\n\n#EWaste #BayArea");
  assert.equal(buildCopyText(variant({ body: " Hello ", hashtags: [] })), "Hello");
  assert.equal(buildCopyText(variant({ body: "", hashtags: ["Tag"] })), "#Tag");
});

test("every platform hands off the same way: its own front door, never a composer", () => {
  /* The draft never travels in the URL. It goes on the clipboard and the
     operator pastes it, which is the same for every platform including
     ones added later. */
  setActivePlatforms(defaultPlatforms());
  for (const platform of listPlatforms()) {
    const url = platformHomeUrl(variant({ platform: platform.key, title: "My title", body: "My body" }));
    assert.equal(url, platform.homeUrl, `${platform.key} opens its own home page`);
    if (!url) continue;
    assert.doesNotMatch(url, /My%20body|My\+body|My body/, "the draft is never smuggled into the link");
    assert.doesNotMatch(url, /[?&](text|selftext|title|body)=/, "no composer prefill parameters");
  }
});

test("a platform the operator added is opened exactly like a built-in one", () => {
  setActivePlatforms([
    ...defaultPlatforms(),
    { key: "mastodon", label: "Mastodon", homeUrl: "https://mastodon.social/", enabled: true, bodyMax: 500, soft: 400 }
  ]);
  assert.equal(platformHomeUrl("mastodon"), "https://mastodon.social/");
  assert.equal(platformHomeUrl(variant({ platform: "mastodon" })), "https://mastodon.social/");
  assert.equal(platformLabel("mastodon"), "Mastodon");

  /* And its limits are enforced like any other platform's. */
  const over = variantChecks(variant({ platform: "mastodon", body: "x".repeat(501) }));
  assert.ok(over.some((check) => check.level === "error"));
  setActivePlatforms(defaultPlatforms());
});

test("a platform with no link reports none instead of inventing a destination", () => {
  setActivePlatforms(defaultPlatforms());
  assert.equal(platformHomeUrl(variant({ platform: NEUTRAL_PLATFORM_KEY })), "");
  /* A removed platform, opened from an archived post. */
  assert.equal(platformHomeUrl(variant({ platform: "myspace" })), "");
  assert.equal(platformHomeUrl(variant({ platform: undefined })), "");
});

test("checks on a removed platform degrade quietly rather than throwing", () => {
  setActivePlatforms(defaultPlatforms());
  const checks = variantChecks(variant({ platform: "long-gone", body: "Some copy" }));
  assert.ok(Array.isArray(checks));
  assert.ok(!checks.some((check) => check.level === "error"),
    "an archived post must not be reported as over a limit that no longer applies");
});
