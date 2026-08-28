import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { Screen } from '../components/Screen'
import { fetchLikedCount } from '../lib/deck'
import { abandonRound } from '../lib/results'
import {
  fetchPlayers,
  fetchSessionById,
  resolveRoute,
  type Player,
} from '../lib/session'
import { supabase } from '../lib/supabase'
import { usePlayerSession } from '../lib/usePlayerSession'

/**
 * §9 calls this the one state with no exit and asks for an escape hatch
 * after roughly three minutes.
 */
const ESCAPE_AFTER_MS = 3 * 60 * 1000

/**
 * How often to re-check whether the round finished, in case the realtime
 * event never lands. Slower than the lobby's poll because this screen can
 * be open for minutes.
 */
const POLL_MS = 5000

/** Frame 04. */
export function Waiting() {
  const navigate = useNavigate()
  const { sessionId = '' } = useParams()
  const { session: auth, loading: authLoading } = usePlayerSession()

  const [players, setPlayers] = useState<Player[]>([])
  const [liked, setLiked] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [escapeOffered, setEscapeOffered] = useState(false)
  const [ending, setEnding] = useState(false)

  const userId = auth?.user.id ?? null

  /* ─── load ──────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!userId) return
    let cancelled = false

    async function load() {
      try {
        const session = await fetchSessionById(sessionId)
        if (cancelled) return

        if (!session) {
          navigate('/', { replace: true })
          return
        }

        // Already complete, or this player has not actually finished.
        const route = await resolveRoute(sessionId, userId!)
        if (cancelled) return
        if (route !== `/waiting/${sessionId}`) {
          navigate(route, { replace: true })
          return
        }

        const [rows, ownLikes] = await Promise.all([
          fetchPlayers(sessionId),
          // Own total only. There is no call here that could reveal the
          // partner's progress, which is the point of frame 04.
          fetchLikedCount(sessionId),
        ])
        if (cancelled) return

        setPlayers(rows)
        setLiked(ownLikes)
        setReady(true)
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [sessionId, userId, navigate])

  /* ─── realtime, plus a poll behind it ───────────────────────────── */

  const checkComplete = useCallback(async () => {
    try {
      const current = await fetchSessionById(sessionId)
      if (current?.status === 'complete') navigate(`/results/${sessionId}`, { replace: true })
    } catch {
      /* the next poll will do */
    }
  }, [sessionId, navigate])

  useEffect(() => {
    if (!ready) return

    const channel = supabase
      .channel(`waiting:${sessionId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` },
        (payload) => {
          if ((payload.new as { status: string }).status === 'complete') {
            navigate(`/results/${sessionId}`, { replace: true })
          }
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [ready, sessionId, navigate])

  /**
   * Same reasoning as the lobby's poll: a postgres_changes event was
   * seen going missing twice during the build, and this screen has no
   * other way out. A dropped event here would leave someone waiting
   * indefinitely on a round that had already finished — and, worse, the
   * escape hatch would then offer to end a round that was already over.
   */
  useEffect(() => {
    if (!ready) return
    const timer = window.setInterval(() => void checkComplete(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [ready, checkComplete])

  /* ─── the escape hatch ──────────────────────────────────────────── */

  useEffect(() => {
    if (!ready) return
    const timer = window.setTimeout(() => setEscapeOffered(true), ESCAPE_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [ready])

  const endRound = useCallback(async () => {
    setEnding(true)
    setError(null)
    try {
      await abandonRound(sessionId)
      navigate(`/results/${sessionId}`, { replace: true })
    } catch (err) {
      setError((err as Error).message)
      setEnding(false)
    }
  }, [sessionId, navigate])

  /* ─── render ────────────────────────────────────────────────────── */

  const partner = players.find((p) => p.user_id !== userId)

  if (authLoading || !ready) {
    return (
      <Screen>
        <div className="flex flex-1 items-center justify-center">
          <p className="lede text-sm">{error ?? 'One moment…'}</p>
        </div>
      </Screen>
    )
  }

  return (
    <Screen className="items-center" gutter="none">
      {/* No min-height here: Screen already owns the 100dvh, and a second
          one inside its safe-area padding would overflow the viewport. */}
      <div
        className="flex w-full flex-1 flex-col items-center"
        style={{ paddingLeft: 30, paddingRight: 30 }}
      >
        <div className="center-col">
          <div className="pulse" aria-hidden="true">
            <i />
            <i />
            <i />
            <b />
          </div>

          <h2 className="t-lg mt-11">
            That&rsquo;s your
            <br />
            twenty done.
          </h2>

          {/* Names the partner but uses they/their — their pronouns are
              not something the app has any way to know. */}
          <p className="lede lede--lg mt-4 max-w-[270px]">
            {partner ? `${partner.display_name} is` : 'Your partner is'} still swiping. Your
            matches unlock the moment they finish.
          </p>
        </div>

        <div className="stack-v w-full">
          {error ? (
            <div className="banner" role="alert">
              {error}
            </div>
          ) : null}

          <div className="note">
            You liked&nbsp;<b>{liked} films</b>
          </div>

          {escapeOffered ? (
            <>
              <p className="lede text-center text-sm">
                {partner ? `${partner.display_name} hasn't` : "They haven't"} come back. You can
                end the round and see what you matched on so far &mdash; they won&rsquo;t be able
                to keep swiping.
              </p>
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => void endRound()}
                disabled={ending}
              >
                {ending ? 'Ending…' : 'End the round now'}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </Screen>
  )
}
