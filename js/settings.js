/* ============================================================
   SAFE CYCLE STUDIO — per-device settings

   Two kinds of state live here, and the split matters:

     · CREDENTIALS (model API keys) stay in this browser's localStorage
       and are never written to Supabase. On a new device you enter them
       once more.

     · PREFERENCES (theme, last view, list density) are also local,
       because they are per-device by nature — a phone wants a
       different list view than a desktop.

   Everything the workspace actually is — posts, records, settings the
   organization shares — lives in Supabase instead. See sync.js.
   ============================================================ */

const CRED_KEY = "sct.credentials.v1";
const MODELS_KEY = "sct.models.v1";
const PREF_KEY = "sct.prefs.v1";
const LOCAL_DATA_KEY = "sct.workspace.v2";
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
  /* Remove obsolete Gist secrets the first time the Supabase build runs. */
  if (Object.hasOwn(saved, "githubToken") || Object.hasOwn(saved, "gistId")) {
    delete saved.githubToken;
    delete saved.gistId;
    write(CRED_KEY, saved);
  }
  const provider = PROVIDERS[saved.provider] ? saved.provider : "anthropic";
  return {
    provider,
    effort: ["", "low", "medium", "high"].includes(saved.effort) ? saved.effort : "",
    keys: Object.fromEntries(PROVIDER_KEYS.map((id) => [id, String(saved.keys?.[id] || "").trim()])),
    models: Object.fromEntries(PROVIDER_KEYS.map((id) =>
      [id, String(saved.models?.[id] || PROVIDERS[id].defaultModel).trim()]))
  };
}

export function writeCredentials(next) {
  const merged = { ...readCredentials(), ...next };
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

/* Enough for any provider's full list several times over. Keep a ceiling
   because localStorage still has a small per-origin budget and a model
   catalog is disposable cache data. */
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

/* ---------- legacy local workspace copy ----------------------------- */

/* Build 3.9 moves the cache to row-level IndexedDB records. This reader
   exists only to migrate the previous full-document localStorage cache,
   and is never consulted before Supabase has authenticated the user. */
export function readLocalWorkspace() {
  try {
    const raw = localStorage.getItem(LOCAL_DATA_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearLegacyLocalWorkspace() {
  try { localStorage.removeItem(LOCAL_DATA_KEY); } catch { /* ignore */ }
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
