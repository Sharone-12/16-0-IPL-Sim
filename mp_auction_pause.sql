-- ===================================================================
-- 16-0 Auction — host pause.
-- Run once in the Supabase SQL Editor (after mp_auction.sql).
--
-- The lot clock is an absolute deadline (auction_state.ends_at), so pausing
-- cannot simply "stop time" — the deadline would still pass while paused and
-- the lot would hammer the moment anyone looked at it. Instead, pausing banks
-- how much time was LEFT and clears the deadline; resuming turns that back into
-- a fresh deadline. A lot therefore resumes with exactly the time it had.
-- ===================================================================

alter table auction_state add column if not exists paused       boolean default false;
alter table auction_state add column if not exists remaining_ms int;

-- Existing rooms predate the columns.
update auction_state set paused = false where paused is null;
