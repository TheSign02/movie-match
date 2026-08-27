import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'

import type { DeckFilm } from '../lib/deck'
import { posterUrl } from '../lib/tmdb'

/* ═══════════════════════════════════════════════════════════════════
   Swipe mechanics, ported from the prototype in the <script> block of
   plans/Movie_Match.html rather than reaching for a gesture library
   (PLAN.md §11).

   Pointer Events with setPointerCapture: one code path for touch,
   mouse and pen, correct on both iOS Safari and Chrome.
   ═══════════════════════════════════════════════════════════════════ */

/** px of travel to commit. */
const THRESHOLD = 95
/** px/ms to commit regardless of travel. A fast short flick is a real
    gesture that a distance-only threshold ignores. */
const FLICK = 0.55
/** Divisor turning horizontal travel into degrees of tilt. */
const ROTATION = 22
/** Vertical movement is damped; the gesture is horizontal. */
const VERTICAL_DAMP = 0.35
/** Travel over which the stamp and wash ramp to full opacity. */
const CUE_RAMP = 110
/** How far off-screen the card flies, and for how long. */
const EXIT_X = 520
const EXIT_MS = 220

export type SwipeCardHandle = {
  /** Fly the card out as if swiped. Used by the pass and like buttons. */
  fly: (liked: boolean) => void
}

type SwipeCardProps = {
  film: DeckFilm
  onCommit: (liked: boolean) => void
  disabled?: boolean
}

export const SwipeCard = forwardRef<SwipeCardHandle, SwipeCardProps>(function SwipeCard(
  { film, onCommit, disabled = false },
  ref,
) {
  const card = useRef<HTMLDivElement>(null)
  const stampLike = useRef<HTMLDivElement>(null)
  const stampPass = useRef<HTMLDivElement>(null)
  const washLike = useRef<HTMLDivElement>(null)
  const washPass = useRef<HTMLDivElement>(null)

  const start = useRef<{ x: number; y: number; t: number } | null>(null)
  const dx = useRef(0)
  const dragging = useRef(false)
  const flying = useRef(false)

  /**
   * Writes straight to the DOM rather than through state: a pointermove
   * fires at display rate, and a re-render per frame is exactly how a
   * drag turns janky.
   */
  const paint = useCallback((x: number, y: number, animate: boolean) => {
    const clamp = (v: number) => Math.max(0, Math.min(1, v))
    const el = card.current
    if (!el) return

    el.style.transition = animate ? `transform ${EXIT_MS}ms var(--ease-out)` : 'none'
    el.style.transform = `translate(${x}px, ${y}px) rotate(${x / ROTATION}deg)`

    const like = String(clamp(x / CUE_RAMP))
    const pass = String(clamp(-x / CUE_RAMP))
    if (stampLike.current) stampLike.current.style.opacity = like
    if (washLike.current) washLike.current.style.opacity = like
    if (stampPass.current) stampPass.current.style.opacity = pass
    if (washPass.current) washPass.current.style.opacity = pass
  }, [])

  // A new film means the previous one has flown out. Snap back to
  // centre with no transition, so the incoming card does not slide in
  // from where the last one left.
  useEffect(() => {
    flying.current = false
    dragging.current = false
    dx.current = 0
    start.current = null
    paint(0, 0, false)
  }, [film.id, paint])

  const commit = useCallback(
    (liked: boolean) => {
      if (flying.current) return
      flying.current = true

      paint(liked ? EXIT_X : -EXIT_X, -40, true)

      // Hand over only once the card is off-screen, so the swap of card
      // content is never visible.
      window.setTimeout(() => onCommit(liked), EXIT_MS)
    },
    [onCommit, paint],
  )

  useImperativeHandle(ref, () => ({ fly: commit }), [commit])

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (flying.current || disabled) return
    // Capture means the drag survives the pointer leaving the card,
    // which it will on any real flick.
    card.current?.setPointerCapture(event.pointerId)
    start.current = { x: event.clientX, y: event.clientY, t: event.timeStamp }
    dragging.current = true
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current || !start.current) return
    dx.current = event.clientX - start.current.x
    paint(dx.current, (event.clientY - start.current.y) * VERTICAL_DAMP, false)
  }

  function release(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current || !start.current) return
    dragging.current = false

    const dt = Math.max(1, event.timeStamp - start.current.t)
    const velocity = Math.abs(dx.current) / dt

    if (Math.abs(dx.current) > THRESHOLD || velocity > FLICK) commit(dx.current > 0)
    else paint(0, 0, true)

    start.current = null
  }

  const poster = posterUrl(film.poster_path, 'w500')

  return (
    <div
      ref={card}
      className="card"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={release}
    >
      {poster ? (
        <img className="card__art" src={poster} alt="" draggable={false} />
      ) : (
        <div className="card__art" style={{ background: 'var(--bg-raised)' }} />
      )}

      <div className="card__grain" />
      <div className="card__scrim" />

      <div className="card__meta">
        {/* The design's chips carry genre and runtime, and its byline a
            director. None of the three is in the movies table: §8 fixes
            the stored shape at tmdb_id, title, year, poster_path and
            overview, and filling the chips would mean a TMDB detail
            request per film on every bulk import. Year stands alone. */}
        <div className="card__title">{film.title}</div>
        {film.year !== null ? <div className="card__by">{film.year}</div> : null}
        {film.overview ? <p className="card__blurb">{film.overview}</p> : null}
      </div>

      <div ref={stampLike} className="stamp stamp--like" style={{ opacity: 0 }}>
        LIKE
      </div>
      <div ref={stampPass} className="stamp stamp--pass" style={{ opacity: 0 }}>
        PASS
      </div>
      <div ref={washLike} className="wash wash--like" style={{ opacity: 0 }} />
      <div ref={washPass} className="wash wash--pass" style={{ opacity: 0 }} />
    </div>
  )
})
