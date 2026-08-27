import { supabase } from './supabase'

export type DeckFilm = {
  id: string
  title: string
  year: number | null
  poster_path: string | null
  overview: string
}

/**
 * The frozen deck, in the session's order.
 *
 * `in` does not preserve the order of the list it is given, and the
 * order is the whole point — both players must see identical films in
 * identical positions — so the rows are re-sorted against movie_ids
 * here rather than trusted as they arrive.
 */
export async function fetchDeck(movieIds: string[]): Promise<DeckFilm[]> {
  const { data, error } = await supabase
    .from('movies')
    .select('id, title, year, poster_path, overview')
    .in('id', movieIds)

  if (error) throw new Error(error.message)

  const byId = new Map((data ?? []).map((row) => [row.id, row]))
  return movieIds.map((id) => byId.get(id)).filter((row): row is DeckFilm => row !== undefined)
}

/**
 * The resume cursor, and it needs no stored state.
 *
 * Every swipe is written immediately and the deck order is frozen
 * server-side, so the count of a player's own swipe rows lands on
 * exactly the card they were on (PLAN.md §9).
 */
export async function fetchSwipeCount(playerId: string): Promise<number> {
  const { count, error } = await supabase
    .from('swipes')
    .select('*', { count: 'exact', head: true })
    .eq('player_id', playerId)

  if (error) throw new Error(error.message)
  return count ?? 0
}

/**
 * One insert per swipe. Never batched: iOS Safari discards backgrounded
 * tabs aggressively and batched state dies with them (§16).
 *
 * A plain insert, not an upsert — undo was cut, so a swipe is
 * write-once and a duplicate is a bug worth surfacing rather than
 * silently swallowing (§5).
 */
export async function recordSwipe(args: {
  sessionId: string
  playerId: string
  movieId: string
  liked: boolean
}): Promise<void> {
  const { error } = await supabase.from('swipes').insert({
    session_id: args.sessionId,
    player_id: args.playerId,
    movie_id: args.movieId,
    liked: args.liked,
  })

  if (error) throw new Error(error.message)
}

export async function finishDeck(sessionId: string): Promise<void> {
  const { error } = await supabase.rpc('finish_deck', { p_session_id: sessionId })
  if (error) throw new Error(error.message)
}

export async function fetchLikedCount(sessionId: string): Promise<number> {
  const { data, error } = await supabase.rpc('liked_count', { p_session_id: sessionId })
  if (error) throw new Error(error.message)
  return (data as number) ?? 0
}
