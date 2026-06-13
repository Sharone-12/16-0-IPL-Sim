// ===================== 16-0 IPL Simulator — 100,000 Seasons Simulation =====================
// Runs 100,000 seasons utilizing the Optimal drafting strategy.
// Aggregates statistics on-the-fly to ensure low memory consumption.
//
// Usage:
//   node run_100k_test.js [iterations]
//

const engine = require("./stress_test.js");

async function run100kSimulation() {
  // Allow passing custom iteration count via CLI (e.g. for a quick dry run), defaulting to 100,000
  const ITERATIONS = process.argv[2] ? parseInt(process.argv[2], 10) : 100000;
  if (isNaN(ITERATIONS) || ITERATIONS <= 0) {
    console.error("Invalid iteration count. Please provide a positive integer.");
    process.exit(1);
  }

  // 1. Team Milestones & Ratios
  let championships = 0;
  let playoffs = 0;
  let missedPlayoffs = 0;

  // 2. Win Record Frequencies
  let perfect_16_0 = 0;
  let nearPerfect_15_1 = 0;
  let strong_14_2 = 0;

  // 3. Individual Award Calibration Stats
  let totalOrangeRuns = 0;
  let minOrangeRuns = Infinity;
  let maxOrangeRuns = -Infinity;

  let totalPurpleWickets = 0;
  let minPurpleWickets = Infinity;
  let maxPurpleWickets = -Infinity;

  // 4. 16-0 Roster Logger
  const perfectRosters = [];

  const startTime = Date.now();
  console.log(`Starting massive ${ITERATIONS.toLocaleString()}-season simulation using OPTIMAL drafting...`);

  for (let i = 1; i <= ITERATIONS; i++) {
    // Run draft with optimal strategy & simulate the season
    const xi = engine.runDraftWithStrategy("optimal");
    const result = engine.runSeason(xi);

    // 1. Milestones & Ratios
    if (result.champion) {
      championships++;
    }
    if (result.rank <= 4) {
      playoffs++;
    } else {
      missedPlayoffs++;
    }

    // 2. Win Record Frequencies
    if (result.wins === 16 && result.losses === 0) {
      perfect_16_0++;
      perfectRosters.push({
        seasonNumber: i,
        roster: xi.map((p, idx) => ({
          slot: idx + 1,
          name: p.name,
          franchise: p.fr,
          season: p.season,
          ovr: p.ovr,
        })),
      });
    } else if (result.wins === 15 && result.losses === 1) {
      nearPerfect_15_1++;
    } else if (result.wins === 14 && result.losses === 2) {
      strong_14_2++;
    }

    // 3. Individual Award Calibration Stats
    if (result.orangeCap) {
      const runs = result.orangeCap.runs;
      totalOrangeRuns += runs;
      if (runs < minOrangeRuns) minOrangeRuns = runs;
      if (runs > maxOrangeRuns) maxOrangeRuns = runs;
    }

    if (result.purpleCap) {
      const wickets = result.purpleCap.wickets;
      totalPurpleWickets += wickets;
      if (wickets < minPurpleWickets) minPurpleWickets = wickets;
      if (wickets > maxPurpleWickets) maxPurpleWickets = wickets;
    }

    // Progress Output every 10,000 runs
    if (i % 10000 === 0 || i === ITERATIONS) {
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`Simulated ${i.toLocaleString()} / ${ITERATIONS.toLocaleString()} seasons... (${elapsedSec}s elapsed)`);
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const avgOrange = totalOrangeRuns / ITERATIONS;
  const avgPurple = totalPurpleWickets / ITERATIONS;

  // Print Formatted ASCII/Console Report
  console.log("\n" + "=".repeat(75));
  console.log(`      16-0 IPL SIMULATOR — ${ITERATIONS.toLocaleString()} SEASONS DEEP SIMULATION REPORT`);
  console.log("=".repeat(75));
  console.log(`Total Seasons Simulated: ${ITERATIONS.toLocaleString()}`);
  console.log(`Total Execution Time:    ${durationSec} seconds`);
  console.log("-".repeat(75));
  console.log("🏆 TEAM MILESTONES & RATIOS:");
  console.log(`  Championships:         ${championships.toLocaleString().padEnd(8)} | Rate: ${((championships / ITERATIONS) * 100).toFixed(2)}%`);
  console.log(`  Playoff Qualifications:${playoffs.toLocaleString().padEnd(8)} | Rate: ${((playoffs / ITERATIONS) * 100).toFixed(2)}%`);
  console.log(`  Missed Playoffs:       ${missedPlayoffs.toLocaleString().padEnd(8)} | Rate: ${((missedPlayoffs / ITERATIONS) * 100).toFixed(2)}%`);
  console.log("-".repeat(75));
  console.log("🔥 WIN RECORD FREQUENCIES:");
  console.log(`  Perfect Seasons (16-0):  ${perfect_16_0.toLocaleString().padEnd(8)} | Rate: ${((perfect_16_0 / ITERATIONS) * 100).toFixed(4)}%`);
  console.log(`  Near-Perfect (15-1):     ${nearPerfect_15_1.toLocaleString().padEnd(8)} | Rate: ${((nearPerfect_15_1 / ITERATIONS) * 100).toFixed(4)}%`);
  console.log(`  Strong Seasons (14-2):   ${strong_14_2.toLocaleString().padEnd(8)} | Rate: ${((strong_14_2 / ITERATIONS) * 100).toFixed(4)}%`);
  console.log("-".repeat(75));
  console.log("👑 INDIVIDUAL AWARD CALIBRATION:");
  console.log(`  Orange Cap (Runs):       Average: ${avgOrange.toFixed(1).padEnd(6)} | Min: ${minOrangeRuns} | Max: ${maxOrangeRuns}`);
  console.log(`  Purple Cap (Wickets):    Average: ${avgPurple.toFixed(1).padEnd(6)} | Min: ${minPurpleWickets} | Max: ${maxPurpleWickets}`);
  console.log("=".repeat(75));

  if (perfectRosters.length > 0) {
    console.log(`\n👑 PERFECT 16-0 ROSTERS LOGGED (${perfectRosters.length}):`);
    perfectRosters.forEach((pr) => {
      console.log(`\n  --- Season #${pr.seasonNumber} Perfect XI ---`);
      pr.roster.forEach((p) => {
        console.log(`    Slot ${p.slot}: ${p.name.padEnd(25)} (${p.franchise} ${p.season}, OVR: ${p.ovr})`);
      });
    });
    console.log("=".repeat(75));
  } else {
    console.log(`\nNo perfect 16-0 seasons were recorded in ${ITERATIONS.toLocaleString()} seasons.`);
    console.log("=".repeat(75));
  }
}

run100kSimulation().catch(console.error);
