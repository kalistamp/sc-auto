# Browser publisher — Safe Cycle Studio 3.12

This is a separate, unattended Node process. It uses Playwright to operate platform
websites. It does **not** use social publishing APIs. Supabase still supplies
workspace storage/authentication, and optional model generation still uses the
existing model providers.

The website is the control panel, not the scheduler. Closing Studio does not
stop a running publisher. Turning off the runner computer does. No live posting
is enabled by installing these files.

## What is implemented, and what requires configuration

Implemented: schema-4 opt-in, pure content/cadence policies, persistent-browser
delivery engine for Facebook/Reddit/Nextdoor/Craigslist/OfferUp, private image
uploads, independent permalink read-back, durable claims/audit, crash recovery,
generation from a topic backlog (paced to what cadence can send), service
listings and native renewal, the **Automation** section in Studio (runner status,
failures, held posts, attempts, policy, backlog, images, listings), and optional
external failure/heartbeat webhooks. Manual publication and automated
publication use the same recording helpers. The old `worker/` is untouched and
unused.

**Not calibrated:** actual account composers, account names, subreddits, areas,
categories, upload widgets, public permalinks, or Nextdoor read-back. The
generic site home URLs do not identify these. `recipes` is deliberately empty:
the software will not guess which account or button to use. The supplied recipe
is a format example, not a claim that its selectors work on a live website.

The additive SQL is tested against PostgreSQL (PGlite) with a stand-in for the
project's own sync functions. The project's original `prelaunch_deployment/sc`
SQL is absent from this repository. Review the actual
`apply_workspace_changes(bigint,jsonb)` signature, owner RLS and revision
locking before deploying `migrations/001_publisher.sql` to staging. This
migration adds a separate journal table/RPC and a private Storage bucket; it does
not change the existing workspace entity allowlist, and it can be re-run.
Policy, backlog, images and service listings are stored in the existing
metadata row. Audit, lease and failure state are authoritative in the separate
table, so restoring a workspace cannot erase evidence or authorize a duplicate
send. JSON backups include a read-only audit snapshot; restoring it does not
replace the journal.

## One-time setup on the always-on host

Use Node 20 or newer. From this directory:

```text
npm ci
node cli.js init
node cli.js auth
node cli.js login facebook
node cli.js login reddit
node cli.js login nextdoor
node cli.js login craigslist
node cli.js login offerup
```

`init` creates `publisher/.local/config.json`. The runner keeps everything it
stores in `publisher/.local/` however it is started (set `SC_PUBLISHER_CONFIG`
to use a different config file); `.local/` is ignored by Git. Set `SC_EMAIL`
and `SC_PASSWORD` temporarily in the host environment for `auth`, using the
**existing Supabase workspace owner**, then remove the password. This stores a
refreshable workspace session on the host. No service-role key is needed or
accepted. Never paste secrets in Studio, the repository or chat.

The default browser channel is installed Google Chrome. `login` opens a
**dedicated publisher profile**; sign in once, then close that browser. It keeps
cookies and storage across restarts, so no further login is needed until a
site signs it out. It does not copy or decrypt your everyday Chrome profile, so
existing logins in your normal browser are not automatically available here —
sign in once in this profile instead. A local `cdpEndpoint` can attach to an
already configured Chrome debugging session; never expose that endpoint to a
network. Use a dedicated profile and do not operate it concurrently with the
runner.

Sites can expire/revoke cookies or require 2FA/CAPTCHA. Those stop delivery,
show on the Automation page, and require you to sign in again with `login`. No
code bypasses challenges or hides automation. Browser-only operation is not a
guarantee against account restrictions.

Protect `.local/` with an OS account ACL (Unix mode 0700/0600 is also requested).
It contains browser sessions, workspace refresh tokens, image copies and logs.
Do not place it in a synced/public folder. Configure a supervisor to restart the
runner under that same account, with this directory as its working directory.
On Windows use a Task Scheduler task running `node.exe cli.js run` with this
working directory, "Run only when user is logged on", and restart on failure;
headed Chrome needs an interactive logged-in desktop. On Linux a headed browser
needs a display/session. Sleep or logout interrupts delivery; an unattended
machine must be configured not to sleep.

## Calibrate each website once, without publishing

1. Set the account-specific composer URL in host configuration (`startUrl`) and
   in Studio's Automation page ("Page the runner starts from"). These must agree
   exactly. Use a Page, a particular subreddit, the intended Nextdoor business
   profile or the correct service category — not just the generic home page.
2. Run `node cli.js inspect facebook` (or another platform). Use the Playwright
   inspector to capture **unique, exact** role/name, label or CSS locators.
3. Copy the structure of `recipe.example.json` into `recipes.<platform>` in the
   local config. Declare ordered preparation steps, account identity assertion,
   a **separate** final submit locator and permalink extraction. Required source
   fields are `body`; Reddit also requires `title`; listings also require `title`,
   `category` and `area`. Upload steps consume approved private image IDs. Use
   `select` with the site's real category value where necessary. No fuzzy
   "try another button" or model-driven recovery is used.
4. Configure read-back locators for the exact body, author, title when present,
   and attached photo elements when used. `verify.unavailable` may identify a
   removed/moderation state. Craigslist additionally requires `verify.listedAt`,
   the public category/index URL where the exact permalink is visible.
5. Supply a real, already published `samplePermalink`, exact `sampleBody`, optional
   `sampleTitle` and `calibratedAt`. Run `node cli.js validate facebook`. Validation
   only reads this existing permalink. It does not publish a canary. A passing
   sample check does not prove the composer has not changed; preparation asserts
   field contents again for each real attempt.
6. Read-back normally uses a fresh, signed-out browser context, so the author's
   private view is not mistaken for publication. Nextdoor posts are only readable
   signed in, so Nextdoor needs either `readerStorageState` (a host-local
   Playwright storage-state file for a **second** account) or `"verifyAs":
   "author"`. The author option reads the post back in the publisher's own
   session: it proves the post exists with the exact text and author, not who
   else can see it, and the evidence records it as "author session". The same
   option exists for any platform whose public view hides the post. If neither is
   acceptable, keep that platform off.

For native listing renewal, add a `renew` object with its own `steps` and
`submit`, plus optional `startUrl` (the page renewal starts from — for
Craigslist, the account's page for the listing; without it the runner opens the
listing's permalink), `confirmLocator` (what appears once renewal succeeded) or
`permalinkLocator`. The runner asserts the account, executes the native renewal
and verifies visibility again. OfferUp service subscriptions often renew
natively without a runner action; leave Studio's renewal interval at 0 for that
case. Do not configure duplicate repost flows or a purchase/subscribe step.
`paidAction` recipes are rejected. Initial paid subscriptions, category
eligibility, phone verification and terms acceptance belong in attended setup.

## Generation, the content gate, and images

On the Automation page, switch on the social destinations you want and add
topics, one per line. Writing is off until you enable it. Each topic becomes one
post for whichever enabled social platform has nothing else waiting, so the
backlog is written at the pace cadence can actually send, never faster than the
24-hour writing limit.

The runner writes with whatever is chosen in Studio's **Model settings** while
"The runner writes with this model too" is on: that saves the provider, model
and key to `sc.publisher_secrets` in Supabase, readable only by the workspace
owner through `publisher_command`, and the runner reads it each minute. So
switching provider in the website switches the runner too; nothing on the host
needs editing. The config's `provider`, `model` and `modelKeyEnv` are only a
fallback for when nothing is shared.

Scheduling an approved version with **Post it automatically at this time**
switched on (the default when automation and that platform are on) is all the
runner needs: the approval is bound to that exact text, destination and images,
and an edit afterwards sends it back through the checks below. The runner
follows the workspace's timezone, and without a config file it runs on the safe
defaults (dry run on the host).

A written post goes out **without anyone reviewing it** only when it trips none
of the checks: no platform warning (length, absolute claims, voice findings,
duplicated contact details), no warning from the model itself, no close repeat
of an earlier post, no note asking for something to be checked, and no
claim-shaped wording — a number, date or event, partnership, certification,
price, tax or time promise, quote, person's story, a claim about every device,
a name (any capitalised school, business, person or place), superlative, link
or placeholder — unless the same words are already in your approved facts, the
mission or the topic you wrote. A number must be one of your numbers as a whole
("800-88" does not approve "800"). Anything else is held on the Automation page
under **Needs you**, with its reasons, and nothing more is written for that
platform until you deal with it. Approving a post word for word (Set up
automatic delivery → "I read this exact copy") sends it as approved; editing it
afterwards takes the approval away. Structural errors always block.

This is a deliberate trade: pattern checks catch the claim types your rules
forbid inventing, but they cannot prove a sentence true. That residual risk is
the price of posting without review.

"Queue approved facts verbatim" writes posts from the approved facts themselves,
with no model key. Set topic reuse to at least 30 days to repeat **finished**
topics. A generation failure is recorded as a failed run, counts against the
daily limit and is reported, but does not stop publishing; three failures in a
row retire that topic until you press "Try again". After any failed attempt
to write or save a post, the runner waits an hour before writing again.

Upload owned/consented JPEG, PNG or WebP images (up to 10 MB) on the Automation
page. The `publisher-images` bucket is private and owner-scoped. Select images in
each post's automatic-delivery dialog or the service listing form. Only
identifiers are stored in the workspace; the runner downloads files using its
workspace session and attaches them through the browser. No new social API is
involved. The browser recipe must include an upload step and photo read-back.
Image-count verification detects missing attachments; it is not a pixel-identity
guarantee after a platform recompresses media.

## Dry-run and activation

Both workspace dry-run and host `live: false` default to safe operation. Run:

```text
node cli.js once
node cli.js run
```

Dry-run evaluates real gates, cadence and claims, and records one decision per
unchanged payload. It performs **zero browser preparation or submission actions**.
Repeated dry-runs do not consume actual posting caps, and only the newest 100
dry-run decisions are kept. Live mode requires both workspace dry-run unchecked
and `live: true` in the local host configuration. Do not enable it until staging
tests, real-account calibration and an explicitly authorized canary have
succeeded. No canary was posted during implementation.

The process uses the configured timezone and rejects a different workspace
timezone. `timing.js` is reused unchanged. Cadence adds minimum gaps, local-day
and rolling-day/week caps, quiet hours and persisted jitter. A limit that
applies to one platform only holds that platform; another platform's due post
still goes. New posts are scheduled into the first window the gaps allow.
Overdue items older than an hour are deferred into a future window rather than
burst-posted after downtime. One publication can be in flight per workspace.
Manual postings outside Studio cannot be serialized by this service; record
those promptly.

## Incidents, restart and reconciliation

The journal tracks `claimed → submitting → verifying → succeeded`. Preparation
leases expire after five minutes. After the submitting barrier, lease expiry
**never** authorizes another submission. Read-back is retried twice (after 20
and 60 seconds) because a new post can take a moment to appear; submission is
never retried.

- **Stopped before posting** (login expired, a selector changed): nothing was
  sent. Posting pauses and the Automation page says why. Fix the cause, then
  press **Resume posting**; the runner tries that item again. An edit made in
  Studio while the runner was preparing is not a failure: the runner drops that
  attempt and starts again next minute. A runner killed while preparing leaves a
  claim that expires after five minutes and is then retried. A preparation step
  that lands on a published post is treated as a possible post, never retried.
  If the dedicated Chrome window is closed, the next attempt opens it again.
- **May or may not have gone out** (crash after the click, missing permalink,
  read-back failure, recording failure): posting stops and stays stopped.
  Restarts reconcile; they do not click Publish again.

To verify and record an uncertain result without submitting, on the host:

```text
node cli.js reconcile ATTEMPT_ID https://actual-platform-permalink
```

This reuses the frozen copy and the configured reader. Or, on the Automation
page, **Record what happened**: stop the runner and wait five minutes (a send
still in progress cannot be settled while any runner is checking in), look at
the account, then
either record it as live (with its link — the publication record is written
from the text the runner actually sent) or record that it is not there, which
lets the runner post it again after you resume. "No result found yet" is not
evidence that a submission failed.

Only one runner may use the browser profile. A `runner.lock` left by a runner
that has since died is taken over automatically on the next start; a lock held
by a running process is refused. The database barrier remains authoritative
either way. Never delete browser-profile files or journal rows as a retry
strategy. At 1,000 journal attempts the runner stops rather than discarding
deduplication evidence; archival needs an explicit design.

Failures appear on the website: the Automation section lists everything the
runner reported, what needs you, and every attempt, and the Overview shows a
banner while anything needs attention. They also go to `.local/failures.log`.
To receive notices with the site closed, optionally set the HTTPS endpoint named
by `alertWebhookEnv`; it receives `{ "text": "..." }`. A notice that cannot be
delivered is logged and never stops the runner. Configure `heartbeatWebhookEnv`
with an independent dead-man monitor to detect host/network death; without it,
the website shows the runner as offline after three missed minutes.

## Verification

From the repository root: `npm run check`.

From this directory after `npm ci`:

```text
npm test
```

That runs the SQL contract tests, the runner end to end against the real
migration (`test:runner`), the browser adapter against intercepted fixture pages
for all five platforms (`test:browser`, never the real services) and the
Automation page in a real browser at desktop and phone widths (`test:ui`). Set
`SC_TEST_BROWSER_CHANNEL=chrome` to use installed Chrome, or install Chromium
with `npx playwright install chromium`. The SQL fixture checks real PostgreSQL
transitions and owner isolation, but is not a substitute for testing the missing
deployment RPCs in staging.

The browser boundary test was deliberately retained and narrowed to `js/`.
All executable publishing stays in this directory. No build step was added.
