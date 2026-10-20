-- The Planner: PDF attachments on trips (Trip → Attachments → + Upload file).
-- Run once in Supabase → SQL Editor → New query → paste this file → Run. Safe to run again.
--
-- Each PDF is saved in a private storage bucket, in a folder named after your account id,
-- so it opens on all your devices. Only you can read, add or remove files in your folder.
-- There are no public links. Files are limited to 10 MB and must be PDFs.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 10485760, array['application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "own attachments: select" on storage.objects;
drop policy if exists "own attachments: insert" on storage.objects;
drop policy if exists "own attachments: update" on storage.objects;
drop policy if exists "own attachments: delete" on storage.objects;

create policy "own attachments: select" on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own attachments: insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own attachments: update" on storage.objects for update to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own attachments: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
