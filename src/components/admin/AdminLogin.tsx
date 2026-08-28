import { useState } from 'react'

import { supabase } from '../../lib/supabase'
import { Screen } from '../Screen'

/**
 * Ordinary email and password. There is no signup route: the admin user
 * is created by hand in the dashboard and matched by a row in admins.
 *
 * The route is not secret and does not need to be — the anon key is
 * public by design, so RLS is the only thing that actually stops a
 * write. A hardcoded frontend password or an unguessable URL would stop
 * nothing (PLAN.md §7).
 */
export function AdminLogin() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })

    // On success the auth listener swaps this screen out, so there is no
    // success branch to write here.
    if (signInError) {
      setError(signInError.message)
      setBusy(false)
    }
  }

  const ready = email.trim() !== '' && password !== ''

  return (
    <Screen>
      <form onSubmit={submit} className="flex flex-1 flex-col justify-center gap-5">
        <div>
          <div className="eyebrow eyebrow--label">Movie Match</div>
          <h1 className="t-lg mt-3">Pool admin</h1>
        </div>

        {error ? <div className="banner">{error}</div> : null}

        <label className="field">
          <span className="lab">Email</span>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        </label>

        <label className="field">
          <span className="lab">Password</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        <button
          type="submit"
          className={`btn ${ready && !busy ? 'btn--primary' : 'btn--off'} mt-2`}
          disabled={!ready || busy}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </Screen>
  )
}
