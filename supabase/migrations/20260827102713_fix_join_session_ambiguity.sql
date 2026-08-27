-- ═══════════════════════════════════════════════════════════════════
-- Fix: column reference "session_id" is ambiguous in join_session
--
-- `returns table (session_id uuid, player_id uuid)` makes session_id an
-- OUT parameter, and plpgsql resolves an unqualified name to the
-- parameter before the column. So
--
--     where session_id = v_sess
--
-- is ambiguous against players.session_id, and Postgres raises 42702 at
-- execution time — which is why the migration applied cleanly and the
-- failure only showed up when a second player actually tried to join.
--
-- Every column reference is now table-qualified. create_session has the
-- same shape of OUT parameters but never compares an unqualified
-- session_id, so it was unaffected; qualified anyway for consistency.
-- ═══════════════════════════════════════════════════════════════════

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

  select s.id, s.status into v_sess, v_status
  from sessions s
  where s.code = upper(trim(p_code));

  if v_sess is null then
    raise exception 'no lobby with that code';
  end if;

  -- Already in this session? Idempotent rejoin.
  select p.id into v_existing
  from players p
  where p.session_id = v_sess
    and p.user_id = auth.uid();

  if v_existing is not null then
    return query select v_sess, v_existing;
    return;
  end if;

  if v_status <> 'waiting' then
    raise exception 'that round has already started';
  end if;

  select count(*) into v_taken
  from players p
  where p.session_id = v_sess;

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
  select array_agg(m.id) into v_deck
  from (select mm.id from movies mm order by random() limit p_deck_size) m;

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

-- create or replace drops the grants that came with the original
-- definitions, so restate them.
revoke execute on function
  create_session(text, int),
  join_session(text, text)
from public;

grant execute on function
  create_session(text, int),
  join_session(text, text)
to authenticated;
