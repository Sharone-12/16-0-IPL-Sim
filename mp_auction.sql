-- ===================================================================
-- 16-0 — IPL-style AUCTION mode.
-- Run once in the Supabase SQL Editor (after mp_schema.sql).
--
-- Auction rooms reuse the existing `rooms` and `players` tables, with
-- settings.mode = 'auction'. That is deliberate: when the auction finishes it
-- writes each manager's XI into players.xi exactly as the draft does, so
-- sim-mp.html runs the league + knockouts afterwards with ZERO changes.
--
-- The lot list itself is never stored. Every client derives the identical
-- ordered pool from the CSV via auction_data.js (same room settings in, same
-- lots out), so the only shared state is which lot is live and what it is going
-- for — the same "derive locally, sync one pointer" trick the simulation uses.
-- ===================================================================

-- ---------- purse ----------
-- Remaining budget in LAKH. Authoritative spend is always recomputed from
-- auction_buys; this column is a cached convenience for the lobby/room UI.
alter table players add column if not exists purse int;

-- ---------- live state: one row per room ----------
create table if not exists auction_state (
  room_id     text primary key references rooms(id) on delete cascade,
  lot_index   int  default 0,           -- which lot is under the hammer
  price       int,                      -- current highest bid, in LAKH (null = no bids)
  high_bidder text,                     -- players.id of the leader (null = unsold so far)
  ends_at     timestamptz,              -- when the hammer falls (null = not started)
  status      text default 'live',      -- live | done
  skip_votes  jsonb default '[]'::jsonb,-- player ids voting to skip the rest of the set
  updated_at  timestamptz default now()
);

-- ---------- results ----------
-- PRIMARY KEY (room_id, lot_index) is what makes selling safe: every client
-- races to resolve an expired lot, and the key guarantees exactly one insert
-- wins. Squads and purses are DERIVED by reading this table, so a lost race
-- can never double-charge anyone or duplicate a signing.
create table if not exists auction_buys (
  room_id    text not null references rooms(id) on delete cascade,
  lot_index  int  not null,
  buyer      text,                      -- players.id, or null for an unsold lot
  player     jsonb,                     -- the lot that was sold
  price      int,                       -- hammer price in LAKH
  created_at timestamptz default now(),
  primary key (room_id, lot_index)
);

create index if not exists auction_buys_room_idx on auction_buys(room_id);
create index if not exists auction_buys_buyer_idx on auction_buys(room_id, buyer);

-- ---------- row level security ----------
alter table auction_state enable row level security;
alter table auction_buys  enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename='auction_state' and policyname='auction_state_all') then
    create policy auction_state_all on auction_state for all to anon using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='auction_buys' and policyname='auction_buys_all') then
    create policy auction_buys_all on auction_buys for all to anon using (true) with check (true);
  end if;
end $$;

-- ---------- realtime ----------
alter publication supabase_realtime add table auction_state;
alter publication supabase_realtime add table auction_buys;
alter table auction_state replica identity full;
alter table auction_buys  replica identity full;
