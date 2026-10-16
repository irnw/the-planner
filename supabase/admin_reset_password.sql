-- The Planner (admin): help someone who forgot their password.
-- Run step by step in Supabase → SQL Editor (select a block, then Run).

-- 1) See recent requests
select id, email, note, created_at, handled
from public.password_help
order by created_at desc
limit 20;

-- 2) Set a temporary password for that account. Edit BOTH values, then run.
--    Pick something only you and they will know (at least 10 characters), send it to them
--    privately, and ask them to change it in Settings → Your Account → Change Password.
update auth.users
set encrypted_password = extensions.crypt('Temporary-Password-Here', extensions.gen_salt('bf')),
    updated_at = now()
where email = lower('person@example.com');

-- 3) Mark the request as handled
update public.password_help set handled = true where email = lower('person@example.com');
