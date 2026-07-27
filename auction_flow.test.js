// End-to-end harness for the AUCTION → SIMULATION handover.
//
// This exists because of a live failure: two managers clicked "Proceed" at the
// same moment, each seated a full set of bots, and the league booted with 18
// teams — of which only 10 got fixtures, so both humans played 0 matches. The
// test drives the real code paths (pool, XI mapping, seat trimming, and the
// actual fixture scheduler lifted out of sim-mp.js) rather than a restatement
// of them, so a regression in any of those files fails here.
//
//   node auction_flow.test.js [runs]
const fs = require("fs");
const vm = require("vm");
const A = require("./auction_data.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (detail ? "\n      " + detail : "")); }
};

// ---------- csv ----------
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

// ---------- lift the real functions out of the shipped files ----------
// Named function declarations only, so the extraction is a brace match from
// `function name(` to its closing brace. If a function is renamed or deleted the
// harness throws rather than silently testing nothing.
function lift(src, names) {
  const out = [];
  for (const name of names) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found — did it get renamed?`);
    let i = src.indexOf("{", start), depth = 0, end = -1;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (!depth) { end = i + 1; break; } }
    }
    if (end < 0) throw new Error(`${name} has unbalanced braces`);
    out.push(src.slice(start, end));
  }
  return out.join("\n\n");
}

const simSrc = fs.readFileSync("sim-mp.js", "utf8");
const roomSrc = fs.readFileSync("auction-room.js", "utf8");

const sandbox = {
  console,
  MP: true,
  USER_ID: null,
  GROUPS: { A: [], B: [] },
  state: { teams: [] },
  // Stand-in for the room's seeded shuffle. The seed lives OUTSIDE the function
  // so consecutive calls draw from one advancing stream, exactly like the real
  // one — mpPerfectSchedule retries with a fresh shuffle when a pass dead-ends,
  // and a stub that returned the same permutation every time would make all 50
  // retries identical and fake a scheduler failure.
  shuffle: null,
  assembleRounds: () => { throw new Error("solo path must not be reached"); },
  MP_LEAGUE_SIZE: 10,
};
let shuffleSeed = 12345;
sandbox.shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    shuffleSeed = (shuffleSeed * 1103515245 + 12345) & 0x7fffffff;
    const j = shuffleSeed % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

vm.createContext(sandbox);
vm.runInContext(
  lift(simSrc, ["mpTrimToLeague", "buildGroupFixtures", "assembleRoundsShared",
                "mpPerfectSchedule", "mpFindRoundMatching"]),
  sandbox
);
vm.runInContext(lift(roomSrc, ["shiftRating"]), sandbox);

// ---------- 1. the OVR that was bid on is the OVR that plays ----------
const auc = parse("ipl_auction_career_final.csv").filter((r) => r.Player_Name).map(A.normalizeAuctionRow);
const mas = parse("ipl_master_calibrated.csv").filter((r) => r.Player_Name && r.Season).map(A.normalizeMasterRow);
const pool = A.buildCuratedPool(auc, mas, { teams: 10 });

// Mirrors the mapping in auction-room.js finishAuction.
function toXiEntry(p) {
  return {
    name: p.name,
    ovr: p.ovr,
    simOvr: p.ovr,
    bat: sandbox.shiftRating(p.bat, p.ovr, p.simOvr),
    bowl: sandbox.shiftRating(p.bowl, p.ovr, p.simOvr),
    isWk: p.isWk, isOverseas: p.isOverseas,
    primaryRole: p.primaryRole, battingOrder: p.battingOrder,
  };
}
// This is what sim-mp.js buildMpTeams actually reads.
const readOvr = (x) => Number(x.simOvr || x.ovr || 70);

const entries = pool.lots.map(toXiEntry);
ok("every player enters the sim at its auction OVR",
   entries.every((x, i) => readOvr(x) === pool.lots[i].ovr),
   entries.filter((x, i) => readOvr(x) !== pool.lots[i].ovr).slice(0, 3).map((x) => x.name).join(", "));
ok("no player is silently buffed to the master scale",
   entries.every((x, i) => readOvr(x) <= pool.lots[i].simOvr));
ok("bat/bowl move with the OVR, so display matches performance", (() => {
  return pool.lots.every((l, i) => {
    const d = l.ovr - l.simOvr;
    const e = entries[i];
    return e.bat === Math.max(30, Math.min(99, Math.round(l.bat + d))) &&
           e.bowl === Math.max(30, Math.min(99, Math.round(l.bowl + d)));
  });
})());
ok("sub-ratings stay in a sane range", entries.every((x) =>
   x.bat >= 30 && x.bat <= 99 && x.bowl >= 30 && x.bowl <= 99));

const shifted = pool.lots.filter((l, i) => entries[i].bat !== l.bat).length;
console.log(`      ${shifted}/${pool.lots.length} players had bat rescaled to the auction scale`);

// ---------- 2. seat trimming ----------
function seats(humans, bots) {
  const rows = [];
  for (let i = 0; i < humans; i++) {
    rows.push({ id: `h${i}`, is_bot: false, joined_at: new Date(1000 + i * 1000).toISOString(), xi: new Array(11).fill(0) });
  }
  for (let i = 0; i < bots; i++) {
    rows.push({ id: `bot_R_${i}`, is_bot: true, joined_at: new Date(9000 + i * 1000).toISOString(), xi: null });
  }
  return rows;
}

ok("a healthy 2-human room is untouched", sandbox.mpTrimToLeague(seats(2, 8)).length === 10);
ok("a full 10-human room is untouched", sandbox.mpTrimToLeague(seats(10, 0)).length === 10);
{
  // The exact failure that was reported: both managers seated 8 bots each.
  const trimmed = sandbox.mpTrimToLeague(seats(2, 16));
  ok("the 18-team room is cut back to 10", trimmed.length === 10, `got ${trimmed.length}`);
  ok("both humans keep their seat", trimmed.filter((p) => !p.is_bot).length === 2);
}
{
  const rows = seats(4, 12);
  const a = sandbox.mpTrimToLeague(rows).map((p) => p.id).sort();
  const b = sandbox.mpTrimToLeague([...rows].reverse()).map((p) => p.id).sort();
  ok("trimming is deterministic regardless of row order", JSON.stringify(a) === JSON.stringify(b));
}

// ---------- 3. the fixture list the trimmed league produces ----------
function scheduleFor(n) {
  sandbox.state.teams = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `T${i}` }));
  const ids = sandbox.state.teams.map((t) => t.id).sort();
  sandbox.GROUPS.A = ids.slice(0, 5);
  sandbox.GROUPS.B = ids.slice(5, 10);
  sandbox.USER_ID = ids[0];
  return sandbox.buildGroupFixtures();
}

{
  const rounds = scheduleFor(10);
  const all = rounds.flat();
  const played = {};
  all.forEach(([h, a]) => {
    played[h.id] = (played[h.id] || 0) + 1;
    played[a.id] = (played[a.id] || 0) + 1;
  });
  const counts = Object.values(played);
  ok("10 teams → 70 fixtures", all.length === 70, `got ${all.length}`);
  ok("10 teams → 14 matchdays", rounds.length === 14, `got ${rounds.length}`);
  ok("every team plays exactly 14", counts.length === 10 && counts.every((c) => c === 14),
     JSON.stringify(played));
  ok("nobody sits out a matchday", rounds.every((r) => {
    const ids = new Set();
    r.forEach(([h, a]) => { ids.add(h.id); ids.add(a.id); });
    return r.length === 5 && ids.size === 10;
  }));

  // The reported symptom: teams present in the table with zero fixtures.
  ok("no team finishes the schedule with 0 matches", counts.every((c) => c > 0));
}

{
  // The broken room's shape: 18 seats fed to a scheduler built for 10.
  sandbox.state.teams = Array.from({ length: 18 }, (_, i) => ({ id: `t${String(i).padStart(2, "0")}`, name: `T${i}` }));
  const ids = sandbox.state.teams.map((t) => t.id).sort();
  sandbox.GROUPS.A = ids.slice(0, 5);
  sandbox.GROUPS.B = ids.slice(5, 10);
  sandbox.USER_ID = ids[0];
  const all = sandbox.buildGroupFixtures().flat();
  const seen = new Set();
  all.forEach(([h, a]) => { seen.add(h.id); seen.add(a.id); });
  ok("confirms the old bug: 18 seats leave 8 teams with no fixtures at all",
     seen.size === 10, `${seen.size} of 18 teams got a fixture`);
}

// ---------- 4. full auction → league dry run ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const RUNS = Number(process.argv[2]) || 12;
for (let r = 0; r < RUNS; r++) {
  const teams = 2 + (r % 9);
  const rnd = rng(4400 + r);
  const p = A.buildCuratedPool(auc, mas, { teams });
  const managers = Array.from({ length: teams }, (_, i) => ({
    id: "h" + i, squad: [], purse: A.PURSE, aggression: 0.4 + rnd() * 1.2,
  }));
  for (const lot of p.lots) {
    if (A.isAuctionComplete(managers)) break;
    if (A.shouldAutoPass(managers, lot, lot.basePrice)) continue;
    let price = lot.basePrice, leader = null;
    for (;;) {
      const ch = managers.filter((m) => {
        if (m.id === (leader && leader.id) || !A.canBidOn(m, lot, price)) return false;
        const ceiling = A.maxBid(m.purse, A.XI_SIZE - m.squad.length);
        return price <= Math.min(ceiling, Math.round(lot.basePrice * (1 + m.aggression * (lot.ovr - 70) / 12))) && rnd() < 0.85;
      });
      if (!ch.length) break;
      leader = ch[Math.floor(rnd() * ch.length)];
      const next = A.nextBid(price);
      if (!A.canBidOn(leader, lot, next)) break;
      price = next;
    }
    if (leader) { leader.squad.push(lot); leader.purse -= price; }
  }
  const taken = managers.flatMap((m) => m.squad.map((x) => x.name));
  A.fillShortSquads(managers, p.lots, taken, p.lots);

  // What setUpLeague would see, and how many bots it therefore seats.
  const rows = managers
    .filter((m) => m.squad.length >= 11)
    .map((m, i) => ({ id: m.id, is_bot: false, joined_at: new Date(1000 + i * 1000).toISOString(),
                      xi: m.squad.map(toXiEntry) }));
  const need = Math.max(0, 10 - rows.length);
  for (let i = 0; i < need; i++) {
    rows.push({ id: `bot_R_${i}`, is_bot: true, joined_at: new Date(9000 + i * 1000).toISOString(), xi: null });
  }

  const league = sandbox.mpTrimToLeague(rows);
  ok(`run ${r} (${teams} managers) seats exactly 10 teams`, league.length === 10, `got ${league.length}`);
  ok(`run ${r} keeps every manager who has an XI`,
     league.filter((x) => !x.is_bot).length === rows.filter((x) => !x.is_bot).length);

  const rounds = scheduleFor(league.length);
  const tally = {};
  rounds.flat().forEach(([h, a]) => {
    tally[h.id] = (tally[h.id] || 0) + 1;
    tally[a.id] = (tally[a.id] || 0) + 1;
  });
  ok(`run ${r} gives all 10 teams a 14-game slate`,
     Object.keys(tally).length === 10 && Object.values(tally).every((c) => c === 14));

  // Nobody carries a master-scale rating into the league.
  const allXi = league.filter((x) => !x.is_bot).flatMap((x) => x.xi);
  const byName = {};
  p.lots.forEach((l) => (byName[l.name] = l));
  ok(`run ${r} carries the auction OVR into every XI`,
     allXi.every((x) => !byName[x.name] || readOvr(x) === byName[x.name].ovr));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
