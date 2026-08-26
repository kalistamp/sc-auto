import test from "node:test";
import assert from "node:assert/strict";

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

const {
  PROVIDERS, fingerprint, readCredentials, writeCredentials, clearCredentials,
  readPrefs, writePrefs, readLocalWorkspace
} = await import("../js/settings.js");
const {
  getCurrentUser, setSupabaseClientForTests, signInWithPassword, signOutUser,
  Workspace, SyncError
} = await import("../js/sync.js");
const { createDefaultData } = await import("../js/data.js");

const USER = { id: "00000000-0000-4000-8000-000000000001", email: "owner@example.com" };

function supabaseServer(initial = null) {
  const store = {
    row: initial ? { data: structuredClone(initial), revision: Number(initial.revision || 1), updated_at: initial.updatedAt } : null,
    history: initial ? [{ data: structuredClone(initial), revision: Number(initial.revision || 1), created_at: initial.updatedAt }] : [],
    rpcCalls: [],
    schemaError: null,
    signedOut: false
  };

  function table(name) {
    const filters = {};
    const builder = {
      select() { return builder; },
      eq(key, value) { filters[key] = value; return builder; },
      order() { return builder; },
      async limit(count) {
        if (store.schemaError) return { data: null, error: store.schemaError };
        if (name !== "workspace_history") return { data: [], error: null };
        const data = [...store.history]
          .sort((a, b) => b.revision - a.revision)
          .slice(0, count)
          .map(({ revision, created_at }) => ({ revision, created_at }));
        return { data, error: null };
      },
      async maybeSingle() {
        if (store.schemaError) return { data: null, error: store.schemaError };
        if (name === "workspace_data") return { data: store.row ? structuredClone(store.row) : null, error: null };
        const found = store.history.find((entry) => Number(entry.revision) === Number(filters.revision));
        return { data: found ? structuredClone(found) : null, error: null };
      }
    };
    return builder;
  }

  const api = {
    auth: {
      async getSession() { return { data: { session: { user: USER } }, error: null }; },
      async getUser() { return { data: { user: USER }, error: null }; },
      async signInWithPassword({ email, password }) {
        return email === USER.email && password === "correct"
          ? { data: { user: USER }, error: null }
          : { data: {}, error: { message: "Invalid login credentials", status: 400 } };
      },
      async signOut() { store.signedOut = true; return { error: null }; }
    },
    schema(name) {
      assert.equal(name, "sc");
      return {
        from: table,
        async rpc(name, args) {
          assert.equal(name, "save_workspace");
          store.rpcCalls.push(structuredClone(args));
          const actual = Number(store.row?.revision || 0);
          if (actual !== Number(args.expected_revision)) {
            return { data: null, error: { code: "40001", message: "SC_VERSION_CONFLICT" } };
          }
          const revision = actual + 1;
          const saved = structuredClone(args.new_data);
          saved.revision = revision;
          store.row = { data: saved, revision, updated_at: saved.updatedAt };
          store.history.push({ data: saved, revision, created_at: saved.updatedAt });
          return { data: revision, error: null };
        }
      };
    }
  };

  return { api, store };
}

function reset() { localStorage.clear(); }

function connectedWorkspace(server) {
  setSupabaseClientForTests(server.api);
  const workspace = new Workspace();
  workspace.setUser(USER);
  return workspace;
}

test("model credentials round-trip without legacy Gist fields", () => {
  reset();
  localStorage.setItem("sct.credentials.v1", JSON.stringify({ githubToken: "old-token", gistId: "old-gist" }));
  const fresh = readCredentials();
  assert.equal(fresh.provider, "anthropic");
  assert.equal(fresh.models.anthropic, PROVIDERS.anthropic.defaultModel);
  assert.equal("githubToken" in fresh, false);
  assert.equal("gistId" in fresh, false);
  assert.doesNotMatch(localStorage.getItem("sct.credentials.v1"), /old-token|old-gist/);

  writeCredentials({
    provider: "openai",
    keys: { ...fresh.keys, openai: "sk-a" },
    models: { ...fresh.models, openai: "gpt-x" }
  });
  assert.equal(readCredentials().keys.openai, "sk-a");
  assert.equal(readCredentials().models.openai, "gpt-x");
  clearCredentials();
  assert.equal(readCredentials().keys.openai, "");
});

test("tokens are fingerprinted and preferences remain device-local", () => {
  reset();
  assert.equal(fingerprint("short"), "set");
  assert.match(fingerprint("a-very-long-provider-secret"), /…/);
  writePrefs({ theme: "dark", libraryLayout: "list" });
  assert.equal(readPrefs().theme, "dark");
  assert.equal(readPrefs().libraryLayout, "list");
});

test("Supabase Auth validates sessions, signs in, and signs out", async () => {
  const server = supabaseServer();
  setSupabaseClientForTests(server.api);
  assert.equal((await getCurrentUser()).id, USER.id);
  assert.equal((await signInWithPassword(USER.email, "correct")).email, USER.email);
  await assert.rejects(() => signInWithPassword(USER.email, "wrong"), /Invalid login credentials/);
  await signOutUser();
  assert.equal(server.store.signedOut, true);
});

test("an unauthenticated workspace fails closed before reading local cache", async () => {
  reset();
  localStorage.setItem("sct.workspace.v2", JSON.stringify({ posts: [{ id: "private" }] }));
  const workspace = new Workspace();
  assert.equal(workspace.status, "locked");
  await assert.rejects(() => workspace.load(), /Sign in/);
});

test("workspace loads the authenticated user's JSON and history", async () => {
  reset();
  const initial = createDefaultData();
  initial.revision = 26;
  initial.posts.push({ id: "p1", campaign: "Campaign", variants: [], ai: {}, tags: [] });
  const server = supabaseServer(initial);
  const workspace = connectedWorkspace(server);

  const { data, from } = await workspace.load();
  assert.equal(from, "supabase");
  assert.equal(data.revision, 26);
  assert.equal(data.posts[0].id, "p1");
  assert.equal(workspace.revisions()[0].sha, "26");
  assert.equal(readLocalWorkspace().posts[0].id, "p1");
});

test("a validated edit saves through the version-checked RPC", async () => {
  reset();
  const initial = createDefaultData();
  initial.revision = 4;
  const server = supabaseServer(initial);
  const workspace = connectedWorkspace(server);
  const { data } = await workspace.load();
  workspace.bind(() => data);

  data.posts.push({ id: "p", campaign: "c", variants: [], ai: {}, tags: [] });
  workspace.touch();
  await workspace.flush();

  assert.equal(server.store.rpcCalls.length, 1);
  assert.equal(server.store.rpcCalls[0].expected_revision, 4);
  assert.equal(server.store.row.revision, 5);
  assert.equal(data.revision, 5);
  assert.equal(workspace.status, "synced");
});

test("invalid workspace data is refused before any RPC", async () => {
  const server = supabaseServer(createDefaultData());
  const workspace = connectedWorkspace(server);
  const { data } = await workspace.load();
  data.posts = "not an array";
  workspace.bind(() => data);
  workspace.touch();
  await workspace.flush();
  assert.equal(workspace.status, "error");
  assert.equal(server.store.rpcCalls.length, 0);
});

test("a concurrent save becomes a conflict and never overwrites silently", async () => {
  const initial = createDefaultData();
  initial.revision = 2;
  const server = supabaseServer(initial);
  const workspace = connectedWorkspace(server);
  const { data } = await workspace.load();
  workspace.bind(() => data);

  const theirs = createDefaultData();
  theirs.revision = 9;
  theirs.posts = [{ id: "theirs", campaign: "Theirs", variants: [], ai: {}, tags: [] }];
  server.store.row = { data: theirs, revision: 9, updated_at: theirs.updatedAt };

  data.posts.push({ id: "mine", campaign: "Mine", variants: [], ai: {}, tags: [] });
  workspace.touch();
  await workspace.flush();
  assert.equal(workspace.status, "conflict");
  assert.equal(workspace.conflict.remote.posts[0].id, "theirs");

  const adopted = await workspace.resolveConflict("theirs");
  assert.equal(adopted.posts[0].id, "theirs");
  assert.equal(workspace.baseRevision, 9);
});

test("keeping local work rebases it on the remote revision", async () => {
  const initial = createDefaultData();
  initial.revision = 2;
  const server = supabaseServer(initial);
  const workspace = connectedWorkspace(server);
  const { data } = await workspace.load();
  workspace.bind(() => data);

  const theirs = createDefaultData();
  theirs.revision = 6;
  server.store.row = { data: theirs, revision: 6, updated_at: theirs.updatedAt };
  data.posts.push({ id: "mine", campaign: "Mine", variants: [], ai: {}, tags: [] });
  workspace.touch();
  await workspace.flush();
  await workspace.resolveConflict("mine");

  assert.equal(server.store.row.revision, 7);
  assert.equal(server.store.row.data.posts[0].id, "mine");
});

test("version history can restore an earlier Supabase snapshot", async () => {
  const initial = createDefaultData();
  initial.revision = 3;
  initial.posts = [{ id: "old", campaign: "Old", variants: [], ai: {}, tags: [] }];
  const server = supabaseServer(initial);
  const workspace = connectedWorkspace(server);
  const restored = await workspace.atRevision("3");
  assert.equal(restored.posts[0].id, "old");
  assert.equal(restored.revision, 3);
});

test("a missing Data API schema produces the exact dashboard instruction", async () => {
  const server = supabaseServer();
  server.store.schemaError = { code: "PGRST106", message: "Invalid schema" };
  const workspace = connectedWorkspace(server);
  await assert.rejects(
    () => workspace.load(),
    (error) => error instanceof SyncError && /Data API/.test(error.message) && /Exposed schemas/.test(error.hint)
  );
});

test("a full local cache does not turn a successful cloud save into failure", async () => {
  reset();
  const server = supabaseServer(createDefaultData());
  const workspace = connectedWorkspace(server);
  const { data } = await workspace.load();
  workspace.bind(() => data);

  const original = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === "sct.workspace.v2") throw new Error("QuotaExceededError");
    original(key, value);
  };
  try {
    data.posts.push({ id: "p1", campaign: "c", variants: [], ai: {}, tags: [] });
    workspace.touch();
    await workspace.flush();
  } finally {
    localStorage.setItem = original;
  }

  assert.equal(server.store.row.data.posts.length, 1);
  assert.equal(workspace.status, "synced");
  assert.equal(workspace.cacheStale, true);
});
