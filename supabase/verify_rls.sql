-- Holiday Tracker: check that accounts can't see each other's data.
-- Run in Supabase → SQL Editor → New query → paste → Run. Changes nothing permanently:
-- it creates two throwaway users, tests as each of them, then deletes them.
-- Expected result: one row reading "PASS: ..." (anything else means something is wrong).
do $$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  seen int; changed int; foreign_seen int; ins_ok boolean := false;
  report text;
begin
  insert into auth.users (id, email, aud, role) values
    (a, 'rls-check-a-' || a || '@example.invalid', 'authenticated', 'authenticated'),
    (b, 'rls-check-b-' || b || '@example.invalid', 'authenticated', 'authenticated');
  insert into public.user_data (user_id, data) values (a, '{"owner":"A"}'), (b, '{"owner":"B"}');

  -- Act as user A
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', a::text, true);
  execute 'set local role authenticated';

  select count(*) into seen from public.user_data;                          -- should be 1 (own row)
  select count(*) into foreign_seen from public.user_data where user_id = b; -- should be 0
  update public.user_data set data = '{"owner":"hacked"}' where user_id = b;
  get diagnostics changed = row_count;                                       -- should be 0
  begin
    insert into public.user_data (user_id, data) values (gen_random_uuid(), '{}');
    ins_ok := true;                                                          -- should NOT happen
  exception when others then ins_ok := false;
  end;

  execute 'reset role';
  -- B's row must be untouched
  if (select data->>'owner' from public.user_data where user_id = b) <> 'B' then changed := changed + 1000; end if;

  delete from auth.users where id in (a, b);   -- cascades to their user_data rows

  report := case when seen = 1 and foreign_seen = 0 and changed = 0 and not ins_ok
    then 'PASS: each account sees only its own data (own rows=1, other''s rows=0, other''s rows changed=0, foreign insert blocked)'
    else format('FAIL: own rows=%s (want 1), other''s rows seen=%s (want 0), other''s rows changed=%s (want 0), foreign insert allowed=%s (want false)', seen, foreign_seen, changed, ins_ok) end;
  perform set_config('rls_check.result', report, false);
end $$;
select current_setting('rls_check.result') as result;
