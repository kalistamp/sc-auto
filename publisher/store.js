import { Workspace, flattenWorkspace, publisherCommand } from "../js/sync.js";
import { createPostFromGeneration, addRun, addActivity, setOrganization, setActivePlatforms, findSimilarPosts } from "../js/data.js";
import { recordPublication, recordListingPublication } from "../js/publication.js";
import { platformLabel } from "../js/platforms.js";
import { nextSlotIso, bestTimeFor } from "../js/timing.js";
import { jitteredSlot } from "../js/cadence.js";
import { generateDrafts } from "../js/providers.js";
import { SUPABASE_SCHEMA } from "../js/config.js";
import { safeError, historyFor } from "./engine.js";
import { pickSubreddit, subredditsOf } from "../js/automation.js";

const HOUR = 3600000;
const SOCIAL = ["facebook", "reddit", "nextdoor"];

export function workspaceChanges(before, after) {
  const base = flattenWorkspace(before), desired = flattenWorkspace(after), result = [];
  for (const [key, value] of desired) {
    if (JSON.stringify(base.get(key)) === JSON.stringify(value)) continue;
    const [entity_type, entity_id] = key.split("\u0000");
    result.push({ entity_type, entity_id, action: "upsert", data: value });
  }
  // Runner never deletes workspace rows.
  return result;
}
const isConflict = (error) => String(error?.message || "").includes("SC_REVISION_CONFLICT");

/* The first slot that the platform's research window AND the minimum gaps
   allow. Scheduling into a slot cadence would refuse only makes the Queue
   show a time that is not going to happen. */
export function earliestSlot(platform, data, journal, now) {
  const history = historyFor(data, journal);
  const until = (rules, events) => Math.max(0, ...events.map((event) => Date.parse(event.at) + rules.gapHours * HOUR).filter(Number.isFinite));
  const target = data.automation.platforms[platform];
  const from = Math.max(+now, until(data.automation.policy, history),
    target ? until(target, history.filter((event) => event.platform === platform)) : 0);
  return nextSlotIso(platform, new Date(from));
}

export class PublisherStore {
  constructor(client, user) { this.client = client; this.workspace = new Workspace(); this.workspace.setUser(user); }
  command(...args) { return publisherCommand(...args); }
  async load() {
    for (let tries = 0; tries < 3; tries++) {
      const remote = await this.workspace.fetchRemote();
      const journal = await this.command("read");
      const after = await this.workspace.readRemoteRevision();
      if (remote.revision === after.revision) return { data: remote.data, journal };
    }
    throw new Error("Workspace changed repeatedly while reading; try next cycle.");
  }
  /* True when something was written. */
  async save(before, after) {
    const changes = workspaceChanges(before, after);
    if (!changes.length) return false;
    const { error } = await this.client.schema(SUPABASE_SCHEMA).rpc("apply_workspace_changes", { expected_revision: before.revision, changes });
    if (error) throw new Error(error.message);
    return true;
  }
  /* Load, change, save — and on a revision conflict (the operator's browser
     saved first) load again and reapply, so neither side's edit is lost.
     `change` returns false to skip. Resolves true when something was written. */
  async mutate(change) {
    for (let tries = 0; ; tries++) {
      const { data, journal } = await this.load();
      const before = structuredClone(data);
      setOrganization(data.organization); setActivePlatforms(data.platforms);
      if (await change(data, journal) === false) return false;
      try { return await this.save(before, data); }
      catch (error) { if (!isConflict(error) || tries === 2) throw error; }
    }
  }
  targetOf(data, item) {
    return item.variant ? data.posts.find((p) => p.id === item.post.id)?.variants.find((v) => v.id === item.id)
      : data.automation.listings.find((l) => l.id === item.id);
  }
  review(item, reasons) {
    return this.mutate((data) => {
      const target = this.targetOf(data, item);
      if (!target) return false;
      target.automation ||= {};
      target.automation.reviewReasons = reasons;
    });
  }
  defer(item, now) {
    return this.mutate((data, journal) => {
      const target = this.targetOf(data, item);
      if (!target) return false;
      target.scheduledAt = jitteredSlot(earliestSlot(item.platform, data, journal, new Date(now)), Math.random(), new Date(target.scheduledAt).getMinutes());
    });
  }
  /* Runner failures reach the website's Automation section. */
  alert(message) { return this.command("alert", { message }); }
  async complete(attempt, evidence, now) {
    // A conflict may retry RECORDING, never the external submission.
    for (let tries = 0; tries < 3; tries++) {
      const { data, journal } = await this.load();
      if (journal.attempts.some((a) => a.id === attempt.id && a.phase === "succeeded")) return;
      const before = structuredClone(data), snapshot = attempt.snapshot;
      setOrganization(snapshot.organization); setActivePlatforms(data.platforms);
      if (snapshot.postId) {
        const post = data.posts.find((p) => p.id === snapshot.postId);
        const variant = post?.variants.find((v) => v.id === snapshot.itemId);
        if (!variant) throw new Error("Submitted draft was deleted; reconcile its record manually.");
        if (variant.status === "published" && variant.publishedUrl !== evidence.permalink) throw new Error("Conflicting manual publication record.");
        recordPublication(data, post, variant, { url: evidence.permalink, at: evidence.verifiedAt, account: evidence.account, now, publishedBody: snapshot.body });
      } else {
        const listing = data.automation.listings.find((l) => l.id === snapshot.itemId);
        if (!listing) throw new Error("Submitted listing was deleted; reconcile manually.");
        recordListingPublication(data, listing, { url: evidence.permalink, at: evidence.verifiedAt, now, publishedBody: snapshot.body });
      }
      try {
        await this.command("complete", { id: attempt.id, owner: attempt.owner, permalink: evidence.permalink, evidence }, data.revision, workspaceChanges(before, data));
        return;
      } catch (error) { if (!isConflict(error) || tries === 2) throw error; }
    }
  }
}

/* A platform already holding an unpublished automatic post gets no new one:
   generation keeps pace with what cadence can actually send, instead of
   building a backlog that is only ever deferred. */
export function platformsReadyForGeneration(data, platforms) {
  const pending = new Set(data.posts.filter((post) => post.status !== "archived")
    .flatMap((post) => post.variants)
    .filter((variant) => variant.status !== "published" && variant.automation?.optIn)
    .map((variant) => variant.platform));
  return platforms.filter((key) => !pending.has(key));
}

export async function generateNext({ store, credentials, now = new Date(), random = Math.random }) {
  const { data, journal } = await store.load();
  const settings = data.automation;
  if (!settings.enabled || !settings.generationEnabled || journal.pausedReason) return false;
  // Failed runs count too, so a broken key or an outage costs one call a day.
  if (data.runs.filter((r) => r.automation && Date.parse(r.at) > +now - 86400000).length >= settings.generationLimit) return false;
  const enabled = SOCIAL.filter((key) => settings.platforms[key]?.enabled);
  // Reddit is only ready while one of its subreddits is free to receive a post.
  const ready = platformsReadyForGeneration(data, enabled)
    .filter((key) => key !== "reddit" || !subredditsOf(settings).length || pickSubreddit(settings, data.posts, +now));
  const topic = settings.topics.find((t) => !t.error && t.platforms.some((key) => ready.includes(key)) && (!t.postId || (settings.repeatDays >= 30 && t.lastGeneratedAt &&
    Date.parse(t.lastGeneratedAt) + settings.repeatDays * 86400000 <= +now &&
    data.posts.find((p) => p.id === t.postId)?.variants.every((v) => v.status === "published"))));
  if (!topic) return false;
  const platforms = topic.platforms.filter((key) => ready.includes(key));
  setOrganization(data.organization); setActivePlatforms(data.platforms);
  const brief = { topic: topic.topic, platforms, guidance: Object.fromEntries(data.platforms.map((p) => [p.key, p.guidance])) };
  let generation, receipt;
  try {
    if (topic.factText) {
      if (!data.organization.facts.includes(topic.factText)) throw new Error("Queued fact is no longer approved.");
      generation = { campaignName: "Approved fact", canonical: topic.factText, warnings: [],
        variants: platforms.map((platform) => ({ platform, title: platform === "reddit" ? topic.factText : "", body: topic.factText, hashtags: [], notes: "" })) };
      receipt = { at: now.toISOString(), provider: "approved-facts", requestedModel: "none", servedModel: "none", promptVersion: "approved-facts-1" };
    } else ({ generation, receipt } = await generateDrafts({ credentials, brief, organization: data.organization, recentPosts: data.posts.slice(0, 40) }));
  } catch (error) {
    // Recorded, counted against the daily limit and alerted — but publishing
    // carries on. Three failures in a row retire the topic from the backlog.
    const message = safeError(error);
    await store.mutate((latest) => {
      const entry = latest.automation.topics.find((t) => t.id === topic.id);
      if (entry) {
        entry.failures = (entry.failures || 0) + 1; entry.lastError = message;
        if (entry.failures >= 3) entry.error = message;
      }
      addRun(latest, { at: now.toISOString(), status: "failed", automation: true,
        provider: topic.factText ? "approved-facts" : credentials.provider || "",
        requestedModel: topic.factText ? "none" : credentials.models?.[credentials.provider] || "",
        servedModel: "", platforms, postId: "", campaign: topic.topic.slice(0, 80), error: message });
    });
    throw new Error(`Generation failed for "${topic.topic.slice(0, 80)}": ${message}`);
  }
  const post = createPostFromGeneration(brief, generation, receipt);
  // An intentional repeat of a completed fact is not flagged as a repeat.
  const similar = topic.factText ? [] : findSimilarPosts(post.canonical, data.posts);
  if (similar.length) post.ai.warnings.push(`Reads a lot like "${similar[0].post.campaign}" (${Math.round(similar[0].score * 100)}% shared wording). Worth varying before publishing.`);
  // The expensive call is done; a conflicting browser save only costs a reload.
  try { return await store.mutate((latest, latestJournal) => {
    const entry = latest.automation.topics.find((t) => t.id === topic.id);
    if (!entry || entry.postId !== topic.postId) return false;
    for (const variant of post.variants) {
      variant.automation = { optIn: true, approval: "", reviewReasons: [] };
      variant.photos = [];
      if (variant.platform === "reddit" && subredditsOf(latest.automation).length)
        variant.subreddit = pickSubreddit(latest.automation, latest.posts, +now) || "";
      const slot = earliestSlot(variant.platform, latest, latestJournal, now);
      let scheduled = jitteredSlot(slot, random());
      const window = bestTimeFor(variant.platform).primary;
      const end = new Date(slot); end.setHours(window.to[0], window.to[1], 0, 0);
      if (Date.parse(scheduled) >= +end) scheduled = slot;
      variant.scheduledAt = scheduled; variant.status = "scheduled";
    }
    latest.posts.unshift(structuredClone(post));
    Object.assign(entry, { postId: post.id, lastGeneratedAt: now.toISOString(), failures: 0, lastError: "" });
    addRun(latest, { ...receipt, automation: true, status: "ok", postId: post.id, platforms, campaign: post.campaign });
    addActivity(latest, "generated", `Automatically drafted ${platforms.map(platformLabel).join(", ")} for "${post.campaign}"`, post.id);
  }); } catch (error) {
    // Count the paid call against the daily limit even though its result could not be saved.
    await store.mutate((latest) => { addRun(latest, { ...receipt, automation: true, status: "failed", postId: "", platforms,
      campaign: post.campaign, error: `Written but not saved: ${safeError(error)}` }); }).catch(() => {});
    throw error;
  }
}
