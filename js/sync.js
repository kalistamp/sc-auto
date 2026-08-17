/* ============================================================
   SAFE CYCLE STUDIO — workspace store

   The whole workspace is one JSON file inside one secret gist that you
   own. This module is everything that touches it.

   Three things it does that the previous build did not:

     · Writes are debounced with a ceiling. Steady typing used to reset
       a timer forever (nothing saved) or fire on every pause (a gist
       revision per sentence). Now edits coalesce, and an edit can
       never sit unsaved longer than MAX_SAVE_WAIT_MS.

     · A conflict is a question, not a dead end. If the gist moved under
       us, the store reports `conflict` and hands both revisions to the
       caller so a person can choose; it never silently overwrites.

     · Version history comes free. GitHub stamps a revision on every
       PATCH, so the gist is its own undo stack.

   With no gist connected the app still works — everything is kept in
   this browser and nothing is uploaded.
   ============================================================ */

import { GIST_FILENAME, HISTORY_LIMIT, MAX_SAVE_WAIT_MS, SAVE_DEBOUNCE_MS } from "./config.js";
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

export class Workspace {
  constructor() {
    this.credentials = readCredentials();
    this.listeners = [];
    this.source = null;        /* () => current data, read at flush time */
    this.dirty = false;
    this.dirtySince = 0;
    this.timer = null;
    this.inFlight = null;
    this.baseRevision = 0;     /* the revision this device believes is live */
    this.lastSyncedAt = null;
    this.lastError = null;
    this.conflict = null;      /* { remote } while unresolved */
    this.history = [];
    /* True once the browser has refused to write the local cache — the
       gist still has everything, but this device's offline copy is stale.
       Surfaced by the app rather than swallowed. */
    this.cacheStale = false;
  }

  get connected() {
    return Boolean(this.credentials.githubToken && this.credentials.gistId);
  }

  get status() {
    if (this.lastError) return "error";
    if (this.conflict) return "conflict";
    if (this.inFlight) return "saving";
    if (this.dirty) return "dirty";
    if (!this.connected) return "local";
    return "synced";
  }

  onStatus(fn) { this.listeners.push(fn); }
  emit() { for (const fn of this.listeners) fn(this.status, this); }

  /* The store pulls from this at flush time rather than being handed a
     snapshot when the edit happens, so a burst of edits always uploads
     the latest state instead of a stale one. */
  bind(getData) { this.source = getData; }

  refreshCredentials() {
    this.credentials = readCredentials();
    this.lastError = null;
    this.emit();
  }

  /* ---------- loading ---------------------------------------------- */

  async load() {
    if (!this.connected) {
      const cached = readLocalWorkspace();
      const data = cached ? migrateData(cached) : createDefaultData();
      this.baseRevision = Number(data.revision || 0);
      this.emit();
      return { data, from: cached ? "device" : "new" };
    }

    const data = await this.fetchRemote();
    this.baseRevision = Number(data.revision || 0);
    this.lastSyncedAt = new Date();
    this.lastError = null;
    this.conflict = null;
    this.cacheStale = !writeLocalWorkspace(data);   /* so the next cold start is instant */
    this.emit();
    return { data, from: "gist" };
  }

  async fetchRemote() {
    const payload = await gistRequest(this.credentials, "GET");
    this.history = Array.isArray(payload.history) ? payload.history.slice(0, HISTORY_LIMIT) : [];
    const file = payload.files?.[GIST_FILENAME];
    if (!file) {
      throw new SyncError(`That gist has no ${GIST_FILENAME}.`, {
        hint: `Add a file named exactly ${GIST_FILENAME} to the gist. Any JSON object will do; the studio fills in the rest.`
      });
    }
    /* Files over 1 MB come back truncated with a raw_url instead. */
    const text = file.truncated && file.raw_url
      ? await (await fetch(file.raw_url, { cache: "no-store" })).text()
      : file.content;
    let parsed;
    try { parsed = JSON.parse(text || "{}"); }
    catch {
      throw new SyncError(`${GIST_FILENAME} is not valid JSON.`, {
        hint: "Open the gist on GitHub and check the file, or restore an earlier revision from version history."
      });
    }
    return migrateData(parsed);
  }

  /* ---------- saving ------------------------------------------------ */

  /* Plain debouncing starves: someone typing steadily resets the timer
     on every keystroke and nothing ever reaches the gist. The ceiling
     keeps the wait bounded. */
  touch() {
    this.dirty = true;
    if (!this.dirtySince) this.dirtySince = Date.now();
    this.emit();

    clearTimeout(this.timer);
    if (Date.now() - this.dirtySince >= MAX_SAVE_WAIT_MS) { this.flush(); return; }
    this.timer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
  }

  async flush() {
    clearTimeout(this.timer);
    if (!this.dirty || !this.source) return;
    if (this.conflict) return;                 /* a person has to answer first */
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
      /* Put the work back: the change is still unsaved, and the next
         edit or an explicit retry should carry it up again. */
      this.dirty = true;
      this.dirtySince = this.dirtySince || Date.now();
      if (error instanceof ConflictError) this.conflict = { remote: error.remote };
      else this.lastError = error;
    } finally {
      this.inFlight = null;
      this.emit();
    }

    if (this.dirty && !this.lastError && !this.conflict) this.flush();
  }

  async write(data) {
    const next = structuredClone(data);
    next.revision = Number(this.baseRevision || 0) + 1;
    next.updatedAt = new Date().toISOString();

    /* With no gist connected, localStorage is not a cache — it is the
       only copy. A refused write here is a genuine failed save, so it
       has to be reported rather than returned as success. */
    if (!this.connected) {
      if (!writeLocalWorkspace(next)) {
        throw new SyncError("This browser is out of storage, so the change could not be saved.", {
          hint: "This device has no gist connected, so local storage is the only copy. Connect a gist under Cloud sync, or export a backup and remove some posts."
        });
      }
      this.cacheStale = false;
      this.baseRevision = next.revision;
      data.revision = next.revision;
      data.updatedAt = next.updatedAt;
      return next;
    }

    if (isOffline()) {
      /* Held locally until the connection returns — but only if the
         write actually landed, so say which of the two happened. */
      if (!writeLocalWorkspace(next)) {
        throw new SyncError("This device is offline and out of local storage, so the change is only in this tab.", {
          hint: "Do not reload. Reconnect to save it to your gist, or export a backup now."
        });
      }
      throw new SyncError("This device is offline. Changes are held here until it reconnects.", { status: 0 });
    }

    /* Read before write. Two devices editing the same gist is the whole
       reason revisions exist, and GitHub has no conditional PATCH, so
       the check has to happen here. Writes are debounced, so this costs
       one extra request per burst rather than per keystroke. */
    const remote = await this.fetchRemote();
    if (Number(remote.revision || 0) !== Number(this.baseRevision || 0)) {
      throw new ConflictError(remote);
    }

    await gistRequest(this.credentials, "PATCH", {
      files: { [GIST_FILENAME]: { content: JSON.stringify(next, null, 2) } }
    });

    this.baseRevision = next.revision;
    data.revision = next.revision;
    data.updatedAt = next.updatedAt;
    /* The gist has it, so this is not a failed save — but the offline
       copy is now behind, and the operator should know before they rely
       on opening this device without a connection. */
    this.cacheStale = !writeLocalWorkspace(next);
    return next;
  }

  /* ---------- conflict resolution ----------------------------------- */

  /* Called after a person has chosen. "theirs" adopts the remote copy;
     "mine" re-bases this device's copy on top of it and writes. */
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

  /* ---------- version history --------------------------------------- */

  /* GitHub keeps one revision per PATCH, so this is an undo stack we
     get without storing anything ourselves. */
  revisions() {
    return this.history.map((entry) => ({
      sha: entry.version,
      at: entry.committed_at,
      added: entry.change_status?.additions ?? 0,
      removed: entry.change_status?.deletions ?? 0
    }));
  }

  async atRevision(sha) {
    const payload = await gistRequest(this.credentials, "GET", null, `/${sha}`);
    const file = payload.files?.[GIST_FILENAME];
    if (!file) throw new SyncError("That revision has no workspace file in it.");
    const text = file.truncated && file.raw_url
      ? await (await fetch(file.raw_url, { cache: "no-store" })).text()
      : file.content;
    return migrateData(JSON.parse(text || "{}"));
  }

  /* ---------- connection test --------------------------------------- */

  /* Used by the Cloud sync dialog before saving credentials, so a typo
     is caught while the fields are still on screen. */
  async test(credentials) {
    const probe = { ...this.credentials, ...credentials };
    if (!probe.githubToken || !probe.gistId) {
      throw new SyncError("Enter both a GitHub token and a gist id.");
    }
    const payload = await gistRequest(probe, "GET");
    const file = payload.files?.[GIST_FILENAME];
    if (!file) {
      throw new SyncError(`That gist has no ${GIST_FILENAME}.`, {
        hint: `Add a file named exactly ${GIST_FILENAME} to the gist first.`
      });
    }
    try {
      return migrateData(JSON.parse(file.content || "{}"));
    } catch {
      throw new SyncError(`${GIST_FILENAME} is not valid JSON.`);
    }
  }
}

/* `navigator` is not guaranteed to exist outside a browser, and this
   file is unit tested. */
function isOffline() {
  return globalThis.navigator?.onLine === false;
}

class ConflictError extends SyncError {
  constructor(remote) {
    super("This workspace changed on another device.");
    this.name = "ConflictError";
    this.remote = remote;
  }
}

/* ------------------------------------------------------------
   GITHUB TRANSPORT
   ------------------------------------------------------------ */

async function gistRequest(credentials, method, body, suffix = "") {
  let response;
  try {
    response = await fetch(`https://api.github.com/gists/${encodeURIComponent(credentials.gistId)}${suffix}`, {
      method,
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${credentials.githubToken}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new SyncError("Could not reach GitHub.", {
      hint: isOffline() ? "This device appears to be offline." : "Check the network connection and try again."
    });
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new SyncError(describeGist(response.status, method, payload), { status: response.status });
  return payload;
}

/* GitHub's own wording for a scope problem ("Resource not accessible by
   personal access token") says nothing about how to fix it, and it is
   the single most likely thing to go wrong here. */
function describeGist(status, method, payload) {
  if (status === 401) return "GitHub rejected the token. It may be expired or mistyped.";
  if (status === 403) {
    return method === "GET"
      ? "That token cannot read this gist. It needs Gists → Read and write (under Account permissions for a fine-grained token)."
      : "That token cannot write this gist. It needs Gists → Read and write, not read-only.";
  }
  if (status === 404) return "No gist found for that id — check the id, and that this token can see it.";
  if (status === 422) return "GitHub refused the write. The workspace file may be too large for a gist.";
  if (status === 429) return "GitHub rate limit reached. Wait a minute and try again.";
  return payload?.message ? `GitHub returned ${status}: ${payload.message}` : `GitHub returned ${status}.`;
}
