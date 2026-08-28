import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { Screen } from '../components/Screen'
import { supabase } from '../lib/supabase'
import {
  fetchPlayers,
  fetchSessionByCode,
  fetchSessionById,
  rememberSession,
  resolveRoute,
  startSession,
  type GameSession,
  type Player,
} from '../lib/session'
import { usePlayerSession } from '../lib/usePlayerSession'

/** How often to re-check the lobby if a realtime event never lands. */
const POLL_MS = 3000

/** Frames 02 and 02b. */
export function Lobby() {
  const navigate = useNavigate()
  const { code = '' } = useParams()
  const { session: auth, loading: authLoading } = usePlayerSession()

  const [game, setGame] = useState<GameSession | null>(null)
  const [players, setPlayers] = useState<Player[]>([])
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(true)

  const userId = auth?.user.id ?? null

  // Derived here rather than after the loading guard, because the poll
  // effect below needs it and hooks cannot live behind an early return.
  const bothIn = players.length >= 2

  /* ─── first load ────────────────────────────────────────────────── */

  useEffect(() => {
    if (!userId) return
    let cancelled = false

    async function load() {
      try {
        // RLS filters this to sessions the caller is in, so a null row
        // means "not a participant" as much as "no such code".
        const found = await fetchSessionByCode(code)
        if (cancelled) return

        if (!found) {
          navigate('/', { replace: true })
          return
        }

        // Reopening a lobby link after the round started belongs
        // wherever the round actually is.
        if (found.status !== 'waiting') {
          navigate(await resolveRoute(found.id, userId!), { replace: true })
          return
        }

        rememberSession(found.id)
        setGame(found)
        setPlayers(await fetchPlayers(found.id))
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [code, userId, navigate])

  /* ─── realtime, plus a poll behind it ───────────────────────────── */

  const sessionId = game?.id ?? null

  /** Applied by both the subscription and the poll. */
  const refresh = useCallback(async () => {
    if (!sessionId) return
    try {
      const [rows, current] = await Promise.all([
        fetchPlayers(sessionId),
        fetchSessionById(sessionId),
      ])
      setPlayers(rows)
      if (current?.status === 'swiping') navigate(`/swipe/${sessionId}`)
    } catch {
      /* a failed poll is not worth a banner; the next one will do */
    }
  }, [sessionId, navigate])

  useEffect(() => {
    if (!sessionId) return

    const channel = supabase
      .channel(`lobby:${sessionId}`)
      // Player 2 arriving. Refetch rather than trusting the payload:
      // one round trip, and the row order stays canonical.
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'players',
          filter: `session_id=eq.${sessionId}`,
        },
        () => {
          void refresh()
        },
      )
      // BUILD: §12 lists only the players subscription for the lobby,
      // but either player may press Start. Without this the one who
      // didn't press it sits in the lobby while the round is running.
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'sessions',
          filter: `id=eq.${sessionId}`,
        },
        (payload) => {
          const next = payload.new as GameSession
          if (next.status === 'swiping') navigate(`/swipe/${sessionId}`)
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [sessionId, navigate, refresh])

  /**
   * The safety net, and it is not paranoia: a postgres_changes event was
   * observed going missing twice while building this — the subscription
   * reported SUBSCRIBED, the partner joined, and nothing arrived. It was
   * not reproducible in isolation, so it cannot be designed around.
   *
   * Without this, a dropped event leaves someone staring at "Waiting for
   * player 2" while their partner is already sitting in the lobby, and
   * the only way out is a manual refresh. Realtime stays the fast path —
   * it lands in a few hundred milliseconds — and this guarantees the
   * screen is correct within a few seconds either way.
   *
   * Stops as soon as the lobby is full, so it never runs during a round.
   */
  useEffect(() => {
    if (!sessionId || bothIn) return
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [sessionId, bothIn, refresh])

  /* ─── actions ───────────────────────────────────────────────────── */

  const start = useCallback(async () => {
    if (!game) return
    setStarting(true)
    setError(null)
    try {
      await startSession(game.id)
      navigate(`/swipe/${game.id}`)
    } catch (err) {
      setError((err as Error).message)
      setStarting(false)
    }
  }, [game, navigate])

  const joinUrl = `${window.location.origin}/join?code=${code.toUpperCase()}`

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code.toUpperCase())
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setError('Could not reach the clipboard. The code is on screen.')
    }
  }

  async function shareLink() {
    // navigator.share needs a secure context, so it is absent over plain
    // http on the LAN — fall back to copying the link.
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Reel Consensus', text: `Lobby ${code}`, url: joinUrl })
        return
      } catch {
        return // a cancelled share sheet is not an error
      }
    }

    try {
      await navigator.clipboard.writeText(joinUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setError('Sharing is not available here. Read them the code instead.')
    }
  }

  /* ─── render ────────────────────────────────────────────────────── */

  if (authLoading || loading) {
    return (
      <Screen>
        <div className="flex flex-1 items-center justify-center">
          <p className="lede text-sm">Opening the lobby…</p>
        </div>
      </Screen>
    )
  }

  const me = players.find((p) => p.user_id === userId)

  return (
    <Screen>
      <div className={bothIn ? 'glow glow--ready' : 'glow glow--lobby'} />

      <div className="topbar">
        <button
          className="iconbtn"
          onClick={() => {
            rememberSession(null)
            navigate('/')
          }}
          aria-label="Leave the lobby"
        >
          ←
        </button>
        <div
          className={bothIn ? 'eyebrow eyebrow--accent' : 'eyebrow'}
          style={{ letterSpacing: '.16em' }}
        >
          {bothIn ? (
            <>
              <i />
              Both in
            </>
          ) : (
            'Lobby'
          )}
        </div>
        <div className="sp" />
      </div>

      <div className="pt-[52px] text-center">
        {bothIn ? (
          <div className="eyebrow" style={{ letterSpacing: '.2em' }}>
            Lobby
          </div>
        ) : null}

        <div className={`code ${bothIn ? 'mt-[18px]' : ''}`}>{code.toUpperCase()}</div>

        {bothIn ? (
          <p className="lede mt-5">Twenty films, same order for both of you.</p>
        ) : (
          <div className="mt-[26px] flex justify-center gap-2.5">
            <button className="btn btn--ghost btn--sm" onClick={() => void copyCode()}>
              {copied ? 'Copied' : 'Copy code'}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => void shareLink()}>
              Share link
            </button>
          </div>
        )}
      </div>

      <div className="push" />

      <div className="stack-v">
        {error ? (
          <div className="banner" role="alert">
            {error}
          </div>
        ) : null}

        {players.map((player) => (
          <div className="row" key={player.id}>
            <div className={player.slot === 2 ? 'avatar avatar--2' : 'avatar'}>
              {player.display_name.trim().charAt(0).toUpperCase()}
            </div>
            <div className="grow">
              <div className="who">
                {player.display_name} {player.user_id === userId ? <s>(you)</s> : null}
              </div>
              {!bothIn && player.id === me?.id ? <div className="sub sub--ok">Ready</div> : null}
            </div>
            {bothIn ? (
              <div style={{ fontSize: 18, color: 'var(--accent)' }} aria-label="ready">
                ✓
              </div>
            ) : null}
          </div>
        ))}

        {!bothIn ? (
          <div className="row row--empty">
            <div className="avatar avatar--none" />
            <div className="grow">
              <div className="who" style={{ color: 'var(--text-muted)', fontWeight: 600 }}>
                Waiting for player 2
              </div>
              <div className="sub" style={{ color: 'var(--text-faint)' }}>
                They just need the code
              </div>
            </div>
            <div className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
          </div>
        ) : null}

        <button
          className={`btn mt-1.5 ${bothIn && !starting ? 'btn--primary' : 'btn--off'}`}
          disabled={!bothIn || starting}
          onClick={() => void start()}
        >
          {starting ? 'Starting…' : 'Start swiping'}
        </button>
      </div>
    </Screen>
  )
}
