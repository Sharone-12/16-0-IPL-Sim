// Recalibrate Bat_Rat / Bowl_Rat / OVR from each player-season's actual stats.
// FIFA-style: ratings are derived from performance, not assigned by hand.
//   node recalibrate.js preview   -> prints before/after for sample players
//   node recalibrate.js write     -> rewrites ipl_master_calibrated.csv
const fs = require("fs");
const Papa = require("papaparse");

const PATH = `${__dirname}/ipl_master_calibrated.csv`;
const raw = fs.readFileSync(PATH, "utf8");
const parsed = Papa.parse(raw, { header: true, skipEmptyLines: true });
const rows = parsed.data;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (x) => (x === "" || x == null ? 0 : +x);

// ---------- BATTING ----------
// Volume (season output) + strike rate + average, rate stats gated by sample size.
function batRating(r) {
  const balls = num(r.Batting_Balls_Faced);
  const runs = num(r.Batting_Runs);
  const sr = num(r.Batting_Strike_Rate);
  const avg = num(r.Batting_Average);
  // Not enough batting to judge -> fall back to a modest default by role.
  if (balls < 12 && runs < 20) return null;
  const conf = clamp(balls / 160, 0.3, 1);
  let v = 57;
  v += (Math.min(runs, 750) / 750) * 23;             // up to +23 for big seasons
  v += clamp((sr - 118) / 62, 0, 1) * 10 * conf;     // up to +10 for high SR
  v += clamp((avg - 18) / 30, 0, 1) * 7 * conf;      // up to +7 for high avg
  return clamp(Math.round(v), 55, 95);
}

// ---------- BOWLING ----------
// Wickets + economy + strike rate, gated by overs bowled.
function bowlRating(r) {
  const ballsB = num(r.Bowling_Balls);
  const wkts = num(r.Bowling_Wickets);
  const econ = num(r.Bowling_Economy);
  const bsr = num(r.Bowling_Strike_Rate);
  if (ballsB < 18) return null; // < 3 overs -> not a bowler this season
  const conf = clamp(ballsB / 180, 0.3, 1);
  let v = 56;
  v += (Math.min(wkts, 25) / 25) * 26;                       // up to +26 for wickets
  v += clamp((9.0 - econ) / 3.0, 0, 1) * 11 * conf;          // up to +11 for economy
  if (bsr > 0) v += clamp((24 - bsr) / 14, 0, 1) * 4 * conf; // up to +4 for strike rate
  return clamp(Math.round(v), 55, 95);
}

// Default ratings for players without a meaningful sample in that discipline.
function defaultBat(r) {
  // keepers/top order get a touch more than tail-enders
  const order = r.Batting_Order;
  if (order === "Opener" || order === "Middle Order" || order === "Finisher") return 66;
  return 60;
}
function defaultBowl() { return 55; }

function overall(bat, bowl, role) {
  if (role === "All-Rounder") {
    const hi = Math.max(bat, bowl), lo = Math.min(bat, bowl);
    return clamp(Math.round(hi * 0.62 + lo * 0.38 + 3), 55, 95);
  }
  if (role === "Bowler") return bowl;
  return bat; // Batsman, Wicketkeeper
}

function recalc(r) {
  const role = r.Primary_Role;
  let bat = batRating(r);
  let bowl = bowlRating(r);
  const batFinal = bat == null ? defaultBat(r) : bat;
  const bowlFinal = bowl == null ? defaultBowl() : bowl;
  const ovr = overall(batFinal, bowlFinal, role);
  return { bat: batFinal, bowl: bowlFinal, ovr };
}

const mode = process.argv[2] || "preview";

if (mode === "preview") {
  const want = [
    ["V Kohli", "2016"], ["R Parag", "2025"], ["R Parag", "2024"],
    ["JJ Bumrah", "2020"], ["Rashid Khan", "2018"], ["AD Russell", "2019"],
    ["RA Jadeja", "2023"], ["SA Yadav", "2023"], ["DA Warner", "2016"],
    ["YBK Jaiswal", "2023"], ["MS Dhoni", "2023"], ["B Sai Sudharsan", "2025"],
    ["Basil Thampi", "2017"], ["Mohammed Shami", "2023"], ["GJ Maxwell", "2021"],
    ["Sandeep Sharma", "2017"], ["AB de Villiers", "2016"], ["HH Pandya", "2024"],
  ];
  console.log("Player              Season  Role         OVR(old→new)  Bat(old→new)  Bowl(old→new)");
  want.forEach(([name, season]) => {
    const r = rows.find((x) => x.Player_Name === name && x.Season === season);
    if (!r) return;
    const n = recalc(r);
    const pad = (s, w) => String(s).padEnd(w);
    console.log(
      `${pad(name, 19)} ${pad(season, 7)} ${pad(r.Primary_Role, 12)} ` +
      `${pad(r.OVR + "→" + n.ovr, 13)} ${pad(r.Bat_Rat + "→" + n.bat, 13)} ${r.Bowl_Rat + "→" + n.bowl}`
    );
  });
  // distribution summary
  const ovrs = rows.map((r) => recalc(r).ovr);
  const buckets = {};
  ovrs.forEach((o) => { const b = Math.floor(o / 5) * 5; buckets[b] = (buckets[b] || 0) + 1; });
  console.log("\nNew OVR distribution:");
  Object.keys(buckets).sort((a, b) => a - b).forEach((b) =>
    console.log(`  ${b}-${+b + 4}: ${buckets[b]}`));
  const top = [...rows].map((r) => ({ r, ...recalc(r) })).sort((a, b) => b.ovr - a.ovr).slice(0, 12);
  console.log("\nTop 12 OVR after recalibration:");
  top.forEach((t) => console.log(`  ${t.ovr}  ${t.r.Player_Name} ${t.r.Season} ${t.r.Franchise} (${t.r.Primary_Role})`));
}

if (mode === "write") {
  rows.forEach((r) => {
    const n = recalc(r);
    r.Bat_Rat = n.bat;
    r.Bowl_Rat = n.bowl;
    r.OVR = n.ovr;
  });
  const out = Papa.unparse(rows, { columns: parsed.meta.fields });
  fs.writeFileSync(PATH, out + "\n");
  console.log(`Recalibrated ${rows.length} rows.`);
}
