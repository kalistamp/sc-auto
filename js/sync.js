/* ============================================================
   SAFE CYCLE STUDIO — authenticated, row-level Supabase sync

   The cloud store is split into independently addressable entities. A
   post edit therefore sends one post, not the complete workspace, and
   Realtime carries only a revision number. Provider keys remain outside
   this store in device-local settings.
   ============================================================ */

import {
  HISTORY_LIMIT, MAX_SAVE_WAIT_MS, SAVE_DEBOUNCE_MS,
  SUPABASE_PUBLISHABLE_KEY, SUPABASE_SCHEMA, SUPABASE_URL
} from "./config.js";
import { createDefaultData, migrateData, validateData } from "./data.js";
import { clearLegacyLocalWorkspace, readCredentials, readLocalWorkspace } from "./settings.js";

const ENTITY_TYPES = new Set(["meta", "post", "deleted", "run", "activity"]);
const META_KEY = "meta\u0000settings";
const CACHE_STORE = "items";
const CACHE_REVISION_KEY = "\u0000revision";
const CACHE_DIRTY_KEY = "sct.workspace.dirty.v3";
const PAGE_SIZE = 500;

export class SyncError extends Error {
  constructor(message, { status = 0, hint = "" } = {}) {
    super(message);
    this.name = "SyncError";
    this.status = status;
    this.hint = hint;
  }
}

let sharedClient = null;

function client() {
  if (sharedClient) return sharedClient;
  const factory = globalThis.supabase?.createClient;
  if (!factory) {
    throw new SyncError("The cloud library did not load.", {
      hint: "Check the connection and reload the page."
    });
  }
  sharedClient = factory(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  return sharedClient;
}

/* Test-only injection point. It is intentionally not used by the app. */
export function setSupabaseClientForTests(next) { sharedClient = next; }
/* The separate Node runner supplies a client with durable host-local auth. */
export function setSupabaseClient(next) { sharedClient = next; }

export async function publisherCommand(command, args = {}, expectedRevision = null, changes = []) {
  const { data, error } = await client().schema(SUPABASE_SCHEMA).rpc("publisher_command", {
    command, payload: args, expected_revision: expectedRevision, changes
  });
  if (error) throw new SyncError(error.message || "Publisher storage is unavailable.");
  return data;
}

export async function uploadAutomationImage(file) {
  const user = await getCurrentUser();
  if (!user) throw new SyncError("Sign in before uploading an image.");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024)
    throw new SyncError("Use a JPEG, PNG or WebP image smaller than 10 MB.");
  const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[file.type];
  const path = `${user.id}/${crypto.randomUUID()}.${extension}`;
  const { error } = await client().storage.from("publisher-images").upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new SyncError(error.message);
  return { path, name: file.name, type: file.type, size: file.size };
}

export async function getCurrentUser() {
  const auth = client().auth;
  const { data: sessionData, error: sessionError } = await auth.getSession();
  if (sessionError) throw authError(sessionError);
  if (!sessionData.session) return null;
  const { data, error } = await auth.getUser();
  if (error) throw authError(error);
  return data.user || null;
}

export async function signInWithPassword(email, password) {
  const { data, error } = await client().auth.signInWithPassword({ email, password });
  if (error) throw authError(error);
  if (!data.user) throw new SyncError("Supabase did not return a user session.");
  return data.user;
}

export async function signOutUser() {
  const { error } = await client().auth.signOut();
  if (error) throw authError(error);
}

function authError(error) {
  return new SyncError(error?.message || "Authentication failed.", {
    status: Number(error?.status || 0)
  });
}

function clone(value) { return structuredClone(value); }
function entityKey(type, id) { return `${type}\u0000${id}`; }
function splitKey(key) {
  const at = key.indexOf("\u0000");
  return { type: key.slice(0, at), id: key.slice(at + 1) };
}
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function hasLocalDirtyMarker() {
  try { return localStorage.getItem(CACHE_DIRTY_KEY) === "1"; } catch { return false; }
}
function setLocalDirtyMarker(dirty) {
  try {
    if (dirty) localStorage.setItem(CACHE_DIRTY_KEY, "1");
    else localStorage.removeItem(CACHE_DIRTY_KEY);
  } catch { /* the in-memory dirty flag still protects the active tab */ }
}

export function flattenWorkspace(input) {
  const data = migrateData(input);
  const items = new Map();
  items.set(META_KEY, {
    schemaVersion: data.schemaVersion,
    createdAt: data.createdAt,
    organization: clone(data.organization),
    platforms: clone(data.platforms),
    automation: clone(data.automation)
  });
  for (const [type, values] of [
    ["post", data.posts], ["deleted", data.deleted],
    ["run", data.runs], ["activity", data.activity]
  ]) {
    for (const value of values) {
      if (value?.id) items.set(entityKey(type, String(value.id)), clone(value));
    }
  }
  return items;
}

export function unflattenWorkspace(items, revision = 0, updatedAt = "") {
  const base = createDefaultData();
  const meta = items.get(META_KEY);
  const data = {
    ...base,
    ...(meta && typeof meta === "object" ? clone(meta) : {}),
    posts: [], deleted: [], runs: [], activity: []
  };
  for (const [key, value] of items) {
    const { type } = splitKey(key);
    if (!ENTITY_TYPES.has(type) || type === "meta") continue;
    const target = type === "post" ? data.posts
      : type === "deleted" ? data.deleted
        : type === "run" ? data.runs : data.activity;
    target.push(clone(value));
  }
  data.posts.sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  data.deleted.sort((a, b) => String(b.deletedAt || b.updatedAt || "").localeCompare(String(a.deletedAt || a.updatedAt || "")));
  data.runs.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  data.activity.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  const migrated = migrateData(data);
  migrated.revision = Number(revision || 0);
  if (updatedAt) migrated.updatedAt = updatedAt;
  return migrated;
}

function diffItems(base, desired) {
  const changes = new Map();
  for (const [key, data] of desired) {
    if (!base.has(key) || !sameJson(base.get(key), data)) {
      const { type, id } = splitKey(key);
      changes.set(key, { entity_type: type, entity_id: id, action: "upsert", data: clone(data) });
    }
  }
  for (const key of base.keys()) {
    if (!desired.has(key)) {
      const { type, id } = splitKey(key);
      changes.set(key, { entity_type: type, entity_id: id, action: "delete" });
    }
  }
  return changes;
}

export class Workspace {
  constructor() {
    this.credentials = readCredentials();
    this.user = null;
    this.listeners = [];
    this.source = null;
    this.adopt = null;
    this.dirty = false;
    this.dirtySince = 0;
    this.timer = null;
    this.inFlight = null;
    this.baseRevision = 0;
    this.remoteUpdatedAt = "";
    this.lastSyncedAt = null;
    this.lastError = null;
    this.conflict = null;
    this.history = [];
    this.cacheStale = false;
    this.knownItems = new Map();
    this.pendingChanges = new Map();
    this.cacheItems = new Map();
    this.cacheRevision = 0;
    this.cacheDbPromise = null;
    this.cacheQueue = Promise.resolve();
    this.channel = null;
    this.queuedRevision = 0;
  }

  setUser(user) {
    if (this.user?.id !== user?.id) this.unsubscribe();
    this.user = user || null;
    this.lastError = null;
    this.emit();
  }

  get connected() { return Boolean(this.user?.id); }
  get accountEmail() { return this.user?.email || ""; }
  get status() {
    if (!this.connected) return "locked";
    if (this.lastError) return "error";
    if (this.conflict) return "conflict";
    if (this.inFlight) return "saving";
    if (this.dirty) return "dirty";
    return "synced";
  }

  onStatus(fn) { this.listeners.push(fn); }
  emit() { for (const fn of this.listeners) fn(this.status, this); }
  bind(getData, adoptData = null) { this.source = getData; this.adopt = adoptData; }

  refreshCredentials() {
    this.credentials = readCredentials();
    this.lastError = null;
    this.emit();
  }

  async load() {
    this.requireUser();
    const cached = await this.loadCached();
    const recoverLocal = Boolean(cached && hasLocalDirtyMarker());
    const info = await this.readRemoteRevision();
    const remoteItems = await this.readAllItems();
    this.knownItems = remoteItems;
    this.baseRevision = info.revision;
    this.remoteUpdatedAt = info.updatedAt;
    this.pendingChanges.clear();
    this.dirty = false;
    this.lastError = null;
    this.conflict = null;
    await this.loadHistory();
    this.subscribe();

    if (recoverLocal) {
      cached.revision = this.cacheRevision;
      this.pendingChanges = diffItems(remoteItems, flattenWorkspace(cached));
      this.dirty = this.pendingChanges.size > 0;
      if (this.dirty && info.revision > this.cacheRevision) {
        this.conflict = {
          remote: unflattenWorkspace(remoteItems, info.revision, info.updatedAt),
          items: remoteItems,
          revision: info.revision
        };
      } else if (this.dirty) {
        setTimeout(() => { if (this.dirty && !this.conflict) void this.flush(); }, 0);
      } else {
        setLocalDirtyMarker(false);
      }
      /* The app adopts this return value before it paints status. Avoid
         emitting a conflict while state.data still belongs to boot. */
      return { data: cached, from: "device" };
    }

    if (!remoteItems.size) {
      const data = cached || createDefaultData();
      data.revision = info.revision;
      this.emit();
      return { data, from: cached ? "device" : "new" };
    }

    const remote = unflattenWorkspace(remoteItems, info.revision, info.updatedAt);
    await this.cacheData(remote, info.revision);
    this.lastSyncedAt = new Date();
    this.emit();
    return { data: remote, from: "supabase" };
  }

  async readRemoteRevision() {
    const { data, error } = await client().schema(SUPABASE_SCHEMA)
      .from("workspace_sync_state")
      .select("revision, updated_at")
      .eq("user_id", this.user.id)
      .maybeSingle();
    if (error) throw databaseError(error, "load");
    if (data) return { revision: Number(data.revision || 0), updatedAt: data.updated_at || "" };
    const created = await client().schema(SUPABASE_SCHEMA).rpc("ensure_workspace_state_v2");
    if (created.error) throw databaseError(created.error, "initialize");
    return { revision: Number(created.data || 0), updatedAt: "" };
  }

  async readAllItems() {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await client().schema(SUPABASE_SCHEMA)
        .from("workspace_items")
        .select("entity_type, entity_id, data, revision")
        .eq("user_id", this.user.id)
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw databaseError(error, "load");
      rows.push(...(data || []));
      if (!data || data.length < PAGE_SIZE) break;
    }
    return new Map(rows.map((row) => [entityKey(row.entity_type, row.entity_id), clone(row.data)]));
  }

  async fetchRemote() {
    const info = await this.readRemoteRevision();
    const items = await this.readAllItems();
    return { data: unflattenWorkspace(items, info.revision, info.updatedAt), items, ...info };
  }

  async readDelta(targetRevision) {
    const { data, error } = await client().schema(SUPABASE_SCHEMA)
      .rpc("read_workspace_changes_since", { since_revision: this.baseRevision });
    if (error) throw databaseError(error, "load changes");
    const items = new Map(this.knownItems);
    for (const change of data?.changes || []) {
      const key = entityKey(change.entity_type, change.entity_id);
      if (change.deleted) items.delete(key);
      else items.set(key, clone(change.data));
    }
    const revision = Number(data?.revision ?? targetRevision ?? this.baseRevision);
    return { data: unflattenWorkspace(items, revision, data?.updated_at || ""), items, revision };
  }

  async loadHistory() {
    const rows = [];
    const current = await client().schema(SUPABASE_SCHEMA)
      .from("workspace_revision_events")
      .select("revision, created_at, changed_count")
      .eq("user_id", this.user.id)
      .order("revision", { ascending: false })
      .limit(HISTORY_LIMIT);
    if (!current.error) rows.push(...(current.data || []));
    else console.warn("Delta history could not be loaded:", current.error.message);

    if (rows.length < HISTORY_LIMIT) {
      const legacy = await client().schema(SUPABASE_SCHEMA)
        .from("workspace_history")
        .select("revision, created_at")
        .eq("user_id", this.user.id)
        .order("revision", { ascending: false })
        .limit(HISTORY_LIMIT - rows.length);
      if (!legacy.error) rows.push(...(legacy.data || []));
    }

    this.history = rows
      .sort((a, b) => Number(b.revision) - Number(a.revision))
      .filter((entry, index, all) => all.findIndex((item) => Number(item.revision) === Number(entry.revision)) === index)
      .slice(0, HISTORY_LIMIT);
  }

  touch() {
    if (!this.source) return;
    const errors = validateData(this.source());
    if (errors.length) {
      this.lastError = new SyncError("This workspace failed validation and was not saved.", { hint: errors[0] });
      this.emit();
      return;
    }
    this.pendingChanges = diffItems(this.knownItems, flattenWorkspace(this.source()));
    void this.cacheData(this.source(), this.baseRevision);
    this.markDirty();
  }

  touchItem(type, value) {
    if (!ENTITY_TYPES.has(type) || type === "meta" || !value?.id) return this.touch();
    const key = entityKey(type, String(value.id));
    const data = clone(value);
    if (this.knownItems.has(key) && sameJson(this.knownItems.get(key), data)) this.pendingChanges.delete(key);
    else this.pendingChanges.set(key, { entity_type: type, entity_id: String(value.id), action: "upsert", data });
    if (!this.knownItems.has(META_KEY) && this.source) {
      const meta = flattenWorkspace(this.source()).get(META_KEY);
      this.pendingChanges.set(META_KEY, { entity_type: "meta", entity_id: "settings", action: "upsert", data: meta });
    }
    void this.cacheItem(type, String(value.id), data);
    this.markDirty();
  }

  markDirty() {
    this.dirty = this.pendingChanges.size > 0;
    setLocalDirtyMarker(this.dirty);
    if (!this.dirty) { this.dirtySince = 0; this.emit(); return; }
    if (!this.dirtySince) this.dirtySince = Date.now();
    this.emit();
    clearTimeout(this.timer);
    if (Date.now() - this.dirtySince >= MAX_SAVE_WAIT_MS) { void this.flush(); return; }
    this.timer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
  }

  async flush() {
    clearTimeout(this.timer);
    if (!this.dirty || !this.source || this.conflict) return;
    if (this.inFlight) { await this.inFlight.catch(() => {}); return this.flush(); }
    const errors = validateData(this.source());
    if (errors.length) {
      this.lastError = new SyncError("This workspace failed validation and was not saved.", { hint: errors[0] });
      this.emit();
      return;
    }
    this.inFlight = this.writePending();
    try {
      await this.inFlight;
      this.lastError = null;
      this.lastSyncedAt = new Date();
    } catch (error) {
      if (error instanceof ConflictError) {
        this.conflict = {
          remote: error.remote.data,
          items: error.remote.items,
          revision: error.remote.revision
        };
      }
      else this.lastError = error;
    } finally {
      this.inFlight = null;
      this.dirty = this.pendingChanges.size > 0;
      if (!this.dirty) this.dirtySince = 0;
      this.emit();
    }
    if (this.queuedRevision > this.baseRevision) void this.pullRealtime(this.queuedRevision);
    else if (this.dirty && !this.lastError && !this.conflict) void this.flush();
  }

  async writePending() {
    this.requireUser();
    if (isOffline()) throw new SyncError("This device is offline. Changes are held here until it reconnects.");
    while (this.pendingChanges.size) {
      const changes = [...this.pendingChanges.values()].slice(0, 200).map(clone);
      const { data: savedRevision, error } = await client().schema(SUPABASE_SCHEMA)
        .rpc("apply_workspace_changes", { expected_revision: this.baseRevision, changes });
      if (error) {
        if (String(error.message || "").includes("SC_REVISION_CONFLICT")) {
          throw new ConflictError(await this.fetchRemote());
        }
        throw databaseError(error, "save");
      }
      this.baseRevision = Number(savedRevision ?? this.baseRevision + 1);
      for (const change of changes) {
        const key = entityKey(change.entity_type, change.entity_id);
        if (change.action === "delete") this.knownItems.delete(key);
        else this.knownItems.set(key, clone(change.data));
      }
      this.pendingChanges = diffItems(this.knownItems, flattenWorkspace(this.source()));
      const now = new Date().toISOString();
      this.source().revision = this.baseRevision;
      this.source().updatedAt = now;
      await this.cacheData(this.source(), this.baseRevision);
      this.history.unshift({ revision: this.baseRevision, created_at: now, changed_count: changes.length });
      this.history = this.history
        .filter((entry, index, all) => all.findIndex((item) => Number(item.revision) === Number(entry.revision)) === index)
        .slice(0, HISTORY_LIMIT);
    }
    setLocalDirtyMarker(false);
  }

  async resolveConflict(choice) {
    const conflict = this.conflict;
    this.conflict = null;
    if (!conflict) return null;
    this.knownItems = new Map(conflict.items);
    this.baseRevision = Number(conflict.revision || 0);
    if (choice === "theirs") {
      this.pendingChanges.clear();
      this.dirty = false;
      setLocalDirtyMarker(false);
      await this.cacheData(conflict.remote, this.baseRevision);
      this.emit();
      return conflict.remote;
    }
    this.pendingChanges = diffItems(this.knownItems, flattenWorkspace(this.source()));
    this.dirty = this.pendingChanges.size > 0;
    this.emit();
    await this.flush();
    return null;
  }

  revisions() {
    return this.history.map((entry) => ({
      sha: String(entry.revision), at: entry.created_at,
      added: Number(entry.changed_count || 0), removed: 0
    }));
  }

  async atRevision(value) {
    this.requireUser();
    const revision = Number(value);
    if (!Number.isInteger(revision) || revision < 1) throw new SyncError("That revision number is invalid.");
    const current = await client().schema(SUPABASE_SCHEMA)
      .rpc("read_workspace_revision_v2", { target_revision: revision });
    if (current.error) throw databaseError(current.error, "load revision");
    if (current.data) {
      const restored = migrateData(current.data);
      restored.revision = revision;
      return restored;
    }
    const legacy = await client().schema(SUPABASE_SCHEMA)
      .from("workspace_history")
      .select("data, revision")
      .eq("user_id", this.user.id)
      .eq("revision", revision)
      .maybeSingle();
    if (legacy.error) throw databaseError(legacy.error, "load revision");
    if (!legacy.data) throw new SyncError("That saved revision no longer exists.");
    const restored = migrateData(legacy.data.data || {});
    restored.revision = Number(legacy.data.revision);
    return restored;
  }

  subscribe() {
    if (this.channel || !client().channel) return;
    this.channel = client().channel(`sc-workspace-${this.user.id}`).on(
      "postgres_changes",
      {
        event: "UPDATE", schema: SUPABASE_SCHEMA, table: "workspace_sync_state",
        filter: `user_id=eq.${this.user.id}`
      },
      (payload) => {
        const revision = Number(payload?.new?.revision || 0);
        if (revision > this.baseRevision) void this.pullRealtime(revision);
      }
    ).subscribe((status) => {
      if (status === "SUBSCRIBED") void this.pullRealtime();
    });
  }

  unsubscribe() {
    if (this.channel && sharedClient?.removeChannel) void sharedClient.removeChannel(this.channel);
    this.channel = null;
  }

  async pullRealtime(announcedRevision = 0) {
    if (this.inFlight) { this.queuedRevision = Math.max(this.queuedRevision, announcedRevision); return; }
    try {
      const target = announcedRevision || (await this.readRemoteRevision()).revision;
      if (target <= this.baseRevision) return;
      if (this.dirty) {
        const remote = await this.fetchRemote();
        this.conflict = { remote: remote.data, items: remote.items, revision: remote.revision };
        this.emit();
        return;
      }
      const remote = await this.readDelta(target);
      this.knownItems = remote.items;
      this.baseRevision = remote.revision;
      await this.cacheData(remote.data, remote.revision);
      await this.loadHistory();
      this.adopt?.(remote.data);
      this.lastSyncedAt = new Date();
      this.emit();
    } catch (error) {
      this.lastError = error;
      this.emit();
    } finally {
      this.queuedRevision = 0;
    }
  }

  openCache() {
    if (this.cacheDbPromise) return this.cacheDbPromise;
    if (!globalThis.indexedDB || !this.user?.id) return Promise.resolve(null);
    this.cacheDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(`sct-cache-v3-${this.user.id}`, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(CACHE_STORE)) {
          request.result.createObjectStore(CACHE_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.cacheDbPromise;
  }

  async cacheTransaction(mode, run) {
    const db = await this.openCache();
    if (!db) return false;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, mode);
      run(tx.objectStore(CACHE_STORE));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  enqueueCache(run) {
    this.cacheQueue = this.cacheQueue.then(run).catch((error) => {
      this.cacheStale = true;
      console.warn("IndexedDB cache unavailable:", error?.message || error);
      return false;
    });
    return this.cacheQueue;
  }

  cacheItem(type, id, data) {
    const key = entityKey(type, id);
    this.cacheItems.set(key, clone(data));
    return this.enqueueCache(() => this.cacheTransaction("readwrite", (store) => store.put({ key, data: clone(data) })));
  }

  cacheData(data, revision = this.baseRevision) {
    const desired = flattenWorkspace(data);
    const changes = diffItems(this.cacheItems, desired);
    this.cacheItems = desired;
    this.cacheRevision = Number(revision || 0);
    return this.enqueueCache(() => this.cacheTransaction("readwrite", (store) => {
      for (const [key, change] of changes) {
        if (change.action === "delete") store.delete(key);
        else store.put({ key, data: clone(change.data) });
      }
      store.put({ key: CACHE_REVISION_KEY, revision: this.cacheRevision });
    }));
  }

  async loadCached() {
    this.requireUser();
    await this.cacheQueue;
    let records = [];
    try {
      const db = await this.openCache();
      if (db) {
        records = await new Promise((resolve, reject) => {
          const request = db.transaction(CACHE_STORE).objectStore(CACHE_STORE).getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
        });
      }
    } catch (error) {
      this.cacheStale = true;
      console.warn("IndexedDB cache unavailable:", error?.message || error);
    }
    const revisionRecord = records.find((record) => record.key === CACHE_REVISION_KEY);
    const itemRecords = records.filter((record) => record.key !== CACHE_REVISION_KEY);
    if (itemRecords.length) {
      this.cacheItems = new Map(itemRecords.map((record) => [record.key, clone(record.data)]));
      this.cacheRevision = Number(revisionRecord?.revision || 0);
      return unflattenWorkspace(this.cacheItems, this.cacheRevision);
    }
    const legacy = readLocalWorkspace();
    if (!legacy) return null;
    const migrated = migrateData(legacy);
    const stored = await this.cacheData(migrated, migrated.revision);
    if (stored === true) clearLegacyLocalWorkspace();
    return migrated;
  }

  requireUser() {
    if (!this.connected) throw new SyncError("Sign in before opening the workspace.");
  }
}

function isOffline() { return globalThis.navigator?.onLine === false; }

class ConflictError extends SyncError {
  constructor(remote) {
    super("This workspace changed on another device.");
    this.name = "ConflictError";
    this.remote = remote;
  }
}

function databaseError(error, action) {
  const message = String(error?.message || "");
  const code = String(error?.code || "");
  if (code === "PGRST106" || /schema.*exposed|invalid schema/i.test(message)) {
    return new SyncError("The sc schema is not enabled in the Supabase Data API.", {
      hint: "Open Project Settings → Data API, add sc to Exposed schemas without removing the others, and save."
    });
  }
  if (code === "42501" || /row-level security|permission denied/i.test(message)) {
    return new SyncError("Supabase refused access to this workspace.", {
      hint: "Confirm that you signed in as the intended user and ran the sc deployment SQL."
    });
  }
  return new SyncError(`Supabase could not ${action} the workspace.`, {
    hint: message || "Check the connection and try again."
  });
}
