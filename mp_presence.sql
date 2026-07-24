-- ===================================================================
-- 16-0 Multiplayer — presence heartbeat.
-- Run once in the Supabase SQL Editor (after mp_schema.sql, mp_sim_sync.sql
-- and mp_replay.sql).
--
-- Every open client stamps this column every 15 seconds. Any manager whose
-- stamp falls more than 60s behind the freshest one in the room is treated as
-- gone, and is dropped from every readiness gate.
--
-- Without it, closing a browser tab leaves the players row behind forever and
-- the room deadlocks waiting on somebody who is never coming back — the league
-- kickoff, each knockout, and the Play Again vote would all hang.
-- ===================================================================

alter table players add column if not exists last_seen timestamptz default now();

-- Existing rows predate the column; treat them as live rather than stale.
update players set last_seen = now() where last_seen is null;
