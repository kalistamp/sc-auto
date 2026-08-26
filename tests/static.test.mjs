import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { BUILD } from "../js/config.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the entry point has the anchors the app and a keyboard user need", async () => {
  const html = await read("index.html");
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /id="gate"/);
  assert.match(html, /id="app"/);
  assert.match(html, /id="view"/);
  assert.match(html, /href="#view"[^>]*>Skip to content|class="skip-link"/);
  assert.match(html, /<dialog id="modal"/);
  assert.match(html, /<dialog id="confirm"/);
  assert.match(html, /type="module" src="js\/app\.js(\?[^"]*)?"/);
  assert.match(html, /<noscript>/, "a JS-only app should say so when JS is off");
});

test("the theme bootstrap runs before the stylesheet, or dark mode flashes white", async () => {
  const html = await read("index.html");
  const bootstrap = html.indexOf("sct.theme");
  const stylesheet = html.indexOf('rel="stylesheet" href="styles.css');
  assert.ok(bootstrap > -1 && stylesheet > -1);
  assert.ok(bootstrap < stylesheet, "the inline theme script must come first");
  assert.match(html, /classList\.add\('theme-dark'\)/);
});

test("the build stamp agrees in all four places it is written", async () => {
  const html = await read("index.html");
  const css = await read("styles.css");

  const cssBuild = css.match(/--build:\s*"([^"]+)"/)?.[1];
  const bodyBuild = html.match(/<body data-build="([^"]+)"/)?.[1];
  /* Anchored to a real href/src attribute. A looser pattern also matched
     the prose in index.html's comments, which is a test failing on its own
     documentation rather than on anything shipped. */
  const queries = [...html.matchAll(/(?:href|src)="[^"]*(?:styles\.css|js\/app\.js)\?v=([^"]+)"/g)]
    .map((match) => match[1]);

  assert.equal(cssBuild, BUILD, "styles.css --build");
  assert.equal(bodyBuild, BUILD, "<body data-build>");
  assert.ok(queries.length >= 2, "both the stylesheet and the module need a cache-busting query");
  for (const query of queries) assert.equal(query, BUILD, "?v= query");
});

test("every icon the code asks for exists in the sprite", async () => {
  const html = await read("index.html");
  const defined = new Set([...html.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map((match) => match[1]));
  assert.ok(defined.size > 20, "the sprite should not have been emptied");

  const used = new Set();
  for (const file of await readdir(new URL("../js", import.meta.url))) {
    const source = await read(`js/${file}`);
    for (const match of source.matchAll(/\bicon\(\s*"([a-z0-9-]+)"/g)) used.add(match[1]);
    for (const match of source.matchAll(/#i-([a-z0-9-]+)/g)) used.add(match[1]);
    /* The sync pill swaps its glyph from a lookup table. */
    for (const match of source.matchAll(/icon:\s*"([a-z0-9-]+)"/g)) used.add(match[1]);
  }
  for (const match of html.matchAll(/href="#i-([a-z0-9-]+)"/g)) used.add(match[1]);

  const missing = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], "a missing symbol renders as an invisible button");
});

test("both themes are fully defined, and neither is a media query away from breaking", async () => {
  const css = await read("styles.css");
  assert.match(css, /^:root\s*\{/m);
  assert.match(css, /:root\.theme-dark\s*\{/);
  assert.match(css, /color-scheme:\s*light/);
  assert.match(css, /color-scheme:\s*dark/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /@media \(max-width: 760px\)/, "the sidebar needs a drawer breakpoint");

  /* Every token used in the dark block must exist in the light block,
     or dark mode inherits a value that was tuned for paper. */
  const lightBlock = css.slice(css.indexOf(":root {"), css.indexOf(":root.theme-dark"));
  const darkBlock = css.slice(css.indexOf(":root.theme-dark"));
  const darkTokens = [...darkBlock.matchAll(/^\s{4}(--[a-z0-9-]+):/gm)].map((match) => match[1]);
  const missing = darkTokens.filter((token) => !lightBlock.includes(`${token}:`));
  assert.deepEqual(missing, [], "dark overrides a token the light palette never declared");
});

test("hardcoded colours stay out of the layout rules", async () => {
  const css = await read("styles.css");
  /* Scan between the end of the palette and the start of the print
     block. rgba() shadows and scrims are fine; a bare hex in here means
     a value that cannot follow the theme. The print block is exempt on
     purpose — printed output is paper, in both themes. */
  const body = css.slice(
    css.indexOf("/* ============================================================\n   BASE"),
    css.indexOf("@media print")
  );
  const hexes = [...body.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0]);
  assert.deepEqual(hexes, [], "colours below the palette must come from tokens");
});

test("no credentials are committed anywhere in the app", async () => {
  const files = ["index.html", "styles.css", "data.template.json", "manifest.webmanifest", "README.md"];
  for (const file of await readdir(new URL("../js", import.meta.url))) files.push(`js/${file}`);

  for (const file of files) {
    const source = await read(file);
    assert.doesNotMatch(source, /github_pat_[A-Za-z0-9_]{20,}/, `${file} contains a GitHub token`);
    assert.doesNotMatch(source, /\bghp_[A-Za-z0-9]{30,}/, `${file} contains a GitHub token`);
    assert.doesNotMatch(source, /\bsk-ant-[A-Za-z0-9-]{20,}/, `${file} contains an Anthropic key`);
    assert.doesNotMatch(source, /\bsk-[A-Za-z0-9]{32,}/, `${file} contains an OpenAI key`);
    assert.doesNotMatch(source, /\bAIza[A-Za-z0-9_-]{30,}/, `${file} contains a Google key`);
  }
});

test("the legacy worker remains inert and contains no deployed credentials", async () => {
  const wrangler = await read("worker/wrangler.toml");
  assert.match(wrangler, /REPLACE_WITH_YOUR_GIST_ID/);
});

test("Supabase authentication fails closed and the browser never receives a service key", async () => {
  const html = await read("index.html");
  const config = await read("js/config.js");
  const app = await read("js/app.js");
  const sync = await read("js/sync.js");

  assert.match(html, /@supabase\/supabase-js@2/);
  assert.match(html, /id="auth-email"/);
  assert.match(html, /id="auth-password"/);
  assert.match(config, /SUPABASE_SCHEMA = "sc"/);
  assert.doesNotMatch(config, /SUPABASE_SERVICE_KEY\s*=/i);
  assert.match(app, /getCurrentUser\(\)/);
  assert.match(sync, /getUser\(\)/, "a cached token must be validated before local workspace data can open");
  assert.match(sync, /requireUser\(\)/);
  assert.doesNotMatch(sync, /api\.github\.com\/gists/);
});

test("the workspace template matches the schema the app writes", async () => {
  const { SCHEMA_VERSION, validateData, migrateData } = await import("../js/data.js");
  const template = JSON.parse(await read("data.template.json"));
  assert.equal(template.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(validateData(migrateData(template)), []);
});

test("nothing in the app can post to a social platform", async () => {
  /* The whole design rests on publishing staying manual. A write call
     to a platform API would be a silent change to that promise. */
  for (const file of await readdir(new URL("../js", import.meta.url))) {
    const source = await read(`js/${file}`);
    const posts = [...source.matchAll(/fetch\(\s*[`"']([^`"']+)/g)].map((match) => match[1]);
    for (const url of posts) {
      assert.doesNotMatch(url, /graph\.facebook|api\.linkedin|oauth\.reddit|nextdoor\.com\/api/i,
        `${file} calls a platform publishing API`);
    }
  }
});
