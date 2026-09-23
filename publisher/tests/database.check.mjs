import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const USER = "00000000-0000-4000-8000-000000000001";
async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create schema sc; create schema storage;
    create table auth.users(id uuid primary key);
    insert into auth.users values('${USER}');
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table sc.workspace_sync_state(user_id uuid primary key, revision bigint);
    create table sc.workspace_items(user_id uuid, entity_type text, entity_id text, data jsonb, primary key(user_id,entity_type,entity_id));
    insert into sc.workspace_sync_state values('${USER}',1);
    insert into sc.workspace_items values('${USER}','meta','settings','{"automation":{"enabled":true,"dryRun":false,"platforms":{"facebook":{"enabled":true}}}}');
    create function sc.apply_workspace_changes(expected_revision bigint, changes jsonb) returns bigint language plpgsql as $$
      declare r bigint; c jsonb; begin
        select revision into r from sc.workspace_sync_state where user_id=auth.uid() for update;
        if r <> expected_revision then raise exception 'SC_REVISION_CONFLICT'; end if;
        for c in select * from jsonb_array_elements(changes) loop
          insert into sc.workspace_items values(auth.uid(),c->>'entity_type',c->>'entity_id',c->'data')
          on conflict(user_id,entity_type,entity_id) do update set data=excluded.data;
        end loop;
        update sc.workspace_sync_state set revision=r+1 where user_id=auth.uid(); return r+1;
      end $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(bucket_id text,name text);
    create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name,'/') $$;
    select set_config('request.jwt.claim.sub','${USER}',false);
  `);
  await db.exec(await readFile(new URL("../migrations/001_publisher.sql", import.meta.url), "utf8"));
  const command = async (name, payload = {}, revision = null, changes = []) => (await db.query("select sc.publisher_command($1,$2::jsonb,$3::bigint,$4::jsonb) as state", [name, JSON.stringify(payload), revision, JSON.stringify(changes)])).rows[0].state;
  return { db, command };
}
const claim = (id) => ({ id, owner: id, operationId: "post-1:create", platform: "facebook", snapshot: { itemId: "post-1" } });
test("SQL claim is exclusive, stale revisions fail, expired preparation can be reclaimed", async () => {
  const { db, command } = await database();
  try {
    await assert.rejects(() => command("claim", claim("stale"), 0), /SC_REVISION_CONFLICT/);
    await command("claim", claim("a"), 1);
    await assert.rejects(() => command("claim", claim("b"), 1), /in flight/);
    await db.exec(`update sc.publisher_journal set state=jsonb_set(state,'{attempts,0,leaseUntil}','"2020-01-01T00:00:00Z"');`);
    await command("claim", claim("b"), 1);
    await assert.rejects(() => command("begin", { id: "a", owner: "a" }, 1), /expired/);
    await command("begin", { id: "b", owner: "b" }, 1);
    await db.exec(`update sc.publisher_journal set state=jsonb_set(state,'{attempts,1,leaseUntil}','"2020-01-01T00:00:00Z"');`);
    await assert.rejects(() => command("claim", { ...claim("c"), operationId: "post-2" }, 1), /in flight/);
    await assert.rejects(() => command("finish", { id: "b", owner: "b", phase: "failed" }), /possible submission/);
  } finally { await db.close(); }
});
test("SQL completion and workspace write are atomic; recording conflict preserves barrier", async () => {
  const { db, command } = await database();
  try {
    await command("claim", claim("a"), 1); await command("begin", { id: "a", owner: "a" }, 1);
    const args = { id: "a", owner: "a", permalink: "https://facebook.com/posts/123", evidence: { bodyMatches: true } };
    const changes = [{ entity_type: "post", entity_id: "post-1", action: "upsert", data: { publishedBody: "exact copy" } }];
    await assert.rejects(() => command("complete", args, 0, changes), /SC_REVISION_CONFLICT/);
    assert.equal((await command("read")).attempts[0].phase, "submitting");
    await command("complete", args, 1, changes);
    assert.equal((await command("read")).attempts[0].phase, "succeeded");
    assert.equal((await db.query("select data from sc.workspace_items where entity_type='post'")).rows[0].data.publishedBody, "exact copy");
    await assert.rejects(() => command("claim", claim("b"), 2), /already attempted/);
  } finally { await db.close(); }
});
test("SQL journal is owner-isolated and cannot be written through authenticated table access", async () => {
  const { db, command } = await database();
  try {
    await command("claim", claim("a"), 1);
    await db.exec(`insert into auth.users values('00000000-0000-4000-8000-000000000002'); select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);`);
    assert.equal((await command("read")).attempts.length, 0);
    await assert.rejects(() => command("finish", { id: "a", owner: "a", phase: "failed" }), /Unknown attempt/);
    await db.exec("grant usage on schema sc to authenticated; set role authenticated;");
    await assert.rejects(() => db.query("delete from sc.publisher_journal"), /permission denied/);
    await db.exec("reset role; select set_config('request.jwt.claim.sub','',false);");
    await assert.rejects(() => command("read"), /Authentication required/);
  } finally { await db.close(); }
});
test("SQL keeps runner alerts for the website, newest first, folding repeats", async () => {
  const { db, command } = await database();
  try {
    await command("alert", { message: "Login expired" });
    await command("alert", { message: "Login expired" });
    await command("alert", { message: "Selector changed" });
    const { alerts } = await command("read");
    assert.deepEqual(alerts.map((a) => [a.message, a.count]), [["Selector changed", 1], ["Login expired", 2]]);
    for (let i = 0; i < 60; i++) await command("alert", { message: `failure ${i}` });
    assert.equal((await command("read")).alerts.length, 50);
  } finally { await db.close(); }
});
test("SQL retries only what provably did not send, and resume clears an expired preparation", async () => {
  const { db, command } = await database();
  try {
    await command("claim", claim("a"), 1);
    await command("finish", { id: "a", owner: "a", phase: "failed", error: "Login expired" });
    await assert.rejects(() => command("claim", claim("b"), 1), /paused/);
    await command("resume");
    await command("claim", claim("b"), 1);
    await db.exec(`update sc.publisher_journal set state=jsonb_set(state,'{attempts,1,leaseUntil}','"2020-01-01T00:00:00Z"');`);
    await command("pause", { reason: "operator pause" });
    const resumed = await command("resume");
    assert.equal(resumed.attempts[1].phase, "abandoned");
    await command("claim", claim("c"), 1); await command("begin", { id: "c", owner: "c" }, 1);
    await command("resolve", { id: "c", outcome: "not-published", note: "Checked the Page; nothing went out." });
    await command("resume");
    await command("claim", claim("d"), 1); await command("begin", { id: "d", owner: "d" }, 1);
    await command("resolve", { id: "d", outcome: "published-externally", note: "It is live on the Page already." });
    await command("resume");
    await assert.rejects(() => command("claim", claim("e"), 1), /already attempted/);
  } finally { await db.close(); }
});
test("SQL prunes dry-run decisions so they cannot exhaust the audit capacity", async () => {
  const { db, command } = await database();
  try {
    for (let i = 0; i < 130; i++) {
      await command("claim", { ...claim(`dry-${i}`), operationId: `op-${i}` }, 1);
      await command("finish", { id: `dry-${i}`, owner: `dry-${i}`, phase: "dry-run" });
    }
    await command("claim", { ...claim("last"), operationId: "op-last" }, 1);
    const { attempts } = await command("read");
    assert.equal(attempts.filter((a) => a.phase === "dry-run").length, 100);
    assert.equal(attempts.at(-1).id, "last");
    assert.equal(attempts.find((a) => a.phase === "dry-run").id, "dry-30", "the oldest are the ones dropped");
  } finally { await db.close(); }
});
test("SQL will not settle a send a live runner may still be making, and a pause always pauses", async () => {
  const { db, command } = await database();
  try {
    await command("claim", claim("a"), 1); await command("begin", { id: "a", owner: "a" }, 1);
    await command("heartbeat", { host: "runner" });
    await assert.rejects(() => command("resolve", { id: "a", outcome: "not-published", note: "Looked at the Page; nothing there." }), /checked in/);
    await db.exec(`update sc.publisher_journal set state=jsonb_set(state,'{heartbeat}','"2020-01-01T00:00:00Z"')`);
    await command("resolve", { id: "a", outcome: "not-published", note: "Looked at the Page; nothing there." });
    await command("resume");
    await command("pause", {});
    await assert.rejects(() => command("claim", claim("b"), 1), /paused/);
    await command("resume");
    await command("claim", claim("c"), 1);
    await command("finish", { id: "c", owner: "c", phase: "failed" });
    await assert.rejects(() => command("claim", claim("d"), 1), /paused/, "a failure with no message still pauses");
  } finally { await db.close(); }
});
test("SQL keeps the runner's model key for its owner only, and never shows it in the status read", async () => {
  const { db, command } = await database();
  try {
    assert.deepEqual(await command("model-get"), {});
    await assert.rejects(() => command("model-set", { provider: "mistral", key: "" }), /paste its key/);
    const state = await command("model-set", { provider: "mistral", model: "mistral-large-latest", key: "secret-key-123" });
    assert.equal(state.runnerModel.provider, "mistral");
    assert.doesNotMatch(JSON.stringify(await command("read")), /secret-key-123/);
    assert.equal((await command("model-get")).key, "secret-key-123");
    await db.exec(`insert into auth.users values('00000000-0000-4000-8000-000000000002'); select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);`);
    assert.deepEqual(await command("model-get"), {}, "another account cannot read it");
    await db.exec(`select set_config('request.jwt.claim.sub','${USER}',false);`);
    await command("model-clear");
    assert.deepEqual(await command("model-get"), {});
    assert.equal((await command("read")).runnerModel, undefined);
    await db.exec("grant usage on schema sc to authenticated; set role authenticated;");
    await assert.rejects(() => db.query("select * from sc.publisher_secrets"), /permission denied/);
    await db.exec("reset role;");
  } finally { await db.close(); }
});
