// Harness for the CURATED auction pool (ipl_auction_career_final.csv joined to
// ipl_master_calibrated.csv). Runs the real auction_data.js against the real
// files, then drives full auctions to prove every manager can still field a
// legal XI from the hand-mapped list.
//   node auction_curated.test.js [runs]
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
function parse(file) {
  const t = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const head = splitLine(t[0]);
  return t.slice(1).map((l) => {
    const c = splitLine(l), r = {};
    head.forEach((h, i) => (r[h] = c[i]));
    return r;
  });
}

const auc = parse("ipl_auction_career_final.csv").filter((r) => r.Player_Name).map(A.normalizeAuctionRow);
const mas = parse("ipl_master_calibrated.csv").filter((r) => r.Player_Name && r.Season).map(A.normalizeMasterRow);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (detail ? "\n      " + detail : "")); }
};

console.log(`auction file: ${auc.length} players · master: ${mas.length} player-seasons\n`);

const pool = A.buildCuratedPool(auc, mas, { teams: 10 });

// ---------- 1. the join ----------
ok("every curated player joins the master file", pool.unmatched.length === 0,
   "unmatched: " + pool.unmatched.slice(0, 8).join(", "));
ok("no player is listed twice", new Set(pool.lots.map((l) => l.name)).size === pool.lots.length);
ok("every lot carries the fields the match engine needs",
   pool.lots.every((l) => l.battingOrder && l.primaryRole &&
     Number.isFinite(l.bat) && Number.isFinite(l.bowl) && Number.isFinite(l.simOvr)));

// ---------- 2. the curated columns are honoured, not recomputed ----------
const bySet = {};
pool.lots.forEach((l) => (bySet[l.setId] = (bySet[l.setId] || 0) + 1));
const rawSets = {};
auc.forEach((r) => (rawSets[r.auctionSet] = (rawSets[r.auctionSet] || 0) + 1));
ok("set membership matches the CSV exactly",
   Object.keys(rawSets).every((k) => bySet[k] === rawSets[k]),
   JSON.stringify({ built: bySet, csv: rawSets }));
ok("base prices come from the CSV, not recomputed", pool.lots.every((l) => {
  const raw = auc.find((r) => r.name === l.name);
  return raw && raw.basePrice === l.basePrice;
}));
ok("Marquee is first under the hammer", pool.lots[0].setId === "Marquee");
ok("sets run in the canonical order", (() => {
  let last = -1;
  for (const l of pool.lots) {
    const i = A.SET_ORDER.indexOf(l.setId);
    if (i < last) return false;
    last = i;
  }
  return true;
})());

// ---------- 3. two rating scales kept apart ----------
const deltas = pool.lots.map((l) => l.simOvr - l.ovr);
ok("auction OVR and sim OVR are genuinely different scales",
   deltas.some((d) => d !== 0),
   "all identical — the separation collapsed");
console.log(`      sim minus auction OVR: min ${Math.min(...deltas)} max ${Math.max(...deltas)} ` +
            `mean ${(deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(2)}`);

// ---------- 4. legality at every room size ----------
console.log("\n--- supply across room sizes ---");
let allSafe = true;
for (const teams of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  const p = A.buildCuratedPool(auc, mas, { teams });
  if (p.shortfalls.length) allSafe = false;
  console.log(`  ${String(teams).padStart(2)} teams  lots=${p.lots.length}  slots=${teams * 11}` +
    `  ${p.shortfalls.length ? "SHORT: " + JSON.stringify(p.shortfalls) : "legal XI guaranteed"}`);
}
ok("every room size 2-10 can field a legal XI", allSafe);

// ---------- 5. full auctions ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function wants(m, lot, price, rnd) {
  if (!A.canBidOn(m, lot, price)) return false;
  const ceiling = A.maxBid(m.purse, A.XI_SIZE - m.squad.length);
  const value = Math.min(ceiling, Math.round(lot.basePrice * (1 + m.aggression * (lot.ovr - 70) / 12)));
  return price <= value && rnd() < 0.85;
}

const RUNS = Number(process.argv[2]) || 45;
let short = 0, filled = 0, autoPassed = 0;
const leftover = [];
for (let r = 0; r < RUNS; r++) {
  const teams = 2 + (r % 9);
  const rnd = rng(7000 + r);
  const p = A.buildCuratedPool(auc, mas, { teams });
  const managers = Array.from({ length: teams }, (_, i) => ({
    id: "m" + i, squad: [], purse: A.PURSE, aggression: 0.4 + rnd() * 1.2,
  }));
  for (const lot of p.lots) {
    if (A.isAuctionComplete(managers)) break;
    if (A.shouldAutoPass(managers, lot, lot.basePrice)) { autoPassed++; continue; }
    let price = lot.basePrice, leader = null;
    for (;;) {
      const ch = managers.filter((m) => m.id !== (leader && leader.id) && wants(m, lot, price, rnd));
      if (!ch.length) break;
      leader = ch[Math.floor(rnd() * ch.length)];
      const next = A.nextBid(price);
      if (!A.canBidOn(leader, lot, next)) break;
      price = next;
    }
    if (leader) { leader.squad.push(lot); leader.purse -= price; }
  }
  const taken = managers.flatMap((m) => m.squad.map((x) => x.name));
  filled += A.fillShortSquads(managers, p.lots, taken, p.lots).length;

  managers.forEach((m) => {
    ok("purse never negative", m.purse >= 0, `run ${r} ${m.id}`);
    ok("squad legal throughout", A.squadFeasible(m.squad), `run ${r} ${m.id}`);
    ok("overseas cap respected", m.squad.filter((x) => x.isOverseas).length <= A.MAX_OVERSEAS, `run ${r}`);
    if (m.squad.length === A.XI_SIZE) {
      const slots = A.assignSlots(m.squad);
      ok("full XI seats a keeper in the top 7",
         !!slots && m.squad.some((x, i) => x.isWk && slots[i] < 7), `run ${r} ${m.id}`);
      leftover.push(m.purse);
    } else short++;
  });
  const all = managers.flatMap((m) => m.squad.map((x) => x.name));
  ok("a player is never sold twice", new Set(all).size === all.length, `run ${r}`);
}

console.log(`\nauto-passed ${autoPassed} · accelerated fills ${filled} · squads left short ${short}`);
if (leftover.length) {
  const avg = leftover.reduce((a, b) => a + b, 0) / leftover.length;
  console.log(`purse left over: avg ${A.formatMoney(Math.round(avg))} min ${A.formatMoney(Math.min(...leftover))}`);
}
ok("every manager completes a full XI", short === 0, `${short} left short`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
