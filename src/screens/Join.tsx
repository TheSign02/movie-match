import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { CODE_LENGTH, CodeInput } from '../components/CodeInput'
import { Screen } from '../components/Screen'
import { joinSession, savedName } from '../lib/session'
import { usePlayerSession } from '../lib/usePlayerSession'

/**
 * Frame 01b. Name and code, both required — player 2 sets their name
 * here, player 1 set theirs on Home.
 *
 * A shared link arrives as /join?code=K7R9, so the code starts filled
 * and only the name is left to type.
 */
export function Join() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { loading, error: authError } = usePlayerSession()

  const [name, setName] = useState(savedName)
  const [code, setCode] = useState(() =>
    (params.get('code') ?? '')
      .toUpperCase()
      .replace(/[^A-Z2-9]/g, '')
      .slice(0, CODE_LENGTH),
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
          Whoever made the lobby will see your name, so use whatever they&rsquo;d recognise.
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

        <label className="field">
          <span className="lab">Your name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Márta"
            autoComplete="nickname"
            maxLength={24}
            aria-label="Your name"
          />
        </label>

        <div className="field">
          <span className="lab">Lobby code</span>
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
