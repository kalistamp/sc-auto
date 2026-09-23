import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BrowserPublisher } from "../browser.js";

const URLS = {
  facebook: "https://www.facebook.com/test/posts/123",
  reddit: "https://www.reddit.com/r/test/comments/123/post",
  nextdoor: "https://nextdoor.com/p/abc123/",
  craigslist: "https://sfbay.craigslist.org/sfc/com/1234567890.html",
  offerup: "https://offerup.com/services/test-pickup"
};

async function fixture(platform, { hidden = false, ambiguous = false, tweak = (recipe) => recipe, pages = {}, snapshotChanges = {} } = {}) {
  const browser = await chromium.launch({ headless: true, channel: process.env.SC_TEST_BROWSER_CHANNEL || undefined });
  const permalink = URLS[platform], origin = new URL(permalink).origin;
  const snapshot = { platform, destination: origin + "/compose", body: "Pickup is free.", title: "Pickup", area: "94101", category: "services", photos: [], operation: "create", ...snapshotChanges };
  let submitted = 0;
  const recipe = tweak({
    account: "Safe Cycle Test", accountLocator: { css: "#account" }, calibratedAt: "2026-09-22",
    startUrl: snapshot.destination, samplePermalink: permalink,
    steps: ["title", "body", "area", "category"].map((field) => ({ action: "fill", field, locator: { label: field } })),
    submit: { role: "button", name: "Publish" },
    verify: { account: { css: "#author" }, body: { css: "#body" }, title: { css: "#title" }, ...(platform === "craigslist" ? { listedAt: origin + "/index" } : {}) },
    ...(platform === "nextdoor" ? { readerStorageState: "reader.json" } : {})
  });
  async function route(context) {
    await context.route("**/*", async (request) => {
      const url = request.request().url();
      const extra = Object.entries(pages).find(([suffix]) => url.endsWith(suffix));
      if (extra) return request.fulfill({ contentType: "text/html", body: extra[1] });
      if (url.endsWith("/compose")) return request.fulfill({ contentType: "text/html", body: `<span id="account">Safe Cycle Test</span>${["title","body","area","category"].map((f) => `<label>${f}<textarea aria-label="${f}"></textarea></label>`).join("")}<button onclick="location.href='${permalink}'">Publish</button>${ambiguous ? "<button>Publish</button>" : ""}` });
      if (url.endsWith("/index")) return request.fulfill({ contentType: "text/html", body: `<a href="${permalink}">Pickup</a>` });
      if (url === permalink) {
        if (request.request().headers()["referer"]?.endsWith("/compose")) submitted++;
        return request.fulfill({ contentType: "text/html", body: `<span id="author">Safe Cycle Test</span><h1 id="title">Pickup</h1><p id="body">${hidden ? "Removed by moderators" : "Pickup is free."}</p>` });
      }
      return request.abort();
    });
    return context;
  }
  const context = await route(await browser.newContext());
  const publisher = new BrowserPublisher({ context, browser: { newContext: async (options) => route(await browser.newContext(options)) }, recipes: { [platform]: recipe }, resolvePhotos: async () => [], readerState: async () => ({ cookies: [], origins: [] }) });
  return { publisher, snapshot, browser, submitted: () => submitted };
}
for (const platform of Object.keys(URLS)) test(`${platform}: browser fills, submits once and independently reads permalink`, async () => {
  const f = await fixture(platform);
  try {
    await f.publisher.prepare(f.snapshot);
    const url = await f.publisher.submit(f.snapshot);
    const evidence = await f.publisher.verify(f.snapshot, url);
    assert.equal(evidence.bodyMatches, true); assert.equal(f.submitted(), 1);
  } finally { await f.browser.close(); }
});
test("browser refuses ambiguous Publish buttons before submission", async () => {
  const f = await fixture("facebook", { ambiguous: true });
  try { await assert.rejects(() => f.publisher.prepare(f.snapshot)); assert.equal(f.submitted(), 0); }
  finally { await f.browser.close(); }
});
test("successful navigation with removed content does not count as verified publication", async () => {
  const f = await fixture("reddit", { hidden: true });
  try { await f.publisher.prepare(f.snapshot); const url = await f.publisher.submit(f.snapshot); await assert.rejects(() => f.publisher.verify(f.snapshot, url), /differs/); }
  finally { await f.browser.close(); }
});
test("verifyAs author reads back through the signed-in session, without a second account", async () => {
  const f = await fixture("nextdoor", { tweak: ({ readerStorageState, ...recipe }) => ({ ...recipe, verifyAs: "author" }) });
  try {
    f.publisher.browser = { newContext: async () => { throw new Error("A reader context must not be opened."); } };
    await f.publisher.prepare(f.snapshot);
    const evidence = await f.publisher.verify(f.snapshot, await f.publisher.submit(f.snapshot));
    assert.equal(evidence.visibility, "author session");
    assert.equal(f.submitted(), 1);
  } finally { await f.browser.close(); }
});
test("a renewal starts on its calibrated page and keeps the listing's permalink", async () => {
  const permalink = URLS.craigslist, origin = new URL(permalink).origin;
  const f = await fixture("craigslist", {
    snapshotChanges: { operation: "renew", publishedUrl: permalink },
    tweak: (recipe) => ({ ...recipe, renew: { startUrl: origin + "/manage", steps: [],
      submit: { role: "button", name: "Renew this posting" }, confirmLocator: { css: "#renewed" } } }),
    pages: { "/manage": `<span id="account">Safe Cycle Test</span><button onclick="document.body.insertAdjacentHTML('beforeend','<p id=renewed>Renewed</p>')">Renew this posting</button>` }
  });
  try {
    await f.publisher.prepare(f.snapshot);
    const url = await f.publisher.submit(f.snapshot);
    assert.equal(url, permalink);
    assert.equal((await f.publisher.verify(f.snapshot, url)).bodyMatches, true);
  } finally { await f.browser.close(); }
});
test("nextdoor without a reader session or an explicit author choice is refused", async () => {
  const f = await fixture("nextdoor", { tweak: ({ readerStorageState, ...recipe }) => recipe });
  try { await assert.rejects(() => f.publisher.prepare(f.snapshot), /readerStorageState/); assert.equal(f.submitted(), 0); }
  finally { await f.browser.close(); }
});
test("a preparation step that publishes by accident is reported as a possible post, not a retryable failure", async () => {
  const permalink = URLS.facebook, origin = new URL(permalink).origin;
  const f = await fixture("facebook", {
    tweak: (recipe) => ({ ...recipe, startUrl: origin + "/draft", steps: [...recipe.steps, { action: "click", locator: { role: "button", name: "Continue" } }] }),
    snapshotChanges: { destination: origin + "/draft" },
    pages: { "/draft": `<span id="account">Safe Cycle Test</span>${["title","body","area","category"].map((f) => `<label>${f}<textarea aria-label="${f}"></textarea></label>`).join("")}<button onclick="location.href='${permalink}'">Continue</button><button>Publish</button>` }
  });
  try {
    const error = await f.publisher.prepare(f.snapshot).then(() => null, (failure) => failure);
    assert.ok(error, "preparation must not report success");
    assert.equal(error.possibleSubmission, true, error.message);
  } finally { await f.browser.close(); }
});
test("a runner whose Chrome window was closed opens it again instead of failing every post", async () => {
  const f = await fixture("facebook");
  try {
    const replacement = f.publisher.context, reader = f.publisher.browser;
    let reconnects = 0;
    const { chromium } = await import("playwright");
    const spare = await chromium.launch({ headless: true, channel: process.env.SC_TEST_BROWSER_CHANNEL || undefined });
    const closedOne = await spare.newContext();
    f.publisher.context = closedOne; f.publisher.watch();
    await closedOne.close();
    f.publisher.connect = async () => { reconnects++; return { context: replacement, browser: reader }; };
    await f.publisher.prepare(f.snapshot);
    assert.equal(reconnects, 1);
    await spare.close();
  } finally { await f.browser.close(); }
});
test("a site that stays put after Post: the runner finds the new post and reads its hover-only link", async () => {
  const permalink = "https://www.facebook.com/permalink.php?story_fbid=42&id=7";
  const origin = "https://www.facebook.com";
  // Posting leaves the page where it is; the profile then lists the new post,
  // whose link only gets its real address while hovered.
  const profile = `<span id="account">Safe Cycle Test</span>
    <div><div data-role="msg">Somebody else's older post</div><a href="?__cft__=x" onmouseover="this.href='https://www.facebook.com/permalink.php?story_fbid=1&id=7'">1h</a></div>
    <div><div data-role="msg">Pickup is free.</div><a href="?__cft__=y" onmouseover="this.href='${permalink}&__cft__[0]=abc'">Just now</a></div>`;
  const f = await fixture("facebook", {
    tweak: (recipe) => ({ ...recipe, startUrl: origin + "/me", find: { url: origin + "/me", post: { css: '[data-role="msg"]' }, rounds: 2, settle: 100 },
      steps: [{ action: "fill", field: "body", locator: { label: "body" } }] }),
    snapshotChanges: { destination: origin + "/me" },
    pages: { "/me": `${profile}<label>body<textarea aria-label="body"></textarea></label><button>Publish</button>` }
  });
  try {
    await f.publisher.prepare(f.snapshot);
    assert.equal(await f.publisher.submit(f.snapshot), permalink);
  } finally { await f.browser.close(); }
});
test("the new-post search never takes a notification or group link from elsewhere on the page", async () => {
  const permalink = "https://www.facebook.com/permalink.php?story_fbid=42&id=7";
  const origin = "https://www.facebook.com";
  // Only our post is loaded, so without limits its box would be the whole page.
  const profile = `<span id="account">Safe Cycle Test</span>
    <div role="banner"><a href="https://www.facebook.com/groups/1/posts/2/?notif_id=3">You were mentioned</a></div>
    <div role="main"><div><div data-role="msg">Pickup is free.</div>
      <a href="https://www.facebook.com/groups/1/posts/9/">shared to a group</a>
      <a href="?__cft__=y" onmouseover="this.href='${permalink}&__cft__[0]=abc'">Just now</a></div></div>`;
  const f = await fixture("facebook", {
    tweak: (recipe) => ({ ...recipe, startUrl: origin + "/me", find: { url: origin + "/me", post: { css: '[data-role="msg"]' }, linkIncludes: "id=7", rounds: 1, settle: 100 },
      steps: [{ action: "fill", field: "body", locator: { label: "body" } }] }),
    snapshotChanges: { destination: origin + "/me" },
    pages: { "/me": `${profile}<label>body<textarea aria-label="body"></textarea></label><button>Publish</button>` }
  });
  try {
    await f.publisher.prepare(f.snapshot);
    assert.equal(await f.publisher.submit(f.snapshot), permalink);
  } finally { await f.browser.close(); }
});
test("a Reddit post goes to its chosen subreddit and nowhere else", async () => {
  const f = await fixture("reddit", {
    tweak: (recipe) => ({ ...recipe, startUrl: "https://www.reddit.com/r/{subreddit}/submit" }),
    snapshotChanges: { subreddit: "test", destination: "https://www.reddit.com/r/test/submit" },
    pages: { "/r/test/submit": `<span id="account">Safe Cycle Test</span>${["title","body","area","category"].map((f) => `<label>${f}<textarea aria-label="${f}"></textarea></label>`).join("")}<button onclick="location.href='${URLS.reddit}'">Publish</button>` }
  });
  try {
    await f.publisher.prepare(f.snapshot);
    assert.equal(await f.publisher.submit(f.snapshot), URLS.reddit);
    // The same permalink checked against a different subreddit is refused.
    await assert.rejects(() => f.publisher.verify({ ...f.snapshot, subreddit: "bayarea" }, URLS.reddit), /not in r\/bayarea/);
  } finally { await f.browser.close(); }
});
