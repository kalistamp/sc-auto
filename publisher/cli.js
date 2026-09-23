import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import readline from "node:readline";
import { createHash } from "node:crypto";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "../js/config.js";
import { setSupabaseClient } from "../js/sync.js";
import { PublisherStore, generateNext } from "./store.js";
import { BrowserPublisher, BROWSER_PLATFORMS, validateRecipe } from "./browser.js";
import { tick, safeError } from "./engine.js";

/* Defaults resolve from this directory, not the shell's, so `.local/` —
   browser sessions, the workspace refresh token — always lands in the
   Git-ignored publisher/.local however the runner is started. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALERT_REPEAT_MS = 6 * 3600000;

export function localPath(root, relative) {
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("Path must stay inside the runner state directory.");
  return resolved;
}

/* Failure notices go to the console, the local log, the website (the
   journal behind Settings → Automation) and the optional webhook. A notice
   that cannot be delivered is logged; it never stops the runner, because a
   runner killed by its own alarm is the failure the alarm exists to report.
   The same message is repeated at most every six hours. */
export function createAlerter({ root, webhook = "", store = null, fetchImpl = fetch, log = console.error, clock = Date.now }) {
  const sentAt = new Map();
  const record = (entry) => fs.appendFile(localPath(root, "failures.log"), JSON.stringify({ at: new Date(clock()).toISOString(), ...entry }) + "\n", { mode: 0o600 }).catch(() => {});
  return async function alert(message) {
    // Avoid provider errors accidentally echoing bearer tokens or query secrets.
    const safe = String(message).replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/https?:\/\/\S+/g, "[URL omitted]").slice(0, 1500);
    if (clock() - (sentAt.get(safe) ?? -Infinity) < ALERT_REPEAT_MS) return;
    sentAt.set(safe, clock());
    log(safe);
    await record({ message: safe });
    try { await store?.alert(safe); }
    catch (error) { await record({ message: `The website could not be told: ${safeError(error)}` }); }
    if (!webhook) return;
    try {
      if (!webhook.startsWith("https://")) throw new Error("Alert webhook must use HTTPS.");
      const response = await fetchImpl(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: safe }), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Webhook answered ${response.status}.`);
    } catch (error) { await record({ message: `Failure notification was not delivered: ${safeError(error)}` }); }
  };
}

/* After a generation attempt fails — the model, or saving what it wrote —
   the next one waits an hour, so a lasting fault cannot call a paid model
   every minute. Resolves false while waiting. */
export function backoff(ms, clock = Date.now) {
  let until = 0;
  return async (task) => {
    if (clock() < until) return false;
    try { return await task(); }
    catch (error) { until = clock() + ms; throw error; }
  };
}

/* The AI the runner writes with: whatever Studio's Model settings shared
   (provider, model and key), or failing that the host's own configuration. */
export async function runnerCredentials(store, config, env = process.env) {
  const shared = await store.command("model-get").catch(() => null);
  if (shared?.provider && shared?.key) return { provider: shared.provider, keys: { [shared.provider]: shared.key },
    models: { [shared.provider]: shared.model || "" }, effort: shared.effort || "" };
  const provider = config.provider || "anthropic";
  return { provider, keys: { [provider]: env[config.modelKeyEnv || "SC_MODEL_KEY"] || "" }, models: { [provider]: config.model || "" }, effort: "" };
}

/* Asks in the terminal; with `hidden`, what is typed is not shown. */
export function ask(question, { hidden = false, input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });
    let muted = false;
    rl._writeToOutput = (text) => { if (!muted) output.write(text); };
    rl.question(question, (answer) => { rl.close(); if (hidden) output.write("\n"); resolve(answer.trim()); });
    muted = hidden;
  });
}

function running(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

/* One local owner per browser profile. A lock left by a process that has
   since died is taken over; the database barrier, not this file, is what
   prevents a second submission. */
export async function acquireLock(lockPath, { isRunning = running } = {}) {
  let handle;
  try { handle = await fs.open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number((await fs.readFile(lockPath, "utf8").catch(() => "")).trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isRunning(pid))
      throw new Error(`Another runner (process ${pid}) is using this browser profile.`);
    await fs.rm(lockPath, { force: true });
    handle = await fs.open(lockPath, "wx", 0o600);
  }
  await handle.writeFile(String(process.pid));
  return async function release() { await handle.close(); await fs.rm(lockPath, { force: true }); };
}

const COMMANDS = ["init", "auth", "login", "inspect", "validate", "once", "run", "status", "reconcile"];

export async function main(args = process.argv.slice(2)) {
  // Node 26 exposes a localStorage that only warns. The runner has no browser
  // storage; the shared modules already treat its absence as normal.
  Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true, writable: true });
  const command = args[0] || "once";
  if (!COMMANDS.includes(command)) throw new Error(`Unknown command "${command}". Commands: ${COMMANDS.join(", ")}.`);
  const configPath = process.env.SC_PUBLISHER_CONFIG ? path.resolve(process.env.SC_PUBLISHER_CONFIG) : path.join(HERE, ".local", "config.json");
  if (command === "init") {
    await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    await fs.copyFile(new URL("./config.example.json", import.meta.url), configPath, 1).catch((error) => {
      throw error.code === "EEXIST" ? new Error(`${configPath} already exists; edit it rather than starting again.`) : error;
    });
    console.log(`Created ${configPath}. Configure the host locally; do not commit sessions or credentials.`); return;
  }
  // Without a config file the runner starts on the safe defaults: dry run on
  // the host ("live": false), everything else taken from Studio.
  const config = JSON.parse(await fs.readFile(configPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return fs.readFile(new URL("./config.example.json", import.meta.url), "utf8");
    throw error;
  }));
  const root = path.resolve(HERE, config.stateDir || ".local");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  process.env.TZ = config.timezone;
  let browser, context;
  async function openBrowser() {
    const { chromium } = await import("playwright");
    if (config.cdpEndpoint) {
      const endpoint = new URL(config.cdpEndpoint);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) throw new Error("CDP must be local; do not expose your browser remotely.");
      browser = await chromium.connectOverCDP(config.cdpEndpoint);
      context = browser.contexts()[0];
    } else {
      context = await chromium.launchPersistentContext(localPath(root, "browser-profile"), {
        channel: config.browserChannel || undefined, headless: config.headless === true,
        timezoneId: config.timezone, acceptDownloads: false
      });
      browser = context.browser();
    }
    return context;
  }
  async function closeBrowser() {
    if (config.cdpEndpoint) await browser?.close();
    else await context?.close();
  }
  if (command === "login" || command === "inspect") {
    const platform = args[1];
    if (!BROWSER_PLATFORMS[platform]) throw new Error("Specify facebook, reddit, nextdoor, craigslist or offerup.");
    await openBrowser();
    const page = await context.newPage();
    await page.goto(config.recipes[platform]?.startUrl || `https://${BROWSER_PLATFORMS[platform].hosts[0]}/`);
    console.log("Use this dedicated browser to sign in. Sessions remain on this host. Close the browser when finished.");
    if (command === "inspect") await page.pause();
    else await new Promise((resolve) => context.on("close", resolve));
    await closeBrowser().catch(() => {}); return;
  }
  const { createClient } = await import("@supabase/supabase-js");
  const sessionPath = localPath(root, "supabase-session.json");
  const storage = {
    async getItem(key) { try { return JSON.parse(await fs.readFile(sessionPath, "utf8"))[key] || null; } catch (e) { if (e.code === "ENOENT") return null; throw e; } },
    async setItem(key, value) { await fs.writeFile(sessionPath + ".tmp", JSON.stringify({ [key]: value }), { mode: 0o600 }); await fs.rename(sessionPath + ".tmp", sessionPath); },
    async removeItem() { await fs.rm(sessionPath, { force: true }); }
  };
  const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  setSupabaseClient(client);
  if (command === "auth") {
    // The same email and password you sign in to Studio with. Asked for here
    // (the password is not shown); SC_EMAIL / SC_PASSWORD still work for scripts.
    const email = process.env.SC_EMAIL || await ask("Studio email: ");
    const password = process.env.SC_PASSWORD || await ask("Studio password (hidden as you type): ", { hidden: true });
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`Workspace sign-in failed: ${error.message}. Use the email and password you sign in to Studio with.`);
    console.log("Connected. The runner stays signed in to your workspace on this computer; you will not need to do this again.");
    client.auth.stopAutoRefresh(); return;
  }
  const { data: auth, error } = await client.auth.getUser();
  if (error || !auth.user) throw new Error("Run auth once on this host to connect the workspace.");
  const store = new PublisherStore(client, auth.user);
  if (command === "status") { console.log(JSON.stringify(await store.command("read"), null, 2)); client.auth.stopAutoRefresh(); return; }
  const alert = createAlerter({ root, store, webhook: process.env[config.alertWebhookEnv || "SC_ALERT_WEBHOOK"] || "" });
  // No concurrent local owners may share a persistent Chrome profile.
  const release = await acquireLock(localPath(root, "runner.lock"));
  let publisher;
  try {
    const resolvePhotos = async (photos) => {
      const result = [];
      for (const asset of photos) {
        const key = typeof asset === "string" ? asset : asset.path;
        if (!key?.startsWith(auth.user.id + "/")) throw new Error("Image must belong to this workspace owner.");
        const { data, error } = await client.storage.from("publisher-images").download(key);
        if (error) throw new Error("Unable to download an approved post image.");
        const bytes = Buffer.from(await data.arrayBuffer());
        const name = createHash("sha256").update(bytes).digest("hex") + path.extname(key);
        await fs.mkdir(localPath(root, "images"), { recursive: true, mode: 0o700 });
        const file = localPath(root, path.join("images", name));
        await fs.writeFile(file, bytes, { mode: 0o600 }); result.push(file);
      }
      return result;
    };
    if (command === "validate" || command === "reconcile") await openBrowser();
    publisher = new BrowserPublisher({ context, browser, recipes: config.recipes,
      connect: async () => { await openBrowser(); return { context, browser }; },
      resolvePhotos, readerState: async (relative) => JSON.parse(await fs.readFile(localPath(root, relative), "utf8")), evidenceDir: root });
    if (command === "validate") {
      const platform = args[1], recipe = validateRecipe(platform, config.recipes[platform]);
      if (!recipe.sampleBody) throw new Error("Set sampleBody to the exact existing public post text; validation never publishes.");
      console.log(await publisher.verify({ platform, body: recipe.sampleBody, title: recipe.sampleTitle || "" }, recipe.samplePermalink));
      return;
    }
    if (command === "reconcile") {
      const { journal } = await store.load();
      const attempt = journal.attempts.find((a) => a.id === args[1]);
      if (!attempt || !["uncertain", "submitting", "verifying"].includes(attempt.phase)) throw new Error("Specify an unresolved attempt ID.");
      const permalink = args[2] || attempt.permalink;
      if (!permalink) throw new Error("Supply the actual permalink. Reconciliation never submits again.");
      const evidence = await publisher.verify(attempt.snapshot, permalink);
      await store.complete(attempt, evidence, new Date().toISOString());
      console.log("Verified and recorded. Review the incident, then resume posting on the Automation page."); return;
    }
    const generate = backoff(3600000);
    let stop = false;
    process.once("SIGINT", () => { stop = true; }); process.once("SIGTERM", () => { stop = true; });
    do {
      try {
        const { data } = await store.load();
        // Schedules are Studio's, so the runner keeps Studio's clock.
        process.env.TZ = data.automation.timezone;
        await store.command("heartbeat", { host: os.hostname() });
        const result = await tick({ store, browser: publisher, alert, live: config.live === true });
        console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
        if (["idle", "waiting", "dry-run", "updated"].includes(result.state))
          await generate(async () => generateNext({ store, credentials: await runnerCredentials(store, config) }));
        const heartbeat = process.env[config.heartbeatWebhookEnv || "SC_HEARTBEAT_WEBHOOK"];
        if (heartbeat) { if (!heartbeat.startsWith("https://")) throw new Error("Heartbeat must use HTTPS."); await fetch(heartbeat, { signal: AbortSignal.timeout(10000) }); }
      } catch (failure) { await alert(safeError(failure)); }
      if (command !== "run" || stop) break;
      for (let seconds = 0; seconds < Math.max(15, config.pollSeconds || 60) && !stop; seconds++) await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (!stop);
  } finally {
    try { await publisher?.close(); await closeBrowser(); }
    finally { client.auth.stopAutoRefresh(); await release(); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(safeError(error)); process.exitCode = 1; });
}
