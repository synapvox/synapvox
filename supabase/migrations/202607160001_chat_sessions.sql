create table if not exists public.chat_sessions (
  id text primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  title text not null default '새 대화',
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_sessions_messages_array check (jsonb_typeof(messages) = 'array')
);

create index if not exists chat_sessions_owner_project_idx
  on public.chat_sessions (owner_id, project_id, updated_at desc);

alter table public.chat_sessions enable row level security;

drop policy if exists "Users manage own chat sessions" on public.chat_sessions;
create policy "Users manage own chat sessions"
on public.chat_sessions
for all
to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);
