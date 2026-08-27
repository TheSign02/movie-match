-- Disposable pool for scripts/verify-privacy.mjs.
--
-- 22 films so a 20-card deck can be drawn with something left over.
-- Negative tmdb_ids: TMDB never issues one, so these can never collide
-- with a real import and cleanup can identify them by sign alone.

insert into movies (tmdb_id, title, year, poster_path, overview)
select
  -9000 - n,
  'VERIFY FIXTURE ' || lpad(n::text, 2, '0'),
  1970 + n,
  '/verify-fixture-' || n || '.jpg',
  'Placeholder row created by the privacy verification script.'
from generate_series(1, 22) as g(n)
on conflict (tmdb_id) do nothing;

select count(*) as fixture_films from movies where tmdb_id < 0;
