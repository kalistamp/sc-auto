import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tick, snapshotFor, historyFor } from "../publisher/engine.js";
import { validateRecipe, assertPermalink } from "../publisher/browser.js";
import { workspaceChanges } from "../publisher/store.js";
import { createDefaultData, createExternalPost, setOrganization } from "../js/data.js";
import { approvalMaterial } from "../js/automation.js";
import { buildCopyText } from "../js/platforms.js";
const NOW = "2026-09-22T19:00:00.000Z";

function fixture({ dryRun = false, fault = "" } = {}) {
  const data = createDefaultData();
  data.revision = 1; data.automation.enabled = true; data.automation.dryRun = dryRun;
  data.automation.platforms.facebook.enabled = true;
  data.automation.platforms.facebook.destination = "https://www.facebook.com/test-page";
  const post = createExternalPost({ platform: "facebook", body: "Pickup is free." });
  const variant = post.variants[0]; variant.status = "scheduled"; variant.scheduledAt = NOW;
  variant.publishedAt = ""; variant.publishedBody = ""; variant.publishedUrl = "";
  setOrganization(data.organization);
  variant.automation = { optIn: true, approval: approvalMaterial(variant, data.organization, data.automation.platforms.facebook.destination, buildCopyText(variant)) };
  data.posts.push(post);
  const journal = { attempts: [], pausedReason: "" };
  const calls = { prepare: 0, submit: 0, verify: 0, complete: 0, alerts: [] };
  const store = {
    async load() { return structuredClone({ data, journal }); },
    async review(item, reasons) { variant.automation.reviewReasons = reasons; },
    async defer() { variant.scheduledAt = "2026-09-23T19:00:00Z"; },
    async command(command, payload, revision) {
      if (["claim", "begin"].includes(command) && revision !== data.revision) throw new Error("SC_REVISION_CONFLICT");
      if (command === "claim") {
        if (journal.attempts.some((a) => ["claimed", "submitting", "verifying", "uncertain"].includes(a.phase))) throw new Error("Publication already in flight");
        journal.attempts.push({ ...payload, phase: "claimed", leaseUntil: "2026-09-22T19:05:00Z" });
      } else {
        const a = journal.attempts.find((a) => a.id === payload.id);
        if (command === "begin") { a.phase = "submitting"; if (fault === "begin") throw new Error("Lost begin response"); }
        if (command === "submitted") { a.phase = "verifying"; a.permalink = payload.permalink; }
        if (command === "finish") { a.phase = payload.phase; if (["failed", "uncertain"].includes(a.phase)) journal.pausedReason = payload.error; }
      }
    },
    async complete(attempt, evidence) { calls.complete++; if (fault === "record") throw new Error("Database unavailable"); journal.attempts.find((a) => a.id === attempt.id).phase = "succeeded"; variant.status = "published"; }
  };
  const browser = {
    async prepare() { calls.prepare++; if (fault === "edit") variant.body = "Changed after claim"; if (fault === "prepare") throw new Error("Login expired"); },
    async submit() { calls.submit++; if (fault === "submit") throw new Error("Lost response after click"); return "https://www.facebook.com/test-page/posts/123"; },
    async verify(snapshot, permalink) { calls.verify++; if (fault === "verify") throw new Error("Not publicly visible"); return { permalink, account: "Page", verifiedAt: NOW }; },
    async close() {}
  };
  return { data, variant, journal, calls, options: { store, browser, alert: async (message) => calls.alerts.push(message), now: () => NOW, live: true, sleep: async () => {} } };
}

test("dry-run makes zero browser calls and does not duplicate its audit decision", async () => {
  const f = fixture({ dryRun: true });
  assert.equal((await tick(f.options)).state, "dry-run");
  assert.equal((await tick(f.options)).state, "idle");
  assert.equal(f.journal.attempts.length, 1); assert.equal(f.calls.prepare + f.calls.submit + f.calls.verify, 0);
});
test("host live flag is required independently of workspace dry-run setting", async () => {
  const f = fixture(); assert.equal((await tick({ ...f.options, live: false })).state, "dry-run"); assert.equal(f.calls.submit, 0);
});
test("verified send records once and cannot be redispatched", async () => {
  const f = fixture(); assert.equal((await tick(f.options)).state, "succeeded");
  await tick(f.options); assert.equal(f.calls.submit, 1); assert.equal(f.calls.complete, 1);
});
for (const fault of ["begin", "submit", "verify", "record"]) test(`${fault} ambiguity blocks restart without another submission`, async () => {
  const f = fixture({ fault });
  assert.equal((await tick(f.options)).state, "uncertain");
  assert.equal((await tick(f.options)).state, "uncertain");
  assert.equal(f.calls.submit, fault === "begin" ? 0 : 1);
  assert.ok(f.calls.alerts.length);
});
for (const [fault, state] of [["prepare", "failed"], ["edit", "updated"]]) test(`${fault} failure before submit cannot publish`, async () => {
  // A browser failure pauses posting; an edit mid-preparation is simply retried next tick.
  const f = fixture({ fault }); assert.equal((await tick(f.options)).state, state); assert.equal(f.calls.submit, 0);
  assert.equal(f.journal.pausedReason ? "paused" : "running", fault === "prepare" ? "paused" : "running");
});
test("two runners race a claim; only one can submit", async () => {
  const f = fixture(); await Promise.allSettled([tick(f.options), tick(f.options)]); assert.equal(f.calls.submit, 1);
});
test("draft scheduled without opt-in never dispatches and invalid date never dispatches", async () => {
  const f = fixture(); f.variant.automation.optIn = false; await tick(f.options); assert.equal(f.calls.submit, 0);
  f.variant.automation.optIn = true; f.variant.scheduledAt = "nonsense"; await tick(f.options); assert.equal(f.calls.submit, 0);
});
test("publication history counts all native renewals, but not duplicate mirrored post records", () => {
  const f = fixture(); f.variant.publishedAt = NOW;
  const attempts = [0, 1].map((i) => ({ id: String(i), phase: "succeeded", platform: "facebook", finishedAt: NOW, snapshot: { itemId: f.variant.id } }));
  assert.equal(historyFor(f.data, { attempts }).length, 2);
});
test("runner deltas preserve unrelated workspace rows and include automation metadata", () => {
  const before = createDefaultData(), after = structuredClone(before); after.automation.dryRun = false;
  const changes = workspaceChanges(before, after); assert.equal(changes.length, 1); assert.equal(changes[0].entity_type, "meta");
});
test("browser recipes reject API URLs, off-platform links and uncalibrated flows", () => {
  assert.throws(() => validateRecipe("facebook", {}));
  assert.throws(() => assertPermalink("https://evil.test/posts/123", "facebook", {}));
  assert.throws(() => assertPermalink("https://www.facebook.com/login", "facebook", {}));
  assert.equal(assertPermalink("https://www.reddit.com/r/test/comments/123/post", "reddit", {}), "https://www.reddit.com/r/test/comments/123/post");
});
test("a failed alert delivery is logged and never stops the runner", async () => {
  const { createAlerter } = await import("../publisher/cli.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "sc-alert-"));
  try {
    const recorded = [];
    const store = { async alert(message) { recorded.push(message); throw new Error("Supabase unreachable"); } };
    let now = 0;
    const alert = createAlerter({ root, store, webhook: "https://hooks.example.test/x", log: () => {}, clock: () => now,
      fetchImpl: async () => { throw new Error("DNS failure"); } });
    await alert("Login expired Bearer abc.def");
    await alert("Login expired Bearer abc.def");
    assert.deepEqual(recorded, ["Login expired Bearer [redacted]"], "the same notice is not repeated at once");
    now += 7 * 3600000;
    await alert("Login expired Bearer abc.def");
    assert.equal(recorded.length, 2, "a notice still true hours later is sent again");
    const log = await readFile(path.join(root, "failures.log"), "utf8");
    assert.match(log, /not delivered: DNS failure/);
    assert.match(log, /website could not be told/);
    assert.doesNotMatch(log, /abc\.def/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a lock left by a dead runner is taken over; a live runner's lock is respected", async () => {
  const { acquireLock } = await import("../publisher/cli.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "sc-lock-"));
  const lockPath = path.join(root, "runner.lock");
  try {
    await writeFile(lockPath, "999999");
    const release = await acquireLock(lockPath, { isRunning: () => false });
    assert.equal(await readFile(lockPath, "utf8"), String(process.pid));
    await release();
    await writeFile(lockPath, "4242");
    await assert.rejects(() => acquireLock(lockPath, { isRunning: (pid) => pid === 4242 }), /process 4242/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failure before submission can be retried; a possible submission never can", async () => {
  const { retryable } = await import("../publisher/engine.js");
  for (const phase of ["failed", "abandoned", "dry-run"]) assert.equal(retryable({ phase }), true, phase);
  assert.equal(retryable({ phase: "resolved", resolution: "not-published" }), true);
  for (const phase of ["claimed", "submitting", "verifying", "uncertain", "succeeded"]) assert.equal(retryable({ phase }), false, phase);
  assert.equal(retryable({ phase: "resolved", resolution: "published-externally" }), false);
  // A claim whose runner died while preparing never reached the barrier.
  assert.equal(retryable({ phase: "claimed", leaseUntil: "2020-01-01T00:00:00Z" }, Date.parse("2026-01-01T00:00:00Z")), true);
  assert.equal(retryable({ phase: "claimed", leaseUntil: "2026-01-01T00:05:00Z" }, Date.parse("2026-01-01T00:00:00Z")), false);
});

test("a step that may have posted during preparation stops everything and is never retried", async () => {
  const f = fixture();
  f.options.browser.prepare = async () => { throw Object.assign(new Error("Navigated to a post during preparation."), { possibleSubmission: true }); };
  assert.equal((await tick(f.options)).state, "uncertain");
  assert.equal((await tick(f.options)).state, "uncertain");
  assert.ok(f.journal.pausedReason);
});

test("recipes may not reach the Publish button through another locator for it", () => {
  const recipe = { account: "A", accountLocator: { css: "#a" }, calibratedAt: "2026-09-22", startUrl: "https://www.facebook.com/p",
    samplePermalink: "https://www.facebook.com/p/posts/1", submit: { role: "button", name: "Post" },
    verify: { body: { css: "#b" }, account: { css: "#c" } },
    steps: [{ action: "fill", field: "body", locator: { label: "Text" } }] };
  assert.equal(validateRecipe("facebook", recipe), recipe);
  assert.throws(() => validateRecipe("facebook", { ...recipe, steps: [...recipe.steps, { action: "click", locator: { name: "post", role: "button" } }] }), /submit/i);
});

test("generation that keeps failing waits an hour before calling the model again", async () => {
  const { backoff } = await import("../publisher/cli.js");
  let now = 0, calls = 0;
  const run = backoff(3600000, () => now);
  await assert.rejects(() => run(async () => { calls++; throw new Error("save failed"); }));
  assert.equal(await run(async () => { calls++; return true; }), false);
  now += 3600001;
  assert.equal(await run(async () => { calls++; return true; }), true);
  assert.equal(calls, 2);
});

test("the runner writes with the model chosen in Studio, falling back to its own configuration", async () => {
  const { runnerCredentials } = await import("../publisher/cli.js");
  const shared = { command: async () => ({ provider: "mistral", model: "mistral-large-latest", key: "k1", effort: "" }) };
  assert.deepEqual(await runnerCredentials(shared, {}), { provider: "mistral", keys: { mistral: "k1" }, models: { mistral: "mistral-large-latest" }, effort: "" });
  const none = { command: async () => ({}) };
  assert.deepEqual(await runnerCredentials(none, { provider: "openai", model: "" }, { SC_MODEL_KEY: "k2" }),
    { provider: "openai", keys: { openai: "k2" }, models: { openai: "" }, effort: "" });
  const offline = { command: async () => { throw new Error("no journal"); } };
  assert.equal((await runnerCredentials(offline, {}, {})).provider, "anthropic");
});
