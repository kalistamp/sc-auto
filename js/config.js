/* ============================================================
   SAFE CYCLE STUDIO — configuration

   No credentials live here. The GitHub token and every model API key
   are yours, entered once per device under Settings → Cloud sync, and
   kept in that browser's localStorage only. Nothing in this repository
   can reach your gist, which is what makes the published site safe.
   ============================================================ */

/* Unlocks the front page. NOT a security boundary, and deliberately so:
   this file is served publicly, so anyone who views source can read it.
   Its only job is to stop a scraper or a casual passer-by from landing
   in the interface — the workspace itself is protected by the GitHub
   token you enter, which never leaves your browser, and by the fact
   that no credential is stored in this repository at all. */
export const APP_PASSKEY = "p";

/* BUILD STAMP — must match, in five places:
     · `--build` in styles.css
     · `data-build` on <body> in index.html
     · the ?v= query on the <link> and <script> in index.html
     · every entry in index.html's <script type="importmap">

   app.js compares the first three at boot and shows a banner if they
   disagree, because the GitHub Pages CDN will happily serve a stale
   stylesheet for a while after a push and the resulting half-broken UI
   is very hard to diagnose otherwise.

   The import map is the one that cannot be checked at runtime, and it is
   the one that matters most. Without it a deploy can pair a fresh app.js
   with a cached data.js; the module graph then fails to LINK, so no code
   runs at all, and the passkey gate renders with a dead button. That has
   happened. tests/boot.test.mjs is what enforces it now — bump all five
   together and run `npm run check`. */
export const BUILD = "3.7.0";

/* The single file inside the gist that holds the whole workspace. */
export const GIST_FILENAME = "sc_data.json";

/* Quiet period after an edit before a save fires, in ms. */
export const SAVE_DEBOUNCE_MS = 900;

/* Ceiling on how long an unsaved change may sit. Without it, steady
   typing resets the debounce forever and nothing is ever written. */
export const MAX_SAVE_WAIT_MS = 6000;

/* Gist revisions listed in the version-history dialog. GitHub returns
   every save since the beginning; showing all of them is just noise. */
export const HISTORY_LIMIT = 30;

/* Generation runs kept in the workspace. This is the audit trail for
   "which model wrote which post", so it is worth keeping deep — but not
   unbounded, since the whole workspace is one JSON file. */
export const RUN_LOG_LIMIT = 150;

/* Activity entries kept. Shorter than the run log: these are UI
   breadcrumbs, not an audit record. */
export const ACTIVITY_LIMIT = 120;

/* ---- the bin -------------------------------------------------------

   Deleting a post moves it here rather than destroying it. A record of
   what went out — and what was decided against — is the most valuable
   thing in this workspace and the least recoverable, and an undo that
   lives for nine seconds in a toast is not a safety net for a decision
   somebody might revisit tomorrow.
   ------------------------------------------------------------------ */

/* How long a deleted post stays recoverable. After this it is removed
   for good, automatically, wherever the workspace is next opened. */
export const DELETED_RETENTION_DAYS = 30;

/* A backstop on the size of the bin, because the whole workspace is one
   JSON file and a deleted post carries its full text and history. Only
   ever trims the OLDEST beyond this count; the retention window above is
   what normally empties it. Deliberately far above any plausible
   month of deleting. */
export const DELETED_LIMIT = 200;

/* Earlier drafts kept per post, so re-running a generation can be
   compared against — and reverted to — what it replaced.

   Bounded because the whole workspace is one JSON file and a snapshot
   carries the full text of every platform version. Eight is roughly a
   morning of iterating on one post, which is as far back as anyone has
   ever wanted to reach. Beyond that the older ones fall off the end. */
export const DRAFT_HISTORY_LIMIT = 8;

/* How long the Undo button stays on a toast, in ms. */
export const UNDO_MS = 9000;

/* Two drafts whose vocabulary overlaps more than this are flagged as
   possible repetition. Jaccard similarity over words longer than three
   characters — high enough that a shared call-to-action alone does not
   trip it. */
export const SIMILARITY_THRESHOLD = 0.55;

/* ---------- voice (js/voice.js) ------------------------------------
   CHANGE (2026-08): comments updated to reflect the upgraded scanner
   and the new smoothness check.

   CHANGE (2026-08b): values now move, where 2026-08 deliberately left
   them alone. Leaving them alone turned out to be the wrong call: the
   smoothness check was added precisely because the variation threshold
   was not doing its job, and the threshold that was generating false
   positives on good copy went unexamined. Two new knobs below, and the
   exemplar count is up.
   ----------------------------------------------------------------- */

/* Below this many sentences a post has no rhythm to judge, and the
   variance figure is noise. A two-line Instagram caption is exempt.
   Also used by the smoothness check (which only runs at ≥5). */
export const VOICE_MIN_SENTENCES = 4;

/* Sentence-length variation (standard deviation over mean) under which
   copy reads as machine-even. Unedited model prose typically lands
   around 0.25–0.40; someone typing quickly lands well above 0.55.
   Set at the low end of human so the warning stays rare enough to
   mean something.

   Unchanged at 0.45, but it now means something narrower: it is only
   consulted when the mean sentence is at least VOICE_EVEN_MIN_MEAN words
   long. That gate is what makes this number honest — 0.45 was derived
   from prose paragraphs, and it is now only ever applied to them. */
export const VOICE_MIN_VARIATION = 0.45;

/* NEW (2026-08b). Mean sentence length, in words, below which evenness
   is not evidence of anything.

   The distinction the old check could not draw: a post whose sentences
   are all about six words long is a punchy human post, and a post whose
   sentences are all about sixteen words long is unedited model prose.
   Both score identically on variation alone, so variation alone was
   flagging good short copy — measurably, on real hand-written posts.
   Twelve sits above the short-punchy band and below the band where
   models cruise. */
export const VOICE_EVEN_MIN_MEAN = 12;

/* Published posts fed back to the model as voice examples.

   Raised 3 → 4 (2026-08b). Exemplars are the strongest lever this system
   has — far stronger than any list of forbidden words — and the room was
   paid for by cutting the ban lists in the prompt down to the worst ~15
   of each. Four still leaves the brief plenty of space. */
export const VOICE_EXEMPLAR_COUNT = 4;

/* Each example is trimmed to this many characters. Long enough to show
   how a post opens, carries, and signs off. */
export const VOICE_EXEMPLAR_CHARS = 600;

/* NEW (2026-08b). Shortest post that can serve as a voice example.
   A twelve-word caption is not evidence of a house style, and spending
   one of only four slots on it displaces something that is. */
export const VOICE_EXEMPLAR_MIN_CHARS = 80;