import { supabase } from './supabase'
import { fetchRuntimes, type TmdbHit } from './tmdb'

export type PoolFilm = {
  id: string
  tmdb_id: number
  title: string
  year: number | null
  poster_path: string | null
  runtime: number | null
  added_at: string
}

/** Active films only, newest first — the order movies_active_idx serves. */
export async function fetchPool(): Promise<PoolFilm[]> {
  const { data, error } = await supabase
    .from('movies')
    .select('id, tmdb_id, title, year, poster_path, runtime, added_at')
    .is('retired_at', null)
    .order('added_at', { ascending: false })

  if (error) throw new Error(error.message)
  return data ?? []
}

/**
 * Adds films to the pool.
 *
 * upsert on tmdb_id rather than insert, because a film that was retired
 * earlier is still in the table: a plain insert would collide with the
 * unique tmdb_id, and the admin would be told a film they cannot see is
 * already there. Clearing retired_at is the un-retire.
 */
export async function addFilms(hits: TmdbHit[]): Promise<number> {
  if (hits.length === 0) return 0

  // Second line of defence. The Edge Function already dedupes, but a
  // single duplicate reaching the upsert below fails the entire batch —
  // ON CONFLICT DO UPDATE cannot affect the same row twice in one
  // statement — so it is worth not depending on that.
  const byId = new Map(hits.map((h) => [h.tmdb_id, h]))
  hits = [...byId.values()]

  // Runtime is the one field search and discover do not carry, so it is
  // fetched here — once per film, at the only moment anyone cares.
  // A failure must not block the import: the card falls back to showing
  // the year alone.
  let runtimes = new Map<number, number | null>()
  try {
    runtimes = await fetchRuntimes(hits.map((h) => h.tmdb_id))
  } catch {
    /* added without runtimes; the deck copes */
  }

  const rows = hits.map((h) => ({
    tmdb_id: h.tmdb_id,
    title: h.title,
    year: h.year,
    poster_path: h.poster_path,
    overview: h.overview,
    runtime: runtimes.get(h.tmdb_id) ?? null,
    retired_at: null,
  }))

  const { error } = await supabase.from('movies').upsert(rows, { onConflict: 'tmdb_id' })
  if (error) throw new Error(error.message)
  return rows.length
}

/**
 * Retires a film rather than deleting it. Rounds already played keep
 * their titles and posters; new decks stop drawing it. See the
 * soft_retire_movies migration for why deletion is not an option.
 */
export async function retireFilm(id: string): Promise<void> {
  const { error } = await supabase
    .from('movies')
    .update({ retired_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw new Error(error.message)
}
