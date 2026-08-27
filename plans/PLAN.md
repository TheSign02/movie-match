# Reel Consensus — Build Spec

Mobile web app. Two people swipe the same 20 films; they see only the films
they both liked. One admin (the owner) curates the film pool.

This document is the source of truth for implementation. Companion file:
`Movie_Match.html` — visual design reference, 10 frames, contains the
authoritative token block.

---

## 1. Scope

### In scope (v1)
- Admin curates a pool of 60–100+ films from TMDB
- Two players join a lobby via a 4-character code
- Each session draws 20 random films from the pool, frozen in order
- Both swipe like/pass; matches revealed only when both finish
- Reload-safe: progress survives refresh, tab kill, and app backgrounding

### Explicitly out of scope
- More than 2 players per session
- Player accounts, signup, or email
- Excluding films a pair has already swiped (needs a `couples` concept
  above sessions — deferred to v2)
- Undo on a swipe
- Live partner progress ("they're on film 14 of 20")
- Either player viewing the other's individual likes
- Any "decide together" / random-picker step after results
- Native apps, push notifications, offline mode

### Non-negotiable product rules
1. A player can **never** read the other player's swipe rows. Enforced in
   Postgres, not in the client.
2. Matches are unavailable until **both** players have finished.
3. The deck is frozen per session. Admin edits mid-round must not change
   what either player sees.
4. Both players see identical films in identical order.

---

## 2. Stack

| Layer | Choice |
|---|---|
| Framework | React 18 + Vite |
| Styling | Tailwind CSS, tokens as CSS custom properties |
| Routing | React Router |
| Backend | Supabase — Postgres, Auth, Realtime, Edge Functions |
| Movie data | TMDB API v3 |
| Hosting | Vercel or Netlify (static SPA) |
| Targets | Android Chrome, iOS Safari (portrait, 390×844 baseline) |

No state management library. React state plus Supabase queries is enough
at this size.

---

## 3. Design system

Tokens live in the `:root` block at the top of `Movie_Match.html`. Port
that block verbatim into `src/styles/tokens.css` and import it once in
`main.tsx`. Do not introduce loose hex values anywhere in components.

Summary of the palette:

```
bg-page    #000000   bg-card   #191B22   bg-sunken #22252E   bg-raised #23262F
border     #2E323C (default)  #464B57 (strong)  #22252E (subtle)
text       #FFFFFF #EAEBF0 #D7D9E1 #C0C4CC #9AA0AC #6C7280 #464B57
accent     #1FC13C   active #17A431   soft #79E39B
pass       #E85555
```

The accent is deliberately brighter than the corporate brand green
`#16B632`, which reads muddy at small sizes on true black. Keep the
comment explaining this attached to the token.

**Type:** Roboto only, weights 400/500/700/900, loaded as a webfont.
Chrome on Windows/Android ships Roboto locally but iOS Safari does not —
without the webfont, iOS silently falls back to SF and metrics drift.

Tailwind config should expose the tokens rather than duplicate them:

```js
// tailwind.config.js
theme: {
  extend: {
    colors: {
      page:   'var(--bg-page)',
      card:   'var(--bg-card)',
      sunken: 'var(--bg-sunken)',
      accent: 'var(--accent)',
      pass:   'var(--pass)',
      // …
    },
    fontFamily: { sans: ['Roboto', 'system-ui', 'sans-serif'] },
  }
}
```

---

## 4. Data model

```sql
-- ─── admins ────────────────────────────────────────────────
-- Membership here is the only thing that grants write access
-- to the film pool. Rows inserted by hand in the dashboard.
create table admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- ─── movies ────────────────────────────────────────────────
create table movies (
  id          uuid primary key default gen_random_uuid(),
  tmdb_id     integer not null unique,
  title       text    not null,
  year        integer,
  poster_path text,              -- TMDB path only, e.g. /abc123.jpg
  overview    text,
  added_at    timestamptz not null default now()
);

create index movies_added_at_idx on movies (added_at desc);

-- ─── sessions ──────────────────────────────────────────────
create type session_status as enum ('waiting', 'swiping', 'complete');

create table sessions (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  status     session_status not null default 'waiting',
  movie_ids  uuid[] not null,     -- frozen deck, ordered
  created_at timestamptz not null default now()
);

create index sessions_code_idx on sessions (code);

-- ─── players ───────────────────────────────────────────────
create table players (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references sessions(id) on delete cascade,
  slot         smallint not null check (slot in (1, 2)),
  user_id      uuid not null references auth.users(id),
  display_name text not null,
  finished_at  timestamptz,
  unique (session_id, slot),
  unique (session_id, user_id)
);

create index players_user_idx on players (user_id);

-- ─── swipes ────────────────────────────────────────────────
create table swipes (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  player_id  uuid not null references players(id) on delete cascade,
  movie_id   uuid not null references movies(id),
  liked      boolean not null,
  created_at timestamptz not null default now(),
  unique (player_id, movie_id)
);

create index swipes_player_idx on swipes (player_id);
```

### Why `movie_ids` is an array, not a join table
The deck must be **ordered** and **immutable** once the session starts.
An array gives both for free and makes "what's the 7th card" a single
index lookup. A join table would need an explicit `position` column and
invites accidental mutation.

### Why there is no `swipe_count` column
An earlier draft had one, to drive a live partner-progress bar. That
feature was cut, so the column and its trigger are gone. The count of a
player's own swipe rows is the resume cursor and needs no denormalisation.

---

## 5. Row Level Security

Enable RLS on every table. **A table with RLS enabled and zero policies
denies everything** — that's the correct failure direction, but it will
produce a confusing empty array at least once during development.

```sql
alter table admins  enable row level security;
alter table movies  enable row level security;
alter table sessions enable row level security;
alter table players enable row level security;
alter table swipes  enable row level security;

-- ─── movies: world-readable, admin-writable ───────────────
create policy "movies readable by all"
  on movies for select
  using (true);

create policy "movies writable by admins"
  on movies for all
  using  (exists (select 1 from admins where user_id = auth.uid()))
  with check (exists (select 1 from admins where user_id = auth.uid()));

-- ─── admins: readable only by admins ──────────────────────
create policy "admins self-readable"
  on admins for select
  using (user_id = auth.uid());

-- ─── sessions: readable if you're in it ───────────────────
-- Lookup-by-code happens inside join_session (security definer),
-- so no policy is needed for the pre-join case.
create policy "sessions readable by participants"
  on sessions for select
  using (exists (
    select 1 from players
    where players.session_id = sessions.id
      and players.user_id = auth.uid()
  ));

-- ─── players: participants see each other ─────────────────
-- Deliberately exposes display_name and finished_at to the partner.
-- Both are needed by the lobby and waiting screens. No swipe data here.
create policy "players readable by participants"
  on players for select
  using (exists (
    select 1 from players p2
    where p2.session_id = players.session_id
      and p2.user_id = auth.uid()
  ));

create policy "players update self"
  on players for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ─── swipes: yours and yours alone ────────────────────────
create policy "swipes select own"
  on swipes for select
  using (exists (
    select 1 from players
    where players.id = swipes.player_id
      and players.user_id = auth.uid()
  ));

create policy "swipes insert own"
  on swipes for insert
  with check (exists (
    select 1 from players
    where players.id = swipes.player_id
      and players.user_id = auth.uid()
  ));
```

Note there is **no update or delete policy on `swipes`**. Undo was cut, so
a swipe is write-once. This also means the client should not attempt an
upsert — a plain insert is correct, and a duplicate is a bug worth
surfacing rather than silently swallowing.

---

## 6. Server functions

Session creation and joining are RPCs rather than client inserts, because
both need to do things a client must not be trusted with: sample the deck,
generate a unique code, and enforce the two-player cap atomically.

### `generate_code()` — internal helper

```sql
create or replace function generate_code()
returns text
language plpgsql
as $$
declare
  -- No 0/O, 1/I/L. Codes get read aloud.
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  candidate text;
  attempts int := 0;
begin
  loop
    candidate := '';
    for i in 1..4 loop
      candidate := candidate ||
        substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;

    exit when not exists (select 1 from sessions where code = candidate);

    attempts := attempts + 1;
    if attempts > 50 then
      raise exception 'could not generate a unique code';
    end if;
  end loop;

  return candidate;
end;
$$;
```

### `create_session(p_display_name text, p_deck_size int default 20)`

```sql
create or replace function create_session(
  p_display_name text,
  p_deck_size int default 20
)
returns table (session_id uuid, code text, player_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deck  uuid[];
  v_code  text;
  v_sess  uuid;
  v_player uuid;
  v_pool_count int;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if coalesce(trim(p_display_name), '') = '' then
    raise exception 'display name required';
  end if;

  select count(*) into v_pool_count from movies;
  if v_pool_count < p_deck_size then
    raise exception 'pool has % films, need at least %',
      v_pool_count, p_deck_size;
  end if;

  -- Sample the deck. random() ordering is fine at this table size.
  select array_agg(id) into v_deck
  from (select id from movies order by random() limit p_deck_size) s;

  v_code := generate_code();

  insert into sessions (code, movie_ids)
  values (v_code, v_deck)
  returning id into v_sess;

  insert into players (session_id, slot, user_id, display_name)
  values (v_sess, 1, auth.uid(), trim(p_display_name))
  returning id into v_player;

  return query select v_sess, v_code, v_player;
end;
$$;
```

### `join_session(p_code text, p_display_name text)`

```sql
create or replace function join_session(
  p_code text,
  p_display_name text
)
returns table (session_id uuid, player_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sess uuid;
  v_status session_status;
  v_taken int;
  v_existing uuid;
  v_player uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select id, status into v_sess, v_status
  from sessions
  where code = upper(trim(p_code));

  if v_sess is null then
    raise exception 'no lobby with that code';
  end if;

  -- Already in this session? Idempotent rejoin.
  select id into v_existing
  from players
  where session_id = v_sess and user_id = auth.uid();

  if v_existing is not null then
    return query select v_sess, v_existing;
    return;
  end if;

  if v_status <> 'waiting' then
    raise exception 'that round has already started';
  end if;

  select count(*) into v_taken from players where session_id = v_sess;
  if v_taken >= 2 then
    raise exception 'that lobby is full';
  end if;

  insert into players (session_id, slot, user_id, display_name)
  values (v_sess, 2, auth.uid(), trim(p_display_name))
  returning id into v_player;

  return query select v_sess, v_player;
end;
$$;
```

### `start_session(p_session_id uuid)`

Either player may start once both are present.

```sql
create or replace function start_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  if not exists (
    select 1 from players
    where session_id = p_session_id and user_id = auth.uid()
  ) then
    raise exception 'not a participant';
  end if;

  select count(*) into v_count from players where session_id = p_session_id;
  if v_count < 2 then
    raise exception 'waiting for the second player';
  end if;

  update sessions set status = 'swiping'
  where id = p_session_id and status = 'waiting';
end;
$$;
```

### `get_matches(p_session_id uuid)` — the privacy gate

```sql
create or replace function get_matches(p_session_id uuid)
returns table (
  movie_id    uuid,
  title       text,
  year        integer,
  poster_path text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Caller must be a participant.
  if not exists (
    select 1 from players
    where session_id = p_session_id and user_id = auth.uid()
  ) then
    raise exception 'not a participant';
  end if;

  -- Both must have finished. This is the whole point of the function.
  if (select count(*) from players
      where session_id = p_session_id and finished_at is not null) < 2 then
    raise exception 'results are not ready yet';
  end if;

  return query
  select m.id, m.title, m.year, m.poster_path
  from swipes s1
  join swipes s2
    on s2.movie_id = s1.movie_id
   and s2.session_id = s1.session_id
   and s2.player_id <> s1.player_id
  join movies m on m.id = s1.movie_id
  where s1.session_id = p_session_id
    and s1.liked and s2.liked
  group by m.id, m.title, m.year, m.poster_path;
end;
$$;
```

### `finish_deck()` and the completion trigger

The client marks itself finished; Postgres decides when the round is over.

```sql
create or replace function finish_deck(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update players
  set finished_at = now()
  where session_id = p_session_id
    and user_id = auth.uid()
    and finished_at is null;
end;
$$;

create or replace function check_session_complete()
returns trigger
language plpgsql
as $$
begin
  if new.finished_at is not null then
    if (select count(*) from players
        where session_id = new.session_id
          and finished_at is not null) = 2 then
      update sessions set status = 'complete' where id = new.session_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger players_completion
  after update of finished_at on players
  for each row execute function check_session_complete();
```

### `liked_count(p_session_id uuid)`

Used by the waiting screen ("You liked 9 films"). Returns only the
caller's own count — no partner data.

```sql
create or replace function liked_count(p_session_id uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::int
  from swipes s
  join players p on p.id = s.player_id
  where s.session_id = p_session_id
    and p.user_id = auth.uid()
    and s.liked;
$$;
```

---

## 7. Auth

### Admin (one person — the owner)
- Email + password, created **by hand** in the Supabase dashboard
- A matching row inserted into `admins`
- No signup route exists in the app
- `/admin` renders a normal login form; the route is not secret and does
  not need to be. RLS is the boundary.

Do **not** gate admin with a hardcoded frontend password or an
unguessable URL. The anon key is public by design; only RLS actually
stops a write.

### Players
- `supabase.auth.signInAnonymously()` on first load if no session exists
- JWT persists in localStorage, so `auth.uid()` is stable across reloads
- No email, no password, no profile

Anonymous sign-ins must be **enabled in the dashboard** — off by default.

---

## 8. TMDB integration

The API key never reaches the client. One Edge Function proxies both admin
operations.

`supabase/functions/tmdb/index.ts`

| Action | Purpose |
|---|---|
| `search?q=` | Title search for deliberate additions |
| `discover?sort=&genre=&decade=&limit=` | Bulk import, up to 50 at a time |

Requirements:
- Verify the caller is in `admins` before doing anything. An Edge Function
  bypasses RLS unless you check explicitly.
- Read the key from `Deno.env.get('TMDB_API_KEY')`
- Return a trimmed shape: `tmdb_id`, `title`, `year`, `poster_path`,
  `overview`. Nothing else is needed.
- Mark results already in the pool so the admin UI can show them greyed
  with a checkmark (dedupe on `tmdb_id`)

Poster URLs are built client-side from the stored path:

```
https://image.tmdb.org/t/p/w500{poster_path}   // cards, tiles
https://image.tmdb.org/t/p/w185{poster_path}   // admin thumbnails
```

TMDB's terms require visible attribution. Put it in the admin footer and
somewhere unobtrusive on the player side.

### Bulk import matters
Curation-by-the-players breaks the game: people add films they already
want to see, so either everything matches or a list-based product replaces
the swipe. Admin-only curation moves the problem rather than solving it —
the admin also plays, and knows the pool.

Two things fix it, and both are in scope:
1. A pool large enough (60–100+) that a random 20 is genuinely unknown
2. Bulk import, so neither person hand-picked most of the library

---

## 9. Routes and the resume state machine

```
/                 Home — name entry, create or join
/join             Name + 4-char code
/lobby/:code      Code display, player list, start
/swipe/:sessionId Deck
/waiting/:sessionId  Finished, partner hasn't
/results/:sessionId  Matches, or no-overlap
/admin            Login → pool management
```

### Resume logic

Reload safety comes from two decisions already made: the anonymous session
persists in localStorage, and **every swipe is written immediately**.

The resume cursor needs no extra state:

```
resume_index = count(swipes where player_id = me)
```

The deck order is frozen server-side, so that index lands on exactly the
card the player was on.

Write one function used by every entry point — first load, reload, and
someone opening a share link:

```ts
async function resolveRoute(sessionId: string) {
  const session = await fetchSession(sessionId);
  const me      = await fetchMyPlayer(sessionId);

  if (!me)                          return '/';               // not a participant
  if (session.status === 'waiting') return `/lobby/${session.code}`;
  if (session.status === 'complete')return `/results/${sessionId}`;
  if (me.finished_at)               return `/waiting/${sessionId}`;
  return `/swipe/${sessionId}`;     // resume at count(my swipes)
}
```

Store the last active `sessionId` in localStorage so a cold open of `/`
can offer to rejoin rather than dumping the player on the home screen.

### Edge cases

| Case | Behaviour |
|---|---|
| Reload mid-deck | Resume at the same card. Free. |
| Tab killed by iOS | Same. This is why swipes are never batched. |
| Cleared storage / new phone | New anonymous user, so a stranger to the session. Both slots full → show "that lobby is full". Acceptable in v1. |
| PWA vs Safari | Standalone mode has a separate storage jar; the installed app is a different anonymous user than the browser tab. Know this before shipping the manifest. |
| Partner abandons mid-round | **The one state with no exit.** Waiting screen needs an escape hatch: after ~3 minutes, offer to end the round and reveal partial matches. Decide the exact wording when building screen 04. |

---

## 10. Screens

Refer to `Movie_Match.html` for exact layout. Frame numbers below match it.

### 01 Home
Name input, "Create a lobby" (primary), "Join a lobby" (ghost). Ambient
green radial glow top-left. Wordmark at 52px.

Creating calls `create_session` → navigate to `/lobby/:code`.

### 01b Join
Name input **and** 4-char code entry. Both required — player 2 sets their
name here, player 1 set theirs on Home. Code input: uppercase, 4 cells,
auto-advance, `inputMode="text"`, `autoCapitalize="characters"`. Paste of
a full code should distribute across cells.

Calls `join_session` → navigate to `/lobby/:code`.

### 02 / 02b Lobby
Code at 76px with a green text-shadow glow. Copy code + Share link
buttons (`navigator.share` where available, clipboard fallback). Player
rows: filled for present players, dashed with animated dots for the empty
slot. Start button is `btn--off` until both are in, then `btn--primary`.

Realtime: subscribe to `players` inserts for this session.

### 03 Swipe deck
Top bar: close, progress track, `n/20` counter. Card stack: two static
rotated backs plus the live card. Bottom: pass and like, 76px circles,
34px apart (the gap is wider than the original design because undo was
removed from between them).

Each swipe: insert immediately, then advance. On the last card, call
`finish_deck` → `/waiting/:sessionId`.

### 03b Drag cues
Reference frames only. Card tilts with a colour wash and a LIKE/PASS
stamp; opacity ramps to 1 over 110px of travel.

### 04 Waiting
Pulsing rings and a breathing dot. Headline "That's your twenty done."
Subcopy names the partner but uses they/their. Own like count via
`liked_count`. **No partner progress** — that was cut.

Realtime: subscribe to this session's `status`. Flip to `complete` →
navigate to results.

### 05 Results
Eyebrow, match count as a 56px figure, 2-column scrolling grid of poster
tiles at 256px tall (the correct height for a 2:3 poster at that column
width), plus a dashed "Swipe another twenty" tile. No footer bar — the
"decide together" button was cut and the grid runs to the bottom edge.

Data from `get_matches`.

### 05b Results, no overlap
Two tilted poster shapes, "No overlap this round.", both like counts (the
totals only — never which films), and a single primary action to start
another round.

### 06 Admin
Search field, TMDB results with ADD buttons and an "in pool" greyed
state, then the current pool as a removable list.

Changed from the original design: **no SHUFFLE button** (order is
per-session now, so pool order means nothing), **no SAVE POOL button**
(writes are immediate), and the counter shows the pool total —
`84 films` — not `20 / 20`.

Add a bulk-import control alongside search: pick top-rated / genre /
decade, preview, add up to 50 at once.

Same route at every width. No separate desktop build — one admin, who
will naturally use a laptop because typing searches is faster there.

---

## 11. Swipe mechanics

Pointer Events with `setPointerCapture` — one code path for touch, mouse
and pen, and it behaves correctly on both iOS Safari and Chrome. The
working prototype is in the `<script>` block of `Movie_Match.html`; port
it rather than reaching for a gesture library.

```
threshold  95px of travel   → commit
flick      0.55 px/ms       → commit regardless of travel
rotation   translateX / 22  degrees
vertical   damped to 0.35 of pointer delta
exit       ±520px, 220ms, then swap card content
```

The velocity check matters: a fast short flick is a real gesture that a
distance-only threshold ignores.

Required CSS on the card: `touch-action: none` and `user-select: none`.

Render the live card plus two static backs. Preload the next 2–3 poster
images so a swipe never reveals an empty card.

---

## 12. Realtime

Two subscriptions in the whole app.

| Where | Table | Fires on | Effect |
|---|---|---|---|
| Lobby | `players` | insert, this session | Second player appears, Start enables |
| Waiting | `sessions` | update, this session | `status = 'complete'` → go to results |

Everything else is a plain query. Enable Realtime on `players` and
`sessions` in the dashboard; leave it off for `swipes` — nothing should be
listening to those, and enabling it widens the surface for no reason.

---

## 13. Mobile constraints

- **`dvh`, not `vh`.** `100vh` on iOS Safari includes the URL bar, so a
  full-height card layout gets clipped.
- **`overscroll-behavior: none`** on `html, body`. Safari's pull-to-refresh
  and rubber-banding otherwise fight the swipe gesture.
- **Safe areas:** `env(safe-area-inset-top / bottom)` for the notch and
  home indicator. The fixed 16px/34px in the design file are mimicry —
  replace them.
- **Do not build the mock OS chrome.** The status bar (21:14, battery) and
  the 134×5 home-indicator pill in the design frames are drawing only.
- **Minimum 44px tap targets.** Primary controls sit in the bottom third,
  within thumb reach.
- **PWA manifest** for Add to Home Screen: portrait-locked, black theme
  colour, standalone display.
- Add `<meta name="viewport" content="width=device-width, initial-scale=1,
  viewport-fit=cover">` — `viewport-fit=cover` is required for
  `env(safe-area-inset-*)` to report real values.

---

## 14. Environment

Client (`.env`, committed as `.env.example` with blanks):

```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

Edge Function secrets (set via CLI, never in the repo):

```
TMDB_API_KEY=
```

The anon key is safe to expose — it's designed to be public, and RLS is
what protects the data. The TMDB key is not; that's why it lives behind
the Edge Function.

---

## 15. Build order

1. **Schema and RLS.** Run the migrations. Write a throwaway script that
   attempts, as player A, to read player B's swipes — confirm it returns
   empty. Do this before building any UI; the whole privacy model rests on
   it and it's much harder to verify later.
2. **Tokens and shell.** Port the token block, Tailwind config, Roboto,
   base layout, safe-area handling. No features.
3. **Admin.** Login, Edge Function, search, add/remove, bulk import.
   Nothing else works without a pool, and this is where you'll discover
   TMDB's response shape.
4. **Lobby.** Create, join, code input, player list, realtime join,
   start. First point at which two phones talk to each other.
5. **Deck.** Port the swipe logic, per-swipe writes, finish, resume.
6. **Waiting and results.** `get_matches`, both result states, abandonment
   escape hatch.
7. **Mobile polish.** Real posters, scrim retuning, PWA manifest,
   two-device testing on both browsers.

### Wire up a real poster at step 3, not step 7
Every image in the design is a CSS gradient placeholder. Real TMDB posters
are busy, high-contrast, and frequently carry burned-in title text. The
card's bottom scrim (`rgba(0,0,0,.97)` → transparent at 62%) will very
likely need to be heavier, and the 256px result tiles need checking
against real 2:3 crops. Finding that out in step 3 is cheap; finding out
in step 7 means retuning finished screens.

---

## 16. Gotchas

- **Never batch swipes.** iOS Safari discards backgrounded tabs
  aggressively; batched state dies with them. Per-swipe writes also make
  resume free.
- **RLS with no policies denies everything.** Expect at least one
  "why is this an empty array" session.
- **Edge Functions bypass RLS.** The TMDB proxy must check `admins`
  itself.
- **`security definer` functions need `set search_path = public`,**
  or they're vulnerable to search-path manipulation.
- **Codes get read aloud.** The alphabet excludes 0/O and 1/I/L. Compare
  and store uppercase.
- **`upper(trim(code))`** on every lookup — people type lowercase and
  paste with whitespace.
- **`get_matches` must stay `security definer`** and keep both its guards.
  It's the only thing standing between a player and their partner's likes.

---

## 17. Manual setup (cannot be done by Claude Code)

These require a browser and a human. Do them before step 1.

1. Create a Supabase project; record the URL and anon key
2. **Enable anonymous sign-ins** (Authentication → Providers) — off by
   default, and nothing works without it
3. Create the admin user by hand (Authentication → Users → Add user),
   with email confirmation already ticked
4. Insert that user's UUID into `admins`
5. Get a TMDB API key (free, requires an account and a stated use case)
6. Set the Edge Function secret: `supabase secrets set TMDB_API_KEY=…`
7. Enable Realtime on `players` and `sessions` only
8. Create the hosting project, add the two `VITE_` env vars
9. Optional: point a domain at it
