import type { SupabaseClient } from '@supabase/supabase-js';

const SOURCE_BUCKET = 'project-files';

export type StoredSourceRow = {
  id: string;
  owner_id: string;
  project_id: string;
  recording_id: string | null;
  scope: 'project' | 'recording';
  kind: 'audio' | 'document';
  original_name: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number;
  duration_seconds: number | null;
  source_payload: Record<string, unknown>;
  created_at: string;
};

export type StoredTranscriptRow = {
  recording_id: string;
  project_id: string;
  meeting_id: string;
  intermediate_json: Record<string, unknown>;
  segments: unknown[];
};

type UploadSourceInput = {
  client: SupabaseClient;
  userId: string;
  projectId: string;
  sourceId: string;
  recordingId?: string;
  scope: 'project' | 'recording';
  kind: 'audio' | 'document';
  file: Blob;
  fileName: string;
  mimeType?: string;
  durationSeconds?: number;
  sourcePayload: Record<string, unknown>;
};

const safePathPart = (value: string) => (
  value.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'file'
);

export const uploadProjectSource = async ({
  client,
  userId,
  projectId,
  sourceId,
  recordingId,
  scope,
  kind,
  file,
  fileName,
  mimeType,
  durationSeconds,
  sourcePayload,
}: UploadSourceInput): Promise<StoredSourceRow> => {
  const scopePath = scope === 'recording' && recordingId
    ? `recordings/${safePathPart(recordingId)}`
    : 'project';
  const storagePath = `${userId}/${safePathPart(projectId)}/${scopePath}/${safePathPart(sourceId)}-${safePathPart(fileName)}`;
  const contentType = mimeType || file.type || 'application/octet-stream';
  const { error: uploadError } = await client.storage
    .from(SOURCE_BUCKET)
    .upload(storagePath, file, { contentType, upsert: true });
  if (uploadError) throw uploadError;

  const row = {
    id: sourceId,
    owner_id: userId,
    project_id: projectId,
    recording_id: recordingId ?? null,
    scope,
    kind,
    original_name: fileName,
    storage_path: storagePath,
    mime_type: contentType,
    size_bytes: file.size,
    duration_seconds: durationSeconds ?? null,
    source_payload: sourcePayload,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await client
    .from('project_sources')
    .upsert(row, { onConflict: 'id' })
    .select('*')
    .single<StoredSourceRow>();
  if (error) {
    await client.storage.from(SOURCE_BUCKET).remove([storagePath]);
    throw error;
  }
  return data;
};

export const saveRecordingTranscript = async ({
  client,
  userId,
  projectId,
  recordingId,
  meetingId,
  intermediateJson,
  segments,
}: {
  client: SupabaseClient;
  userId: string;
  projectId: string;
  recordingId: string;
  meetingId: string;
  intermediateJson: Record<string, unknown>;
  segments: unknown[];
}) => {
  const { error } = await client.from('recording_transcripts').upsert({
    recording_id: recordingId,
    owner_id: userId,
    project_id: projectId,
    meeting_id: meetingId,
    intermediate_json: intermediateJson,
    segments,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'recording_id' });
  if (error) throw error;
};

export const loadStoredProjectWorkspace = async (client: SupabaseClient, projectId: string) => {
  const [{ data: sources, error: sourceError }, { data: transcripts, error: transcriptError }] = await Promise.all([
    client.from('project_sources').select('*').eq('project_id', projectId).order('created_at', { ascending: false }),
    client.from('recording_transcripts').select('*').eq('project_id', projectId),
  ]);
  if (sourceError) throw sourceError;
  if (transcriptError) throw transcriptError;

  const rows = (sources ?? []) as StoredSourceRow[];
  const audioPaths = rows.filter((row) => row.kind === 'audio').map((row) => row.storage_path);
  const signedUrls = new Map<string, string>();
  if (audioPaths.length > 0) {
    const { data, error } = await client.storage.from(SOURCE_BUCKET).createSignedUrls(audioPaths, 60 * 60);
    if (error) throw error;
    data.forEach((entry, index) => {
      if (entry.signedUrl) signedUrls.set(audioPaths[index], entry.signedUrl);
    });
  }
  return {
    sources: rows,
    transcripts: (transcripts ?? []) as StoredTranscriptRow[],
    signedUrls,
  };
};

export const downloadProjectSource = async (client: SupabaseClient, storagePath: string) => {
  const { data, error } = await client.storage.from(SOURCE_BUCKET).download(storagePath);
  if (error) throw error;
  return data;
};

export const deleteProjectSource = async (
  client: SupabaseClient,
  sourceId: string,
  storagePath?: string,
  recordingId?: string,
) => {
  let storagePaths = storagePath ? [storagePath] : [];
  if (recordingId) {
    const { data, error } = await client
      .from('project_sources')
      .select('storage_path')
      .eq('recording_id', recordingId);
    if (error) throw error;
    storagePaths = (data ?? []).map((row) => row.storage_path as string);
  }
  if (storagePaths.length > 0) {
    const { error } = await client.storage.from(SOURCE_BUCKET).remove(storagePaths);
    if (error) throw error;
  }
  const deleteQuery = client.from('project_sources').delete();
  const { error } = recordingId
    ? await deleteQuery.eq('recording_id', recordingId)
    : await deleteQuery.eq('id', sourceId);
  if (error) throw error;
};

export const updateProjectSourcePayload = async (
  client: SupabaseClient,
  sourceId: string,
  sourcePayload: Record<string, unknown>,
) => {
  const { error } = await client.from('project_sources').update({
    source_payload: sourcePayload,
    updated_at: new Date().toISOString(),
  }).eq('id', sourceId);
  if (error) throw error;
};

export const updateStoredTranscriptSegments = async (
  client: SupabaseClient,
  recordingId: string,
  segments: unknown[],
) => {
  const { error } = await client.from('recording_transcripts').update({
    segments,
    updated_at: new Date().toISOString(),
  }).eq('recording_id', recordingId);
  if (error) throw error;
};
