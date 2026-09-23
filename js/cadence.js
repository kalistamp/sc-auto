/* Cadence answers whether a send is allowed, not which posting hour is best. */
const HOUR = 3600000;
const DAY = 24 * HOUR;
function localParts(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(now)).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
/* `scope` says who a refusal applies to: "global" stops every platform,
   "platform" only this one, so another platform's due post can still go. */
export function cadenceDecision({ now, platform, automation, history = [], attempts = [] }) {
  const time = Number(new Date(now));
  if (!Number.isFinite(time)) return { ok: false, scope: "global", reason: "Invalid clock." };
  if (attempts.some((a) => ["claimed", "submitting", "verifying", "uncertain"].includes(a.phase)))
    return { ok: false, scope: "global", reason: "Another publication is in flight or unresolved." };
  const policy = automation.policy, target = automation.platforms[platform];
  if (!target) return { ok: false, scope: "platform", reason: "Unsupported platform." };
  const local = localParts(time, automation.timezone);
  const quiet = policy.quietStart === policy.quietEnd || (policy.quietStart < policy.quietEnd
    ? local.hour >= policy.quietStart && local.hour < policy.quietEnd
    : local.hour >= policy.quietStart || local.hour < policy.quietEnd);
  if (quiet) return { ok: false, scope: "global", reason: "Quiet hours." };
  for (const [rules, events, name, scope] of [[policy, history, "Global", "global"], [target, history.filter((h) => h.platform === platform), platform, "platform"]]) {
    const times = events.map((h) => Date.parse(h.at)).filter(Number.isFinite);
    if (times.some((at) => at > time - rules.gapHours * HOUR)) return { ok: false, scope, reason: `${name} minimum gap.` };
    if (times.filter((at) => at > time - DAY).length >= rules.daily ||
        times.filter((at) => localParts(at, automation.timezone).date === local.date).length >= rules.daily)
      return { ok: false, scope, reason: `${name} daily cap.` };
    if (times.filter((at) => at > time - 7 * DAY).length >= rules.weekly) return { ok: false, scope, reason: `${name} weekly cap.` };
  }
  return { ok: true, scope: "", reason: "Eligible." };
}

/* Persist this choice. Re-evaluating the queue must never re-roll jitter. */
export function jitteredSlot(slot, random, previousMinute = -1) {
  const date = new Date(slot);
  if (!Number.isFinite(+date) || !Number.isFinite(random) || random < 0 || random >= 1) throw new Error("Invalid slot or jitter input.");
  let minute = Math.floor(random * 30);
  if ((date.getMinutes() + minute) % 60 === previousMinute) minute = (minute + 1) % 30;
  date.setMinutes(date.getMinutes() + minute, 0, 0);
  return date.toISOString();
}
