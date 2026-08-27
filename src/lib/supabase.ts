import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
      'Copy .env.example to .env and fill both in.',
  )
}

export const supabase = createClient(url, anonKey, {
  auth: {
    // The whole resume story rests on this: the anonymous JWT lives
    // in localStorage, so auth.uid() is stable across reloads, tab
    // kills and backgrounding (PLAN.md §9).
    persistSession: true,
    autoRefreshToken: true,
    // No magic links or OAuth redirects anywhere in this app.
    detectSessionInUrl: false,
  },
})
