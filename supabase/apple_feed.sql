-- Holiday Tracker: fetch each user's published Apple Calendar every 10 minutes, inside Supabase.
-- Replaces the GitHub Actions job (GitHub often skips scheduled runs for hours).
-- Run once in Supabase → SQL Editor → New query → paste this file → Run. Safe to run again.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Latest copy of each user's Apple Calendar. Users can only read their own row; only the
-- scheduled jobs below write to it.
create table if not exists public.apple_feed (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  ics          text,
  fetched_at   timestamptz,
  request_id   bigint,
  requested_at timestamptz,
  last_error   text
);
alter table public.apple_feed enable row level security;
alter table public.apple_feed force row level security;
revoke all on public.apple_feed from anon, authenticated;
grant select on public.apple_feed to authenticated;
drop policy if exists "own row: select" on public.apple_feed;
create policy "own row: select" on public.apple_feed for select to authenticated
  using ((select auth.uid()) = user_id);

-- Step 1 (every 10 min): ask for each user's calendar. Only Apple's published-calendar
-- addresses are fetched, so the database can't be pointed at anything else.
create or replace function public.apple_feed_request() returns void
language plpgsql security definer set search_path = '' as $$
declare r record; u text;
begin
  for r in select d.user_id, d.data->>'appleCalUrl' as url from public.user_data d
           where coalesce(d.data->>'appleCalUrl', '') <> '' loop
    u := regexp_replace(trim(r.url), '^webcal://', 'https://', 'i');
    if u !~* '^https://p[0-9]+-caldav\.icloud\.com(:443)?/published/[A-Za-z0-9_/=-]+$' then
      insert into public.apple_feed (user_id, last_error) values (r.user_id, 'Not an Apple published-calendar link')
      on conflict (user_id) do update set last_error = excluded.last_error;
      continue;
    end if;
    insert into public.apple_feed (user_id, request_id, requested_at)
    values (r.user_id, net.http_get(url := u, timeout_milliseconds := 30000), now())
    on conflict (user_id) do update set request_id = excluded.request_id, requested_at = excluded.requested_at;
  end loop;
end $$;

-- Step 2 (a few minutes later): store the answers that came back.
create or replace function public.apple_feed_collect() returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.apple_feed f
     set ics = resp.content, fetched_at = now(), last_error = null
    from net._http_response resp
   where resp.id = f.request_id and resp.status_code = 200
     and left(resp.content, 15) = 'BEGIN:VCALENDAR'
     and f.ics is distinct from resp.content;
  update public.apple_feed f
     set fetched_at = now(), last_error = null
    from net._http_response resp
   where resp.id = f.request_id and resp.status_code = 200
     and left(resp.content, 15) = 'BEGIN:VCALENDAR' and f.ics = resp.content;
  update public.apple_feed f
     set last_error = coalesce(resp.error_msg, 'HTTP ' || resp.status_code)
    from net._http_response resp
   where resp.id = f.request_id
     and (resp.status_code is distinct from 200 or left(coalesce(resp.content, ''), 15) <> 'BEGIN:VCALENDAR');
end $$;

revoke all on function public.apple_feed_request() from public, anon, authenticated;
revoke all on function public.apple_feed_collect() from public, anon, authenticated;

-- Schedules (re-running this file updates them instead of adding duplicates)
select cron.schedule('apple-feed-request', '*/10 * * * *', 'select public.apple_feed_request()');
select cron.schedule('apple-feed-collect', '3-59/10 * * * *', 'select public.apple_feed_collect()');

-- Fetch once right now so you don't wait for the first scheduled run
select public.apple_feed_request();
