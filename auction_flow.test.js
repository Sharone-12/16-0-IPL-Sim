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

// ---------- 3b. drag-to-reorder ----------
// squadLayout/moveSlot/buildXi are lifted out of auction-room.js and run against
// a stubbed room, so the reorder rules are tested as shipped rather than restated.
const dragBox = {
  console,
  A,
  PID: "me",
  S: { order: [], pinned: new Set() },
  toast: (m) => dragBox.lastToast = m,
  renderSquad: () => {},
  squadOf: () => dragBox.squad,
  squad: [],
  lastToast: null,
  SLOT_LABELS: new Array(11).fill(""),
  // ORDER_KEY is a module-level const, not a function, so it can't be lifted.
  ORDER_KEY: "auction_order_TEST",
  localStorage: (() => {
    const mem = {};
    return {
      getItem: (k) => (k in mem ? mem[k] : null),
      setItem: (k, v) => { mem[k] = String(v); },
      removeItem: (k) => { delete mem[k]; },
    };
  })(),
};
vm.createContext(dragBox);
vm.runInContext(
  lift(roomSrc, ["squadLayout", "moveSlot", "buildXi", "shiftRating", "saveOrder", "loadOrder", "looseLayout"]),
  dragBox
);

// Build a squad the way the auction does: walk the lots and take anything canAdd
// still allows. Hand-picking by role does not work — Buttler is a keeper who
// OPENS and Watson an all-rounder who OPENS, so a role-based fixture quietly
// lands five players who can only bat 1-3 and no legal XI exists. Feasibility
// also guarantees the squad covers all 11 slots, which is what the drag tests
// need anyway.
function makeSquad(size, from) {
  const out = [];
  for (let i = from || 0; i < pool.lots.length && out.length < size; i++) {
    if (A.canAdd(out, pool.lots[i])) out.push(pool.lots[i]);
  }
  if (out.length < size) throw new Error(`fixture could only assemble ${out.length}/${size}`);
  return out;
}

function loadSquad(players) {
  dragBox.squad = players;
  dragBox.S.order = [];
  dragBox.S.pinned = new Set();
  return dragBox.squadLayout();
}
const slotOf = (name) => dragBox.S.order.indexOf(name);
const legalLayout = () =>
  dragBox.S.order.every((n, s) => !n || A.eligibleSlots(dragBox.squad.find((p) => p.name === n)).includes(s));

{
  // A realistic full XI: 3 openers, 3 middle, a keeper, an all-rounder, 3 bowlers.
  const squad = makeSquad(11);
  ok("test fixture builds an 11", squad.length === 11, `got ${squad.length}`);
  ok("test fixture has no duplicate player",
     new Set(squad.map((p) => p.name)).size === 11);
  ok("test fixture is a squad the auction would actually allow", A.squadFeasible(squad));

  loadSquad(squad);
  ok("auto layout is legal for every slot", legalLayout());
  ok("auto layout seats all 11", dragBox.S.order.filter(Boolean).length === 11);

  const first = [...dragBox.S.order];
  dragBox.squadLayout();
  dragBox.squadLayout();
  ok("layout does not shuffle between renders",
     JSON.stringify(dragBox.S.order) === JSON.stringify(first));

  // Legal swap: find two players whose eligible slots overlap both ways.
  const pair = (() => {
    for (const x of squad) for (const y of squad) {
      if (x === y) continue;
      const sx = slotOf(x.name), sy = slotOf(y.name);
      if (A.eligibleSlots(x).includes(sy) && A.eligibleSlots(y).includes(sx)) return [x, y, sx, sy];
    }
    return null;
  })();
  ok("squad contains a legally swappable pair", !!pair);
  const [x, y, sx, sy] = pair;
  dragBox.moveSlot(sx, sy);
  ok("a legal swap moves both players", slotOf(x.name) === sy && slotOf(y.name) === sx);
  ok("both swapped players become hand-placed",
     dragBox.S.pinned.has(x.name) && dragBox.S.pinned.has(y.name));
  ok("layout is still legal after the swap", legalLayout());

  // Illegal: a specialist bowler cannot open.
  const bowler = squad.find((p) => !A.eligibleSlots(p).includes(0));
  const before = [...dragBox.S.order];
  dragBox.lastToast = null;
  dragBox.moveSlot(slotOf(bowler.name), 0);
  ok("a player barred from slot 1 cannot be dragged there",
     JSON.stringify(dragBox.S.order) === JSON.stringify(before));
  ok("the rejected move explains itself", /can't bat at 1/.test(dragBox.lastToast || ""));

  // A no-op drag onto itself changes nothing.
  dragBox.moveSlot(3, 3);
  ok("dropping a player on itself is a no-op",
     JSON.stringify(dragBox.S.order) === JSON.stringify(before));
}

{
  // A hand-placed slot must survive the next signing.
  // A part-built squad, mid-auction.
  const full = makeSquad(11);
  const squad = full.slice(0, 6);
  loadSquad(squad);
  // Move somebody to a different legal slot that nobody else is using.
  const moved = squad.find((p) => A.eligibleSlots(p).some(
    (s) => s !== slotOf(p.name) && dragBox.S.order[s] == null));
  ok("part-built squad has somewhere to drag to", !!moved);
  const target = A.eligibleSlots(moved).find(
    (s) => s !== slotOf(moved.name) && dragBox.S.order[s] == null);
  dragBox.moveSlot(slotOf(moved.name), target);
  ok("player sits where it was dragged", slotOf(moved.name) === target);

  // Sign the rest; the hand-placed slot must hold.
  dragBox.squad = full;
  dragBox.squadLayout();
  ok("a hand-placed slot survives later signings", slotOf(moved.name) === target,
     `moved to ${slotOf(moved.name)}`);
  ok("layout stays legal as the squad grows", legalLayout());
}

{
  // The dragged order is what reaches players.xi.
  const squad = makeSquad(11);
  loadSquad(squad);
  for (const x of squad) {
    const alt = A.eligibleSlots(x).find((s) => {
      const y = squad.find((p) => p.name === dragBox.S.order[s]);
      return s !== slotOf(x.name) && y && A.eligibleSlots(y).includes(slotOf(x.name));
    });
    if (alt != null) { dragBox.moveSlot(slotOf(x.name), alt); break; }
  }
  const order = [...dragBox.S.order];

  const xi = dragBox.buildXi("me");
  ok("buildXi emits 11 in slot order", xi.length === 11 && xi.every((x, i) => x.slot === i));
  const expected = order.map((n) => (squad.find((p) => p.name === n) || {}).displayName);
  ok("buildXi honours the dragged batting order",
     xi.every((x, i) => x.name === expected[i]),
     `got  ${xi.map((x) => x.name).join(" | ")}\n      want ${expected.join(" | ")}`);
  ok("only the top-order anchor is captain",
     xi.filter((x) => x.isCaptain).length === 1 && xi[0].isCaptain);
  ok("buildXi carries the auction OVR", xi.every((x) => x.simOvr === x.ovr));
}

{
  // A refresh mid-auction must not cost you the order you set.
  const squad = makeSquad(11);
  loadSquad(squad);
  for (const x of squad) {
    const alt = A.eligibleSlots(x).find((s) => {
      const y = squad.find((p) => p.name === dragBox.S.order[s]);
      return s !== slotOf(x.name) && y && A.eligibleSlots(y).includes(slotOf(x.name));
    });
    if (alt != null) { dragBox.moveSlot(slotOf(x.name), alt); break; }
  }
  const kept = [...dragBox.S.order];
  const pins = [...dragBox.S.pinned];

  // Simulate the reload: wipe in-memory state, restore from storage, re-layout.
  dragBox.S.order = [];
  dragBox.S.pinned = new Set();
  dragBox.loadOrder();
  dragBox.squadLayout();
  ok("the batting order survives a page refresh",
     JSON.stringify(dragBox.S.order) === JSON.stringify(kept),
     `after ${JSON.stringify(dragBox.S.order)}`);
  ok("hand-placed pins survive a page refresh",
     pins.every((n) => dragBox.S.pinned.has(n)));
}

{
  // The last-resort layout: an unassignable squad must still show everyone,
  // each in a distinct slot, rather than vanish or duplicate a position.
  const impossible = pool.lots.filter((l) => A.eligibleSlots(l).join() === "0,1,2").slice(0, 5);
  ok("found 5 players who can only bat 1-3", impossible.length === 5);
  ok("that squad genuinely has no legal XI", A.assignSlots(impossible) === null);
  const loose = dragBox.looseLayout(impossible);
  ok("loose layout still seats all five", loose.filter((s) => s >= 0).length === 5);
  ok("loose layout never doubles up a slot",
     new Set(loose.filter((s) => s >= 0)).size === loose.filter((s) => s >= 0).length);
  ok("loose layout keeps slots in range", loose.every((s) => s >= 0 && s < A.XI_SIZE));
}

// ---------- 3c. the bid clock ----------
// A bid must never shorten the countdown and never inflate it without bound.
// The old behaviour replaced the deadline with `now + bump`, so bidding at 5s
// on a brisk clock moved it to 6s ("+1 second") and the first bid on a relaxed
// 12s clock cut it to 8s.
const clockBox = { console, S: { clock: null }, msLeft: () => clockBox.left, left: 0, Date };
vm.createContext(clockBox);
vm.runInContext(lift(roomSrc, ["bumpedDeadline"]), clockBox);

const CLOCKS = {
  snappy:  { open: 6000,  bump: 5000 },
  brisk:   { open: 8000,  bump: 6000 },
  relaxed: { open: 12000, bump: 8000 },
};
function newClock(preset, left) {
  clockBox.S.clock = CLOCKS[preset];
  clockBox.left = left;
  return Date.parse(clockBox.bumpedDeadline()) - Date.now();
}
const near = (a, b) => Math.abs(a - b) <= 60; // tolerance for the Date.now() gap

ok("brisk: bidding at 5s left extends to the 8s ceiling, not 6s",
   near(newClock("brisk", 5000), 8000), `got ${newClock("brisk", 5000)}`);
ok("brisk: a last-gasp bid still buys the full 6s bump",
   near(newClock("brisk", 0), 6000), `got ${newClock("brisk", 0)}`);
ok("relaxed: the first bid no longer SHORTENS a 12s clock",
   near(newClock("relaxed", 11000), 12000), `got ${newClock("relaxed", 11000)}`);
ok("snappy: capped at its 6s opening duration",
   near(newClock("snappy", 5000), 6000), `got ${newClock("snappy", 5000)}`);

for (const [name, c] of Object.entries(CLOCKS)) {
  let neverShortens = true, neverExceeds = true, alwaysMin = true;
  for (let left = 0; left <= c.open; left += 250) {
    const got = newClock(name, left);
    if (got + 60 < left) neverShortens = false;
    if (got > c.open + 60) neverExceeds = false;
    if (got + 60 < c.bump) alwaysMin = false;
  }
  ok(`${name}: a bid never shortens the clock`, neverShortens);
  ok(`${name}: a bid never pushes past the opening duration`, neverExceeds);
  ok(`${name}: a bid always leaves at least the bump`, alwaysMin);
}

// ---------- 3d. host kick ----------
// A removed manager must lose their VOTE but keep their TEAM. Deleting the row
// instead would change the roster, and every client derives fixtures from that
// roster — so anyone reloading after the kick would compute a different season.
const kickBox = {
  console,
  MP_PID: "me",
  mpPlayers: [],
  MP_PRESENCE_WINDOW_MS: 60000,
  MP_LEAGUE_SIZE: 10,
};
vm.createContext(kickBox);
vm.runInContext(lift(simSrc, ["mpLiveHumans", "mpTrimToLeague"]), kickBox);

{
  const now = Date.now();
  const stamp = (s) => new Date(now - s * 1000).toISOString();
  kickBox.mpPlayers = [
    { id: "me",    is_bot: false, status: "ready",  last_seen: stamp(0) },
    { id: "alice", is_bot: false, status: "ready",  last_seen: stamp(2) },
    { id: "bob",   is_bot: false, status: "kicked", last_seen: stamp(1) },  // idle, tab open
    { id: "carol", is_bot: false, status: "ready",  last_seen: stamp(400) }, // tab closed
    { id: "bot_1", is_bot: true,  status: "done",   last_seen: stamp(0) },
  ];
  const live = kickBox.mpLiveHumans().map((p) => p.id);
  ok("a kicked manager is dropped from the voters", !live.includes("bob"), live.join(","));
  ok("a stale heartbeat is still dropped too", !live.includes("carol"), live.join(","));
  ok("everyone else still votes", live.includes("me") && live.includes("alice"));
  ok("bots never vote", !live.includes("bot_1"));

  // ...but the league roster is untouched by the kick.
  const rows = kickBox.mpPlayers
    .filter((p) => p.id !== "bot_1")
    .map((p, i) => ({ ...p, joined_at: new Date(1000 + i * 1000).toISOString(),
                      xi: p.is_bot ? null : new Array(11).fill(0) }));
  for (let i = 0; i < 6; i++) {
    rows.push({ id: `bot_R_${i}`, is_bot: true, status: "done",
                joined_at: new Date(9000 + i * 1000).toISOString(), xi: null });
  }
  const seated = kickBox.mpTrimToLeague(rows).map((p) => p.id);
  ok("a kicked manager keeps their league seat", seated.includes("bob"), seated.join(","));
  ok("the league is still exactly 10 teams", seated.length === 10, `got ${seated.length}`);

  // The sim's own roster filter must agree — it is what buildMpTeams consumes.
  const boot = rows.filter((p) => p.is_bot || (Array.isArray(p.xi) && p.xi.length >= 11));
  ok("mpBoot's roster filter also keeps a kicked manager",
     boot.some((p) => p.id === "bob"));
}

// ---------- 3e. the manager who buys three players and leaves ----------
// Their squad is completed from the unsold lots at base price so they still
// field a legal XI, keep the players they actually bought, and never strand
// those players outside the league.
{
  const p4 = A.buildCuratedPool(auc, mas, { teams: 4 });
  const mine = makeSquad(3);                       // three real signings
  const abandoned = { id: "gone", squad: [...mine], purse: A.PURSE - 4000 };
  const others = [1, 2, 3].map((i) => ({ id: "m" + i, squad: [], purse: A.PURSE }));
  const taken = mine.map((p) => p.name);

  A.fillShortSquads([abandoned, ...others], p4.lots, taken, p4.lots);

  ok("an abandoned 3-player squad is completed to a full XI",
     abandoned.squad.length === A.XI_SIZE, `got ${abandoned.squad.length}`);
  ok("the three they actually bought are still theirs",
     mine.every((p) => abandoned.squad.some((x) => x.name === p.name)));
  ok("the completed XI is legal", A.squadFeasible(abandoned.squad));
  ok("the completed XI has a slot assignment", !!A.assignSlots(abandoned.squad));
  ok("a keeper reaches the top order", (() => {
    const slots = A.assignSlots(abandoned.squad);
    return !!slots && abandoned.squad.some((x, i) => x.isWk && slots[i] < 7);
  })());
  ok("the overseas cap still holds",
     abandoned.squad.filter((x) => x.isOverseas).length <= A.MAX_OVERSEAS);
  ok("they never overspend", abandoned.purse >= 0, `purse ${abandoned.purse}`);
  ok("nobody else was handed the same player", (() => {
    const all = [abandoned, ...others].flatMap((m) => m.squad.map((x) => x.name));
    return new Set(all).size === all.length;
  })());
}

// How good is a walked-away team, really? Measured inside a REAL auction, where
// the leftovers have already been picked over — filling from the untouched pool
// would flatter it badly (it comes out level with a fully-bid squad, which is
// nonsense).
{
  const avg = (sq) => sq.reduce((a, x) => a + x.ovr, 0) / sq.length;
  const results = {};
  for (const quit of [0, 3, 6, 11]) {
    const samples = [];
    for (let r = 0; r < 12; r++) {
      const teams = 6;
      const rnd = rng(3300 + r);
      const p = A.buildCuratedPool(auc, mas, { teams });
      const ms = Array.from({ length: teams }, (_, i) => ({
        id: "m" + i, squad: [], purse: A.PURSE, aggression: 0.4 + rnd() * 1.2,
      }));
      const quitter = ms[0];
      for (const lot of p.lots) {
        if (A.isAuctionComplete(ms)) break;
        // The quitter stops bidding once they have `quit` players.
        const active = ms.filter((m) => m !== quitter || m.squad.length < quit);
        if (A.shouldAutoPass(active, lot, lot.basePrice)) continue;
        let price = lot.basePrice, leader = null;
        for (;;) {
          const ch = active.filter((m) => {
            if (m.id === (leader && leader.id) || !A.canBidOn(m, lot, price)) return false;
            const ceiling = A.maxBid(m.purse, A.XI_SIZE - m.squad.length);
            return price <= Math.min(ceiling,
              Math.round(lot.basePrice * (1 + m.aggression * (lot.ovr - 70) / 12))) && rnd() < 0.85;
          });
          if (!ch.length) break;
          leader = ch[Math.floor(rnd() * ch.length)];
          const next = A.nextBid(price);
          if (!A.canBidOn(leader, lot, next)) break;
          price = next;
        }
        if (leader) { leader.squad.push(lot); leader.purse -= price; }
      }
      A.fillShortSquads(ms, p.lots, ms.flatMap((m) => m.squad.map((x) => x.name)), p.lots);
      ok(`quitter with ${quit} signings still fields a legal XI`,
         quitter.squad.length === A.XI_SIZE && A.squadFeasible(quitter.squad),
         `run ${r}: ${quitter.squad.length} players`);
      samples.push(avg(quitter.squad));
    }
    results[quit] = samples.reduce((a, b) => a + b, 0) / samples.length;
  }
  console.log("      abandoned-team strength (6-manager auction, 12 runs each):");
  for (const [k, v] of Object.entries(results)) {
    console.log(`        quit after ${String(k).padStart(2)} signings -> XI avg OVR ${v.toFixed(1)}`);
  }
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
