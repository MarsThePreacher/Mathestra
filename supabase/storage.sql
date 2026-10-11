-- Mathestra: storage for imported audio clips.
-- Run once in the Supabase dashboard: SQL Editor, New query, paste, Run.
--
-- Files are public to read, so shared links and saved graphs can play them for
-- anyone. Each file's path starts with its owner's user id and ends with a hash
-- of its contents, so paths cannot be guessed, and only the owner can write.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('audio', 'audio', true, 26214400, array['audio/*'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "audio: upload own" on storage.objects;
create policy "audio: upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'audio' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "audio: replace own" on storage.objects;
create policy "audio: replace own" on storage.objects
  for update to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'audio' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "audio: delete own" on storage.objects;
create policy "audio: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Uploading with "upsert" also reads the existing object, so owners can read their own folder.
drop policy if exists "audio: read own" on storage.objects;
create policy "audio: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = (select auth.uid())::text);
