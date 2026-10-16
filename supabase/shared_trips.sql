-- The Planner: read-only trip links for travel companions (Share, inside each trip).
-- Run once in Supabase → SQL Editor → New query → paste this file → Run. Safe to run again.
--
-- When you share a trip, the app saves a copy of just that trip (with only the details you chose) here.
-- Anyone with its link, https://theplanner.pages.dev/share/<token>, can view that copy; they can't change
-- anything or see your other trips. "Stop sharing" deletes the copy, and the link stops working.

create table if not exists public.shared_trip (
  token      text primary key default replace(gen_random_uuid()::text, '-', ''),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  event_id   text not null,
  snapshot   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint shared_trip_one_per_event unique (user_id, event_id),
  constraint shared_trip_size check (pg_column_size(snapshot) < 1024 * 1024)
);

drop trigger if exists shared_trip_touch on public.shared_trip;
create trigger shared_trip_touch before update on public.shared_trip
  for each row execute function public.touch_updated_at();

alter table public.shared_trip enable row level security;
alter table public.shared_trip force row level security;
revoke all on public.shared_trip from anon, authenticated;
grant select, delete on public.shared_trip to authenticated;
-- The token always comes from the database (never chosen by the app)
grant insert (user_id, event_id, snapshot), update (user_id, event_id, snapshot) on public.shared_trip to authenticated;

drop policy if exists "own share: select" on public.shared_trip;
drop policy if exists "own share: insert" on public.shared_trip;
drop policy if exists "own share: update" on public.shared_trip;
drop policy if exists "own share: delete" on public.shared_trip;
create policy "own share: select" on public.shared_trip for select to authenticated using ((select auth.uid()) = user_id);
create policy "own share: insert" on public.shared_trip for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own share: update" on public.shared_trip for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own share: delete" on public.shared_trip for delete to authenticated using ((select auth.uid()) = user_id);

-- Read one shared trip by its token (used by the share link; works without signing in, one trip at a time)
create or replace function public.shared_trip_get(t text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select snapshot || jsonb_build_object('updated_at', updated_at)
  from public.shared_trip where token = t and char_length(t) >= 32 limit 1
$$;
revoke all on function public.shared_trip_get(text) from public;
grant execute on function public.shared_trip_get(text) to anon, authenticated;
