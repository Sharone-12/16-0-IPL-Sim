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

-- Manual, vote-gated progression: each human's sim_ready_step is how far they
-- have clicked to advance. The room only moves to step N once every human has
-- sim_ready_step >= N (e.g. "2/2 ready"). Bots don't vote.
alter table players add column if not exists sim_ready_step int default -1;
