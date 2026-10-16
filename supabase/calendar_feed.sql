-- The Planner: each account's calendar feed (subscribe in Apple Calendar, Google Calendar or Outlook).
-- Run once in Supabase → SQL Editor → New query → paste this file → Run. Safe to run again.
--
-- The app saves a ready-made calendar file (.ics) here whenever your trips change. Calendar apps fetch it from
-- https://theplanner.pages.dev/feed/<token>.ics, which looks it up by its long random token (functions/feed/[token].js).
-- Nobody can list feeds or guess a token; only the owner can see or change their own row.

create table if not exists public.calendar_feed (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  token      text not null unique default replace(gen_random_uuid()::text, '-', ''),
  ics        text not null default '',
  updated_at timestamptz not null default now(),
  constraint calendar_feed_size check (octet_length(ics) < 5 * 1024 * 1024)
);

drop trigger if exists calendar_feed_touch on public.calendar_feed;
create trigger calendar_feed_touch before update on public.calendar_feed
  for each row execute function public.touch_updated_at();

alter table public.calendar_feed enable row level security;
alter table public.calendar_feed force row level security;
revoke all on public.calendar_feed from anon, authenticated;
grant select on public.calendar_feed to authenticated;
-- The token always comes from the database (never chosen by the app)
grant insert (user_id, ics), update (user_id, ics) on public.calendar_feed to authenticated;

drop policy if exists "own feed: select" on public.calendar_feed;
drop policy if exists "own feed: insert" on public.calendar_feed;
drop policy if exists "own feed: update" on public.calendar_feed;
create policy "own feed: select" on public.calendar_feed for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "own feed: insert" on public.calendar_feed for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "own feed: update" on public.calendar_feed for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Read one feed by its token (used by the feed link; works without signing in, one feed at a time)
create or replace function public.calendar_feed_ics(t text) returns text
language sql stable security definer set search_path = '' as $$
  select ics from public.calendar_feed where token = t and char_length(t) >= 32 limit 1
$$;
revoke all on function public.calendar_feed_ics(text) from public;
grant execute on function public.calendar_feed_ics(text) to anon, authenticated;

-- "Reset link" in Settings: a new token, so the old link stops working
create or replace function public.reset_calendar_link() returns text
language sql volatile security definer set search_path = '' as $$
  update public.calendar_feed set token = replace(gen_random_uuid()::text, '-', '')
  where user_id = auth.uid() returning token
$$;
revoke all on function public.reset_calendar_link() from public, anon;
grant execute on function public.reset_calendar_link() to authenticated;
