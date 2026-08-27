import { posterUrl } from '../../lib/tmdb'
import type { PoolFilm } from '../../lib/pool'

type PoolListProps = {
  films: PoolFilm[]
  onRemove: (film: PoolFilm) => void
  busyId: string | null
}

/**
 * The current pool. Frame 06 numbers the rows, which is worth keeping —
 * it makes "how far off 60 am I" answerable at a glance while scrolling.
 *
 * Removing retires rather than deletes, so a film that has been swiped
 * in a past round keeps its title and poster for that round's results.
 */
export function PoolList({ films, onRemove, busyId }: PoolListProps) {
  if (films.length === 0) {
    return (
      <p className="lede px-1 text-sm">
        Nothing in the pool yet. A round needs 20 films, and it wants 60 or more before a
        random 20 stops being predictable.
      </p>
    )
  }

  return (
    <div className="pool">
      {films.map((film, index) => {
        const poster = posterUrl(film.poster_path, 'w185')

        return (
          <div className="pool-row" key={film.id}>
            <span className="n">{String(index + 1).padStart(2, '0')}</span>

            {poster ? (
              <img className="art" src={poster} alt="" loading="lazy" decoding="async" />
            ) : (
              <div className="art" />
            )}

            <div className="nm">
              {film.title} <s>{film.year ?? '—'}</s>
            </div>

            <button
              className="rm tap-exempt"
              onClick={() => onRemove(film)}
              disabled={busyId === film.id}
              aria-label={`Remove ${film.title}`}
            >
              ✕
            </button>
          </div>
        )
      })}
    </div>
  )
}
