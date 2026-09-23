/* Test harness: the real publisher code against the real migration SQL.

   PGlite runs the migration in-process. A small shim gives PublisherStore the
   subset of the Supabase client it uses (PostgREST reads and RPCs), so the
   runner's claims, revisions and recordings go through real PostgreSQL
   transactions. The stand-in for the missing prelaunch SQL is deliberately
   minimal: one revision counter and an upsert/delete item table. */
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { flattenWorkspace } from "../../js/sync.js";

export const USER = "00000000-0000-4000-8000-000000000001";

export async function database(workspace) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create schema sc; create schema storage;
    create table auth.users(id uuid primary key);
    insert into auth.users values('${USER}');
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table sc.workspace_sync_state(user_id uuid primary key, revision bigint, updated_at timestamptz default now());
    create table sc.workspace_items(user_id uuid, entity_type text, entity_id text, data jsonb, revision bigint,
      primary key(user_id,entity_type,entity_id));
    insert into sc.workspace_sync_state(user_id, revision) values('${USER}',1);
    create function sc.apply_workspace_changes(expected_revision bigint, changes jsonb) returns bigint language plpgsql as $$
      declare r bigint; c jsonb; begin
        select revision into r from sc.workspace_sync_state where user_id=auth.uid() for update;
        if r <> expected_revision then raise exception 'SC_REVISION_CONFLICT'; end if;
        for c in select * from jsonb_array_elements(changes) loop
          if c->>'action' = 'delete' then
            delete from sc.workspace_items where user_id=auth.uid() and entity_type=c->>'entity_type' and entity_id=c->>'entity_id';
          else
            insert into sc.workspace_items values(auth.uid(),c->>'entity_type',c->>'entity_id',c->'data',r+1)
            on conflict(user_id,entity_type,entity_id) do update set data=excluded.data, revision=excluded.revision;
          end if;
        end loop;
        update sc.workspace_sync_state set revision=r+1, updated_at=now() where user_id=auth.uid(); return r+1;
      end $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(bucket_id text,name text);
    create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name,'/') $$;
    select set_config('request.jwt.claim.sub','${USER}',false);
  `);
  await db.exec(await readFile(new URL("../migrations/001_publisher.sql", import.meta.url), "utf8"));
  for (const [key, value] of flattenWorkspace(workspace)) {
    const [type, id] = key.split("\u0000");
    await db.query("insert into sc.workspace_items values($1,$2,$3,$4::jsonb,1)", [USER, type, id, JSON.stringify(value)]);
  }
  return db;
}

/* Only the calls the runner makes. Errors come back in Supabase's
   { data, error } shape so the production error paths are exercised. */
export function supabaseShim(db) {
  const wrap = async (run) => {
    try { return { data: await run(), error: null }; }
    catch (error) { return { data: null, error: { message: error.message } }; }
  };
  const from = (table) => {
    const filters = [];
    let columns = "*";
    const where = () => filters.length ? ` where ${filters.map(([column], i) => `${column} = $${i + 1}`).join(" and ")}` : "";
    const query = {
      select(value) { columns = value; return query; },
      eq(column, value) { filters.push([column, value]); return query; },
      order() { return query; },
      limit() { return Promise.resolve({ data: [], error: null }); },
      maybeSingle: () => wrap(async () => (await db.query(`select ${columns} from sc.${table}${where()} limit 1`, filters.map(([, v]) => v))).rows[0] || null),
      range: (start, end) => wrap(async () => (await db.query(`select ${columns} from sc.${table}${where()} order by entity_type, entity_id offset ${start} limit ${end - start + 1}`, filters.map(([, v]) => v))).rows)
    };
    return query;
  };
  const rpc = (name, args = {}) => wrap(async () => {
    if (name === "apply_workspace_changes")
      return (await db.query("select sc.apply_workspace_changes($1::bigint,$2::jsonb) as r", [args.expected_revision, JSON.stringify(args.changes)])).rows[0].r;
    if (name === "publisher_command")
      return (await db.query("select sc.publisher_command($1,$2::jsonb,$3::bigint,$4::jsonb) as r",
        [args.command, JSON.stringify(args.payload ?? {}), args.expected_revision, JSON.stringify(args.changes ?? [])])).rows[0].r;
    throw new Error(`Unexpected RPC ${name}`);
  });
  return {
    schema: () => ({ from, rpc }),
    storage: { from: () => ({ download: async () => ({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null }) }) }
  };
}

export async function revision(db) {
  return Number((await db.query("select revision from sc.workspace_sync_state")).rows[0].revision);
}

/* A second writer — the operator's browser — saving between runner steps. */
export async function browserWrite(db, type, id, data) {
  const current = await revision(db);
  await db.query("select sc.apply_workspace_changes($1::bigint,$2::jsonb)",
    [current, JSON.stringify([{ entity_type: type, entity_id: id, action: "upsert", data }])]);
}

export function fakeBrowser({ fault = "" } = {}) {
  const calls = { prepare: 0, submit: 0, verify: 0 };
  return {
    calls,
    async prepare() { calls.prepare++; if (fault === "prepare") throw new Error("Login expired"); },
    async submit(snapshot) { calls.submit++; return `https://www.${snapshot.platform}.com/test/posts/${calls.submit}`; },
    async verify(snapshot, permalink) {
      calls.verify++;
      if (fault === "verify") throw new Error("Not publicly visible");
      return { permalink, account: "Safe Cycle Test", verifiedAt: new Date().toISOString(), visibility: "public", bodyMatches: true };
    },
    async close() {}
  };
}
