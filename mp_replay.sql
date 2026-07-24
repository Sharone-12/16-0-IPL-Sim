-- ===================================================================
-- 16-0 Multiplayer — "Play Again" in the same room.
-- Run once in the Supabase SQL Editor (after mp_schema.sql / mp_sim_sync.sql).
--
-- One counter per room. It does two jobs:
--   1. It is folded into the shared RNG seed (`<room>:<season>`), so replaying
--      the same room produces a genuinely different league instead of an
--      identical rerun of the last one.
--   2. It is the signal every client watches — when season moves past the one
--      a client booted with, that client follows the room back to the draft.
-- rooms is already in the realtime publication with replica identity full, so
-- the bump reaches everyone.
-- ===================================================================

alter table rooms add column if not exists season int default 0;

-- Existing rooms created before this column arrived.
update rooms set season = 0 where season is null;
