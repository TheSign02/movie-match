import { posterUrl, type TmdbHit } from '../../lib/tmdb'

type HitRowProps = {
  hit: TmdbHit
  onAdd: (hit: TmdbHit) => void
  busy: boolean
}

/**
 * One TMDB result. Frame 06 shows three states — addable, addable, and
 * greyed with a checkmark for something already in the pool — and the
 * greyed state is why the Edge Function bothers marking in_pool.
 */
export function HitRow({ hit, onAdd, busy }: HitRowProps) {
  const poster = posterUrl(hit.poster_path, 'w185')

  const sub = hit.in_pool
    ? 'in pool'
    : [hit.year ?? '—', hit.retired ? 'removed earlier' : `tmdb ${hit.tmdb_id}`].join(' · ')

  return (
    <div className={`hit${hit.in_pool ? ' hit--in' : ''}`}>
      {poster ? (
        <img className="hit__art" src={poster} alt="" loading="lazy" decoding="async" />
      ) : (
        <div className="hit__art" />
      )}

      <div className="hit__body">
        <div className="hit__title">{hit.title}</div>
        <div className="hit__sub">{sub}</div>
      </div>

      {hit.in_pool ? (
        <div className="in-pool" aria-label="already in the pool">
          ✓
        </div>
      ) : (
        <button className="add tap-exempt" onClick={() => onAdd(hit)} disabled={busy}>
          ADD
        </button>
      )}
    </div>
  )
}
