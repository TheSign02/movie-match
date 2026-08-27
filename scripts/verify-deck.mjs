/**
 * The phase 5 gate: does the deck resume where it was left, and does
 * the round close out correctly?
 *
 * Run:
 *   npm run verify:deck
 *
 * The resume tests here are the server half of what §15 asks for —
 * that the cursor is right after 7 swipes, that it survives a fresh
 * client with no local state at all, and that finishing is idempotent.
 * The tab-kill and backgrounding tests still have to happen on a phone;
 * this proves there is nothing for those to get wrong.
 */

import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const URL = process.env.VITE_SUPABASE_URL
const ANON = process.env.VITE_SUPABASE_ANON_KEY

if (!URL || !ANON) {
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.')
  process.exit(1)
}

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

/** Mirrors fetchDeck in src/lib/deck.ts: `in` does not preserve order. */
async function fetchDeck(client, movieIds) {
  const { data, error } = await client
    .from('movies')
    .select('id, title, year, poster_path, overview')
    .in('id', movieIds)

  if (error) throw new Error(error.message)
  const byId = new Map((data ?? []).map((r) => [r.id, r]))
  return movieIds.map((id) => byId.get(id)).filter(Boolean)
}

async function swipeCount(client, playerId) {
  const { count, error } = await client
    .from('swipes')
    .select('*', { count: 'exact', head: true })
    .eq('player_id', playerId)

  if (error) throw new Error(error.message)
  return count ?? 0
}

async function main() {
  console.log('Reel Consensus — deck and resume verification')
  console.log(`Target: ${URL}\n`)

  sql(`
    insert into movies (tmdb_id, title, year, poster_path, overview)
    select -9000 - n, 'VERIFY FIXTURE ' || lpad(n::text, 2, '0'), 1970 + n,
           '/f' || n || '.jpg', 'fixture overview'
    from generate_series(1, 22) as g(n)
    on conflict (tmdb_id) do nothing;
  `)

  const A = await anonUser()
  const B = await anonUser()

  try {
    section('Setup')

    const created = await A.client.rpc('create_session', { p_display_name: 'Ada' })
    check('session created', !created.error, created.error?.message ?? '')
    if (created.error) return

    const { session_id: sessionId, code, player_id: playerA } = created.data[0]
    const joined = await B.client.rpc('join_session', { p_code: code, p_display_name: 'Grace' })
    const playerB = joined.data[0].player_id
    await A.client.rpc('start_session', { p_session_id: sessionId })
    check('round started', true)

    const sessionRow = await A.client
      .from('sessions')
      .select('movie_ids')
      .eq('id', sessionId)
      .single()
    const movieIds = sessionRow.data.movie_ids

    section('Deck order')

    const deckA = await fetchDeck(A.client, movieIds)
    const deckB = await fetchDeck(B.client, movieIds)

    check('deck has 20 films', deckA.length === 20, `got ${deckA.length}`)
    check(
      'the reordered deck matches movie_ids exactly',
      JSON.stringify(deckA.map((f) => f.id)) === JSON.stringify(movieIds),
    )
    check(
      'both players build an identical deck',
      JSON.stringify(deckA.map((f) => f.id)) === JSON.stringify(deckB.map((f) => f.id)),
    )
    check(
      'every card carries what the card renders',
      deckA.every((f) => f.title && f.poster_path && typeof f.overview === 'string'),
    )

    section('Resume cursor')

    // Seven swipes, exactly the scenario §15 asks to test by hand.
    for (let i = 0; i < 7; i++) {
      const { error } = await A.client.from('swipes').insert({
        session_id: sessionId,
        player_id: playerA,
        movie_id: movieIds[i],
        liked: i % 2 === 0,
      })
      if (error) throw new Error(`swipe ${i} failed: ${error.message}`)
    }

    const cursor = await swipeCount(A.client, playerA)
    check('after 7 swipes the cursor is 7', cursor === 7, `got ${cursor}`)
    check(
      'the cursor points at the 8th film',
      deckA[cursor].id === movieIds[7],
      `${deckA[cursor].id} vs ${movieIds[7]}`,
    )

    // A brand new client with no localStorage at all — the closest this
    // can get to a killed tab. Same user, so the same JWT identity.
    const fresh = newClient()
    await fresh.auth.setSession({
      access_token: (await A.client.auth.getSession()).data.session.access_token,
      refresh_token: (await A.client.auth.getSession()).data.session.refresh_token,
    })
    const freshCursor = await swipeCount(fresh, playerA)
    check(
      'a client with no local state resumes at the same card',
      freshCursor === 7,
      `got ${freshCursor}`,
    )

    const dupe = await A.client.from('swipes').insert({
      session_id: sessionId,
      player_id: playerA,
      movie_id: movieIds[3],
      liked: true,
    })
    check('re-swiping a film is refused, not silently accepted', !!dupe.error)

    const cursorAfterDupe = await swipeCount(A.client, playerA)
    check('a refused duplicate does not move the cursor', cursorAfterDupe === 7)

    section('Finishing')

    for (let i = 7; i < 20; i++) {
      const { error } = await A.client.from('swipes').insert({
        session_id: sessionId,
        player_id: playerA,
        movie_id: movieIds[i],
        liked: i < 12,
      })
      if (error) throw new Error(`swipe ${i} failed: ${error.message}`)
    }
    check('all 20 swiped', (await swipeCount(A.client, playerA)) === 20)

    await A.client.rpc('finish_deck', { p_session_id: sessionId })

    const midStatus = await A.client.from('sessions').select('status').eq('id', sessionId).single()
    check(
      'one player finishing does not complete the round',
      midStatus.data.status === 'swiping',
      `status ${midStatus.data.status}`,
    )

    const liked = await A.client.rpc('liked_count', { p_session_id: sessionId })
    // Liked: indices 0,2,4,6 from the first seven, then 7..11.
    check('liked_count reports the caller own total', liked.data === 9, `got ${liked.data}`)

    // finish_deck is what the deck screen calls after the last swipe,
    // and a reload can call it again. It must not double-fire the
    // completion trigger or reset finished_at.
    const again = await A.client.rpc('finish_deck', { p_session_id: sessionId })
    check('finishing twice is harmless', !again.error, again.error?.message ?? '')

    const myRow = await A.client
      .from('players')
      .select('finished_at')
      .eq('id', playerA)
      .single()
    check('finished_at is set', myRow.data.finished_at !== null)

    for (let i = 0; i < 20; i++) {
      const { error } = await B.client.from('swipes').insert({
        session_id: sessionId,
        player_id: playerB,
        movie_id: movieIds[i],
        liked: i >= 5 && i < 15,
      })
      if (error) throw new Error(`B swipe ${i} failed: ${error.message}`)
    }
    await B.client.rpc('finish_deck', { p_session_id: sessionId })

    const endStatus = await A.client.from('sessions').select('status').eq('id', sessionId).single()
    check(
      'both finishing completes the round',
      endStatus.data.status === 'complete',
      `status ${endStatus.data.status}`,
    )

    const matches = await A.client.rpc('get_matches', { p_session_id: sessionId })
    // A liked 0,2,4,6,7,8,9,10,11 (evens up to 6, then 7-11).
    // B liked 5-14. Overlap is 6,7,8,9,10,11 — six films.
    const expected = [6, 7, 8, 9, 10, 11].map((i) => movieIds[i]).sort()
    const got = (matches.data ?? []).map((m) => m.movie_id).sort()

    check('matches are the six films both liked', got.length === 6, `got ${got.length}`)
    check(
      'and they are the right six',
      JSON.stringify(got) === JSON.stringify(expected),
    )
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
