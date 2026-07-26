// Headless full-auction simulation. Drives the REAL auction logic from
// auction_data.js through complete auctions to prove the thing everything else
// depends on: every manager ends with a legal XI, nobody overspends, and the
// auction terminates.
//   node auction_sim.test.js [runs]
const fs = require("fs");
const A = require("./auction_data.js");

function splitLine(line) {
  const out = []; let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur); return out;
}
const text = fs.readFileSync("ipl_master_calibrated.csv", "utf8").split(/\r?\n/).filter((l) => l.trim());
const head = splitLine(text[0]);
const rows = text.slice(1).map((l) => {
  const c = splitLine(l), o = {}; head.forEach((h, i) => (o[h] = c[i])); return o;
}).filter((r) => r.Player_Name && r.Franchise && r.Season).map((r) => ({
  name: r.Player_Name, displayName: r.Player_Name, season: r.Season,
  fr: r.Franchise, frFull: r.Franchise_Full,
  ovr: Math.min(+r.OVR || 70, 100), bat: +r.Bat_Rat || +r.OVR || 70, bowl: +r.Bowl_Rat || +r.OVR || 60,
  primaryRole: r.Primary_Role, battingOrder: r.Batting_Order,
  isWk: r.Is_Wicketkeeper === "1", isOverseas: r.Nationality === "Overseas",
}));

// Deterministic RNG so failures reproduce.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// A manager who wants the player, can afford them, and sometimes bids on
// appetite. `aggression` varies so we exercise both spendthrifts and hoarders.
function wants(m, lot, price, rnd) {
  if (!A.canBidOn(m, lot, price)) return false;
  const slotsLeft = A.XI_SIZE - m.squad.length;
  const ceiling = A.maxBid(m.purse, slotsLeft);
  // Value the player, scaled by how desperate we are to fill slots.
  const value = Math.min(ceiling, Math.round(lot.basePrice * (1 + m.aggression * (lot.ovr - 70) / 12)));
  if (price > value) return false;
  return rnd() < 0.85;
}

function runAuction(teams, seed) {
  const rnd = rng(seed);
  const pool = A.buildAuctionPool(rows, { teams, eraFrom: 2008, eraTo: 2026 });
  const managers = Array.from({ length: teams }, (_, i) => ({
    id: "m" + i, squad: [], purse: A.PURSE, aggression: 0.4 + rnd() * 1.2,
  }));

  let sold = 0, unsold = 0, autoPassed = 0, guard = 0;
  for (let i = 0; i < pool.lots.length; i++) {
    if (A.isAuctionComplete(managers)) break;
    const lot = pool.lots[i];

    if (A.shouldAutoPass(managers, lot, lot.basePrice)) { autoPassed++; continue; }

    // Ascending auction: keep going while at least one manager will beat the ask.
    let price = lot.basePrice, leader = null;
    for (;;) {
      if (++guard > 500000) throw new Error("auction did not terminate");
      const challengers = managers.filter((m) => m.id !== (leader && leader.id) && wants(m, lot, price, rnd));
      if (!challengers.length) break;
      leader = challengers[Math.floor(rnd() * challengers.length)];
      const next = A.nextBid(price);
      if (!A.canBidOn(leader, lot, next)) break; // leader is at their ceiling
      price = next;
    }
    if (leader) {
      leader.squad.push(lot);
      leader.purse -= price;
      sold++;
    } else unsold++;
  }
  // Accelerated round — the safety net for anyone still short.
  const taken = managers.flatMap((m) => m.squad.map((p) => p.name));
  const reserve = A.bestSeasonPerPlayer(rows, 2008, 2026);
  const filled = A.fillShortSquads(managers, pool.lots, taken, reserve);

  return { pool, managers, sold, unsold, autoPassed, filled: filled.length };
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; } else { fail++; console.log("FAIL  " + name + (detail ? "\n      " + detail : "")); }
};

const RUNS = Number(process.argv[2]) || 40;
console.log(`simulating ${RUNS} full auctions across room sizes 2-10\n`);

let totalSold = 0, totalUnsold = 0, totalAuto = 0, totalFilled = 0, incomplete = 0;
const purseLeft = [];
for (let r = 0; r < RUNS; r++) {
  const teams = 2 + (r % 9);
  const { managers, sold, unsold, autoPassed, filled } = runAuction(teams, 1000 + r);
  totalSold += sold; totalUnsold += unsold; totalAuto += autoPassed; totalFilled += filled;

  managers.forEach((m) => {
    ok("purse never negative", m.purse >= 0, `run ${r}: ${m.id} purse ${m.purse}`);
    ok("squad never exceeds 11", m.squad.length <= A.XI_SIZE, `run ${r}: ${m.squad.length}`);
    ok("no duplicate signings", new Set(m.squad.map((p) => p.name)).size === m.squad.length, `run ${r}`);
    ok("overseas cap respected", m.squad.filter((p) => p.isOverseas).length <= A.MAX_OVERSEAS, `run ${r}`);
    ok("squad is always slot-legal", A.squadFeasible(m.squad), `run ${r}: ${m.id}`);
    if (m.squad.length === A.XI_SIZE) {
      const slots = A.assignSlots(m.squad);
      ok("full XI has a valid slot assignment", !!slots, `run ${r}`);
      ok("full XI has a keeper in the top 7",
         !!slots && m.squad.some((p, i) => p.isWk && slots[i] < 7), `run ${r}: ${m.id}`);
      purseLeft.push(m.purse);
    } else incomplete++;
  });

  // No player may be sold to two managers.
  const all = managers.flatMap((m) => m.squad.map((p) => p.name));
  ok("a player is never sold twice", new Set(all).size === all.length, `run ${r}`);
}

const filled = RUNS * 0 + purseLeft.length;
console.log(`lots sold ${totalSold} · unsold ${totalUnsold} · auto-passed ${totalAuto} · accelerated-round fills ${totalFilled}`);
console.log(`squads completed: ${filled}  ·  left short: ${incomplete}`);
if (purseLeft.length) {
  const avg = purseLeft.reduce((a, b) => a + b, 0) / purseLeft.length;
  console.log(`purse left over on a completed squad: avg ${A.formatMoney(Math.round(avg))}` +
              `  min ${A.formatMoney(Math.min(...purseLeft))}  max ${A.formatMoney(Math.max(...purseLeft))}`);
}
ok("every manager completes a full XI", incomplete === 0, `${incomplete} squads left short`);
ok("auto-pass actually fires (dead lots are skipped)", totalAuto > 0);

console.log(`\n${pass} assertions passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
