create table if not exists public.projects (
  id text primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  description text not null default '',
  status text not null default '자료 필요',
  recordings integer not null default 0 check (recordings >= 0),
  materials integer not null default 0 check (materials >= 0),
  favorite boolean not null default false,
  shared boolean not null default false,
  trashed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists projects_owner_updated_idx
  on public.projects (owner_id, updated_at desc);
create index if not exists projects_owner_trash_idx
  on public.projects (owner_id, trashed_at)
  where trashed_at is not null;

alter table public.projects enable row level security;

drop policy if exists "Users manage own projects" on public.projects;
create policy "Users manage own projects"
on public.projects
for all
to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);
