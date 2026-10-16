-- The Planner: AI reading for Smart Upload (used by the Edge Function "ai-scan").
-- Run once in Supabase → SQL Editor → New query → paste this file → Run. Safe to run again.
--
-- ai_usage   one row per AI read: who, which day (UTC), what it cost. Only the server function can see it.
-- scan_rules recipes for booking layouts the AI has read. Signed-in users' apps read them so the next
--            booking in a known layout is read without the AI. They hold only fixed template wording
--            (checked by the function: no digits, emails or names), never anyone's booking details.

create table if not exists public.ai_usage (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  day        date not null default (now() at time zone 'utc')::date,
  cost_usd   numeric(10,6) not null default 0,
  status     text not null default 'pending',
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_day on public.ai_usage (day, user_id);
alter table public.ai_usage enable row level security;
alter table public.ai_usage force row level security;
revoke all on public.ai_usage from anon, authenticated;

create table if not exists public.scan_rules (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('flight','hotel','activity','transport')),
  signature   jsonb not null,
  patterns    jsonb not null default '[]',
  leg_pattern text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.scan_rules enable row level security;
alter table public.scan_rules force row level security;
revoke all on public.scan_rules from anon, authenticated;
grant select (id, kind, signature, patterns, leg_pattern, updated_at) on public.scan_rules to authenticated;
drop policy if exists "signed-in users read recipes" on public.scan_rules;
create policy "signed-in users read recipes" on public.scan_rules for select to authenticated using (true);

-- Before an AI read: check this person's 20-a-day and everyone's US$0.50-a-day, then hold a slot.
-- One at a time (advisory lock), so two scans at once can't both squeeze under the cap.
create or replace function public.ai_scan_reserve(p_user uuid, p_estimate numeric, p_user_limit int, p_daily_cap numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d date := (now() at time zone 'utc')::date; mine int; spent numeric; new_id bigint;
begin
  perform pg_advisory_xact_lock(724501);
  -- Slots left pending by a crashed request stop counting after 10 minutes
  update public.ai_usage set status = 'failed', cost_usd = 0 where status = 'pending' and created_at < now() - interval '10 minutes';
  select count(*) into mine from public.ai_usage where day = d and user_id = p_user and status <> 'failed';
  if mine >= p_user_limit then return jsonb_build_object('ok', false, 'reason', 'user_limit', 'remaining', 0); end if;
  select coalesce(sum(cost_usd), 0) into spent from public.ai_usage where day = d and status <> 'failed';
  if spent + p_estimate > p_daily_cap then return jsonb_build_object('ok', false, 'reason', 'daily_cap', 'remaining', p_user_limit - mine); end if;
  insert into public.ai_usage (user_id, day, cost_usd) values (p_user, d, p_estimate) returning id into new_id;
  return jsonb_build_object('ok', true, 'id', new_id, 'remaining', p_user_limit - mine - 1);
end $$;

-- After the AI read: record what it actually cost
create or replace function public.ai_scan_finish(p_id bigint, p_cost numeric, p_status text)
returns void language sql security definer set search_path = '' as $$
  update public.ai_usage set cost_usd = p_cost, status = p_status where id = p_id;
$$;

-- Save a recipe. A layout seen before (same identifying wording) gains any new patterns instead of a duplicate.
create or replace function public.scan_rule_save(p_kind text, p_signature jsonb, p_patterns jsonb, p_leg_pattern text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare sig jsonb; existing public.scan_rules; merged jsonb;
begin
  select coalesce(jsonb_agg(x order by x), '[]') into sig from (select lower(trim(v)) x from jsonb_array_elements_text(p_signature) v) s;
  select * into existing from public.scan_rules where kind = p_kind and signature = sig limit 1;
  if existing.id is null then
    insert into public.scan_rules (kind, signature, patterns, leg_pattern) values (p_kind, sig, coalesce(p_patterns, '[]'), p_leg_pattern) returning id into existing.id;
    return existing.id;
  end if;
  select coalesce(jsonb_agg(p), '[]') into merged from (
    select p from jsonb_array_elements(existing.patterns) p
    union all
    select n from jsonb_array_elements(coalesce(p_patterns, '[]')) n
      where not exists (select 1 from jsonb_array_elements(existing.patterns) o where o->>'field' = n->>'field')
  ) s;
  update public.scan_rules set patterns = merged, leg_pattern = coalesce(leg_pattern, p_leg_pattern), updated_at = now() where id = existing.id;
  return existing.id;
end $$;

revoke all on function public.ai_scan_reserve(uuid, numeric, int, numeric) from public, anon, authenticated;
revoke all on function public.ai_scan_finish(bigint, numeric, text) from public, anon, authenticated;
revoke all on function public.scan_rule_save(text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.ai_scan_reserve(uuid, numeric, int, numeric) to service_role;
grant execute on function public.ai_scan_finish(bigint, numeric, text) to service_role;
grant execute on function public.scan_rule_save(text, jsonb, jsonb, text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────────
-- Useful checks (select a line and Run):
--   Today's AI spend:       select count(*), sum(cost_usd) from public.ai_usage where day = (now() at time zone 'utc')::date and status = 'done';
--   Layouts learned so far: select id, kind, signature, jsonb_array_length(patterns) as patterns, leg_pattern is not null as legs, updated_at from public.scan_rules order by updated_at desc;
--   Forget a bad recipe:    delete from public.scan_rules where id = 123;
