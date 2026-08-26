/* ============================================================
   SAFE CYCLE STUDIO — authenticated Supabase workspace store

   The complete workspace remains one JSON document, now stored in the
   dedicated `sc` Postgres schema. Row Level Security ties every row and
   every saved revision to the authenticated Supabase user.

   Model-provider keys are deliberately not part of this document. They
   remain in localStorage through settings.js and never reach Supabase.
   ============================================================ */

import {
  HISTORY_LIMIT, MAX_SAVE_WAIT_MS, SAVE_DEBOUNCE_MS,
  SUPABASE_PUBLISHABLE_KEY, SUPABASE_SCHEMA, SUPABASE_URL
} from "./config.js";
import { createDefaultData, migrateData, validateData } from "./data.js";
import { readCredentials, readLocalWorkspace, writeLocalWorkspace } from "./settings.js";

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

export async function getCurrentUser() {
  const auth = client().auth;
  const { data: sessionData, error: sessionError } = await auth.getSession();
  if (sessionError) throw authError(sessionError);
  if (!sessionData.session) return null;

  /* getUser validates the signed token with Supabase. A hand-edited local
     session can never unlock a cached workspace. */
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

export class Workspace {
  constructor() {
    this.credentials = readCredentials();
    this.user = null;
    this.listeners = [];
    this.source = null;
    this.dirty = false;
    this.dirtySince = 0;
    this.timer = null;
    this.inFlight = null;
    this.baseRevision = 0;
    this.lastSyncedAt = null;
    this.lastError = null;
    this.conflict = null;
    this.history = [];
    this.cacheStale = false;
  }

  setUser(user) {
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
  bind(getData) { this.source = getData; }

  refreshCredentials() {
    this.credentials = readCredentials();
    this.lastError = null;
    this.emit();
  }

  async load() {
    this.requireUser();
    const remote = await this.fetchRemote();
    if (!remote) {
      const cached = readLocalWorkspace();
      const data = cached ? migrateData(cached) : createDefaultData();
      data.revision = 0;
      this.baseRevision = 0;
      this.history = [];
      this.emit();
      return { data, from: cached ? "device" : "new" };
    }

    this.baseRevision = Number(remote.revision || 0);
    this.lastSyncedAt = new Date();
    this.lastError = null;
    this.conflict = null;
    this.cacheStale = !writeLocalWorkspace(remote);
    await this.loadHistory();
    this.emit();
    return { data: remote, from: "supabase" };
  }

  async fetchRemote() {
    this.requireUser();
    const { data, error } = await client()
      .schema(SUPABASE_SCHEMA)
      .from("workspace_data")
      .select("data, revision, updated_at")
      .eq("user_id", this.user.id)
      .maybeSingle();

    if (error) throw databaseError(error, "load");
    if (!data) return null;

    const workspace = migrateData(data.data || {});
    workspace.revision = Number(data.revision || 0);
    workspace.updatedAt = data.updated_at || workspace.updatedAt;
    return workspace;
  }

  async loadHistory() {
    const { data, error } = await client()
      .schema(SUPABASE_SCHEMA)
      .from("workspace_history")
      .select("revision, created_at")
      .eq("user_id", this.user.id)
      .order("revision", { ascending: false })
      .limit(HISTORY_LIMIT);

    if (error) {
      console.warn("Version history could not be loaded:", error.message);
      this.history = [];
      return;
    }
    this.history = data || [];
  }

  touch() {
    this.dirty = true;
    if (!this.dirtySince) this.dirtySince = Date.now();
    this.emit();

    clearTimeout(this.timer);
    if (Date.now() - this.dirtySince >= MAX_SAVE_WAIT_MS) { void this.flush(); return; }
    this.timer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
  }

  async flush() {
    clearTimeout(this.timer);
    if (!this.dirty || !this.source) return;
    if (this.conflict) return;
    if (this.inFlight) { await this.inFlight.catch(() => {}); return this.flush(); }

    const data = this.source();
    const errors = validateData(data);
    if (errors.length) {
      this.lastError = new SyncError("This workspace failed validation and was not saved.", { hint: errors[0] });
      this.emit();
      return;
    }

    this.dirty = false;
    this.dirtySince = 0;
    this.emit();

    this.inFlight = this.write(data);
    try {
      await this.inFlight;
      this.lastError = null;
      this.lastSyncedAt = new Date();
    } catch (error) {
      this.dirty = true;
      this.dirtySince = this.dirtySince || Date.now();
      if (error instanceof ConflictError) this.conflict = { remote: error.remote };
      else this.lastError = error;
    } finally {
      this.inFlight = null;
      this.emit();
    }

    if (this.dirty && !this.lastError && !this.conflict) void this.flush();
  }

  async write(data) {
    this.requireUser();
    const next = structuredClone(data);
    next.revision = Number(this.baseRevision || 0) + 1;
    next.updatedAt = new Date().toISOString();

    if (isOffline()) {
      if (!writeLocalWorkspace(next)) {
        throw new SyncError("This device is offline and out of local storage, so the change is only in this tab.", {
          hint: "Do not reload. Reconnect to save it to Supabase, or export a backup now."
        });
      }
      throw new SyncError("This device is offline. Changes are held here until it reconnects.");
    }

    const { data: savedRevision, error } = await client()
      .schema(SUPABASE_SCHEMA)
      .rpc("save_workspace", {
        expected_revision: this.baseRevision,
        new_data: next
      });

    if (error) {
      if (String(error.message || "").includes("SC_VERSION_CONFLICT")) {
        const remote = await this.fetchRemote();
        throw new ConflictError(remote || createDefaultData());
      }
      throw databaseError(error, "save");
    }

    const revision = Number(savedRevision);
    this.baseRevision = revision;
    data.revision = revision;
    data.updatedAt = next.updatedAt;
    next.revision = revision;
    this.cacheStale = !writeLocalWorkspace(next);
    this.history.unshift({ revision, created_at: next.updatedAt });
    this.history = this.history
      .filter((entry, index, all) => all.findIndex((item) => Number(item.revision) === Number(entry.revision)) === index)
      .slice(0, HISTORY_LIMIT);
    return next;
  }

  async resolveConflict(choice) {
    const remote = this.conflict?.remote;
    this.conflict = null;
    if (choice === "theirs") {
      this.baseRevision = Number(remote?.revision || 0);
      this.dirty = false;
      this.emit();
      return remote;
    }
    this.baseRevision = Number(remote?.revision || 0);
    this.dirty = true;
    this.emit();
    await this.flush();
    return null;
  }

  revisions() {
    return this.history.map((entry) => ({
      sha: String(entry.revision),
      at: entry.created_at,
      added: 0,
      removed: 0
    }));
  }

  async atRevision(value) {
    this.requireUser();
    const revision = Number(value);
    if (!Number.isInteger(revision) || revision < 1) throw new SyncError("That revision number is invalid.");

    const { data, error } = await client()
      .schema(SUPABASE_SCHEMA)
      .from("workspace_history")
      .select("data, revision")
      .eq("user_id", this.user.id)
      .eq("revision", revision)
      .maybeSingle();

    if (error) throw databaseError(error, "load revision");
    if (!data) throw new SyncError("That saved revision no longer exists.");
    const restored = migrateData(data.data || {});
    restored.revision = Number(data.revision);
    return restored;
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
      hint: "Open Project Settings → Data API, add sc to Exposed schemas, and save."
    });
  }
  if (code === "42501" || /row-level security|permission denied/i.test(message)) {
    return new SyncError("Supabase refused access to this workspace.", {
      hint: "Confirm that you signed in as the user selected during import and that the RLS migration ran."
    });
  }
  return new SyncError(`Supabase could not ${action} the workspace.`, {
    hint: message || "Check the connection and try again."
  });
}
