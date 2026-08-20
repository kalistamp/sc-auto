# Safe Cycle Studio

A private content studio for Safe Cycle Tech: draft social posts with a frontier
model, review and approve them by hand, publish them yourself, and keep a
complete record of what went out.

It is a static site with no build step and no server. Everything runs in the
browser, and the workspace lives in one GitHub gist that you own.

---

## The workflow

```
one line about the post → model drafts one version per platform
      → you review, edit, or re-run it → you approve
      → Copy post → open the platform → you log in and paste
      → you publish → paste the link back → permanent record
```

**Nothing in this app posts to a social platform, and nothing ever will.** Using
a model to help write a post is not the same thing as a bot logging into an
account, and the platforms treat them very differently. Automating the final
submission through scraping or browser automation is what puts an account at
risk, so the final step stays unmistakably human. What the studio automates is
everything around it: drafting, checking, reminding, and recordkeeping.

The handoff is the same for every platform, including any you add yourself:

1. **Copy post** puts the finished text — body and hashtags together — on your
   clipboard. It sits directly under the **Ready to paste** panel, which shows
   exactly what it will give you, so nothing about the copy is a surprise.
2. **Open <platform>** takes you to that platform's own home or login page,
   copying the post on the way. Platforms with no link (the neutral **Any
   platform**, or one you have not given a URL yet) show the copy button alone
   rather than a second control that only repeats it.
3. You log in, paste, read it once more, and publish it yourself.

There are no exceptions and no special cases. Earlier versions prefilled
Reddit's composer through its submit URL; that was removed, because a handoff
that behaves differently on one platform is a handoff you cannot trust at the
one step where a mistake is public.

---

## Writing a brief

**A brief is one line.** Say what the post is about — a sentence, a phrase,
whatever you would say to a colleague across the room — and press *Generate
drafts*. Under it is a row of one-click starters built from your own approved
facts, minus anything that reads like a post you have already published.

Everything else is optional and folded away under **Add detail**: campaign name,
audience, goal, a must-include phrase, call to action, tone, target date, tags.
Leave them blank and the model works them out from your organization profile and
reports what it assumed; the draft's **Brief** card labels those lines
*model's read* so you can tell its assumptions from your instructions. Anything
you do fill in is followed exactly and never overwritten.

The reasoning is simple: a form that demands an audience, an objective, and a
key message before it will write anything is asking you to write most of the
post. At that point you may as well write the post.

---

## Re-running a draft

The **Shared message** at the top of a draft is the spine every platform version
is written from — it is never published anywhere itself. Edit it and press
**Re-run drafts**, and the model rewrites each unpublished version from your
wording, with the drafts it is replacing passed in as what *not* to repeat.

Nothing is lost when you do:

- The version being replaced is snapshotted into **History** first, with the
  receipt of the model that wrote it.
- **History** also holds the current generation as the model wrote it, whenever
  you have edited over it, and every restore snapshots what *it* replaces — so a
  restore is itself undoable from the same list.
- Approved versions go back to draft, because the text they were approved for no
  longer exists. Published versions are never touched by any of this.

The last eight versions are kept (`DRAFT_HISTORY_LIMIT` in
[`js/config.js`](js/config.js)); the whole workspace is one JSON file, and a
snapshot carries the full text of every platform version.

---

## Platforms

The platform list is yours, and it lives in the workspace rather than in the
code. Settings → Platforms — the **first** card on that page — is where you
switch platforms on and off, add ones that are missing, and edit anything about
them. Every row there has its own **Open**, **Edit** and **Remove** buttons.

The Overview page also carries a **Your platforms** card: one tile per switched-on
platform, each a direct link to that platform's login page, plus **Add platform**.
That is the fast path — copy a post, click through, log in, paste.

- **Any platform** is the neutral default: one draft, written to work anywhere,
  with no hashtag conventions or network-specific references. Its limits are the
  tightest of the mainstream networks, so a draft that passes really can be
  pasted anywhere.
- **Add platform** takes a name, a home or login link, a colour, the character
  limits, and a line of guidance for the model. That is all a platform is here.
- **Remove** deletes a platform you have never posted to. If recorded posts use
  it, it is *retired* instead: it disappears from new briefs, but every post
  keeps its real platform name, colour and limits. Publication history is never
  rewritten to fit a shorter list.

LinkedIn shipped as a built-in until version 3.2.0 and no longer does. A
workspace that already has LinkedIn posts keeps them, with the platform
automatically re-registered as retired.

---

## Getting in

Enter the passkey. It is whatever `APP_PASSKEY` says in
[`js/config.js`](js/config.js) — currently `p`. Change it before publishing.

That passkey is a **privacy latch, not security**. These files are public, so
anyone can read the passkey out of them. What actually protects the workspace is
the GitHub token you enter per device, which never leaves that browser.

Closing the tab re-locks the studio. Reloading during a session does not.

---

## Cloud sync

Open **⚙ Cloud sync** from the top bar (or Settings → Cloud sync) and fill in
four things:

| Field | What it needs |
|---|---|
| GitHub token | A fine-grained token with **Gists → Read and write**, and nothing else |
| Gist ID | A secret gist containing one file named `sc_data.json`. A full URL works |
| Provider | Anthropic Claude, OpenAI, or Google Gemini |
| API key + model | The key for that provider and the model id to ask for |

Seed the gist by pasting [`data.template.json`](data.template.json) into
`sc_data.json`. Each provider keeps its own key and model, so switching providers
does not throw the other configurations away.

**Credentials stay in that browser's local storage.** They are never written to
the gist and are not part of a backup. On a second device you enter them once
more. That is deliberate: syncing plaintext keys behind a short passkey would be
worse than typing them again.

Without a gist the studio still works — everything is kept on that device and
nothing is uploaded.

### What syncing gives you

- **Debounced writes with a ceiling.** Edits coalesce into one save, and no edit
  can sit unsaved for more than six seconds.
- **Conflict detection, not conflict destruction.** If the gist moved under you,
  the studio stops and asks which version to keep. It never silently overwrites.
- **Version history.** GitHub stamps a revision on every save, so the gist is
  its own undo stack — Settings → Cloud sync → Versions lists them and can
  restore one. Restoring is itself a save, so it is undoable too.
- **Offline tolerance.** Changes are held on the device and pushed when the
  connection returns.

---

## Proof of which model wrote what

Every generation records a **receipt**: the provider, the model that was
*requested*, the model that actually *answered*, the prompt version, the
response id, token usage, and latency.

Those last two are not the same field, and that is the point. A provider can
resolve a family alias to a dated snapshot (`claude-opus-5` →
`claude-opus-5-20260317`) — which counts as a match — or serve something else
entirely, which does not. The receipt chip says which:

| Chip | Meaning |
|---|---|
| green, check | The model that answered is the one that was requested |
| amber, alert | A **different** model answered. Re-read anything it wrote |
| dashed | The provider did not report a model, so nothing is confirmed |
| copper, link | Recorded by hand — no model was involved |

**Model runs** is the audit view: every generation, successful or failed, with
its full receipt. Click the eye on any row for the detail sheet.

---

## Recordkeeping

Each platform version keeps three separate texts, so editing a draft can never
quietly rewrite history:

- `aiBody` — the model's untouched output, frozen at generation
- `body` — the working copy you edit and approve
- `publishedBody` — the exact text at the moment you marked it published

Alongside them, `post.generations` holds the drafts a re-run or a restore
replaced. All of it is read through one **History** button next to the shared
message — there used to be a per-platform *Model's original* button as well, and
two ways to reach earlier text under different names was one too many.

**Record a post** (in the Library) adds something you wrote and published
straight on a platform, without it ever being drafted here. It joins the same
record, marked as having had no model behind it.

---

## Reading a post

Lists truncate to one line and the editor holds the copy in a box sized for
typing, so neither is any good for reading a long post end to end. **Read full
post** — under the Ready to paste panel, on the eye beside any Queue row, and on
anything in the bin — opens the whole thing in its own window.

It shows the same text the clipboard gets, hashtags included, in the position
they will be published in. The text wraps: your paragraph breaks are kept, and a
long URL breaks rather than pushing the window sideways. Nothing in that window
scrolls horizontally. Where a post has several platform versions, they are one
click apart at the bottom.

The reader is read-only on purpose — editing belongs in the editor, where the
character meters and the platform checks are.

---

## Deciding against a post

Three ways to say no, in order of how final they are:

| You want to | Do this | What happens |
|---|---|---|
| Send it back for another pass | **Back to draft** on that version | Approval is withdrawn; the text stays |
| Keep the record, out of the way | **Archive** | It leaves the active lists and keeps everything |
| Not use it at all | **Delete** | It moves to **Deleted posts** for 30 days |

**Deleting no longer destroys anything.** The post goes to the bin whole — every
platform version, its receipt, its publication record, its draft history — and
**Restore** brings all of it back to the library. Each row shows how many days
are left, and the last three days are flagged.

After 30 days an entry is removed for good. There is no server here to run a
timer, so expiry is applied from the clock whenever the workspace is next opened
— on whichever device opens it. **Remove permanently** and **Empty the bin** do
the same thing immediately, and both say plainly that the gist's revision history
is the only copy left afterwards.

The window and the bin's size cap are `DELETED_RETENTION_DAYS` and
`DELETED_LIMIT` in [`js/config.js`](js/config.js).

One thing the bin does quietly: a platform used only by a deleted post stays
registered. Otherwise removing that platform, then restoring the post a week
later, would produce a post pointing at a platform the list no longer has — and
the studio refuses to save a workspace that contradicts itself, so the symptom
would be saving stopping altogether.

---

## What "scheduled" means

A date is a note in a diary. Nothing in this app publishes on a timer, and the
Queue is a list of things waiting for a person.

So a platform version is **scheduled** when it has a date and has not been
published — however that date got there: the target date on the brief, the
*Planned date* field on the draft, or the Schedule dialog. All three now leave
it in the same state. The **Queue** additionally holds approved work with no
date on it yet, and the sidebar badge counts exactly what that page lists.

That last paragraph is one rule in [`js/data.js`](js/data.js) (`isScheduled`,
`isQueued`) that every count reads. Before, the Overview tile counted a status
while the Queue read the date, so a post given a date on the New draft form
appeared under its day in the Queue while the tile said **Scheduled 0**.

---

## Best time to post

Every place you can put a date on a post now says when the research says to put
it: on the draft card under *Planned date*, and in the Schedule dialog with the
reasoning open underneath. **Use this time** moves the field to the next real
occurrence of that window, and the Schedule dialog starts on it rather than on
an arbitrary "tomorrow at 10".

Settings holds the whole table at once, with every source behind it.

The windows live in [`js/timing.js`](js/timing.js) and nothing fetches them at
runtime. Two things about them are deliberate:

**They are labelled by how good the evidence is, not by how confident the
sentence sounds.** Facebook and Instagram rest on Sprout Social's 2026 study
(~2 billion engagements, ~307,000 profiles) and Buffer's (52 million posts).
Nextdoor rests on Nextdoor's own guidance, which is first-party but publishes
no sample size and dates to 2020. Reddit rests on no large study at all,
because none exists — neither Sprout nor Buffer covers it — so it is marked
**weak evidence** and says on its face that the real unit is the subreddit.

**Where two large studies disagree, both are shown.** On Facebook they do:
Sprout finds afternoons strongest, Buffer finds mornings strongest, and they
agree only on the day. The dialog says so and offers the losing window as the
second option, because an operator who knows the sources conflict will run a
test and one handed a single confident number will not.

None of this is a prediction about this organization's audience. It is an
average over other people's, shown with that sentence attached every time.
Once the workspace holds a season of publication records, they beat it.

---

## Guardrails

The model is given the organization's approved facts and standing rules, and
told it may state nothing else. On top of that, every draft is checked before
approval:

- empty body, or over the platform's hard character limit — blocks approval
- longer than a typical post for that platform — a warning
- Reddit without a title — blocks approval
- absolute claims (`guarantee`, `100%`) — a warning
- any figure at all — a warning to check it against a source
- more hashtags than the platform needs — a warning
- new copy that reads like something already published — a warning on the post

Warnings never block. The operator knows things the app does not.

---

## Keyboard

| Key | Does |
|---|---|
| `g` then `o` `c` `l` `q` `r` `d` `s` | Overview, Compose, Library, Queue, Runs, Deleted, Settings |
| `n` | Start a draft |
| `/` | Search the library |
| `t` | Toggle light and dark |
| `?` | Shortcut list |
| `Esc` | Close a dialog or the menu |

Shortcuts are ignored while you are typing in a field.

---

## Appearance

Light, dark, and system, in Settings → Appearance, or `t` to flip. The theme is
applied before first paint by an inline script in `index.html`, so a dark-mode
visitor never gets a white flash.

---

## Running it

No install needed:

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000` and enter the passkey from `js/config.js`.

Tests are Node's built-in runner, no dependencies:

```bash
npm test      # unit tests
npm run check # syntax check every module, then the tests
```

### Releasing a change

The build stamp appears in five places and they must agree: `BUILD` in
[`js/config.js`](js/config.js), `--build` in `styles.css`, `data-build` on
`<body>`, the `?v=` queries in `index.html`, and every entry in that file's
import map. Bump all five, then run `npm run check` — `tests/boot.test.mjs`
fails if the import map falls behind or misses a module.

The import map is not decoration. Without it the browser can pair a freshly
fetched `app.js` with a cached `data.js` from the previous deploy; ES modules
link before they execute, so a renamed export means **no code runs at all** and
the passkey gate renders with a dead Unlock button and nothing in the UI to
explain it. If you ever see that, hard-reload (Ctrl+Shift+R, or Cmd+Shift+R on
a Mac) — and after five seconds the gate now says so itself.

---

## Files

```text
index.html            App shell, icon sprite, theme bootstrap
styles.css            Design tokens and every rule; light and dark
js/config.js          Passkey, build stamp, tuning constants
js/data.js            Schema, migration, validation, derived state
js/platforms.js       Per-platform rules, checks, and handoff
js/providers.js       The three model adapters and the receipt
js/voice.js           House style: the prompt's voice rules and the draft scanner
js/settings.js        Per-device credentials and preferences
js/sync.js            Gist store: load, debounced save, conflicts, history
js/theme.js           Light / dark / system
js/timing.js          Best time to post: the research table and its citations
js/ui.js              Escaping, formatting, modals, toasts, focus retention
js/app.js             Views and interaction
data.template.json    Seed contents for the gist file
tests/                Node test suite
worker/               Optional, currently unused server-side gateway
```

### About `worker/`

A Cloudflare Worker that would hold the credentials server-side instead of in
the browser. It is **not wired up** — the app calls the providers directly,
which is what lets this project have no server at all. The trade is that the
keys live in your browser rather than in a backend you have to run and pay for.
The directory stays as a foundation if that trade ever stops being the right
one.

---

## Upgrading from the previous version

Migration is automatic on first load and nothing needs doing by hand. Schema 1
and 2 workspaces both come forward.

**Schema 1 → 2.** Old posts carry a single model string, so their receipt
reports it as both requested and answered and is marked unverified rather than
pretending to a match it cannot prove. Their variants get the current body as
the model original, since there is no separate record of it.

**Schema 2 → 3.** `platformSettings` is folded into a new `platforms` array —
your enabled/disabled choices, guidance and account names all come across. The
neutral **Any platform** option is added. Any platform your posts reference but
the list no longer offers, LinkedIn included, is re-registered as retired so no
post is orphaned or reassigned.

**Within schema 3 (3.2 → 3.4).** No migration step and no version bump: posts
gain `topic`, `derived` and `generations`, the workspace gains `deleted`, and all
of them default cleanly on an older workspace. Two things do change on load, both
in the direction of the record being true:

- A post written before briefs shrank has its `topic` read from its old key
  message, so nothing shows up blank.
- An approved version that already carries a date is opened as **scheduled**,
  which is what it always was to the Queue.

Back up before upgrading if you want a way back: Settings → Data → Backup .json.
Schema 3 is not readable by older builds.

---

## What this does not protect against

- The passkey and browser-stored credentials are not server-grade security.
- Anyone with access to the browser profile has the credentials.
- Use a dedicated, narrowly scoped GitHub token, and rotate it if a device may
  be compromised.
- Set spending limits and billing alerts with every model provider.
- Do not put donor, student, pickup-address, or other personal information into
  the gist or into a model prompt.
