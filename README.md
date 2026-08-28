# Reel Consensus

Mobile web app. Two people swipe the same 20 films; they see only the films they
both liked. One admin curates the film pool.

`plans/PLAN.md` is the build spec and the source of truth.
`plans/Movie_Match.html` is the visual reference and holds the authoritative
token block.

## Stack

React 19 + Vite 8, Tailwind 4, React Router 7, Supabase (Postgres, Auth,
Realtime, Edge Functions), TMDB API v3.

Versions differ from the spec's table, which names React 18 and a Tailwind 3
style `tailwind.config.js`. The colour mapping lives in an `@theme inline`
block in `src/index.css` instead; the instruction it implements — reference the
tokens, never duplicate them — is unchanged.

## Setup

```bash
npm install
cp .env.example .env      # fill in both VITE_ values
npm run dev
```

`.env` needs the project URL and the **anon** key. The anon key is public by
design; RLS is what protects the data. The TMDB key never goes in a `VITE_`
variable — it lives only in the Edge Function's environment.

Things that need a browser and a person, once per project:

1. Create the Supabase project; record the URL and anon key
2. **Enable anonymous sign-ins** (Authentication → Providers). Off by default,
   and nothing on the player side works without it
3. Create the admin user by hand (Authentication → Users → Add user), with
   email confirmation ticked
4. Get a TMDB API key (free, needs an account and a stated use case)

Then, from the CLI:

```bash
supabase link --project-ref <ref>
npm run db:push
supabase db query --linked "insert into admins (user_id) \
  select id from auth.users where email = 'you@example.com';"
supabase secrets set TMDB_API_KEY=...
npm run fn:deploy
```

Realtime is enabled by the migration, on `players` and `sessions` only — no
dashboard step. `swipes` stays off the publication deliberately: nothing
listens to it and enabling it would widen the surface for no reason.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server, bound to the LAN for phone testing |
| `npm run build` | Typecheck then production build |
| `npm run db:push` | Apply migrations to the linked project |
| `npm run db:advisors` | Supabase's security and performance linter |
| `npm run fn:deploy` | Deploy the TMDB Edge Function |
| `npm run icons` | Regenerate the PWA icons |
| `npm run verify:all` | All five verification suites |

### Verification suites

Each runs against the real remote project, seeds its own fixture films, and
cleans up after itself.

| Suite | Covers |
|---|---|
| `verify:privacy` | The four non-negotiable product rules. 45 checks |
| `verify:tmdb` | The Edge Function, its admin guard, and pool writes. 25 checks |
| `verify:lobby` | Two real clients, two realtime subscriptions. 14 checks |
| `verify:deck` | Deck order, the resume cursor, finishing. 20 checks |
| `verify:results` | Both result states and the escape hatch. 20 checks |

Anonymous sign-ins are rate limited to **30 an hour per IP**, and a full
`verify:all` spends about thirteen of them. Two runs back to back will
fail with `Request rate limit reached`, which is the limit doing its job
rather than a bug. Raise it at Authentication → Rate Limits if it gets in
the way.

`verify:privacy` is the one that matters most: it signs in as three separate
anonymous users and asserts what the server *refuses*. A player must never be
able to read the other player's swipe rows, and completing the round must not
change that.

`verify:tmdb` and `verify:results` need an admin, and get one without anyone's
password by promoting a throwaway anonymous user through the CLI, then demoting
it in a `finally` block.

## Deploying

Static SPA. `vercel.json` and `public/_redirects` both rewrite every route to
`index.html` — without that, refreshing `/lobby/K7R9` is a 404 and the resume
story falls over. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the
host's environment.

## Things worth knowing

- **Realtime is the fast path, not the guarantee.** The lobby and the
  waiting screen both poll behind their subscriptions, every 3s and 5s
  respectively. A `postgres_changes` event was seen going missing three
  times across a dozen runs of `verify:lobby` — the channel reported
  SUBSCRIBED, the partner joined, and nothing arrived — and it never
  reproduced in isolation. Without the poll, a dropped event strands a
  player on "waiting for player 2" with no way out but a manual refresh.
  `verify:lobby` asserts the realtime path and the refetch path
  separately, so a failure says which layer broke.
- **A PWA has its own storage jar.** The installed app is a *different*
  anonymous user than the browser tab on the same phone. Expected for v1, and
  confusing during testing if you don't know it.
- **Cleared storage means a new identity.** A player who clears site data is a
  stranger to their own session; with both slots full they get "that lobby is
  full". Accepted for v1.
- **Swipes are write-once.** No update or delete policy, and no update or
  delete grant. Undo was cut.
- **The pool wants 60+ films.** Two rounds of 20 drawn from a pool of N repeat
  400/N films on average, so 60 is roughly where a second round stops feeling
  like a rerun. 20 is the hard floor and is enforced in `create_session`.
