/**
 * TMDB proxy — the only thing in this project that holds the TMDB key.
 *
 * PLAN.md §8. The key never reaches the client, so both admin
 * operations go through here:
 *
 *   { action: 'search',   q }                      title search
 *   { action: 'discover', sort, genre, decade, limit }   bulk import
 *   { action: 'genres' }                           genre list for the UI
 *   { action: 'details', ids }                     runtime + genres
 *
 * An Edge Function bypasses RLS, so admin membership is checked
 * explicitly on every call. Without that check this endpoint would hand
 * anyone with the anon key an authenticated view of the whole API.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2'

const TMDB = 'https://api.themoviedb.org/3'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const JSON_HEADERS = { ...CORS, 'Content-Type': 'application/json' }

/** Bulk import is capped at 50, and TMDB pages are 20 wide. */
const MAX_LIMIT = 50
const PAGE_SIZE = 20

type Trimmed = {
  tmdb_id: number
  title: string
  year: number | null
  poster_path: string | null
  overview: string
  /** Already in the pool, so the UI greys it with a checkmark. */
  in_pool: boolean
  /** In the table but retired. Adding it again un-retires it. */
  retired: boolean
}

type TmdbMovie = {
  id: number
  title?: string
  name?: string
  release_date?: string
  poster_path?: string | null
  overview?: string
}

function fail(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS })
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS })
}

/**
 * TMDB gives a full ISO date or an empty string. Year is all the design
 * shows, and an empty string must not become 0.
 */
function yearOf(releaseDate: string | undefined): number | null {
  if (!releaseDate) return null
  const year = Number.parseInt(releaseDate.slice(0, 4), 10)
  return Number.isFinite(year) ? year : null
}

function trim(raw: TmdbMovie): Omit<Trimmed, 'in_pool' | 'retired'> {
  return {
    tmdb_id: raw.id,
    title: raw.title ?? raw.name ?? 'Untitled',
    year: yearOf(raw.release_date),
    poster_path: raw.poster_path ?? null,
    overview: raw.overview ?? '',
  }
}

async function tmdbGet(path: string, params: Record<string, string>, key: string) {
  const url = new URL(`${TMDB}${path}`)
  url.searchParams.set('api_key', key)
  url.searchParams.set('language', 'en-US')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`TMDB ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return fail('POST only', 405)

  const tmdbKey = Deno.env.get('TMDB_API_KEY')
  if (!tmdbKey) return fail('TMDB_API_KEY is not set on this function', 500)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return fail('not authenticated', 401)

  // Acts as the caller, not as the service role: RLS still applies to
  // the movies read below, and is_admin() sees the caller's auth.uid().
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  )

  // supabase-js sends the anon key as Authorization even with no
  // session, so the header being present proves nothing. getUser
  // validates the JWT and tells us whether there is a real subject
  // behind it; without this, an unauthenticated call falls through to
  // is_admin and dies as a 500 "permission denied for function", which
  // is the right outcome reached the wrong way.
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData?.user) return fail('not authenticated', 401)

  // The check that matters. An Edge Function is outside RLS, so nothing
  // else is standing here.
  const { data: isAdmin, error: adminError } = await supabase.rpc('is_admin')
  if (adminError) return fail(`admin check failed: ${adminError.message}`, 500)
  if (!isAdmin) return fail('not an admin', 403)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return fail('body must be JSON', 400)
  }

  const action = String(body.action ?? '')

  try {
    if (action === 'genres') {
      const data = await tmdbGet('/genre/movie/list', {}, tmdbKey)
      return ok({ genres: data.genres ?? [] })
    }

    /**
     * Runtimes for a specific set of films.
     *
     * Only /movie/{id} carries a runtime, so this is one request per
     * film — which is why it runs when films are added rather than for
     * every search result nobody will add. Batched with a small
     * concurrency cap: 50 at once would trip TMDB's rate limit, and one
     * at a time would take most of a minute.
     */
    if (action === 'details') {
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : []
      if (ids.length === 0) return ok({ details: [] })
      if (ids.length > MAX_LIMIT) return fail(`at most ${MAX_LIMIT} ids per call`, 400)

      const details: {
        tmdb_id: number
        runtime: number | null
        genres: string[]
      }[] = []
      const CONCURRENCY = 8

      for (let i = 0; i < ids.length; i += CONCURRENCY) {
        const slice = ids.slice(i, i + CONCURRENCY)
        const batch = await Promise.all(
          slice.map(async (id) => {
            try {
              const film = await tmdbGet(`/movie/${id}`, {}, tmdbKey)

              // TMDB reports 0 for plenty of films; treat that as absent
              // rather than storing a runtime of zero minutes.
              const runtime = Number(film.runtime)

              // Names, not ids. /movie/{id} already resolves them, and
              // the player side has no way to look ids up — the genre
              // list is behind this function's admin check.
              const genres: string[] = Array.isArray(film.genres)
                ? film.genres
                    .map((g: { name?: string }) => g?.name)
                    .filter((name: unknown): name is string => typeof name === 'string')
                : []

              return {
                tmdb_id: id,
                runtime: Number.isFinite(runtime) && runtime > 0 ? runtime : null,
                genres,
              }
            } catch {
              // One unavailable film must not fail the whole import.
              return { tmdb_id: id, runtime: null, genres: [] }
            }
          }),
        )
        details.push(...batch)
      }

      return ok({ details })
    }

    let raw: TmdbMovie[] = []

    if (action === 'search') {
      const q = String(body.q ?? '').trim()
      if (!q) return ok({ results: [] })

      const data = await tmdbGet('/search/movie', { query: q, include_adult: 'false', page: '1' }, tmdbKey)
      raw = data.results ?? []
    } else if (action === 'discover') {
      const limit = Math.min(Number(body.limit) || PAGE_SIZE, MAX_LIMIT)
      const pages = Math.ceil(limit / PAGE_SIZE)

      const params: Record<string, string> = {
        include_adult: 'false',
        sort_by: String(body.sort ?? 'vote_average.desc'),
        // Without a vote floor, sort_by=vote_average.desc returns
        // obscure films with a single 10/10 rating.
        'vote_count.gte': '300',
      }

      if (body.genre) params.with_genres = String(body.genre)

      if (body.decade) {
        const start = Number(body.decade)
        params['primary_release_date.gte'] = `${start}-01-01`
        params['primary_release_date.lte'] = `${start + 9}-12-31`
      }

      for (let page = 1; page <= pages; page++) {
        const data = await tmdbGet('/discover/movie', { ...params, page: String(page) }, tmdbKey)
        raw.push(...(data.results ?? []))
        if ((data.results ?? []).length < PAGE_SIZE) break
      }

      raw = raw.slice(0, limit)
    } else {
      return fail(`unknown action: ${action || '(none)'}`, 400)
    }

    // TMDB pagination is not stable. With sort_by=vote_average.desc a
    // great many films tie, and the result window shifts between the
    // page requests above, so the same film can arrive on two pages.
    // Left in, that breaks the import outright rather than cosmetically:
    // ON CONFLICT DO UPDATE cannot affect the same row twice in one
    // statement, so one duplicate fails the whole upsert.
    const seen = new Set<number>()
    raw = raw.filter((m) => {
      if (seen.has(m.id)) return false
      seen.add(m.id)
      return true
    })

    // A card with no poster is not worth dealing, so drop those here
    // rather than letting the admin add a film the deck can't render.
    const trimmed = raw.filter((m) => m.poster_path).map(trim)

    if (trimmed.length === 0) return ok({ results: [] })

    const { data: existing, error: poolError } = await supabase
      .from('movies')
      .select('tmdb_id, retired_at')
      .in(
        'tmdb_id',
        trimmed.map((m) => m.tmdb_id),
      )

    if (poolError) return fail(`pool lookup failed: ${poolError.message}`, 500)

    const state = new Map<number, string | null>()
    for (const row of existing ?? []) state.set(row.tmdb_id, row.retired_at)

    const results: Trimmed[] = trimmed.map((m) => ({
      ...m,
      in_pool: state.has(m.tmdb_id) && state.get(m.tmdb_id) === null,
      retired: state.has(m.tmdb_id) && state.get(m.tmdb_id) !== null,
    }))

    return ok({ results })
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'unknown error', 502)
  }
})
