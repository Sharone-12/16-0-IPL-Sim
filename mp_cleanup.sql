-- ===================================================================
-- 16-0 Multiplayer — auto-delete rooms 2 hours after creation.
-- Run once in the Supabase SQL Editor. Requires pg_cron (Supabase has it;
-- enable via Dashboard → Database → Extensions if the CREATE line errors).
-- Deleting a room cascades to its players + matches (ON DELETE CASCADE).
-- ===================================================================

create extension if not exists pg_cron;

-- Every 30 minutes, remove rooms older than 2 hours.
select cron.schedule(
  'cleanup-old-rooms',
  '*/30 * * * *',
  $$ delete from rooms where created_at < now() - interval '2 hours'; $$
);

-- To change the cadence later, unschedule then re-add:
--   select cron.unschedule('cleanup-old-rooms');
