-- Mathestra: saved graphs.
-- Run once in the Supabase dashboard: SQL Editor → New query → paste → Run.

create table if not exists public.graphs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default 'Untitled' check (char_length(title) <= 200),
  -- The whole piece, encoded exactly like a share link (deflate + base64url).
  data text not null constraint graphs_data_check check (char_length(data) <= 5000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists graphs_user_updated on public.graphs (user_id, updated_at desc);

-- Keep updated_at honest on every edit.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists graphs_touch on public.graphs;
create trigger graphs_touch
  before update on public.graphs
  for each row execute function public.touch_updated_at();

-- Row level security: every user sees and edits only their own graphs.
alter table public.graphs enable row level security;

drop policy if exists "graphs: read own" on public.graphs;
create policy "graphs: read own" on public.graphs
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "graphs: insert own" on public.graphs;
create policy "graphs: insert own" on public.graphs
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "graphs: update own" on public.graphs;
create policy "graphs: update own" on public.graphs
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "graphs: delete own" on public.graphs;
create policy "graphs: delete own" on public.graphs
  for delete to authenticated using ((select auth.uid()) = user_id);
