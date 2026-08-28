-- ═══════════════════════════════════════════════════════════════════
-- "Swipe another twenty" has to land both players in the same round.
--
-- It used to call create_session, which makes a lobby with one player
-- in it. Both players tapping produced two lobbies with two codes, each
-- waiting for a partner who was sitting in the other one.
--
-- rematch() fixes it by being idempotent per finished session: the
-- first caller creates the new round with BOTH players already in it,
-- and the second caller gets handed that same round. sessions.rematch_of
-- is what makes that lookup possible, and it doubles as the thing the
-- results screen subscribes to — a player who never tapped is pushed
-- into the new lobby when their partner does.
--
-- Not in scope, still: excluding films the pair already swiped. That
-- needs a couples concept above sessions and §1 defers it to v2. A
-- rematch draws from the whole pool, same as any other round.
-- ═══════════════════════════════════════════════════════════════════

alter table sessions
  add column rematch_of uuid references sessions(id) on delete set null;

-- One rematch per session, which is also the race guard: two players
-- tapping at the same instant both pass the lookup below, and this is
-- what stops the second insert.
--
-- ON DELETE SET NULL rather than CASCADE: deleting an old round must
-- not take the new one with it.
create unique index sessions_rematch_of_key
  on sessions (rematch_of)
  where rematch_of is not null;

create or replace function rematch(p_session_id uuid)
returns table (session_id uuid, code text)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_existing      uuid;
  v_existing_code text;
  v_deck_size     int;
  v_pool_count    int;
  v_deck          uuid[];
  v_code          text;
  v_new           uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not exists (
    select 1 from players p
    where p.session_id = p_session_id
      and p.user_id = auth.uid()
  ) then
    raise exception 'not a participant';
  end if;

  -- Whoever taps second gets the round the first one made.
  select s.id, s.code into v_existing, v_existing_code
  from sessions s
  where s.rematch_of = p_session_id;

  if v_existing is not null then
    return query select v_existing, v_existing_code;
    return;
  end if;

  -- Match the deck size of the round being replayed rather than
  -- assuming 20, so a shorter test round replays as a shorter round.
  select array_length(s.movie_ids, 1) into v_deck_size
  from sessions s
  where s.id = p_session_id;

  if v_deck_size is null then
    raise exception 'no such round';
  end if;

  select count(*) into v_pool_count from movies where retired_at is null;
  if v_pool_count < v_deck_size then
    raise exception 'pool has % films, need at least %', v_pool_count, v_deck_size;
  end if;

  select array_agg(m.id) into v_deck
  from (
    select mm.id
    from movies mm
    where mm.retired_at is null
    order by random()
    limit v_deck_size
  ) m;

  v_code := generate_code();

  insert into sessions (code, movie_ids, rematch_of)
  values (v_code, v_deck, p_session_id)
  returning id into v_new;

  -- Same two people, same slots, same names. Both are in from the
  -- start, so the new lobby opens with Start already live.
  insert into players (session_id, slot, user_id, display_name)
  select v_new, p.slot, p.user_id, p.display_name
  from players p
  where p.session_id = p_session_id;

  return query select v_new, v_code;

exception
  when unique_violation then
    -- Both tapped at once. The loser of that race reads the winner's
    -- round rather than reporting a constraint to the player.
    select s.id, s.code into v_existing, v_existing_code
    from sessions s
    where s.rematch_of = p_session_id;

    if v_existing is null then
      raise;
    end if;

    return query select v_existing, v_existing_code;
end;
$fn$;

revoke execute on function rematch(uuid) from anon, public;
grant  execute on function rematch(uuid) to authenticated;
