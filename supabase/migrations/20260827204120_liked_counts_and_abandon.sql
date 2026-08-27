-- ═══════════════════════════════════════════════════════════════════
-- Two functions the results screens need and §6 does not provide.
--
-- 1. liked_counts — frame 05b shows both totals ("You liked 9, Márta
--    liked 7, none the same"), but liked_count returns only the
--    caller's own and RLS puts the partner's swipe rows out of reach.
--    A count is not a row, and §10 asks for the totals explicitly, so
--    this returns both — behind the same both-finished gate as
--    get_matches. That gate is what keeps it from becoming the live
--    partner progress the product deliberately cut: before the round
--    is over it tells you nothing.
--
-- 2. abandon_round — §9 calls the waiting screen "the one state with
--    no exit" and asks for an escape hatch after roughly three
--    minutes. Revealing partial matches means get_matches has to pass
--    its both-finished guard, so ending the round marks the absent
--    player finished wherever they got to.
--
--    Only someone who has finished their own twenty may do it: without
--    that, a player could end the round on their first card and see the
--    partner's likes against a deck they had barely started.
-- ═══════════════════════════════════════════════════════════════════

create or replace function liked_counts(p_session_id uuid)
returns table (player_id uuid, display_name text, liked integer)
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not exists (
    select 1 from players p
    where p.session_id = p_session_id
      and p.user_id = auth.uid()
  ) then
    raise exception 'not a participant';
  end if;

  if (
    select count(*) from players p
    where p.session_id = p_session_id
      and p.finished_at is not null
  ) < 2 then
    raise exception 'results are not ready yet';
  end if;

  -- Every reference qualified. The OUT parameters above are named after
  -- columns, and an unqualified one resolves to the parameter first —
  -- the same trap join_session fell into.
  return query
  select p.id, p.display_name, count(s.id)::int
  from players p
  left join swipes s
    on s.player_id = p.id
   and s.liked
  where p.session_id = p_session_id
  group by p.id, p.display_name, p.slot
  order by p.slot;
end;
$fn$;

create or replace function abandon_round(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not exists (
    select 1 from players p
    where p.session_id = p_session_id
      and p.user_id = auth.uid()
      and p.finished_at is not null
  ) then
    raise exception 'finish your own twenty first';
  end if;

  -- Marks whoever is still going as finished where they stand. The
  -- players_completion trigger picks it up and flips the session to
  -- complete.
  update players p
  set finished_at = now()
  where p.session_id = p_session_id
    and p.finished_at is null;
end;
$fn$;

revoke execute on function
  liked_counts(uuid),
  abandon_round(uuid)
from anon, public;

grant execute on function
  liked_counts(uuid),
  abandon_round(uuid)
to authenticated;
