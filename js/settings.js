/* ============================================================
   SAFE CYCLE STUDIO — per-device settings

   Two kinds of state live here, and the split matters:

     · CREDENTIALS (GitHub token, model API keys) stay in this
       browser's localStorage and are never written to the gist. On a
       new device you enter them once more. Syncing them would mean
       putting plaintext secrets in a file protected by a short
       passkey, which is worse than typing them again.

     · PREFERENCES (theme, last view, list density) are also local,
       because they are per-device by nature — a phone wants a
       different list view than a desktop.

   Everything the workspace actually is — posts, records, settings the
   organization shares — lives in the gist instead. See sync.js.
   ============================================================ */

const CRED_KEY = "sct.credentials.v1";
const MODELS_KEY = "sct.models.v1";
const PREF_KEY = "sct.prefs.v1";
const LOCAL_DATA_KEY = "sct.workspace.v2";
const UNLOCK_KEY = "sct.unlocked";
const DRAFT_KEY = "sct.brief.draft";

export const PROVIDERS = Object.freeze({
  anthropic: {
    label: "Anthropic Claude",
    defaultModel: "claude-opus-5",
    placeholder: "sk-ant-…",
    keysUrl: "https://platform.claude.com/settings/keys",
    /* Anthropic exposes a reasoning-effort control; the others use
       different knobs, so this is only offered for this provider. */
    supportsEffort: true
  },
  openai: {
    label: "OpenAI",
    defaultModel: "gpt-5.6-luna",
    placeholder: "sk-…",
    keysUrl: "https://platform.openai.com/api-keys",
    supportsEffort: false
  },
  gemini: {
    label: "Google Gemini",
    defaultModel: "gemini-3.6-flash",
    placeholder: "AIza…",
    keysUrl: "https://aistudio.google.com/apikey",
    supportsEffort: false
  }
});

export const PROVIDER_KEYS = Object.keys(PROVIDERS);

const DEFAULT_PREFS = {
  theme: "system",          /* system | light | dark */
  view: "overview",
  libraryLayout: "grid",    /* grid | list */
  librarySort: "updated"    /* updated | created | campaign */
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch { return { ...fallback }; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode; settings just won't persist */ }
}

/* ---------- credentials -------------------------------------------- */

export function readCredentials() {
  const saved = read(CRED_KEY, {});
  const provider = PROVIDERS[saved.provider] ? saved.provider : "anthropic";
  return {
    githubToken: String(saved.githubToken || "").trim(),
    gistId: extractGistId(saved.gistId),
    provider,
    effort: ["", "low", "medium", "high"].includes(saved.effort) ? saved.effort : "",
    keys: Object.fromEntries(PROVIDER_KEYS.map((id) => [id, String(saved.keys?.[id] || "").trim()])),
    models: Object.fromEntries(PROVIDER_KEYS.map((id) =>
      [id, String(saved.models?.[id] || PROVIDERS[id].defaultModel).trim()]))
  };
}

export function writeCredentials(next) {
  const merged = { ...readCredentials(), ...next };
  merged.gistId = extractGistId(merged.gistId);
  write(CRED_KEY, merged);
  return readCredentials();
}

export function clearCredentials() {
  try { localStorage.removeItem(CRED_KEY); } catch { /* nothing to do */ }
  clearModelCatalogs();
}

/* ---------- model catalogs ------------------------------------------

   What each provider answered when it was last asked which models the
   entered key can use. Cached so reopening Cloud sync shows a populated
   picker instead of an empty one waiting on a network round trip.

   Cached against the key's FINGERPRINT, never the key itself. A model
   list belongs to a key, not to a provider — a different key can be a
   different project with different model access — so pasting a new key
   has to invalidate the list rather than leave the picker confidently
   describing the old one.
   ------------------------------------------------------------------- */

/* Enough for any provider's full list several times over. A ceiling only
   because localStorage is a shared ~5 MB budget with the workspace, and
   losing a post to a cache of model names would be an absurd trade. */
const MODEL_CACHE_LIMIT = 300;

function readCatalogs() {
  try {
    const raw = localStorage.getItem(MODELS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

export function readModelCatalog(provider, apiKey) {
  const entry = readCatalogs()[provider];
  if (!entry || !Array.isArray(entry.models) || !entry.models.length) return null;
  if (entry.keyPrint !== fingerprint(String(apiKey || "").trim())) return null;
  return {
    models: entry.models
      .filter((model) => model && typeof model.id === "string" && model.id)
      .map((model) => ({ id: model.id, label: String(model.label || model.id) })),
    fetchedAt: String(entry.fetchedAt || "")
  };
}

export function writeModelCatalog(provider, { models = [], apiKey = "", fetchedAt = "" } = {}) {
  if (!PROVIDERS[provider]) return null;
  const all = readCatalogs();
  all[provider] = {
    keyPrint: fingerprint(String(apiKey || "").trim()),
    fetchedAt: fetchedAt || new Date().toISOString(),
    models: models.slice(0, MODEL_CACHE_LIMIT).map((model) => ({
      id: String(model.id || ""),
      label: String(model.label || model.id || "")
    })).filter((model) => model.id)
  };
  write(MODELS_KEY, all);
  return readModelCatalog(provider, apiKey);
}

export function clearModelCatalogs() {
  try { localStorage.removeItem(MODELS_KEY); } catch { /* nothing to do */ }
}

/* People paste the whole gist URL about as often as the bare id. */
export function extractGistId(value) {
  return String(value || "").trim()
    .replace(/^.*gist\.github\.com\//, "")
    .replace(/^[^/]+\//, "")
    .replace(/[#?].*$/, "")
    .replace(/\/+$/, "");
}

/* Never show a token, only enough of it to recognise which one it is. */
export function fingerprint(token) {
  if (!token) return "—";
  return token.length > 14 ? `${token.slice(0, 8)}…${token.slice(-4)}` : "set";
}

/* ---------- preferences -------------------------------------------- */

export function readPrefs() { return read(PREF_KEY, DEFAULT_PREFS); }

export function writePrefs(patch) {
  const merged = { ...readPrefs(), ...patch };
  write(PREF_KEY, merged);
  return merged;
}

/* ---------- session latch ------------------------------------------ */

/* sessionStorage, not localStorage: closing the tab re-locks the studio,
   but a reload during a working session does not interrupt you. */
export const session = {
  get unlocked() {
    try { return sessionStorage.getItem(UNLOCK_KEY) === "1"; } catch { return false; }
  },
  unlock() { try { sessionStorage.setItem(UNLOCK_KEY, "1"); } catch { /* ignore */ } },
  lock() { try { sessionStorage.removeItem(UNLOCK_KEY); } catch { /* ignore */ } }
};

/* ---------- local workspace copy ------------------------------------ */

/* Used when no gist is connected, and as the cache that lets the app
   open instantly (and survive an offline start) once one is. */
export function readLocalWorkspace() {
  try {
    const raw = localStorage.getItem(LOCAL_DATA_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/* Returns false when the browser refused the write — almost always the
   ~5 MB per-origin quota, reached by a workspace with enough posts in it.
   The caller has to know: with a gist connected this only means the
   instant-open cache went stale, but with no gist connected localStorage
   IS the store, and a silent failure there loses the edit. Swallowing the
   exception without reporting it is how that becomes invisible. */
export function writeLocalWorkspace(data) {
  try {
    localStorage.setItem(LOCAL_DATA_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/* ---------- in-progress brief --------------------------------------- */

/* A brief can take real thought to write. Losing it to an accidental
   reload — or to a failed generation — is the kind of small betrayal
   that makes a tool feel untrustworthy, so it is kept on disk. */
export function readDraftBrief() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function writeDraftBrief(brief) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(brief)); } catch { /* ignore */ }
}

export function clearDraftBrief() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}
