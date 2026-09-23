import { randomUUID, createHash } from "node:crypto";
import { autonomousGate, listingErrors, ACTIVE_ATTEMPTS, AUTOMATION_LABELS, destinationFor, subredditsOf } from "../js/automation.js";
import { cadenceDecision } from "../js/cadence.js";
import { buildCopyText, variantChecks } from "../js/platforms.js";
import { setOrganization, setActivePlatforms } from "../js/data.js";

export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function safeError(error) {
  return String(error?.message || error || "Publisher failed.")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/\S+/g, "[URL omitted]")
    .replace(/(?:access_token|refresh_token|password|api_key)\s*[=:]\s*[^\s,;]+/gi, "[credential omitted]").slice(0, 1000);
}
export function candidates(data) {
  const items = data.posts.filter((p) => p.status !== "archived").flatMap((post) => post.variants
    .filter((variant) => variant.status !== "published" && variant.automation?.optIn && Number.isFinite(Date.parse(variant.scheduledAt)))
    .map((variant) => ({ id: variant.id, post, variant, platform: variant.platform, scheduledAt: variant.scheduledAt })));
  return [...items, ...data.automation.listings.filter((listing) => listing.enabled && Number.isFinite(Date.parse(listing.scheduledAt)))
    .map((listing) => ({ id: listing.id, listing, platform: listing.platform, scheduledAt: listing.scheduledAt }))]
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
}
export function snapshotFor(item, data) {
  const source = item.variant || item.listing;
  return {
    itemId: item.id, postId: item.post?.id || "", platform: item.platform,
    destination: item.variant ? destinationFor(data.automation, source) : data.automation.platforms[item.platform]?.destination || "",
    subreddit: source.subreddit || "",
    flair: subredditsOf(data.automation).find((entry) => entry.name.toLowerCase() === String(source.subreddit || "").toLowerCase())?.flair || "",
    title: source.title || "", body: item.variant ? buildCopyText(source) : source.body,
    photos: source.photos || [], category: source.category || "", area: source.area || "",
    price: source.price ?? "", condition: source.condition || "", kind: source.kind || "social",
    operation: source.operation || "create", publishedUrl: source.publishedUrl || "",
    source: structuredClone(source), organization: structuredClone(data.organization)
  };
}
export function historyFor(data, journal) {
  const completed = (journal.attempts || []).filter((a) => a.phase === "succeeded");
  const records = [...data.posts, ...data.deleted].flatMap((p) => p.variants.filter((v) => v.publishedAt)
    .filter((v) => !completed.some((a) => a.snapshot.itemId === v.id))
    .map((v) => ({ id: v.id, platform: v.platform, at: v.publishedAt })));
  for (const a of completed) {
    records.push({ id: a.id, platform: a.platform, at: a.finishedAt });
  }
  return records;
}
/* "Angle taken" is the model describing its approach, not a caution about
   the copy, so it is not a reason to hold a post. */
export const reviewWarnings = (post) => (post?.ai?.warnings || []).filter((warning) => !/^Angle taken:/.test(warning));

export function gateFor(item, data, snapshot) {
  const variant = item.variant || { ...item.listing, hashtags: [] };
  const checks = item.variant ? variantChecks(variant, data.organization) : listingErrors(item.listing).map((text) => ({ level: "error", text }));
  // Human-reviewed copy can be delivered automatically, but never bypass structural errors.
  return autonomousGate({ variant, organization: data.organization, destination: snapshot.destination,
    copy: snapshot.body, checks, warnings: reviewWarnings(item.post), brief: item.post });
}

/* Each operation may be claimed again only while every earlier attempt is
   known to have sent nothing. The SQL claim enforces the same rule. A claim
   whose lease ran out (its runner died while preparing) never reached the
   submit barrier; the next claim marks it abandoned. */
export function retryable(attempt, now = Date.now()) {
  return ["abandoned", "dry-run", "failed"].includes(attempt.phase)
    || (attempt.phase === "resolved" && attempt.resolution === "not-published")
    || (attempt.phase === "claimed" && Date.parse(attempt.leaseUntil) <= now);
}

/* Read-back is read-only, so it may be repeated; a new post can take a
   little while to become visible. Submission is never repeated. */
async function verifyPatiently(browser, snapshot, permalink, delays, sleep) {
  for (let index = 0; ; index++) {
    try { return await browser.verify(snapshot, permalink); }
    catch (error) { if (index >= delays.length) throw error; await sleep(delays[index]); }
  }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Refusals the database raises before it changes anything: the transaction
   rolled back, so an attempt that met one is still unsent. Anything else —
   above all a timeout — might have committed, and is treated as a possible
   submission. */
const REFUSED = /SC_REVISION_CONFLICT|Preparation lease expired|Dry-run is enabled|Destination disabled|Automation disabled|Publisher paused|Lease owner changed|Publication already in flight|Operation already attempted/;
/* The item or the rules moved while the browser was being prepared. Nothing
   was sent; the next tick starts again from the current workspace. */
class Stale extends Error {}

export async function tick({ store, browser, alert, now = () => new Date().toISOString(), owner = randomUUID(), live = false,
  verifyDelays = [20000, 60000], sleep = pause }) {
  let { data, journal } = await store.load();
  setOrganization(data.organization); setActivePlatforms(data.platforms);
  const unresolved = journal.attempts.find((a) => ["submitting", "verifying", "uncertain"].includes(a.phase));
  if (unresolved) {
    await alert(`A ${AUTOMATION_LABELS[unresolved.platform] || unresolved.platform} post may or may not have gone out (attempt ${unresolved.id}). Nothing more is posted until you record what happened on the Automation page.`);
    return { state: "uncertain", attempt: unresolved.id };
  }
  if (!data.automation.enabled || journal.pausedReason) return { state: "paused", reason: journal.pausedReason || "Automation disabled." };
  let waiting = "";
  for (const item of candidates(data)) {
    if (!data.automation.platforms[item.platform]?.enabled || Date.parse(item.scheduledAt) > Date.parse(now())) continue;
    // A write changes the revision, so the tick ends and the next one starts
    // from fresh data instead of claiming with a stale revision.
    if (Date.parse(now()) - Date.parse(item.scheduledAt) > 3600000) {
      if (await store.defer(item, now())) return { state: "updated", reason: "Moved an overdue item to its next window." };
      continue;
    }
    const snapshot = snapshotFor(item, data);
    const operationId = `${item.id}:${snapshot.operation}:${item.listing?.cycle || 0}`;
    const payloadHash = digest(snapshot);
    if (journal.attempts.some((a) => a.operationId === operationId && !retryable(a, Date.parse(now())))) continue;
    if (journal.attempts.some((a) => a.operationId === operationId && a.phase === "dry-run" && a.payloadHash === payloadHash) && (data.automation.dryRun || !live)) continue;
    const gate = gateFor(item, data, snapshot);
    if (!gate.ok) {
      if (!await store.review(item, gate.reasons)) continue;
      await alert(`Review needed for the ${AUTOMATION_LABELS[item.platform] || item.platform} ${item.variant ? `version of "${item.post.campaign}"` : `listing "${item.listing.title}"`}: ${gate.reasons.join(" ")}`);
      return { state: "updated", reason: "Held an item for review." };
    }
    const cadence = cadenceDecision({ now: now(), platform: item.platform, automation: data.automation,
      history: historyFor(data, journal), attempts: journal.attempts.filter((a) => a.phase !== "claimed" || Date.parse(a.leaseUntil) > Date.parse(now())) });
    if (!cadence.ok) {
      if (cadence.scope === "global") return { state: "waiting", reason: cadence.reason };
      waiting ||= cadence.reason;
      continue;
    }
    const attempt = { id: randomUUID(), owner, operationId, platform: item.platform, payloadHash, snapshot };
    let phase = "unclaimed", permalink = "";
    try {
      try { await store.command("claim", attempt, data.revision); }
      catch (error) {
        // Usually the operator's browser saved a moment ago. Try next tick.
        if (REFUSED.test(error.message)) return { state: "updated", reason: "The workspace changed; trying again next minute." };
        throw error;
      }
      phase = "claimed";
      if (data.automation.dryRun || !live) {
        await store.command("finish", { id: attempt.id, owner, phase: "dry-run", error: "No browser actions or submissions performed." });
        return { state: "dry-run", attempt: attempt.id };
      }
      await browser.prepare(snapshot);
      const latest = await store.load();
      setOrganization(latest.data.organization); setActivePlatforms(latest.data.platforms);
      const fresh = candidates(latest.data).find((candidate) => candidate.id === item.id);
      if (!fresh || digest(snapshotFor(fresh, latest.data)) !== payloadHash || !gateFor(fresh, latest.data, snapshot).ok)
        throw new Stale("Content, destination or approval changed during preparation.");
      const decision = cadenceDecision({ now: now(), platform: item.platform, automation: latest.data.automation,
        history: historyFor(latest.data, latest.journal), attempts: latest.journal.attempts.filter((a) => a.id !== attempt.id && ACTIVE_ATTEMPTS.includes(a.phase)) });
      if (!decision.ok) throw new Stale(decision.reason);
      // If this RPC times out it MAY have committed. Never send in that case;
      // the durable barrier is conservatively left for reconciliation.
      phase = "submitting";
      try { await store.command("begin", { id: attempt.id, owner }, latest.data.revision); }
      catch (error) { if (REFUSED.test(error.message)) throw new Stale(error.message); throw error; }
      permalink = await browser.submit(snapshot);
      await store.command("submitted", { id: attempt.id, owner, permalink }); phase = "verifying";
      const evidence = await verifyPatiently(browser, snapshot, permalink, verifyDelays, sleep);
      await store.complete(attempt, evidence, now());
      return { state: "succeeded", attempt: attempt.id, permalink };
    } catch (error) {
      if (phase === "unclaimed") throw error;
      if (error instanceof Stale) {
        await store.command("finish", { id: attempt.id, owner, phase: "abandoned", error: error.message }).catch(() => {});
        return { state: "updated", reason: error.message };
      }
      const uncertain = ["submitting", "verifying"].includes(phase) || error?.possibleSubmission === true;
      const message = safeError(error);
      const recorded = await store.command("finish", { id: attempt.id, owner, phase: uncertain ? "uncertain" : "failed", error: message }).then(() => true, () => false);
      // If even that could not be written, nothing records that posting must
      // stop; pause it directly, and keep the link the platform returned.
      if (!recorded) await store.command("pause", { reason: `A post may have gone out and could not be recorded${permalink ? `: ${permalink}` : ""}. ${message}` }).catch(() => {});
      const where = AUTOMATION_LABELS[item.platform] || item.platform;
      await alert(uncertain
        ? `A ${where} post may or may not have gone out, and posting has stopped: ${message}`
        : `Posting stopped before anything was sent to ${where}: ${message} Fix it, then resume on the Automation page.`);
      return { state: uncertain ? "uncertain" : "failed", attempt: attempt.id, reason: message };
    } finally { await browser.close(); }
  }
  return waiting ? { state: "waiting", reason: waiting } : { state: "idle" };
}
