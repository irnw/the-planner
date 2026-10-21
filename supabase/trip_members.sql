-- The Planner: trips you plan together (Trip → People → Invite by email).
-- Run once in Supabase → SQL Editor → New query → paste this file → Run. Safe to run again.
-- Needs schema.sql (touch_updated_at) and attachments.sql (the 'attachments' bucket) first.
--
-- A trip you invite people to moves into its own row here. Only its owner and the people who joined can
-- read it, and every change goes through trip_save, which checks what that person is allowed to change:
--   editor: everything in the trip       budget: costs, splits, who paid, Settle up
--   custom: the parts the owner ticked (details, flights, hotels, activities, transport, budget, checklist, attachments)
-- Only the owner can delete the trip, invite or remove people. Anyone can remove a flight they added;
-- only the owner can remove other people's flights.
-- Invites match the email someone signs in with (confirmed emails only). No email is sent by the app.

create table if not exists public.trip (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  version     bigint not null default 1,
  updated_by  uuid,
  updated_at  timestamptz not null default now(),
  constraint trip_size check (pg_column_size(data) < 5 * 1024 * 1024)
);
create index if not exists trip_owner_idx on public.trip (owner_id);

create table if not exists public.trip_member (
  trip_id     uuid not null references public.trip (id) on delete cascade,
  email       text not null check (email = lower(email) and length(email) between 3 and 254),
  user_id     uuid references auth.users (id) on delete cascade,
  role        text not null check (role in ('editor', 'budget', 'custom')),
  perms       text[] not null default '{}',
  person_id   text,
  invited_at  timestamptz not null default now(),
  joined_at   timestamptz,
  primary key (trip_id, email)
);
create index if not exists trip_member_user_idx on public.trip_member (user_id);
create index if not exists trip_member_email_idx on public.trip_member (email);

drop trigger if exists trip_touch on public.trip;
create trigger trip_touch before update on public.trip for each row execute function public.touch_updated_at();

-- Nobody reads or writes these tables directly: everything goes through the functions below
alter table public.trip enable row level security;
alter table public.trip force row level security;
alter table public.trip_member enable row level security;
alter table public.trip_member force row level security;
revoke all on public.trip, public.trip_member from anon, authenticated;

-- The signed-in person's email, only once they've confirmed it
create or replace function public.trip_my_email() returns text
language sql stable security definer set search_path = '' as $$
  select lower(u.email) from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null
$$;

-- What the signed-in person may do on a trip: null = not on it
create or replace function public.trip_perms(p_trip uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare r record; allp text[] := array['details','flights','hotels','activities','transport','budget','checklist','attachments'];
begin
  if auth.uid() is null then return null; end if;
  if exists (select 1 from public.trip t where t.id = p_trip and t.owner_id = auth.uid()) then return array['owner'] || allp; end if;
  select m.role, m.perms into r from public.trip_member m where m.trip_id = p_trip and m.user_id = auth.uid() and m.joined_at is not null;
  if not found then return null; end if;
  if r.role = 'editor' then return allp; end if;
  if r.role = 'budget' then return array['budget']; end if;
  return array(select unnest(r.perms) intersect select unnest(allp));
end $$;

-- For storage policies: trips/<trip id>/… files
create or replace function public.trip_file_can(p_trip text, p_perm text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare pr text[];
begin
  if p_trip !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  pr := public.trip_perms(p_trip::uuid);
  return pr is not null and (p_perm = 'view' or p_perm = any(pr));
end $$;

-- Items of one kind keyed by id, without (or with only) the money fields
create or replace function public.trip_items(p_arr jsonb, p_keys text[], p_only boolean) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(e->>'id',
    case when p_only then coalesce((select jsonb_object_agg(k, v) from jsonb_each(e) x(k, v) where k = any(p_keys)), '{}'::jsonb)
         else e - p_keys end), '{}'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_arr) = 'array' then p_arr else '[]'::jsonb end) e
$$;

-- Trips I own or joined, with what I may do on each
create or replace function public.trip_list() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'version', t.version, 'data', t.data,
    'owner', t.owner_id = auth.uid(), 'perms', to_jsonb(public.trip_perms(t.id)),
    'person', case when t.owner_id = auth.uid() then 'u:' || auth.uid()::text else m.person_id end, 'ownerPerson', 'u:' || t.owner_id::text)), '[]'::jsonb)
  from public.trip t left join public.trip_member m on m.trip_id = t.id and m.user_id = auth.uid() and m.joined_at is not null
  where t.owner_id = auth.uid() or m.user_id is not null
$$;

-- Just the versions (and your permissions), for cheap polling
create or replace function public.trip_versions() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(t.id, jsonb_build_array(t.version, to_jsonb(public.trip_perms(t.id)))), '{}'::jsonb)
  from public.trip t
  where t.owner_id = auth.uid() or exists (select 1 from public.trip_member m where m.trip_id = t.id and m.user_id = auth.uid() and m.joined_at is not null)
$$;

create or replace function public.trip_create(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.trip;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if jsonb_typeof(p_data) <> 'object' then raise exception 'bad trip'; end if;
  insert into public.trip (owner_id, data, updated_by) values (auth.uid(), p_data, auth.uid()) returning * into r;
  return jsonb_build_object('id', r.id, 'version', r.version);
end $$;

-- Save a trip. p_version must be the version the change was made on; if someone saved in between,
-- nothing is written and the latest copy comes back (the app merges and tries again).
create or replace function public.trip_save(p_id uuid, p_version bigint, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.trip; pr text[]; me text := auth.uid()::text; k text; o jsonb; n jsonb; gone text[];
  money text[] := array['cost','currency','rateToSGD','split','splitWith','paidBy','settled','depositAmount','depositCurrency','depositDate',
    'depositPaid','paymentDueDate','fullyPaid','fullPaymentAmount','fullPaymentCurrency'];
  parts text[] := array['flights','hotels','activities','transport','checklist','attachments','party','settle'];
begin
  pr := public.trip_perms(p_id);
  if pr is null then raise exception 'You are not on this trip'; end if;
  if jsonb_typeof(p_data) <> 'object' then raise exception 'bad trip'; end if;
  select * into t from public.trip where id = p_id for update;
  if t.version <> p_version then
    return jsonb_build_object('ok', false, 'version', t.version, 'data', t.data);
  end if;
  if not ('owner' = any(pr)) then
    if (t.data - parts) is distinct from (p_data - parts) and not ('details' = any(pr)) then
      raise exception 'You can''t change this trip''s details'; end if;
    foreach k in array array['flights','hotels','activities','transport'] loop
      o := t.data -> k; n := p_data -> k;
      if public.trip_items(o, money, false) is distinct from public.trip_items(n, money, false) and not (k = any(pr)) then
        raise exception 'You can''t change % on this trip', k; end if;
      -- Money fields of bookings that were already there
      if not ('budget' = any(pr)) and exists (
        select 1 from jsonb_each(public.trip_items(o, money, true)) a(id, v)
        join jsonb_each(public.trip_items(n, money, true)) b(id, v) using (id) where a.v is distinct from b.v) then
        raise exception 'You can''t change costs on this trip'; end if;
      -- Who added a booking can't be changed
      if exists (
        select 1 from jsonb_array_elements(coalesce(o, '[]'::jsonb)) a join jsonb_array_elements(coalesce(n, '[]'::jsonb)) b
        on a->>'id' = b->>'id' where a->'by' is distinct from b->'by') then
        raise exception 'You can''t change who added a booking'; end if;
    end loop;
    -- Flights: you can only remove the ones you added, and new ones must be yours
    select array_agg(a->>'id') into gone from jsonb_array_elements(coalesce(t.data->'flights', '[]'::jsonb)) a
      where (a->>'by') is distinct from me
        and not exists (select 1 from jsonb_array_elements(coalesce(p_data->'flights', '[]'::jsonb)) b where b->>'id' = a->>'id');
    if gone is not null then raise exception 'Only the trip owner can remove flights other people added'; end if;
    if exists (select 1 from jsonb_array_elements(coalesce(p_data->'flights', '[]'::jsonb)) b
        where (b->>'by') is distinct from me
          and not exists (select 1 from jsonb_array_elements(coalesce(t.data->'flights', '[]'::jsonb)) a where a->>'id' = b->>'id')) then
      raise exception 'New flights must be added as yourself'; end if;
    if ((t.data->'party') is distinct from (p_data->'party') or (t.data->'settle') is distinct from (p_data->'settle')) and not ('budget' = any(pr)) then
      raise exception 'You can''t change the split on this trip'; end if;
    if (t.data->'checklist') is distinct from (p_data->'checklist') and not ('checklist' = any(pr)) then
      raise exception 'You can''t change the checklist on this trip'; end if;
    if (t.data->'attachments') is distinct from (p_data->'attachments') and not ('attachments' = any(pr)) then
      raise exception 'You can''t change attachments on this trip'; end if;
  end if;
  update public.trip set data = p_data, version = version + 1, updated_by = auth.uid() where id = p_id returning * into t;
  return jsonb_build_object('ok', true, 'version', t.version);
end $$;

create or replace function public.trip_delete(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.trip where id = p_id and owner_id = auth.uid();
  if not found then raise exception 'Only the trip owner can delete it'; end if;
end $$;

-- People on a trip. The owner sees everyone's email; others see names and roles
create or replace function public.trip_members(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare pr text[] := public.trip_perms(p_id); own boolean;
begin
  if pr is null then raise exception 'You are not on this trip'; end if;
  own := 'owner' = any(pr);
  return coalesce((select jsonb_agg(jsonb_build_object('email', case when own or m.user_id = auth.uid() then m.email end,
      'role', m.role, 'perms', to_jsonb(m.perms), 'person', m.person_id, 'joined', m.joined_at is not null, 'me', m.user_id = auth.uid())
      order by m.invited_at)
    from public.trip_member m where m.trip_id = p_id), '[]'::jsonb);
end $$;

create or replace function public.trip_invite(p_id uuid, p_email text, p_role text, p_perms text[], p_person text) returns void
language plpgsql security definer set search_path = '' as $$
declare e text := lower(trim(p_email));
begin
  if not exists (select 1 from public.trip where id = p_id and owner_id = auth.uid()) then raise exception 'Only the trip owner can invite people'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That email doesn''t look right'; end if;
  if e = public.trip_my_email() then raise exception 'That''s your own email'; end if;
  if p_role not in ('editor','budget','custom') then raise exception 'bad role'; end if;
  if (select count(*) from public.trip_member where trip_id = p_id) >= 30 then raise exception 'A trip can have up to 30 people'; end if;
  insert into public.trip_member (trip_id, email, role, perms, person_id)
    values (p_id, e, p_role, coalesce(p_perms, '{}'), nullif(p_person, ''))
  on conflict (trip_id, email) do update set role = excluded.role, perms = excluded.perms, person_id = coalesce(excluded.person_id, public.trip_member.person_id);
end $$;

create or replace function public.trip_remove_member(p_id uuid, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.trip where id = p_id and owner_id = auth.uid()) then raise exception 'Only the trip owner can remove people'; end if;
  delete from public.trip_member where trip_id = p_id and email = lower(p_email);
end $$;

create or replace function public.trip_leave(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.trip_member where trip_id = p_id and user_id = auth.uid()
$$;

-- Invites waiting for the signed-in person's (confirmed) email
create or replace function public.trip_invites() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.data->>'name', 'startDate', t.data->>'startDate', 'endDate', t.data->>'endDate',
    'role', m.role, 'from', coalesce(nullif(split_part(coalesce(u.raw_user_meta_data->>'name', u.raw_user_meta_data->>'full_name', ''), ' ', 1), ''), 'Someone'))), '[]'::jsonb)
  from public.trip_member m join public.trip t on t.id = m.trip_id join auth.users u on u.id = t.owner_id
  where m.email = public.trip_my_email() and m.joined_at is null and t.owner_id <> auth.uid()
$$;

-- Join: links you to your name in the Split tab, adding you there if the owner didn't pick one
create or replace function public.trip_join(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e text := public.trip_my_email(); m public.trip_member; t public.trip; nm text; pid text;
begin
  if e is null then raise exception 'Confirm your email first'; end if;
  select * into m from public.trip_member where trip_id = p_id and email = e for update;
  if not found then raise exception 'This invite is no longer available'; end if;
  select * into t from public.trip where id = p_id for update;
  pid := m.person_id;
  if pid is null or not exists (select 1 from jsonb_array_elements(coalesce(t.data->'party', '[]'::jsonb)) p where p->>'id' = pid) then
    pid := 'u:' || auth.uid()::text;
    select coalesce(nullif(split_part(coalesce(raw_user_meta_data->>'name', raw_user_meta_data->>'full_name', ''), ' ', 1), ''), split_part(e, '@', 1))
      into nm from auth.users where id = auth.uid();
    if not exists (select 1 from jsonb_array_elements(coalesce(t.data->'party', '[]'::jsonb)) p where p->>'id' = pid) then
      update public.trip set data = jsonb_set(data, '{party}', coalesce(data->'party', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('id', pid, 'name', left(nm, 40)))),
        version = version + 1 where id = p_id;
    end if;
  end if;
  update public.trip_member set user_id = auth.uid(), joined_at = now(), person_id = pid where trip_id = p_id and email = e;
  return jsonb_build_object('person', pid);
end $$;

create or replace function public.trip_decline(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.trip_member where trip_id = p_id and email = public.trip_my_email() and joined_at is null
$$;

revoke all on function public.trip_my_email(), public.trip_perms(uuid), public.trip_file_can(text, text), public.trip_items(jsonb, text[], boolean),
  public.trip_list(), public.trip_versions(), public.trip_create(jsonb), public.trip_save(uuid, bigint, jsonb), public.trip_delete(uuid),
  public.trip_members(uuid), public.trip_invite(uuid, text, text, text[], text), public.trip_remove_member(uuid, text), public.trip_leave(uuid),
  public.trip_invites(), public.trip_join(uuid), public.trip_decline(uuid) from public, anon;
grant execute on function public.trip_perms(uuid), public.trip_file_can(text, text),
  public.trip_list(), public.trip_versions(), public.trip_create(jsonb), public.trip_save(uuid, bigint, jsonb), public.trip_delete(uuid),
  public.trip_members(uuid), public.trip_invite(uuid, text, text, text[], text), public.trip_remove_member(uuid, text), public.trip_leave(uuid),
  public.trip_invites(), public.trip_join(uuid), public.trip_decline(uuid) to authenticated;

-- Files of a shared trip (PDF attachments) live under trips/<trip id>/ in the attachments bucket
drop policy if exists "trip files: select" on storage.objects;
drop policy if exists "trip files: insert" on storage.objects;
drop policy if exists "trip files: delete" on storage.objects;
create policy "trip files: select" on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = 'trips' and public.trip_file_can((storage.foldername(name))[2], 'view'));
create policy "trip files: insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = 'trips' and public.trip_file_can((storage.foldername(name))[2], 'attachments'));
create policy "trip files: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = 'trips' and public.trip_file_can((storage.foldername(name))[2], 'attachments'));
