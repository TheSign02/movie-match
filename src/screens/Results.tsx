import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { GenreChips } from '../components/GenreChips'
import { MatchDetail } from '../components/MatchDetail'
import { Screen } from '../components/Screen'
import { fetchLikedCounts, fetchMatches, type LikedCount, type Match } from '../lib/results'
import {
  fetchMyPlayer,
  fetchSessionById,
  rememberSession,
  resolveRoute,
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
  /** The match brought forward, if any. */
  const [open, setOpen] = useState<Match | null>(null)

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
   * Home, to set up another round.
   *
   * This used to be a rematch that moved BOTH players into a new lobby.
   * That was the wrong behaviour: one player being ready again should
   * not pull the other off a results screen they are still reading. So
   * leaving is a personal act — the partner keeps their matches on
   * screen for as long as they want them.
   */
  const leave = useCallback(() => {
    // The round is over; nothing to come back to.
    rememberSession(null)
    navigate('/')
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
        <div className="topbar">
          <button className="iconbtn" onClick={leave} aria-label="Back to the home screen">
            ←
          </button>
          <div className="sp" />
          <div className="sp" />
        </div>

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
          {/* Labelled for where it actually goes. This screen has nothing
              else in it, so unlike the matches grid it keeps a primary
              action rather than leaning on the back arrow alone. */}
          <button className="btn btn--primary" onClick={leave}>
            Back to home
          </button>
        </div>
      </Screen>
    )
  }

  /* ─── 05 · matches ──────────────────────────────────────────────── */

  return (
    <Screen gutter="none">
      <div className="glow glow--top" />

      {/* BUILD: the frame has no back control, because it was drawn as the
          end of the flow. The round really does end here, so there has to
          be a way out that does not involve closing the tab. */}
      <div className="topbar" style={{ padding: '18px 20px 0' }}>
        <button className="iconbtn" onClick={leave} aria-label="Back to the home screen">
          ←
        </button>
        <div className="sp" />
        <div className="sp" />
      </div>

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
          const sub = [match.year, match.runtime ? `${match.runtime} min` : null]
            .filter(Boolean)
            .join(' · ')

          return (
            <button
              className="tile tap-exempt"
              key={match.movie_id}
              onClick={() => setOpen(match)}
              aria-label={`${match.title}, more about this film`}
            >
              {poster ? (
                <img className="tile__art" src={poster} alt="" loading="lazy" />
              ) : (
                <div className="tile__art" style={{ background: 'var(--bg-raised)' }} />
              )}
              <div className="tile__meta">
                <div className="tile__title">{match.title}</div>
                <div className="tile__year">{sub}</div>
                <GenreChips genres={match.genres} small />
              </div>
            </button>
          )
        })}

        {/* The design's dashed "Swipe another twenty" tile is gone: the
            back button is the only way out, and one exit is clearer than
            two that do the same thing. */}
      </div>

      {/* Match is the get_matches row shape; CardFace speaks DeckFilm.
          Same fields under different names. */}
      {open ? (
        <MatchDetail
          film={{
            id: open.movie_id,
            title: open.title,
            year: open.year,
            poster_path: open.poster_path,
            overview: open.overview,
            runtime: open.runtime,
            genres: open.genres,
          }}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </Screen>
  )
}
