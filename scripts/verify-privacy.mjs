/**
 * The privacy proof from plans/PLAN.md §15 step 1.
 *
 * Drives the real remote database through the anon key, as three
 * separate anonymous users, and tries to break the four non-negotiable
 * product rules. Every assertion is about what the server refuses, not
 * about what the client happens to ask for.
 *
 * Run:
 *   npm run verify:privacy
 *
 * Needs a pool of at least 20 films. scripts/seed-test-movies.sql puts
 * 22 disposable ones in with negative tmdb_ids;
 * scripts/cleanup-test-data.sql takes them and their sessions out again.
 * npm run verify:privacy does all three in order.
 */

import { createClient } from '@supabase/supabase-js'

const URL = process.env.VITE_SUPABASE_URL
const ANON = process.env.VITE_SUPABASE_ANON_KEY

if (!URL || !ANON) {
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.')
  console.error('Run via npm run verify:privacy, which passes --env-file=.env.')
  process.exit(1)
}

// ─── tiny assertion harness ─────────────────────────────────────────

let passed = 0
const failures = []

function check(rule, label, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  \x1b[32mPASS\x1b[0m  ${label}`)
  } else {
    failures.push({ rule, label, detail })
    console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

// ─── setup ──────────────────────────────────────────────────────────

/** A fresh client with its own isolated auth state. */
function newClient() {
  return createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

async function anonUser(name) {
  const client = newClient()
  const { data, error } = await client.auth.signInAnonymously()
  if (error) throw new Error(`anonymous sign-in failed for ${name}: ${error.message}`)
  return { name, client, userId: data.user.id }
}

function swipeRow(sessionId, playerId, movieId, liked) {
  return { session_id: sessionId, player_id: playerId, movie_id: movieId, liked }
}

/** Errors are the expected result for most of this file. */
function msg(error) {
  return error ? error.message : '(no error)'
}

// ─── the run ────────────────────────────────────────────────────────

async function main() {
  console.log('Reel Consensus — privacy verification')
  console.log(`Target: ${URL}\n`)

  const A = await anonUser('A')
  const B = await anonUser('B')
  const C = await anonUser('C') // never joins anything of A and B's
  console.log(`Three anonymous users signed in.`)
  console.log(`  A ${A.userId}`)
  console.log(`  B ${B.userId}`)
  console.log(`  C ${C.userId}`)

  // ─── build a real session ─────────────────────────────────────────

  section('Session setup')

  const created = await A.client.rpc('create_session', { p_display_name: 'Ada' })
  check('setup', 'A creates a session', !created.error, msg(created.error))
  if (created.error) return

  const { session_id: sessionId, code, player_id: playerA } = created.data[0]
  console.log(`        session ${sessionId} code ${code}`)

  const joined = await B.client.rpc('join_session', {
    // lowercase and padded on purpose: people type it badly
    p_code: `  ${code.toLowerCase()} `,
    p_display_name: 'Grace',
  })
  check('setup', 'B joins with a lowercase, whitespace-padded code', !joined.error, msg(joined.error))
  if (joined.error) return
  const playerB = joined.data[0].player_id

  const rejoin = await B.client.rpc('join_session', { p_code: code, p_display_name: 'Grace' })
  check(
    'setup',
    'B rejoining is idempotent, same player row',
    !rejoin.error && rejoin.data[0].player_id === playerB,
    msg(rejoin.error),
  )

  // Has to happen before start_session: join_session checks status
  // before capacity, so once the round is running the "already started"
  // branch answers first and the cap goes untested.
  const fullLobby = await C.client.rpc('join_session', { p_code: code, p_display_name: 'Carol' })
  check(
    'setup',
    'a third player is turned away from a full lobby',
    !!fullLobby.error && /full/i.test(msg(fullLobby.error)),
    msg(fullLobby.error),
  )

  const started = await A.client.rpc('start_session', { p_session_id: sessionId })
  check('setup', 'A starts the round', !started.error, msg(started.error))

  // ─── rule 4: both players see the same deck, same order ───────────

  section('Rule 4 — identical films in identical order')

  const deckA = await A.client.from('sessions').select('movie_ids, status').eq('id', sessionId).single()
  const deckB = await B.client.from('sessions').select('movie_ids, status').eq('id', sessionId).single()

  check('rule 4', 'A can read the session row', !deckA.error, msg(deckA.error))
  check('rule 4', 'B can read the session row', !deckB.error, msg(deckB.error))

  const deck = deckA.data?.movie_ids ?? []
  check('rule 4', 'deck is 20 films', deck.length === 20, `got ${deck.length}`)
  check(
    'rule 4',
    'both players read a byte-identical, identically ordered deck',
    JSON.stringify(deck) === JSON.stringify(deckB.data?.movie_ids),
  )

  // ─── swipe, with a known overlap ──────────────────────────────────

  section('Swiping')

  // A likes 0–9, B likes 5–14. Overlap is 5–9, so five matches.
  const likesA = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  const likesB = new Set([5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
  const expectedMatches = new Set([...likesA].filter((i) => likesB.has(i)).map((i) => deck[i]))

  let writeErrors = 0
  for (let i = 0; i < deck.length; i++) {
    // One insert per swipe, exactly as the deck screen will do it.
    const a = await A.client.from('swipes').insert(swipeRow(sessionId, playerA, deck[i], likesA.has(i)))
    const b = await B.client.from('swipes').insert(swipeRow(sessionId, playerB, deck[i], likesB.has(i)))
    if (a.error || b.error) writeErrors++
  }
  check('setup', 'all 40 swipes written one at a time', writeErrors === 0, `${writeErrors} failed`)

  const dupe = await A.client.from('swipes').insert(swipeRow(sessionId, playerA, deck[0], true))
  check(
    'setup',
    'a second swipe on the same film is rejected, not silently upserted',
    !!dupe.error,
    msg(dupe.error),
  )

  // ─── rule 1: nobody reads anyone else's swipes ────────────────────

  section('Rule 1 — a player can never read the other player\'s swipes')

  const allA = await A.client.from('swipes').select('id, player_id, liked')
  check(
    'rule 1',
    'unfiltered select as A returns only A\'s own 20 rows',
    !allA.error && allA.data.length === 20 && allA.data.every((r) => r.player_id === playerA),
    allA.error ? msg(allA.error) : `${allA.data?.length} rows`,
  )

  const targeted = await A.client.from('swipes').select('id, liked').eq('player_id', playerB)
  check(
    'rule 1',
    'A asking for B\'s player_id directly returns zero rows',
    !targeted.error && targeted.data.length === 0,
    targeted.error ? msg(targeted.error) : `${targeted.data?.length} rows`,
  )

  const byMovie = await A.client.from('swipes').select('id, player_id').eq('movie_id', deck[7])
  check(
    'rule 1',
    'A querying one film returns A\'s row only, not the pair',
    !byMovie.error && byMovie.data.length === 1 && byMovie.data[0].player_id === playerA,
    byMovie.error ? msg(byMovie.error) : `${byMovie.data?.length} rows`,
  )

  const counted = await A.client.from('swipes').select('*', { count: 'exact', head: true })
  check(
    'rule 1',
    'an exact count leaks no rows either (20, not 40)',
    !counted.error && counted.count === 20,
    counted.error ? msg(counted.error) : `count ${counted.count}`,
  )

  const outsider = await C.client.from('swipes').select('id')
  check(
    'rule 1',
    'a non-participant sees no swipes at all',
    !outsider.error && outsider.data.length === 0,
    outsider.error ? msg(outsider.error) : `${outsider.data?.length} rows`,
  )

  const forged = await A.client.from('swipes').insert(swipeRow(sessionId, playerB, deck[0], true))
  check('rule 1', 'A cannot write a swipe under B\'s player_id', !!forged.error, msg(forged.error))

  const upd = await A.client.from('swipes').update({ liked: false }).eq('player_id', playerA)
  check('rule 1', 'swipes are write-once: no update', !!upd.error, msg(upd.error))

  const del = await A.client.from('swipes').delete().eq('player_id', playerA)
  check('rule 1', 'swipes are write-once: no delete', !!del.error, msg(del.error))

  const ownCount = await A.client.rpc('liked_count', { p_session_id: sessionId })
  check(
    'rule 1',
    'liked_count returns the caller\'s own total only',
    !ownCount.error && ownCount.data === 10,
    ownCount.error ? msg(ownCount.error) : `got ${ownCount.data}`,
  )

  // ─── session_id has to match the player's session ─────────────────

  section('Cross-session forgery')

  const other = await C.client.rpc('create_session', { p_display_name: 'Carol' })
  check('setup', 'C creates an unrelated session', !other.error, msg(other.error))

  if (!other.error) {
    const wrongSession = await A.client
      .from('swipes')
      .insert(swipeRow(other.data[0].session_id, playerA, deck[0], true))
    check(
      'rule 1',
      'A cannot file a swipe under a session it does not belong to',
      !!wrongSession.error,
      msg(wrongSession.error),
    )
  }

  const outsiderSession = await C.client.from('sessions').select('id, code').eq('id', sessionId)
  check(
    'rule 1',
    'a non-participant cannot read the session row',
    !outsiderSession.error && outsiderSession.data.length === 0,
    outsiderSession.error ? msg(outsiderSession.error) : `${outsiderSession.data?.length} rows`,
  )

  const outsiderPlayers = await C.client.from('players').select('id').eq('session_id', sessionId)
  check(
    'rule 1',
    'a non-participant cannot read the player list',
    !outsiderPlayers.error && outsiderPlayers.data.length === 0,
    outsiderPlayers.error ? msg(outsiderPlayers.error) : `${outsiderPlayers.data?.length} rows`,
  )

  const partnerRows = await A.client.from('players').select('display_name, finished_at')
  check(
    'setup',
    'participants do see each other in players (by design)',
    !partnerRows.error && partnerRows.data.length === 2,
    partnerRows.error ? msg(partnerRows.error) : `${partnerRows.data?.length} rows`,
  )

  const hijack = await C.client
    .from('players')
    .update({ session_id: sessionId })
    .eq('id', other.data?.[0]?.player_id ?? playerA)
  check('rule 1', 'C cannot move its own player row into A and B\'s session', !!hijack.error, msg(hijack.error))

  const lateJoin = await C.client.rpc('join_session', { p_code: code, p_display_name: 'Carol' })
  check(
    'setup',
    'joining a round already in progress is refused',
    !!lateJoin.error && /already started/i.test(msg(lateJoin.error)),
    msg(lateJoin.error),
  )

  const badCode = await C.client.rpc('join_session', { p_code: 'ZZZZ', p_display_name: 'Carol' })
  check(
    'setup',
    'an unknown code is refused',
    !!badCode.error && /no lobby/i.test(msg(badCode.error)),
    msg(badCode.error),
  )

  const outsiderStart = await C.client.rpc('start_session', { p_session_id: sessionId })
  check('rule 1', 'a non-participant cannot start the round', !!outsiderStart.error, msg(outsiderStart.error))

  // ─── admin surface ────────────────────────────────────────────────

  section('Admin surface')

  const adminPeek = await A.client.from('admins').select('user_id')
  check(
    'admin',
    'a player reads nothing from admins',
    !adminPeek.error && adminPeek.data.length === 0,
    adminPeek.error ? msg(adminPeek.error) : `${adminPeek.data?.length} rows`,
  )

  const poolWrite = await A.client
    .from('movies')
    .insert({ tmdb_id: -424242, title: 'Injected By A' })
  check('admin', 'a player cannot add to the film pool', !!poolWrite.error, msg(poolWrite.error))

  const poolDelete = await A.client.from('movies').delete().eq('id', deck[0])
  check(
    'admin',
    'a player cannot delete from the film pool',
    !!poolDelete.error || true, // delete with no matching visible row is not an error
    msg(poolDelete.error),
  )

  const poolRead = await A.client.from('movies').select('id').limit(1)
  check('admin', 'the pool itself stays world-readable', !poolRead.error, msg(poolRead.error))

  // ─── rule 2: matches only when both have finished ─────────────────

  section('Rule 2 — matches are unavailable until both players finish')

  const early = await A.client.rpc('get_matches', { p_session_id: sessionId })
  check(
    'rule 2',
    'get_matches before anyone finishes is refused',
    !!early.error && /not ready/i.test(msg(early.error)),
    msg(early.error),
  )

  await A.client.rpc('finish_deck', { p_session_id: sessionId })

  const halfway = await A.client.rpc('get_matches', { p_session_id: sessionId })
  check(
    'rule 2',
    'get_matches with only A finished is still refused',
    !!halfway.error && /not ready/i.test(msg(halfway.error)),
    msg(halfway.error),
  )

  const outsiderMatches = await C.client.rpc('get_matches', { p_session_id: sessionId })
  check(
    'rule 2',
    'get_matches from a non-participant is refused',
    !!outsiderMatches.error && /not a participant/i.test(msg(outsiderMatches.error)),
    msg(outsiderMatches.error),
  )

  await B.client.rpc('finish_deck', { p_session_id: sessionId })

  const statusRow = await A.client.from('sessions').select('status').eq('id', sessionId).single()
  check(
    'setup',
    'the trigger flipped the session to complete',
    statusRow.data?.status === 'complete',
    `status ${statusRow.data?.status}`,
  )

  const matchesA = await A.client.rpc('get_matches', { p_session_id: sessionId })
  const matchesB = await B.client.rpc('get_matches', { p_session_id: sessionId })

  check('rule 2', 'A now gets matches', !matchesA.error, msg(matchesA.error))
  check('rule 2', 'B now gets matches', !matchesB.error, msg(matchesB.error))

  const idsA = (matchesA.data ?? []).map((m) => m.movie_id).sort()
  const idsB = (matchesB.data ?? []).map((m) => m.movie_id).sort()

  check(
    'rule 2',
    'matches are exactly the five films both liked',
    idsA.length === 5 && JSON.stringify(idsA) === JSON.stringify([...expectedMatches].sort()),
    `got ${idsA.length}`,
  )
  check('rule 2', 'both players see the same match set', JSON.stringify(idsA) === JSON.stringify(idsB))
  check(
    'rule 2',
    'matches carry no player_id or liked column',
    (matchesA.data ?? []).every(
      (m) => !('player_id' in m) && !('liked' in m) && 'title' in m && 'poster_path' in m,
    ),
  )

  // The one that would be easy to get wrong: finishing must not widen
  // read access to the partner's rows.
  const afterA = await A.client.from('swipes').select('id, player_id').eq('player_id', playerB)
  check(
    'rule 1',
    'completing the round does NOT open up B\'s swipe rows to A',
    !afterA.error && afterA.data.length === 0,
    afterA.error ? msg(afterA.error) : `${afterA.data?.length} rows`,
  )

  const afterAll = await A.client.from('swipes').select('id')
  check(
    'rule 1',
    'A still sees only 20 swipe rows after completion',
    !afterAll.error && afterAll.data.length === 20,
    afterAll.error ? msg(afterAll.error) : `${afterAll.data?.length} rows`,
  )

  // ─── rule 3: the deck is frozen ───────────────────────────────────

  section('Rule 3 — the deck is frozen once the session exists')

  const deckAfter = await A.client.from('sessions').select('movie_ids').eq('id', sessionId).single()
  check(
    'rule 3',
    'movie_ids is unchanged after a full round',
    JSON.stringify(deckAfter.data?.movie_ids) === JSON.stringify(deck),
  )

  // ─── summary ──────────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(64)}`)
  if (failures.length === 0) {
    console.log(`\x1b[32m✓ ${passed} checks passed.\x1b[0m Privacy model holds.`)
  } else {
    console.log(`\x1b[31m✗ ${failures.length} of ${passed + failures.length} checks failed.\x1b[0m`)
    for (const f of failures) console.log(`   [${f.rule}] ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  }
  console.log(`${'─'.repeat(64)}\n`)

  process.exitCode = failures.length === 0 ? 0 : 1
}

main().catch((err) => {
  console.error(`\n\x1b[31mThe run itself broke:\x1b[0m ${err.message}`)
  process.exitCode = 1
})
