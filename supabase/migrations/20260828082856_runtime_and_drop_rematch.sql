-- ═══════════════════════════════════════════════════════════════════
-- Three changes, all driven by testing the built app.
--
-- 1. movies.runtime, so the card can read "2023 · 106 min".
--
--    This is the first stored field beyond the shape §8 fixes, and it
--    costs more than the others: search and discover do not return a
--    runtime, only /movie/{id} does. So it is fetched once, when a film
--    is added, rather than for every search result nobody adds.
--
-- 2. get_matches gains overview and runtime, for the tap-to-expand
--    detail on the results grid. The return type changes, which
--    create-or-replace cannot do, so the function is dropped and
--    rebuilt — and the grants with it.
--
-- 3. rematch() and sessions.rematch_of are removed.
--
--    "Swipe another twenty" moving BOTH players into a new lobby turned
--    out to be the wrong behaviour, not just a bug in how it was
--    implemented: one player finishing should not drag the other off a
--    results screen they are still reading. Results now has a back
--    button, and starting another round goes through Home like any
--    other round. The definition stays in the 20260828075803 migration
--    if it is ever wanted again.
-- ═══════════════════════════════════════════════════════════════════


-- ─── 1. runtime ────────────────────────────────────────────────────
-- Nullable on purpose: TMDB reports 0 or nothing for plenty of films,
-- and the card shows the year alone rather than "0 min".
alter table movies add column runtime integer;


-- ─── 2. get_matches, with what the detail view needs ──────────────
drop function if exists get_matches(uuid);

create function get_matches(p_session_id uuid)
returns table (
  movie_id    uuid,
  title       text,
  year        integer,
  poster_path text,
  overview    text,
  runtime     integer
)
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- Caller must be a participant.
  if not exists (
    select 1 from players p
    where p.session_id = p_session_id
      and p.user_id = auth.uid()
  ) then
    raise exception 'not a participant';
  end if;

  -- Both must have finished. This is the whole point of the function.
  if (
    select count(*) from players p
    where p.session_id = p_session_id
      and p.finished_at is not null
  ) < 2 then
    raise exception 'results are not ready yet';
  end if;

  return query
  select m.id, m.title, m.year, m.poster_path, m.overview, m.runtime
  from swipes s1
  join swipes s2
    on s2.movie_id = s1.movie_id
   and s2.session_id = s1.session_id
   and s2.player_id <> s1.player_id
  join movies m on m.id = s1.movie_id
  where s1.session_id = p_session_id
    and s1.liked and s2.liked
  group by m.id, m.title, m.year, m.poster_path, m.overview, m.runtime;
end;
$fn$;

-- drop took the grants with it.
revoke execute on function get_matches(uuid) from anon, public;
grant  execute on function get_matches(uuid) to authenticated;


-- ─── 3. rematch, removed ───────────────────────────────────────────
drop function if exists rematch(uuid);
drop index if exists sessions_rematch_of_key;
alter table sessions drop column if exists rematch_of;
