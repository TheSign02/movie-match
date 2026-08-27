import { useEffect, useState } from 'react'

import { AdminLogin } from '../components/admin/AdminLogin'
import { PoolAdmin } from '../components/admin/PoolAdmin'
import { Screen } from '../components/Screen'
import { supabase } from '../lib/supabase'
import { isAnonymousSession, useAuth } from '../lib/useAuth'

/**
 * Frame 06. Three gates before the pool UI: a session, then admins
 * membership, then the screen itself.
 *
 * Membership is asked of the server rather than inferred from the
 * session, because the session proves who you are and nothing about what
 * you may write.
 */
export function Admin() {
  const { session, loading } = useAuth()
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null)

  useEffect(() => {
    if (!session) {
      setIsAdmin(null)
      return
    }

    let cancelled = false
    setIsAdmin(null)

    supabase.rpc('is_admin').then(({ data }) => {
      if (!cancelled) setIsAdmin(data === true)
    })

    return () => {
      cancelled = true
    }
  }, [session])

  if (loading) {
    return (
      <Screen>
        <div className="flex flex-1 items-center justify-center">
          <p className="lede text-sm">…</p>
        </div>
      </Screen>
    )
  }

  if (!session) return <AdminLogin />

  // A player who has already been given an anonymous session lands here
  // holding a perfectly valid JWT for the wrong identity. Saying so is
  // more use than a bare "not an admin".
  if (isAdmin === false) {
    const anonymous = isAnonymousSession(session)

    return (
      <Screen>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <h1 className="t-md">Not an admin.</h1>
          <p className="lede max-w-[300px] text-sm">
            {anonymous
              ? 'This browser is signed in as a player. Sign out to log in with the admin account.'
              : 'This account is signed in but has no row in admins.'}
          </p>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => void supabase.auth.signOut()}
          >
            Sign out
          </button>
        </div>
      </Screen>
    )
  }

  if (isAdmin === null) {
    return (
      <Screen>
        <div className="flex flex-1 items-center justify-center">
          <p className="lede text-sm">Checking access…</p>
        </div>
      </Screen>
    )
  }

  return <PoolAdmin />
}
