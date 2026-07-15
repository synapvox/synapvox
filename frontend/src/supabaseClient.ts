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
