do $$
begin
  if to_regclass('public.chunks') is not null then
    alter table public.chunks drop constraint if exists chunks_pkey;
    alter table public.chunks
      add constraint chunks_pkey primary key (project_id, chunk_id);
  end if;
end
$$;
