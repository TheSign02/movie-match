import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { CODE_LENGTH, CodeInput } from '../components/CodeInput'
import { Screen } from '../components/Screen'
import { joinSession, savedName } from '../lib/session'
import { usePlayerSession } from '../lib/usePlayerSession'

/**
 * Frame 01b, minus the name field.
 *
 * The design has a name input here because it was drawn as a standalone
 * screen. In the built flow you can only arrive by typing a name on Home
 * and tapping "Join a lobby", so asking again is asking twice. The name
 * comes from storage and is shown, not re-entered.
 *
 * A shared link — /join?code=K7R9 — is the one way in that skips Home,
 * and it arrives with no stored name. That case goes to Home carrying
 * the code rather than growing a conditional second name field.
 */
export function Join() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { loading, error: authError } = usePlayerSession()

  const name = savedName()

  const [code, setCode] = useState(() =>
    (params.get('code') ?? '')
      .toUpperCase()
      .replace(/[^A-Z2-9]/g, '')
      .slice(0, CODE_LENGTH),
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Arrived by share link with nothing stored: Home has the name field.
  useEffect(() => {
    if (name.trim() !== '') return
    const incoming = params.get('code')
    navigate(incoming ? `/?code=${encodeURIComponent(incoming)}` : '/', { replace: true })
  }, [name, params, navigate])

  const ready = name.trim() !== '' && code.length === CODE_LENGTH && !loading && !busy

  async function join() {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await joinSession(code, name)
      navigate(`/lobby/${code}`)
    } catch (err) {
      // 'no lobby with that code', 'that lobby is full', 'that round has
      // already started' — all written to be shown as-is.
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Screen>
      <div className="topbar">
        <button className="iconbtn" onClick={() => navigate('/')} aria-label="Back">
          ←
        </button>
        <div className="eyebrow" style={{ letterSpacing: '.16em' }}>
          Join
        </div>
        <div className="sp" />
      </div>

      <div className="pt-10">
        <h2 className="t-md">Join a lobby</h2>
        <p className="lede mt-3.5 max-w-[290px]">
          Joining as <b style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{name}</b>.
          Whoever made the lobby will see that name.
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

        <div className="field">
          <span className="lab">Lobby code</span>
          {/* No auto-submit on the fourth character: onComplete fires
              from inside CodeInput's commit, before this component has
              re-rendered with the final character, so join() would read
              a three-character code and quietly do nothing. */}
          <CodeInput value={code} onChange={setCode} />
        </div>

        <button
          className={`btn ${ready ? 'btn--primary' : 'btn--off'}`}
          disabled={!ready}
          onClick={() => void join()}
        >
          {busy ? 'Joining…' : 'Join lobby'}
        </button>
      </div>
    </Screen>
  )
}
