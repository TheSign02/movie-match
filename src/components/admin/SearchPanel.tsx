import { useEffect, useState } from 'react'

import { searchFilms, type TmdbHit } from '../../lib/tmdb'
import { HitRow } from './HitRow'

type SearchPanelProps = {
  /** tmdb_ids currently active in the pool, so rows re-grey without a refetch. */
  poolIds: Set<number>
  onAdd: (hits: TmdbHit[]) => Promise<void>
  busy: boolean
  onError: (message: string) => void
}

const DEBOUNCE_MS = 350

/** Deliberate additions by title (PLAN.md §8). */
export function SearchPanel({ poolIds, onAdd, busy, onError }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TmdbHit[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed === '') {
      setResults([])
      return
    }

    // Debounced so a typed word is one request, not eight. The cancelled
    // flag drops a response that arrives after a newer keystroke.
    let cancelled = false
    setSearching(true)

    const timer = setTimeout(() => {
      searchFilms(trimmed)
        .then((hits) => {
          if (!cancelled) setResults(hits)
        })
        .catch((err: Error) => {
          if (!cancelled) onError(err.message)
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // onError is stable; including it would re-run the search on every
    // parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const shown = results.map((hit) =>
    poolIds.has(hit.tmdb_id) ? { ...hit, in_pool: true, retired: false } : hit,
  )

  return (
    <>
      <div className="search">
        <span className="ic" aria-hidden="true">
          ⌕
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search TMDB by title"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Search TMDB by title"
        />
      </div>

      {query.trim() !== '' ? (
        <>
          <div className="sec-label">
            {searching ? 'Searching…' : `Search results · ${shown.length}`}
          </div>

          {shown.length > 0 ? (
            <div className="group">
              {shown.map((hit) => (
                <HitRow key={hit.tmdb_id} hit={hit} onAdd={(h) => void onAdd([h])} busy={busy} />
              ))}
            </div>
          ) : searching ? null : (
            <p className="lede px-1 text-sm">Nothing with a poster matched that.</p>
          )}
        </>
      ) : null}
    </>
  )
}
