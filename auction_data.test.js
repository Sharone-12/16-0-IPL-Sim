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

// ---------- 3b. overseas cap ----------
console.log("\n--- overseas cap (max 4 per XI => >=7 Indians per team) ---");
let overseasSafe = true;
for (const teams of [2, 4, 6, 8, 10]) {
  const lots = A.buildAuctionPool(rows, { teams, eraFrom: 2008, eraTo: 2026 }).lots;
  const indian = lots.filter((l) => !l.isOverseas).length;
  const needIndian = (11 - A.MAX_OVERSEAS) * teams;
  const indianBowlers = lots.filter((l) => !l.isOverseas && l.primaryRole === "Bowler").length;
  if (indian < needIndian) overseasSafe = false;
  console.log(
    `  ${String(teams).padStart(2)} teams  indian=${String(indian).padStart(3)}/${String(needIndian).padStart(3)} needed` +
    `  indian bowlers=${String(indianBowlers).padStart(3)} (bowler slots=${4 * teams})`
  );
}
ok("pool always supplies enough Indians for the overseas cap", overseasSafe);

// ---------- 3c. depth floor ----------
// Quotas scaled by team count alone gave a 2-manager room 45 lots and a
// four-player Marquee — no Dhoni, no Gill, no Raina. Depth is now floored so a
// small room browses the same catalogue as a mid-size one.
const small = A.buildAuctionPool(rows, { teams: 2, eraFrom: 2008, eraTo: 2026 });
const mid = A.buildAuctionPool(rows, { teams: 6, eraFrom: 2008, eraTo: 2026 });
ok("a 2-manager room gets the same breadth as a 6-manager one",
   small.lots.length === mid.lots.length, `${small.lots.length} vs ${mid.lots.length}`);
ok("small-room Marquee is a real set, not a handful",
   small.lots.filter((l) => l.setId === "marquee").length >= 10);
ok("the household names reach a 2-manager auction", (() => {
  const inPool = new Set(small.lots.map((l) => l.name));
  const missing = ["MS Dhoni", "Shubman Gill", "SK Raina", "CH Gayle", "JJ Bumrah", "RG Sharma"]
    .filter((n) => rows.some((r) => r.name === n) && !inPool.has(n));
  if (missing.length) console.log("      missing: " + missing.join(", "));
  return missing.length === 0;
})());
ok("depth floor never breaks legality at any room size", [2, 3, 4, 5].every(
  (t) => A.buildAuctionPool(rows, { teams: t, eraFrom: 2008, eraTo: 2026 }).shortfalls.length === 0));
ok("checkSupply now catches an all-overseas pool", (() => {
  const allForeign = uniq.map((p) => Object.assign({}, p, { isOverseas: true }));
  return A.checkSupply(allForeign, 4).some((s) => s.what.includes("indian"));
})());

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
// Pacing: no single set may hog a long unbroken run of lots. A fixed OVR-85
// tier line used to put all 60 chosen bowlers in Tier A and leave Tier B empty
// — 60 bowler lots back to back. Each role is now split at its own median.
ok("no set runs for more than 35 consecutive lots", (() => {
  const lots = pool10Lots();
  let run = 1, worst = 1, worstSet = lots[0].setLabel;
  for (let i = 1; i < lots.length; i++) {
    if (lots[i].setId === lots[i - 1].setId) {
      if (++run > worst) { worst = run; worstSet = lots[i].setLabel; }
    } else run = 1;
  }
  if (worst > 35) console.log(`      worst run: ${worst} x ${worstSet}`);
  return worst <= 35;
})());
ok("both tiers of every split role are populated", (() => {
  const lots = pool10Lots();
  const empty = ["bowlers", "openers", "middle"]
    .filter((r) => !lots.some((l) => l.setId === r + "A") || !lots.some((l) => l.setId === r + "B"));
  if (empty.length) console.log("      empty tier for: " + empty.join(", "));
  return empty.length === 0;
})());
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

// ---------- 5b. NO RATING INVERSION ----------
// The bug this exists to catch: quota'ing the A/B display tiers separately cut
// Rabada (87) from Bowlers A while admitting ~84 bowlers into Bowlers B, and
// dropped three 92-rated players because Marquee held only 2 x teams.
const inPool = new Set(pool10.lots.map((l) => l.name));
const excluded = uniq.filter((p) => !inPool.has(p.name));
ok("no excluded player outranks an included player of the SAME role", (() => {
  const worstIn = {};
  pool10.lots.forEach((l) => {
    worstIn[l.role] = Math.min(worstIn[l.role] === undefined ? Infinity : worstIn[l.role], l.ovr);
  });
  const bad = excluded.filter((p) => p.ovr > (worstIn[A.roleFor(p)] ?? Infinity));
  if (bad.length) {
    console.log("      inversions: " + bad.slice(0, 5).map((p) => `${p.name}(${p.ovr},${A.roleFor(p)})`).join(", "));
  }
  return bad.length === 0;
})());
ok("every 92+ player is in the auction somewhere", (() => {
  const missing = uniq.filter((p) => p.ovr >= 92 && !inPool.has(p.name));
  if (missing.length) console.log("      missing: " + missing.map((p) => `${p.name}(${p.ovr})`).join(", "));
  return missing.length === 0;
})());
ok("marquee overflow lands in a role set, not the bin", (() => {
  const elite = uniq.filter((p) => p.ovr >= 92);
  const marqueeLots = pool10.lots.filter((l) => l.setId === "marquee").length;
  return elite.length > marqueeLots
    ? elite.every((p) => inPool.has(p.name))
    : true;
})());

console.log("\n--- set composition (10 teams) ---");
pool10.sets.forEach((s) =>
  console.log(
    `  ${s.label.padEnd(24)} ${String(s.got).padStart(3)} lots` +
    `  ${String(Math.round((s.got / pool10.lots.length) * 100)).padStart(3)}%`
  )
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

// ---------- 8. squad legality ----------
const lotsBy = (fn) => pool10.lots.filter(fn);
const openers = lotsBy((l) => l.battingOrder === "Opener" && l.primaryRole !== "Bowler");
const bowlers = lotsBy((l) => l.primaryRole === "Bowler");

ok("an empty squad accepts anyone", A.canAdd([], openers[0]));
ok("cannot sign the same player twice", !A.canAdd([openers[0]], openers[0]));
ok("a 4th opener is refused (only 3 opener slots exist)",
   !A.canAdd(openers.slice(0, 3), openers[3]));
ok("a 5th bowler beyond the tail is refused",
   !A.canAdd(bowlers.slice(0, 4), bowlers[4]));
ok("overseas cap blocks a 5th overseas signing", (() => {
  const foreign = pool10.lots.filter((l) => l.isOverseas);
  const four = [];
  for (const l of foreign) { if (A.canAdd(four, l)) four.push(l); if (four.length === 4) break; }
  const next = foreign.find((l) => !four.includes(l) && A.squadFeasible(four.concat([{ ...l, isOverseas: false }])));
  return four.length === 4 && next ? !A.canAdd(four, next) : true;
})());
ok("assignSlots finds a valid arrangement for a legal XI", (() => {
  const xi = [];
  for (const l of pool10.lots) { if (xi.length === 11) break; if (A.canAdd(xi, l)) xi.push(l); }
  const slots = A.assignSlots(xi);
  return xi.length === 11 && slots && new Set(slots).size === 11 && slots.every((s) => s >= 0);
})());
ok("a greedily-built XI is always legal and has a keeper in the top 7", (() => {
  const xi = [];
  for (const l of pool10.lots) { if (xi.length === 11) break; if (A.canAdd(xi, l)) xi.push(l); }
  const slots = A.assignSlots(xi);
  return xi.length === 11 && xi.some((p, i) => p.isWk && slots[i] < 7);
})());
ok("keeper rule: a squad that can never seat a keeper is rejected", (() => {
  const noKeeper = [];
  for (const l of pool10.lots) {
    if (l.isWk) continue;
    if (noKeeper.length === 11) break;
    if (A.canAdd(noKeeper, l)) noKeeper.push(l);
  }
  return noKeeper.length < 11; // cannot complete an XI with zero keepers
})());

// ---------- 9. skipping dead lots ----------
const mgr = (id, squad, purse) => ({ id, squad: squad || [], purse: purse == null ? A.PURSE : purse });

ok("a manager with a full XI cannot bid", (() => {
  const xi = [];
  for (const l of pool10.lots) { if (xi.length === 11) break; if (A.canAdd(xi, l)) xi.push(l); }
  return !A.canBidOn(mgr("a", xi), pool10.lots[50], 50);
})());
ok("a manager who cannot afford the price cannot bid",
   !A.canBidOn(mgr("a", [], 100), pool10.lots[0], 100));
ok("a manager with no legal slot cannot bid",
   !A.canBidOn(mgr("a", openers.slice(0, 3)), openers[3], openers[3].basePrice));
ok("shouldAutoPass fires when nobody in the room can bid",
   A.shouldAutoPass([mgr("a", openers.slice(0, 3)), mgr("b", openers.slice(3, 6))],
                    openers[6], openers[6].basePrice));
ok("shouldAutoPass stays false while anyone can bid",
   !A.shouldAutoPass([mgr("a", openers.slice(0, 3)), mgr("b", [])], openers[6], openers[6].basePrice));
ok("isAuctionComplete only when every manager is full", (() => {
  const xi = [];
  for (const l of pool10.lots) { if (xi.length === 11) break; if (A.canAdd(xi, l)) xi.push(l); }
  return A.isAuctionComplete([mgr("a", xi), mgr("b", xi)]) &&
         !A.isAuctionComplete([mgr("a", xi), mgr("b", [])]);
})());

// ---------- 10. move to next set ----------
ok("nextSetIndex jumps past the whole current set", (() => {
  const i = A.nextSetIndex(pool10.lots, 0);
  return pool10.lots[0].setId === "marquee" &&
         pool10.lots[i].setId !== "marquee" &&
         pool10.lots[i - 1].setId === "marquee";
})());
ok("nextSetIndex from mid-set still lands on the next set", (() => {
  const i = A.nextSetIndex(pool10.lots, 5);
  return pool10.lots[i].setId !== pool10.lots[5].setId;
})());
ok("nextSetIndex clamps at the end", A.nextSetIndex(pool10.lots, pool10.lots.length) === pool10.lots.length);
ok("skip vote only asks managers who could still bid in that set", (() => {
  const full = [];
  for (const l of pool10.lots) { if (full.length === 11) break; if (A.canAdd(full, l)) full.push(l); }
  const voters = A.skipSetVoters([mgr("live", []), mgr("done", full)], pool10.lots, 0);
  return voters.includes("live") && !voters.includes("done");
})());
ok("skip vote is empty when the set is dead for everyone", (() => {
  const start = pool10.lots.findIndex((l) => l.setId === "openersA");
  const three = openers.slice(0, 3);
  return A.skipSetVoters([mgr("a", three), mgr("b", three)], pool10.lots, start).length === 0;
})());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
