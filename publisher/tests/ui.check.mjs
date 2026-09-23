import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createDefaultData, createExternalPost } from "../../js/data.js";
import { flattenWorkspace } from "../../js/sync.js";

test("the real Automation section saves policy, shows failures and settles an uncertain send, on desktop and mobile", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const name = url.pathname === "/" ? "/index.html" : url.pathname;
      if (!/^\/(?:index\.html|styles\.css|js\/[\w.-]+\.js|assets\/[\w./-]+)$/.test(name)) { res.writeHead(404); res.end(); return; }
      let content = await readFile(path.join(root, name));
      // Only the fixture substitutes the SDK. Production SRI/CSP is untouched.
      if (name === "/index.html") content = content.toString().replace(/integrity="[^"]*"/g, "");
      const type = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": type }); res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, channel: process.env.SC_TEST_BROWSER_CHANNEL || undefined });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const data = createDefaultData();
    data.automation.enabled = true;
    // One version the runner held for review, with its reasons.
    const held = createExternalPost({ platform: "facebook", body: "Join our drop-off event this Saturday." });
    held.campaign = "Saturday event"; held.status = "review";
    Object.assign(held.variants[0], { status: "scheduled", scheduledAt: "2026-09-29T20:00:00.000Z", publishedAt: "", publishedBody: "",
      automation: { optIn: true, approval: "", reviewReasons: ["Mentions a date, day or event that is not in your approved facts or the brief: \"Saturday\"."] }, photos: [] });
    data.posts.push(held);
    const rows = [...flattenWorkspace(data)].map(([key, value]) => ({ entity_type: key.split("\u0000")[0], entity_id: key.split("\u0000")[1], data: value, revision: 1 }));
    const sdk = `(() => {
      let rows=${JSON.stringify(rows)}, revision=1;
      const user={id:'00000000-0000-4000-8000-000000000001',email:'test@example.com'};
      const ok=(data)=>Promise.resolve({data,error:null});
      const journal={heartbeat:new Date(Date.now()-600000).toISOString(),host:'Fixture runner',pausedReason:'Test failure: login expired',
        alerts:[{at:new Date().toISOString(),lastAt:new Date().toISOString(),count:3,message:'Facebook composer changed: the Publish button was not found.'}],
        attempts:[{id:'attempt-1',platform:'facebook',phase:'uncertain',claimedAt:new Date().toISOString(),error:'Read-back copy or author differs from the submitted payload.',
          snapshot:{itemId:'x',postId:'y',title:'',body:'Pickup is free across the Bay Area.'},events:[{phase:'claimed',at:new Date().toISOString()}]}]};
      window.__commands=[];
      const client={ auth:{ getSession:()=>ok({session:{user}}),getUser:()=>ok({user}) },
        schema:()=>({from:(name)=>{const query={select:()=>query,eq:()=>query,order:()=>query,
          maybeSingle:()=>ok({revision,updated_at:new Date().toISOString()}),range:()=>ok(name==='workspace_items'?rows:[]),limit:()=>ok([])};return query;},
          rpc:(name,args)=>{
            if(name==='publisher_command'){window.__commands.push(args);
              if(args.command==='resolve'){journal.attempts[0]={...journal.attempts[0],phase:'resolved',resolution:args.payload.outcome};}
              return ok(journal);}
            if(name==='apply_workspace_changes'){for(const c of args.changes){const found=rows.find(r=>r.entity_type===c.entity_type&&r.entity_id===c.entity_id);if(found)found.data=c.data;else rows.push({...c,revision:revision+1});}return ok(++revision);}
            return ok({revision,changes:[]});}}),
        channel:()=>({on(){return this;},subscribe(){return this;}}), removeChannel:()=>{},
        storage:{from:()=>({upload:()=>ok({})})}};
      window.supabase={createClient:()=>client};
    })();`;
    await context.route("https://cdn.jsdelivr.net/**", (route) => route.fulfill({ contentType: "text/javascript", body: sdk }));
    const page = await context.newPage(); const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/#overview`);
    await page.locator("#app:not([hidden])").waitFor({ timeout: 5000 }).catch(async (error) => {
      throw new Error(`${error.message}\n${await page.locator("#gate").innerText()}\n${errors.join("\n")}`);
    });

    // A stopped runner is visible from the first page, not only its own.
    await page.getByText("Automatic posting needs you.").waitFor();
    assert.match(await page.locator("#count-automation").innerText(), /^[1-9]/);
    await page.getByRole("button", { name: "Open Automation", exact: true }).click();
    await page.locator("#automation-form").waitFor();

    // Everything that needs a person is listed, with its way out.
    await page.getByText("Posting is paused: Test failure: login expired", { exact: true }).waitFor();
    await page.getByText(/has not checked in since/).waitFor();
    await page.getByText(/"Saturday event" is waiting for your review/).waitFor();
    await page.getByText("Facebook composer changed: the Publish button was not found.", { exact: true }).waitFor();

    // Policy saves through the toggles a person actually sees.
    assert.equal(await page.locator('input[name="dryRun"]').isChecked(), true);
    await page.locator('label:has(input[name="facebook-enabled"])').click();
    await page.locator('input[name="facebook-destination"]').fill("https://www.facebook.com/test-page");
    await page.getByRole("button", { name: "Save automation policy", exact: true }).click();
    await page.getByText("Automation settings saved").waitFor();
    assert.equal(await page.locator('#automation-form input[name="facebook-enabled"]').isChecked(), true);
    assert.equal(await page.locator('input[name="facebook-destination"]').inputValue(), "https://www.facebook.com/test-page");

    await page.getByRole("button", { name: "Queue approved facts verbatim", exact: true }).click();
    await page.getByText(data.organization.facts[0], { exact: true }).waitFor();

    // The held version opens with the runner's reasons in front of the copy.
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await page.getByText("The runner is holding this for you.").waitFor();
    await page.locator("#modal [data-close]").first().click();

    // An uncertain send is settled by a person; nothing is posted from here.
    await page.getByRole("button", { name: "Record what happened", exact: true }).first().click();
    await page.locator("#resolve-outcome").selectOption("not-published");
    await page.locator("#resolve-note").fill("Checked the Page as a visitor; nothing went out.");
    await page.locator('label:has(input[name="stopped"])').click();
    await page.getByRole("button", { name: "Save what happened", exact: true }).click();
    await page.getByText(/may post it again after you resume/).waitFor();
    const commands = await page.evaluate(() => window.__commands.map((c) => c.command));
    assert.ok(commands.includes("resolve"));

    await mkdir(new URL("../.local/", import.meta.url), { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL("../.local/automation-desktop.png", import.meta.url)), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#automation-form").scrollIntoViewIfNeeded();
    await page.screenshot({ path: fileURLToPath(new URL("../.local/automation-mobile.png", import.meta.url)) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, "the Automation section must not overflow a phone screen");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("every view renders without a page error, and a draft's delivery dialog opens from the editor", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const server = http.createServer(async (req, res) => {
    try {
      const name = new URL(req.url, "http://localhost").pathname.replace(/^\/$/, "/index.html");
      if (!/^\/(?:index\.html|styles\.css|js\/[\w.-]+\.js|assets\/[\w./-]+)$/.test(name)) { res.writeHead(404); res.end(); return; }
      let content = await readFile(path.join(root, name));
      if (name === "/index.html") content = content.toString().replace(/integrity="[^"]*"/g, "");
      res.writeHead(200, { "Content-Type": name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html" }); res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, channel: process.env.SC_TEST_BROWSER_CHANNEL || undefined });
  try {
    const data = createDefaultData();
    data.automation.enabled = true;
    data.automation.platforms.facebook.enabled = true;
    data.automation.platforms.facebook.destination = "https://www.facebook.com/test-page";
    const post = createExternalPost({ platform: "facebook", body: "Pickup is free across the Bay Area." });
    post.campaign = "Free pickup"; post.status = "review";
    Object.assign(post.variants[0], { status: "scheduled", scheduledAt: new Date(Date.now() + 86400000).toISOString(), publishedAt: "", publishedBody: "",
      automation: { optIn: true, approval: "", reviewReasons: [] }, photos: [] });
    data.posts.push(post, createExternalPost({ platform: "reddit", title: "Recorded", body: "A post made by hand.", publishedUrl: "https://www.reddit.com/r/test/comments/1/x" }));
    const rows = [...flattenWorkspace(data)].map(([key, value]) => ({ entity_type: key.split("\u0000")[0], entity_id: key.split("\u0000")[1], data: value, revision: 1 }));
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("https://cdn.jsdelivr.net/**", (route) => route.fulfill({ contentType: "text/javascript", body: `(() => {
      const rows=${JSON.stringify(rows)}; const user={id:'u',email:'t@example.com'}; const ok=(data)=>Promise.resolve({data,error:null});
      const journal={heartbeat:new Date().toISOString(),host:'Fixture',pausedReason:'',alerts:[],attempts:[{id:'a1',platform:'facebook',phase:'dry-run',claimedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),snapshot:{itemId:'${post.variants[0].id}',body:'Pickup is free.'},events:[]}]};
      window.__commands=[]; window.__saved=[]; let revision=1;
      window.supabase={createClient:()=>({auth:{getSession:()=>ok({session:{user}}),getUser:()=>ok({user})},
        schema:()=>({from:(name)=>{const q={select:()=>q,eq:()=>q,order:()=>q,maybeSingle:()=>ok({revision,updated_at:new Date().toISOString()}),range:()=>ok(name==='workspace_items'?rows:[]),limit:()=>ok([])};return q;},
          rpc:(name,args)=>{
            if(name==='publisher_command'){window.__commands.push(args); if(args.command==='model-set') journal.runnerModel={provider:args.payload.provider,model:args.payload.model}; return ok(journal);}
            if(name==='apply_workspace_changes'){window.__saved.push(...args.changes); return ok(++revision);}
            return ok({revision,changes:[]});}}),
        channel:()=>({on(){return this;},subscribe(){return this;}}),removeChannel:()=>{},storage:{from:()=>({upload:()=>ok({})})}})};
    })();` }));
    const page = await context.newPage(); const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator("#app:not([hidden])").waitFor({ timeout: 5000 });
    for (const view of ["overview", "compose", "library", "queue", "automation", "runs", "deleted", "settings"]) {
      await page.evaluate((target) => { location.hash = target; }, view);
      await page.locator("#view-title").filter({ hasText: /./ }).waitFor();
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${view} overflows a phone screen`);
    }
    // Settings keeps organization and sync, and points to Automation instead of holding it.
    assert.equal(await page.locator("#automation-form").count(), 0);
    await page.evaluate(() => { location.hash = "queue"; });
    await page.getByText("Dry run", { exact: true }).first().waitFor();
    await page.getByRole("button", { name: /Free pickup/ }).click();
    await page.getByRole("button", { name: "Review automation / images", exact: true }).click();
    await page.getByText("Post this version automatically").waitFor();
    assert.equal(await page.locator('#automation-variant-form input[name="optIn"]').isChecked(), true);
    await page.locator("#modal [data-close]").first().click();

    // Scheduling an approved version is enough: the switch is on and the approval is bound to the text.
    await page.getByRole("button", { name: /Reschedule|Schedule/ }).first().click();
    assert.equal(await page.locator('#schedule-form input[name="autoPost"]').isChecked(), true);
    await page.getByRole("button", { name: "Add to queue", exact: true }).click();
    await page.getByText("Added to the queue").waitFor();
    await page.waitForFunction(() => window.__saved.some((c) => c.entity_type === "post"
      && c.data.variants?.[0]?.automation?.optIn === true && c.data.variants[0].automation.approval));

    // A subreddit added on the Automation page is saved with the workspace.
    await page.evaluate(() => { location.hash = "automation"; });
    await page.locator("#sub-name-0").fill("r/marin");
    await page.locator("#sub-days-0").fill("14");
    await page.locator('label:has(input[name="sub-on-0"])').click();
    await page.getByRole("button", { name: "Save automation policy", exact: true }).click();
    await page.getByText("Automation settings saved").waitFor();
    await page.waitForFunction(() => window.__saved.some((c) => c.entity_type === "meta"
      && c.data.automation?.platforms?.reddit?.subreddits?.[0]?.name === "marin" && c.data.automation.platforms.reddit.subreddits[0].gapDays === 14));
    assert.equal(await page.locator("#sub-name-0").inputValue(), "marin");
    assert.equal(await page.locator("#sub-name-1").inputValue(), "", "an empty row is always there to add another");

    // Model settings shares the chosen provider with the runner.
    await page.locator('button[data-act="sync-settings"][aria-label="Cloud sync settings"]').click();
    await page.locator("#s-provider").selectOption("mistral");
    await page.locator("#k-mistral").fill("mistral-test-key");
    assert.equal(await page.locator('#sync-form input[name="runnerModel"]').isChecked(), true);
    await page.getByRole("button", { name: "Save model settings", exact: true }).click();
    await page.getByText(/shared with the runner/).waitFor();
    const set = await page.evaluate(() => window.__commands.find((c) => c.command === "model-set"));
    assert.equal(set.payload.provider, "mistral");
    assert.equal(set.payload.key, "mistral-test-key");
    await page.evaluate(() => { location.hash = "automation"; });
    await page.getByText(/Writes with:/).waitFor();
    assert.match(await page.getByText(/Writes with:/).innerText(), /mistral/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
