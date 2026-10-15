-- Holiday Tracker: per-user data storage
-- Run once in Supabase → SQL Editor → New query → paste this file → Run.
-- Safe to run again: every statement is idempotent.

-- One row per account holding that user's tracker data (events, leave, rates…).
create table if not exists public.user_data (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  data         jsonb  not null default '{}'::jsonb,
  -- Client-side "lastModified" (ms since epoch) used for newest-wins merging between devices
  modified_ms  bigint not null default 0,
  updated_at   timestamptz not null default now(),
  -- Keep one account from filling the free-tier database (current data is ~0.4 MB)
  constraint user_data_size check (pg_column_size(data) < 20 * 1024 * 1024)
);

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists user_data_touch on public.user_data;
create trigger user_data_touch before update on public.user_data
  for each row execute function public.touch_updated_at();

-- Row Level Security: the database itself only lets a signed-in user see and change
-- their own row. Requests without a session (the public "anon" key) get nothing.
alter table public.user_data enable row level security;
alter table public.user_data force row level security;

revoke all on public.user_data from anon;
grant select, insert, update, delete on public.user_data to authenticated;

drop policy if exists "own row: select" on public.user_data;
drop policy if exists "own row: insert" on public.user_data;
drop policy if exists "own row: update" on public.user_data;
drop policy if exists "own row: delete" on public.user_data;
create policy "own row: select" on public.user_data for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "own row: insert" on public.user_data for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "own row: update" on public.user_data for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own row: delete" on public.user_data for delete to authenticated
  using ((select auth.uid()) = user_id);

-- "Delete my account" in Settings: removes the caller's login and (via cascade) their data.
-- Runs with elevated rights but can only ever delete the caller's own account.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from auth.users where id = auth.uid();
end $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
