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
  readPrefs, writePrefs
} = await import("../js/settings.js");
const {
  flattenWorkspace, getCurrentUser, setSupabaseClientForTests,
  signInWithPassword, signOutUser, unflattenWorkspace, Workspace, SyncError
} = await import("../js/sync.js");
const { createDefaultData } = await import("../js/data.js");

const USER = { id: "00000000-0000-4000-8000-000000000001", email: "owner@example.com" };
const rowKey = (type, id) => `${type}|${id}`;

function supabaseServer(initial = null) {
  const store = {
    revision: Number(initial?.revision || 0),
    updatedAt: initial?.updatedAt || "",
    rows: new Map(),
    snapshots: new Map(),
    events: [],
    rpcCalls: [],
    schemaError: null,
    signedOut: false
  };

  function saveSnapshot() {
    const items = new Map([...store.rows.values()].map((row) => [
      `${row.entity_type}\u0000${row.entity_id}`, structuredClone(row.data)
    ]));
    store.snapshots.set(store.revision, unflattenWorkspace(items, store.revision, store.updatedAt));
  }

  if (initial) {
    for (const [key, data] of flattenWorkspace(initial)) {
      const at = key.indexOf("\u0000");
      const type = key.slice(0, at), id = key.slice(at + 1);
      store.rows.set(rowKey(type, id), { entity_type: type, entity_id: id, data, revision: store.revision });
    }
    store.events.push({ revision: store.revision, created_at: store.updatedAt, changed_count: store.rows.size });
    saveSnapshot();
  }

  function table(name) {
    const filters = {};
    const builder = {
      select() { return builder; },
      eq(key, value) { filters[key] = value; return builder; },
      order() { return builder; },
      async range(from, to) {
        if (store.schemaError) return { data: null, error: store.schemaError };
        if (name !== "workspace_items") return { data: [], error: null };
        return { data: [...store.rows.values()].slice(from, to + 1).map((row) => structuredClone(row)), error: null };
      },
      async limit(count) {
        if (store.schemaError) return { data: null, error: store.schemaError };
        if (name === "workspace_revision_events") {
          return { data: [...store.events].sort((a, b) => b.revision - a.revision).slice(0, count), error: null };
        }
        return { data: [], error: null };
      },
      async maybeSingle() {
        if (store.schemaError) return { data: null, error: store.schemaError };
        if (name === "workspace_sync_state") {
          return store.hasState === false
            ? { data: null, error: null }
            : { data: { revision: store.revision, updated_at: store.updatedAt }, error: null };
        }
        if (name === "workspace_history") {
          const data = store.snapshots.get(Number(filters.revision));
          return { data: data ? { data: structuredClone(data), revision: Number(filters.revision) } : null, error: null };
        }
        return { data: null, error: null };
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
        async rpc(name, args = {}) {
          if (name === "ensure_workspace_state_v2") {
            store.hasState = true;
            return { data: store.revision, error: null };
          }
          if (name === "read_workspace_revision_v2") {
            return { data: structuredClone(store.snapshots.get(Number(args.target_revision)) || null), error: null };
          }
          if (name === "read_workspace_changes_since") {
            const changes = [...store.rows.values()]
              .filter((row) => row.revision > Number(args.since_revision))
              .map((row) => ({ ...structuredClone(row), deleted: false }));
            return { data: { revision: store.revision, updated_at: store.updatedAt, changes }, error: null };
          }
          assert.equal(name, "apply_workspace_changes");
          store.rpcCalls.push(structuredClone(args));
          if (Number(args.expected_revision) !== store.revision) {
            return { data: null, error: { code: "40001", message: "SC_REVISION_CONFLICT" } };
          }
          store.revision += 1;
          store.updatedAt = new Date().toISOString();
          for (const change of args.changes) {
            const key = rowKey(change.entity_type, change.entity_id);
            if (change.action === "delete") store.rows.delete(key);
            else store.rows.set(key, {
              entity_type: change.entity_type, entity_id: change.entity_id,
              data: structuredClone(change.data), revision: store.revision
            });
          }
          store.events.push({ revision: store.revision, created_at: store.updatedAt, changed_count: args.changes.length });
          saveSnapshot();
          return { data: store.revision, error: null };
        }
      };
    }
  };

  return { api, store };
}

function reset() { localStorage.clear(); }
function connectedWorkspace(server) {
  localStorage.removeItem("sct.workspace.v2");
  localStorage.removeItem("sct.workspace.dirty.v3");
  setSupabaseClientForTests(server.api);
  const workspace = new Workspace();
  workspace.setUser(USER);
  return workspace;
}

test("model credentials remain device-local without legacy Gist fields", () => {
  reset();
  localStorage.setItem("sct.credentials.v1", JSON.stringify({ githubToken: "old-token", gistId: "old-gist" }));
  const fresh = readCredentials();
  assert.equal(fresh.provider, "anthropic");
  assert.equal(fresh.models.anthropic, PROVIDERS.anthropic.defaultModel);
  assert.equal("githubToken" in fresh, false);
  assert.equal("gistId" in fresh, false);
  writeCredentials({ provider: "openai", keys: { ...fresh.keys, openai: "sk-a" } });
  assert.equal(readCredentials().keys.openai, "sk-a");
  clearCredentials();
  assert.equal(readCredentials().keys.openai, "");
});

test("tokens are fingerprinted and preferences remain device-local", () => {
  reset();
  assert.equal(fingerprint("short"), "set");
  assert.match(fingerprint("a-very-long-provider-secret"), /…/);
  writePrefs({ theme: "dark", libraryLayout: "list" });
  assert.equal(readPrefs().theme, "dark");
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

test("an unauthenticated workspace fails closed before reading legacy cache", async () => {
  reset();
  localStorage.setItem("sct.workspace.v2", JSON.stringify({ posts: [{ id: "private" }] }));
  const workspace = new Workspace();
  await assert.rejects(() => workspace.load(), /Sign in/);
});

test("row entities round-trip into a complete workspace", () => {
  const data = createDefaultData();
  data.posts.push({ id: "p1", campaign: "Campaign", variants: [], ai: {}, tags: [] });
  const restored = unflattenWorkspace(flattenWorkspace(data), 26, data.updatedAt);
  assert.equal(restored.revision, 26);
  assert.equal(restored.posts[0].id, "p1");
});

test("workspace loads authenticated row entities and revision history", async () => {
  const initial = createDefaultData();
  initial.revision = 26;
  initial.posts.push({ id: "p1", campaign: "Campaign", variants: [], ai: {}, tags: [] });
  const workspace = connectedWorkspace(supabaseServer(initial));
  const { data, from } = await workspace.load();
  assert.equal(from, "supabase");
  assert.equal(data.posts[0].id, "p1");
  assert.equal(workspace.revisions()[0].sha, "26");
});

test("a hot edit sends only the changed post through the conditional RPC", async () => {
  const initial = createDefaultData();
  initial.revision = 4;
  initial.posts.push({ id: "p", campaign: "Before", variants: [], ai: {}, tags: [] });
  const server = supabaseServer(initial);
  const workspace = connectedWorkspace(server);
  const { data } = await workspace.load();
  workspace.bind(() => data);
  data.posts[0].campaign = "After";
  workspace.touchItem("post", data.posts[0]);
  await workspace.flush();
  assert.equal(server.store.rpcCalls.length, 1);
  assert.equal(server.store.rpcCalls[0].expected_revision, 4);
  assert.deepEqual(server.store.rpcCalls[0].changes.map((item) => item.entity_type), ["post"]);
  assert.equal(data.revision, 5);
});

test("structural changes emit explicit row deltas rather than a full document", async () => {
  const initial = createDefaultData();
  initial.revision = 2;
  const server = supabaseServer(initial);
  const workspace = connectedWorkspace(server);
  const { data } = await workspace.load();
  workspace.bind(() => data);
  data.posts.push({ id: "new", campaign: "New", variants: [], ai: {}, tags: [] });
  workspace.touch();
  await workspace.flush();
  assert.ok(server.store.rpcCalls[0].changes.some((item) => item.entity_id === "new"));
  assert.equal("new_data" in server.store.rpcCalls[0], false);
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
  server.store.revision = 9;
  data.organization.name = "Mine";
  workspace.touch();
  await workspace.flush();
  assert.equal(workspace.status, "conflict");
  assert.equal(workspace.conflict.remote.revision, 9);
});

test("keeping local work rebases row changes on the remote revision", async () => {
  const initial = createDefaultData();
  initial.revision = 2;
  const server = supabaseServer(initial);
  const workspace = connectedWorkspace(server);
  const { data } = await workspace.load();
  workspace.bind(() => data);
  server.store.revision = 6;
  data.organization.name = "Mine";
  workspace.touch();
  await workspace.flush();
  await workspace.resolveConflict("mine");
  assert.equal(server.store.revision, 7);
});

test("version history restores a normalized row snapshot", async () => {
  const initial = createDefaultData();
  initial.revision = 3;
  initial.posts = [{ id: "old", campaign: "Old", variants: [], ai: {}, tags: [] }];
  const workspace = connectedWorkspace(supabaseServer(initial));
  const restored = await workspace.atRevision("3");
  assert.equal(restored.posts[0].id, "old");
  assert.equal(restored.revision, 3);
});

test("a missing Data API schema gives the non-destructive dashboard instruction", async () => {
  const server = supabaseServer();
  server.store.schemaError = { code: "PGRST106", message: "Invalid schema" };
  const workspace = connectedWorkspace(server);
  await assert.rejects(
    () => workspace.load(),
    (error) => error instanceof SyncError && /Data API/.test(error.message) && /without removing/.test(error.hint)
  );
});

test("hot edits never rewrite the old full-document localStorage cache", async () => {
  reset();
  const initial = createDefaultData();
  initial.posts.push({ id: "p", campaign: "Before", variants: [], ai: {}, tags: [] });
  const server = supabaseServer(initial);
  const workspace = connectedWorkspace(server);
  const { data } = await workspace.load();
  workspace.bind(() => data);
  let fullWrites = 0;
  const original = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === "sct.workspace.v2") fullWrites += 1;
    original(key, value);
  };
  try {
    data.posts[0].campaign = "After";
    workspace.touchItem("post", data.posts[0]);
    await workspace.flush();
  } finally {
    localStorage.setItem = original;
  }
  assert.equal(fullWrites, 0);
});
