import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const hasSupabaseConfig = (
  typeof supabaseUrl === 'string'
  && supabaseUrl.length > 0
  && !supabaseUrl.includes('{project-ref}')
  && typeof supabaseAnonKey === 'string'
  && supabaseAnonKey.length > 0
  && !supabaseAnonKey.startsWith('replace-with-')
);

export const supabase = hasSupabaseConfig
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

export const requireSupabase = () => {
  if (supabase === null) {
    throw new Error('로그인 설정을 확인하고 있습니다. 잠시 후 다시 시도해주세요.');
  }
  return supabase;
};
