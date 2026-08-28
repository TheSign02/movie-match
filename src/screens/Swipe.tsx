import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { CardFace } from '../components/CardFace'
import { Screen } from '../components/Screen'
import { SwipeCard, type SwipeCardHandle } from '../components/SwipeCard'
import {
  fetchDeck,
  fetchSwipeCount,
  finishDeck,
  recordSwipe,
  type DeckFilm,
} from '../lib/deck'
import {
  fetchMyPlayer,
  fetchSessionById,
  rememberSession,
  resolveRoute,
  type Player,
} from '../lib/session'
import { posterUrl } from '../lib/tmdb'
import { usePlayerSession } from '../lib/usePlayerSession'

/**
 * How far ahead to warm posters. The card at index + 1 is rendered
 * behind the live one so the browser already fetches it; this covers the
 * two after that, so a swipe never reveals an empty card.
 */
const PRELOAD_AHEAD = 3

/** Frame 03. */
export function Swipe() {
  const navigate = useNavigate()
  const { sessionId = '' } = useParams()
  const { session: auth, loading: authLoading } = usePlayerSession()

  const [deck, setDeck] = useState<DeckFilm[] | null>(null)
  const [me, setMe] = useState<Player | null>(null)
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [finishing, setFinishing] = useState(false)

  const cardRef = useRef<SwipeCardHandle>(null)

  /**
   * Writes are serialised through one promise chain. Each insert is
   * independent, but chaining gives a single thing to await before
   * finish_deck — without it the round can be marked finished while the
   * twentieth swipe is still in flight, and get_matches would compute
   * against an incomplete set.
   */
  const queue = useRef<Promise<void>>(Promise.resolve())

  const userId = auth?.user.id ?? null

  /* ─── load and resume ───────────────────────────────────────────── */

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

        const player = await fetchMyPlayer(sessionId, userId!)
        if (cancelled) return

        if (!player) {
          navigate('/', { replace: true })
          return
        }

        // Anything other than a running round this player has not
        // finished belongs elsewhere.
        if (session.status !== 'swiping' || player.finished_at) {
          navigate(await resolveRoute(sessionId, userId!), { replace: true })
          return
        }

        const [films, swiped] = await Promise.all([
          fetchDeck(session.movie_ids),
          fetchSwipeCount(player.id),
        ])
        if (cancelled) return

        rememberSession(sessionId)
        setMe(player)
        setDeck(films)

        // Every card already swiped but finish_deck never landed — a
        // tab killed between the last insert and the RPC. Close it out.
        if (swiped >= films.length) {
          await finishDeck(sessionId)
          navigate(`/waiting/${sessionId}`, { replace: true })
          return
        }

        setIndex(swiped)
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [sessionId, userId, navigate])

  /* ─── preload ───────────────────────────────────────────────────── */

  useEffect(() => {
    if (!deck) return
    for (let i = index + 2; i <= index + PRELOAD_AHEAD && i < deck.length; i++) {
      const url = posterUrl(deck[i]!.poster_path, 'w500')
      if (url) {
        const img = new Image()
        img.src = url
      }
    }
  }, [deck, index])

  /* ─── swiping ───────────────────────────────────────────────────── */

  const onCommit = useCallback(
    (liked: boolean) => {
      if (!deck || !me) return

      const film = deck[index]
      if (!film) return

      const isLast = index + 1 >= deck.length

      // The insert goes out immediately; the UI does not wait for it.
      // A swipe that felt like it took 300ms would be a worse bug than
      // the rare failure this optimism risks, and the failure path
      // re-reads the true cursor from the server.
      queue.current = queue.current.then(() =>
        recordSwipe({
          sessionId,
          playerId: me.id,
          movieId: film.id,
          liked,
        }).catch(async (err: Error) => {
          setError(`That swipe did not save: ${err.message}`)
          // Re-sync rather than guess. The count is the cursor.
          try {
            setIndex(await fetchSwipeCount(me.id))
          } catch {
            /* the banner is already up */
          }
        }),
      )

      if (isLast) {
        setFinishing(true)
        void queue.current
          .then(() => finishDeck(sessionId))
          .then(() => navigate(`/waiting/${sessionId}`, { replace: true }))
          .catch((err: Error) => {
            setError(err.message)
            setFinishing(false)
          })
        return
      }

      setIndex((current) => current + 1)
    },
    [deck, index, me, navigate, sessionId],
  )

  /* ─── render ────────────────────────────────────────────────────── */

  if (authLoading || !deck || !me) {
    return (
      <Screen>
        <div className="flex flex-1 items-center justify-center">
          <p className="lede text-sm">{error ?? 'Dealing the deck…'}</p>
        </div>
      </Screen>
    )
  }

  const film = deck[index]
  const next = deck[index + 1]
  const remaining = deck.length - index
  const progress = Math.round(((index + 1) / deck.length) * 100)

  return (
    <Screen gutter="deck">
      <div className="deckbar">
        <button
          className="iconbtn tap-exempt"
          style={{ width: 40, height: 40, fontSize: 17, color: 'var(--text-muted)' }}
          onClick={() => navigate('/')}
          aria-label="Leave the round"
        >
          ✕
        </button>
        <div style={{ flex: 1 }}>
          <div className="track">
            <i style={{ width: `${progress}%` }} />
          </div>
        </div>
        <div className="counter">
          {Math.min(index + 1, deck.length)}/{deck.length}
        </div>
      </div>

      {error ? (
        <div className="banner mt-3" role="alert">
          {error}
        </div>
      ) : null}

      <div className="deck">
        {/* The furthest back stays abstract — it is a sliver of edge and
            a third poster there would be noise. Dropped as the films
            behind run out, so the last card never sits on a phantom
            pile. */}
        {remaining > 2 ? <div className="deck-back deck-back--1" /> : null}

        {/* The next film, rendered for real. It is visible from the
            first pixel of a drag, and because it is a whole card the
            moment the top one flies away reveals something finished
            rather than a placeholder that then swaps. */}
        {next ? (
          <div className="card card--next" aria-hidden="true">
            <CardFace film={next} />
          </div>
        ) : null}

        {film ? (
          <SwipeCard ref={cardRef} film={film} onCommit={onCommit} disabled={finishing} />
        ) : null}
      </div>

      <div className="deck-actions">
        <button
          className="round round--pass tap-exempt"
          onClick={() => cardRef.current?.fly(false)}
          disabled={finishing}
          aria-label="Pass"
        >
          ✕
        </button>
        <button
          className="round round--like tap-exempt"
          onClick={() => cardRef.current?.fly(true)}
          disabled={finishing}
          aria-label="Like"
        >
          ♥
        </button>
      </div>
    </Screen>
  )
}
