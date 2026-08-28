import { supabase } from './supabase'

/** What the Edge Function returns for a search or discover hit. */
export type TmdbHit = {
  tmdb_id: number
  title: string
  year: number | null
  poster_path: string | null
  overview: string
  /** Active in the pool right now. */
  in_pool: boolean
  /** In the table but retired; adding it again un-retires it. */
  retired: boolean
}

export type Genre = { id: number; name: string }

/**
 * Poster sizes, per PLAN.md §8. w500 for anything the player sees,
 * w185 for admin thumbnails — the admin list renders dozens at 44px
 * wide and w500 there would be several megabytes of wasted transfer.
 */
export type PosterSize = 'w185' | 'w500'

export function posterUrl(path: string | null, size: PosterSize): string | null {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null
}

type TmdbAction =
  | { action: 'search'; q: string }
  | { action: 'discover'; sort: string; genre?: number; decade?: number; limit: number }
  | { action: 'genres' }
  | { action: 'details'; ids: number[] }

/**
 * functions.invoke puts a non-2xx response body inside the error rather
 * than in data, so every message the function raises has to be dug out
 * of error.context. Without this the UI shows "Edge Function returned a
 * non-2xx status code" instead of "not an admin".
 */
async function invoke<T>(body: TmdbAction): Promise<T> {
  const { data, error } = await supabase.functions.invoke('tmdb', { body })

  if (error) {
    let message = error.message
    const context = (error as { context?: Response }).context
    if (context && typeof context.json === 'function') {
      try {
        const parsed = (await context.json()) as { error?: string }
        if (parsed?.error) message = parsed.error
      } catch {
        /* body was not JSON; keep the generic message */
      }
    }
    throw new Error(message)
  }

  return data as T
}

export function searchFilms(q: string) {
  return invoke<{ results: TmdbHit[] }>({ action: 'search', q }).then((r) => r.results)
}

export function discoverFilms(opts: {
  sort: string
  genre?: number
  decade?: number
  limit: number
}) {
  // Typed as the discover member, not the union: assigning to .genre on
  // a union-typed value is an error because the other members have no
  // such property.
  const body: Extract<TmdbAction, { action: 'discover' }> = {
    action: 'discover',
    sort: opts.sort,
    limit: opts.limit,
  }
  if (opts.genre) body.genre = opts.genre
  if (opts.decade) body.decade = opts.decade
  return invoke<{ results: TmdbHit[] }>(body).then((r) => r.results)
}

export function fetchGenres() {
  return invoke<{ genres: Genre[] }>({ action: 'genres' }).then((r) => r.genres)
}

export type FilmDetails = { runtime: number | null; genres: string[] }

/**
 * Runtime and genres by tmdb_id. One TMDB request per film behind the
 * scenes, since only /movie/{id} carries either — which is why this is
 * called when films are added rather than for every search result.
 */
export async function fetchDetails(ids: number[]): Promise<Map<number, FilmDetails>> {
  if (ids.length === 0) return new Map()

  const { details } = await invoke<{
    details: { tmdb_id: number; runtime: number | null; genres: string[] }[]
  }>({ action: 'details', ids })

  return new Map(details.map((d) => [d.tmdb_id, { runtime: d.runtime, genres: d.genres ?? [] }]))
}
