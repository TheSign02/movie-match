-- ═══════════════════════════════════════════════════════════════════
-- Genres, for the chips beside the runtime on the card and the results.
--
-- Stored as resolved names rather than TMDB's genre_ids, for one
-- decisive reason: turning ids into names needs the genre list, and the
-- only route to that list is the tmdb Edge Function, which refuses
-- anyone who is not in admins. Players are not admins. Storing ids would
-- leave the deck holding numbers it has no way to translate.
--
-- All of them are kept and the UI shows the top three. TMDB returns them
-- roughly primary-first, and storing the lot costs nothing while leaving
-- the display rule a display decision.
--
-- get_matches has to carry them too, for the results grid and the
-- tap-to-expand card. That is another return-type change, so the
-- function is dropped and rebuilt — and re-granted.
-- ═══════════════════════════════════════════════════════════════════

alter table movies add column genres text[];


drop function if exists get_matches(uuid);

create function get_matches(p_session_id uuid)
returns table (
  movie_id    uuid,
  title       text,
  year        integer,
  poster_path text,
  overview    text,
  runtime     integer,
  genres      text[]
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
  select m.id, m.title, m.year, m.poster_path, m.overview, m.runtime, m.genres
  from swipes s1
  join swipes s2
    on s2.movie_id = s1.movie_id
   and s2.session_id = s1.session_id
   and s2.player_id <> s1.player_id
  join movies m on m.id = s1.movie_id
  where s1.session_id = p_session_id
    and s1.liked and s2.liked
  group by m.id, m.title, m.year, m.poster_path, m.overview, m.runtime, m.genres;
end;
$fn$;

revoke execute on function get_matches(uuid) from anon, public;
grant  execute on function get_matches(uuid) to authenticated;
