import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { BUILD } from "../js/config.js";

/* ============================================================
   BOOT INTEGRITY

   Everything here guards one failure mode, because it has now happened
   twice and both times looked like something else entirely:

     the module graph fails to load, so NOT ONE LINE of app.js runs,
     so no event listener is ever attached, so the passkey gate renders
     as static HTML with a dead Unlock button.

   It is a uniquely nasty bug to report. Nothing is on fire, nothing is
   red, the page looks completely normal, and the only evidence is in a
   console the operator has no reason to open. "The passkey stopped
   working" is what it looks like from outside.

   Two causes so far:
     1. js/voice.js was truncated mid-comment, so it did not parse.
     2. index.html versioned js/app.js but not the modules it imports, so
        a deploy could pair a fresh app.js with a cached data.js. A
        renamed export then breaks linking.

   ES modules link before they execute, which is what makes both cases
   total rather than partial. These tests are cheap; the bug is not.
   ============================================================ */

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");

/* Just enough browser for a module to reach the end of its own body.
   js/theme.js reads window at load time, which is correct for a
   browser-only module and not something to design around — but it does
   mean importing it here needs these to exist. Nothing below simulates
   behaviour; these only have to be non-throwing. */
const noop = () => {};
globalThis.window ??= {
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  addEventListener: noop
};
globalThis.localStorage ??= globalThis.window.localStorage;
globalThis.matchMedia ??= globalThis.window.matchMedia;
globalThis.document ??= {
  documentElement: { dataset: {}, classList: { add: noop, remove: noop, toggle: noop } },
  body: { dataset: {} },
  querySelector: () => null,
  addEventListener: noop
};

async function moduleFiles() {
  return (await readdir(new URL("../js", import.meta.url))).filter((name) => name.endsWith(".js")).sort();
}

/* ------------------------------------------------------------
   1. EVERY IMPORT RESOLVES TO A REAL EXPORT
   ------------------------------------------------------------ */

test("every named import in js/ is actually exported by the module it comes from", async () => {
  const files = await moduleFiles();
  const exportsOf = new Map();

  for (const file of files) {
    /* app.js runs boot() on import and needs a DOM, so it can never be
       imported here. It is still checked as an IMPORTER below, which is
       the direction that matters: it is the entry point, and it is the
       file whose broken links kill the gate. */
    if (file === "app.js") continue;
    const module = await import(new URL(`../js/${file}`, import.meta.url));
    exportsOf.set(file, new Set(Object.keys(module)));
  }

  let checked = 0;
  for (const file of files) {
    const source = await read(`js/${file}`);
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']\.\/([\w.-]+)["']/g)) {
      const target = match[2];
      const available = exportsOf.get(target);
      assert.ok(available, `js/${file} imports from ./${target}, which is not a module in js/`);

      for (const raw of match[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        checked += 1;
        assert.ok(available.has(name),
          `js/${file} imports { ${name} } from ./${target}, but ./${target} does not export it. ` +
          `In a browser this breaks linking and NOTHING in the entry module runs.`);
      }
    }
  }
  assert.ok(checked > 50, `expected to verify a real number of imports, only saw ${checked}`);
});

test("every module in js/ parses and evaluates on its own", async () => {
  for (const file of await moduleFiles()) {
    if (file === "app.js") continue;   /* needs a DOM; covered by the link test */
    await assert.doesNotReject(
      () => import(new URL(`../js/${file}`, import.meta.url)),
      `js/${file} does not load`
    );
  }
});

/* ------------------------------------------------------------
   2. THE CACHE CANNOT SERVE A MIXED BUILD
   ------------------------------------------------------------ */

test("the import map versions every module, at the current build", async () => {
  const html = await read("index.html");
  const block = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  assert.ok(block, "index.html must carry an import map, or a deploy can mix old and new modules");

  const map = JSON.parse(block[1]).imports;
  const mapped = Object.keys(map);

  for (const file of await moduleFiles()) {
    /* app.js is versioned by its own <script src> query instead. */
    if (file === "app.js") continue;
    const key = `./js/${file}`;
    assert.ok(mapped.includes(key),
      `${key} is missing from the import map, so a browser may serve a stale copy of it`);
    assert.equal(map[key], `${key}?v=${BUILD}`,
      `${key} must be pinned to the current build`);
  }

  for (const [key, value] of Object.entries(map)) {
    assert.ok(key.startsWith("./"),
      `import map key ${key} must be relative, so the app still works in a subdirectory`);
    assert.ok(value.endsWith(`?v=${BUILD}`), `${key} points at a stale build: ${value}`);
  }
});

test("the import map is declared before the module that depends on it", async () => {
  const html = await read("index.html");
  /* An import map after the first module script is ignored, which would
     silently restore the exact bug it exists to prevent. */
  assert.ok(html.indexOf('<script type="importmap">') < html.indexOf('type="module"'),
    "the import map must appear before any module script");
});

/* ------------------------------------------------------------
   3. A FAILURE STILL EXPLAINS ITSELF
   ------------------------------------------------------------ */

test("a boot failure tells the operator what to do instead of looking normal", async () => {
  const html = await read("index.html");
  const app = await read("js/app.js");

  assert.match(html, /__sctBooted\s*=\s*false/, "index.html must arm the watchdog");
  assert.match(html, /getElementById\('gate-msg'\)/, "the watchdog must write to the gate message");
  assert.match(html, /Ctrl\+Shift\+R/, "the message must say how to force a fresh load");
  assert.match(app, /__sctBooted\s*=\s*true/, "app.js must report that it booted");

  /* The flag has to be raised before anything that can throw, or a failure
     later in boot leaves the watchdog blaming the cache for the wrong thing. */
  const bootBody = app.slice(app.indexOf("function boot()"));
  const flagAt = bootBody.indexOf("__sctBooted");
  const firstCall = bootBody.indexOf("applyTheme()");
  assert.ok(flagAt > -1 && flagAt < firstCall, "the booted flag must be set first inside boot()");

  /* Classic script, not a module: it has to survive whatever stopped the
     module graph from loading in the first place. */
  const watchdog = html.slice(html.indexOf("__sctBooted"));
  assert.ok(!watchdog.slice(0, watchdog.indexOf("</script>")).includes("import "),
    "the watchdog must not itself depend on modules");
});

/* ------------------------------------------------------------
   4. THE GATE THE OPERATOR ACTUALLY TOUCHES
   ------------------------------------------------------------ */

/* ------------------------------------------------------------
   5. NO DEAD BUTTONS
   ------------------------------------------------------------ */

test("every data-act button in the markup has a handler", async () => {
  const app = await read("js/app.js");

  /* Actions written into rendered HTML... */
  const emitted = new Set(
    [...app.matchAll(/data-act="([a-z-]+)"/g)].map((match) => match[1])
  );
  /* ...and the cases handleAction switches on. */
  const handled = new Set(
    [...app.matchAll(/case\s+"([a-z-]+)"\s*:/g)].map((match) => match[1])
  );

  assert.ok(emitted.size > 10, `expected a real number of actions, saw ${emitted.size}`);
  for (const action of emitted) {
    assert.ok(handled.has(action),
      `markup renders data-act="${action}" but handleAction has no case for it — that button does nothing`);
  }

  /* The two the operator specifically asked for, named so a rename has to
     be deliberate rather than accidental. */
  for (const required of ["platform-add", "platform-edit", "platform-remove", "open-platform"]) {
    assert.ok(emitted.has(required), `no button renders data-act="${required}"`);
    assert.ok(handled.has(required), `no handler for "${required}"`);
  }
});

test("the platform front doors are reachable without digging", async () => {
  const app = await read("js/app.js");

  /* Regression guard. These controls existed once but only at the bottom
     of a long settings page and on an already-generated draft, which is
     not "quickly open the platform" by any reading. */
  const overview = app.slice(app.indexOf("function renderOverview()"), app.indexOf("function greeting()"));
  assert.match(overview, /launcherPlatforms\(\)/,
    "the overview must list the platform links; it is the first screen after unlocking");
  assert.match(overview, /data-act="platform-add"/,
    "adding a platform must be possible from the overview");

  /* Platforms are edited far more often than the organization profile, so
     they come first in settings rather than below a long form. */
  const settings = app.slice(app.indexOf("function renderSettings()"));
  const platformsAt = settings.indexOf("<h3>Platforms</h3>");
  const orgAt = settings.indexOf('id="org-form"');
  assert.ok(platformsAt > -1 && orgAt > -1);
  assert.ok(platformsAt < orgAt, "the Platforms card must sit above the Organization form");

  /* An <a href>, not a scripted open, so the link behaves like a link. */
  assert.match(app, /<a class="launch" href="\$\{esc\(platform\.homeUrl\)\}"/,
    "front doors must be real links (middle-click, open in new tab, copy address)");
});

/* ------------------------------------------------------------
   6. THE EDITOR, AS THE OPERATOR ASKED FOR IT

   Each of these is a fix that was reported by hand, and each is the
   kind that quietly comes back the next time the markup is rearranged.
   ------------------------------------------------------------ */

test("a platform version offers exactly one copy control, next to the text it copies", async () => {
  const app = await read("js/app.js");
  const card = app.slice(app.indexOf("function variantCard("), app.indexOf("function readyBlock("));

  const copies = [...card.matchAll(/data-act="copy"/g)].length;
  assert.equal(copies, 0, "the copy button belongs to the ready-to-paste block, not the action row");
  assert.match(card, /readyBlock\(variant, meta\)/, "every variant must render the ready block");

  const ready = app.slice(app.indexOf("function readyBlock("), app.indexOf("function variantMeta("));
  assert.equal([...ready.matchAll(/data-act="copy"/g)].length, 1, "exactly one Copy post button");
  assert.match(ready, /Copy post/);

  /* "Copy for pasting" was the Open button with no platform to open —
     a second control with the same effect and a different name. Both
     labels are still discussed in the comments explaining why they
     went, so this reads the code with the prose stripped out. */
  const markup = app.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(markup, /Copy for pasting/, "a duplicate copy control under another name");
  assert.doesNotMatch(markup, /Model's original/, "superseded by the draft history dialog");
});

test("the hashtags a person types are shown the way they will be pasted", async () => {
  const app = await read("js/app.js");
  /* One function builds the clipboard text, the published record, and
     this preview, so what is shown cannot drift from what is copied. */
  assert.match(app, /function readyBody\(variant, meta\) \{\s*const text = buildCopyText\(variant\);/);
  /* And it has to follow both fields that feed it while they are typed. */
  const input = app.slice(app.indexOf("function onInput("), app.indexOf("let renderTimer"));
  assert.match(input, /field === "body" \|\| field === "hashtags"/);
  assert.match(input, /ready-\$\{variantId\}/);
});

test("the shared message can be re-run, and what it replaces is kept", async () => {
  const app = await read("js/app.js");
  const card = app.slice(app.indexOf("function canonicalCard("), app.indexOf("/* Only the rows that carry"));
  assert.match(card, /data-act="rerun-drafts"/, "the button has to sit with the field it re-runs");
  assert.match(card, /data-act="draft-history"/, "and the history it produces has to be reachable from there");

  /* The snapshot must be taken before the model is called, not after. */
  const rerun = app.slice(app.indexOf("async function rerunDrafts("), app.indexOf("function restoreGeneration("));
  assert.ok(rerun.indexOf("pushGeneration(") < rerun.indexOf("await generateDrafts("),
    "the current draft must be saved before anything can overwrite it");
  assert.match(rerun, /status !== "published"/, "a published record is never rewritten");
});

test("the editor columns space themselves, rather than each block guessing", async () => {
  const app = await read("js/app.js");
  const css = await read("styles.css");

  const editor = app.slice(app.indexOf("function renderEditor("), app.indexOf("function canonicalCard("));
  assert.match(editor, /class="editor-main"/);
  assert.match(editor, /class="editor-side"/);
  /* An inline margin here is what let the warnings box sit flush against
     the shared message with nothing between them. */
  assert.doesNotMatch(editor, /style="margin/, "editor spacing belongs in the stylesheet");

  assert.match(css, /\.editor-main, \.editor-side \{[^}]*gap: 1rem/);
  assert.match(css, /\.variant-body > \.field \+ \.field/, "fields need a rule between them, not just a margin");

  /* One flex gap only holds if the children bring no margins, and the
     reset is the same specificity as the rules it undoes — so it only
     wins from further down the file. Cheap to assert, invisible to
     debug: the symptom is uneven gaps, not a broken rule. */
  const reset = css.indexOf(".editor-main > *, .editor-side > *");
  assert.ok(reset > -1, "the editor columns need their margin reset");
  assert.ok(reset > css.indexOf("\n.notes {"), "the reset must come after the margins it resets");
  assert.ok(reset < css.indexOf("   QUEUE"), "and stay in the editor section it belongs to");
});

test("the passkey gate has the exact anchors app.js wires itself to", async () => {
  const html = await read("index.html");
  const app = await read("js/app.js");

  /* wireChrome() looks these up by id and would throw on a null, taking
     the rest of the wiring down with it. */
  for (const id of ["gate", "gate-form", "gate-btn", "gate-msg", "gate-card", "passkey", "app"]) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html is missing #${id}`);
  }

  assert.match(app, /el\("#gate-form"\)\.addEventListener\("submit", onUnlock\)/,
    "the gate form must still be wired to onUnlock");
  assert.match(app, /input\.value !== APP_PASSKEY/, "the passkey comparison must still be in place");
});
