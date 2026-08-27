import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { Screen } from '../components/Screen'
import { fetchLikedCounts, fetchMatches, type LikedCount, type Match } from '../lib/results'
import {
  createSession,
  fetchMyPlayer,
  fetchSessionById,
  rememberSession,
  resolveRoute,
  savedName,
} from '../lib/session'
import { posterUrl } from '../lib/tmdb'
import { usePlayerSession } from '../lib/usePlayerSession'

/** Frames 05 and 05b. */
export function Results() {
  const navigate = useNavigate()
  const { sessionId = '' } = useParams()
  const { session: auth, loading: authLoading } = usePlayerSession()

  const [matches, setMatches] = useState<Match[] | null>(null)
  const [counts, setCounts] = useState<LikedCount[]>([])
  const [deckSize, setDeckSize] = useState(20)
  /** Needed to say "You liked N" rather than matching on display name. */
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const userId = auth?.user.id ?? null

  useEffect(() => {
    if (!userId) return
    let cancelled = false

    async function load() {
      try {
        const route = await resolveRoute(sessionId, userId!)
        if (cancelled) return
        if (route !== `/results/${sessionId}`) {
          navigate(route, { replace: true })
          return
        }

        const session = await fetchSessionById(sessionId)
        if (cancelled) return
        if (session) setDeckSize(session.movie_ids.length)

        const found = await fetchMatches(sessionId)
        if (cancelled) return
        setMatches(found)

        // Only needed for the no-overlap screen, which names both
        // totals. Skipped otherwise rather than fetched and ignored.
        if (found.length === 0) {
          const [totals, me] = await Promise.all([
            fetchLikedCounts(sessionId),
            fetchMyPlayer(sessionId, userId!),
          ])
          if (cancelled) return
          setCounts(totals)
          setMyPlayerId(me?.id ?? null)
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [sessionId, userId, navigate])

  /**
   * Another round is a new session with a new deck, so the partner
   * joins again with the new code. Both players tapping this makes two
   * lobbies; whoever shares their code first wins, and the other is
   * abandoned harmlessly.
   */
  const again = useCallback(async () => {
    setStarting(true)
    setError(null)
    try {
      rememberSession(null)
      const { code } = await createSession(savedName() || 'Player 1')
      navigate(`/lobby/${code}`)
    } catch (err) {
      setError((err as Error).message)
      setStarting(false)
    }
  }, [navigate])

  if (authLoading || matches === null) {
    return (
      <Screen>
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <p className="lede text-sm">{error ?? 'Counting up…'}</p>
        </div>
      </Screen>
    )
  }

  /* ─── 05b · no overlap ──────────────────────────────────────────── */

  if (matches.length === 0) {
    const mine = counts.find((c) => c.player_id === myPlayerId)
    const theirs = counts.find((c) => c.player_id !== myPlayerId)

    return (
      <Screen>
        <div className="flex flex-1 flex-col justify-center">
          <div className="pair" aria-hidden="true">
            <i />
            <i />
          </div>

          <h2 className="t-xl mt-[34px]">
            No overlap
            <br />
            this round.
          </h2>

          {/* Totals only, never which films — that distinction is the
              whole privacy model. */}
          <p className="lede lede--lg mt-4 max-w-[290px]">
            {mine && theirs
              ? `You liked ${mine.liked}, ${theirs.display_name} liked ${theirs.liked}, none the same. `
              : ''}
            It happens. The next twenty are already picked out.
          </p>
        </div>

        <div className="stack-v">
          {error ? (
            <div className="banner" role="alert">
              {error}
            </div>
          ) : null}
          <button
            className={`btn ${starting ? 'btn--off' : 'btn--primary'}`}
            onClick={() => void again()}
            disabled={starting}
          >
            {starting ? 'Dealing…' : 'Swipe another twenty'}
          </button>
        </div>
      </Screen>
    )
  }

  /* ─── 05 · matches ──────────────────────────────────────────────── */

  return (
    <Screen gutter="none">
      <div className="glow glow--top" />

      <div className="results-head">
        <div className="eyebrow eyebrow--accent" style={{ letterSpacing: '.2em' }}>
          <i />
          You agreed on
        </div>
        <div className="figure mt-2.5">
          {matches.length} film{matches.length === 1 ? '' : 's'}
        </div>
        <p className="lede mt-2.5">
          Out of {deckSize}
          {matches.length >= 4 ? ' · that’s a good night.' : ''}
        </p>
      </div>

      {error ? (
        <div className="banner mx-6 mb-3" role="alert">
          {error}
        </div>
      ) : null}

      {/* No footer bar: the "decide together" button was cut, so the grid
          runs to the bottom edge. */}
      <div className="results-grid">
        {matches.map((match) => {
          const poster = posterUrl(match.poster_path, 'w500')
          return (
            <div className="tile" key={match.movie_id}>
              {poster ? (
                <img className="tile__art" src={poster} alt="" loading="lazy" />
              ) : (
                <div className="tile__art" style={{ background: 'var(--bg-raised)' }} />
              )}
              <div className="tile__meta">
                <div className="tile__title">{match.title}</div>
                <div className="tile__year">{match.year ?? ''}</div>
              </div>
            </div>
          )
        })}

        <button className="tile--again" onClick={() => void again()} disabled={starting}>
          <b>＋</b>
          <s>
            {starting ? (
              'Dealing…'
            ) : (
              <>
                Swipe another
                <br />
                twenty
              </>
            )}
          </s>
        </button>
      </div>
    </Screen>
  )
}
