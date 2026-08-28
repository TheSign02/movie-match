import { supabase } from './supabase'

export type Match = {
  movie_id: string
  title: string
  year: number | null
  poster_path: string | null
}

export type LikedCount = {
  player_id: string
  display_name: string
  liked: number
}

/**
 * The privacy gate. Refuses with 'not a participant' or 'results are
 * not ready yet' — both written to be shown to a player as they are.
 */
export async function fetchMatches(sessionId: string): Promise<Match[]> {
  const { data, error } = await supabase.rpc('get_matches', { p_session_id: sessionId })
  if (error) throw new Error(error.message)
  return (data as Match[]) ?? []
}

/**
 * Both players' totals, for the no-overlap screen. Behind the same
 * both-finished gate as get_matches, so it cannot become the live
 * partner progress the product cut.
 */
export async function fetchLikedCounts(sessionId: string): Promise<LikedCount[]> {
  const { data, error } = await supabase.rpc('liked_counts', { p_session_id: sessionId })
  if (error) throw new Error(error.message)
  return (data as LikedCount[]) ?? []
}

/**
 * Another twenty, for the same two people.
 *
 * Idempotent per finished round: the first caller creates the new
 * session with both players already in it, and the second caller is
 * handed that same session. Calling create_session here instead would
 * give each player their own lobby, each waiting for a partner sitting
 * in the other one.
 */
export async function rematch(sessionId: string): Promise<{ sessionId: string; code: string }> {
  const { data, error } = await supabase.rpc('rematch', { p_session_id: sessionId })
  if (error) throw new Error(error.message)

  const row = (data as { session_id: string; code: string }[])[0]
  if (!row) throw new Error('rematch returned nothing')
  return { sessionId: row.session_id, code: row.code }
}

/** Ends the round for a partner who stopped swiping (PLAN.md §9). */
export async function abandonRound(sessionId: string): Promise<void> {
  const { error } = await supabase.rpc('abandon_round', { p_session_id: sessionId })
  if (error) throw new Error(error.message)
}
