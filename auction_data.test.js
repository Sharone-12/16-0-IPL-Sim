// Node harness for the auction data layer. Runs the REAL auction_data.js
// against the REAL player database — no fixtures, no mocks.
//   node auction_data.test.js
const fs = require("fs");
const A = require("./auction_data.js");

// ---------- load the same CSV the game loads ----------
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = splitLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const row = {};
    head.forEach((h, i) => (row[h] = cells[i]));
    return row;
  });
}
function splitLine(line) {
  const out = [];
  let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const rows = parseCsv(fs.readFileSync("ipl_master_calibrated.csv", "utf8"))
  .filter((r) => r.Player_Name && r.Franchise && r.Season)
  .map((r) => ({
    name: r.Player_Name,
    displayName: r.Player_Name,
    season: r.Season,
    fr: r.Franchise,
    frFull: r.Franchise_Full,
    ovr: Math.min(+r.OVR || 70, 100),
    bat: +r.Bat_Rat || +r.OVR || 70,
    bowl: +r.Bowl_Rat || +r.OVR || 60,
    primaryRole: r.Primary_Role,
    battingOrder: r.Batting_Order,
    isWk: r.Is_Wicketkeeper === "1",
    isOverseas: r.Nationality === "Overseas",
  }));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (detail ? "\n      " + detail : "")); }
};

console.log(`loaded ${rows.length} player-seasons\n`);

// ---------- 1. one lot per player ----------
const uniq = A.bestSeasonPerPlayer(rows, 2008, 2026);
ok("collapses player-seasons to unique players", uniq.length === new Set(rows.map((r) => r.name)).size,
   `got ${uniq.length}`);
ok("each player enters at their best season", (() => {
  const gayle = uniq.find((p) => p.name.includes("Gayle"));
  if (!gayle) return true;
  const all = rows.filter((r) => r.name === gayle.name);
  return gayle.ovr === Math.max(...all.map((r) => r.ovr));
})());

// ---------- 2. era filter ----------
const modern = A.bestSeasonPerPlayer(rows, 2020, 2026);
ok("era filter restricts seasons", modern.every((p) => +p.season >= 2020 && +p.season <= 2026));
ok("era filter shrinks the pool", modern.length < uniq.length, `${modern.length} vs ${uniq.length}`);

// ---------- 3. THE BIG ONE: every room size can field a legal XI ----------
console.log("\n--- pool supply across room sizes ---");
let allSafe = true;
for (const teams of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  const pool = A.buildAuctionPool(rows, { teams, eraFrom: 2008, eraTo: 2026 });
  const short = pool.shortfalls;
  if (short.length) allSafe = false;
  const mins = Math.round((pool.lots.length * 12) / 60);
  console.log(
    `  ${String(teams).padStart(2)} teams  lots=${String(pool.lots.length).padStart(3)}` +
    `  slots=${String(teams * 11).padStart(3)}  ratio=${(pool.lots.length / (teams * 11)).toFixed(2)}x` +
    `  ~${mins}min  ${short.length ? "SHORT: " + JSON.stringify(short) : "legal XI guaranteed"}`
  );
}
ok("every room size 2-10 can fill a legal XI", allSafe);

// ---------- 4. why the quota exists ----------
// NOT legality: a naive top-N cut is legally fine, because all-rounders and
// keepers who bat middle order also fill slots 3/4/5 (61 such players in a
// top-211 cut, against the ~40 ten teams need). The quota exists for auction
// SHAPE — a rating cut is 28% elite bowlers and 2 finishers, so you would sit
// through sixty seamers in a row and never bid on a finisher.
const naive = uniq.slice().sort((a, b) => b.ovr - a.ovr).slice(0, 211);
ok("a naive rating cut is legally playable (the quota is not about legality)",
   A.checkSupply(naive, 10).length === 0);

const share = (lots, id) => lots.filter((l) => A.setIdFor(l) === id).length / lots.length;
ok("naive cut is dominated by one set (bad auction pacing)",
   share(naive, "bowlersA") > 0.25, `bowlersA share ${(share(naive, "bowlersA") * 100).toFixed(0)}%`);
ok("naive cut starves finishers", naive.filter((l) => A.setIdFor(l) === "finishers").length < 5);
ok("quota pool keeps every set under a quarter of the lots",
   A.SETS.every((s) => share(pool10Lots(), s.id) <= 0.25));
ok("quota pool gives finishers a real set",
   pool10Lots().filter((l) => l.setId === "finishers").length >= 10);
function pool10Lots() {
  return A.buildAuctionPool(rows, { teams: 10, eraFrom: 2008, eraTo: 2026 }).lots;
}

// ---------- 5. sets are ordered, non-overlapping, complete ----------
const pool10 = A.buildAuctionPool(rows, { teams: 10, eraFrom: 2008, eraTo: 2026 });
ok("no player appears in two lots", new Set(pool10.lots.map((l) => l.name)).size === pool10.lots.length);
ok("lots are grouped in set order", (() => {
  const order = A.SETS.map((s) => s.id);
  let last = -1;
  for (const lot of pool10.lots) {
    const i = order.indexOf(lot.setId);
    if (i < last) return false;
    last = i;
  }
  return true;
})());
ok("every lot has a base price", pool10.lots.every((l) => l.basePrice >= A.MIN_BASE));
ok("marquee set is the first thing under the hammer", pool10.lots[0].setId === "marquee");

console.log("\n--- set composition (10 teams) ---");
pool10.sets.forEach((s) =>
  console.log(`  ${s.label.padEnd(24)} ${String(s.got).padStart(3)} lots  (wanted ${s.wanted}, pool has ${s.available})`)
);

// ---------- 6. money ----------
ok("base price rises with rating", A.basePriceFor(95) > A.basePriceFor(86) && A.basePriceFor(86) > A.basePriceFor(70));
ok("increments climb with price", A.bidIncrement(50) < A.bidIncrement(300) && A.bidIncrement(300) < A.bidIncrement(900));
ok("nextBid always increases", [50, 99, 100, 199, 200, 499, 500, 5000].every((v) => A.nextBid(v) > v));
ok("money formats as crore", A.formatMoney(100) === "₹1 Cr" && A.formatMoney(250) === "₹2.50 Cr",
   `${A.formatMoney(100)} / ${A.formatMoney(250)}`);

// ---------- 7. the purse can always complete an XI ----------
ok("purse covers 11 players at base price", A.PURSE >= 11 * A.MIN_BASE);
ok("maxBid reserves enough for remaining slots", A.maxBid(A.PURSE, 11) === A.PURSE - 10 * A.MIN_BASE);
ok("maxBid on the final slot spends everything", A.maxBid(1234, 1) === 1234);
ok("a manager who spends to maxBid can still fill the XI", (() => {
  let purse = A.PURSE;
  for (let slotsLeft = 11; slotsLeft > 0; slotsLeft--) {
    const bid = A.maxBid(purse, slotsLeft);
    if (bid < A.MIN_BASE) return false;
    purse -= slotsLeft === 11 ? bid : A.MIN_BASE; // blow the lot on the first buy
  }
  return purse >= 0;
})());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
