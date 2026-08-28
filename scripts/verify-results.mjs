/**
 * The phase 6 gate: the waiting screen's realtime handoff, both result
 * states, and the abandonment escape hatch.
 *
 * Run:
 *   npm run verify:results
 */

import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const URL = process.env.VITE_SUPABASE_URL
const ANON = process.env.VITE_SUPABASE_ANON_KEY

if (!URL || !ANON) {
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.')
  process.exit(1)
}

const EVENT_TIMEOUT_MS = 15_000

let passed = 0
const failures = []

function check(label, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  \x1b[32mPASS\x1b[0m  ${label}`)
  } else {
    failures.push({ label, detail })
    console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

function sql(statement) {
  return execFileSync('supabase', ['db', 'query', '--linked', statement], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Exact ids, so cleanup never guesses at which sessions were ours. */
const createdSessions = []

function newClient() {
  return createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

async function anonUser() {
  const client = newClient()
  const { data, error } = await client.auth.signInAnonymously()
  if (error) throw new Error(`anonymous sign-in failed: ${error.message}`)
  return { client, userId: data.user.id }
}

function catcher(label, timeoutMs = EVENT_TIMEOUT_MS) {
  let value
  let fired = false
  const waiters = []
  return {
    settle(next) {
      if (fired) return
      fired = true
      value = next
      for (const resolve of waiters) resolve(next)
    },
    wait() {
      if (fired) return Promise.resolve(value)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)),
          timeoutMs,
        )
        waiters.push((next) => {
          clearTimeout(timer)
          resolve(next)
        })
      })
    },
  }
}

function subscribed(channel) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('channel never subscribed')), EVENT_TIMEOUT_MS)
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timer)
        resolve()
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        clearTimeout(timer)
        reject(new Error(`channel status ${status}`))
      }
    })
  })
}

/**
 * Builds a finished round with a controllable overlap.
 *
 * Takes the two players rather than making new ones. A user may be in
 * any number of sessions — players is unique on (session_id, user_id) —
 * and anonymous sign-ins are rate limited to 30 an hour per IP, which a
 * suite that minted two users per round used to eat through.
 */
async function playRound(A, B, { likesA, likesB, finishB = true }) {
  const created = await A.client.rpc('create_session', { p_display_name: 'Ada' })
  if (created.error) throw new Error(created.error.message)
  const { session_id: sessionId, code, player_id: playerA } = created.data[0]
  createdSessions.push(sessionId)

  const joined = await B.client.rpc('join_session', { p_code: code, p_display_name: 'Grace' })
  if (joined.error) throw new Error(joined.error.message)
  const playerB = joined.data[0].player_id

  await A.client.rpc('start_session', { p_session_id: sessionId })

  const session = await A.client.from('sessions').select('movie_ids').eq('id', sessionId).single()
  const movieIds = session.data.movie_ids

  for (let i = 0; i < movieIds.length; i++) {
    await A.client
      .from('swipes')
      .insert({ session_id: sessionId, player_id: playerA, movie_id: movieIds[i], liked: likesA(i) })
    await B.client
      .from('swipes')
      .insert({ session_id: sessionId, player_id: playerB, movie_id: movieIds[i], liked: likesB(i) })
  }

  await A.client.rpc('finish_deck', { p_session_id: sessionId })
  if (finishB) await B.client.rpc('finish_deck', { p_session_id: sessionId })

  return { A, B, sessionId, movieIds, playerA, playerB }
}

async function main() {
  console.log('Movie Match — waiting and results verification')
  console.log(`Target: ${URL}\n`)

  sql(`
    insert into movies (tmdb_id, title, year, poster_path, overview, runtime, genres)
    select -9000 - n, 'VERIFY FIXTURE ' || lpad(n::text, 2, '0'), 1970 + n,
           '/f' || n || '.jpg', 'fixture overview', 90 + n,
           array['Drama', 'Romance', 'Thriller', 'Comedy']
    from generate_series(1, 22) as g(n)
    on conflict (tmdb_id) do nothing;
  `)

  // Three users for the whole suite. Every round below is played by the
  // same two people.
  const A = await anonUser()
  const B = await anonUser()
  const stranger = await anonUser()

  try {
    /* ─── the waiting screen's handoff ───────────────────────────── */

    section('Waiting — the realtime handoff')

    const created = await A.client.rpc('create_session', { p_display_name: 'Ada' })
    const { session_id: sessionId, code, player_id: playerA } = created.data[0]
    createdSessions.push(sessionId)
    const joined = await B.client.rpc('join_session', { p_code: code, p_display_name: 'Grace' })
    const playerB = joined.data[0].player_id
    await A.client.rpc('start_session', { p_session_id: sessionId })

    const session = await A.client.from('sessions').select('movie_ids').eq('id', sessionId).single()
    const movieIds = session.data.movie_ids

    for (let i = 0; i < 20; i++) {
      await A.client
        .from('swipes')
        .insert({ session_id: sessionId, player_id: playerA, movie_id: movieIds[i], liked: i < 9 })
    }
    await A.client.rpc('finish_deck', { p_session_id: sessionId })

    const own = await A.client.rpc('liked_count', { p_session_id: sessionId })
    check('the waiting screen can read its own like count', own.data === 9, `got ${own.data}`)

    const partnerTotals = await A.client.rpc('liked_counts', { p_session_id: sessionId })
    check(
      'it cannot read the partner totals while the round is live',
      !!partnerTotals.error && /not ready/i.test(partnerTotals.error.message),
      partnerTotals.error?.message ?? '(no error)',
    )

    const partnerRows = await A.client
      .from('swipes')
      .select('id')
      .eq('player_id', playerB)
    check(
      'and no partner progress is visible at all',
      partnerRows.data?.length === 0,
      `${partnerRows.data?.length} rows`,
    )

    const completed = catcher('sessions UPDATE to complete')
    const channel = A.client
      .channel(`waiting:${sessionId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` },
        (payload) => {
          if (payload.new.status === 'complete') completed.settle(payload.new)
        },
      )
    await subscribed(channel)

    for (let i = 0; i < 20; i++) {
      await B.client
        .from('swipes')
        .insert({ session_id: sessionId, player_id: playerB, movie_id: movieIds[i], liked: i >= 5 && i < 12 })
    }
    await B.client.rpc('finish_deck', { p_session_id: sessionId })

    try {
      await completed.wait()
      check('the partner finishing pushes the waiting screen to results', true)
    } catch (err) {
      check('the partner finishing pushes the waiting screen to results', false, err.message)
    }

    await A.client.removeChannel(channel)

    /* ─── frame 05 ───────────────────────────────────────────────── */

    section('Results — matches')

    const matches = await A.client.rpc('get_matches', { p_session_id: sessionId })
    // A liked 0-8, B liked 5-11. Overlap 5,6,7,8.
    check('the match count is right', matches.data?.length === 4, `got ${matches.data?.length}`)
    check(
      'each tile has what it needs to render',
      (matches.data ?? []).every((m) => m.title && m.poster_path && 'year' in m),
    )
    check(
      'and what the tap-to-expand detail needs',
      (matches.data ?? []).every((m) => 'overview' in m && 'runtime' in m),
      `keys: ${Object.keys((matches.data ?? [])[0] ?? {}).sort().join(',')}`,
    )
    // Same caveat as the deck: the pool is mostly real films, whose genre
    // counts vary. What matters is that the column survives get_matches.
    check(
      'and the genres for the chips, on the tile and the detail alike',
      (matches.data ?? []).every((m) => m.genres === null || Array.isArray(m.genres)),
      `first: ${JSON.stringify((matches.data ?? [])[0]?.genres)}`,
    )
    check(
      'with at least one match carrying some',
      (matches.data ?? []).some((m) => (m.genres ?? []).length > 0),
    )
    check(
      'and nothing it should not have',
      (matches.data ?? []).every((m) => !('liked' in m) && !('player_id' in m)),
    )

    const bothTotals = await A.client.rpc('liked_counts', { p_session_id: sessionId })
    check('liked_counts opens up once both have finished', !bothTotals.error, bothTotals.error?.message ?? '')
    check(
      'it returns one row per player, totals only',
      bothTotals.data?.length === 2 &&
        bothTotals.data.every((r) => typeof r.liked === 'number' && r.display_name),
    )
    check(
      'the totals are correct and per-player',
      bothTotals.data?.find((r) => r.display_name === 'Ada')?.liked === 9 &&
        bothTotals.data?.find((r) => r.display_name === 'Grace')?.liked === 7,
      JSON.stringify(bothTotals.data?.map((r) => [r.display_name, r.liked])),
    )

    /* ─── frame 05b ──────────────────────────────────────────────── */

    section('Results — no overlap')

    const zero = await playRound(A, B, {
      likesA: (i) => i < 10,
      likesB: (i) => i >= 10,
    })
    const zeroMatches = await A.client.rpc('get_matches', { p_session_id: zero.sessionId })
    check('a round with no overlap returns zero matches', zeroMatches.data?.length === 0)

    const zeroTotals = await A.client.rpc('liked_counts', { p_session_id: zero.sessionId })
    check(
      'both totals are still available for the no-overlap copy',
      zeroTotals.data?.length === 2 && zeroTotals.data.every((r) => r.liked === 10),
      JSON.stringify(zeroTotals.data?.map((r) => r.liked)),
    )

    /* ─── the escape hatch ───────────────────────────────────────── */

    section('Abandonment escape hatch')

    const stuck = await playRound(A, B, {
      likesA: (i) => i < 8,
      likesB: (i) => i >= 4 && i < 10,
      finishB: false,
    })

    const early = await A.client.rpc('get_matches', { p_session_id: stuck.sessionId })
    check(
      'matches are locked while the partner has not finished',
      !!early.error && /not ready/i.test(early.error.message),
      early.error?.message ?? '',
    )

    // The partner must not be able to end a round they have not finished.
    const abandonedByB = await B.client.rpc('abandon_round', {
      p_session_id: stuck.sessionId,
    })
    check(
      'someone who has not finished cannot end the round',
      !!abandonedByB.error && /finish your own/i.test(abandonedByB.error.message),
      abandonedByB.error?.message ?? '(no error)',
    )

    const abandonedByStranger = await stranger.client.rpc('abandon_round', {
      p_session_id: stuck.sessionId,
    })
    check('a stranger cannot end the round', !!abandonedByStranger.error)

    const abandoned = await A.client.rpc('abandon_round', { p_session_id: stuck.sessionId })
    check('the finished player can end the round', !abandoned.error, abandoned.error?.message ?? '')

    const afterStatus = await A.client
      .from('sessions')
      .select('status')
      .eq('id', stuck.sessionId)
      .single()
    check(
      'ending the round completes the session',
      afterStatus.data.status === 'complete',
      `status ${afterStatus.data.status}`,
    )

    const partial = await A.client.rpc('get_matches', { p_session_id: stuck.sessionId })
    // A liked 0-7, B liked 4-9 before stopping. Overlap 4,5,6,7.
    check(
      'partial matches are revealed from what the partner did swipe',
      partial.data?.length === 4,
      `got ${partial.data?.length}`,
    )

    const bStillBlind = await A.client
      .from('swipes')
      .select('id')
      .eq('player_id', stuck.playerB)
    check(
      'ending the round still does not expose the partner rows',
      bStillBlind.data?.length === 0,
      `${bStillBlind.data?.length} rows`,
    )

  } finally {
    sql(`
      delete from sessions where id in (${createdSessions.map((id) => `'${id}'`).join(', ') || "'00000000-0000-0000-0000-000000000000'"});
      delete from movies where tmdb_id < 0;
    `)
    console.log('\nFixtures and test sessions removed.')
  }

  console.log(`\n${'─'.repeat(64)}`)
  if (failures.length === 0) {
    console.log(`\x1b[32m✓ ${passed} checks passed.\x1b[0m`)
  } else {
    console.log(`\x1b[31m✗ ${failures.length} of ${passed + failures.length} checks failed.\x1b[0m`)
    for (const f of failures) console.log(`   ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  }
  console.log(`${'─'.repeat(64)}\n`)

  process.exitCode = failures.length === 0 ? 0 : 1
}

main().catch((err) => {
  console.error(`\n\x1b[31mThe run itself broke:\x1b[0m ${err.message}`)
  process.exitCode = 1
})
