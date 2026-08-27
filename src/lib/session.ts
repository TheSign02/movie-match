import { supabase } from './supabase'

export type SessionStatus = 'waiting' | 'swiping' | 'complete'

export type GameSession = {
  id: string
  code: string
  status: SessionStatus
  movie_ids: string[]
  created_at: string
}

export type Player = {
  id: string
  session_id: string
  slot: number
  user_id: string
  display_name: string
  finished_at: string | null
}

/* ─── local remembering ──────────────────────────────────────────────
   A cold open of / should be able to offer a rejoin rather than dumping
   someone who was mid-round back on the home screen (PLAN.md §9). The
   name is kept for the same reason: nobody wants to retype it for a
   second round.
   ─────────────────────────────────────────────────────────────────── */

const LAST_SESSION_KEY = 'reel:lastSessionId'
const NAME_KEY = 'reel:displayName'

/** localStorage throws in private mode on some browsers; never let that break a render. */
function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    /* nothing to do; the app works without it */
  }
}

export const lastSessionId = () => read(LAST_SESSION_KEY)
export const rememberSession = (id: string | null) => write(LAST_SESSION_KEY, id)
export const savedName = () => read(NAME_KEY) ?? ''
export const rememberName = (name: string) => write(NAME_KEY, name.trim())

/* ─── RPCs ─────────────────────────────────────────────────────────── */

/** Postgres raise exception messages arrive as error.message and are written for humans. */
function rpcError(error: { message: string } | null): never | void {
  if (error) throw new Error(error.message)
}

export async function createSession(displayName: string) {
  const { data, error } = await supabase.rpc('create_session', {
    p_display_name: displayName,
  })
  rpcError(error)

  const row = (data as { session_id: string; code: string; player_id: string }[])[0]
  if (!row) throw new Error('create_session returned nothing')

  rememberSession(row.session_id)
  rememberName(displayName)
  return row
}

export async function joinSession(code: string, displayName: string) {
  const { data, error } = await supabase.rpc('join_session', {
    p_code: code,
    p_display_name: displayName,
  })
  rpcError(error)

  const row = (data as { session_id: string; player_id: string }[])[0]
  if (!row) throw new Error('join_session returned nothing')

  rememberSession(row.session_id)
  rememberName(displayName)
  return row
}

export async function startSession(sessionId: string) {
  const { error } = await supabase.rpc('start_session', { p_session_id: sessionId })
  rpcError(error)
}

/* ─── reads ────────────────────────────────────────────────────────── */

/**
 * Both of these return null rather than throwing when there is no row,
 * because "no row" is the normal answer for someone who is not a
 * participant — RLS filters the session out entirely.
 */
export async function fetchSessionByCode(code: string): Promise<GameSession | null> {
  const { data, error } = await supabase
    .from('sessions')
    .select('id, code, status, movie_ids, created_at')
    .eq('code', code.toUpperCase().trim())
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data
}

export async function fetchSessionById(id: string): Promise<GameSession | null> {
  const { data, error } = await supabase
    .from('sessions')
    .select('id, code, status, movie_ids, created_at')
    .eq('id', id)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data
}

export async function fetchPlayers(sessionId: string): Promise<Player[]> {
  const { data, error } = await supabase
    .from('players')
    .select('id, session_id, slot, user_id, display_name, finished_at')
    .eq('session_id', sessionId)
    .order('slot')

  if (error) throw new Error(error.message)
  return data ?? []
}

export async function fetchMyPlayer(sessionId: string, userId: string): Promise<Player | null> {
  const players = await fetchPlayers(sessionId)
  return players.find((p) => p.user_id === userId) ?? null
}

/**
 * The single entry point for deciding where someone belongs — first
 * load, reload, or a share link (PLAN.md §9).
 *
 * The deck screen resumes at count(my swipes), which needs no state
 * here: the deck order is frozen server-side, so that index lands on
 * exactly the card they were on.
 */
export async function resolveRoute(sessionId: string, userId: string): Promise<string> {
  const session = await fetchSessionById(sessionId)
  if (!session) return '/' // not a participant, or the session is gone

  const me = await fetchMyPlayer(sessionId, userId)
  if (!me) return '/'

  if (session.status === 'waiting') return `/lobby/${session.code}`
  if (session.status === 'complete') return `/results/${sessionId}`
  if (me.finished_at) return `/waiting/${sessionId}`
  return `/swipe/${sessionId}`
}
