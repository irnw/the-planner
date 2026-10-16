-- The Planner: "Forgot password?" requests, emailed to the admin through Resend.
-- Run once in Supabase → SQL Editor → New query → paste this file → Run. Safe to run again.
-- Then store your Resend key and your email in the Vault (see the bottom of this file).

create extension if not exists pg_net;

-- Requests from the app. Anyone may submit one; nobody can read them through the app
-- (only you, in the Supabase dashboard / SQL Editor).
create table if not exists public.password_help (
  id         bigint generated always as identity primary key,
  email      text not null,
  note       text,
  created_at timestamptz not null default now(),
  handled    boolean not null default false,
  constraint password_help_email_len check (char_length(email) between 3 and 254),
  constraint password_help_note_len  check (note is null or char_length(note) <= 500)
);
alter table public.password_help enable row level security;
alter table public.password_help force row level security;
revoke all on public.password_help from anon, authenticated;
grant insert (email, note) on public.password_help to anon, authenticated;
drop policy if exists "anyone can ask for help" on public.password_help;
create policy "anyone can ask for help" on public.password_help for insert to anon, authenticated with check (true);

-- Email the admin about each new request (at most 5 emails an hour; every request is still saved).
create or replace function public.password_help_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare k text; to_addr text; recent int;
begin
  select decrypted_secret into k       from vault.decrypted_secrets where name = 'resend_api_key' limit 1;
  select decrypted_secret into to_addr from vault.decrypted_secrets where name = 'admin_email'    limit 1;
  if k is null or to_addr is null then return new; end if;
  select count(*) into recent from public.password_help where created_at > now() - interval '1 hour';
  if recent > 5 then return new; end if;
  perform net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || k, 'Content-Type', 'application/json'),
    body    := jsonb_build_object(
      'from',    'The Planner <onboarding@resend.dev>',
      'to',      jsonb_build_array(to_addr),
      'subject', 'The Planner: password help for ' || new.email,
      'text',    'Someone asked for help signing in to The Planner.' || chr(10) || chr(10)
              || 'Account email: ' || new.email || chr(10)
              || 'Note: ' || coalesce(nullif(new.note, ''), '(none)') || chr(10)
              || 'Requested: ' || to_char(new.created_at at time zone 'Asia/Singapore', 'DD Mon YYYY, HH24:MI') || ' (Singapore time)' || chr(10) || chr(10)
              || 'To help: check it is really them, then set a temporary password with supabase/admin_reset_password.sql '
              || 'in the Supabase SQL Editor, send it to them, and ask them to change it in Settings → Your Account.'
    )
  );
  return new;
end $$;
revoke all on function public.password_help_notify() from public, anon, authenticated;

drop trigger if exists password_help_notify on public.password_help;
create trigger password_help_notify after insert on public.password_help
  for each row execute function public.password_help_notify();

-- ───────────────────────────────────────────────────────────────────────────────
-- ONE-TIME: store your Resend key and your email (encrypted in Supabase Vault).
-- Replace the two values, then run just these two lines (select them and press Run).
--   • The key: resend.com → API Keys → Create API key (permission: "Sending access").
--   • The email: without your own domain, Resend can only send to the address your
--     Resend account was registered with, so use that address.
--
-- select vault.create_secret('re_PASTE_YOUR_KEY_HERE', 'resend_api_key');
-- select vault.create_secret('you@example.com', 'admin_email');
--
-- To change one later:  select vault.update_secret((select id from vault.secrets where name = 'admin_email'), 'new@example.com');
-- To test: submit "Forgot password?" in the app, then check delivery with:
--   select status_code, content from net._http_response order by created desc limit 3;
