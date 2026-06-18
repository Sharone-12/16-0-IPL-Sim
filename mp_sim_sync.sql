-- ===================================================================
-- 16-0 Multiplayer — real-time league sync.
-- Run once in the Supabase SQL Editor.
-- Adds a shared round pointer to each room. Every client computes identical
-- results from the seeded RNG, so we only broadcast this one integer: which
-- league round the whole room is currently on. `sim_at` paces the advance.
-- rooms is already in the realtime publication with replica identity full,
-- so UPDATEs to these columns reach every subscribed client.
-- ===================================================================

alter table rooms add column if not exists sim_round int default -1;
alter table rooms add column if not exists sim_at    timestamptz;
