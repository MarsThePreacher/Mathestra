-- Mathestra: allow larger saved graphs (pieces built from long data lists, such as a song).
-- Raises the per-graph limit from 500,000 to 5,000,000 characters of encoded data.
-- Run once in the Supabase dashboard: SQL Editor, New query, paste, Run.

alter table public.graphs drop constraint if exists graphs_data_check;
alter table public.graphs add constraint graphs_data_check check (char_length(data) <= 5000000);
