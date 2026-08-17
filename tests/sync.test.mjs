import test from "node:test";
import assert from "node:assert/strict";

/* localStorage has to exist before settings.js or sync.js is imported,
   because a Workspace reads credentials in its constructor. */
function storage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear()
  };
}
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();

const { PROVIDERS, extractGistId, fingerprint, readCredentials, writeCredentials, clearCredentials,
        readPrefs, writePrefs, session, readLocalWorkspace } = await import("../js/settings.js");
const { Workspace, SyncError } = await import("../js/sync.js");
const { createDefaultData } = await import("../js/data.js");
/* The workspace filename lives in exactly one place — config.js. Fixtures
   read it from there rather than hardcoding a string, so renaming the file
   can never leave the tests asserting against a name the app no longer uses. */
const { GIST_FILENAME } = await import("../js/config.js");

function reset() {
  localStorage.clear();
  sessionStorage.clear();
}

/* ------------------------------------------------------------
   SETTINGS
   ------------------------------------------------------------ */

test("a gist id is pulled out of whatever the user pasted", () => {
  assert.equal(extractGistId("abc123"), "abc123");
  assert.equal(extractGistId("https://gist.github.com/someone/abc123"), "abc123");
  assert.equal(extractGistId("https://gist.github.com/someone/abc123/"), "abc123");
  assert.equal(extractGistId("https://gist.github.com/someone/abc123#file-data-json"), "abc123");
  assert.equal(extractGistId("  abc123  "), "abc123");
  assert.equal(extractGistId(""), "");
});

test("a token is only ever shown as a fingerprint", () => {
  const token = "github_pat_11ABCDEFG_secretsecretsecret";
  const shown = fingerprint(token);
  assert.ok(!shown.includes("secretsecret"), "the secret half must never be rendered");
  assert.match(shown, /…/);
  assert.equal(fingerprint(""), "—");
  assert.equal(fingerprint("short"), "set");
});

test("credentials round-trip with sane defaults and per-provider isolation", () => {
  reset();
  const fresh = readCredentials();
  assert.equal(fresh.provider, "anthropic");
  assert.equal(fresh.models.anthropic, PROVIDERS.anthropic.defaultModel);
  assert.equal(fresh.effort, "");

  writeCredentials({ provider: "openai", keys: { ...fresh.keys, openai: "sk-a" }, models: { ...fresh.models, openai: "gpt-x" } });
  writeCredentials({ keys: { ...readCredentials().keys, anthropic: "sk-ant-b" } });

  const saved = readCredentials();
  assert.equal(saved.provider, "openai", "switching providers must not drop the others");
  assert.equal(saved.keys.openai, "sk-a");
  assert.equal(saved.keys.anthropic, "sk-ant-b");
  assert.equal(saved.models.openai, "gpt-x");

  clearCredentials();
  assert.equal(readCredentials().keys.openai, "");
});

test("an unknown provider or effort value falls back instead of breaking the app", () => {
  reset();
  localStorage.setItem("sct.credentials.v1", JSON.stringify({ provider: "wat", effort: "extreme" }));
  const credentials = readCredentials();
  assert.equal(credentials.provider, "anthropic");
  assert.equal(credentials.effort, "");
});

test("preferences persist and the session latch is per-tab", () => {
  reset();
  assert.equal(readPrefs().theme, "system");
  writePrefs({ theme: "dark", libraryLayout: "list" });
  assert.equal(readPrefs().theme, "dark");
  assert.equal(readPrefs().libraryLayout, "list");

  assert.equal(session.unlocked, false);
  session.unlock();
  assert.equal(session.unlocked, true);
  session.lock();
  assert.equal(session.unlocked, false);
});

/* ------------------------------------------------------------
   WORKSPACE — LOCAL MODE
   ------------------------------------------------------------ */

test("with no gist connected everything stays on the device", async () => {
  reset();
  const workspace = new Workspace();
  assert.equal(workspace.connected, false);
  assert.equal(workspace.status, "local");

  const { data, from } = await workspace.load();
  assert.equal(from, "new");

  workspace.bind(() => data);
  data.posts.push({ id: "p1", campaign: "c", variants: [], ai: {}, tags: [] });
  workspace.touch();
  assert.equal(workspace.status, "dirty");

  await workspace.flush();
  assert.equal(data.revision, 1, "a local save still bumps the revision, so a later gist connect can compare");
  assert.equal(readLocalWorkspace().posts.length, 1);

  const second = new Workspace();
  const reloaded = await second.load();
  assert.equal(reloaded.from, "device");
  assert.equal(reloaded.data.posts.length, 1);
});

test("a workspace that fails validation is refused rather than written", async () => {
  reset();
  const workspace = new Workspace();
  const { data } = await workspace.load();
  data.posts = "not an array";
  workspace.bind(() => data);
  workspace.touch();
  await workspace.flush();
  assert.equal(workspace.status, "error");
  assert.match(workspace.lastError.message, /failed validation/i);
});

/* ------------------------------------------------------------
   WORKSPACE — GIST MODE
   ------------------------------------------------------------ */

function connectGist() {
  reset();
  writeCredentials({ githubToken: "test-token", gistId: "test-gist" });
  return new Workspace();
}

function gistServer(initial) {
  const store = { data: initial, revision: initial.revision };
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ url, method, body: options.body ? JSON.parse(options.body) : null });
    if (method === "PATCH") {
      store.data = JSON.parse(JSON.parse(options.body).files[GIST_FILENAME].content);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({
      history: [{ version: "sha1", committed_at: "2026-01-01T00:00:00Z", change_status: { additions: 3, deletions: 1 } }],
      files: { [GIST_FILENAME]: { content: JSON.stringify(store.data) } }
    }), { status: 200 });
  };
  return { store, calls };
}

test("gist mode: load, then a save that checks the revision before writing", async () => {
  const workspace = connectGist();
  const remote = createDefaultData();
  remote.revision = 4;
  const { calls, store } = gistServer(remote);

  const { data, from } = await workspace.load();
  assert.equal(from, "gist");
  assert.equal(workspace.baseRevision, 4);
  assert.equal(workspace.revisions()[0].sha, "sha1");

  workspace.bind(() => data);
  data.posts.push({ id: "p", campaign: "c", variants: [], ai: {}, tags: [] });
  workspace.touch();
  await workspace.flush();

  const patch = calls.find((call) => call.method === "PATCH");
  assert.ok(patch, "a save must reach GitHub");
  assert.equal(patch.url, "https://api.github.com/gists/test-gist");
  assert.equal(JSON.parse(patch.body.files[GIST_FILENAME].content).revision, 5);
  assert.equal(store.data.revision, 5);
  assert.equal(workspace.baseRevision, 5);
  assert.equal(workspace.status, "synced");

  /* Read-before-write: exactly one extra GET per save burst. */
  assert.equal(calls.filter((call) => call.method === "GET").length, 2);
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
});

test("a burst of edits coalesces into one write", async () => {
  const workspace = connectGist();
  const { calls } = gistServer(createDefaultData());
  const { data } = await workspace.load();
  workspace.bind(() => data);

  workspace.touch();
  workspace.touch();
  workspace.touch();
  await workspace.flush();

  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
});

test("a gist that moved under us produces a conflict, never a silent overwrite", async () => {
  const workspace = connectGist();
  const remote = createDefaultData();
  remote.revision = 2;
  const { calls, store } = gistServer(remote);

  const { data } = await workspace.load();
  workspace.bind(() => data);

  /* Another device saves while this one has local edits. */
  store.data = { ...createDefaultData(), revision: 9, posts: [{ id: "theirs", campaign: "Theirs", variants: [], ai: {}, tags: [] }] };

  data.posts.push({ id: "mine", campaign: "Mine", variants: [], ai: {}, tags: [] });
  workspace.touch();
  await workspace.flush();

  assert.equal(workspace.status, "conflict");
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0, "nothing may be written while a conflict is unresolved");
  assert.equal(workspace.conflict.remote.posts[0].id, "theirs");

  const theirs = await workspace.resolveConflict("theirs");
  assert.equal(theirs.posts[0].id, "theirs");
  assert.equal(workspace.baseRevision, 9);
  assert.equal(workspace.dirty, false);
});

test("keeping your own version re-bases it on the remote revision and writes", async () => {
  const workspace = connectGist();
  const remote = createDefaultData();
  remote.revision = 2;
  const { calls, store } = gistServer(remote);

  const { data } = await workspace.load();
  workspace.bind(() => data);
  store.data = { ...createDefaultData(), revision: 6 };

  data.posts.push({ id: "mine", campaign: "Mine", variants: [], ai: {}, tags: [] });
  workspace.touch();
  await workspace.flush();
  assert.equal(workspace.status, "conflict");

  await workspace.resolveConflict("mine");
  const patch = calls.filter((call) => call.method === "PATCH").at(-1);
  const written = JSON.parse(patch.body.files[GIST_FILENAME].content);
  assert.equal(written.revision, 7, "the write is stacked on top of the remote revision");
  assert.equal(written.posts[0].id, "mine");
});

test("GitHub's unhelpful statuses become instructions", async () => {
  const workspace = connectGist();
  for (const [status, pattern] of [[401, /rejected the token/i], [403, /Read and write/i], [404, /No gist found/i]]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ message: "Resource not accessible" }), { status });
    await assert.rejects(() => workspace.load(), (error) => error instanceof SyncError && pattern.test(error.message));
  }
});

test("a gist without the workspace file says which file is missing", async () => {
  const workspace = connectGist();
  globalThis.fetch = async () => new Response(JSON.stringify({ files: { "notes.txt": { content: "hi" } } }), { status: 200 });
  await assert.rejects(() => workspace.load(), (error) => error.message.includes(GIST_FILENAME));
});

/* ------------------------------------------------------------
   STORAGE QUOTA

   A browser refusing the localStorage write used to be swallowed, so a
   workspace could stop being saved while the UI still said "Saved".
   What it means depends entirely on whether a gist is connected.
   ------------------------------------------------------------ */

/* Make every workspace write throw the way a full origin does. */
function fillStorage() {
  const real = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === "sct.workspace.v2") {
      const error = new Error("QuotaExceededError");
      error.name = "QuotaExceededError";
      throw error;
    }
    return real(key, value);
  };
  return () => { localStorage.setItem = real; };
}

test("with no gist, a storage-quota failure is reported instead of losing the edit", async () => {
  reset();
  const workspace = new Workspace();
  const { data } = await workspace.load();
  workspace.bind(() => data);

  const restore = fillStorage();
  try {
    data.posts.push({ id: "p1", campaign: "c", variants: [], ai: {}, tags: [] });
    workspace.touch();
    await workspace.flush();
  } finally { restore(); }

  assert.equal(workspace.status, "error", "a failed save must not report success");
  assert.match(workspace.lastError.message, /out of storage/i);
  assert.equal(workspace.dirty, true, "the change is still unsaved and must be retried");
});

test("with a gist, a storage-quota failure still saves remotely and only flags the stale cache", async () => {
  const workspace = connectGist();
  const { store } = gistServer(createDefaultData());
  const { data } = await workspace.load();
  workspace.bind(() => data);

  const restore = fillStorage();
  try {
    data.posts.push({ id: "p1", campaign: "c", variants: [], ai: {}, tags: [] });
    workspace.touch();
    await workspace.flush();
  } finally { restore(); }

  assert.equal(workspace.status, "synced", "the gist write succeeded, so this is not a failed save");
  assert.equal(store.data.posts.length, 1, "the post reached the gist");
  assert.equal(workspace.cacheStale, true, "but the offline copy is behind, and the app must be able to say so");
});

test("an earlier revision can be read back for restore", async () => {
  const workspace = connectGist();
  const old = createDefaultData();
  old.revision = 1;
  old.posts = [{ id: "old", campaign: "Old", variants: [], ai: {}, tags: [] }];
  globalThis.fetch = async (url) => {
    assert.match(url, /\/gists\/test-gist\/sha1$/);
    return new Response(JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(old) } } }), { status: 200 });
  };
  const restored = await workspace.atRevision("sha1");
  assert.equal(restored.posts[0].id, "old");
});
