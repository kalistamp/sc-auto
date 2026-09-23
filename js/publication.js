import { addActivity } from "./data.js";
import { buildCopyText, platformLabel } from "./platforms.js";
import { AUTOMATION_LABELS } from "./automation.js";
import { nextSlotIso } from "./timing.js";
import { jitteredSlot } from "./cadence.js";

/* The caller sets the active organization to the submitted snapshot first. */
export function recordPublication(data, post, variant, { url, at, account, now, publishedBody = buildCopyText(variant) }) {
  const wasPublished = variant.status === "published";
  variant.publishedUrl = url.trim();
  variant.publishedAt = at;
  variant.account = account.trim();
  if (!wasPublished) variant.publishedBody = publishedBody;
  variant.status = "published";
  post.updatedAt = now;
  addActivity(data, "publish", `${wasPublished ? "Updated the record for" : "Published"} the ${platformLabel(variant.platform)} version of "${post.campaign}"`, post.id);
}

/* The same record for a service listing, shared by the runner and by a
   person recording a listing by hand. A listing that renews is put back on
   the schedule for its next renewal; any other is finished. */
export function recordListingPublication(data, listing, { url, at, now, publishedBody, random = Math.random }) {
  Object.assign(listing, { publishedUrl: url.trim(), publishedBody, publishedAt: at, lastActionAt: now, enabled: false });
  if (listing.renewDays >= 7) {
    listing.operation = "renew";
    listing.cycle = (listing.cycle || 0) + 1;
    listing.scheduledAt = jitteredSlot(nextSlotIso(listing.platform, new Date(Date.parse(now) + listing.renewDays * 86400000)), random());
    listing.enabled = true;
  }
  addActivity(data, "publish", `Published the ${AUTOMATION_LABELS[listing.platform] || listing.platform} listing "${listing.title}"`);
}
