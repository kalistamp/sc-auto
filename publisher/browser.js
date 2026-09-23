/* Browser-only delivery. No social API clients, stealth patches or CAPTCHA bypass. */
export const BROWSER_PLATFORMS = Object.freeze({
  facebook: { hosts: ["facebook.com"], permalink: "(?:/posts/|/permalink/|story_fbid=|/photo/)", fields: ["body"] },
  reddit: { hosts: ["reddit.com"], permalink: "/comments/", fields: ["title", "body"] },
  nextdoor: { hosts: ["nextdoor.com"], permalink: "/(?:p|news_feed)/", fields: ["body"] },
  craigslist: { hosts: ["craigslist.org"], permalink: "/[a-z]+/[a-z]+/[0-9]+\\.html", fields: ["title", "body", "category", "area"] },
  offerup: { hosts: ["offerup.com"], permalink: "/(?:item/detail|services|p)/", fields: ["title", "body", "category", "area"] }
});
function trustedUrl(url, platform) {
  const parsed = new URL(url);
  return parsed.protocol === "https:" && !parsed.username && !parsed.password &&
    BROWSER_PLATFORMS[platform]?.hosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
}
/* Two locators that would reach the same control. A preparation step must
   never be another way of pressing the final Publish button. */
function sameTarget(a = {}, b = {}) {
  const text = (value) => String(value ?? "").trim().toLowerCase();
  return Boolean((a.role && text(a.role) === text(b.role) && text(a.name) === text(b.name))
    || (a.label && text(a.label) === text(b.label)) || (a.css && text(a.css) === text(b.css)));
}
function possibleSubmission(message) { return Object.assign(new Error(message), { possibleSubmission: true }); }
const OPENED_A_POST = "A preparation step opened a published post, so it may have posted. Check the account, then recalibrate the recipe.";

export function validateRecipe(platform, recipe) {
  if (!BROWSER_PLATFORMS[platform]) throw new Error("Unsupported browser platform.");
  if (!recipe?.account || !recipe?.accountLocator || !recipe?.submit || !recipe?.verify?.body || !recipe?.verify?.account)
    throw new Error(`${platform}: configure account assertions, submit and read-back locators.`);
  if (!recipe.calibratedAt || !recipe.samplePermalink || !trustedUrl(recipe.samplePermalink, platform))
    throw new Error(`${platform}: calibrate against a real, existing permalink before enabling.`);
  if (!trustedUrl(recipe.startUrl, platform)) throw new Error("Composer must be on the platform's HTTPS origin.");
  if (!Array.isArray(recipe.steps) || recipe.steps.length > 30) throw new Error("Recipe needs at most 30 explicit steps.");
  if (recipe.paidAction) throw new Error("Set up paid subscriptions manually; this runner cannot authorize purchases.");
  for (const field of BROWSER_PLATFORMS[platform].fields) {
    if (!recipe.steps.some((step) => step.field === field && ["fill", "select"].includes(step.action)))
      throw new Error(`Recipe must explicitly set ${field}.`);
  }
  for (const step of recipe.steps) {
    if (!["click", "fill", "select", "upload", "check"].includes(step.action) || !step.locator) throw new Error("Unsupported browser step.");
    if (sameTarget(step.locator, recipe.submit)) throw new Error("Final submit must not appear in preparation steps.");
  }
  if (![undefined, "public", "author"].includes(recipe.verifyAs)) throw new Error("verifyAs must be \"public\" or \"author\".");
  // Nextdoor posts are only readable signed in: a second reader account, or an
  // explicit choice to accept the author's own view as the evidence.
  if (platform === "nextdoor" && !recipe.readerStorageState && recipe.verifyAs !== "author")
    throw new Error("Nextdoor needs readerStorageState (a separate reader session) or verifyAs \"author\".");
  if (recipe.renew) {
    const renew = recipe.renew;
    if (renew.startUrl && !trustedUrl(renew.startUrl, platform)) throw new Error("Renewal page must be on the platform's HTTPS origin.");
    if (!renew.submit || !Array.isArray(renew.steps) || renew.steps.length > 30) throw new Error("Renewal needs explicit steps and a separate submit locator.");
    for (const step of renew.steps) {
      if (!["click", "fill", "select", "upload", "check"].includes(step.action) || !step.locator) throw new Error("Unsupported browser step.");
      if (sameTarget(step.locator, renew.submit)) throw new Error("Final submit must not appear in preparation steps.");
    }
  }
  return recipe;
}
export function assertPermalink(url, platform, recipe) {
  if (!trustedUrl(url, platform) || !new RegExp(BROWSER_PLATFORMS[platform].permalink).test(url))
    throw new Error("The returned URL is not a recognized platform permalink.");
  if (recipe.permalinkPattern && !new RegExp(recipe.permalinkPattern).test(url)) throw new Error("Permalink does not match the configured destination.");
  return url;
}
/* A recipe for one item: "{subreddit}" in its addresses becomes the
   subreddit chosen for this post. */
function forItem(recipe, snapshot) {
  if (!snapshot.subreddit) return recipe;
  const fill = (value) => typeof value === "string" ? value.replaceAll("{subreddit}", snapshot.subreddit)
    : Array.isArray(value) ? value.map(fill) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)])) : value;
  return fill(recipe);
}
/* A Reddit post must land in the subreddit it was scheduled for. */
function inSubreddit(url, snapshot) {
  if (snapshot.subreddit && !new URL(url).pathname.toLowerCase().startsWith(`/r/${snapshot.subreddit.toLowerCase()}/`))
    throw new Error(`The post is not in r/${snapshot.subreddit}.`);
  return url;
}
function isPermalink(url, platform, recipe) {
  try { assertPermalink(url, platform, recipe); return true; } catch { return false; }
}
export function locate(page, spec) {
  if (spec.role && typeof spec.name === "string") return page.getByRole(spec.role, { name: spec.name, exact: true });
  if (spec.label) return page.getByLabel(spec.label, { exact: true });
  if (spec.css) return page.locator(spec.css);
  throw new Error("Use an exact role/name, label or CSS locator.");
}
async function unique(page, spec) {
  const item = locate(page, spec);
  await item.waitFor({ state: "visible", timeout: 15000 });
  if (await item.count() !== 1) throw new Error("Ambiguous browser locator; recalibration required.");
  return item;
}
function normalize(text) { return String(text).replace(/\s+/g, " ").trim(); }
export async function assertAccount(page, recipe) {
  const actual = normalize(await (await unique(page, recipe.accountLocator)).innerText());
  if (actual !== normalize(recipe.account)) throw new Error("Wrong account or signed-out browser; sign in and recalibrate.");
}

export class BrowserPublisher {
  constructor({ context, browser, connect, recipes, resolvePhotos, readerState, evidenceDir }) {
    Object.assign(this, { context, browser, connect, recipes, resolvePhotos, readerState, evidenceDir });
    this.page = null;
    this.watch();
  }
  /* A Chrome window closed by hand (or crashed) is opened again on the next
     attempt, instead of failing every post until the runner restarts. */
  watch() {
    const context = this.context;
    context?.once?.("close", () => { if (this.context === context) Object.assign(this, { context: null, browser: null, page: null }); });
  }
  async ensureBrowser() {
    if (this.context && this.browser) return;
    Object.assign(this, await this.connect());
    this.watch();
  }
  async prepare(snapshot) {
    const recipe = forItem(validateRecipe(snapshot.platform, this.recipes[snapshot.platform]), snapshot);
    if (snapshot.destination !== recipe.startUrl) throw new Error("Workspace destination and calibrated composer disagree.");
    if (snapshot.operation === "renew" && !recipe.renew) throw new Error("This destination has no calibrated native renewal flow.");
    const flow = snapshot.operation === "renew" ? { ...recipe, ...recipe.renew } : recipe;
    if (flow.paidAction) throw new Error("A paid action requires manual setup.");
    if (snapshot.operation !== "renew" && snapshot.photos?.length && !flow.steps.some((step) => step.action === "upload")) throw new Error("Recipe does not attach the selected images.");
    if (snapshot.title && !recipe.verify.title && snapshot.platform !== "facebook" && snapshot.platform !== "nextdoor") throw new Error("Read-back needs a title assertion.");
    this.flow = flow;
    await this.ensureBrowser();
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(15000);
    // A renewal starts on its own page when one is calibrated (Craigslist
    // renews from the account's listing page), otherwise on the listing.
    const renewal = snapshot.operation === "renew";
    await this.page.goto(renewal && !recipe.renew.startUrl ? assertPermalink(snapshot.publishedUrl, snapshot.platform, recipe) : flow.startUrl);
    await assertAccount(this.page, flow);
    // A step that lands on a published post may have published it: that is a
    // possible submission, never a failure the runner could retry.
    const opened = this.page.url();
    const landedOnPost = () => !renewal && this.page.url() !== opened && isPermalink(this.page.url(), snapshot.platform, flow);
    for (const step of flow.steps) {
      if (landedOnPost()) throw possibleSubmission(OPENED_A_POST);
      const locator = await unique(this.page, step.locator);
      if (step.action === "click") await locator.click();
      else if (step.action === "check") await locator.check();
      else if (step.action === "upload") await locator.setInputFiles(await this.resolvePhotos(snapshot.photos || []));
      else {
        const value = step.field ? snapshot[step.field] : step.value;
        if (value === undefined || value === null) throw new Error(`Missing composer field: ${step.field}`);
        if (step.action === "fill") await locator.fill(String(value));
        else await locator.selectOption(String(value));
      }
    }
    if (landedOnPost()) throw possibleSubmission(OPENED_A_POST);
    // Assert every filled field still contains the intended payload before the commit barrier.
    for (const step of flow.steps.filter((step) => step.action === "fill")) {
      const locator = await unique(this.page, step.locator);
      const value = await locator.evaluate((node) => "value" in node ? node.value : node.innerText);
      if (normalize(value) !== normalize(step.field ? snapshot[step.field] : step.value)) throw new Error("Composer changed the intended text.");
    }
    await unique(this.page, flow.submit);
    return { account: recipe.account };
  }
  async submit(snapshot) {
    if (!this.page) throw new Error("No prepared browser page.");
    // No retry wrapper around this call. Any exception is a possible submission.
    await (await unique(this.page, this.flow.submit)).click({ timeout: 15000 });
    // A renewal keeps its permalink; a calibrated confirmation is the signal.
    if (snapshot.operation === "renew" && this.flow.confirmLocator) {
      await unique(this.page, this.flow.confirmLocator);
      return assertPermalink(snapshot.publishedUrl, snapshot.platform, this.flow);
    }
    if (this.flow.find) return inSubreddit(await this.findPost(snapshot), snapshot);
    if (this.flow.permalinkLocator) {
      const link = await unique(this.page, this.flow.permalinkLocator);
      const href = await link.getAttribute("href");
      return inSubreddit(assertPermalink(new URL(href, this.page.url()).href, snapshot.platform, this.flow), snapshot);
    }
    await this.page.waitForURL((url) => {
      try { assertPermalink(url.href, snapshot.platform, this.flow); return true; } catch { return false; }
    }, { timeout: 30000 });
    return inSubreddit(assertPermalink(this.page.url(), snapshot.platform, this.flow), snapshot);
  }
  /* For sites that neither open the new post nor show its link (Facebook):
     reload the page it was posted to until a post whose text starts like
     ours is near the top, then read that post's own link, which Facebook
     only fills in while the pointer is over it. Not finding it is an error
     after the click, so the engine treats it as a possible post. */
  async findPost(snapshot) {
    // linkIncludes pins the link to this account (e.g. "id=<profile id>"), so a
    // notification or group link elsewhere on the page can never be taken.
    const { url, post, linkIncludes = "", rounds = 6, settle = 5000 } = forItem(this.flow, snapshot).find;
    const want = normalize(snapshot.body).slice(0, 60);
    await this.page.waitForTimeout(3000);
    for (let round = 0; round < rounds; round++) {
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await this.page.waitForTimeout(settle);
      const messages = locate(this.page, post);
      for (let i = 0; i < Math.min(await messages.count(), 5); i++) {
        const message = messages.nth(i);
        if (!normalize(await message.innerText().catch(() => "")).startsWith(want)) continue;
        // The post's own box: the widest ancestor still holding only this
        // message, and never wider than the page's main content (menus and
        // notifications live outside it).
        const marker = `sc-find-${round}-${i}`;
        await message.evaluate((node, [selector, mark]) => {
          let box = node;
          while (box.parentElement && !box.parentElement.matches('[role="main"], body')
            && box.parentElement.querySelectorAll(selector).length <= 1) box = box.parentElement;
          box.setAttribute("data-sc-find", mark);
        }, [post.css, marker]);
        const anchors = this.page.locator(`[data-sc-find="${marker}"] a`);
        for (let j = 0; j < Math.min(await anchors.count(), 20); j++) {
          const anchor = anchors.nth(j);
          await anchor.hover({ timeout: 3000 }).catch(() => {});
          await this.page.waitForTimeout(200);
          const href = await anchor.getAttribute("href").catch(() => "");
          if (!href) continue;
          const link = new URL(href, this.page.url());
          link.searchParams.delete("__cft__[0]"); link.searchParams.delete("__tn__");
          if (linkIncludes && !link.href.includes(linkIncludes)) continue;
          if (link.searchParams.has("comment_id")) continue;
          if (isPermalink(link.href, snapshot.platform, this.flow)) return assertPermalink(link.href, snapshot.platform, this.flow);
        }
      }
    }
    throw new Error("Posted, but the new post was not found on the page; check the account before resuming.");
  }
  async verify(snapshot, permalink) {
    const recipe = forItem(validateRecipe(snapshot.platform, this.recipes[snapshot.platform]), snapshot);
    inSubreddit(assertPermalink(permalink, snapshot.platform, recipe), snapshot);
    await this.ensureBrowser();
    // A fresh reader context avoids treating an author's private preview as
    // public. verifyAs "author" is the explicit, weaker exception: it proves
    // the post exists with this text and author, not who else can see it.
    const asAuthor = recipe.verifyAs === "author";
    const context = asAuthor ? null : await this.browser.newContext(recipe.readerStorageState ? { storageState: await this.readerState(recipe.readerStorageState) } : {});
    const page = asAuthor ? await this.context.newPage() : await context.newPage();
    try {
      const response = await page.goto(permalink, { timeout: 30000 });
      if (!response?.ok()) throw new Error("Permalink is not readable.");
      assertPermalink(page.url(), snapshot.platform, recipe);
      const body = normalize(await (await unique(page, recipe.verify.body)).innerText());
      const account = normalize(await (await unique(page, recipe.verify.account)).innerText());
      if (body !== normalize(snapshot.body) || account !== normalize(recipe.account)) throw new Error("Read-back copy or author differs from the submitted payload.");
      if (snapshot.title && recipe.verify.title && normalize(await (await unique(page, recipe.verify.title)).innerText()) !== normalize(snapshot.title)) throw new Error("Read-back title differs.");
      if (snapshot.photos?.length) {
        if (!recipe.verify.photos) throw new Error("Photo publication needs a read-back image locator.");
        const photos = locate(page, recipe.verify.photos);
        if (await photos.count() !== snapshot.photos.length || !await photos.evaluateAll((nodes) => nodes.every((node) => node.complete && node.naturalWidth > 0)))
          throw new Error("Published images are missing or unreadable.");
      }
      if (recipe.verify.unavailable && await locate(page, recipe.verify.unavailable).count()) throw new Error("Platform reports removed, pending or unavailable content.");
      if (recipe.verify.listedAt) {
        if (!trustedUrl(recipe.verify.listedAt, snapshot.platform)) throw new Error("Invalid public listing index URL.");
        await page.goto(recipe.verify.listedAt);
        if (!await page.locator(`a[href="${permalink.replaceAll('"', '%22')}"]`).count()) throw new Error("Permalink exists but the post is not visible in its configured listing index.");
      }
      if (snapshot.platform === "craigslist" && !recipe.verify.listedAt) throw new Error("Craigslist needs public category/index read-back to detect ghosting.");
      return { permalink, account: recipe.account, verifiedAt: new Date().toISOString(), bodyMatches: true,
        visibility: asAuthor ? "author session" : recipe.readerStorageState ? "independent reader" : "public" };
    } finally { await (asAuthor ? page : context).close(); }
  }
  async close() { if (this.page) await this.page.close().catch(() => {}); this.page = null; }
}
