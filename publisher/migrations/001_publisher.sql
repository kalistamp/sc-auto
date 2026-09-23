-- Additive migration. Review against the missing prelaunch SQL, then run in a
-- staging Supabase SQL Editor first. No existing RPC or entity allowlist is replaced.
begin;
create table if not exists sc.publisher_journal (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{"attempts":[],"pausedReason":"","heartbeat":""}'::jsonb
);
alter table sc.publisher_journal enable row level security;
revoke all on sc.publisher_journal from anon, authenticated;

-- The AI provider, model and key the runner writes with, set from Studio's
-- Model settings. Only this owner's session can read it, and only through
-- publisher_command; the table itself is closed to every client role.
create table if not exists sc.publisher_secrets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  model jsonb not null default '{}'::jsonb
);
alter table sc.publisher_secrets enable row level security;
revoke all on sc.publisher_secrets from anon, authenticated;

create or replace function sc.publisher_command(
  command text, payload jsonb default '{}'::jsonb,
  expected_revision bigint default null, changes jsonb default '[]'::jsonb
) returns jsonb language plpgsql security definer set search_path = pg_catalog, sc as $$
declare
  uid uuid := auth.uid();
  s jsonb; a jsonb; items jsonb; alerts jsonb; idx int; i int;
  rev bigint; new_rev bigint; current_config jsonb;
  clock timestamptz := clock_timestamp();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  insert into sc.publisher_journal(user_id) values(uid) on conflict do nothing;
  select state into s from sc.publisher_journal where user_id = uid for update;
  if command = 'read' then return s; end if;
  if command = 'model-get' then
    return coalesce((select model from sc.publisher_secrets where user_id = uid), '{}'::jsonb);
  end if;
  items := s->'attempts';
  if command in ('claim','begin','complete') then
    select revision into rev from sc.workspace_sync_state where user_id = uid for update;
    if expected_revision is null or rev is distinct from expected_revision then
      raise exception 'SC_REVISION_CONFLICT';
    end if;
  end if;
  if command in ('claim','begin') then
    select data->'automation' into current_config from sc.workspace_items
      where user_id = uid and entity_type = 'meta' and entity_id = 'settings';
    if coalesce((current_config->>'enabled')::boolean,false) is not true then raise exception 'Automation disabled'; end if;
    if coalesce(s->>'pausedReason','') <> '' then raise exception 'Publisher paused: %', s->>'pausedReason'; end if;
  end if;
  if command = 'heartbeat' then
    s := s || jsonb_build_object('heartbeat',clock,'host',left(payload->>'host',100));
  elsif command = 'alert' then
    -- Runner failures shown on the website. The newest 50 are kept; a
    -- repeat of the latest message only moves its timestamp and count.
    alerts := coalesce(s->'alerts','[]'::jsonb);
    if jsonb_array_length(alerts) > 0 and alerts->0->>'message' = left(payload->>'message',1500) then
      alerts := jsonb_set(alerts,'{0}',(alerts->0) || jsonb_build_object('lastAt',clock,
        'count',coalesce((alerts->0->>'count')::int,1)+1));
    else
      alerts := jsonb_build_array(jsonb_build_object('at',clock,'lastAt',clock,'count',1,
        'message',left(payload->>'message',1500))) || alerts;
    end if;
    select coalesce(jsonb_agg(x order by n),'[]'::jsonb) into alerts
      from jsonb_array_elements(alerts) with ordinality as t(x,n) where n <= 50;
    s := s || jsonb_build_object('alerts',alerts);
  elsif command = 'pause' then
    -- Never an empty reason: an empty one would read as "not paused".
    s := s || jsonb_build_object('pausedReason',coalesce(nullif(left(payload->>'reason',1000),''),'Paused.'));
  elsif command = 'model-set' then
    if coalesce(payload->>'provider','') = '' or coalesce(payload->>'key','') = '' then
      raise exception 'Choose a provider and paste its key first.';
    end if;
    insert into sc.publisher_secrets(user_id, model) values (uid, jsonb_build_object(
      'provider',left(payload->>'provider',40),'model',left(coalesce(payload->>'model',''),200),
      'effort',left(coalesce(payload->>'effort',''),20),'key',left(payload->>'key',500),'updatedAt',clock))
      on conflict (user_id) do update set model = excluded.model;
    -- What the website shows: never the key itself.
    s := s || jsonb_build_object('runnerModel',jsonb_build_object('provider',left(payload->>'provider',40),
      'model',left(coalesce(payload->>'model',''),200),'updatedAt',clock));
  elsif command = 'model-clear' then
    delete from sc.publisher_secrets where user_id = uid;
    s := s - 'runnerModel';
  elsif command = 'resume' then
    -- A preparation lease that expired can no longer submit; it is abandoned
    -- rather than left to block the resume it cannot complete.
    if jsonb_array_length(items) > 0 then
      for i in 0..jsonb_array_length(items)-1 loop
        a := items->i;
        if a->>'phase' = 'claimed' and (a->>'leaseUntil')::timestamptz < clock then
          items := jsonb_set(items,array[i::text],a || jsonb_build_object('phase','abandoned','finishedAt',clock));
        end if;
      end loop;
    end if;
    if exists(select 1 from jsonb_array_elements(items) x where x->>'phase' in ('submitting','verifying','uncertain','claimed')) then
      raise exception 'Resolve the active attempt first';
    end if;
    s := s || jsonb_build_object('pausedReason','','attempts',items);
  elsif command = 'claim' then
    -- Dry-run and abandoned entries prove nothing was sent, so they are not
    -- deduplication evidence. Keep only the newest 100 of them.
    select coalesce(jsonb_agg(x order by n),'[]'::jsonb) into items from (
      select x, n, row_number() over (partition by x->>'phase' in ('dry-run','abandoned') order by n desc) as keep
        from jsonb_array_elements(items) with ordinality as t(x,n)) kept
      where not (x->>'phase' in ('dry-run','abandoned')) or keep <= 100;
    if jsonb_array_length(items) >= 1000 then raise exception 'Audit capacity reached; archive journal with deduplication evidence before continuing'; end if;
    -- Only preparation can expire. Submitting/verifying/uncertain never release
    -- the global barrier automatically, even if their worker has disappeared.
    if jsonb_array_length(items) > 0 then
      for i in 0..jsonb_array_length(items)-1 loop
        a := items->i;
        if a->>'phase' = 'claimed' and (a->>'leaseUntil')::timestamptz < clock then
          items := jsonb_set(items,array[i::text],a || jsonb_build_object('phase','abandoned','finishedAt',clock));
        elsif a->>'phase' in ('claimed','submitting','verifying','uncertain') then
          raise exception 'Publication already in flight';
        end if;
      end loop;
    end if;
    -- An operation may be claimed again only when every earlier attempt is
    -- known not to have sent anything: failed before submission, abandoned
    -- preparation, dry-run, or a person confirmed it was not published.
    if exists(select 1 from jsonb_array_elements(items) x where x->>'operationId' = payload->>'operationId'
      and x->>'phase' not in ('abandoned','dry-run','failed')
      and not (x->>'phase' = 'resolved' and x->>'resolution' = 'not-published')) then
      raise exception 'Operation already attempted';
    end if;
    if coalesce((current_config->'platforms'->(payload->>'platform')->>'enabled')::boolean,false) is not true then raise exception 'Destination disabled'; end if;
    a := payload || jsonb_build_object('phase','claimed','claimedAt',clock,'leaseUntil',clock + interval '5 minutes',
      'events',jsonb_build_array(jsonb_build_object('phase','claimed','at',clock)));
    if not (a ? 'id' and a ? 'owner' and a ? 'operationId' and a ? 'snapshot') then raise exception 'Incomplete claim'; end if;
    items := items || jsonb_build_array(a);
    s := s || jsonb_build_object('attempts',items);
  else
    select ordinality::int-1, value into idx,a from jsonb_array_elements(items) with ordinality
      where value->>'id' = payload->>'id';
    if a is null then raise exception 'Unknown attempt'; end if;
    if command <> 'resolve' and a->>'owner' is distinct from payload->>'owner' then raise exception 'Lease owner changed'; end if;
    if command = 'begin' then
      if a->>'phase' <> 'claimed' or (a->>'leaseUntil')::timestamptz <= clock then raise exception 'Preparation lease expired'; end if;
      if coalesce((current_config->>'dryRun')::boolean,true) then raise exception 'Dry-run is enabled'; end if;
      if coalesce((current_config->'platforms'->(a->>'platform')->>'enabled')::boolean,false) is not true then raise exception 'Destination disabled'; end if;
      a := a || jsonb_build_object('phase','submitting','submittedAt',clock);
    elsif command = 'submitted' then
      if a->>'phase' <> 'submitting' then raise exception 'Invalid submit transition'; end if;
      a := a || jsonb_build_object('phase','verifying','permalink',payload->>'permalink');
    elsif command = 'complete' then
      if a->>'phase' not in ('submitting','verifying','uncertain') then raise exception 'Invalid completion'; end if;
      if coalesce(payload->>'permalink','') = '' or jsonb_array_length(changes) = 0 then raise exception 'Missing publication evidence'; end if;
      -- The existing RPC commits the ordinary publication record in this same
      -- transaction; if it fails, no attempt is marked complete.
      select sc.apply_workspace_changes(expected_revision, changes) into new_rev;
      a := a || jsonb_build_object('phase','succeeded','finishedAt',clock,'permalink',payload->>'permalink','evidence',payload->'evidence');
    elsif command = 'finish' then
      if payload->>'phase' not in ('failed','uncertain','dry-run','abandoned') then raise exception 'Invalid outcome'; end if;
      if a->>'phase' in ('submitting','verifying','uncertain') and payload->>'phase' <> 'uncertain' then raise exception 'Cannot clear a possible submission'; end if;
      if a->>'phase' not in ('claimed','submitting','verifying','uncertain') then raise exception 'Attempt already terminal'; end if;
      a := a || jsonb_build_object('phase',payload->>'phase','error',left(payload->>'error',1000),'finishedAt',clock);
      if payload->>'phase' in ('failed','uncertain') then
        s := s || jsonb_build_object('pausedReason',coalesce(nullif(left(payload->>'error',1000),''),'Stopped after a failed attempt.'));
      end if;
    elsif command = 'resolve' then
      if a->>'phase' not in ('uncertain','submitting','verifying','claimed') or length(coalesce(payload->>'note','')) < 10 then raise exception 'Resolution needs an active attempt and evidence note'; end if;
      if payload->>'outcome' not in ('published-externally','not-published') then raise exception 'Invalid resolution'; end if;
      -- A send still marked in progress may belong to a runner that is alive.
      -- Only settle it once no runner has checked in for five minutes.
      if a->>'phase' in ('submitting','verifying')
        and nullif(s->>'heartbeat','')::timestamptz > clock - interval '5 minutes' then
        raise exception 'The runner checked in within the last five minutes. Stop it, wait five minutes, then record what happened.';
      end if;
      -- Resolution never submits anything itself. 'not-published' is a person's
      -- finding that nothing went out, so the item may be claimed again once
      -- publishing is resumed; 'published-externally' keeps it blocked for good.
      a := a || jsonb_build_object('phase','resolved','resolution',payload->>'outcome','note',payload->>'note','finishedAt',clock);
    else raise exception 'Unknown publisher command'; end if;
    a := a || jsonb_build_object('events',coalesce(a->'events','[]'::jsonb) || jsonb_build_array(jsonb_build_object('phase',a->>'phase','at',clock)));
    s := s || jsonb_build_object('attempts',jsonb_set(items,array[idx::text],a));
  end if;
  update sc.publisher_journal set state = s where user_id = uid;
  return s || jsonb_build_object('revision',new_rev);
end $$;
revoke all on function sc.publisher_command(text,jsonb,bigint,jsonb) from public, anon;
grant execute on function sc.publisher_command(text,jsonb,bigint,jsonb) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('publisher-images','publisher-images',false,10485760,array['image/jpeg','image/png','image/webp']) on conflict(id) do nothing;
-- Re-runnable: an updated copy of this file can be applied over an earlier one.
drop policy if exists publisher_images_owner_select on storage.objects;
drop policy if exists publisher_images_owner_insert on storage.objects;
create policy publisher_images_owner_select on storage.objects for select to authenticated
using(bucket_id = 'publisher-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy publisher_images_owner_insert on storage.objects for insert to authenticated
with check(bucket_id = 'publisher-images' and (storage.foldername(name))[1] = auth.uid()::text);
commit;
