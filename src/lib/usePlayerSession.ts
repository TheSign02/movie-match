import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'

import { supabase } from './supabase'

type PlayerSessionState = {
  session: Session | null
  loading: boolean
  error: string | null
}

/**
 * Guarantees a session on the player side of the app, signing in
 * anonymously if there isn't one (PLAN.md §7).
 *
 * Deliberately not used by /admin. An anonymous sign-in there would
 * hand the admin a perfectly valid JWT for the wrong identity and then
 * tell them they are not an admin — so the admin route reads the
 * session and never creates one.
 *
 * An admin who is already signed in and opens a player route keeps that
 * session: auth.uid() is what the RPCs care about, and an admin is
 * allowed to play.
 */
export function usePlayerSession(): PlayerSessionState {
  const [state, setState] = useState<PlayerSessionState>({
    session: null,
    loading: true,
    error: null,
  })

  useEffect(() => {
    let cancelled = false

    async function ensure() {
      const { data } = await supabase.auth.getSession()
      if (cancelled) return

      if (data.session) {
        setState({ session: data.session, loading: false, error: null })
        return
      }

      const { data: signedIn, error } = await supabase.auth.signInAnonymously()
      if (cancelled) return

      if (error) {
        // Nearly always one thing: anonymous sign-ins are off in the
        // dashboard. Say so rather than showing an empty screen.
        setState({ session: null, loading: false, error: error.message })
        return
      }

      setState({ session: signedIn.session, loading: false, error: null })
    }

    void ensure()

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!cancelled && session) setState({ session, loading: false, error: null })
    })

    return () => {
      cancelled = true
      data.subscription.unsubscribe()
    }
  }, [])

  return state
}
