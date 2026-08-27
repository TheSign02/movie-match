-- ═══════════════════════════════════════════════════════════════════
-- Soft-retire films instead of deleting them.
--
-- swipes.movie_id references movies(id) with no ON DELETE action, which
-- is right — cascading would silently rewrite the matches of rounds
-- already played, and RESTRICT protects that history. But §10 frame 06
-- describes the pool as a removable list, and under a strict FK the
-- remove button fails with a foreign-key error on any film that has
-- ever been swiped. That is every interesting film after the first
-- round.
--
-- retired_at squares the two: removal always succeeds, past rounds keep
-- their titles and posters, and the film stops being dealt into new
-- decks. Re-adding a retired film clears the flag rather than colliding
-- with the unique tmdb_id.
--
-- Retired films stay world-readable on purpose: get_matches joins
-- movies, and a results screen from an old round still has to render.
-- ═══════════════════════════════════════════════════════════════════

alter table movies add column retired_at timestamptz;

-- The pool list and the deck sample both want active films newest-first.
create index movies_active_idx on movies (added_at desc) where retired_at is null;

-- movies_added_at_idx covered the unfiltered case and nothing asks for
-- that any more.
drop index movies_added_at_idx;


-- create_session has to count and sample only what is still in the
-- pool, or a retired film can be dealt into a new deck and the
-- "pool has N films" guard can pass on films nobody can be shown.
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

  select count(*) into v_pool_count
  from movies
  where retired_at is null;

  if v_pool_count < p_deck_size then
    raise exception 'pool has % films, need at least %',
      v_pool_count, p_deck_size;
  end if;

  -- Sample the deck. random() ordering is fine at this table size.
  select array_agg(m.id) into v_deck
  from (
    select mm.id
    from movies mm
    where mm.retired_at is null
    order by random()
    limit p_deck_size
  ) m;

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

-- create or replace preserves the ACL, but restate it so this file
-- stands on its own.
revoke execute on function create_session(text, int) from anon, public;
grant  execute on function create_session(text, int) to authenticated;
