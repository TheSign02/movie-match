import type { DeckFilm } from '../lib/deck'
import { posterUrl } from '../lib/tmdb'

/**
 * Everything inside a card that isn't the gesture: poster, scrim and the
 * meta block.
 *
 * Shared by the live card, the cards stacked behind it, and the match
 * detail on the results screen — so a film reads the same wherever it
 * appears, and a card revealed mid-swipe is already finished rather than
 * a placeholder that swaps.
 */
export function CardFace({ film }: { film: DeckFilm }) {
  const poster = posterUrl(film.poster_path, 'w500')

  // "2023 · 106 min", or whichever half exists. TMDB reports no runtime
  // for plenty of films, and 0 min is worse than nothing.
  const meta = [film.year, film.runtime ? `${film.runtime} min` : null]
    .filter((part) => part !== null && part !== undefined)
    .join(' · ')

  return (
    <>
      {poster ? (
        <img className="card__art" src={poster} alt="" draggable={false} />
      ) : (
        <div className="card__art" style={{ background: 'var(--bg-raised)' }} />
      )}

      {/* The design's diagonal grain overlay is deliberately gone: over a
          real poster it read as scratches on the image rather than as
          texture. */}
      <div className="card__scrim" />

      <div className="card__meta">
        {/* The design's chips carry genre, and its byline a director.
            Neither is in the movies table — §8 fixes the stored shape,
            and runtime is already one addition past it. */}
        <div className="card__title">{film.title}</div>
        {meta ? <div className="card__by">{meta}</div> : null}
        {film.overview ? <p className="card__blurb">{film.overview}</p> : null}
      </div>
    </>
  )
}
