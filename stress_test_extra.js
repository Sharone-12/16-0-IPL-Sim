// ===== 16-0 — extra stress analyses (uses the real engine from stress_test.js) =====
//   node stress_test_extra.js [runs]
const fs = require("fs");
const E = require("./stress_test");

const RUNS = parseInt(process.argv[2], 10) || 1000;
const out = { runs: RUNS };

const isAR = (p) => p && p.primaryRole === "All-Rounder";
const printXI = (xi) =>
  xi.forEach((p, i) =>
    console.log(
      `   ${String(i + 1).padStart(2)}. [${E.SLOTS[i]}] ${p ? `${p.name} (${p.fr} ${p.season}) OVR:${p.ovr} ${p.primaryRole}${p.isWk ? " WK" : ""}${p.isOverseas ? " ✈" : ""}` : "EMPTY"}`
    )
  );
const validate = (xi) => {
  const filled = xi.filter(Boolean);
  return {
    count: filled.length,
    bowlers: filled.filter((p) => p.primaryRole === "Bowler").length,
    allrounders: filled.filter(isAR).length,
    keepers: filled.filter((p) => p.isWk).length,
    overseas: filled.filter((p) => p.isOverseas).length,
  };
};

// ---------- TEST 1: worst 3 random XIs ----------
console.log(`\n========== TEST 1 — Worst 3 RANDOM drafts (of ${RUNS}) ==========`);
E.setStrategy("random");
const randomRuns = [];
for (let i = 0; i < RUNS; i++) {
  const xi = E.simulateDraft();
  randomRuns.push({ xi, result: E.runSeason(xi) });
}
const worst3 = [...randomRuns].sort((a, b) => a.result.wins - b.result.wins).slice(0, 3);
worst3.forEach(({ xi, result }, n) => {
  const v = validate(xi);
  console.log(`\n--- Worst #${n + 1}: ${result.wins} wins, rank ${result.rank} ---`);
  console.log(`   Legal check: ${v.count}/11 filled · ${v.bowlers} bowlers · ${v.allrounders} AR · ${v.keepers} WK · ${v.overseas} overseas`);
  if (v.count < 11) console.log("   ⚠ INCOMPLETE XI");
  if (v.keepers === 0) console.log("   ⚠ NO WICKETKEEPER");
  if (v.bowlers + v.allrounders < 4) console.log("   ⚠ THIN BOWLING (<4 bowl options)");
  printXI(xi);
});
out.worst3Random = worst3.map(({ xi, result }) => ({
  result, validation: validate(xi),
  xi: xi.map((p, i) => p && { slot: E.SLOTS[i], name: p.name, fr: p.fr, season: p.season, ovr: p.ovr, role: p.primaryRole, wk: p.isWk }),
}));

// ---------- helper to run a custom-chooser strategy ----------
function runStrategy(label, chooser, runs) {
  const results = [];
  for (let i = 0; i < runs; i++) {
    const xi = E.simulateDraft(chooser);
    if (xi.some((s) => s === null)) continue; // skip rare incomplete
    results.push({ xi, result: E.runSeason(xi) });
  }
  const n = results.length;
  const champ = results.filter((r) => r.result.champion).length / n;
  const perfect = results.filter((r) => r.result.wins === 16 && r.result.losses === 0).length;
  const top4 = results.filter((r) => r.result.rank <= 4).length / n;
  const avg = results.reduce((a, r) => a + r.result.wins, 0) / n;
  console.log(`\n=== ${label} (${n} valid runs) ===`);
  console.log(`Championship rate: ${(champ * 100).toFixed(1)}%`);
  console.log(`16-0 rate:         ${((perfect / n) * 100).toFixed(2)}%  (${perfect})`);
  console.log(`Top-4 rate:        ${(top4 * 100).toFixed(1)}%`);
  console.log(`Avg total wins:    ${avg.toFixed(2)}`);
  return { label, n, champRate: champ, perfectRate: perfect / n, top4Rate: top4, avgWins: avg };
}

// Baseline greedy for comparison
const greedyChooser = (legal) => [...legal].sort((a, b) => b.ovr - a.ovr)[0];

// ---------- TEST 2: all-rounder heavy (force AR into slots 5,6,7 = idx 4,5,6) ----------
console.log(`\n========== TEST 2 — All-rounder heavy vs greedy ==========`);
const AR_SLOTS = new Set([4, 5, 6]);
const arChooser = (legal, xi, picked) => {
  // While AR slots remain empty, demand an all-rounder that fits one of them.
  const arSlotsOpen = [...AR_SLOTS].some((s) => xi[s] === null);
  const arsLocked = [...AR_SLOTS].filter((s) => isAR(xi[s])).length;
  if (arSlotsOpen && arsLocked < 3) {
    const ars = legal.filter((p) => isAR(p) && E.eligibleSlots(p).some((s) => AR_SLOTS.has(s) && xi[s] === null));
    if (ars.length) return [...ars].sort((a, b) => b.ovr - a.ovr)[0];
    // no AR available this spin — only respin if we still have time to fill ARs
    const emptyNonAr = xi.filter((p, i) => p === null && !AR_SLOTS.has(i)).length;
    if (emptyNonAr > 0) return greedyChooser(legal); // fill elsewhere, keep AR slots open
    return null; // must respin for an AR
  }
  return greedyChooser(legal);
};
const baseGreedy2 = runStrategy("STANDARD GREEDY", greedyChooser, RUNS);
const arHeavy = runStrategy("ALL-ROUNDER HEAVY (3+ AR)", arChooser, RUNS);

// ---------- TEST 3: only OVR 88+ ----------
console.log(`\n========== TEST 3 — OVR 88+ only vs greedy ==========`);
const eliteChooser = (legal) => {
  const elite = legal.filter((p) => p.ovr >= 88);
  if (!elite.length) return null; // respin — nothing elite here
  return [...elite].sort((a, b) => b.ovr - a.ovr)[0];
};
const elite = runStrategy("OVR 88+ ONLY", eliteChooser, RUNS);

out.strategies = { baselineGreedy: baseGreedy2, allRounderHeavy: arHeavy, elite88: elite };

// ---------- TEST 4: every 16-0 XI from a large greedy batch ----------
console.log(`\n========== TEST 4 — Perfect 16-0 XIs (greedy) ==========`);
E.setStrategy("greedy");
const PERFECT_RUNS = Math.max(RUNS, 3000);
const perfectXIs = [];
for (let i = 0; i < PERFECT_RUNS; i++) {
  const xi = E.simulateDraft();
  const r = E.runSeason(xi);
  if (r.wins === 16 && r.losses === 0) perfectXIs.push(xi);
}
console.log(`Found ${perfectXIs.length} perfect 16-0 teams in ${PERFECT_RUNS} greedy drafts (${((perfectXIs.length / PERFECT_RUNS) * 100).toFixed(2)}%)`);
perfectXIs.forEach((xi, n) => {
  const avgOvr = (xi.reduce((a, p) => a + p.ovr, 0) / 11).toFixed(1);
  console.log(`\n--- 16-0 XI #${n + 1} (avg OVR ${avgOvr}) ---`);
  printXI(xi);
});
out.perfectXIs = perfectXIs.map((xi) => ({
  avgOvr: +(xi.reduce((a, p) => a + p.ovr, 0) / 11).toFixed(1),
  xi: xi.map((p, i) => ({ slot: E.SLOTS[i], name: p.name, fr: p.fr, season: p.season, ovr: p.ovr, role: p.primaryRole, wk: p.isWk, overseas: p.isOverseas })),
}));

// ---------- append to results json ----------
let existing = {};
try { existing = JSON.parse(fs.readFileSync(`${__dirname}/stress_test_results.json`, "utf8")); } catch (_) {}
existing.extra = out;
fs.writeFileSync(`${__dirname}/stress_test_results.json`, JSON.stringify(existing, null, 2));
console.log("\nExtra results appended to stress_test_results.json");
