import { useEffect, useState } from 'react'

import { discoverFilms, fetchGenres, type Genre, type TmdbHit } from '../../lib/tmdb'
import { HitRow } from './HitRow'

type BulkImportProps = {
  poolIds: Set<number>
  onAdd: (hits: TmdbHit[]) => Promise<void>
  busy: boolean
  onError: (message: string) => void
}

const SORTS = [
  { value: 'vote_average.desc', label: 'Top rated' },
  { value: 'popularity.desc', label: 'Popular' },
  { value: 'revenue.desc', label: 'Highest grossing' },
  { value: 'primary_release_date.desc', label: 'Newest' },
]

const DECADES = [1960, 1970, 1980, 1990, 2000, 2010, 2020]

/** The Edge Function caps this at 50 per call. */
const LIMITS = [10, 20, 30, 50]

/**
 * Bulk import, and the reason the pool works at all.
 *
 * Hand-picking breaks the game: people add films they already want to
 * see, so either everything matches or a list replaces the swipe. Two
 * things fix it — a pool large enough that a random 20 is genuinely
 * unknown, and imports nobody curated film by film (PLAN.md §8).
 */
export function BulkImport({ poolIds, onAdd, busy, onError }: BulkImportProps) {
  const [open, setOpen] = useState(false)
  const [genres, setGenres] = useState<Genre[]>([])

  const [sort, setSort] = useState(SORTS[0]!.value)
  const [genre, setGenre] = useState(0)
  const [decade, setDecade] = useState(0)
  const [limit, setLimit] = useState(20)

  const [preview, setPreview] = useState<TmdbHit[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || genres.length > 0) return
    fetchGenres()
      .then(setGenres)
      .catch((err: Error) => onError(err.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function runPreview() {
    setLoading(true)
    setPreview(null)
    try {
      const hits = await discoverFilms({
        sort,
        limit,
        ...(genre ? { genre } : {}),
        ...(decade ? { decade } : {}),
      })
      setPreview(hits)
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const shown = (preview ?? []).map((hit) =>
    poolIds.has(hit.tmdb_id) ? { ...hit, in_pool: true, retired: false } : hit,
  )
  const addable = shown.filter((hit) => !hit.in_pool)

  if (!open) {
    return (
      <button className="btn btn--ghost btn--sm mt-3" onClick={() => setOpen(true)}>
        Bulk import…
      </button>
    )
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="admin-head" style={{ padding: '0 4px 4px' }}>
        <div className="sec-label" style={{ padding: 0 }}>
          Bulk import
        </div>
        <button className="tap-exempt text-xs text-faint" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>

      <div className="admin-controls">
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort by">
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <select
          className="select"
          value={genre}
          onChange={(e) => setGenre(Number(e.target.value))}
          aria-label="Genre"
        >
          <option value={0}>Any genre</option>
          {genres.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>

        <select
          className="select"
          value={decade}
          onChange={(e) => setDecade(Number(e.target.value))}
          aria-label="Decade"
        >
          <option value={0}>Any decade</option>
          {DECADES.map((d) => (
            <option key={d} value={d}>
              {d}s
            </option>
          ))}
        </select>

        <select
          className="select"
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          aria-label="How many films"
        >
          {LIMITS.map((n) => (
            <option key={n} value={n}>
              Up to {n}
            </option>
          ))}
        </select>
      </div>

      <button className="btn btn--ghost btn--sm" onClick={() => void runPreview()} disabled={loading}>
        {loading ? 'Fetching…' : 'Preview'}
      </button>

      {preview !== null ? (
        <>
          <div className="sec-label" style={{ padding: '4px 4px 0' }}>
            {addable.length} new · {shown.length - addable.length} already in pool
          </div>

          <div className="group">
            {shown.map((hit) => (
              <HitRow key={hit.tmdb_id} hit={hit} onAdd={(h) => void onAdd([h])} busy={busy} />
            ))}
          </div>

          <button
            className={`btn btn--sm ${addable.length > 0 && !busy ? 'btn--primary' : 'btn--off'}`}
            disabled={addable.length === 0 || busy}
            onClick={() => {
              void onAdd(addable).then(() => setPreview(null))
            }}
          >
            {addable.length > 0 ? `Add all ${addable.length}` : 'Nothing new to add'}
          </button>
        </>
      ) : null}
    </div>
  )
}
