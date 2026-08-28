import { useEffect, useRef } from 'react'

import type { DeckFilm } from '../lib/deck'
import { CardFace } from './CardFace'

/**
 * A match, brought forward at card size.
 *
 * BUILD: not one of the ten frames. The results grid shows a poster and
 * a title, which is all a 2-up tile has room for — the description only
 * becomes readable somewhere like this. Reuses CardFace, so a film looks
 * the same here as it did in the deck.
 */
export function MatchDetail({ film, onClose }: { film: DeckFilm; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Focus lands on the way out, so a keyboard or screen reader user is
    // not left behind the overlay.
    close.current?.focus()

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="detail"
      role="dialog"
      aria-modal="true"
      aria-label={film.title}
      // Backdrop only: a tap that started inside the card must not close
      // it, which is what checking the target rules out.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="detail__card">
        <button
          ref={close}
          className="detail__close tap-exempt"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>

        <CardFace film={film} />
      </div>
    </div>
  )
}
