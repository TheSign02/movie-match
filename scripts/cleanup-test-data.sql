-- Undoes scripts/seed-test-movies.sql and everything the privacy run
-- built on top of it.
--
-- Sessions go first: players and swipes cascade from them, and while a
-- swipe still references a fixture film the movies delete would be
-- blocked by the foreign key.
--
-- Scoped to fixture films (negative tmdb_id) so it can never touch a
-- real pool or a real round.

delete from sessions
where movie_ids && (select coalesce(array_agg(id), '{}') from movies where tmdb_id < 0);

delete from movies where tmdb_id < 0;

select
  (select count(*) from movies)   as movies_left,
  (select count(*) from sessions) as sessions_left,
  (select count(*) from players)  as players_left,
  (select count(*) from swipes)   as swipes_left;
