/**
 * Exercises the tmdb Edge Function and the admin write path against the
 * real project, before any UI is built on top of them.
 *
 * Run:
 *   npm run verify:tmdb
 *
 * Getting an admin JWT without anyone's password: sign in anonymously,
 * promote that throwaway user by inserting its id into admins through
 * the CLI, then demote and delete everything it created. The 403 path is
 * checked first, while the user is still just a player.
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

/** The CLI reaches the database through the Management API, no password. */
function sql(statement) {
  return execFileSync('supabase', ['db', 'query', '--linked', statement], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * functions.invoke buries the response body inside the error, which is
 * where every message from index.ts lives.
 */
async function invoke(client, body) {
  const { data, error } = await client.functions.invoke('tmdb', { body })
  if (!error) return { data, status: 200, message: null }

  let message = error.message
  let status = 0
  if (error.context && typeof error.context.json === 'function') {
    status = error.context.status ?? 0
    try {
      const parsed = await error.context.json()
      if (parsed?.error) message = parsed.error
    } catch {
      /* non-JSON body, keep error.message */
    }
  }
  return { data: null, status, message }
}

async function main() {
  console.log('Reel Consensus — TMDB proxy verification')
  console.log(`Target: ${URL}\n`)

  const client = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const { data: signIn, error: signInError } = await client.auth.signInAnonymously()
  if (signInError) throw new Error(`anonymous sign-in failed: ${signInError.message}`)
  const userId = signIn.user.id
  console.log(`Throwaway user ${userId}`)

  const addedTmdbIds = []

  try {
    // ─── the guard, while this user is still nobody ──────────────────

    section('Admin guard')

    const asPlayer = await invoke(client, { action: 'search', q: 'past lives' })
    check(
      'a signed-in non-admin is refused',
      asPlayer.status === 403 && /not an admin/i.test(asPlayer.message ?? ''),
      `status ${asPlayer.status}: ${asPlayer.message}`,
    )

    const anonClient = createClient(URL, ANON, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const asAnon = await invoke(anonClient, { action: 'search', q: 'past lives' })
    check(
      'a caller with no session is refused',
      asAnon.status === 401 || asAnon.status === 403,
      `status ${asAnon.status}: ${asAnon.message}`,
    )

    // ─── promote ────────────────────────────────────────────────────

    sql(`insert into admins (user_id) values ('${userId}') on conflict do nothing;`)
    const isAdmin = await client.rpc('is_admin')
    check('promotion took effect', isAdmin.data === true, `is_admin returned ${isAdmin.data}`)

    // ─── search ─────────────────────────────────────────────────────

    section('Search')

    const search = await invoke(client, { action: 'search', q: 'past lives' })
    check('search returns results', !!search.data?.results?.length, search.message ?? '')

    const hits = search.data?.results ?? []
    if (hits.length) {
      console.log(`        top hit: ${hits[0].title} (${hits[0].year}) ${hits[0].poster_path}`)
      check(
        'every result carries the trimmed shape and nothing else',
        hits.every(
          (h) =>
            Object.keys(h).sort().join(',') ===
            'in_pool,overview,poster_path,retired,title,tmdb_id,year',
        ),
        `keys: ${Object.keys(hits[0]).sort().join(',')}`,
      )
      check(
        'every result has a poster path',
        hits.every((h) => typeof h.poster_path === 'string' && h.poster_path.startsWith('/')),
      )
      check(
        'year is a number or null, never 0',
        hits.every((h) => h.year === null || (Number.isInteger(h.year) && h.year > 1800)),
      )
      check('nothing is marked in_pool yet', hits.every((h) => h.in_pool === false))
    }

    const empty = await invoke(client, { action: 'search', q: '   ' })
    check('a blank query returns an empty list, not an error', empty.data?.results?.length === 0)

    // ─── genres ─────────────────────────────────────────────────────

    section('Genres')

    const genres = await invoke(client, { action: 'genres' })
    check('genre list comes back', (genres.data?.genres?.length ?? 0) > 10, genres.message ?? '')

    // ─── discover / bulk import ─────────────────────────────────────

    section('Bulk import')

    const bulk = await invoke(client, { action: 'discover', sort: 'vote_average.desc', limit: 50 })
    const bulkResults = bulk.data?.results ?? []
    check('discover returns close to 50', bulkResults.length >= 40, `got ${bulkResults.length}`)
    check(
      'no duplicate tmdb_ids across the pages',
      new Set(bulkResults.map((r) => r.tmdb_id)).size === bulkResults.length,
    )
    check('the 50 cap holds', bulkResults.length <= 50, `got ${bulkResults.length}`)

    const decade = await invoke(client, {
      action: 'discover',
      sort: 'vote_average.desc',
      decade: 1990,
      limit: 20,
    })
    const decadeResults = decade.data?.results ?? []
    check(
      'a decade filter really constrains the years',
      decadeResults.length > 0 && decadeResults.every((r) => r.year >= 1990 && r.year <= 1999),
      decadeResults.length ? `years ${Math.min(...decadeResults.map((r) => r.year))}–${Math.max(...decadeResults.map((r) => r.year))}` : 'no results',
    )

    const badAction = await invoke(client, { action: 'nope' })
    check('an unknown action is rejected', badAction.status === 400, `status ${badAction.status}`)

    // ─── writing to the pool as an admin ────────────────────────────

    section('Pool writes')

    const toAdd = bulkResults.slice(0, 3).map((m) => ({
      tmdb_id: m.tmdb_id,
      title: m.title,
      year: m.year,
      poster_path: m.poster_path,
      overview: m.overview,
    }))
    addedTmdbIds.push(...toAdd.map((m) => m.tmdb_id))

    const insert = await client.from('movies').insert(toAdd)
    check('an admin can add films', !insert.error, insert.error?.message ?? '')

    const reSearch = await invoke(client, {
      action: 'discover',
      sort: 'vote_average.desc',
      limit: 20,
    })
    const marked = (reSearch.data?.results ?? []).filter((r) => addedTmdbIds.includes(r.tmdb_id))
    check(
      'films already in the pool come back marked in_pool',
      marked.length === 3 && marked.every((m) => m.in_pool === true && m.retired === false),
      `${marked.length} of 3 marked`,
    )

    // Re-adding the same film has to be an un-retire, not a collision.
    const first = addedTmdbIds[0]
    const retire = await client
      .from('movies')
      .update({ retired_at: new Date().toISOString() })
      .eq('tmdb_id', first)
    check('an admin can retire a film', !retire.error, retire.error?.message ?? '')

    const afterRetire = await invoke(client, {
      action: 'discover',
      sort: 'vote_average.desc',
      limit: 20,
    })
    const retiredHit = (afterRetire.data?.results ?? []).find((r) => r.tmdb_id === first)
    check(
      'a retired film reads as retired, not as in_pool',
      retiredHit?.retired === true && retiredHit?.in_pool === false,
      `in_pool=${retiredHit?.in_pool} retired=${retiredHit?.retired}`,
    )

    const unretire = await client
      .from('movies')
      .upsert({ ...toAdd[0], retired_at: null }, { onConflict: 'tmdb_id' })
    check('re-adding un-retires instead of colliding', !unretire.error, unretire.error?.message ?? '')

    const activeCount = await client
      .from('movies')
      .select('*', { count: 'exact', head: true })
      .is('retired_at', null)
    check('all three are active again', activeCount.count === 3, `count ${activeCount.count}`)
  } finally {
    // ─── demote and clean up, whatever happened above ───────────────
    sql(`delete from admins where user_id = '${userId}';`)
    if (addedTmdbIds.length) {
      sql(`delete from movies where tmdb_id in (${addedTmdbIds.join(',')});`)
    }
    console.log('\nDemoted the throwaway user and removed its films.')
  }

  const leftover = await createClient(URL, ANON)
    .from('movies')
    .select('*', { count: 'exact', head: true })
  console.log(`Pool now holds ${leftover.count ?? 0} films.`)

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
