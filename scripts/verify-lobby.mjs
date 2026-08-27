/**
 * The phase 4 gate: does player 2 appear on player 1's screen without a
 * refresh, and does either player pressing Start move the other one?
 *
 * Run:
 *   npm run verify:lobby
 *
 * This is the part a single browser cannot test. Two real clients, two
 * real realtime subscriptions, and assertions that the events arrive
 * rather than that the code that would send them exists.
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

/**
 * A one-shot realtime event catcher.
 *
 * The timer starts when wait() is called, not when the catcher is
 * created: a handler has to be registered on the channel before the
 * triggering action, but the clock should only run while something is
 * actually waiting. An event that arrived before wait() resolves
 * immediately rather than being lost.
 */
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

/** Channel subscription is async; waiting avoids a race with the insert. */
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

async function main() {
  console.log('Reel Consensus — lobby and realtime verification')
  console.log(`Target: ${URL}\n`)

  sql(`
    insert into movies (tmdb_id, title, year, poster_path, overview)
    select -9000 - n, 'VERIFY FIXTURE ' || n, 1970 + n, '/f' || n || '.jpg', 'fixture'
    from generate_series(1, 22) as g(n)
    on conflict (tmdb_id) do nothing;
  `)

  const A = await anonUser()
  const B = await anonUser()

  let sessionId = null

  try {
    section('Create and join')

    const created = await A.client.rpc('create_session', { p_display_name: 'Ada' })
    check('player 1 creates a lobby', !created.error, created.error?.message ?? '')
    if (created.error) return

    const { session_id, code } = created.data[0]
    sessionId = session_id
    console.log(`        code ${code}`)

    // Player 1 is now sitting in the lobby with a live subscription, the
    // state this whole phase is about.
    const playerInsert = catcher('players INSERT on player 1')
    const startEventForA = catcher('sessions UPDATE on player 1')

    const channelA = A.client
      .channel(`lobby:${sessionId}:a`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'players', filter: `session_id=eq.${sessionId}` },
        (payload) => playerInsert.settle(payload.new),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` },
        (payload) => startEventForA.settle(payload.new),
      )

    await subscribed(channelA)
    check('player 1 subscribes to the lobby channel', true)

    const joined = await B.client.rpc('join_session', {
      p_code: `  ${code.toLowerCase()} `,
      p_display_name: 'Grace',
    })
    check('player 2 joins', !joined.error, joined.error?.message ?? '')

    section('Realtime — player 2 appears without a refresh')

    let insertedRow = null
    try {
      insertedRow = await playerInsert.wait()
      check('the players INSERT reaches player 1 over the wire', true)
    } catch (err) {
      check('the players INSERT reaches player 1 over the wire', false, err.message)
    }

    if (insertedRow) {
      check(
        'the event carries the joining player, in slot 2',
        insertedRow.display_name === 'Grace' && insertedRow.slot === 2,
        `slot ${insertedRow.slot}, name ${insertedRow.display_name}`,
      )
      check(
        'the event carries no swipe data',
        !('liked' in insertedRow) && !('movie_id' in insertedRow),
      )
    }

    const seen = await A.client.from('players').select('slot, display_name').order('slot')
    check(
      'player 1 now reads both players',
      seen.data?.length === 2,
      `${seen.data?.length} rows`,
    )

    section('Realtime — either player may start')

    // Player 2 also needs to move when player 1 presses Start, which is
    // the subscription §12 does not list for the lobby.
    const startEventForB = catcher('sessions UPDATE on player 2')
    const channelB = B.client
      .channel(`lobby:${sessionId}:b`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` },
        (payload) => startEventForB.settle(payload.new),
      )

    await subscribed(channelB)

    const started = await A.client.rpc('start_session', { p_session_id: sessionId })
    check('player 1 starts the round', !started.error, started.error?.message ?? '')

    try {
      const row = await startEventForB.wait()
      check(
        'player 2 is told the round started, without polling',
        row.status === 'swiping',
        `status ${row.status}`,
      )
    } catch (err) {
      check('player 2 is told the round started, without polling', false, err.message)
    }

    try {
      const row = await startEventForA.wait()
      check('the starter gets the same event', row.status === 'swiping', `status ${row.status}`)
    } catch (err) {
      check('the starter gets the same event', false, err.message)
    }

    section('Lobby edge cases')

    const rejoin = await B.client.rpc('join_session', { p_code: code, p_display_name: 'Grace' })
    check(
      'rejoining a running round is idempotent, not an error',
      !rejoin.error && rejoin.data?.[0]?.session_id === sessionId,
      rejoin.error?.message ?? '',
    )

    const C = await anonUser()
    const late = await C.client.rpc('join_session', { p_code: code, p_display_name: 'Carol' })
    check(
      'a stranger cannot join a running round',
      !!late.error && /already started/i.test(late.error.message),
      late.error?.message ?? '(no error)',
    )

    const strangerLobby = await C.client.from('sessions').select('code').eq('code', code)
    check(
      'a stranger reading the lobby by code gets nothing',
      strangerLobby.data?.length === 0,
      `${strangerLobby.data?.length} rows`,
    )

    const badCode = await C.client.rpc('join_session', { p_code: 'zzzz', p_display_name: 'Carol' })
    check(
      'a lowercase unknown code is refused cleanly',
      !!badCode.error && /no lobby/i.test(badCode.error.message),
      badCode.error?.message ?? '',
    )

    await A.client.removeChannel(channelA)
    await B.client.removeChannel(channelB)
  } finally {
    sql(`
      delete from sessions
      where movie_ids && (select coalesce(array_agg(id), '{}') from movies where tmdb_id < 0);
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
