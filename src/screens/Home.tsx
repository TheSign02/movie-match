import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { Screen } from '../components/Screen'
import {
  createSession,
  lastSessionId,
  rememberName,
  rememberSession,
  resolveRoute,
  savedName,
} from '../lib/session'
import { usePlayerSession } from '../lib/usePlayerSession'

/** Frame 01. Name entry and the two big targets. */
export function Home() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { session, loading, error: authError } = usePlayerSession()

  const [name, setName] = useState(savedName)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** Where a previous round left off, if it is still live. */
  const [rejoinTo, setRejoinTo] = useState<string | null>(null)

  useEffect(() => {
    const previous = lastSessionId()
    if (!previous || !session) return

    let cancelled = false

    resolveRoute(previous, session.user.id)
      .then((route) => {
        if (cancelled) return
        // resolveRoute answers '/' when the session is gone or this user
        // was never in it — a cleared storage jar, or a stale id.
        if (route === '/') rememberSession(null)
        else setRejoinTo(route)
      })
      .catch(() => {
        /* offering a rejoin is a nicety; never block the home screen */
      })

    return () => {
      cancelled = true
    }
  }, [session])

  async function create() {
    setBusy(true)
    setError(null)
    try {
      const { code } = await createSession(name)
      navigate(`/lobby/${code}`)
    } catch (err) {
      // The likely one by far: "pool has 12 films, need at least 20".
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const ready = name.trim() !== '' && !loading && !busy

  return (
    <Screen>
      <div className="glow glow--home" />

      <div className="pt-[46px]">
        <div className="eyebrow eyebrow--accent">
          <i />
          Movie night
        </div>
        <div className="wordmark mt-[22px]">
          Reel
          <br />
          Consensus
        </div>
        <p className="lede mt-4 max-w-[280px]">
          Both of you swipe the same twenty films. You only see the ones you both liked.
        </p>
      </div>

      <div className="push" />

      <div className="stack-v stack-v--lg">
        {authError ? (
          <div className="banner" role="alert">
            Could not start a player session: {authError}
          </div>
        ) : null}

        {error ? (
          <div className="banner" role="alert">
            {error}
          </div>
        ) : null}

        {rejoinTo ? (
          <button className="btn btn--ghost btn--sm" onClick={() => navigate(rejoinTo)}>
            Back to your round
          </button>
        ) : null}

        <label className="field">
          <span className="lab">Your name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            autoComplete="nickname"
            maxLength={24}
            aria-label="Your name"
          />
        </label>

        <button
          className={`btn ${ready ? 'btn--primary' : 'btn--off'}`}
          disabled={!ready}
          onClick={() => void create()}
        >
          {busy ? 'Dealing twenty…' : 'Create a lobby'}
        </button>

        <button
          className={`btn ${ready ? 'btn--ghost' : 'btn--off'}`}
          disabled={!ready}
          onClick={() => {
            // The name is only entered here now, so it has to be stored
            // before leaving — /join reads it rather than asking again,
            // and would bounce straight back without this.
            rememberName(name)
            const code = params.get('code')
            navigate(code ? `/join?code=${encodeURIComponent(code)}` : '/join')
          }}
        >
          Join a lobby
        </button>
      </div>
    </Screen>
  )
}
