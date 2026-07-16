import type { SupabaseClient } from '@supabase/supabase-js';

export type StoredProjectRow = {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  status: string;
  recordings: number;
  materials: number;
  favorite: boolean;
  shared: boolean;
  trashed_at: string | null;
  created_at: string;
  updated_at: string;
};

export const loadStoredProjects = async (client: SupabaseClient): Promise<StoredProjectRow[]> => {
  const { data, error } = await client
    .from('projects')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as StoredProjectRow[];
};

export const createStoredProject = async (
  client: SupabaseClient,
  project: Pick<StoredProjectRow, 'id' | 'owner_id' | 'name' | 'description' | 'status'>,
): Promise<StoredProjectRow> => {
  const { data, error } = await client
    .from('projects')
    .insert(project)
    .select('*')
    .single<StoredProjectRow>();
  if (error) throw error;
  return data;
};

export const updateStoredProject = async (
  client: SupabaseClient,
  projectId: string,
  updates: Partial<Pick<StoredProjectRow, 'name' | 'description' | 'status' | 'recordings' | 'materials' | 'favorite' | 'shared'>>,
): Promise<StoredProjectRow> => {
  const { data, error } = await client
    .from('projects')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', projectId)
    .select('*')
    .single<StoredProjectRow>();
  if (error) throw error;
  return data;
};

export const removeStoredProjectFiles = async (
  client: SupabaseClient,
  storagePaths: string[],
) => {
  if (storagePaths.length === 0) return;
  const { error } = await client.storage.from('project-files').remove(storagePaths);
  if (error) throw error;
};
