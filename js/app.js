/* ============================================================
   SAFE CYCLE STUDIO — views and interaction

   The chrome (sidebar, topbar, dialogs, toast) is static markup in
   index.html; only #view is re-rendered. That is what keeps a caret,
   a scroll position and a text selection alive while a save runs in
   the background — and it is why every handler below either mutates
   data and patches one node, or navigates and rebuilds the view, but
   never both at once.

   Workflow, in one line: draft with a model → review and edit →
   approve → copy or open the platform → publish it yourself → paste
   the URL back. Nothing in this file posts to a social platform, and
   nothing ever will; that boundary is the point.
   ============================================================ */

import { APP_PASSKEY, BUILD, DELETED_RETENTION_DAYS } from "./config.js";
import {
  STATUS_LABELS,
  addActivity, addRun, allVariants, countsFor, createDefaultData, createExternalPost,
  createPostFromGeneration, deletionDaysLeft, deletionExpiresAt, derivePostStatus,
  findSimilarPosts, getPlatform,
  isOverdue, isQueued, isScheduled, listPlatforms, migrateData, normalizePlatform, nowIso,
  platformKeys, purgeExpiredDeleted, pushGeneration, removeDeletedForever, restoreDeletedPost,
  setActivePlatforms, snapshotGeneration, softDeletePost, splitTags, textSimilarity,
  uniquePlatformKey, validateData
} from "./data.js";
import { buildCopyText, platformHomeUrl, platformLabel, variantChecks } from "./platforms.js";
import { PROMPT_VERSION, ProviderError, generateDrafts, listModels, modelsMatch, receiptState } from "./providers.js";
import {
  PROVIDERS, PROVIDER_KEYS, clearCredentials, clearDraftBrief, fingerprint, readCredentials,
  readDraftBrief, readModelCatalog, readPrefs, session, writeCredentials, writeDraftBrief,
  writeModelCatalog, writePrefs
} from "./settings.js";
import { SyncError, Workspace } from "./sync.js";
import { THEMES, applyTheme, currentTheme, setTheme, toggleTheme, watchSystemTheme } from "./theme.js";
import {
  closeModal, confirmAction, copyText, downloadFile, el, esc, fmtDateTime, fmtDayHeading,
  fmtTime, fromLocalInput, icon, openModal, plural, relTime, safeUrl, toLocalInput,
  toast, withFocusRetained
} from "./ui.js";

const workspace = new Workspace();

const state = {
  data: null,
  view: "overview",
  postId: "",
  generating: false,
  rerunning: false,
  abort: null,
  filters: { q: "", status: "all", platform: "all" },
  prefs: readPrefs(),
  brief: emptyBrief(),
  keySequence: ""
};

const VIEWS = {
  overview: { title: "Overview", sub: "Everything waiting on you", render: renderOverview },
  compose:  { title: "New draft", sub: "Turn a brief into platform-ready copy", render: renderCompose },
  library:  { title: "Library", sub: "Every draft and publication record", render: renderLibrary },
  queue:    { title: "Queue", sub: "Approved and scheduled, in date order", render: renderQueue },
  runs:     { title: "Model runs", sub: "Which model produced what, and when", render: renderRuns },
  deleted:  { title: "Deleted posts", sub: `Recoverable for ${DELETED_RETENTION_DAYS} days`, render: renderDeleted },
  settings: { title: "Settings", sub: "Organization context, sync, and data", render: renderSettings },
  editor:   { title: "Draft", sub: "Review, edit, approve, publish", render: renderEditor }
};

/* ============================================================
   BOOT

   `boot()` is called from the very bottom of this file, not here.
   Loading a local workspace emits a sync-status change synchronously,
   which reaches paintSyncState — and that reads a lookup table defined
   further down. Starting before the module has finished evaluating
   trips the temporal dead zone and the whole first load fails.
   ============================================================ */

function boot() {
  /* First act, before anything that could throw: tells the watchdog in
     index.html that the module graph linked and is running. If this never
     runs the gate explains itself instead of sitting there with a dead
     Unlock button — see the comment on that script. */
  globalThis.__sctBooted = true;

  applyTheme();
  watchSystemTheme(() => { /* tokens do the work; nothing to re-render */ });
  wireChrome();
  checkBuild();

  workspace.bind(() => state.data);
  workspace.onStatus(paintSyncState);

  const draft = readDraftBrief();
  if (draft) {
    state.brief = { ...emptyBrief(), ...draft };
    /* A brief saved by an older build has the topic under its old name. */
    state.brief.topic ||= draft.keyMessage || "";
  }

  if (session.unlocked) enterStudio({ silent: true });
  else el("#passkey")?.focus();
}

/* The one place the workspace is adopted, so the platform registry can
   never be left describing a workspace that is no longer open.

   Platforms are workspace data as of schema 3, and js/data.js keeps a
   registry that every other module reads through getPlatform(). There are
   ten paths that swap the whole workspace — first load, cache hit, remote
   pull, conflict resolution, import, reset, version restore — and a
   platform list that lagged behind any one of them would render a post
   under the wrong platform's name and limits. Assigning state.data
   directly is therefore a bug; call this instead. */
function adoptData(data) {
  state.data = data;
  setActivePlatforms(data?.platforms);
  return data;
}

/* A brand-new brief starts with whatever platforms the organization has
   turned on, rather than a hardcoded guess. */
function seedBriefPlatforms() {
  if (readDraftBrief()) return;
  const enabled = platformKeys({ enabledOnly: true, includeRetired: false });
  if (enabled.length) state.brief.platforms = enabled;
}

/* Drafting is only ever offered for platforms that are switched on and
   not retired. A brief restored from localStorage can name a platform
   that has since been removed, so it is filtered rather than trusted. */
function draftablePlatforms() {
  return listPlatforms({ enabledOnly: true, includeRetired: false });
}

function usablePlatformKeys(keys) {
  const allowed = new Set(draftablePlatforms().map((platform) => platform.key));
  return (Array.isArray(keys) ? keys : []).filter((key) => allowed.has(key));
}

/* The Pages CDN will serve a previous styles.css or app.js for a while
   after a push. A half-updated pair fails in ways that look like bugs
   in the code, so the four places the build string lives are compared
   at boot and any disagreement is said out loud. */
function checkBuild() {
  const css = getComputedStyle(document.documentElement).getPropertyValue("--build").trim().replace(/^"|"$/g, "");
  const html = document.body.dataset.build;
  if (css && html && (css !== BUILD || html !== BUILD)) {
    showBanner(
      `Mixed build detected (page ${html}, styles ${css}, script ${BUILD}). Reload with a hard refresh.`,
      { action: "Reload", onAction: () => location.reload(true) }
    );
  }
}

async function enterStudio({ silent = false } = {}) {
  el("#gate").classList.add("is-gone");
  el("#app").hidden = false;

  try {
    const { data, from } = await workspace.load();
    adoptData(data);
    if (!silent && from === "gist") toast("Workspace loaded from your gist", { kind: "good" });
  } catch (error) {
    /* A failed remote load must not lock the operator out of their own
       records — fall back to the local copy and say what happened. */
    const cached = migrateData(readCachedOrDefault());
    adoptData(cached);
    showBanner(describeError(error), { action: "Retry", onAction: () => retryLoad() });
  }

  seedBriefPlatforms();

  state.view = VIEWS[state.prefs.view] && state.prefs.view !== "editor" ? state.prefs.view : "overview";
  const fromHash = location.hash.replace("#", "");
  if (VIEWS[fromHash] && fromHash !== "editor") state.view = fromHash;

  render();
  paintSyncState(workspace.status);
}

function readCachedOrDefault() {
  try {
    const raw = localStorage.getItem("sct.workspace.v2");
    return raw ? JSON.parse(raw) : createDefaultData();
  } catch { return createDefaultData(); }
}

async function retryLoad() {
  hideBanner();
  try {
    const { data } = await workspace.load();
    adoptData(data);
    render();
    toast("Workspace reloaded", { kind: "good" });
  } catch (error) {
    showBanner(describeError(error), { action: "Retry", onAction: () => retryLoad() });
  }
}

/* ============================================================
   CHROME
   ============================================================ */

function wireChrome() {
  el("#gate-form").addEventListener("submit", onUnlock);

  el("#menu-btn").addEventListener("click", () => setDrawer(!el("#app").classList.contains("menu-open")));
  el("#scrim").addEventListener("click", () => setDrawer(false));
  el("#theme-btn").addEventListener("click", () => { toggleTheme(); state.prefs = readPrefs(); if (state.view === "settings") render(); });
  el("#lock-btn").addEventListener("click", lockStudio);
  el("#sync-pill").addEventListener("click", onSyncPill);
  el("#banner-close").addEventListener("click", hideBanner);

  /* One delegated listener per event type, on document, so markup
     written by any view is wired the moment it lands. */
  document.addEventListener("click", onClick);
  document.addEventListener("input", onInput);
  document.addEventListener("change", onChange);
  document.addEventListener("submit", onSubmit);
  document.addEventListener("keydown", onKeydown);

  window.addEventListener("hashchange", () => {
    const view = location.hash.replace("#", "");
    if (VIEWS[view] && view !== "editor" && view !== state.view) navigate(view);
  });

  /* Coming back online is the natural moment to push anything held. */
  window.addEventListener("online", () => { hideBanner(); if (workspace.dirty) workspace.flush(); });
  window.addEventListener("offline", () => showBanner("This device is offline. Changes are held here until it reconnects."));

  /* Last chance to warn before losing an unsaved edit. */
  window.addEventListener("beforeunload", (event) => {
    if (!workspace.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

async function onUnlock(event) {
  event.preventDefault();
  const input = el("#passkey");
  const button = el("#gate-btn");
  const message = el("#gate-msg");

  if (input.value !== APP_PASSKEY) {
    el("#gate-card").classList.add("is-wrong");
    setTimeout(() => el("#gate-card").classList.remove("is-wrong"), 460);
    message.className = "gate-msg";
    message.textContent = "That passkey is not right.";
    input.select();
    return;
  }

  message.className = "gate-msg is-busy";
  message.textContent = "Opening your workspace…";
  button.disabled = true;
  session.unlock();
  await enterStudio();
}

async function lockStudio() {
  if (workspace.dirty) {
    const ok = await confirmAction({
      title: "Lock with unsaved changes?",
      body: "Some edits have not reached your gist yet. They stay on this device, but locking now means they are not backed up.",
      confirmLabel: "Lock anyway"
    });
    if (!ok) return;
  }
  session.lock();
  location.reload();
}

function setDrawer(open) {
  el("#app").classList.toggle("menu-open", open);
  el("#scrim").hidden = !open;
  el("#menu-btn").setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("is-locked", open);
}

function showBanner(text, { action = "", onAction = null, kind = "" } = {}) {
  const banner = el("#banner");
  el("#banner-text").textContent = text;
  banner.className = `banner${kind ? ` is-${kind}` : ""}`;
  const button = el("#banner-action");
  button.hidden = !action;
  button.textContent = action;
  button.onclick = onAction;
  banner.hidden = false;
}

function hideBanner() { el("#banner").hidden = true; }

/* ---------- sync pill ---------------------------------------------- */

const SYNC_LOOK = {
  local:    { cls: "is-local",  icon: "cloud-off", text: "This device" },
  dirty:    { cls: "",          icon: "clock",     text: "Saving soon" },
  saving:   { cls: "is-busy",   icon: "refresh",   text: "Saving" },
  synced:   { cls: "is-synced", icon: "check",     text: "Saved" },
  conflict: { cls: "is-error",  icon: "alert",     text: "Conflict" },
  error:    { cls: "is-error",  icon: "alert",     text: "Not saved" }
};

function paintSyncState(status) {
  const look = SYNC_LOOK[status] || SYNC_LOOK.local;
  const pill = el("#sync-pill");
  pill.className = `sync-pill ${look.cls}`;
  pill.querySelector("use").setAttribute("href", `#i-${look.icon}`);
  el("#sync-text").textContent = look.text;
  pill.title = syncTitle(status);

  const dot = el("#side-mode .dot");
  const label = el("#side-mode span");
  const stamp = el("#side-stamp");
  if (dot && label && stamp) {
    dot.className = `dot ${status === "synced" ? "is-on" : status === "error" || status === "conflict" ? "is-bad" : workspace.connected ? "is-warn" : ""}`;
    label.textContent = workspace.connected ? "Gist sync" : "This device";
    stamp.textContent = workspace.connected
      ? (workspace.lastSyncedAt ? `synced ${relTime(workspace.lastSyncedAt)}` : "not synced yet")
      : "not connected";
  }

  if (status === "conflict") openConflictDialog();
  if (status === "error" && workspace.lastError) {
    showBanner(describeError(workspace.lastError), { action: "Try again", onAction: () => { hideBanner(); workspace.flush(); } });
  }
  warnIfCacheStale();
}

/* The browser refusing to write the local cache used to be swallowed
   silently, which meant a workspace could quietly stop being saved on
   this device while the interface still said "Saved". Say it once — not
   on every emit, or it would fight the error banner on every keystroke —
   and say it again if it recovers and then fails a second time. */
let cacheWarned = false;
function warnIfCacheStale() {
  if (!workspace.cacheStale) { cacheWarned = false; return; }
  if (cacheWarned || workspace.status === "error") return;
  cacheWarned = true;
  showBanner(
    "This browser is out of storage, so the offline copy on this device is no longer being updated. Your gist still has everything.",
    { kind: "warn", action: "Back up", onAction: () => { hideBanner(); exportJson(); } }
  );
}

function syncTitle(status) {
  if (status === "local") return "Not syncing. Click to connect a gist.";
  if (status === "synced") return `Saved to your gist${workspace.lastSyncedAt ? ` ${relTime(workspace.lastSyncedAt)}` : ""}. Click to pull the latest.`;
  if (status === "conflict") return "This workspace changed elsewhere. Click to resolve.";
  if (status === "error") return "The last save did not go through. Click to retry.";
  return "Saving…";
}

async function onSyncPill() {
  const status = workspace.status;
  if (status === "local") return openSyncDialog();
  if (status === "conflict") return openConflictDialog();
  if (status === "error" || status === "dirty") { hideBanner(); return workspace.flush(); }
  if (status === "saving") return;

  el("#sync-pill").classList.add("is-busy");
  try {
    const { data } = await workspace.load();
    adoptData(data);
    render();
    toast("Pulled the latest from your gist", { kind: "good" });
  } catch (error) {
    toast(describeError(error), { kind: "error" });
  }
}

/* ============================================================
   RENDER
   ============================================================ */

function render() {
  const view = VIEWS[state.view] || VIEWS.overview;
  el("#view-title").textContent = view.title;
  el("#view-sub").textContent = view.sub;
  document.title = `${view.title} · Safe Cycle Studio`;

  withFocusRetained(() => { el("#view").innerHTML = view.render(); });
  paintNav();
  paintSideModel();
}

function paintNav() {
  const active = state.view === "editor" ? "library" : state.view;
  for (const button of document.querySelectorAll("[data-nav]")) {
    button.classList.toggle("is-active", button.dataset.nav === active);
  }
  if (!state.data) return;
  const counts = countsFor(state.data);
  const library = el("#count-library");
  const queue = el("#count-queue");
  const deleted = el("#count-deleted");
  library.textContent = counts.needsReview ? String(counts.needsReview) : "";
  library.className = `nav-count${counts.needsReview ? " is-hot" : ""}`;
  /* Everything the Queue page lists, dated or not — the badge and that
     page have to agree on what "in the queue" means. */
  queue.textContent = counts.queued ? String(counts.queued) : "";
  queue.className = `nav-count${counts.overdue ? " is-hot" : ""}`;
  if (deleted) deleted.textContent = counts.deleted ? String(counts.deleted) : "";
}

function paintSideModel() {
  const credentials = readCredentials();
  const meta = PROVIDERS[credentials.provider];
  const configured = Boolean(credentials.keys[credentials.provider]);
  el("#side-model-name").textContent = configured ? credentials.models[credentials.provider] : "Not configured";
  el("#side-model-provider").textContent = configured ? meta.label : "Add a key to generate";
}

/* ============================================================
   VIEW — OVERVIEW
   ============================================================ */

function renderOverview() {
  const data = state.data;
  const counts = countsFor(data);
  const needsReview = data.posts.filter((post) => derivePostStatus(post) === "review")
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const upNext = allVariants(data)
    .filter(({ variant }) => isScheduled(variant))
    .sort((a, b) => Date.parse(a.variant.scheduledAt) - Date.parse(b.variant.scheduledAt))
    .slice(0, 5);
  const lastRun = data.runs[0];

  return `
    <section class="page-head">
      <div class="page-head-main">
        <p class="eyebrow">${esc(fmtDayHeading(new Date()))}</p>
        <h2>${greeting()}</h2>
        <p class="lede">${overviewLede(counts)}</p>
      </div>
    </section>

    <div class="stat-row">
      ${statTile("Needs review", counts.needsReview, "Drafts waiting on you", { hot: counts.needsReview > 0, nav: "library", filter: "review" })}
      ${statTile("Approved", counts.approved, "Ready to post", { nav: "queue" })}
      ${statTile("Scheduled", counts.scheduled, counts.overdue ? `${counts.overdue} past due` : "Has a date on it", { hot: counts.overdue > 0, nav: "queue" })}
      ${statTile("Published", counts.published, "Recorded posts", { nav: "library", filter: "published" })}
    </div>

    <div class="grid grid-2" style="margin-top:1.2rem">
      <section class="card">
        <header class="card-head">
          <div><h3>Waiting on you</h3><p>Nothing here publishes itself</p></div>
          <span class="spacer"></span>
          <button class="btn btn-quiet btn-sm" type="button" data-nav="library">Library ${icon("arrow-right")}</button>
        </header>
        <div class="card-body flush">
          ${needsReview.length
            ? `<div class="rows">${needsReview.slice(0, 6).map(postRow).join("")}</div>`
            : `<div class="card-body">${emptyBlock("check-circle", "All caught up", "Every draft has been reviewed. Start a new one when you are ready.")}</div>`}
        </div>
      </section>

      <section class="card">
        <header class="card-head">
          <div><h3>Up next</h3><p>Scheduled for a person to post</p></div>
          <span class="spacer"></span>
          <button class="btn btn-quiet btn-sm" type="button" data-nav="queue">Queue ${icon("arrow-right")}</button>
        </header>
        <div class="card-body flush">
          ${upNext.length
            ? `<div class="rows">${upNext.map(queueRow).join("")}</div>`
            : `<div class="card-body">${emptyBlock("calendar", "Nothing scheduled", "Pick a date on an approved draft and it shows up here.")}</div>`}
        </div>
      </section>
    </div>

    <h2 class="section-title">${icon("external")} Your platforms</h2>
    <section class="card">
      <header class="card-head">
        <div><h3>Front doors</h3><p>Open a platform to log in and paste. Nothing is posted for you.</p></div>
        <span class="spacer"></span>
        <button class="btn btn-quiet btn-sm" type="button" data-act="platform-add">${icon("plus")} Add platform</button>
        <button class="btn btn-quiet btn-sm" type="button" data-nav="settings">Manage ${icon("arrow-right")}</button>
      </header>
      <div class="card-body">
        ${launcherPlatforms().length
          ? `<div class="launcher">${launcherPlatforms().map(platformLauncher).join("")}</div>`
          : emptyBlock("external", "No platforms yet", "Add the first one and its login page is a click away from here.", { action: "Add platform", act: "platform-add" })}
      </div>
    </section>

    <h2 class="section-title">${icon("activity")} Recent activity</h2>
    <section class="card">
      <div class="card-body">
        ${lastRun ? `<ul class="notes is-info" style="margin-top:0;margin-bottom:1rem">
          <li>${icon("info")}<span>Last generation ${relTime(lastRun.at)} — ${receiptChip(lastRun, { asButton: true })}</span></li>
        </ul>` : ""}
        ${data.activity.length
          ? `<div class="detail-list">${data.activity.slice(0, 8).map((item) => `
              <div class="detail">
                <dd>${esc(item.message)} <span class="stamp"> · ${relTime(item.at)}</span></dd>
              </div>`).join("")}</div>`
          : `<p class="muted">Activity shows up here as you draft, approve, and publish.</p>`}
      </div>
    </section>`;
}

/* The platforms worth showing a front door for: switched on, not retired.
   A retired platform's login page is of no use — there is nothing new to
   post there. */
function launcherPlatforms() {
  return listPlatforms({ enabledOnly: true, includeRetired: false });
}

/* One front door.

   This exists because the Open buttons were originally only in two places:
   the bottom of a long settings page, and a draft you had already
   generated. Both are wrong for "I want to go and post something now",
   which is the whole point of keeping a link per platform. An <a> rather
   than a scripted window.open so it behaves like a link should —
   middle-click, open in new tab, copy address.

   A platform with no URL still appears, greyed, saying why. Hiding it
   would make the gap invisible exactly when the operator is wondering
   where their platform went. */
function platformLauncher(platform) {
  const label = esc(platform.label);
  const pip = `<span class="pip" style="background:${esc(platform.color)}">${esc(platform.label[0])}</span>`;
  const meta = esc(platform.blurb || platform.note || "");

  if (!platform.homeUrl) {
    return `<div class="launch is-flat" title="No link set for ${label}">
      ${pip}
      <span class="launch-main"><strong>${label}</strong><small>${meta || "No link set"}</small></span>
    </div>`;
  }

  return `<a class="launch" href="${esc(platform.homeUrl)}" target="_blank" rel="noopener noreferrer">
    ${pip}
    <span class="launch-main"><strong>${label}</strong><small>${meta}</small></span>
    ${icon("external", "launch-go")}
  </a>`;
}

function greeting() {
  const hour = new Date().getHours();
  const part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return `${part}.`;
}

function overviewLede(counts) {
  if (counts.overdue) return `${plural(counts.overdue, "scheduled post")} ${counts.overdue === 1 ? "is" : "are"} past its date. Publishing is manual, so nothing went out on its own.`;
  if (counts.needsReview) return `${plural(counts.needsReview, "draft")} waiting for your review.`;
  if (counts.approved) return `${plural(counts.approved, "approved post")} ready to copy and publish.`;
  return "Nothing is waiting. A good moment to write something new.";
}

/* A tile is only a button when there is somewhere to go. A focusable
   control that does nothing is worse than plain text. */
function statTile(label, value, note, { hot = false, nav = "", filter = "" } = {}) {
  const inner = `
    <span class="stat-label">${esc(label)}</span>
    <span class="stat-value">${value}</span>
    <span class="stat-note">${esc(note)}</span>`;
  if (!nav) return `<div class="stat${hot ? " is-hot" : ""}" style="cursor:default">${inner}</div>`;
  return `<button class="stat${hot ? " is-hot" : ""}" type="button" data-act="jump" data-jump="${esc(nav)}" data-filter-status="${esc(filter)}">${inner}</button>`;
}

function postRow(post) {
  const status = derivePostStatus(post);
  return `<button class="row" type="button" data-act="open-post" data-post="${esc(post.id)}">
    <span class="row-main">
      <span class="row-title">${esc(post.campaign)}</span>
      <span class="row-sub">${esc(firstLine(post.canonical || post.topic || post.keyMessage) || "No copy yet")}</span>
      <span class="row-meta">${pips(post.variants)}<span class="badge ${status}">${esc(STATUS_LABELS[status])}</span></span>
    </span>
    <span class="row-side"><span class="stamp">${relTime(post.updatedAt)}</span></span>
  </button>`;
}

function queueRow({ post, variant }) {
  const late = isOverdue(variant);
  return `<button class="row" type="button" data-act="open-post" data-post="${esc(post.id)}">
    <span class="row-main">
      <span class="row-title">${esc(post.campaign)}</span>
      <span class="row-sub">${esc(platformLabel(variant.platform))} · ${esc(fmtDateTime(variant.scheduledAt))}</span>
    </span>
    <span class="row-side">
      ${late ? `<span class="badge review">Past due</span>` : `<span class="stamp">${relTime(variant.scheduledAt)}</span>`}
    </span>
  </button>`;
}

/* ============================================================
   VIEW — COMPOSE
   ============================================================ */

function renderCompose() {
  const credentials = readCredentials();
  const meta = PROVIDERS[credentials.provider];
  const ready = Boolean(credentials.keys[credentials.provider]);
  const brief = state.brief;
  const ideas = topicSuggestions();

  return `
    <section class="page-head">
      <div class="page-head-main">
        <p class="eyebrow">Draft</p>
        <h2>Say what it is about. That is the whole brief.</h2>
        <p class="lede">One line is enough. The studio fills in the campaign name, the audience, and the goal from your organization profile, and tells you what it assumed. Add detail below only when you want to overrule it.</p>
      </div>
    </section>

    <div class="compose-layout">
      <form class="card" id="brief-form">
        <div class="form-step">
          <h3><span class="step-num">01</span> What is this about?</h3>
          <p>A sentence. A phrase. Whatever you would say to a colleague across the room.</p>
          <div class="field">
            <label class="sr-only" for="b-topic">What is this about?</label>
            <textarea class="textarea" id="b-topic" name="topic" maxlength="1200" rows="2"
                      placeholder="Old laptops in closets could be computers for local students" required>${esc(brief.topic)}</textarea>
          </div>
          ${ideas.length ? `
            <p class="hint chips-lead">Or start from one of these:</p>
            <div class="chips">
              ${ideas.map((idea) => `
                <button class="chip" type="button" data-act="use-topic" data-topic="${esc(idea.value)}"
                        title="${esc(idea.value)}">${esc(idea.label)}</button>`).join("")}
            </div>` : ""}
        </div>

        <div class="form-step">
          <h3><span class="step-num">02</span> Which platforms?</h3>
          <p>One independently written draft per platform, not one post copied four times. Pick <strong>Any platform</strong> for a single neutral draft you can paste anywhere.</p>
          <div class="picker">
            ${draftablePlatforms().map((platform) => {
              const on = brief.platforms.includes(platform.key);
              return `<label class="pick">
                <input type="checkbox" name="platform" value="${esc(platform.key)}" ${on ? "checked" : ""}>
                <span class="pick-body">
                  <span class="pip" style="background:${esc(platform.color)}">${esc(platform.label[0])}</span>
                  <span><strong>${esc(platform.label)}</strong><small>${esc(platform.blurb || platform.note)}</small></span>
                </span>
                <span class="pick-check">${icon("check")}</span>
              </label>`;
            }).join("")}
          </div>
          ${draftablePlatforms().length ? "" : `
            <p class="hint">No platforms are switched on. <button class="btn btn-ghost btn-sm" type="button" data-nav="settings">${icon("gear")} Open platform settings</button></p>`}
        </div>

        <div class="form-step">
          <details class="more" ${detailFilled(brief) ? "open" : ""}>
            <summary>
              <h3><span class="step-num">03</span> Add detail</h3>
              <span class="more-note">${detailFilled(brief) ? "In use" : "Optional — the model works these out"}</span>
              ${icon("chevron", "more-mark")}
            </summary>
            <div class="more-body">
              <div class="form-grid">
                <div class="field full">
                  <label for="b-must">Must include, word for word</label>
                  <input class="input" id="b-must" name="mustInclude" maxlength="300" placeholder="Saturday drop-off at the Berkeley library, 10am to 2pm" value="${esc(brief.mustInclude)}">
                  <p class="hint">A phrase, date, or detail every draft has to carry. Only things you can stand behind.</p>
                </div>
                <div class="field">
                  <label for="b-campaign">Campaign name</label>
                  <input class="input" id="b-campaign" name="campaign" maxlength="100" placeholder="The model names it" value="${esc(brief.campaign)}">
                </div>
                <div class="field">
                  <label for="b-audience">Audience</label>
                  <input class="input" id="b-audience" name="audience" maxlength="180" placeholder="The model reads it from your profile" value="${esc(brief.audience)}">
                </div>
                <div class="field full">
                  <label for="b-objective">What should this accomplish?</label>
                  <input class="input" id="b-objective" name="objective" maxlength="220" placeholder="The model infers it from the topic" value="${esc(brief.objective)}">
                </div>
                <div class="field">
                  <label for="b-cta">Call to action</label>
                  <input class="input" id="b-cta" name="cta" maxlength="240" value="${esc(brief.cta || state.data.organization.defaultCta)}">
                </div>
                <div class="field">
                  <label for="b-tone">Tone</label>
                  <select class="input" id="b-tone" name="tone">
                    ${["Neighborly and direct", "Warm and hopeful", "Educational and reassuring", "Urgent but not pushy", "Partnership-focused"]
                      .map((tone) => `<option ${brief.tone === tone ? "selected" : ""}>${esc(tone)}</option>`).join("")}
                  </select>
                </div>
                <div class="field">
                  <label for="b-when">Target date</label>
                  <input class="input" id="b-when" name="scheduledAt" type="datetime-local" value="${esc(toLocalInput(brief.scheduledAt))}">
                  <p class="hint">Puts it in the Queue once you approve it. Nothing posts on a timer.</p>
                </div>
                <div class="field">
                  <label for="b-tags">Tags</label>
                  <input class="input" id="b-tags" name="tags" maxlength="160" placeholder="laptops, back-to-school" value="${esc(brief.tags)}">
                </div>
              </div>
            </div>
          </details>
        </div>

        <div class="generate-bar">
          <button class="btn btn-primary" type="submit" ${state.generating || !ready ? "disabled" : ""}>
            ${state.generating ? `<span class="spinner"></span> Writing drafts…` : `${icon("spark")} Generate drafts`}
          </button>
          ${state.generating
            ? `<button class="btn btn-ghost" type="button" data-act="cancel-generate">Cancel</button>`
            : ""}
          <p>${ready
            ? "Output lands in review, where you can edit it, re-run it, and compare versions. Nothing is published or sent anywhere."
            : "Add a model API key under Cloud sync before generating."}</p>
        </div>
      </form>

      <aside class="compose-aside">
        <div class="aside-card">
          <h3>${icon("spark")} Model</h3>
          <p style="margin-bottom:.7rem">${ready
            ? `This run will ask <strong>${esc(credentials.models[credentials.provider])}</strong> from ${esc(meta.label)}. The receipt on the finished draft records which model actually answered.`
            : `No ${esc(meta.label)} key on this device yet.`}</p>
          <button class="btn btn-ghost btn-sm btn-block" type="button" data-act="sync-settings">${icon("gear")} ${ready ? "Change model" : "Add a key"}</button>
        </div>

        <div class="aside-card">
          <h3>What the model may say</h3>
          <p>Only your approved facts and what you type into this brief. It fills in the framing — who this is for, what it is called — and says so on the draft. It will not invent a number, a partner, or a person.</p>
          <ul class="tip-list">
            <li>${icon("check")}<span>${plural(state.data.organization.facts.length, "approved fact")} on record</span></li>
            <li>${icon("check")}<span>${plural(state.data.organization.prohibitedClaims.length, "standing rule")}</span></li>
            <li>${icon("shield")}<span>Every draft needs your approval before it counts as ready</span></li>
          </ul>
          <button class="btn btn-quiet btn-sm" type="button" data-act="jump" data-jump="settings" style="margin-top:.7rem">Edit facts and rules</button>
        </div>
      </aside>
    </div>`;
}

function emptyBrief() {
  return {
    topic: "", campaign: "", objective: "", audience: "", keyMessage: "",
    cta: "", tone: "Neighborly and direct", scheduledAt: "", tags: "", mustInclude: "",
    platforms: ["reddit", "facebook", "nextdoor"]
  };
}

/* Whether the optional section is holding anything, so it opens itself
   rather than hiding a value the operator typed on a previous visit. */
function detailFilled(brief) {
  return Boolean(brief.campaign || brief.audience || brief.objective || brief.mustInclude
    || brief.scheduledAt || brief.tags);
}

function readBriefForm() {
  const form = el("#brief-form");
  if (!form) return state.brief;
  const values = new FormData(form);
  /* The optional block lives in a <details>. A closed <details> still
     submits its fields, which is what keeps this one read of the form
     honest whether it is open or shut. */
  return {
    ...state.brief,
    topic: (values.get("topic") || "").trim(),
    campaign: (values.get("campaign") || "").trim(),
    objective: (values.get("objective") || "").trim(),
    audience: (values.get("audience") || "").trim(),
    cta: (values.get("cta") || "").trim(),
    tone: values.get("tone") || "Neighborly and direct",
    scheduledAt: fromLocalInput(values.get("scheduledAt")),
    tags: (values.get("tags") || "").trim(),
    mustInclude: (values.get("mustInclude") || "").trim(),
    platforms: values.getAll("platform")
  };
}

/* ------------------------------------------------------------
   ONE-CLICK STARTERS

   The point of the whole screen is that a post should cost a sentence,
   and the cheapest sentence is one you did not have to think of. These
   come from the organization's own approved facts — each fact is
   already a thing worth telling people, written in language the
   operator signed off on — plus a few standing asks every collection
   drive has.

   Anything that reads like something already in the library is dropped:
   suggesting last week's post back to its author is worse than
   suggesting nothing.
   ------------------------------------------------------------ */

const STANDING_IDEAS = [
  "A reminder that pickup is free and how to book one",
  "What happens to the data on a donated device",
  "The full list of what we take, working or broken"
];

function topicSuggestions() {
  const facts = (state.data.organization.facts || []).map((fact) => firstLine(fact).replace(/\s+/g, " ").trim());
  const recent = state.data.posts.slice(0, 12).map((post) => post.topic || post.canonical || "");

  /* The standing asks lead, because they are shaped like posts; the
     facts fill the rest of the row. Nothing is offered twice, and
     nothing is offered that reads like a chip already on the row or a
     post already in the library — a row of five near-identical ideas is
     no more use than one. */
  const chosen = [];
  for (const idea of [...STANDING_IDEAS, ...facts]) {
    if (!idea || chosen.length >= 5) continue;
    const tooClose = [...chosen, ...recent].some((other) => textSimilarity(idea, other) > 0.5);
    if (!tooClose) chosen.push(idea);
  }

  /* The chip is elided to keep the row readable; what it puts in the
     box is the whole thing. Inserting the elided text would send the
     model a sentence ending in an ellipsis. */
  return chosen.map((idea) => ({ value: idea, label: idea.length > 76 ? `${idea.slice(0, 73).trimEnd()}…` : idea }));
}

async function runGeneration() {
  const brief = readBriefForm();
  /* A brief restored from localStorage predates whatever the platform
     list looks like now, and the draft is kept across sessions. Filtering
     at the point of use rather than at load is deliberate: the saved
     brief is read during boot, before the workspace — and therefore the
     platform list — has been adopted. */
  brief.platforms = usablePlatformKeys(brief.platforms);
  state.brief = brief;
  writeDraftBrief(brief);

  if (!brief.platforms.length) return toast("Pick at least one platform.", { kind: "error" });
  /* The only thing the model cannot work out for itself. */
  if (!brief.topic) {
    el("#b-topic")?.focus();
    return toast("Say what the post is about — a sentence is enough.", { kind: "error" });
  }

  const credentials = readCredentials();
  state.generating = true;
  state.abort = new AbortController();
  render();

  const guidance = Object.fromEntries(brief.platforms.map((key) => [key, getPlatform(key).guidance || ""]));
  const started = nowIso();

  try {
    const { generation, receipt } = await generateDrafts({
      credentials,
      brief: { ...brief, guidance },
      organization: state.data.organization,
      /* Two different jobs read this list, and the wider bound is for
         the second one. providers.js takes the newest twelve to show the
         model what not to repeat, while voice.js searches the whole slice
         for posts a person actually wrote or edited to use as voice
         examples. Capped at twelve, a run of recent machine drafts could
         hide every good example and the prompt would ship with no
         exemplar section at all — losing the strongest signal it has. */
      recentPosts: state.data.posts.slice(0, 40),
      signal: state.abort.signal
    });

    const post = createPostFromGeneration(brief, generation, receipt);

    /* Repetition is the quiet failure mode of a small organization's
       feed, so check the new copy against what has already gone out. */
    const similar = findSimilarPosts(post.canonical, state.data.posts);
    if (similar.length) {
      post.ai.warnings.push(
        `Reads a lot like "${similar[0].post.campaign}" (${Math.round(similar[0].score * 100)}% shared wording). Worth varying before publishing.`
      );
    }
    if (generation.campaignAngle) post.ai.warnings.unshift(`Angle taken: ${generation.campaignAngle}`);

    state.data.posts.unshift(post);
    addRun(state.data, {
      at: receipt.at, status: "ok",
      provider: receipt.provider, requestedModel: receipt.requestedModel, servedModel: receipt.servedModel,
      promptVersion: receipt.promptVersion, latencyMs: receipt.latencyMs, usage: receipt.usage,
      responseId: receipt.responseId, platforms: brief.platforms, postId: post.id, campaign: post.campaign
    });
    addActivity(state.data, "generated",
      `Drafted ${brief.platforms.map(platformLabel).join(", ")} for "${post.campaign}"`, post.id);

    commit();
    clearDraftBrief();
    state.brief = emptyBrief();
    seedBriefPlatforms();
    state.postId = post.id;
    state.generating = false;
    navigate("editor");
    toast(`Drafts ready — ${receipt.servedModel || receipt.requestedModel} answered`, { kind: "good" });
  } catch (error) {
    state.generating = false;
    if (error?.name === "AbortError") { render(); return toast("Generation cancelled"); }

    addRun(state.data, {
      at: started, status: "failed",
      provider: credentials.provider, requestedModel: credentials.models[credentials.provider], servedModel: "",
      promptVersion: PROMPT_VERSION, latencyMs: 0, usage: null, responseId: "",
      platforms: brief.platforms, postId: "", campaign: brief.campaign || firstLine(brief.topic) || "(untitled)",
      error: error.message
    });
    commit();
    render();
    openErrorDialog(error);
  } finally {
    state.abort = null;
  }
}

function openErrorDialog(error, { rerun = false } = {}) {
  openModal(`
    <div class="modal-inner">
      <div class="modal-head">
        <div>
          <h2>The drafts did not come back</h2>
          <p>${esc(error.message || "Something went wrong talking to the model provider.")}</p>
        </div>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon("x")}</button>
      </div>
      <div class="modal-scroll">
        ${error.hint ? `<div class="notice is-warn">${icon("alert")}<span>${esc(error.hint)}</span></div>` : ""}
        <p class="hint">${rerun
          ? "The drafts you already had are untouched, and nothing was added to the history. This attempt is recorded in Model runs."
          : "Your brief is still on the form — nothing was lost. This attempt is recorded in Model runs."}</p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" type="button" data-act="sync-settings">${icon("gear")} Cloud sync</button>
        <span class="spacer"></span>
        <button class="btn btn-primary" type="button" data-close>${rerun ? "Back to the draft" : "Back to the brief"}</button>
      </div>
    </div>`);
}

/* ============================================================
   VIEW — LIBRARY
   ============================================================ */

function renderLibrary() {
  const { q, status, platform } = state.filters;
  const needle = q.trim().toLowerCase();

  const posts = state.data.posts
    .filter((post) => {
      const haystack = [post.campaign, post.topic, post.objective, post.audience, post.keyMessage, post.canonical,
        ...(post.tags || []), ...post.variants.map((v) => `${v.title} ${v.body} ${v.publishedUrl}`)]
        .join(" ").toLowerCase();
      const statusOk = status === "all" || derivePostStatus(post) === status;
      const platformOk = platform === "all" || post.variants.some((v) => v.platform === platform);
      return (!needle || haystack.includes(needle)) && statusOk && platformOk;
    })
    .sort(sorters[state.prefs.librarySort] || sorters.updated);

  const grid = state.prefs.libraryLayout === "grid";

  return `
    <section class="page-head">
      <div class="page-head-main">
        <p class="eyebrow">Library</p>
        <h2>${state.data.posts.length ? `${plural(posts.length, "post")}` : "Nothing yet"}</h2>
        <p class="lede">Every draft, approval, and publication this studio knows about — including posts you recorded from a platform directly.</p>
      </div>
      <button class="btn btn-ghost" type="button" data-act="record-external">${icon("link")} Record a post</button>
    </section>

    <div class="toolbar">
      <div class="search">
        ${icon("search")}
        <label class="sr-only" for="q">Search posts</label>
        <input type="search" id="q" placeholder="Search campaigns, copy, tags, links…" value="${esc(q)}" spellcheck="false">
      </div>
      <label class="sr-only" for="f-status">Status</label>
      <select class="select" id="f-status" data-filter="status">
        <option value="all">Any status</option>
        ${["review", "approved", "scheduled", "partial", "published", "archived"]
          .map((key) => `<option value="${key}" ${status === key ? "selected" : ""}>${esc(STATUS_LABELS[key])}</option>`).join("")}
      </select>
      <label class="sr-only" for="f-platform">Platform</label>
      <select class="select" id="f-platform" data-filter="platform">
        <option value="all">Any platform</option>
        ${listPlatforms().map((entry) => `<option value="${esc(entry.key)}" ${platform === entry.key ? "selected" : ""}>${esc(entry.label)}</option>`).join("")}
      </select>
      <label class="sr-only" for="f-sort">Sort</label>
      <select class="select" id="f-sort" data-pref="librarySort">
        <option value="updated" ${state.prefs.librarySort === "updated" ? "selected" : ""}>Recently updated</option>
        <option value="created" ${state.prefs.librarySort === "created" ? "selected" : ""}>Newest first</option>
        <option value="campaign" ${state.prefs.librarySort === "campaign" ? "selected" : ""}>Campaign A–Z</option>
      </select>
      <span class="spacer"></span>
      <div class="segment" role="group" aria-label="Layout">
        <button type="button" data-layout="grid" class="${grid ? "is-on" : ""}" aria-pressed="${grid}">${icon("grid")}<span class="only-wide">Cards</span></button>
        <button type="button" data-layout="list" class="${grid ? "" : "is-on"}" aria-pressed="${!grid}">${icon("list")}<span class="only-wide">List</span></button>
      </div>
    </div>

    ${posts.length
      ? (grid
        ? `<div class="post-grid">${posts.map(postCard).join("")}</div>`
        : `<div class="card"><div class="rows">${posts.map(postRow).join("")}</div></div>`)
      : (state.data.posts.length
        ? emptyBlock("search", "No matches", "Try a different search, or clear the filters.", { action: "Clear filters", act: "clear-filters" })
        : emptyBlock("inbox", "The library is empty", "Write a brief and the studio will draft a version for each platform you pick.", { action: "Start a draft", nav: "compose" }))}`;
}

const sorters = {
  updated: (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  created: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  campaign: (a, b) => a.campaign.localeCompare(b.campaign)
};

function postCard(post) {
  const status = derivePostStatus(post);
  return `<button class="post-card" type="button" data-act="open-post" data-post="${esc(post.id)}">
    <span class="post-card-top">
      ${pips(post.variants)}
      <span class="spacer"></span>
      <span class="badge ${status}">${esc(STATUS_LABELS[status])}</span>
    </span>
    <h3>${esc(post.campaign)}</h3>
    <p>${esc(post.canonical || post.topic || post.keyMessage || "No copy yet")}</p>
    <span class="post-card-foot">
      ${post.source === "external"
        ? `<span class="badge external">${icon("link")} Recorded</span>`
        : receiptChip(post.ai, { compact: true })}
      <span class="spacer"></span>
      <span>${relTime(post.updatedAt)}</span>
    </span>
  </button>`;
}

function pips(variants) {
  return `<span class="pips" aria-label="Platforms">${variants.map((variant) => {
    const meta = getPlatform(variant.platform);
    return `<span class="pip" style="background:${meta?.color || "#7d8279"}" title="${esc(meta?.label || variant.platform)}">${esc((meta?.label || "?")[0])}</span>`;
  }).join("")}</span>`;
}

/* ============================================================
   VIEW — QUEUE
   ============================================================ */

function renderQueue() {
  const items = allVariants(state.data)
    .filter(({ variant }) => isQueued(variant))
    .sort((a, b) => {
      const left = a.variant.scheduledAt ? Date.parse(a.variant.scheduledAt) : Infinity;
      const right = b.variant.scheduledAt ? Date.parse(b.variant.scheduledAt) : Infinity;
      return left - right;
    });

  const dated = items.filter(({ variant }) => variant.scheduledAt);
  const undated = items.filter(({ variant }) => !variant.scheduledAt);

  const days = new Map();
  for (const item of dated) {
    const key = item.variant.scheduledAt.slice(0, 10);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(item);
  }

  return `
    <section class="page-head">
      <div class="page-head-main">
        <p class="eyebrow">Queue</p>
        <h2>${items.length ? plural(items.length, "post") + " to publish" : "Nothing queued"}</h2>
        <p class="lede">A date here is a reminder for you, not an instruction to a machine. Nothing leaves this studio without you copying it across.</p>
      </div>
    </section>

    ${items.length ? "" : emptyBlock("calendar", "Nothing waiting", "Approve a draft and give it a date, and it appears here.", { action: "Go to the library", nav: "library" })}

    ${[...days.entries()].map(([day, group]) => `
      <section class="day">
        <header class="day-head">
          <strong>${esc(fmtDayHeading(`${day}T12:00:00`))}</strong>
          <span>${plural(group.length, "post")}</span>
          ${Date.parse(`${day}T23:59:59`) < Date.now() ? `<span class="badge review">Past due</span>` : ""}
        </header>
        ${group.map(queueItem).join("")}
      </section>`).join("")}

    ${undated.length ? `
      <section class="day">
        <header class="day-head">
          <strong>Approved, no date</strong>
          <span>${plural(undated.length, "post")}</span>
        </header>
        ${undated.map(queueItem).join("")}
      </section>` : ""}`;
}

/* A row with two ways in: the body of it opens the draft to work on,
   and the eye opens the reader.

   It is a <div> wrapping two buttons rather than one big button, because
   a button inside a button is invalid HTML — browsers drop the inner one
   and the reader would simply never open. The outer element keeps the
   card's look; the inner button carries the click. */
function queueItem({ post, variant }) {
  const meta = getPlatform(variant.platform);
  const late = isOverdue(variant);
  return `<div class="queue-item${late ? " is-late" : ""}" style="--platform:${meta?.color}">
    <button class="queue-open" type="button" data-act="open-post" data-post="${esc(post.id)}">
      <span class="pip" style="background:${meta?.color}">${esc((meta?.label || "?")[0])}</span>
      <span class="row-main">
        <span class="row-title">${esc(post.campaign)}</span>
        <span class="row-sub">${esc(firstLine(variant.body) || "No copy yet")}</span>
      </span>
    </button>
    <span class="row-side">
      <span class="badge ${variant.status}">${esc(STATUS_LABELS[variant.status])}</span>
      <span class="stamp">${variant.scheduledAt ? esc(fmtTime(variant.scheduledAt)) : "—"}</span>
      <button class="icon-btn" type="button" data-act="read-post" data-variant="${esc(variant.id)}"
              title="Read the full post">${icon("eye")}</button>
    </span>
  </div>`;
}

/* ============================================================
   VIEW — DELETED POSTS

   The bin, and the answer to "what if I decide against a post". A
   deleted post is not destroyed: it waits here for
   DELETED_RETENTION_DAYS with everything it had, and comes back whole.

   Expiry is read from the clock rather than run by a timer, because
   there is no server to run one. Opening this view is one of the
   moments the clock is read; loading the workspace is the other.
   ============================================================ */

function renderDeleted() {
  const purged = purgeExpiredDeleted(state.data);
  /* Anything the clock removed has to reach the gist too, but not from
     inside a render — a save that fires mid-paint reenters this code. */
  if (purged) queueMicrotask(() => commit());

  const entries = state.data.deleted;

  return `
    <section class="page-head">
      <div class="page-head-main">
        <p class="eyebrow">Deleted</p>
        <h2>${entries.length ? `${plural(entries.length, "post")} in the bin` : "The bin is empty"}</h2>
        <p class="lede">Deleting a post moves it here for ${DELETED_RETENTION_DAYS} days with everything it had — every platform version, its receipt, and its publication record. Restore it in that time and nothing is lost. After that it is removed for good, wherever you next open the studio.</p>
      </div>
      ${entries.length ? `<button class="btn btn-ghost" type="button" data-act="empty-bin">${icon("trash")} Empty the bin</button>` : ""}
    </section>

    ${entries.length
      ? `<div class="card"><div class="rows">${entries.map(deletedRow).join("")}</div></div>`
      : emptyBlock("trash", "Nothing deleted",
          `Posts you delete wait here for ${DELETED_RETENTION_DAYS} days before they are removed for good.`,
          { action: "Go to the library", nav: "library" })}`;
}

function deletedRow(entry) {
  const left = deletionDaysLeft(entry);
  const status = derivePostStatus(entry);

  return `<div class="row is-static">
    <span class="row-main">
      <span class="row-title">${esc(entry.campaign)}</span>
      <span class="row-sub">${esc(firstLine(entry.canonical || entry.topic) || "No copy")}</span>
      <span class="row-meta">
        ${pips(entry.variants)}
        <span class="badge ${status}">${esc(STATUS_LABELS[status])}</span>
        <span class="stamp">Deleted ${relTime(entry.deletedAt)}</span>
      </span>
    </span>
    <span class="row-side">
      <span class="badge ${left <= 3 ? "review" : "draft"}" title="Removed for good on ${esc(fmtDateTime(deletionExpiresAt(entry)))}">
        ${left === 0 ? "Gone today" : plural(left, "day")} left
      </span>
      ${entry.variants.length
        ? `<button class="icon-btn" type="button" data-act="read-post" data-variant="${esc(entry.variants[0].id)}" title="Read the full post">${icon("eye")}</button>`
        : ""}
      <button class="btn btn-soft btn-sm" type="button" data-act="restore-post" data-post="${esc(entry.id)}">${icon("undo")} Restore</button>
      <button class="btn btn-quiet btn-sm" type="button" data-act="purge-post" data-post="${esc(entry.id)}" title="Remove this permanently, now">${icon("trash")}</button>
    </span>
  </div>`;
}

/* ============================================================
   VIEW — MODEL RUNS

   The user-facing answer to "which model wrote this, really". Every
   generation, successful or not, lands here with what was asked for,
   what answered, how long it took, and what it cost in tokens.
   ============================================================ */

function renderRuns() {
  const runs = state.data.runs;
  const ok = runs.filter((run) => run.status === "ok");
  const swapped = ok.filter((run) => run.servedModel && !modelsMatch(run.requestedModel, run.servedModel));
  const tokens = ok.reduce((sum, run) => sum + (run.usage?.total || 0), 0);
  const median = medianOf(ok.map((run) => run.latencyMs).filter(Boolean));

  return `
    <section class="page-head">
      <div class="page-head-main">
        <p class="eyebrow">Audit</p>
        <h2>Every model call, on the record</h2>
        <p class="lede">What was requested, what actually answered, and what it cost. Providers resolve aliases to dated snapshots, and occasionally serve something else entirely — this is where you would see that.</p>
      </div>
    </section>

    <div class="stat-row">
      ${statTile("Runs recorded", runs.length, `${runs.length - ok.length} failed`)}
      ${statTile("Model swaps", swapped.length, swapped.length ? "A different model answered" : "Every run matched", { hot: swapped.length > 0 })}
      ${statTile("Tokens used", tokens ? formatCompact(tokens) : "—", "Across successful runs")}
      ${statTile("Typical latency", median ? `${(median / 1000).toFixed(1)}s` : "—", "Median round trip")}
    </div>

    <h2 class="section-title">${icon("history")} History</h2>
    ${runs.length ? `
      <div class="table-wrap">
        <table class="log">
          <thead><tr>
            <th>When</th><th>Campaign</th><th>Asked for</th><th>Answered</th><th>Platforms</th><th>Latency</th><th>Tokens</th><th></th>
          </tr></thead>
          <tbody>
            ${runs.map((run) => `
              <tr>
                <td><span class="stamp" title="${esc(fmtDateTime(run.at))}">${relTime(run.at)}</span></td>
                <td>${run.postId
                  ? `<button class="linkish" type="button" data-act="open-post" data-post="${esc(run.postId)}">${esc(run.campaign || "Untitled")}</button>`
                  : esc(run.campaign || "Untitled")}</td>
                <td class="num">${esc(run.requestedModel || "—")}</td>
                <td>${run.status === "ok" ? receiptChip(run) : `<span class="badge review">${icon("alert")} Failed</span>`}</td>
                <td class="num">${esc((run.platforms || []).map((key) => getPlatform(key).label).join(", ") || "—")}</td>
                <td class="num">${run.latencyMs ? `${(run.latencyMs / 1000).toFixed(1)}s` : "—"}</td>
                <td class="num">${run.usage?.total ? formatCompact(run.usage.total) : "—"}</td>
                <td><button class="icon-btn" type="button" data-act="run-detail" data-run="${esc(run.id)}" aria-label="Run detail">${icon("eye")}</button></td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`
      : emptyBlock("activity", "No runs yet", "Generate a draft and the full receipt shows up here.", { action: "Start a draft", nav: "compose" })}`;
}

function medianOf(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function formatCompact(value) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/* ---------- the receipt chip, used in five places ------------------- */

function receiptChip(ai, { compact = false, asButton = false } = {}) {
  const kind = receiptState(ai);
  const label = {
    ok: ai?.servedModel,
    swapped: ai?.servedModel,
    unknown: ai?.requestedModel || "model not recorded",
    manual: "posted by hand"
  }[kind];
  const glyph = { ok: "check-circle", swapped: "alert", unknown: "info", manual: "link" }[kind];
  const title = {
    ok: `${ai?.providerLabel || ai?.provider || ""} served ${ai?.servedModel} — the model that was requested.`,
    swapped: `Requested ${ai?.requestedModel}, but ${ai?.servedModel} answered.`,
    unknown: "The provider did not report which model answered.",
    manual: "Recorded from a platform; no model was involved."
  }[kind];

  const inner = `${icon(glyph)}<span>${esc(compact && label ? shortModel(label) : label || "—")}</span>`;
  return asButton || !compact
    ? `<button class="receipt is-${kind}" type="button" data-act="receipt" data-receipt='${esc(JSON.stringify(ai || {}))}' title="${esc(title)}">${inner}</button>`
    : `<span class="receipt is-${kind}" title="${esc(title)}">${inner}</span>`;
}

/* A dated snapshot id is long and the date is the least useful part of
   it at a glance, so cards show the family and the tooltip has it all. */
function shortModel(model) {
  return String(model).replace(/-\d{8}$/, "");
}

function openReceiptDialog(ai) {
  const kind = receiptState(ai);
  const rows = [
    ["Provider", PROVIDERS[ai.provider]?.label || ai.providerLabel || ai.provider || "—"],
    ["Model requested", ai.requestedModel || "—"],
    ["Model that answered", ai.servedModel || "not reported"],
    ["Prompt version", ai.promptVersion || "—"],
    ["Response id", ai.responseId || "—"],
    ["Generated", ai.at ? fmtDateTime(ai.at) : "—"],
    ["Round trip", ai.latencyMs ? `${(ai.latencyMs / 1000).toFixed(2)}s` : "—"],
    ["Input tokens", ai.usage?.input ? ai.usage.input.toLocaleString() : "—"],
    ["Output tokens", ai.usage?.output ? ai.usage.output.toLocaleString() : "—"]
  ];

  if (ai.error) rows.push(["Error", ai.error]);

  const explain = ai.status === "failed"
    ? "This run did not produce drafts. It is kept so the failure is on record rather than only in a toast that has since gone."
    : {
      ok: "The model that answered is the model that was requested. An alias resolving to a dated snapshot counts as a match.",
      swapped: "A different model answered than the one requested. That can be a provider fallback or an account-level routing rule. Anything written by this run should be re-read before it goes out.",
      unknown: "This provider did not report which model produced the reply, so the studio cannot confirm it. Older posts recorded before receipts existed also land here.",
      manual: "This post was written and published by a person, with no model involved."
    }[kind];

  openModal(`
    <div class="modal-inner">
      <div class="modal-head">
        <div>
          <h2>Model receipt</h2>
          <p>${esc(explain)}</p>
        </div>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon("x")}</button>
      </div>
      <div class="modal-scroll">
        <dl class="receipt-sheet">
          ${rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join("")}
        </dl>
      </div>
      <div class="modal-foot"><span class="spacer"></span><button class="btn btn-primary" type="button" data-close>Close</button></div>
    </div>`, { size: "sm" });
}

/* ============================================================
   VIEW — EDITOR
   ============================================================ */

function renderEditor() {
  const post = currentPost();
  if (!post) { queueMicrotask(() => navigate("library")); return ""; }
  const status = derivePostStatus(post);

  return `
    <section class="editor-head">
      <div class="page-head-main">
        <button class="crumb" type="button" data-nav="library">${icon("chevron", "")} Library</button>
        <h2>${esc(post.campaign)}</h2>
        <p class="lede">${esc(post.objective || "Review each platform version, approve it, then publish it yourself.")}</p>
        <div class="row-meta">
          <span class="badge ${status}">${esc(STATUS_LABELS[status])}</span>
          ${post.source === "external" ? `<span class="badge external">${icon("link")} Recorded from platform</span>` : receiptChip(post.ai)}
          <span class="stamp">Updated ${relTime(post.updatedAt)}</span>
        </div>
      </div>
    </section>

    <div class="split">
      <div class="editor-main">
        ${post.ai.warnings.length ? `
          <ul class="notes">
            ${post.ai.warnings.map((note) => `<li>${icon("alert")}<span>${esc(note)}</span></li>`).join("")}
          </ul>` : ""}

        ${canonicalCard(post)}

        ${post.variants.map((variant) => variantCard(post, variant)).join("")}
      </div>

      <aside class="editor-side">
        ${briefCard(post)}

        <div class="card">
          <div class="card-body">
            <div class="btn-row">
              <button class="btn btn-soft btn-block" type="button" data-act="approve-all">${icon("check")} Approve every draft</button>
            </div>
            <div class="btn-row btn-row-tight">
              <button class="btn btn-ghost btn-sm" type="button" data-act="duplicate">${icon("copy")} Duplicate</button>
              <button class="btn btn-ghost btn-sm" type="button" data-act="export-post">${icon("download")} Export</button>
              <button class="btn btn-ghost btn-sm" type="button" data-act="archive">${icon("archive")} ${post.status === "archived" ? "Restore" : "Archive"}</button>
              <button class="btn btn-ghost btn-sm" type="button" data-act="delete-post">${icon("trash")} Delete</button>
            </div>
          </div>
        </div>
      </aside>
    </div>`;
}

/* THE SHARED MESSAGE, and the two buttons that make it worth editing.

   It reads like a system prompt, and after this change it behaves like
   one: edit it, press Re-run drafts, and every platform version is
   rewritten from it. That is only safe because the run before it is
   kept — see snapshotGeneration in js/data.js — so History is next to
   the button rather than buried in a menu. */
function canonicalCard(post) {
  const versions = generationCount(post);
  const rerunnable = post.variants.some((variant) => variant.status !== "published");

  return `<section class="card canonical">
    <header class="card-head">
      <div>
        <h3>Shared message</h3>
        <p>The spine every platform version is written from. Never published anywhere itself.</p>
      </div>
      <span class="spacer"></span>
      <button class="btn btn-quiet btn-sm" type="button" data-act="draft-history">
        ${icon("history")} History${versions ? ` <span class="count-pip">${versions}</span>` : ""}
      </button>
      <button class="btn btn-soft btn-sm" type="button" data-act="rerun-drafts" ${rerunnable && !state.rerunning ? "" : "disabled"}
              title="${rerunnable ? "Rewrite every unpublished version from this message" : "Every version here is published, so there is nothing to rewrite"}">
        ${state.rerunning ? `<span class="spinner"></span> Re-running…` : `${icon("refresh")} Re-run drafts`}
      </button>
    </header>
    <div class="card-body">
      <div class="field">
        <label class="sr-only" for="canonical">Shared message</label>
        <textarea class="textarea" id="canonical" data-post-field="canonical"
                  placeholder="The message all platforms share">${esc(post.canonical)}</textarea>
        <p class="hint">Edit this and press <strong>Re-run drafts</strong> to rewrite the platform versions from it. Every run is kept, so you can compare them and go back to the one you liked. Edits here save on their own.</p>
      </div>
    </div>
  </section>`;
}

/* Only the rows that carry something. A column of "Not recorded" reads
   like missing data when in fact a hand-recorded post simply never had
   a brief.

   A row the MODEL filled in says so. The brief is one line now, and the
   rest of it is the model's reading of that line — presenting its guess
   at the audience in the same voice as something the operator typed
   would be the app quietly putting words in their mouth. */
function briefCard(post) {
  const derived = new Set(post.derived || []);
  const rows = [
    ["Topic", post.topic || post.keyMessage, false],
    ["Audience", post.audience, derived.has("audience")],
    ["Goal", post.objective, derived.has("objective")],
    ["Tags", (post.tags || []).map((tag) => `#${tag}`).join(" "), false],
    ["Created", fmtDateTime(post.createdAt), false],
    ["Account", post.variants.map((variant) => variant.account).find(Boolean) || "", false]
  ].filter(([, value]) => value);

  return `<div class="card">
    <header class="card-head">
      <div>
        <h3>${post.source === "external" ? "Record" : "Brief"}</h3>
        <p>${post.source === "external" ? "Written and published by hand" : "What this was written for"}</p>
      </div>
    </header>
    <div class="card-body">
      <dl class="detail-list">
        ${rows.map(([label, value, guessed]) => `<div class="detail">
          <dt>${esc(label)}${guessed ? `<span class="dt-tag" title="You left this blank, so the model filled it in from your organization profile">model's read</span>` : ""}</dt>
          <dd>${esc(value)}</dd>
        </div>`).join("")}
      </dl>
      ${derived.size ? `<p class="hint">Blank fields are filled in by the model and can be overruled on the next brief.</p>` : ""}
    </div>
  </div>`;
}

function variantCard(post, variant) {
  const meta = getPlatform(variant.platform);
  const published = variant.status === "published";

  return `<article class="variant${published ? " is-published" : ""}" id="v-${esc(variant.id)}">
    <header class="variant-head">
      <span class="pip" style="background:${meta.color}">${esc(meta.label[0])}</span>
      <h3>${esc(meta.label)}</h3>
      <span class="badge ${variant.status}">${esc(STATUS_LABELS[variant.status])}</span>
    </header>

    <div class="variant-body">
      ${meta.titleMax ? `
        <div class="field">
          <label for="t-${esc(variant.id)}">Title</label>
          <input class="input" id="t-${esc(variant.id)}" data-variant="${esc(variant.id)}" data-field="title"
                 value="${esc(variant.title)}" maxlength="${meta.titleMax}" ${published ? "readonly" : ""}>
          ${meterFor(variant.title.length, meta.titleMax)}
        </div>` : ""}

      <div class="field">
        <label for="b-${esc(variant.id)}">Post copy</label>
        <textarea class="textarea body-text" id="b-${esc(variant.id)}" data-variant="${esc(variant.id)}" data-field="body"
                  ${published ? "readonly" : ""}>${esc(variant.body)}</textarea>
        <div id="meta-${esc(variant.id)}">${variantMeta(variant)}</div>
      </div>

      <div class="field">
        <label for="h-${esc(variant.id)}">Hashtags</label>
        <input class="input" id="h-${esc(variant.id)}" data-variant="${esc(variant.id)}" data-field="hashtags"
               value="${esc((variant.hashtags || []).join(", "))}" placeholder="ewaste, bayarea" ${published ? "readonly" : ""}>
        <p class="hint">Commas here; the studio adds the # and puts them at the end of the post below.</p>
      </div>

      ${readyBlock(variant, meta)}

      <div class="field">
        <label for="s-${esc(variant.id)}">Planned date</label>
        <input class="input" id="s-${esc(variant.id)}" type="datetime-local" data-variant="${esc(variant.id)}" data-field="scheduledAt"
               value="${esc(toLocalInput(variant.scheduledAt))}" ${published ? "readonly" : ""}>
        <p class="hint">A reminder for you. It puts this in the Queue; nothing posts on a timer.</p>
      </div>

      ${variant.notes ? `<ul class="notes is-info"><li>${icon("info")}<span>${esc(variant.notes)}</span></li></ul>` : ""}

      <div class="actions">
        ${published
          ? `<button class="btn btn-ghost btn-sm" type="button" data-act="publish" data-variant="${esc(variant.id)}">${icon("pencil")} Edit record</button>`
          : `
            <button class="btn btn-ghost btn-sm" type="button" data-act="toggle-approve" data-variant="${esc(variant.id)}">
              ${variant.status === "draft" ? `${icon("check")} Approve` : "Back to draft"}
            </button>
            ${variant.status !== "draft" ? `<button class="btn btn-ghost btn-sm" type="button" data-act="schedule" data-variant="${esc(variant.id)}">
              ${icon("calendar")} ${variant.status === "scheduled" ? "Reschedule" : "Schedule"}
            </button>` : ""}
            <span class="spacer"></span>
            <button class="btn btn-copper btn-sm" type="button" data-act="publish" data-variant="${esc(variant.id)}">
              ${icon("check-circle")} Mark published
            </button>`}
      </div>

      ${variant.publishedUrl && safeUrl(variant.publishedUrl) ? `
        <div class="published-link">
          ${icon("link")}
          <a href="${esc(safeUrl(variant.publishedUrl))}" target="_blank" rel="noopener noreferrer">${esc(variant.publishedUrl)}</a>
          <span class="spacer"></span>
          <span class="stamp">${esc(fmtDateTime(variant.publishedAt))}</span>
        </div>` : published ? `
        <div class="published-link">${icon("check")}<span>Published ${esc(fmtDateTime(variant.publishedAt))} — no link recorded</span></div>` : ""}
    </div>
  </article>`;
}

/* THE POST, EXACTLY AS IT WILL BE PASTED.

   Hashtags are typed as a comma-separated list because that is the sane
   way to edit them, but they are PUBLISHED as "#one #two" at the end of
   the post — and nothing on the page used to show that, so the copy
   button's output was a surprise. This block is the resolution: it is
   built by the same buildCopyText() that fills the clipboard and that
   gets frozen as publishedBody, so what is shown here cannot drift from
   what is copied.

   It also carries the one copy button. There used to be three overlapping
   controls at the bottom of the card — Copy, "Copy for pasting" (the
   Open button with no link to open), and "Model's original" — and no way
   to tell from the labels which one put the post on the clipboard.
   Now: one primary Copy post, here, against the text it copies. */
function readyBlock(variant, meta) {
  return `<section class="ready" aria-label="Ready to paste">
    <header class="ready-head">
      <div>
        <h4>${icon("check-circle")} Ready to paste</h4>
        <small>Post copy and hashtags together — exactly what the button gives you</small>
      </div>
      <span class="spacer"></span>
      <button class="btn btn-primary btn-sm" type="button" data-act="copy" data-variant="${esc(variant.id)}">
        ${icon("copy")} Copy post
      </button>
    </header>
    <div id="ready-${esc(variant.id)}">${readyBody(variant, meta)}</div>
  </section>`;
}

/* Patched on every keystroke, so it is deliberately the only part that
   changes: rebuilding the header would take the copy button out from
   under the pointer mid-click.

   The second button goes somewhere rather than doing the same thing
   under another name — and it only exists when there is somewhere to
   go. A platform with no link (the neutral "Any platform", or one just
   added) shows the copy button alone. */
function readyBody(variant, meta) {
  const text = buildCopyText(variant);
  return `
    <pre class="ready-text">${esc(text) || `<span class="muted">Nothing to copy yet.</span>`}</pre>
    <footer class="ready-foot">
      <span class="stamp">${plural(text.length, "character")}</span>
      <span class="spacer"></span>
      <button class="btn btn-quiet btn-sm" type="button" data-act="read-post" data-variant="${esc(variant.id)}"
              title="Open the whole post in a reading window">
        ${icon("eye")} Read full post
      </button>
      ${meta.homeUrl ? `<button class="btn btn-quiet btn-sm" type="button" data-act="open-platform" data-variant="${esc(variant.id)}"
              title="Copies this post, then opens ${esc(meta.label)} in a new tab so you can log in and paste it">
        ${icon("external")} Open ${esc(meta.label)}
      </button>` : ""}
    </footer>`;
}

/* Everything under a body textarea that has to update while typing.
   Kept in one node so the caret above it is never disturbed. */
function variantMeta(variant) {
  const meta = getPlatform(variant.platform);
  const checks = variantChecks(variant);
  return `
    ${meterFor(variant.body.length, meta.bodyMax, meta.soft)}
    ${checks.length ? `<ul class="notes">${checks.map((check) =>
      `<li>${icon(check.level === "error" ? "alert" : "info")}<span>${esc(check.text)}</span></li>`).join("")}</ul>` : ""}`;
}

function meterFor(length, max, soft = 0) {
  const limit = soft || max;
  const ratio = Math.min(1, length / limit);
  const level = length > max ? "is-over" : soft && length > soft ? "is-warn" : "";
  return `<div class="meter ${level}">
    <span class="meter-track"><span class="meter-fill" style="width:${(ratio * 100).toFixed(1)}%"></span></span>
    <span>${length.toLocaleString()}${soft ? ` / ~${soft.toLocaleString()}` : ` / ${max.toLocaleString()}`}</span>
  </div>`;
}

/* ============================================================
   VIEW — SETTINGS
   ============================================================ */

function renderSettings() {
  const org = state.data.organization;
  const credentials = readCredentials();
  const theme = currentTheme();

  return `
    <section class="page-head">
      <div class="page-head-main">
        <p class="eyebrow">Settings</p>
        <h2>How the studio works</h2>
        <p class="lede">The organization profile and platform defaults travel with the workspace. Credentials and appearance stay on this device.</p>
      </div>
    </section>

    <div class="split">
      <div>
        <section class="card">
          <header class="card-head">
            <div><h3>Platforms</h3><p>Your list. Switch on what you use, add anything missing.</p></div>
            <span class="spacer"></span>
            <button class="btn btn-primary btn-sm" type="button" data-act="platform-add">${icon("plus")} Add platform</button>
          </header>
          <div class="card-body">
            <ol class="workflow">
              <li>Draft a post for the platform, then review and approve it.</li>
              <li>Press <strong>Copy</strong> to put the approved text on the clipboard.</li>
              <li>Press <strong>Open</strong> to go to the platform and log in.</li>
              <li>Paste it, check it over, and publish it yourself.</li>
            </ol>

            ${listPlatforms().map((platform) => platformRow(platform)).join("")}

            <p class="hint" style="margin-top:.8rem">
              This studio never posts anything anywhere. It writes the copy, checks it, keeps the record,
              and opens the platform's own page so you can paste it in yourself.
            </p>
          </div>
        </section>

        <form class="card" id="org-form" style="margin-top:1rem">
          <header class="card-head"><div><h3>Organization</h3><p>Standing context for every draft</p></div></header>
          <div class="card-body">
            <div class="form-grid">
              <div class="field"><label for="o-name">Name</label><input class="input" id="o-name" name="name" value="${esc(org.name)}" required></div>
              <div class="field"><label for="o-site">Website</label><input class="input" id="o-site" name="website" type="url" value="${esc(org.website)}"></div>
              <div class="field full"><label for="o-area">Service area</label><input class="input" id="o-area" name="serviceArea" value="${esc(org.serviceArea)}"></div>
              <div class="field full"><label for="o-mission">Mission</label><textarea class="textarea" id="o-mission" name="mission" required>${esc(org.mission)}</textarea></div>
              <div class="field full"><label for="o-voice">Voice</label><input class="input" id="o-voice" name="voice" value="${esc(org.voice)}"></div>
              <div class="field full"><label for="o-cta">Default call to action</label><input class="input" id="o-cta" name="defaultCta" value="${esc(org.defaultCta)}"></div>
            </div>

            <div class="field">
              <label for="o-facts">Approved facts</label>
              <textarea class="textarea tall" id="o-facts" name="facts">${esc(org.facts.join("\n"))}</textarea>
              <p class="hint">One per line. The model may state these and nothing else. Only add claims you are comfortable publishing exactly as written.</p>
            </div>

            <div class="field">
              <label for="o-rules">Standing rules</label>
              <textarea class="textarea" id="o-rules" name="prohibitedClaims" style="min-height:150px">${esc(org.prohibitedClaims.join("\n"))}</textarea>
              <p class="hint">One per line. Guardrails for privacy, accuracy, and responsible outreach.</p>
            </div>

            <button class="btn btn-primary" type="submit">Save organization</button>
          </div>
        </form>

      </div>

      <aside>
        <section class="card">
          <header class="card-head"><div><h3>Cloud sync</h3><p>${workspace.connected ? "Connected" : "Not connected"}</p></div></header>
          <div class="card-body">
            <dl class="facts">
              <dt>Workspace</dt><dd>${workspace.connected ? `gist ${esc(credentials.gistId.slice(0, 10))}…` : "This device only"}</dd>
              <dt>GitHub token</dt><dd>${esc(fingerprint(credentials.githubToken))}</dd>
              <dt>Model</dt><dd>${credentials.keys[credentials.provider] ? esc(credentials.models[credentials.provider]) : "not configured"}</dd>
              <dt>Revision</dt><dd>${state.data.revision}</dd>
            </dl>
            <div class="btn-row" style="margin-top:.9rem">
              <button class="btn btn-primary btn-sm" type="button" data-act="sync-settings">${icon("gear")} ${workspace.connected ? "Manage" : "Connect"}</button>
              ${workspace.connected ? `<button class="btn btn-ghost btn-sm" type="button" data-act="history">${icon("history")} Versions</button>` : ""}
            </div>
          </div>
        </section>

        <section class="card" style="margin-top:1rem">
          <header class="card-head"><div><h3>Appearance</h3><p>This device only</p></div></header>
          <div class="card-body">
            <div class="segment" role="group" aria-label="Theme" style="width:100%">
              ${THEMES.map((option) => `
                <button type="button" data-theme="${option}" class="${theme === option ? "is-on" : ""}" aria-pressed="${theme === option}" style="flex:1">
                  ${icon(option === "system" ? "system" : option === "light" ? "sun" : "moon")}
                  ${option[0].toUpperCase() + option.slice(1)}
                </button>`).join("")}
            </div>
          </div>
        </section>

        <section class="card" style="margin-top:1rem">
          <header class="card-head"><div><h3>Data</h3><p>Backups and transfer</p></div></header>
          <div class="card-body">
            <div class="btn-row">
              <button class="btn btn-ghost btn-sm" type="button" data-act="export-json">${icon("download")} Backup .json</button>
              <button class="btn btn-ghost btn-sm" type="button" data-act="export-md">${icon("download")} Records .md</button>
              <button class="btn btn-ghost btn-sm" type="button" data-act="import">${icon("upload")} Import .json</button>
              <input type="file" id="import-file" accept="application/json,.json" hidden>
            </div>
            <p class="hint" style="margin-top:.7rem">The <code>.json</code> is a complete backup and can be imported again. The <code>.md</code> is a readable publication record — every post, where it went, and when.</p>
          </div>
        </section>

        <section class="card" style="margin-top:1rem">
          <header class="card-head"><div><h3>Danger</h3><p>Both are hard to undo</p></div></header>
          <div class="card-body">
            <div class="btn-row">
              <button class="btn btn-ghost btn-sm" type="button" data-act="forget-device">${icon("signout")} Forget credentials</button>
              <button class="btn btn-danger btn-sm" type="button" data-act="reset">${icon("trash")} Reset workspace</button>
            </div>
            <p class="hint" style="margin-top:.7rem">Forgetting credentials clears the token and API keys from this browser and leaves the gist untouched. Resetting replaces every post and setting — export a backup first.</p>
          </div>
        </section>

        <section class="card" style="margin-top:1rem">
          <div class="card-body">
            <dl class="facts">
              <dt>Build</dt><dd class="mono">${esc(BUILD)}</dd>
              <dt>Schema</dt><dd class="mono">${state.data.schemaVersion}</dd>
              <dt>Prompt</dt><dd class="mono">${esc(PROMPT_VERSION)}</dd>
            </dl>
            <button class="btn btn-quiet btn-sm" type="button" data-act="shortcuts" style="margin-top:.7rem">Keyboard shortcuts</button>
          </div>
        </section>
      </aside>
    </div>`;
}

/* One row in Settings → Platforms.

   The Open button is the whole point of the row: it is the operator's
   route to the platform, and it is deliberately identical for a built-in
   platform and one added five minutes ago. A platform with no URL gets a
   disabled button with a reason rather than a hidden one, so the fix
   ("give it a link") is discoverable from where the gap shows up.

   Retired platforms — a platform removed while old posts still reference
   it — are shown greyed out and cannot be switched on. They exist so the
   history stays readable; see migratePlatforms in js/data.js. */
function platformRow(platform) {
  const usedBy = platformUsage(platform.key);
  const link = platform.homeUrl;
  return `<div class="platform-row${platform.retired ? " is-retired" : ""}">
    <label class="toggle-row">
      <input type="checkbox" data-platform="${esc(platform.key)}" ${platform.enabled ? "checked" : ""} ${platform.retired ? "disabled" : ""}>
      <span class="pip" style="background:${esc(platform.color)}">${esc(platform.label[0])}</span>
      <span class="toggle-main">
        <strong>${esc(platform.label)}</strong>
        <small>${esc(platform.retired ? "Removed from your list. Kept because posts still reference it." : platform.note || platform.blurb)}</small>
      </span>
      <span class="switch"></span>
    </label>
    <div class="platform-actions">
      ${link
        ? `<a class="btn btn-ghost btn-sm" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${icon("external")} Open</a>`
        : `<button class="btn btn-ghost btn-sm" type="button" disabled title="Add a home page or login link to enable this">${icon("external")} Open</button>`}
      <button class="btn btn-quiet btn-sm" type="button" data-act="platform-edit" data-platform-key="${esc(platform.key)}">${icon("pencil")} Edit</button>
      <button class="btn btn-quiet btn-sm" type="button" data-act="platform-remove" data-platform-key="${esc(platform.key)}">${icon("trash")} Remove</button>
      ${usedBy ? `<span class="stamp">${esc(plural(usedBy, "post"))}</span>` : ""}
    </div>
  </div>`;
}

/* How many recorded variants point at this platform. Drives the removal
   warning, because removing a platform that carries history is a very
   different decision from removing one that never got used.

   Posts in the bin are counted. They can be restored for thirty days,
   and a restored post whose platform was deleted in the meantime would
   reference a key the list no longer has — which is a workspace that
   fails validation and therefore stops saving. Counting them here means
   such a platform is retired instead of removed, and the record holds. */
function platformUsage(key) {
  const live = allVariants(state.data).filter(({ variant }) => variant.platform === key).length;
  const binned = state.data.deleted
    .flatMap((entry) => entry.variants)
    .filter((variant) => variant.platform === key).length;
  return live + binned;
}

/* ============================================================
   DIALOGS
   ============================================================ */

/* Add or edit a platform. One dialog for both, because the fields are the
   same and two nearly-identical forms drift apart.

   The key is generated from the name on create and then frozen: recorded
   posts reference it, so letting it change would orphan history. The name
   stays editable — renaming "Nextdoor" to "Nextdoor (Mission)" must not
   touch a single stored post. */
function openPlatformDialog(key = "") {
  const existing = key ? listPlatforms().find((platform) => platform.key === key) : null;
  const platform = existing || normalizePlatform({ enabled: true, bodyMax: 5000, soft: 1000 });
  const editing = Boolean(existing);

  openModal(`
    <form class="modal-inner" id="platform-form" data-platform-key="${esc(editing ? platform.key : "")}">
      <div class="modal-head">
        <div>
          <h2>${editing ? `Edit ${esc(platform.label)}` : "Add a platform"}</h2>
          <p>Nothing here publishes for you. A platform is a name, the limits to check copy against, and a link to its own page so you can go and paste.</p>
        </div>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon("x")}</button>
      </div>

      <div class="modal-scroll">
        <div class="form-grid">
          <div class="field">
            <label for="pf-label">Name</label>
            <input class="input" id="pf-label" name="label" value="${esc(platform.label === "Untitled" ? "" : platform.label)}"
                   placeholder="Mastodon" required ${editing ? "" : "data-autofocus"}>
          </div>
          <div class="field">
            <label for="pf-home">Home page or login link</label>
            <input class="input" id="pf-home" name="homeUrl" type="url" value="${esc(platform.homeUrl)}"
                   placeholder="https://mastodon.social/">
            <p class="hint">Where the Open button takes you. Leave blank if there is no single page.</p>
          </div>
          <div class="field">
            <label for="pf-color">Colour</label>
            <input class="input" id="pf-color" name="color" type="color" value="${esc(/^#[0-9a-f]{6}$/i.test(platform.color) ? platform.color : "#7d8279")}">
          </div>
          <div class="field">
            <label for="pf-soft">Aim for (characters)</label>
            <input class="input" id="pf-soft" name="soft" type="number" min="0" step="50" value="${platform.soft}">
            <p class="hint">Where the studio starts nudging. 0 to never nudge.</p>
          </div>
          <div class="field">
            <label for="pf-max">Hard limit (characters)</label>
            <input class="input" id="pf-max" name="bodyMax" type="number" min="1" step="100" value="${platform.bodyMax}">
            <p class="hint">The platform's real ceiling. Going over blocks approval.</p>
          </div>
          <div class="field">
            <label for="pf-title">Title limit (characters)</label>
            <input class="input" id="pf-title" name="titleMax" type="number" min="0" step="10" value="${platform.titleMax}">
            <p class="hint">0 if this platform has no separate title. Reddit uses 300.</p>
          </div>
          <div class="field full">
            <label for="pf-note">Reminder to yourself</label>
            <input class="input" id="pf-note" name="note" value="${esc(platform.note)}"
                   placeholder="Post from the Page, not a personal profile.">
          </div>
          <div class="field full">
            <label for="pf-guidance">How posts here should read</label>
            <textarea class="textarea" id="pf-guidance" name="guidance" placeholder="Neighborly, concrete, and never pushy.">${esc(platform.guidance)}</textarea>
            <p class="hint">Passed to the model when it drafts for this platform.</p>
          </div>
        </div>
      </div>

      <div class="modal-foot">
        <span class="spacer"></span>
        <button class="btn btn-ghost" type="button" data-close>Cancel</button>
        <button class="btn btn-primary" type="submit">${editing ? "Save platform" : "Add platform"}</button>
      </div>
    </form>`);
}

async function savePlatformForm(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  const label = String(values.label || "").trim();
  if (!label) return toast("A platform needs a name.", { kind: "error" });

  const editingKey = form.dataset.platformKey || "";
  const list = [...state.data.platforms];
  const index = editingKey ? list.findIndex((platform) => platform.key === editingKey) : -1;

  if (editingKey && index === -1) return toast("That platform is no longer in the list.", { kind: "error" });

  /* The key is derived once and then never moves — recorded posts point
     at it. Everything else on the object is free to change. */
  const key = editingKey || uniquePlatformKey(label, list.map((platform) => platform.key));
  const next = normalizePlatform({
    ...(index >= 0 ? list[index] : {}),
    key,
    label,
    homeUrl: values.homeUrl,
    color: values.color,
    soft: values.soft,
    bodyMax: values.bodyMax,
    titleMax: values.titleMax,
    note: values.note,
    guidance: values.guidance,
    enabled: index >= 0 ? list[index].enabled : true,
    retired: index >= 0 ? list[index].retired : false
  });

  if (index >= 0) list[index] = next;
  else list.push(next);

  state.data.platforms = list;
  setActivePlatforms(list);
  addActivity(state.data, "platform", `${index >= 0 ? "Updated" : "Added"} platform ${next.label}`);
  commit();
  closeModal();
  render();
  toast(`${next.label} ${index >= 0 ? "saved" : "added"}`, { kind: "good" });
}

/* Removing a platform must never remove a post. Where history exists the
   platform is retired instead of deleted: it drops out of the pickers, it
   cannot be switched on, and every recorded post keeps its real platform
   name, colour and limits. Only a platform nothing references is actually
   deleted. */
async function removePlatform(key) {
  const platform = listPlatforms().find((entry) => entry.key === key);
  if (!platform) return;
  const usedBy = platformUsage(key);

  const ok = await confirmAction({
    title: `Remove ${platform.label}?`,
    body: usedBy
      ? `${plural(usedBy, "recorded post")} ${usedBy === 1 ? "uses" : "use"} this platform. Those stay exactly as they are — the platform is retired, so it disappears from new briefs but the history keeps its name and limits.`
      : "It will be removed from your platform list. Nothing else changes.",
    confirmLabel: usedBy ? "Retire it" : "Remove it",
    danger: true
  });
  if (!ok) return;

  state.data.platforms = usedBy
    ? state.data.platforms.map((entry) =>
        entry.key === key ? normalizePlatform({ ...entry, enabled: false, retired: true }) : entry)
    : state.data.platforms.filter((entry) => entry.key !== key);

  setActivePlatforms(state.data.platforms);
  /* A brief in progress may name it. */
  state.brief.platforms = usablePlatformKeys(state.brief.platforms);
  writeDraftBrief(state.brief);
  addActivity(state.data, "platform", `${usedBy ? "Retired" : "Removed"} platform ${platform.label}`);
  commit();
  render();
  toast(`${platform.label} ${usedBy ? "retired" : "removed"}`);
}

function openSyncDialog() {
  const credentials = readCredentials();

  openModal(`
    <form class="modal-inner" id="sync-form">
      <div class="modal-head">
        <div>
          <h2>Cloud sync</h2>
          <p>The studio holds nothing of its own. Point it at a gist you own and a model key you pay for, and it becomes yours — on this device and any other you enter these on.</p>
        </div>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon("x")}</button>
      </div>

      <div class="modal-scroll">
        <section class="modal-section">
          <h3>Workspace storage</h3>
          <div class="field">
            <label for="s-token">GitHub token</label>
            <input class="input" id="s-token" name="githubToken" type="password" autocomplete="off" spellcheck="false"
                   placeholder="github_pat_… or ghp_…" value="${esc(credentials.githubToken)}" data-autofocus>
            <p class="hint">Needs <strong>Gists → Read and write</strong> and nothing else.
              <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener">Create one ↗</a></p>
          </div>
          <div class="field">
            <label for="s-gist">Gist ID</label>
            <input class="input" id="s-gist" name="gistId" autocomplete="off" spellcheck="false"
                   placeholder="Paste the gist id or its full URL" value="${esc(credentials.gistId)}">
            <p class="hint">A secret gist containing one file named <code>sc_data.json</code>. A full URL works — the id is pulled out of it.
              <a href="https://gist.github.com/" target="_blank" rel="noopener">New gist ↗</a></p>
          </div>
        </section>

        <section class="modal-section">
          <h3>Drafting model</h3>
          <div class="field">
            <label for="s-provider">Provider</label>
            <select class="input" id="s-provider" name="provider">
              ${PROVIDER_KEYS.map((id) => `<option value="${id}" ${credentials.provider === id ? "selected" : ""}>${esc(PROVIDERS[id].label)}</option>`).join("")}
            </select>
            <p class="hint">Each provider keeps its own key and model, so switching does not throw the others away.</p>
          </div>

          ${PROVIDER_KEYS.map((id) => `
            <div data-provider-block="${id}" ${credentials.provider === id ? "" : "hidden"}>
              <div class="field">
                <label for="k-${id}">${esc(PROVIDERS[id].label)} API key</label>
                <input class="input" id="k-${id}" name="key_${id}" type="password" autocomplete="off" spellcheck="false"
                       data-key-for="${id}"
                       placeholder="${esc(PROVIDERS[id].placeholder)}" value="${esc(credentials.keys[id])}">
                <p class="hint"><a href="${esc(PROVIDERS[id].keysUrl)}" target="_blank" rel="noopener">Get a key ↗</a></p>
              </div>
              <div class="field">
                <label for="m-${id}">Model</label>
                <div class="field-row">
                  <select class="input" id="m-${id}" name="model_${id}" data-model-select="${id}">
                    ${modelOptions(id, credentials.models[id], readModelCatalog(id, credentials.keys[id]))}
                  </select>
                  <button class="btn btn-ghost btn-sm" type="button" data-act="test-models" data-provider="${id}"
                          title="Check the key and reload the model list">${icon("refresh")} Test</button>
                </div>
                <input class="input field-sub" id="mc-${id}" name="custom_${id}" autocomplete="off" spellcheck="false"
                       aria-label="${esc(PROVIDERS[id].label)} model id"
                       value="${esc(credentials.models[id])}" placeholder="${esc(PROVIDERS[id].defaultModel)}" hidden>
                <p class="field-status" id="ms-${id}" role="status" aria-live="polite">
                  ${modelStatusLine(id, credentials.keys[id], readModelCatalog(id, credentials.keys[id]))}
                </p>
              </div>
              ${PROVIDERS[id].supportsEffort ? `
                <div class="field">
                  <label for="s-effort">Reasoning effort</label>
                  <select class="input" id="s-effort" name="effort">
                    <option value="" ${credentials.effort === "" ? "selected" : ""}>Provider default</option>
                    <option value="low" ${credentials.effort === "low" ? "selected" : ""}>Low — fastest, cheapest</option>
                    <option value="medium" ${credentials.effort === "medium" ? "selected" : ""}>Medium</option>
                    <option value="high" ${credentials.effort === "high" ? "selected" : ""}>High</option>
                  </select>
                  <p class="hint">Only sent when you pick one. Older models reject this setting, so the default leaves it off.</p>
                </div>` : ""}
            </div>`).join("")}
        </section>

        <div class="notice">
          ${icon("shield")}
          <span><strong>Credentials never leave this browser.</strong> They are not written to the gist and are not part of a backup. On another device you enter them once more — that is deliberate: syncing plaintext keys behind a short passkey would be worse than typing them again.</span>
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn btn-ghost btn-sm" type="button" data-act="forget-device">Forget</button>
        <span class="spacer"></span>
        <button class="btn btn-ghost" type="button" data-close>Cancel</button>
        <button class="btn btn-primary" type="submit">Save and connect</button>
      </div>
    </form>`, { size: "" });
}

/* ------------------------------------------------------------
   THE MODEL PICKER

   Which models a key can use is the provider's answer, not this app's, so
   the picker is filled from a live call (Test) and from the last answer
   that call got. Three states have to keep working regardless:

     · no key yet — nothing to ask with
     · a key the provider will not answer for — CORS, offline, revoked
     · a saved model the provider no longer lists

   In all three the operator must still be able to set a model, which is
   what the "Other" escape hatch is for. A picker that can only offer what
   a successful fetch returned would, on a failed fetch, be a picker that
   cannot be used at all.
   ------------------------------------------------------------ */

const CUSTOM_MODEL = "__custom__";

function modelOptions(providerId, selected, catalog) {
  const listed = catalog?.models || [];
  const known = new Set(listed.map((model) => model.id));
  const chosen = String(selected || "").trim();
  const parts = [];

  if (listed.length) {
    parts.push(`<optgroup label="Available to this key">`);
    for (const model of listed) {
      const label = model.label && model.label !== model.id ? `${model.label} — ${model.id}` : model.id;
      parts.push(`<option value="${esc(model.id)}"${model.id === chosen ? " selected" : ""}>${esc(label)}</option>`);
    }
    parts.push(`</optgroup>`);
  }

  /* Whatever is saved stays selectable even when the fetched list does not
     contain it. Dropping it would silently re-point every future run at
     some other model, which is the one thing this picker must not do. */
  if (chosen && !known.has(chosen)) {
    parts.push(listed.length
      ? `<optgroup label="Saved on this device"><option value="${esc(chosen)}" selected>${esc(chosen)} — not in the fetched list</option></optgroup>`
      : `<option value="${esc(chosen)}" selected>${esc(chosen)}</option>`);
  }

  parts.push(`<option value="${CUSTOM_MODEL}">Other — type a model id…</option>`);
  return parts.join("");
}

function modelStatusLine(providerId, apiKey, catalog) {
  if (!String(apiKey || "").trim()) {
    return "Paste a key above, then Test to load the models it can use.";
  }
  if (!catalog?.models?.length) {
    return "Test the key to load the models it can use.";
  }
  const when = catalog.fetchedAt ? ` ${relTime(catalog.fetchedAt)}` : "";
  return `${plural(catalog.models.length, "model")} listed by ${esc(PROVIDERS[providerId].label)}${esc(when)}. Test again to refresh.`;
}

/* The value the picker is currently pointing at, custom field included, so
   a refresh can put the selection back where the operator left it. */
function currentModelChoice(providerId) {
  const select = el(`#m-${providerId}`);
  if (!select) return "";
  if (select.value !== CUSTOM_MODEL) return select.value;
  return (el(`#mc-${providerId}`)?.value || "").trim();
}

function paintModelPicker(providerId, catalog, selected) {
  const select = el(`#m-${providerId}`);
  if (!select) return;
  select.innerHTML = modelOptions(providerId, selected, catalog);
  /* An id the fetched list does not have is still offered above, so this
     only falls through to the custom field when there was no id at all. */
  if (!select.value || select.value === CUSTOM_MODEL) select.value = CUSTOM_MODEL;
  syncCustomModelField(providerId);
}

function syncCustomModelField(providerId) {
  const select = el(`#m-${providerId}`);
  const custom = el(`#mc-${providerId}`);
  if (!select || !custom) return;
  custom.hidden = select.value !== CUSTOM_MODEL;
}

function setModelStatus(providerId, kind, html) {
  const node = el(`#ms-${providerId}`);
  if (!node) return;
  const glyph = { good: "check-circle", bad: "alert", busy: "" }[kind] || "";
  node.className = `field-status${kind ? ` is-${kind}` : ""}`;
  node.innerHTML = `${kind === "busy" ? `<span class="spinner"></span>` : glyph ? icon(glyph) : ""}<span>${html}</span>`;
}

/* Retyping a key invalidates the list that was fetched with the old one.
   Saying so is the honest move: the picker's contents are now a claim
   about a key that is no longer in the box. */
function markModelsStale(providerId) {
  const node = el(`#ms-${providerId}`);
  if (!node) return;
  const key = (el(`#k-${providerId}`)?.value || "").trim();
  setModelStatus(providerId, "", key
    ? "Key changed. Test it to load the models it can use."
    : "Paste a key above, then Test to load the models it can use.");
}

async function testModels(node) {
  const providerId = node.dataset.provider;
  const meta = PROVIDERS[providerId];
  if (!meta || !el(`#m-${providerId}`)) return;

  const apiKey = (el(`#k-${providerId}`)?.value || "").trim();
  /* Read the selection BEFORE the picker is rebuilt under it. */
  const chosen = currentModelChoice(providerId);

  const label = node.innerHTML;
  node.disabled = true;
  node.innerHTML = `<span class="spinner"></span> Testing`;
  setModelStatus(providerId, "busy", `Asking ${esc(meta.label)} which models this key can use…`);

  try {
    const catalog = await listModels({ provider: providerId, apiKey });
    writeModelCatalog(providerId, { models: catalog.models, apiKey, fetchedAt: catalog.fetchedAt });
    paintModelPicker(providerId, catalog, chosen);

    const missing = chosen && !catalog.models.some((model) => model.id === chosen);
    setModelStatus(providerId, "good",
      `Key works. ${esc(plural(catalog.models.length, "model"))} available.` +
      (missing ? ` <strong>${esc(chosen)}</strong> is not among them — pick one from the list.` : ""));
  } catch (error) {
    setModelStatus(providerId, "bad", esc(describeError(error)));
  } finally {
    node.disabled = false;
    node.innerHTML = label;
  }
}

/* The picker's own value, unless it is pointing at "Other", in which case
   the typed id is the answer. Falls back to the provider default so the
   saved model is never the empty string. */
function chosenModel(values, providerId) {
  const picked = String(values.get(`model_${providerId}`) || "").trim();
  const typed = String(values.get(`custom_${providerId}`) || "").trim();
  const resolved = picked === CUSTOM_MODEL ? typed : picked;
  return resolved || PROVIDERS[providerId].defaultModel;
}

async function submitSyncForm(form) {
  const values = new FormData(form);
  const button = form.querySelector("button[type=submit]");
  const next = {
    githubToken: (values.get("githubToken") || "").trim(),
    gistId: (values.get("gistId") || "").trim(),
    provider: values.get("provider"),
    effort: values.get("effort") || "",
    keys: Object.fromEntries(PROVIDER_KEYS.map((id) => [id, (values.get(`key_${id}`) || "").trim()])),
    models: Object.fromEntries(PROVIDER_KEYS.map((id) => [id, chosenModel(values, id)]))
  };

  if (Boolean(next.githubToken) !== Boolean(next.gistId)) {
    return toast("Enter both the token and the gist id, or leave both empty.", { kind: "error" });
  }

  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span> Connecting…`;

  try {
    let remote = null;
    if (next.githubToken && next.gistId) remote = await workspace.test(next);

    writeCredentials(next);
    workspace.refreshCredentials();

    if (remote) {
      /* First connection with local work already done: offer to keep it
         rather than silently replacing one with the other. */
      const localHasWork = state.data.posts.length > 0;
      const remoteHasWork = remote.posts.length > 0;
      if (localHasWork && remoteHasWork && state.data.revision === 0) {
        const keepLocal = await confirmAction({
          title: "Two workspaces",
          body: `This device has ${plural(state.data.posts.length, "post")} and the gist has ${plural(remote.posts.length, "post")}. Which should win?`,
          confirmLabel: "Keep this device's"
        });
        if (!keepLocal) adoptData(remote);
        workspace.baseRevision = Number(remote.revision || 0);
        if (keepLocal) workspace.touch();
      } else {
        adoptData(remote);
        workspace.baseRevision = Number(remote.revision || 0);
      }
      workspace.lastSyncedAt = new Date();
    }

    closeModal();
    render();
    paintSyncState(workspace.status);
    toast(remote ? "Connected to your gist" : "Saved on this device", { kind: "good" });
  } catch (error) {
    button.disabled = false;
    button.textContent = "Save and connect";
    toast(describeError(error), { kind: "error" });
  }
}

function openConflictDialog() {
  const remote = workspace.conflict?.remote;
  if (!remote) return;

  openModal(`
    <div class="modal-inner">
      <div class="modal-head">
        <div>
          <h2>This workspace changed elsewhere</h2>
          <p>Another device saved to the same gist while this one had unsaved edits. Nothing has been overwritten — choose which version to keep.</p>
        </div>
      </div>
      <div class="modal-scroll">
        <dl class="facts">
          <dt>On the gist</dt><dd>revision ${remote.revision} · ${plural(remote.posts.length, "post")} · saved ${esc(relTime(remote.updatedAt))}</dd>
          <dt>On this device</dt><dd>revision ${state.data.revision} · ${plural(state.data.posts.length, "post")}</dd>
        </dl>
        <div class="notice is-warn" style="margin-top:1rem">
          ${icon("alert")}
          <span>Download a backup first if you are unsure. Whichever you discard is still recoverable from the gist's version history.</span>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost btn-sm" type="button" data-act="export-json">${icon("download")} Backup</button>
        <span class="spacer"></span>
        <button class="btn btn-ghost" type="button" data-act="resolve" data-choice="theirs">Use the gist's</button>
        <button class="btn btn-primary" type="button" data-act="resolve" data-choice="mine">Keep mine</button>
      </div>
    </div>`, { size: "sm" });
}

async function openHistoryDialog() {
  const revisions = workspace.revisions();
  openModal(`
    <div class="modal-inner">
      <div class="modal-head">
        <div>
          <h2>Version history</h2>
          <p>GitHub keeps a revision for every save. Restoring writes the old contents back as a new save, so a restore is itself undoable from this list.</p>
        </div>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon("x")}</button>
      </div>
      <div class="modal-scroll">
        ${revisions.length ? `<ul class="history-list">${revisions.map((rev, index) => `
          <li class="history-item">
            <span class="stamp">${esc(fmtDateTime(rev.at))}${index === 0 ? " · current" : ""}</span>
            <span class="mono faint">+${rev.added} / −${rev.removed}</span>
            <button class="btn btn-ghost btn-sm" type="button" data-act="restore" data-sha="${esc(rev.sha)}" ${index === 0 ? "disabled" : ""}>Restore</button>
          </li>`).join("")}</ul>`
          : `<p class="muted">No revisions recorded yet. Reload the workspace once to fetch them.</p>`}
      </div>
      <div class="modal-foot"><span class="spacer"></span><button class="btn btn-primary" type="button" data-close>Close</button></div>
    </div>`);
}

function openPublishDialog(variantId) {
  const { post, variant } = findVariant(variantId);
  if (!variant) return;
  const meta = getPlatform(variant.platform);
  const editing = variant.status === "published";

  openModal(`
    <form class="modal-inner" id="publish-form" data-variant="${esc(variantId)}">
      <div class="modal-head">
        <div>
          <h2>${editing ? "Edit the record" : `Record this ${esc(meta.label)} post`}</h2>
          <p>${editing
            ? "Correct the link, time, or account on a post already on record."
            : "Fill this in after you have posted it. The studio saves the exact text alongside the link, so the record still matches even if the draft is edited later."}</p>
        </div>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon("x")}</button>
      </div>

      <div class="modal-scroll">
        <div class="field">
          <label for="p-url">Link to the post</label>
          <input class="input" id="p-url" name="url" type="url" placeholder="https://…" value="${esc(variant.publishedUrl)}" data-autofocus>
          <p class="hint">Optional, but it is what makes this record verifiable later.</p>
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="p-at">Published</label>
            <input class="input" id="p-at" name="at" type="datetime-local" required
                   value="${esc(toLocalInput(variant.publishedAt || new Date().toISOString()))}">
          </div>
          <div class="field">
            <label for="p-account">Account or page</label>
            <input class="input" id="p-account" name="account" placeholder="${esc(getPlatform(variant.platform).account || "Safe Cycle Tech")}"
                   value="${esc(variant.account)}">
          </div>
        </div>
        ${editing ? "" : `<div class="notice">${icon("info")}<span>The current draft text is what gets stored as published. Edit the draft first if it is not what actually went out.</span></div>`}
      </div>

      <div class="modal-foot">
        <span class="spacer"></span>
        <button class="btn btn-ghost" type="button" data-close>Cancel</button>
        <button class="btn btn-primary" type="submit">${editing ? "Save record" : "Mark published"}</button>
      </div>
    </form>`, { size: "sm" });
}

function openScheduleDialog(variantId) {
  const { variant } = findVariant(variantId);
  if (!variant) return;

  openModal(`
    <form class="modal-inner" id="schedule-form" data-variant="${esc(variantId)}">
      <div class="modal-head">
        <div>
          <h2>Plan a date</h2>
          <p>A reminder for you. This studio does not post on a timer — the date just puts it in the queue.</p>
        </div>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon("x")}</button>
      </div>
      <div class="modal-scroll">
        <div class="field">
          <label for="sc-at">Date and time</label>
          <input class="input" id="sc-at" name="at" type="datetime-local" required
                 value="${esc(toLocalInput(variant.scheduledAt || defaultScheduleTime()))}" data-autofocus>
        </div>
      </div>
      <div class="modal-foot">
        <span class="spacer"></span>
        <button class="btn btn-ghost" type="button" data-close>Cancel</button>
        <button class="btn btn-primary" type="submit">Add to queue</button>
      </div>
    </form>`, { size: "sm" });
}

function defaultScheduleTime() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(10, 0, 0, 0);
  return date.toISOString();
}

function openExternalDialog() {
  openModal(`
    <form class="modal-inner" id="external-form">
      <div class="modal-head">
        <div>
          <h2>Record a post you already made</h2>
          <p>For anything published straight on a platform without being drafted here. It joins the same record, marked as written by hand.</p>
        </div>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon("x")}</button>
      </div>
      <div class="modal-scroll">
        <div class="form-grid">
          <div class="field">
            <label for="x-campaign">What was it about?</label>
            <input class="input" id="x-campaign" name="campaign" placeholder="Saturday drop-off reminder" required data-autofocus>
          </div>
          <div class="field">
            <label for="x-platform">Platform</label>
            <select class="input" id="x-platform" name="platform">
              ${listPlatforms({ includeRetired: false }).map((entry) => `<option value="${esc(entry.key)}">${esc(entry.label)}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="field">
          <label for="x-body">What you posted</label>
          <textarea class="textarea body-text" id="x-body" name="body" required placeholder="Paste the text of the post"></textarea>
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="x-url">Link</label>
            <input class="input" id="x-url" name="url" type="url" placeholder="https://…">
          </div>
          <div class="field">
            <label for="x-at">Published</label>
            <input class="input" id="x-at" name="at" type="datetime-local" required value="${esc(toLocalInput(new Date().toISOString()))}">
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <span class="spacer"></span>
        <button class="btn btn-ghost" type="button" data-close>Cancel</button>
        <button class="btn btn-primary" type="submit">Add to the record</button>
      </div>
    </form>`);
}

/* ------------------------------------------------------------
   DRAFT HISTORY

   Re-running is only usable if the previous attempt survives it, and
   "which one did I like most" is a question you answer by reading them
   side by side. So this dialog lists every stored generation newest
   first, with the current text at the top for comparison and a restore
   on each older one.

   The oldest entry is synthesized rather than stored: a post that has
   never been re-run still has the model's untouched first output in
   `aiBody`, and that used to be reachable behind a per-platform
   "Model's original" button. That button is gone; this is where it
   lives now, so there is one place to look for earlier text instead of
   two that sounded alike.
   ------------------------------------------------------------ */

function generationEntries(post) {
  const stored = (post.generations || []).map((entry) => ({ ...entry, kind: "saved" }));

  /* One entry is not stored but derived: the current generation as the
     model wrote it, before the operator typed over it. It is only worth
     listing where the two differ — otherwise it is the current draft
     twice — and it belongs at the top, because it is a version of the
     text that is on screen now rather than of one that was replaced.

     Restoring it is what the old per-platform "Model's original" button
     did, which is why that button could be removed. */
  const edited = post.variants.filter((variant) => variant.aiBody && variant.aiBody.trim() !== variant.body.trim());
  if (!edited.length) return stored;

  return [{
    id: "original",
    kind: "original",
    at: post.ai?.at || post.createdAt,
    note: "As generated, before your edits",
    ai: post.ai,
    canonical: "",
    variants: edited.map((variant) => ({
      variantId: variant.id, platform: variant.platform, title: variant.title,
      body: variant.aiBody, aiBody: variant.aiBody, hashtags: [...(variant.hashtags || [])],
      notes: "", status: "draft"
    }))
  }, ...stored];
}

function generationCount(post) {
  return generationEntries(post).length;
}

function openDraftHistoryDialog() {
  const post = currentPost();
  if (!post) return;
  const entries = generationEntries(post);

  const current = {
    id: "current",
    at: post.updatedAt,
    note: "Current",
    ai: post.ai,
    variants: post.variants.map((variant) => ({
      variantId: variant.id, platform: variant.platform, title: variant.title,
      body: variant.body, hashtags: variant.hashtags, status: variant.status
    }))
  };

  openModal(`
    <div class="modal-inner">
      <div class="modal-head">
        <div>
          <h2>Draft history</h2>
          <p>Every version of this post the studio has held, newest first. Restoring replaces the working copy — and saves what it replaced, so a restore is itself undoable from this list. Published versions are never touched.</p>
        </div>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon("x")}</button>
      </div>
      <div class="modal-scroll">
        ${generationBlock(current, { current: true })}
        ${entries.length
          ? entries.map((entry) => generationBlock(entry)).join("")
          : `<p class="muted">Nothing earlier yet. Re-run the drafts and the version they replace is kept here.</p>`}
      </div>
      <div class="modal-foot"><span class="spacer"></span><button class="btn btn-primary" type="button" data-close>Close</button></div>
    </div>`);
}

function generationBlock(entry, { current = false } = {}) {
  return `<section class="gen${current ? " is-current" : ""}">
    <header class="gen-head">
      <strong>${esc(entry.note || "Earlier draft")}</strong>
      <span class="stamp" title="${esc(fmtDateTime(entry.at))}">${relTime(entry.at)}</span>
      ${entry.ai && entry.ai.provider !== "none" ? receiptChip(entry.ai, { compact: true }) : ""}
      <span class="spacer"></span>
      ${current ? `<span class="badge approved">In the editor</span>` : `
        <button class="btn btn-ghost btn-sm" type="button" data-act="restore-generation" data-gen="${esc(entry.id)}">
          ${icon("undo")} Restore this
        </button>`}
    </header>
    ${entry.variants.length
      ? entry.variants.map((variant) => `
          <div class="gen-variant">
            <span class="gen-platform">${esc(platformLabel(variant.platform))}</span>
            <div class="diff">${esc([variant.title, buildCopyText(variant)].filter(Boolean).join("\n\n")) || "(empty)"}</div>
          </div>`).join("")
      : `<p class="muted">No copy recorded in this version.</p>`}
  </section>`;
}

/* ------------------------------------------------------------
   RE-RUN

   Edit the shared message, press the button, get a fresh set of drafts
   written from it. The operator's own wording is passed as the steer and
   the drafts being replaced are passed as what NOT to repeat, so a
   second run is a second attempt rather than the same attempt again.
   ------------------------------------------------------------ */

async function rerunDrafts() {
  const post = currentPost();
  if (!post || state.rerunning) return;

  const credentials = readCredentials();
  if (!credentials.keys[credentials.provider]) {
    toast("Add a model API key under Cloud sync first.", { kind: "error" });
    return openSyncDialog();
  }

  /* Published text is a record of what actually went out; nothing here
     may overwrite it. */
  const targets = post.variants.filter((variant) => variant.status !== "published");
  if (!targets.length) return toast("Every version here is published. Duplicate the post to work on it again.", { kind: "error" });

  const held = post.variants.length - targets.length;
  const approved = targets.filter((variant) => variant.status !== "draft").length;
  const ok = await confirmAction({
    title: "Re-run the drafts?",
    body: [
      "The model rewrites each platform version from the shared message above.",
      "What is there now is saved to Draft history first, so you can compare and go back.",
      approved ? `${plural(approved, "approved version")} will go back to draft, because the text changes.` : "",
      held ? `${plural(held, "published version")} stays exactly as recorded.` : ""
    ].filter(Boolean).join(" "),
    confirmLabel: "Re-run"
  });
  if (!ok) return;

  pushGeneration(post, snapshotGeneration(post, { note: "Replaced by a re-run" }));

  state.rerunning = true;
  state.abort = new AbortController();
  render();

  const platforms = [...new Set(targets.map((variant) => variant.platform))];
  const started = nowIso();

  try {
    const { generation, receipt } = await generateDrafts({
      credentials,
      brief: {
        topic: post.topic || post.keyMessage || post.canonical,
        campaign: post.campaign,
        objective: post.objective,
        audience: post.audience,
        cta: state.data.organization.defaultCta,
        tone: "",
        platforms,
        guidance: Object.fromEntries(platforms.map((key) => [key, getPlatform(key).guidance || ""])),
        /* The two things that make this a second pass rather than a
           repeat of the first. */
        sharedMessage: post.canonical,
        previousDrafts: targets.map((variant) => ({
          platform: variant.platform,
          copy: variant.body.slice(0, 900)
        }))
      },
      organization: state.data.organization,
      recentPosts: state.data.posts.filter((entry) => entry.id !== post.id).slice(0, 40),
      signal: state.abort.signal
    });

    for (const variant of targets) {
      const next = generation.variants.find((item) => item.platform === variant.platform);
      if (!next) continue;
      variant.title = next.title || variant.title;
      variant.body = next.body;
      /* The model's output moved, so the frozen original moves with it.
         Leaving aiBody pointing at the first run would make this text
         look hand-edited to voice.js, which would then quote machine
         prose back to the model as an example of how a person writes —
         the exact feedback loop that file exists to avoid. The old
         original is not lost: the snapshot above holds it. */
      variant.aiBody = next.body;
      variant.hashtags = next.hashtags;
      variant.notes = next.notes;
      /* An approval was given to text that no longer exists. */
      if (variant.status !== "draft") variant.status = "draft";
    }

    /* The operator's shared message is the instruction for this run, so
       it survives it. Only an empty one takes the model's wording. */
    if (!post.canonical.trim()) post.canonical = generation.canonical;

    post.ai = {
      provider: receipt.provider,
      requestedModel: receipt.requestedModel,
      servedModel: receipt.servedModel,
      promptVersion: receipt.promptVersion,
      responseId: receipt.responseId || "",
      usage: receipt.usage || null,
      latencyMs: receipt.latencyMs || 0,
      at: receipt.at,
      warnings: [...(generation.warnings || [])]
    };
    /* A rewrite can drift onto ground an earlier post already covered,
       so the repetition check runs on every pass, not only the first. */
    const similar = findSimilarPosts(post.canonical, state.data.posts.filter((entry) => entry.id !== post.id));
    if (similar.length) {
      post.ai.warnings.push(
        `Reads a lot like "${similar[0].post.campaign}" (${Math.round(similar[0].score * 100)}% shared wording). Worth varying before publishing.`
      );
    }
    if (generation.campaignAngle) post.ai.warnings.unshift(`Angle taken: ${generation.campaignAngle}`);
    post.updatedAt = nowIso();

    addRun(state.data, {
      at: receipt.at, status: "ok",
      provider: receipt.provider, requestedModel: receipt.requestedModel, servedModel: receipt.servedModel,
      promptVersion: receipt.promptVersion, latencyMs: receipt.latencyMs, usage: receipt.usage,
      responseId: receipt.responseId, platforms, postId: post.id, campaign: post.campaign
    });
    addActivity(state.data, "generated", `Re-ran the drafts for "${post.campaign}"`, post.id);

    state.rerunning = false;
    commit();
    render();
    toast(`Rewritten — ${plural(generationCount(post), "earlier version")} kept in history`, { kind: "good" });
  } catch (error) {
    state.rerunning = false;
    /* The snapshot was taken before the call, so a failed run leaves an
       entry describing text that was never replaced. Take it back out. */
    post.generations = (post.generations || []).slice(1);

    if (error?.name === "AbortError") { render(); return toast("Re-run cancelled"); }

    addRun(state.data, {
      at: started, status: "failed",
      provider: credentials.provider, requestedModel: credentials.models[credentials.provider], servedModel: "",
      promptVersion: PROMPT_VERSION, latencyMs: 0, usage: null, responseId: "",
      platforms, postId: post.id, campaign: post.campaign, error: error.message
    });
    commit();
    render();
    openErrorDialog(error, { rerun: true });
  } finally {
    state.abort = null;
  }
}

/* Put an earlier version back. The current text is snapshotted on the
   way past, so this is reversible from the same list it was launched
   from — the one property that makes restoring safe to try. */
function restoreGeneration(genId) {
  const post = currentPost();
  if (!post) return;
  const entry = generationEntries(post).find((item) => item.id === genId);
  if (!entry) return;

  pushGeneration(post, snapshotGeneration(post, { note: "Replaced by a restore" }));

  let restored = 0;
  for (const saved of entry.variants) {
    /* Match on the variant id, falling back to the platform so a
       version restored into a duplicated post still lands. */
    const variant = post.variants.find((item) => item.id === saved.variantId)
      || post.variants.find((item) => item.platform === saved.platform);
    if (!variant || variant.status === "published") continue;
    variant.title = saved.title;
    variant.body = saved.body;
    variant.hashtags = [...(saved.hashtags || [])];
    if (saved.notes) variant.notes = saved.notes;
    /* Restored text has not been approved in its own right. Any date on
       it is left alone — it is a plan for the slot, not for the wording,
       so the post stays in the Queue while it waits to be re-approved. */
    variant.status = "draft";
    restored += 1;
  }
  if (entry.canonical) post.canonical = entry.canonical;
  post.updatedAt = nowIso();

  addActivity(state.data, "post", `Restored an earlier draft of "${post.campaign}"`, post.id);
  commit();
  closeModal();
  render();
  toast(restored
    ? `Restored ${plural(restored, "version")} — the text it replaced is in history`
    : "Nothing to restore into: every version here is published", { kind: restored ? "good" : "error" });
}

/* ------------------------------------------------------------
   THE READER

   A post is written to be read in one piece, and nothing else in this
   app shows it that way: the editor has it in a textarea sized for
   editing, and every list truncates it to one line with an ellipsis.
   So this window does one job — the whole post, as it will be pasted,
   set to be read.

   Two rules it exists to keep:
     · The text WRAPS. `pre-wrap` keeps the operator's own line breaks,
       `overflow-wrap: anywhere` breaks a long URL rather than pushing
       the window sideways. Nothing here scrolls horizontally.
     · It is the same text the clipboard gets, built by the same
       buildCopyText — hashtags included, in the position they will be
       published in.

   Read-only on purpose. Editing happens in the editor, where the
   character meters and the platform checks are.
   ------------------------------------------------------------ */

function openReaderDialog(variantId) {
  const { post, variant } = findVariantAnywhere(variantId);
  if (!variant) return;

  const meta = getPlatform(variant.platform);
  const text = buildCopyText(variant);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const others = post.variants.filter((item) => item.id !== variant.id);

  openModal(`
    <div class="modal-inner">
      <div class="modal-head">
        <div>
          <h2>${esc(post.campaign)}</h2>
          <p class="reader-meta">
            <span class="pip" style="background:${esc(meta.color)}">${esc(meta.label[0])}</span>
            <span>${esc(meta.label)}</span>
            <span class="badge ${variant.status}">${esc(STATUS_LABELS[variant.status])}</span>
            ${variant.scheduledAt ? `<span class="stamp">${esc(fmtDateTime(variant.scheduledAt))}</span>` : ""}
          </p>
        </div>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon("x")}</button>
      </div>

      <div class="modal-scroll">
        <article class="reader">
          ${variant.title ? `<h3 class="reader-title">${esc(variant.title)}</h3>` : ""}
          <div class="reader-text">${esc(text) || `<span class="muted">This version has no copy yet.</span>`}</div>
          ${variant.notes ? `<ul class="notes is-info"><li>${icon("info")}<span>${esc(variant.notes)}</span></li></ul>` : ""}
          ${variant.publishedUrl && safeUrl(variant.publishedUrl) ? `
            <div class="published-link">
              ${icon("link")}
              <a href="${esc(safeUrl(variant.publishedUrl))}" target="_blank" rel="noopener noreferrer">${esc(variant.publishedUrl)}</a>
            </div>` : ""}
        </article>

        ${others.length ? `
          <p class="reader-switch">
            <span class="stamp">Other versions:</span>
            ${others.map((item) => `<button class="linkish" type="button" data-act="read-post" data-variant="${esc(item.id)}">${esc(platformLabel(item.platform))}</button>`).join("")}
          </p>` : ""}
      </div>

      <div class="modal-foot">
        <span class="stamp">${plural(words, "word")} · ${plural(text.length, "character")}</span>
        <span class="spacer"></span>
        <button class="btn btn-ghost" type="button" data-close>Close</button>
        <button class="btn btn-primary" type="button" data-act="copy" data-variant="${esc(variant.id)}">${icon("copy")} Copy post</button>
      </div>
    </div>`, { size: "lg" });
}

function openShortcutsDialog() {
  const rows = [
    ["g then o", "Overview"], ["g then c", "New draft"], ["g then l", "Library"],
    ["g then q", "Queue"], ["g then r", "Model runs"], ["g then d", "Deleted posts"],
    ["g then s", "Settings"],
    ["n", "Start a draft"], ["/", "Search the library"], ["t", "Toggle light and dark"],
    ["Esc", "Close a dialog or the menu"], ["?", "This list"]
  ];
  openModal(`
    <div class="modal-inner">
      <div class="modal-head">
        <div><h2>Keyboard shortcuts</h2><p>They are ignored while you are typing in a field.</p></div>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon("x")}</button>
      </div>
      <div class="modal-scroll">
        <dl class="facts">${rows.map(([key, what]) => `<dt class="mono">${esc(key)}</dt><dd>${esc(what)}</dd>`).join("")}</dl>
      </div>
      <div class="modal-foot"><span class="spacer"></span><button class="btn btn-primary" type="button" data-close>Got it</button></div>
    </div>`, { size: "sm" });
}

/* ============================================================
   EVENTS
   ============================================================ */

function onClick(event) {
  const nav = event.target.closest("[data-nav]");
  if (nav) { navigate(nav.dataset.nav); return; }

  const theme = event.target.closest("[data-theme]");
  if (theme) { setTheme(theme.dataset.theme); state.prefs = readPrefs(); render(); return; }

  const layout = event.target.closest("[data-layout]");
  if (layout) { state.prefs = writePrefs({ libraryLayout: layout.dataset.layout }); render(); return; }

  const action = event.target.closest("[data-act]");
  if (!action) return;
  handleAction(action.dataset.act, action, event);
}

function handleAction(act, node, event) {
  const variantId = node.dataset.variant;

  switch (act) {
    case "jump":
      if (node.dataset.filterStatus) state.filters.status = node.dataset.filterStatus;
      if (node.dataset.jump) navigate(node.dataset.jump);
      return;

    case "open-post":
      state.postId = node.dataset.post;
      navigate("editor");
      return;

    case "sync-settings": closeModal(); return openSyncDialog();
    case "test-models": return testModels(node);
    case "history": return openHistoryDialog();
    case "shortcuts": return openShortcutsDialog();
    case "record-external": return openExternalDialog();
    case "receipt": {
      try { openReceiptDialog(JSON.parse(node.dataset.receipt)); } catch { /* malformed; nothing to show */ }
      return;
    }
    case "run-detail": {
      const run = state.data.runs.find((item) => item.id === node.dataset.run);
      if (run) openReceiptDialog({ ...run, providerLabel: PROVIDERS[run.provider]?.label });
      return;
    }

    case "cancel-generate": state.abort?.abort(); return;
    case "clear-filters":
      state.filters = { q: "", status: "all", platform: "all" };
      render();
      return;

    /* A starter idea. Fills the brief's one field and leaves the caret
       at the end of it, so the next keystroke edits rather than
       replaces. */
    case "use-topic": {
      state.brief = { ...readBriefForm(), topic: node.dataset.topic || "" };
      writeDraftBrief(state.brief);
      render();
      const box = el("#b-topic");
      box?.focus();
      box?.setSelectionRange(box.value.length, box.value.length);
      return;
    }

    case "copy": return copyVariant(variantId);
    case "open-platform": return openPlatform(variantId);

    case "platform-add": return openPlatformDialog();
    case "platform-edit": return openPlatformDialog(node.dataset.platformKey);
    case "platform-remove": return removePlatform(node.dataset.platformKey);
    case "toggle-approve": return toggleApprove(variantId);
    case "approve-all": return approveAll();
    case "schedule": return openScheduleDialog(variantId);
    case "publish": return openPublishDialog(variantId);
    case "rerun-drafts": return rerunDrafts();
    case "draft-history": return openDraftHistoryDialog();
    case "restore-generation": return restoreGeneration(node.dataset.gen);

    case "read-post": return openReaderDialog(variantId);

    case "duplicate": return duplicatePost();
    case "archive": return archivePost();
    case "delete-post": return deletePost();
    case "restore-post": return restorePost(node.dataset.post);
    case "purge-post": return purgePost(node.dataset.post);
    case "empty-bin": return emptyBin();
    case "export-post": return exportPost();

    case "export-json": return exportJson();
    case "export-md": return exportMarkdown();
    case "import": el("#import-file")?.click(); return;
    case "reset": return resetWorkspace();
    case "forget-device": return forgetDevice();
    case "resolve": return resolveConflict(node.dataset.choice);
    case "restore": return restoreRevision(node.dataset.sha, node);
    default: return;
  }
}

function onInput(event) {
  const target = event.target;

  /* A retyped key makes the model list next to it a claim about a key that
     is no longer in the box. */
  if (target.dataset.keyFor) { markModelsStale(target.dataset.keyFor); return; }

  if (target.id === "q") {
    state.filters.q = target.value;
    debounceRender();
    return;
  }

  if (target.closest("#brief-form")) {
    state.brief = readBriefForm();
    writeDraftBrief(state.brief);
    return;
  }

  const postField = target.dataset.postField;
  if (postField) {
    const post = currentPost();
    if (!post) return;
    post[postField] = target.value;
    post.updatedAt = nowIso();
    commit({ quiet: true });
    return;
  }

  const variantId = target.dataset.variant;
  const field = target.dataset.field;
  if (variantId && field && field !== "scheduledAt") {
    const { post, variant } = findVariant(variantId);
    if (!variant) return;
    variant[field] = field === "hashtags" ? splitTags(target.value) : target.value;
    post.updatedAt = nowIso();
    /* Patch only the blocks under the field being typed in, so the caret
       above them is never touched. */
    if (field === "body") {
      const holder = document.getElementById(`meta-${variantId}`);
      if (holder) holder.innerHTML = variantMeta(variant);
    }
    if (field === "title") {
      const meter = target.parentElement?.querySelector(".meter");
      if (meter) meter.outerHTML = meterFor(variant.title.length, getPlatform(variant.platform).titleMax);
    }
    /* Both fields feed the copy, so the preview of what gets pasted
       follows either one. */
    if (field === "body" || field === "hashtags") {
      const preview = document.getElementById(`ready-${variantId}`);
      if (preview) preview.innerHTML = readyBody(variant, getPlatform(variant.platform));
    }
    commit({ quiet: true });
  }
}

let renderTimer = null;
function debounceRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => render(), 160);
}

function onChange(event) {
  const target = event.target;

  const filter = target.dataset.filter;
  if (filter) { state.filters[filter] = target.value; render(); return; }

  const pref = target.dataset.pref;
  if (pref) { state.prefs = writePrefs({ [pref]: target.value }); render(); return; }

  const platform = target.dataset.platform;
  if (platform) {
    const entry = state.data.platforms.find((item) => item.key === platform);
    /* A retired platform cannot be switched back on from here: its posts
       are history and the operator removed it on purpose. Re-adding it by
       name is the deliberate route back. */
    if (!entry || entry.retired) return;
    entry.enabled = target.checked;
    setActivePlatforms(state.data.platforms);
    commit();
    render();
    return;
  }

  if (target.dataset.variant && target.dataset.field === "scheduledAt") {
    const { post, variant } = findVariant(target.dataset.variant);
    if (!variant) return;
    variant.scheduledAt = fromLocalInput(target.value);
    /* Typing a date here and picking one in the Schedule dialog have to
       leave the variant in the same state, or the Overview counts one
       and not the other. Approving is still a separate decision, so a
       draft stays a draft — it just carries a date. */
    if (variant.scheduledAt && variant.status === "approved") variant.status = "scheduled";
    if (!variant.scheduledAt && variant.status === "scheduled") variant.status = "approved";
    post.updatedAt = nowIso();
    commit();
    render();
    return;
  }

  if (target.dataset.modelSelect) {
    syncCustomModelField(target.dataset.modelSelect);
    if (target.value === CUSTOM_MODEL) el(`#mc-${target.dataset.modelSelect}`)?.focus();
    return;
  }

  if (target.name === "provider") {
    for (const block of document.querySelectorAll("[data-provider-block]")) {
      block.hidden = block.dataset.providerBlock !== target.value;
    }
    return;
  }

  if (target.id === "import-file") importBackup(target.files?.[0]);
}

function onSubmit(event) {
  const form = event.target;
  event.preventDefault();

  if (form.id === "brief-form") return runGeneration();
  if (form.id === "org-form") return saveOrganization(form);
  if (form.id === "sync-form") return submitSyncForm(form);
  if (form.id === "publish-form") return savePublication(form);
  if (form.id === "schedule-form") return saveSchedule(form);
  if (form.id === "external-form") return saveExternalPost(form);
  if (form.id === "platform-form") return savePlatformForm(form);
}

function onKeydown(event) {
  if (event.key === "Escape" && el("#app").classList.contains("menu-open")) { setDrawer(false); return; }

  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  if (el("#modal").open || el("#confirm").open) return;
  if (!state.data) return;

  if (state.keySequence === "g") {
    state.keySequence = "";
    const target = { o: "overview", c: "compose", l: "library", q: "queue", r: "runs", d: "deleted", s: "settings" }[event.key];
    if (target) { event.preventDefault(); navigate(target); }
    return;
  }

  if (event.key === "g") { state.keySequence = "g"; setTimeout(() => { state.keySequence = ""; }, 1200); return; }
  if (event.key === "n") { event.preventDefault(); navigate("compose"); return; }
  if (event.key === "t") { event.preventDefault(); toggleTheme(); if (state.view === "settings") render(); return; }
  if (event.key === "?") { event.preventDefault(); openShortcutsDialog(); return; }
  if (event.key === "/") {
    event.preventDefault();
    if (state.view !== "library") navigate("library");
    queueMicrotask(() => el("#q")?.focus());
  }
}

/* ============================================================
   MUTATIONS
   ============================================================ */

/* One funnel for every change: stamp the workspace, tell the store, and
   repaint the counts. `quiet` skips the nav repaint for keystroke-rate
   edits, which do not change any count. */
function commit({ quiet = false } = {}) {
  state.data.updatedAt = nowIso();
  workspace.touch();
  if (!quiet) paintNav();
}

function currentPost() {
  return state.data?.posts.find((post) => post.id === state.postId) || null;
}

function findVariant(variantId) {
  for (const post of state.data.posts) {
    const variant = post.variants.find((item) => item.id === variantId);
    if (variant) return { post, variant };
  }
  return { post: null, variant: null };
}

/* The reader can be opened on a deleted post — reading it is exactly how
   you decide whether to restore it — so it looks in the bin too. Kept
   separate from findVariant() deliberately: every other caller of that
   function mutates what it finds, and nothing should be able to edit,
   approve or publish its way into a post that has been deleted. */
function findVariantAnywhere(variantId) {
  const live = findVariant(variantId);
  if (live.variant) return live;
  for (const entry of state.data.deleted) {
    const variant = entry.variants.find((item) => item.id === variantId);
    if (variant) return { post: entry, variant };
  }
  return { post: null, variant: null };
}

async function copyVariant(variantId) {
  /* Anywhere, because the reader can be open on a post in the bin and
     copying its text is the least destructive thing you can do with it. */
  const { variant } = findVariantAnywhere(variantId);
  if (!variant) return;
  const ok = await copyText(buildCopyText(variant));
  toast(ok ? `${platformLabel(variant.platform)} copy is on the clipboard` : "The browser blocked the clipboard. Select the text and copy it.", { kind: ok ? "good" : "error" });
}

/* Copy, then open the platform's own page. In that order and never the
   other way round: arriving at a login screen with an empty clipboard is
   the one version of this step that wastes the trip. */
function openPlatform(variantId) {
  const { variant } = findVariant(variantId);
  if (!variant) return;
  const label = platformLabel(variant.platform);
  const url = platformHomeUrl(variant);

  copyText(buildCopyText(variant));

  if (!url) {
    /* The neutral "Any platform" draft, or a platform with no link yet.
       The copy still happened, which is the part that matters. */
    toast(`Copy is on the clipboard. Open wherever you are posting and paste it.`);
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
  toast(`Copy is on the clipboard — log in and paste it into ${label}`);
}

function toggleApprove(variantId) {
  const { post, variant } = findVariant(variantId);
  if (!variant || variant.status === "published") return;
  if (variant.status === "draft") {
    const blocking = variantChecks(variant).filter((check) => check.level === "error");
    if (blocking.length) return toast(blocking[0].text, { kind: "error" });
    /* A date was already set — on the brief, or in the field above — so
       approving it puts it on the calendar rather than leaving it in the
       state the Overview reports as "not scheduled". */
    variant.status = variant.scheduledAt ? "scheduled" : "approved";
  } else {
    variant.status = "draft";
    variant.scheduledAt = "";
  }
  post.updatedAt = nowIso();
  addActivity(state.data, "variant", `${variant.status === "draft" ? "Returned" : "Approved"} the ${platformLabel(variant.platform)} draft of "${post.campaign}"`, post.id);
  commit();
  render();
}

function approveAll() {
  const post = currentPost();
  if (!post) return;
  const blocked = [];
  for (const variant of post.variants) {
    if (variant.status !== "draft") continue;
    const errors = variantChecks(variant).filter((check) => check.level === "error");
    if (errors.length) { blocked.push(platformLabel(variant.platform)); continue; }
    variant.status = variant.scheduledAt ? "scheduled" : "approved";
  }
  post.updatedAt = nowIso();
  addActivity(state.data, "post", `Approved the drafts in "${post.campaign}"`, post.id);
  commit();
  render();
  toast(blocked.length ? `Approved, except ${blocked.join(" and ")} — those still need a fix.` : "Every draft approved", { kind: blocked.length ? "error" : "good" });
}

function saveSchedule(form) {
  const { post, variant } = findVariant(form.dataset.variant);
  if (!variant) return;
  variant.scheduledAt = fromLocalInput(new FormData(form).get("at"));
  variant.status = "scheduled";
  post.updatedAt = nowIso();
  addActivity(state.data, "variant", `Queued the ${platformLabel(variant.platform)} version of "${post.campaign}" for ${fmtDateTime(variant.scheduledAt)}`, post.id);
  commit();
  closeModal();
  render();
  toast("Added to the queue", { kind: "good" });
}

function savePublication(form) {
  const { post, variant } = findVariant(form.dataset.variant);
  if (!variant) return;
  const values = new FormData(form);
  const wasPublished = variant.status === "published";

  variant.publishedUrl = (values.get("url") || "").trim();
  variant.publishedAt = fromLocalInput(values.get("at"));
  variant.account = (values.get("account") || "").trim();
  /* Freeze what actually went out. The draft can be edited afterwards
     without the record quietly changing to match. */
  if (!wasPublished) variant.publishedBody = buildCopyText(variant);
  variant.status = "published";
  post.updatedAt = nowIso();

  addActivity(state.data, "publish",
    `${wasPublished ? "Updated the record for" : "Published"} the ${platformLabel(variant.platform)} version of "${post.campaign}"`, post.id);
  commit();
  closeModal();
  render();
  toast(wasPublished ? "Record updated" : "Publication recorded", { kind: "good" });
}

function saveExternalPost(form) {
  const values = new FormData(form);
  const post = createExternalPost({
    campaign: (values.get("campaign") || "").trim(),
    platform: values.get("platform"),
    body: (values.get("body") || "").trim(),
    publishedAt: fromLocalInput(values.get("at")),
    publishedUrl: (values.get("url") || "").trim()
  });
  state.data.posts.unshift(post);
  addActivity(state.data, "publish", `Recorded a ${platformLabel(post.variants[0].platform)} post: "${post.campaign}"`, post.id);
  commit();
  closeModal();
  state.postId = post.id;
  navigate("editor");
  toast("Added to the record", { kind: "good" });
}

function saveOrganization(form) {
  const values = new FormData(form);
  Object.assign(state.data.organization, {
    name: (values.get("name") || "").trim(),
    website: (values.get("website") || "").trim(),
    serviceArea: (values.get("serviceArea") || "").trim(),
    mission: (values.get("mission") || "").trim(),
    voice: (values.get("voice") || "").trim(),
    defaultCta: (values.get("defaultCta") || "").trim(),
    facts: String(values.get("facts") || "").split("\n").map((line) => line.trim()).filter(Boolean),
    prohibitedClaims: String(values.get("prohibitedClaims") || "").split("\n").map((line) => line.trim()).filter(Boolean)
  });
  addActivity(state.data, "settings", "Updated the organization profile");
  commit();
  toast("Organization saved", { kind: "good" });
}

function duplicatePost() {
  const post = currentPost();
  if (!post) return;
  const copy = structuredClone(post);
  copy.id = `post_${crypto.randomUUID()}`;
  copy.campaign = `${post.campaign} (copy)`;
  copy.createdAt = copy.updatedAt = nowIso();
  copy.status = "review";
  copy.source = post.source;
  /* The history belongs to the post it was written for. A copy starts
     with none, so nothing in its list claims to be an earlier version of
     a draft that has not been run yet. */
  copy.generations = [];
  for (const variant of copy.variants) {
    variant.id = `variant_${crypto.randomUUID()}`;
    variant.status = "draft";
    variant.publishedAt = "";
    variant.publishedUrl = "";
    variant.publishedBody = "";
  }
  state.data.posts.unshift(copy);
  addActivity(state.data, "post", `Duplicated "${post.campaign}"`, copy.id);
  commit();
  state.postId = copy.id;
  render();
  toast("Duplicated — the copy is open", { kind: "good" });
}

function archivePost() {
  const post = currentPost();
  if (!post) return;
  post.status = post.status === "archived" ? "review" : "archived";
  post.updatedAt = nowIso();
  addActivity(state.data, "post", `${post.status === "archived" ? "Archived" : "Restored"} "${post.campaign}"`, post.id);
  commit();
  render();
  toast(post.status === "archived" ? "Archived" : "Restored");
}

/* Deleting is now a move rather than an erasure: the post goes to the
   bin and stays recoverable for DELETED_RETENTION_DAYS. The toast still
   offers an immediate undo, because the fastest fix for a misclick is
   the one that does not make you go and find the thing. */
async function deletePost() {
  const post = currentPost();
  if (!post) return;
  const published = post.variants.filter((variant) => variant.status === "published").length;

  const ok = await confirmAction({
    title: `Delete "${post.campaign}"?`,
    body: published
      ? `This post has ${plural(published, "published record")}. It moves to Deleted posts, where you can restore it for ${DELETED_RETENTION_DAYS} days; after that the record of what went out is gone. The posts themselves stay live on their platforms.`
      : `Every platform version goes with it. You can restore it from Deleted posts for ${DELETED_RETENTION_DAYS} days.`,
    confirmLabel: "Delete",
    danger: true
  });
  if (!ok) return;

  softDeletePost(state.data, post);
  addActivity(state.data, "post", `Deleted "${post.campaign}"`);
  commit();
  state.postId = "";
  navigate("library");

  toast(`Deleted "${post.campaign}" — kept for ${DELETED_RETENTION_DAYS} days`, {
    action: "Undo",
    onAction: () => restorePost(post.id, { quiet: true })
  });
}

function restorePost(postId, { quiet = false } = {}) {
  const post = restoreDeletedPost(state.data, postId);
  if (!post) return toast("That post is no longer in the bin.", { kind: "error" });

  addActivity(state.data, "post", `Restored "${post.campaign}" from the bin`, post.id);
  commit();
  render();
  if (!quiet) {
    toast(`"${post.campaign}" is back in the library`, {
      action: "Open it",
      onAction: () => { state.postId = post.id; navigate("editor"); }
    });
  } else {
    toast(`"${post.campaign}" restored`, { kind: "good" });
  }
}

/* The one place in this app that destroys something. Both routes into
   it ask first, and both say plainly that the gist's revision history
   is the only thing left afterwards. */
async function purgePost(postId) {
  const entry = state.data.deleted.find((item) => item.id === postId);
  if (!entry) return;

  const ok = await confirmAction({
    title: `Remove "${entry.campaign}" for good?`,
    body: "This does not wait for the 30 days. The post and every platform version go now, and the only copy left is in your gist's revision history.",
    confirmLabel: "Remove permanently",
    danger: true
  });
  if (!ok) return;

  removeDeletedForever(state.data, postId);
  addActivity(state.data, "data", `Permanently removed "${entry.campaign}"`);
  commit();
  render();
  toast("Removed for good");
}

async function emptyBin() {
  const count = state.data.deleted.length;
  if (!count) return;

  const ok = await confirmAction({
    title: `Empty the bin?`,
    body: `${plural(count, "deleted post")} ${count === 1 ? "is" : "are"} still inside their ${DELETED_RETENTION_DAYS}-day window. Emptying removes ${count === 1 ? "it" : "them"} now, and the only copy left is in your gist's revision history.`,
    confirmLabel: "Empty it",
    danger: true
  });
  if (!ok) return;

  state.data.deleted = [];
  addActivity(state.data, "data", `Emptied the bin (${plural(count, "post")})`);
  commit();
  render();
  toast("The bin is empty");
}

/* ============================================================
   DATA IN AND OUT
   ============================================================ */

function exportJson() {
  downloadFile(`safecycle-workspace-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state.data, null, 2));
  toast("Backup downloaded");
}

function exportPost() {
  const post = currentPost();
  if (!post) return;
  downloadFile(`${slug(post.campaign)}.md`, postToMarkdown(post), "text/markdown");
}

function exportMarkdown() {
  const lines = [
    `# ${state.data.organization.name} — publication record`,
    "",
    `Exported ${fmtDateTime(new Date())} · ${plural(state.data.posts.length, "post")} · schema ${state.data.schemaVersion}`,
    ""
  ];
  for (const post of [...state.data.posts].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
    lines.push(postToMarkdown(post), "");
  }
  downloadFile(`safecycle-records-${new Date().toISOString().slice(0, 10)}.md`, lines.join("\n"), "text/markdown");
  toast("Records downloaded");
}

function postToMarkdown(post) {
  const kind = post.source === "external"
    ? "Recorded from the platform (no model involved)"
    : `${post.ai.providerLabel || post.ai.provider} · requested ${post.ai.requestedModel || "—"} · answered ${post.ai.servedModel || "not reported"}`;

  const lines = [
    `## ${post.campaign}`,
    "",
    `- Status: ${STATUS_LABELS[derivePostStatus(post)]}`,
    `- Created: ${fmtDateTime(post.createdAt)}`,
    `- Model: ${kind}`,
    post.topic ? `- Topic: ${post.topic}` : "",
    post.audience ? `- Audience: ${post.audience}${(post.derived || []).includes("audience") ? " (model's read)" : ""}` : "",
    post.tags?.length ? `- Tags: ${post.tags.join(", ")}` : "",
    "",
    post.canonical ? `> ${post.canonical.replace(/\n/g, "\n> ")}` : "",
    ""
  ].filter(Boolean);

  for (const variant of post.variants) {
    lines.push(`### ${platformLabel(variant.platform)} — ${STATUS_LABELS[variant.status]}`, "");
    if (variant.title) lines.push(`**${variant.title}**`, "");
    lines.push(variant.publishedBody || variant.body, "");
    if (variant.publishedAt) lines.push(`_Published ${fmtDateTime(variant.publishedAt)}${variant.publishedUrl ? ` — ${variant.publishedUrl}` : ""}_`, "");
  }
  return lines.join("\n");
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "post";
}

async function importBackup(file) {
  if (!file) return;
  try {
    const imported = migrateData(JSON.parse(await file.text()));
    const errors = validateData(imported);
    if (errors.length) throw new Error(errors[0]);

    const ok = await confirmAction({
      title: "Replace this workspace?",
      body: `The backup holds ${plural(imported.posts.length, "post")}. It replaces everything currently here — ${plural(state.data.posts.length, "post")}.`,
      confirmLabel: "Import",
      danger: true
    });
    if (!ok) return;

    imported.revision = state.data.revision;
    adoptData(imported);
    addActivity(state.data, "data", `Imported a backup with ${plural(imported.posts.length, "post")}`);
    commit();
    render();
    toast("Backup imported", { kind: "good" });
  } catch (error) {
    toast(`That file could not be imported: ${error.message}`, { kind: "error" });
  } finally {
    const input = el("#import-file");
    if (input) input.value = "";
  }
}

async function resetWorkspace() {
  const ok = await confirmAction({
    title: "Reset the whole workspace?",
    body: "Every post, publication record, run, and customized setting is replaced with a fresh one. Export a backup first if any of it matters.",
    confirmLabel: "Reset everything",
    danger: true
  });
  if (!ok) return;
  const revision = state.data.revision;
  adoptData(createDefaultData());
  state.data.revision = revision;
  addActivity(state.data, "data", "Reset the workspace");
  commit();
  navigate("overview");
  toast("Workspace reset");
}

async function forgetDevice() {
  const ok = await confirmAction({
    title: "Forget credentials on this device?",
    body: "The GitHub token and every model API key are removed from this browser. Your gist and its contents are untouched.",
    confirmLabel: "Forget",
    danger: true
  });
  if (!ok) return;
  clearCredentials();
  workspace.refreshCredentials();
  closeModal();
  render();
  paintSyncState(workspace.status);
  toast("Credentials cleared from this device");
}

async function resolveConflict(choice) {
  closeModal();
  const remote = await workspace.resolveConflict(choice);
  if (remote) {
    adoptData(remote);
    render();
    toast("Loaded the gist's version");
  } else {
    toast("Your version was written to the gist", { kind: "good" });
  }
}

async function restoreRevision(sha, button) {
  const ok = await confirmAction({
    title: "Restore this revision?",
    body: "The workspace is replaced with the contents of that save. Because restoring is itself a save, it can be undone from this same list.",
    confirmLabel: "Restore"
  });
  if (!ok) return;

  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span>`;
  try {
    const restored = await workspace.atRevision(sha);
    restored.revision = state.data.revision;
    adoptData(restored);
    addActivity(state.data, "data", "Restored an earlier revision");
    commit();
    closeModal();
    render();
    toast("Revision restored", { kind: "good" });
  } catch (error) {
    button.disabled = false;
    button.textContent = "Restore";
    toast(describeError(error), { kind: "error" });
  }
}

/* ============================================================
   HELPERS
   ============================================================ */

function navigate(view) {
  if (!VIEWS[view]) return;
  state.view = view;
  if (view !== "editor") {
    state.prefs = writePrefs({ view });
    history.replaceState(null, "", `#${view}`);
  }
  setDrawer(false);
  window.scrollTo({ top: 0, behavior: "auto" });
  render();
  el("#view").focus({ preventScroll: true });
}

function emptyBlock(glyph, heading, body, { action = "", nav = "", act = "" } = {}) {
  const button = action
    ? `<button class="btn btn-primary" type="button" ${nav ? `data-nav="${esc(nav)}"` : `data-act="${esc(act)}"`}>${esc(action)}</button>`
    : "";
  return `<div class="empty">${icon(glyph, "ico-lg")}<h3>${esc(heading)}</h3><p>${esc(body)}</p>${button}</div>`;
}

function firstLine(value) {
  return String(value || "").split("\n").find((line) => line.trim()) || "";
}

function describeError(error) {
  if (error instanceof ProviderError || error instanceof SyncError) {
    return error.hint ? `${error.message} ${error.hint}` : error.message;
  }
  return error?.message || "Something went wrong.";
}

/* Everything above is a declaration, so starting here is safe. */
boot();
