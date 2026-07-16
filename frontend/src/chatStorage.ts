import type { SupabaseClient } from '@supabase/supabase-js';

export type StoredChatMessage = {
  role: 'user' | 'assistant';
  text: string;
};

export type StoredChatSession = {
  id: string;
  title: string;
  messages: StoredChatMessage[];
  updatedAt: string;
};

const validMessages = (messages: unknown): StoredChatMessage[] => {
  if (!Array.isArray(messages)) return [];
  return messages.filter((message): message is StoredChatMessage => {
    if (message === null || typeof message !== 'object') return false;
    const candidate = message as Partial<StoredChatMessage>;
    return (candidate.role === 'user' || candidate.role === 'assistant')
      && typeof candidate.text === 'string';
  });
};

export const createChatSessionId = () => `chat-${crypto.randomUUID()}`;

export const loadProjectChats = async (
  client: SupabaseClient,
  projectId: string,
): Promise<StoredChatSession[]> => {
  const { data, error } = await client
    .from('chat_sessions')
    .select('id, title, messages, updated_at')
    .eq('project_id', projectId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: String(row.id),
    title: typeof row.title === 'string' && row.title.trim() ? row.title : '새 대화',
    messages: validMessages(row.messages),
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : new Date().toISOString(),
  }));
};

export const saveProjectChat = async (
  client: SupabaseClient,
  userId: string,
  projectId: string,
  chatId: string,
  messages: StoredChatMessage[],
) => {
  const firstQuestion = messages.find((message) => message.role === 'user')?.text.trim();
  const title = firstQuestion ? firstQuestion.slice(0, 60) : '새 대화';
  const updatedAt = new Date().toISOString();
  const { error } = await client.from('chat_sessions').upsert({
    id: chatId,
    owner_id: userId,
    project_id: projectId,
    title,
    messages,
    updated_at: updatedAt,
  }, { onConflict: 'id' });
  if (error) throw error;
  return { id: chatId, title, messages, updatedAt } satisfies StoredChatSession;
};

export const deleteProjectChat = async (
  client: SupabaseClient,
  chatId: string,
) => {
  const { error } = await client.from('chat_sessions').delete().eq('id', chatId);
  if (error) throw error;
};
