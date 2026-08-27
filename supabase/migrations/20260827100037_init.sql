-- ═══════════════════════════════════════════════════════════════════
-- Reel Consensus — initial schema
--
-- Implements plans/PLAN.md §4 (data model), §5 (RLS) and §6 (server
-- functions). Four deviations from the spec's SQL, each documented at
-- the point it occurs:
--
--   1. RLS policies call security-definer helpers instead of querying
--      players inline. The spec's version recurses.
--   2. No "players update self" policy, and no UPDATE grant on
--      players. finish_deck covers the only legitimate update.
--   3. swipes.session_id is validated against the player's session, so
--      a client cannot file a swipe under the wrong session.
--   4. Two of the spec's indexes are dropped as redundant.
--
-- Non-negotiable rule this file exists to enforce: a player can never
-- read the other player's swipe rows.
-- ═══════════════════════════════════════════════════════════════════


-- ─── admins ────────────────────────────────────────────────────────
-- Membership here is the only thing that grants write access to the
-- film pool. Rows inserted by hand.
create table admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);


-- ─── movies ────────────────────────────────────────────────────────
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


-- ─── sessions ──────────────────────────────────────────────────────
create type session_status as enum ('waiting', 'swiping', 'complete');

create table sessions (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  status     session_status not null default 'waiting',
  movie_ids  uuid[] not null,     -- frozen deck, ordered
  created_at timestamptz not null default now()
);

-- The spec's sessions_code_idx is omitted: `code text not null unique`
-- already builds a unique btree index on that column, and a second
-- index on the same key only costs write throughput.


-- ─── players ───────────────────────────────────────────────────────
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

-- Not redundant: the unique constraint above leads with session_id, so
-- it cannot serve a lookup by user_id alone.
create index players_user_idx on players (user_id);


-- ─── swipes ────────────────────────────────────────────────────────
create table swipes (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  player_id  uuid not null references players(id) on delete cascade,
  movie_id   uuid not null references movies(id),
  liked      boolean not null,
  created_at timestamptz not null default now(),
  unique (player_id, movie_id)
);

-- The spec's swipes_player_idx is omitted: unique (player_id, movie_id)
-- already indexes player_id as its leading column.


-- ═══════════════════════════════════════════════════════════════════
-- Policy helpers
--
-- These exist because the spec's inline policies recurse. A policy on
-- players whose USING clause selects from players re-triggers that same
-- policy, and Postgres aborts with
--
--     42P17: infinite recursion detected in policy for relation
--            "players"
--
-- The sessions and swipes policies hit it too, indirectly, because
-- their subqueries on players evaluate the players policy.
--
-- A security-definer function runs as its owner and so bypasses RLS,
-- which breaks the cycle. Each one answers a single yes/no question
-- about the caller and leaks nothing else.
-- ═══════════════════════════════════════════════════════════════════

create or replace function is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $fn$
  select exists (select 1 from admins where user_id = auth.uid());
$fn$;

create or replace function is_participant(p_session_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $fn$
  select exists (
    select 1 from players
    where session_id = p_session_id
      and user_id = auth.uid()
  );
$fn$;

-- Deliberately takes both ids. Checking only player ownership would let
-- a client insert a swipe carrying someone else's session_id, which is
-- the column get_matches filters on — so the pair has to agree.
create or replace function can_swipe_as(p_player_id uuid, p_session_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $fn$
  select exists (
    select 1 from players
    where id = p_player_id
      and user_id = auth.uid()
      and session_id = p_session_id
  );
$fn$;


-- ═══════════════════════════════════════════════════════════════════
-- Table privileges
--
-- Supabase grants broad default privileges on new public tables, so
-- start from zero and hand back only what each role needs. RLS is the
-- real boundary; this is the second lock on the same door.
--
-- Note what is absent: no insert on sessions or players (those come
-- only from the definer RPCs), and no update or delete on swipes at
-- all. Undo was cut, so a swipe is write-once.
-- ═══════════════════════════════════════════════════════════════════

revoke all on admins, movies, sessions, players, swipes from anon, authenticated;

grant select                 on movies   to anon, authenticated;
grant insert, update, delete on movies   to authenticated;
grant select                 on admins   to authenticated;
grant select                 on sessions to authenticated;
grant select                 on players  to authenticated;
grant select, insert         on swipes   to authenticated;


-- ═══════════════════════════════════════════════════════════════════
-- Row Level Security
--
-- A table with RLS enabled and zero policies denies everything. That is
-- the correct failure direction, and it will produce one confusing
-- empty array during development.
-- ═══════════════════════════════════════════════════════════════════

alter table admins   enable row level security;
alter table movies   enable row level security;
alter table sessions enable row level security;
alter table players  enable row level security;
alter table swipes   enable row level security;

-- ─── movies: world-readable, admin-writable ───────────────────────
create policy "movies readable by all"
  on movies for select
  using (true);

create policy "movies writable by admins"
  on movies for all
  using  (is_admin())
  with check (is_admin());

-- ─── admins: you can see your own row and nothing else ────────────
create policy "admins self-readable"
  on admins for select
  using (user_id = auth.uid());

-- ─── sessions: readable if you're in it ───────────────────────────
-- Lookup-by-code happens inside join_session (security definer), so
-- there is no policy for the pre-join case and none is needed.
create policy "sessions readable by participants"
  on sessions for select
  using (is_participant(id));

-- ─── players: participants see each other ─────────────────────────
-- Deliberately exposes display_name and finished_at to the partner; the
-- lobby and waiting screens both need them. No swipe data here.
--
-- The spec's "players update self" policy is intentionally not created.
-- It would have allowed a player to rewrite any column of their own
-- row, session_id included — enough to move themselves into a
-- stranger's lobby. finish_deck is security definer and needs no
-- policy, and display_name is set at create/join time only.
create policy "players readable by participants"
  on players for select
  using (is_participant(session_id));

-- ─── swipes: yours and yours alone ────────────────────────────────
-- This is the whole privacy model. There is no update or delete policy,
-- and no update or delete grant either.
create policy "swipes select own"
  on swipes for select
  using (can_swipe_as(player_id, session_id));

create policy "swipes insert own"
  on swipes for insert
  with check (can_swipe_as(player_id, session_id));


-- ═══════════════════════════════════════════════════════════════════
-- Server functions
--
-- Session creation and joining are RPCs rather than client inserts
-- because both do things a client must not be trusted with: sample the
-- deck, generate a unique code, enforce the two-player cap atomically.
-- ═══════════════════════════════════════════════════════════════════

-- ─── generate_code() — internal helper ────────────────────────────
create or replace function generate_code()
returns text
language plpgsql
set search_path = public
as $fn$
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
$fn$;

-- ─── create_session ───────────────────────────────────────────────
create or replace function create_session(
  p_display_name text,
  p_deck_size int default 20
)
returns table (session_id uuid, code text, player_id uuid)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_deck   uuid[];
  v_code   text;
  v_sess   uuid;
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
$fn$;

-- ─── join_session ─────────────────────────────────────────────────
create or replace function join_session(
  p_code text,
  p_display_name text
)
returns table (session_id uuid, player_id uuid)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_sess     uuid;
  v_status   session_status;
  v_taken    int;
  v_existing uuid;
  v_player   uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if coalesce(trim(p_display_name), '') = '' then
    raise exception 'display name required';
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

-- Two people tapping Join at the same instant both clear the count
-- check above; unique (session_id, slot) is what actually stops the
-- second one. Turn that into the message the first branch would have
-- given rather than leaking a constraint name to the UI.
exception
  when unique_violation then
    raise exception 'that lobby is full';
end;
$fn$;

-- ─── start_session — either player may start ──────────────────────
create or replace function start_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
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
$fn$;

-- ─── get_matches — the privacy gate ───────────────────────────────
-- Must stay security definer and must keep both guards. It is the only
-- thing standing between a player and their partner's likes.
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
as $fn$
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
$fn$;

-- ─── finish_deck + completion trigger ─────────────────────────────
-- The client marks itself finished; Postgres decides when the round is
-- over.
create or replace function finish_deck(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update players
  set finished_at = now()
  where session_id = p_session_id
    and user_id = auth.uid()
    and finished_at is null;
end;
$fn$;

create or replace function check_session_complete()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
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
$fn$;

create trigger players_completion
  after update of finished_at on players
  for each row execute function check_session_complete();

-- ─── liked_count — the caller's own count, never the partner's ────
create or replace function liked_count(p_session_id uuid)
returns integer
language sql
security definer
stable
set search_path = public
as $fn$
  select count(*)::int
  from swipes s
  join players p on p.id = s.player_id
  where s.session_id = p_session_id
    and p.user_id = auth.uid()
    and s.liked;
$fn$;


-- ═══════════════════════════════════════════════════════════════════
-- Function privileges
--
-- Postgres grants EXECUTE to PUBLIC on every new function, which would
-- expose all of these to unauthenticated callers. Every one of them
-- needs a real auth.uid(), so hand them to authenticated only.
--
-- generate_code gets no grant at all: it is only ever called from
-- inside create_session, which runs as the owner.
-- ═══════════════════════════════════════════════════════════════════

revoke execute on function
  is_admin(),
  is_participant(uuid),
  can_swipe_as(uuid, uuid),
  generate_code(),
  create_session(text, int),
  join_session(text, text),
  start_session(uuid),
  get_matches(uuid),
  finish_deck(uuid),
  liked_count(uuid)
from public;

grant execute on function
  is_admin(),
  is_participant(uuid),
  can_swipe_as(uuid, uuid),
  create_session(text, int),
  join_session(text, text),
  start_session(uuid),
  get_matches(uuid),
  finish_deck(uuid),
  liked_count(uuid)
to authenticated;


-- ═══════════════════════════════════════════════════════════════════
-- Realtime
--
-- Exactly two subscriptions exist in the app: players inserts (lobby)
-- and sessions updates (waiting screen). swipes stays off the
-- publication — nothing listens to it and enabling it would widen the
-- surface for no reason.
-- ═══════════════════════════════════════════════════════════════════

do $do$
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    raise exception 'publication supabase_realtime is missing';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'players'
  ) then
    alter publication supabase_realtime add table public.players;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'sessions'
  ) then
    alter publication supabase_realtime add table public.sessions;
  end if;
end;
$do$;
