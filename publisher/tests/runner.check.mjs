/* The runner end to end: real engine, real store, real migration SQL.
   Only the browser (platform websites) and the model provider are fakes. */
process.env.TZ = "America/Los_Angeles";
import test from "node:test";
import assert from "node:assert/strict";
import { database, supabaseShim, revision, browserWrite, fakeBrowser, USER } from "./harness.mjs";
import { setSupabaseClient } from "../../js/sync.js";
import { createDefaultData, createExternalPost, setOrganization, setActivePlatforms } from "../../js/data.js";
import { approvalMaterial } from "../../js/automation.js";
import { buildCopyText } from "../../js/platforms.js";
import { PublisherStore, generateNext } from "../store.js";
import { tick } from "../engine.js";

/* Tuesday 12:00 in Los Angeles: inside every timing window's day and
   outside the default quiet hours. */
const NOW = "2026-09-22T19:00:00.000Z";
const minutesBefore = (minutes) => new Date(Date.parse(NOW) - minutes * 60000).toISOString();

function workspace() {
  const data = createDefaultData();
  const a = data.automation;
  a.enabled = true; a.dryRun = false;
  for (const key of ["facebook", "reddit"]) {
    a.platforms[key].enabled = true;
    a.platforms[key].destination = `https://www.${key}.com/test/compose`;
  }
  setOrganization(data.organization); setActivePlatforms(data.platforms);
  return data;
}

/* A scheduled, opted-in variant. `approved` binds exact-copy approval. */
function addPost(data, platform, { body = "Pickup is free across the Bay Area.", minutes = 5, approved = true, title = "Free pickup" } = {}) {
  const post = createExternalPost({ platform, body, title: platform === "reddit" ? title : "" });
  post.status = "review";
  const variant = post.variants[0];
  Object.assign(variant, { status: "scheduled", scheduledAt: minutesBefore(minutes), publishedAt: "", publishedUrl: "", publishedBody: "", photos: [] });
  variant.automation = { optIn: true, reviewReasons: [], approval: approved
    ? approvalMaterial(variant, data.organization, data.automation.platforms[platform].destination, buildCopyText(variant)) : "" };
  data.posts.push(post);
  return { post, variant };
}

async function runner(data) {
  const db = await database(data);
  const client = supabaseShim(db);
  setSupabaseClient(client);
  const store = new PublisherStore(client, { id: USER });
  const alerts = [];
  const options = (browser) => ({ store, browser, alert: async (message) => { alerts.push(message); }, now: () => NOW, live: true, sleep: async () => {} });
  return { db, store, alerts, options };
}

const variantIn = (data, id) => data.posts.flatMap((post) => post.variants).find((variant) => variant.id === id);

test("dry-run through the real SQL records one decision and touches no browser", async () => {
  const data = workspace(); data.automation.dryRun = true;
  addPost(data, "facebook");
  const { db, store, options } = await runner(data);
  try {
    const browser = fakeBrowser();
    assert.equal((await tick(options(browser))).state, "dry-run");
    assert.equal((await tick(options(browser))).state, "idle");
    const { journal } = await store.load();
    assert.deepEqual(journal.attempts.map((attempt) => attempt.phase), ["dry-run"]);
    assert.equal(browser.calls.prepare + browser.calls.submit + browser.calls.verify, 0);
  } finally { await db.close(); }
});

test("a verified live send is recorded exactly as a manual record would be", async () => {
  const data = workspace();
  const { variant } = addPost(data, "facebook");
  const expected = buildCopyText(variant);
  const { db, store, options } = await runner(data);
  try {
    const browser = fakeBrowser();
    const result = await tick(options(browser));
    assert.equal(result.state, "succeeded");
    const { data: after, journal } = await store.load();
    const recorded = variantIn(after, variant.id);
    assert.equal(recorded.status, "published");
    assert.equal(recorded.publishedBody, expected);
    assert.equal(recorded.publishedUrl, result.permalink);
    assert.equal(journal.attempts[0].phase, "succeeded");
    assert.equal((await tick(options(browser))).state, "idle");
    assert.equal(browser.calls.submit, 1);
  } finally { await db.close(); }
});

test("writing a review reason does not make the next item's claim fail on a stale revision", async () => {
  const data = workspace();
  data.automation.policy.gapHours = 1;
  addPost(data, "facebook", { body: "We guarantee 100% of devices are refurbished.", minutes: 10, approved: false });
  const { variant: ready } = addPost(data, "reddit", { minutes: 5 });
  const { db, store, alerts, options } = await runner(data);
  try {
    const browser = fakeBrowser();
    for (let i = 0; i < 3; i++) await tick(options(browser));
    const { data: after } = await store.load();
    assert.equal(variantIn(after, ready.id).status, "published");
    assert.equal(alerts.some((message) => /SC_REVISION_CONFLICT/.test(message)), false, alerts.join("\n"));
  } finally { await db.close(); }
});

test("one platform's minimum gap does not hold back another platform that is due", async () => {
  const data = workspace();
  Object.assign(data.automation.policy, { gapHours: 1, daily: 10, weekly: 10 });
  const earlier = createExternalPost({ platform: "facebook", body: "Earlier post", publishedAt: minutesBefore(120) });
  data.posts.push(earlier);
  addPost(data, "facebook", { minutes: 10 });
  const { variant: reddit } = addPost(data, "reddit", { minutes: 5 });
  const { db, store, options } = await runner(data);
  try {
    await tick(options(fakeBrowser()));
    const { data: after } = await store.load();
    assert.equal(variantIn(after, reddit.id).status, "published");
  } finally { await db.close(); }
});

test("after a failure before submission, resuming lets the runner deliver the item", async () => {
  const data = workspace();
  const { variant } = addPost(data, "facebook");
  const { db, store, options } = await runner(data);
  try {
    assert.equal((await tick(options(fakeBrowser({ fault: "prepare" })))).state, "failed");
    assert.equal((await tick(options(fakeBrowser()))).state, "paused");
    await store.command("resume");
    const browser = fakeBrowser();
    assert.equal((await tick(options(browser))).state, "succeeded");
    assert.equal(browser.calls.submit, 1);
    const { data: after } = await store.load();
    assert.equal(variantIn(after, variant.id).status, "published");
  } finally { await db.close(); }
});

test("a failure after submission blocks every later tick and never resubmits", async () => {
  const data = workspace();
  addPost(data, "facebook");
  addPost(data, "reddit");
  const { db, options } = await runner(data);
  try {
    const browser = fakeBrowser({ fault: "verify" });
    assert.equal((await tick(options(browser))).state, "uncertain");
    for (let i = 0; i < 3; i++) assert.equal((await tick(options(browser))).state, "uncertain");
    assert.equal(browser.calls.submit, 1);
  } finally { await db.close(); }
});

test("generation survives a concurrent browser save instead of pausing publishing", async () => {
  const data = workspace();
  data.automation.generationEnabled = true;
  data.automation.topics.push({ id: "topic_1", topic: data.organization.facts[0], factText: data.organization.facts[0], platforms: ["facebook"], postId: "" });
  const { db, store } = await runner(data);
  try {
    const save = store.save.bind(store);
    let raced = false;
    store.save = async (before, after) => {
      if (!raced) { raced = true; await browserWrite(db, "activity", "act_browser", { id: "act_browser", type: "note", message: "browser", at: NOW }); }
      return save(before, after);
    };
    await generateNext({ store, credentials: {}, now: new Date(NOW), random: () => 0.5 });
    const { data: after, journal } = await store.load();
    assert.equal(journal.pausedReason, "");
    assert.equal(after.posts.length, 1);
    assert.equal(after.automation.topics[0].postId, after.posts[0].id);
    assert.ok(after.activity.some((entry) => entry.id === "act_browser"), "the browser's save must survive");
  } finally { await db.close(); }
});

test("generation waits while earlier automatic posts for the platform are still pending", async () => {
  const data = workspace();
  Object.assign(data.automation, { generationEnabled: true, generationLimit: 10 });
  for (const [index, fact] of data.organization.facts.slice(0, 2).entries())
    data.automation.topics.push({ id: `topic_${index}`, topic: fact, factText: fact, platforms: ["facebook"], postId: "" });
  const { db, store } = await runner(data);
  try {
    assert.equal(await generateNext({ store, credentials: {}, now: new Date(NOW), random: () => 0.5 }), true);
    assert.equal(await generateNext({ store, credentials: {}, now: new Date(NOW), random: () => 0.5 }), false);
    assert.equal((await store.load()).data.posts.length, 1);
  } finally { await db.close(); }
});

test("a browser save just before the submit barrier is not mistaken for a possible post", async () => {
  const data = workspace();
  const { variant } = addPost(data, "facebook");
  const { db, store, alerts, options } = await runner(data);
  try {
    const command = store.command.bind(store);
    let raced = false;
    store.command = async (name, ...rest) => {
      if (name === "begin" && !raced) { raced = true; await browserWrite(db, "activity", "act_browser", { id: "act_browser", type: "note", message: "browser", at: NOW }); }
      return command(name, ...rest);
    };
    const browser = fakeBrowser();
    const first = await tick(options(browser));
    assert.equal(first.state, "updated", JSON.stringify(first));
    assert.equal(browser.calls.submit, 0, "the rejected barrier means nothing was clicked");
    assert.equal((await store.load()).journal.pausedReason, "", "a stale revision is not a reason to stop posting");
    assert.equal((await tick(options(browser))).state, "succeeded");
    assert.equal(browser.calls.submit, 1);
    assert.equal(variantIn((await store.load()).data, variant.id).status, "published");
    assert.equal(alerts.length, 0, alerts.join("\n"));
  } finally { await db.close(); }
});

test("an edit to the post during preparation sends the new version next time, without pausing", async () => {
  const data = workspace();
  const { post, variant } = addPost(data, "facebook", { approved: false });
  const { db, store, options } = await runner(data);
  try {
    const browser = fakeBrowser();
    const prepare = browser.prepare;
    let edited = false;
    browser.prepare = async (snapshot) => {
      await prepare(snapshot);
      if (edited) return;
      edited = true;
      const { data: latest } = await store.load();
      const target = latest.posts.find((p) => p.id === post.id);
      target.variants[0].body = "Pickup is free across the Bay Area. Old routers too.";
      await browserWrite(db, "post", post.id, target);
    };
    await tick(options(browser));
    assert.equal(browser.calls.submit, 0);
    assert.equal((await store.load()).journal.pausedReason, "");
    assert.equal((await tick(options(browser))).state, "succeeded");
    assert.match(variantIn((await store.load()).data, variant.id).publishedBody, /Old routers too/);
  } finally { await db.close(); }
});

test("a claim that loses to a browser save waits quietly for the next minute", async () => {
  const data = workspace();
  addPost(data, "facebook");
  const { db, store, alerts, options } = await runner(data);
  try {
    const load = store.load.bind(store);
    let raced = false;
    store.load = async () => {
      const result = await load();
      if (!raced) { raced = true; await browserWrite(db, "activity", "act_browser", { id: "act_browser", type: "note", message: "browser", at: NOW }); }
      return result;
    };
    const result = await tick(options(fakeBrowser()));
    assert.equal(result.state, "updated", JSON.stringify(result));
    assert.equal(alerts.length, 0);
  } finally { await db.close(); }
});

test("a runner that died while preparing does not stall that item forever", async () => {
  const data = workspace();
  const { variant } = addPost(data, "facebook");
  const { db, store, options } = await runner(data);
  try {
    // A claim with no finish: the process was killed during preparation.
    const { data: loaded } = await store.load();
    await store.command("claim", { id: "dead", owner: "dead", operationId: `${variant.id}:create:0`, platform: "facebook", snapshot: { itemId: variant.id } }, loaded.revision);
    await db.exec(`update sc.publisher_journal set state=jsonb_set(state,'{attempts,0,leaseUntil}','"2020-01-01T00:00:00Z"')`);
    const browser = fakeBrowser();
    assert.equal((await tick(options(browser))).state, "succeeded");
    assert.equal(browser.calls.submit, 1);
    assert.equal((await store.load()).journal.attempts[0].phase, "abandoned");
  } finally { await db.close(); }
});

test("if a person settles an attempt while the runner is still posting, the runner stops instead of posting again", async () => {
  const data = workspace();
  addPost(data, "facebook");
  const { db, store, options } = await runner(data);
  try {
    const browser = fakeBrowser();
    const submit = browser.submit;
    browser.submit = async (snapshot) => {
      const url = await submit(snapshot);
      // Someone records "not published" from the website mid-send, bypassing the UI's warnings.
      await db.exec(`update sc.publisher_journal set state=jsonb_set(state,'{attempts,0}',(state->'attempts'->0)||'{"phase":"resolved","resolution":"not-published"}')`);
      return url;
    };
    assert.equal((await tick(options(browser))).state, "uncertain");
    const { journal } = await store.load();
    assert.notEqual(journal.pausedReason, "", "posting must actually stop");
    for (let i = 0; i < 2; i++) await tick(options(browser));
    assert.equal(browser.calls.submit, 1, "never a second post");
  } finally { await db.close(); }
});
