create extension if not exists pgcrypto;

insert into storage.buckets (id, name, public, file_size_limit)
values ('project-files', 'project-files', false, 524288000)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

create table if not exists public.project_sources (
  id text primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id text not null,
  recording_id text,
  scope text not null check (scope in ('project', 'recording')),
  kind text not null check (kind in ('audio', 'document')),
  original_name text not null,
  storage_path text not null unique,
  mime_type text,
  size_bytes bigint not null default 0,
  duration_seconds integer,
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.recording_transcripts (
  recording_id text primary key references public.project_sources(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id text not null,
  meeting_id text not null,
  intermediate_json jsonb not null default '{}'::jsonb,
  segments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_sources_owner_project_idx
  on public.project_sources (owner_id, project_id, created_at desc);
create index if not exists project_sources_recording_idx
  on public.project_sources (owner_id, project_id, recording_id)
  where recording_id is not null;
create index if not exists recording_transcripts_owner_project_idx
  on public.recording_transcripts (owner_id, project_id, created_at desc);

alter table public.project_sources enable row level security;
alter table public.recording_transcripts enable row level security;

drop policy if exists "Users manage own project sources" on public.project_sources;
create policy "Users manage own project sources"
on public.project_sources
for all
to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists "Users manage own recording transcripts" on public.recording_transcripts;
create policy "Users manage own recording transcripts"
on public.recording_transcripts
for all
to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists "Users read own project files" on storage.objects;
create policy "Users read own project files"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'project-files'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "Users upload own project files" on storage.objects;
create policy "Users upload own project files"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'project-files'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "Users update own project files" on storage.objects;
create policy "Users update own project files"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'project-files'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'project-files'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "Users delete own project files" on storage.objects;
create policy "Users delete own project files"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'project-files'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);
