import { useCallback, useEffect, useMemo, useState } from 'react'

import { addFilms, fetchPool, retireFilm, type PoolFilm } from '../../lib/pool'
import { supabase } from '../../lib/supabase'
import type { TmdbHit } from '../../lib/tmdb'
import { BulkImport } from './BulkImport'
import { PoolList } from './PoolList'
import { SearchPanel } from './SearchPanel'

/** A round draws 20; below this a random 20 stops feeling random. */
const HEALTHY_POOL = 60

/**
 * Frame 06, with the three changes PLAN.md §10 calls for: no SHUFFLE
 * (deck order is per-session now, so pool order means nothing), no SAVE
 * POOL (every write is immediate), and the counter shows the pool total
 * rather than 20 / 20.
 */
export function PoolAdmin() {
  const [pool, setPool] = useState<PoolFilm[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setPool(await fetchPool())
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const poolIds = useMemo(() => new Set((pool ?? []).map((f) => f.tmdb_id)), [pool])

  const onError = useCallback((message: string) => setError(message), [])

  const handleAdd = useCallback(
    async (hits: TmdbHit[]) => {
      if (hits.length === 0) return
      setBusy(true)
      setError(null)
      try {
        await addFilms(hits)
        await reload()
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [reload],
  )

  const handleRemove = useCallback(
    async (film: PoolFilm) => {
      setRemovingId(film.id)
      setError(null)
      try {
        await retireFilm(film.id)
        // Optimistic enough: drop it locally rather than refetching the
        // whole pool for one row.
        setPool((current) => (current ?? []).filter((f) => f.id !== film.id))
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setRemovingId(null)
      }
    },
    [],
  )

  const count = pool?.length ?? 0

  return (
    <div
      className="screen--admin flex min-h-[100dvh] flex-1 flex-col"
      style={{
        paddingTop: 'var(--inset-top)',
        paddingLeft: 'calc(var(--inset-left) + 18px)',
        paddingRight: 'calc(var(--inset-right) + 18px)',
        paddingBottom: 'var(--inset-bottom)',
      }}
    >
      <div className="admin-head">
        <div
          className="eyebrow eyebrow--label"
          style={{ fontSize: 'var(--size-sm)', color: 'var(--text-quiet)' }}
        >
          Pool admin
        </div>
        <button
          className="tap-exempt text-xs text-faint"
          onClick={() => void supabase.auth.signOut()}
        >
          Sign out
        </button>
      </div>

      {error ? (
        <div className="banner mb-3" role="alert">
          {error}
        </div>
      ) : null}

      <SearchPanel poolIds={poolIds} onAdd={handleAdd} busy={busy} onError={onError} />

      <BulkImport poolIds={poolIds} onAdd={handleAdd} busy={busy} onError={onError} />

      <div className="admin-head" style={{ padding: '20px 4px 8px' }}>
        <div className="sec-label" style={{ padding: 0 }}>
          Current pool
        </div>
        <div
          style={{
            fontSize: 'var(--size-xs)',
            color: count >= HEALTHY_POOL ? 'var(--accent-soft)' : 'var(--text-quiet)',
          }}
        >
          {pool === null ? '…' : `${count} film${count === 1 ? '' : 's'}`}
          {pool !== null && count < HEALTHY_POOL ? ` · ${HEALTHY_POOL - count} to go` : ''}
        </div>
      </div>

      {pool === null ? (
        <p className="lede px-1 text-sm">Loading the pool…</p>
      ) : (
        <PoolList films={pool} onRemove={(f) => void handleRemove(f)} busyId={removingId} />
      )}

      {/* TMDB's terms require visible attribution wherever their data is
          shown (PLAN.md §8). */}
      <p className="attribution">
        This product uses the TMDB API but is not endorsed or certified by TMDB.
      </p>
    </div>
  )
}
