-- ===================================================================
-- 16-0 Multiplayer League — Supabase schema
-- Run this in the Supabase SQL Editor once.
-- No auth: the game uses the anon key, so policies are permissive.
-- (Same trust model as the existing `leaderboards` table.)
-- ===================================================================

-- ---------- tables ----------
create table if not exists rooms (
  id          text primary key,            -- 6-char room code
  name        text,
  host_id     text,
  status      text default 'waiting',      -- waiting | drafting | league | knockouts | finished
  settings    jsonb,                       -- { era, difficulty, max_players }
  created_at  timestamptz default now()
);

create table if not exists players (
  id          text primary key,            -- client uuid (or bot_<uuid>)
  room_id     text references rooms(id) on delete cascade,
  username    text,
  is_host     boolean default false,
  is_bot      boolean default false,
  bot_team    text,                        -- IPL 2026 team name if bot
  status      text default 'waiting',      -- waiting | ready | drafting | done
  xi          jsonb,                       -- drafted XI array
  joined_at   timestamptz default now()
);

create table if not exists matches (
  id           text primary key,
  room_id      text references rooms(id) on delete cascade,
  phase        text,                       -- league | q1 | eliminator | q2 | final
  team_a       text,                       -- player id
  team_b       text,                       -- player id
  winner       text,
  score_a      int,
  score_b      int,
  status       text default 'pending',     -- pending | ready | completed
  simulated_at timestamptz
);

create index if not exists players_room_idx on players(room_id);
create index if not exists matches_room_idx on matches(room_id);

-- ---------- row level security ----------
alter table rooms   enable row level security;
alter table players enable row level security;
alter table matches enable row level security;

-- Permissive anon access (public party game, no accounts). Tighten later if needed.
do $$
begin
  -- rooms
  if not exists (select 1 from pg_policies where tablename='rooms' and policyname='rooms_all') then
    create policy rooms_all on rooms for all to anon using (true) with check (true);
  end if;
  -- players
  if not exists (select 1 from pg_policies where tablename='players' and policyname='players_all') then
    create policy players_all on players for all to anon using (true) with check (true);
  end if;
  -- matches
  if not exists (select 1 from pg_policies where tablename='matches' and policyname='matches_all') then
    create policy matches_all on matches for all to anon using (true) with check (true);
  end if;
end $$;

-- ---------- realtime ----------
-- Broadcast row changes to subscribed clients (postgres_changes).
alter publication supabase_realtime add table rooms;
alter publication supabase_realtime add table players;
alter publication supabase_realtime add table matches;

-- Ensure full row payloads on updates/deletes (so realtime handlers get old+new).
alter table rooms   replica identity full;
alter table players replica identity full;
alter table matches replica identity full;
