/* ============================================================
   SAFE CYCLE STUDIO — the Automation section

   What the separate publisher/ runner is doing, what it needs from a
   person, and the policy it follows. The runner reports through the
   publisher journal (heartbeat, failures, attempts); this module only
   renders it. Nothing here drives a platform.
   ============================================================ */

import { AUTOMATION_PLATFORMS, AUTOMATION_LABELS, subredditsOf } from "./automation.js";
import { esc, fmtDateTime, icon, plural, relTime, safeUrl } from "./ui.js";

/* The runner beats once a minute; three missed beats is "offline". */
const STALE_MS = 180000;
const OPEN_PHASES = ["submitting", "verifying", "uncertain"];

export function runnerOnline(journal, now = Date.now()) {
  return Boolean(journal?.heartbeat) && now - Date.parse(journal.heartbeat) <= STALE_MS;
}

/* Opted-in work the gate sent back to a person, with the gate's reasons. */
export function heldItems(data) {
  const posts = data.posts.filter((post) => post.status !== "archived").flatMap((post) => post.variants
    .filter((variant) => variant.status !== "published" && variant.automation?.optIn && variant.automation.reviewReasons?.length)
    .map((variant) => ({ kind: "variant", id: variant.id, platform: variant.platform, title: post.campaign, reasons: variant.automation.reviewReasons })));
  const listings = data.automation.listings.filter((listing) => listing.enabled && listing.automation?.reviewReasons?.length)
    .map((listing) => ({ kind: "listing", id: listing.id, platform: listing.platform, title: listing.title, reasons: listing.automation.reviewReasons }));
  return [...posts, ...listings];
}

/* Everything that needs a person, in one list, for the Automation page,
   the Overview banner and the nav badge. Empty while automation is off:
   an idle runner is not a problem then. */
export function automationAttention(data, journal, error = "", now = Date.now()) {
  if (!data?.automation?.enabled) return [];
  const issues = [];
  if (error) issues.push({ key: "storage", text: error });
  // No journal and no error means it has not been read yet: unknown, not offline.
  else if (journal && !runnerOnline(journal, now)) issues.push({ key: "offline", text: journal.heartbeat
    ? `The runner has not checked in since ${fmtDateTime(journal.heartbeat)}. Nothing is being posted until it is running again.`
    : "The runner has never checked in. Nothing is posted until it runs on its computer." });
  for (const attempt of (journal?.attempts || []).filter((entry) => OPEN_PHASES.includes(entry.phase)))
    issues.push({ key: "attempt", attempt, text: `A ${label(attempt.platform)} post may or may not have gone out. Posting is stopped until you record what happened.` });
  if (journal?.pausedReason) issues.push({ key: "paused", text: `Posting is paused: ${journal.pausedReason}` });
  for (const item of heldItems(data)) issues.push({ key: "held", item, text: `${label(item.platform)} — "${item.title}" is waiting for your review.` });
  return issues;
}

const label = (key) => AUTOMATION_LABELS[key] || key;
const PHASE_LABELS = {
  claimed: "Preparing", submitting: "Posting", verifying: "Checking the post", uncertain: "Needs attention",
  succeeded: "Posted", failed: "Stopped before posting", "dry-run": "Dry run", abandoned: "Abandoned", resolved: "Resolved"
};
const PHASE_BADGE = { succeeded: "published", uncertain: "review", failed: "review", submitting: "scheduled", verifying: "scheduled", claimed: "scheduled", resolved: "draft", "dry-run": "draft", abandoned: "draft" };

export function toggleField(name, checked, title, note) {
  return `<label class="toggle-row">
    <input type="checkbox" name="${esc(name)}" ${checked ? "checked" : ""}>
    <span class="toggle-main"><strong>${esc(title)}</strong>${note ? `<small>${esc(note)}</small>` : ""}</span>
    <span class="switch"></span>
  </label>`;
}

function number(name, value, text, { min = 1, max = 10000, id = `auto-${name}` } = {}) {
  return `<div class="field"><label for="${esc(id)}">${esc(text)}</label>
    <input class="input" id="${esc(id)}" name="${esc(name)}" type="number" min="${min}" max="${max}" value="${esc(value)}" required></div>`;
}

function stat(title, value, note, hot = false) {
  return `<div class="stat${hot ? " is-hot" : ""}" style="cursor:default"><span class="stat-label">${esc(title)}</span>
    <span class="stat-value">${esc(value)}</span><span class="stat-note">${esc(note)}</span></div>`;
}

function attentionCard(issues) {
  return `<section class="card">
    <header class="card-head"><div><h3>Needs you</h3><p>Posting problems and posts held for review</p></div>
      <span class="spacer"></span>
      <button type="button" class="btn btn-quiet btn-sm" data-act="automation-refresh">${icon("refresh")} Refresh status</button>
    </header>
    <div class="card-body${issues.length ? " flush" : ""}">
      ${issues.length ? `<div class="rows">${issues.map((issue) => `<div class="row is-static">
        <span class="row-main"><span class="row-title">${icon("alert")} ${esc(issue.text)}</span>
          ${issue.item ? `<span class="row-sub">${esc(issue.item.reasons.join(" "))}</span>` : ""}
          ${issue.attempt ? `<span class="row-sub">${esc(issue.attempt.snapshot?.title || firstLine(issue.attempt.snapshot?.body))}${issue.attempt.error ? ` — ${esc(issue.attempt.error)}` : ""}</span>` : ""}</span>
        <span class="row-side">${
          issue.key === "attempt" ? `<button class="btn btn-soft btn-sm" type="button" data-act="automation-resolve" data-attempt="${esc(issue.attempt.id)}">Record what happened</button>`
          : issue.key === "paused" ? `<button class="btn btn-soft btn-sm" type="button" data-act="automation-resume">Resume posting</button>`
          : issue.key === "held" && issue.item.kind === "variant" ? `<button class="btn btn-soft btn-sm" type="button" data-act="automation-variant" data-variant="${esc(issue.item.id)}">Review</button>`
          : issue.key === "held" ? `<button class="btn btn-soft btn-sm" type="button" data-act="listing-approve" data-listing="${esc(issue.item.id)}">Approve and enable</button>` : ""
        }</span></div>`).join("")}</div>`
      : `<div class="empty">${icon("check-circle", "ico-lg")}<h3>Nothing needs you</h3><p>The runner is checking in and nothing is held.</p></div>`}
    </div>
  </section>`;
}

function failuresCard(journal) {
  const alerts = journal?.alerts || [];
  return `<section class="card">
    <header class="card-head"><div><h3>Failures</h3><p>Everything the runner reported, newest first</p></div></header>
    <div class="card-body${alerts.length ? " flush" : ""}">
      ${alerts.length ? `<div class="rows">${alerts.slice(0, 50).map((alert) => `<div class="row is-static">
        <span class="row-main"><span class="row-sub" style="white-space:normal;overflow-wrap:anywhere">${esc(alert.message)}</span>
          <span class="row-meta"><span class="stamp" title="${esc(fmtDateTime(alert.at))}">${esc(relTime(alert.lastAt || alert.at))}</span>
          ${alert.count > 1 ? `<span class="stamp">· ${esc(plural(alert.count, "time"))}</span>` : ""}</span></span></div>`).join("")}</div>`
      : `<p class="muted">No failures reported.</p>`}
    </div>
  </section>`;
}

function attemptsCard(journal) {
  const attempts = (journal?.attempts || []).slice().reverse().slice(0, 50);
  return `<section class="card" style="margin-top:1rem">
    <header class="card-head"><div><h3>Publication attempts</h3><p>The runner's record of every send, newest first</p></div></header>
    <div class="card-body${attempts.length ? " flush" : ""}">
      ${attempts.length ? `<div class="rows">${attempts.map((attempt) => `<details class="row is-static attempt">
        <summary class="row-main">
          <span class="row-title">${esc(label(attempt.platform))} — ${esc(attempt.snapshot?.title || firstLine(attempt.snapshot?.body) || attempt.id)}</span>
          <span class="row-meta"><span class="badge ${PHASE_BADGE[attempt.phase] || "draft"}">${esc(PHASE_LABELS[attempt.phase] || attempt.phase)}</span>
            <span class="stamp">${esc(fmtDateTime(attempt.finishedAt || attempt.claimedAt))}</span></span>
        </summary>
        <dl class="facts" style="margin-top:.6rem">
          ${attempt.permalink && safeUrl(attempt.permalink) ? `<dt>Post</dt><dd><a href="${esc(safeUrl(attempt.permalink))}" target="_blank" rel="noopener noreferrer">${esc(attempt.permalink)}</a></dd>` : ""}
          ${attempt.error ? `<dt>Detail</dt><dd>${esc(attempt.error)}</dd>` : ""}
          ${attempt.evidence?.visibility ? `<dt>Checked as</dt><dd>${esc(attempt.evidence.visibility)}</dd>` : ""}
          ${attempt.resolution ? `<dt>Resolution</dt><dd>${esc(attempt.resolution)} — ${esc(attempt.note || "")}</dd>` : ""}
          <dt>Steps</dt><dd>${(attempt.events || []).map((event) => `${esc(PHASE_LABELS[event.phase] || event.phase)} ${esc(fmtDateTime(event.at))}`).join(" → ")}</dd>
          <dt>Attempt</dt><dd class="mono">${esc(attempt.id)}</dd>
        </dl>
        ${OPEN_PHASES.includes(attempt.phase) || attempt.phase === "claimed" ? `<button class="btn btn-ghost btn-sm" type="button" data-act="automation-resolve" data-attempt="${esc(attempt.id)}">Record what happened</button>` : ""}
      </details>`).join("")}</div>`
      : `<p class="muted">No publication attempts recorded.</p>`}
    </div>
  </section>`;
}

function policyForm(a, journal) {
  return `<form class="card auto-card" id="automation-form">
    <header class="card-head"><div><h3>How it posts</h3><p>Stored with the workspace; the runner reads it every minute</p></div></header>
    <div class="card-body">
      ${toggleField("enabled", a.enabled, "Automatic publishing", "Off means the runner posts nothing and generates nothing.")}
      ${toggleField("dryRun", a.dryRun, "Dry run", "Records what would be posted, and when, without opening a single platform page.")}
      <p class="hint">Real posting also needs <code>"live": true</code> in the runner's own configuration on its computer, so unticking dry run here cannot start posting by itself.</p>
      <div class="form-grid" style="margin-top:.8rem">
        <div class="field"><label for="automation-timezone">Timezone</label><input class="input" id="automation-timezone" name="timezone" value="${esc(a.timezone)}" required></div>
        ${number("daily", a.policy.daily, "Posts per day, all platforms")}
        ${number("weekly", a.policy.weekly, "Posts per rolling week, all platforms")}
        ${number("gapHours", a.policy.gapHours, "Hours between any two posts")}
        ${number("quietStart", a.policy.quietStart, "Quiet from (hour, 0–23)", { min: 0, max: 23 })}
        ${number("quietEnd", a.policy.quietEnd, "Quiet until (hour, 0–23)", { min: 0, max: 23 })}
      </div>
      <h4 class="auto-subhead">Platforms</h4>
      ${AUTOMATION_PLATFORMS.map((key) => `<div class="platform-row auto-platform">
        ${toggleField(`${key}-enabled`, a.platforms[key].enabled, label(key), key === "craigslist" || key === "offerup" ? "Pickup-service listings, below." : "Automatic posts from the topic backlog, and posts you opt in.")}
        <div class="form-grid">
          <div class="field full"><label for="auto-${key}-destination">Page the runner starts from</label>
            <input class="input" id="auto-${key}-destination" name="${key}-destination" type="text" inputmode="url" autocomplete="off" spellcheck="false" value="${esc(a.platforms[key].destination)}" placeholder="https://www.facebook.com/YourPage">
            <p class="hint">Must match <code>startUrl</code> in the runner's recipe for ${esc(label(key))} exactly. The runner refuses to post when they differ.</p></div>
          ${number(`${key}-gapHours`, a.platforms[key].gapHours, "Hours between posts", { id: `auto-${key}-gapHours` })}
          ${number(`${key}-daily`, a.platforms[key].daily, "Posts per day", { id: `auto-${key}-daily` })}
          ${number(`${key}-weekly`, a.platforms[key].weekly, "Posts per rolling week", { id: `auto-${key}-weekly` })}
        </div>
        ${key === "reddit" ? subredditRows(a) : ""}
      </div>`).join("")}
      <h4 class="auto-subhead">Writing new posts</h4>
      ${toggleField("generationEnabled", a.generationEnabled, "Write posts from the topic backlog", "One topic at a time, and only while a platform has nothing else waiting to go out.")}
      <p class="hint">Writes with: <strong>${journal?.runnerModel ? `${esc(journal.runnerModel.provider)} · ${esc(journal.runnerModel.model || "its default model")}` : "nothing yet"}</strong>. Change it in Model settings (the gear, top right) with "The runner writes with this model too" switched on.</p>
      <div class="form-grid">
        ${number("generationLimit", a.generationLimit, "Posts written per 24 hours", { min: 1, max: 10, id: "auto-generation-limit" })}
        ${number("repeatDays", a.repeatDays, "Reuse a finished topic after (days, 0 = never)", { min: 0, max: 3650, id: "auto-repeat" })}
      </div>
      <p class="hint">A post goes out without you only when it trips none of the checks: no warnings, nothing the model flagged, and no claim — a number, date, name, partner, certification, price, quote or promise — that is not already in your approved facts or the topic. Anything else waits for you under Needs you. A post you approve word for word is sent as approved; editing it takes the approval away.</p>
      <button class="btn btn-primary" type="submit">Save automation policy</button>
    </div>
  </form>`;
}

/* One row per subreddit, plus an empty one to add another. Clearing a name
   removes that row when saved. */
function subredditRows(a) {
  const rows = [...subredditsOf(a), { name: "", flair: "", gapDays: 30, enabled: false, note: "" }];
  return `<div class="auto-subs">
    <p class="field-label">Subreddits</p>
    <p class="hint">Each Reddit post goes to one of these: the switched-on subreddit that has waited longest. Leave "Page the runner starts from" empty when using this list. Check each subreddit's rules before switching it on.</p>
    ${rows.map((entry, row) => `<div class="auto-sub">
      <div class="field"><label for="sub-name-${row}">${entry.name ? "Subreddit" : "Add a subreddit"}</label>
        <input class="input" id="sub-name-${row}" name="sub-name-${row}" value="${esc(entry.name)}" placeholder="bayarea" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label for="sub-flair-${row}">Flair, if required</label>
        <input class="input" id="sub-flair-${row}" name="sub-flair-${row}" value="${esc(entry.flair)}" autocomplete="off"></div>
      <div class="field"><label for="sub-days-${row}">Days between posts</label>
        <input class="input" id="sub-days-${row}" name="sub-days-${row}" type="number" min="1" max="365" value="${esc(entry.gapDays)}"></div>
      <input type="hidden" name="sub-note-${row}" value="${esc(entry.note)}">
      ${toggleField(`sub-on-${row}`, entry.enabled, entry.name ? `Post to r/${entry.name}` : "Switch on", entry.note)}
    </div>`).join("")}
  </div>`;
}

function topicsCard(a) {
  return `<section class="card auto-card" style="margin-top:1rem">
    <header class="card-head"><div><h3>Topic backlog</h3><p>What the runner writes about next</p></div></header>
    <div class="card-body">
      <form id="automation-topics-form">
        <div class="field"><label for="auto-topics">New topics, one per line</label>
          <textarea class="textarea" id="auto-topics" name="topics" required placeholder="Old laptops in closets could be computers for local students"></textarea>
          <p class="hint">Each topic becomes one post for whichever enabled platform is free next. The runner's own model key writes it; an empty backlog means nothing new is written.</p></div>
        <div class="btn-row">
          <button class="btn btn-ghost btn-sm" type="submit">${icon("plus")} Add topics</button>
          <button class="btn btn-quiet btn-sm" type="button" data-act="automation-facts">Queue approved facts verbatim</button>
        </div>
      </form>
      ${a.topics.length ? `<div class="rows" style="margin-top:.8rem">${a.topics.map((topic) => `<div class="row is-static">
        <span class="row-main"><span class="row-title">${esc(topic.topic)}</span>
          <span class="row-sub">${topic.error ? `Stopped: ${esc(topic.error)}` : topic.postId ? `Written ${esc(relTime(topic.lastGeneratedAt))}` : topic.lastError ? `Last try failed: ${esc(topic.lastError)}` : topic.factText ? "Waiting — approved fact, sent word for word" : "Waiting"}</span></span>
        <span class="row-side">
          ${topic.error ? `<button class="btn btn-quiet btn-sm" type="button" data-act="topic-retry" data-topic-id="${esc(topic.id)}">Try again</button>` : ""}
          <button class="btn btn-quiet btn-sm" type="button" data-act="topic-remove" data-topic-id="${esc(topic.id)}" title="Remove from the backlog">${icon("trash")}</button>
        </span></div>`).join("")}</div>`
      : `<p class="muted" style="margin-top:.8rem">No topics queued.</p>`}
    </div>
  </section>`;
}

function imagesCard(a) {
  return `<section class="card auto-card" style="margin-top:1rem">
    <header class="card-head"><div><h3>Images</h3><p>Your own photos and logo, for posts and listings</p></div></header>
    <div class="card-body">
      <form id="automation-images-form">
        <div class="field"><label for="automation-images">Add images</label>
          <input class="input" id="automation-images" type="file" name="images" accept="image/jpeg,image/png,image/webp" multiple required>
          <p class="hint">JPEG, PNG or WebP, up to 10 MB each. Stored privately in Supabase and fetched only by the runner. Choose them per post under Set up automatic delivery, or on a listing.</p></div>
        <button class="btn btn-ghost btn-sm" type="submit">${icon("upload")} Upload</button>
      </form>
      ${(a.images || []).length ? `<ul class="tip-list" style="margin-top:.8rem">${a.images.map((image) => `<li>${icon("check")}<span>${esc(image.name)} <span class="stamp">${esc(Math.ceil(image.size / 1024))} KB</span></span></li>`).join("")}</ul>` : `<p class="muted" style="margin-top:.8rem">No images uploaded.</p>`}
    </div>
  </section>`;
}

function listingsCard(a) {
  return `<section class="card auto-card" style="margin-top:1rem">
    <header class="card-head"><div><h3>Pickup-service listings</h3><p>Craigslist and OfferUp</p></div></header>
    <div class="card-body">
      <form id="automation-listing-form">
        <div class="form-grid">
          <div class="field"><label for="listing-platform">Platform</label><select class="select" id="listing-platform" name="platform"><option value="craigslist">Craigslist</option><option value="offerup">OfferUp</option></select></div>
          <div class="field"><label for="listing-title">Title</label><input class="input" id="listing-title" name="title" required></div>
          <div class="field"><label for="listing-area">Area or ZIP</label><input class="input" id="listing-area" name="area" required></div>
          <div class="field"><label for="listing-category">Category, as the platform names it</label><input class="input" id="listing-category" name="category" required></div>
          <div class="field full"><label for="listing-body">Service description, exactly as it should appear</label><textarea class="textarea" id="listing-body" name="body" required></textarea></div>
          <div class="field"><label for="listing-at">First post</label><input class="input" id="listing-at" name="scheduledAt" type="datetime-local" required></div>
          <div class="field"><label for="listing-url">Existing listing link, to renew instead</label><input class="input" id="listing-url" name="publishedUrl" type="url"></div>
          ${number("renewDays", 0, "Renew every (days; 0 = never, otherwise 7 or more)", { min: 0, max: 365, id: "listing-renew" })}
        </div>
        <fieldset class="auto-images"><legend class="field-label">Images to attach</legend>${imageChoices(a.images || [])}</fieldset>
        ${toggleField("approved", false, "I checked this copy, the category, that the service fits it, and that I own the images", "Required. The runner sends the listing exactly as approved here.")}
        <p class="hint">Set up any paid subscription yourself first; the runner never pays for anything.</p>
        <button class="btn btn-primary" type="submit">Queue listing</button>
      </form>
      ${a.listings.length ? `<div class="rows" style="margin-top:.8rem">${a.listings.map((listing) => `<div class="row is-static">
        <span class="row-main"><span class="row-title">${esc(label(listing.platform))} — ${esc(listing.title)}</span>
          <span class="row-sub">${listing.enabled ? `${listing.operation === "renew" ? "Renewal" : "First post"} ${esc(fmtDateTime(listing.scheduledAt))}` : listing.publishedUrl ? "Posted, no renewal planned" : "Paused"}${listing.automation?.reviewReasons?.length ? ` — held: ${esc(listing.automation.reviewReasons.join(" "))}` : ""}</span></span>
        <span class="row-side">
          ${listing.automation?.reviewReasons?.length ? `<button class="btn btn-soft btn-sm" type="button" data-act="listing-approve" data-listing="${esc(listing.id)}">Approve and enable</button>` : ""}
          <button class="btn btn-ghost btn-sm" type="button" data-act="listing-toggle" data-listing="${esc(listing.id)}">${listing.enabled ? "Pause" : "Enable"}</button>
        </span></div>`).join("")}</div>` : ""}
    </div>
  </section>`;
}

export function automationView(data, journal, error = "") {
  const a = data.automation;
  const issues = automationAttention(data, journal, error);
  const online = runnerOnline(journal);
  const posted = (journal?.attempts || []).filter((attempt) => attempt.phase === "succeeded").length;
  const mode = !a.enabled ? "Off" : a.dryRun ? "Dry run" : "Live";
  return `
    <section class="page-head">
      <div class="page-head-main">
        <p class="eyebrow">Automation</p>
        <h2>${!a.enabled ? "Automatic publishing is off" : issues.length ? `${plural(issues.length, "thing")} ${issues.length === 1 ? "needs" : "need"} you` : a.dryRun ? "Dry run — nothing is being posted" : "Posting on its own"}</h2>
        <p class="lede">The runner is a separate program on an always-on computer. It opens each platform in its own signed-in browser, posts opted-in items at the cadence below, and reads the post back before recording it. Closing this tab does not stop it; turning that computer off does.</p>
      </div>
    </section>

    ${error && !a.enabled ? `<div class="notice is-warn auto-banner">${icon("alert")}<span>${esc(error)}</span></div>` : ""}

    <div class="stat-row">
      ${stat("Runner", !journal && !error ? "—" : online ? "Online" : "Offline", !journal ? (error ? "Status unavailable" : "Checking…")
        : journal.heartbeat ? `Last seen ${relTime(journal.heartbeat)}${journal.host ? ` on ${journal.host}` : ""}` : "Never checked in", a.enabled && Boolean(journal) && !online)}
      ${stat("Mode", mode, a.enabled && !a.dryRun ? "Needs live mode on the runner too" : "Nothing is sent")}
      ${stat("Held for review", heldItems(data).length, "Waiting on you", heldItems(data).length > 0)}
      ${stat("Posted automatically", posted, "Read back and recorded")}
    </div>

    <div style="margin-top:1.2rem">${attentionCard(issues)}</div>

    <div class="split" style="margin-top:1rem">
      <div>
        ${policyForm(a, journal)}
        ${topicsCard(a)}
        ${listingsCard(a)}
        ${attemptsCard(journal)}
      </div>
      <aside>
        ${failuresCard(journal)}
        ${imagesCard(a)}
      </aside>
    </div>`;
}

export function imageChoices(images, selected = []) {
  return images.map((image) => `<label class="auto-image"><input type="checkbox" name="photos" value="${esc(image.path)}" ${selected.includes(image.path) ? "checked" : ""}> ${esc(image.name)}</label>`).join("")
    || `<p class="hint">Upload images in the Images card first.</p>`;
}

/* The runner's latest word on one Queue row or draft card. */
export function attemptBadge(variant, journal, dryRun) {
  if (variant.status === "published" && !variant.automation?.optIn) return "";
  const attempt = journal?.attempts?.filter((a) => a.snapshot?.itemId === variant.id).at(-1);
  const reasons = variant.automation?.reviewReasons || [];
  if (attempt) return `<span class="badge ${PHASE_BADGE[attempt.phase] || "draft"}" title="${esc(attempt.error || "")}">${esc(PHASE_LABELS[attempt.phase] || attempt.phase)}</span>`;
  if (!variant.automation?.optIn) return variant.status === "published" ? "" : `<span class="badge draft" title="Posted by hand">Manual</span>`;
  if (reasons.length) return `<span class="badge review" title="${esc(reasons.join(" "))}">Needs review</span>`;
  return `<span class="badge scheduled">${dryRun ? "Automatic · dry run" : "Automatic"}</span>`;
}

function firstLine(value) {
  return String(value || "").split("\n").find((line) => line.trim()) || "";
}
