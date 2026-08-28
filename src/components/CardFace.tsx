import type { DeckFilm } from '../lib/deck'
import { posterUrl } from '../lib/tmdb'

/**
 * Everything inside a card that isn't the gesture: poster, grain, scrim
 * and the meta block.
 *
 * Shared by the live card and the one stacked behind it, so that when
 * the top card flies away what it reveals is a finished card rather
 * than a placeholder that then swaps.
 */
export function CardFace({ film }: { film: DeckFilm }) {
  const poster = posterUrl(film.poster_path, 'w500')

  return (
    <>
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
    </>
  )
}
