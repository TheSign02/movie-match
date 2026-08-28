import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { Screen } from '../components/Screen'
import { SwipeCard, type SwipeCardHandle } from '../components/SwipeCard'
import { LikeIcon, PassIcon } from '../components/icons'
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
import { usePlayerSession } from '../lib/usePlayerSession'

/**
 * How many cards are mounted at once, the live one included.
 *
 * Three is what removes the blink. Each is keyed by film id and stays
 * mounted as the stack advances, so by the time a card is revealed its
 * poster has been in the document — and decoded — for two swipes. They
 * sit exactly behind each other, so at rest only the top one is visible.
 */
const STACK_SIZE = 3

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

  // Top card first. Keys are film ids, so advancing the index reuses the
  // cards behind rather than remounting them.
  const stack = deck.slice(index, index + STACK_SIZE)
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
        {/* Rendered in order, front to back, and separated by z-index
            rather than DOM order so the nodes never have to be
            reshuffled. The stack shortens by itself near the end of the
            deck, so the last card sits on nothing. */}
        {stack.map((card, offset) => (
          <SwipeCard
            key={card.id}
            ref={offset === 0 ? cardRef : null}
            film={card}
            isTop={offset === 0}
            zIndex={STACK_SIZE - offset}
            onCommit={onCommit}
            disabled={finishing}
          />
        ))}
      </div>

      <div className="deck-actions">
        <button
          className="round round--pass tap-exempt"
          onClick={() => cardRef.current?.fly(false)}
          disabled={finishing}
          aria-label="Pass"
        >
          <PassIcon />
        </button>
        <button
          className="round round--like tap-exempt"
          onClick={() => cardRef.current?.fly(true)}
          disabled={finishing}
          aria-label="Like"
        >
          <LikeIcon />
        </button>
      </div>
    </Screen>
  )
}
