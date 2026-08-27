import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'

import { supabase } from './supabase'

type AuthState = {
  session: Session | null
  /** True until the persisted session has been read off localStorage. */
  loading: boolean
}

/**
 * The current session, kept in sync.
 *
 * getSession is deliberately the first read rather than getUser: it
 * comes straight from localStorage with no network round trip, which is
 * what makes a reload land on the right screen immediately instead of
 * flashing the home screen first.
 */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ session: null, loading: true })

  useEffect(() => {
    let cancelled = false

    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setState({ session: data.session, loading: false })
    })

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!cancelled) setState({ session, loading: false })
    })

    return () => {
      cancelled = true
      data.subscription.unsubscribe()
    }
  }, [])

  return state
}

/** True for a session created by signInAnonymously. */
export function isAnonymousSession(session: Session | null): boolean {
  return session?.user?.is_anonymous === true
}
