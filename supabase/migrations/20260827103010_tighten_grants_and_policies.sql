-- ═══════════════════════════════════════════════════════════════════
-- Close three findings from `supabase db advisors`.
--
-- 1. anon could execute every function in public, generate_code
--    included. The first migration's `revoke execute ... from public`
--    was a no-op: Supabase's default privileges grant EXECUTE
--    explicitly to anon, authenticated and service_role, and revoking
--    from PUBLIC does not touch a named grant. Confirmed in the ACL:
--
--      {postgres=X/postgres,anon=X/postgres,
--       authenticated=X/postgres,service_role=X/postgres}
--
--    Nothing leaked — every one of these starts by rejecting a null
--    auth.uid() — but the guard was carrying weight the grant should
--    have carried.
--
-- 2. The admins policy re-evaluated auth.uid() per row. Irrelevant at
--    one row, wrong as a pattern to copy.
--
-- 3. "movies writable by admins" was FOR ALL, so it also ran on every
--    SELECT alongside "movies readable by all" — two permissive
--    policies evaluated on the pool's hottest read path.
-- ═══════════════════════════════════════════════════════════════════


-- ─── 1. anon executes nothing ─────────────────────────────────────
-- The app signs in anonymously before it does anything, which yields
-- the authenticated role. Nothing legitimate ever calls as anon.

revoke execute on function
  is_admin(),
  is_participant(uuid),
  can_swipe_as(uuid, uuid),
  generate_code(),
  check_session_complete(),
  create_session(text, int),
  join_session(text, text),
  start_session(uuid),
  get_matches(uuid),
  finish_deck(uuid),
  liked_count(uuid)
from anon, public;

-- These two are not API surface at all. generate_code is called only
-- from inside create_session and check_session_complete only by the
-- trigger — both run as the function owner, so neither needs a grant.
revoke execute on function
  generate_code(),
  check_session_complete()
from authenticated;


-- ─── 2. hoist auth.uid() out of the per-row loop ───────────────────
-- Wrapping it in a subselect lets the planner evaluate it once as an
-- InitPlan instead of once per row.

drop policy "admins self-readable" on admins;

create policy "admins self-readable"
  on admins for select
  using (user_id = (select auth.uid()));


-- ─── 3. one policy per action on movies ────────────────────────────
-- FOR ALL covers SELECT too, which meant every pool read evaluated
-- is_admin() as well as the world-readable policy. Splitting it leaves
-- reads with a single `using (true)` policy.

drop policy "movies writable by admins" on movies;

create policy "movies insertable by admins"
  on movies for insert
  with check (is_admin());

create policy "movies updatable by admins"
  on movies for update
  using (is_admin())
  with check (is_admin());

create policy "movies deletable by admins"
  on movies for delete
  using (is_admin());
