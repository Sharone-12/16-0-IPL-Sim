const {
  runSeason,
  simulateDraft,
  evaluateOptimalPlayer,
  setDifficulty,
  setIsPrime,
  applyPrimeRatings
} = require("./stress_test.js");

// 1. Enable Prime Mode
applyPrimeRatings();
setIsPrime(true);

// 2. Set Difficulty to Easy
setDifficulty("easy");

async function run50kPrimeEasyStressTest() {
    const ITERATIONS = 50000;
    
    // Stats to track
    let championships = 0;
    let madePlayoffs = 0;   // Top 4
    let missedPlayoffs = 0; // Not Top 4
    
    // Record milestones
    let win_16_0 = 0; // 16-0
    let win_15_1 = 0; // 15-1
    let win_14_2 = 0; // 14-2
    
    // Track rosters of the 16-0 teams
    const perfectTeams = [];
    console.log(`Starting massive 50,000-run simulation in PRIME mode + EASY difficulty with 3 REROLLS...`);
    for (let i = 1; i <= ITERATIONS; i++) {
        // Log progress every 5,000 runs
        if (i % 5000 === 0) {
            console.log(`Simulated ${i} / ${ITERATIONS} seasons...`);
        }
        // 1. Run optimal draft with 3 rerolls
        const team = simulateDraft((legal, xi, picked, draftState) => {
            const scored = legal.map(p => ({
                player: p,
                score: evaluateOptimalPlayer(p, xi, picked)
            })).sort((a, b) => b.score - a.score);
            
            const bestChoice = scored[0];

            if (draftState && draftState.rerollsLeft > 0) {
                let threshold = 76;
                if (picked < 4) threshold = 83;
                else if (picked < 7) threshold = 79;
                else if (picked < 9) threshold = 74;

                if (bestChoice.score < threshold) {
                    draftState.rerollsLeft--;
                    return null; // triggers a respin
                }
            }

            return bestChoice.player;
        }, { rerolls: 3 });
        
        // 2. Simulate the 14-match season + playoffs
        const seasonResult = runSeason(team); 
        const wins = seasonResult.wins;
        // 3. Track playoff qualifications (Top 4)
        if (seasonResult.rank <= 4) {
            madePlayoffs++;
        } else {
            missedPlayoffs++;
        }
        // 4. Track Championship
        if (seasonResult.champion) {
            championships++;
        }
        // 5. Track specific win records
        if (wins === 16) {
            win_16_0++;
            perfectTeams.push(team);
        } else if (wins === 15) {
            win_15_1++;
        } else if (wins === 14) {
            win_14_2++;
        }
    }
    // --- REPORT GENERATION ---
    console.log("\n===============================================================");
    console.log("    50,000 DRAFTS DEEP SIMULATION REPORT (PRIME + EASY + 3 REROLLS)    ");
    console.log("===============================================================");
    console.log(`Total Seasons Played: ${ITERATIONS.toLocaleString()}`);
    console.log("---------------------------------------------------------------");
    
    // Playoff & Champ Rates
    const playoffPct = ((madePlayoffs / ITERATIONS) * 100).toFixed(2);
    const missedPlayoffPct = ((missedPlayoffs / ITERATIONS) * 100).toFixed(2);
    const champPct = ((championships / ITERATIONS) * 100).toFixed(2);
    console.log(`🏆 Championship Rate:   ${champPct}% (${championships.toLocaleString()} times)`);
    console.log(`📈 Made Playoffs (Top 4): ${playoffPct}% (${madePlayoffs.toLocaleString()} times)`);
    console.log(`📉 Missed Playoffs:       ${missedPlayoffPct}% (${missedPlayoffs.toLocaleString()} times)`);
    console.log("---------------------------------------------------------------");
    
    // Milestones Rates
    const rate16_0 = ((win_16_0 / ITERATIONS) * 100).toFixed(4);
    const rate15_1 = ((win_15_1 / ITERATIONS) * 100).toFixed(4);
    const rate14_2 = ((win_14_2 / ITERATIONS) * 100).toFixed(4);
    console.log("🔥 ELITE WIN MILESTONES:");
    console.log(`- Perfect Seasons (16-0):  ${rate16_0}% (${win_16_0} times)`);
    console.log(`- Near-Perfect (15-1):     ${rate15_1}% (${win_15_1} times)`);
    console.log(`- Strong Season (14-2):    ${rate14_2}% (${win_14_2} times)`);
    
    // Print 16-0 teams if any were found
    if (win_16_0 > 0) {
        console.log("\n👑 THE 16-0 SQUADS FOUND:");
        perfectTeams.forEach((team, idx) => {
            console.log(`  Team #${idx + 1}: ${team.map(p => `${p.name} (${p.season})`).join(', ')}`);
        });
    } else {
        console.log("\n❌ No 16-0 teams found in this 50,000 run.");
    }
    console.log("===============================================================");
}

run50kPrimeEasyStressTest().catch(console.error);
