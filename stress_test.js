// ===================== 16-0 — headless stress test =====================
// Faithful Node port of the REAL draft.js + simulation.js engines (no DOM).
// Runs thousands of drafts + full seasons to measure championship / 16-0 rates
// and surface the highest-contributing players and optimal XI.
//
//   node stress_test.js [runs]
//
// Mirrors: tier-weighted spin (getSpinWeights/pickTeam), canDraft + eligibleSlots
// placement, selectBalancedXI for AI, teamStrength, simulateMatch full math,
// buildGroupFixtures, and the playoff bracket.

const Papa = require("papaparse");
const fs = require("fs");

// ---------- load CSV ----------
const csv = fs.readFileSync(`${__dirname}/ipl_master_calibrated.csv`, "utf8");
const { data: rows } = Papa.parse(csv, { header: true, skipEmptyLines: true });

// ---------- constants (from simulation.js) ----------
const USER_ID = "USER";
const GROUPS = {
  A: ["CSK", "RCB", "GT", "PBKS", "DC"],
  B: ["MI", "KKR", "SRH", "RR", USER_ID],
};
const MAX_OVERSEAS = 4;
const ERA_FROM = 2008;
const ERA_TO = 2026;

let PICK_STRATEGY = "greedy"; // 'greedy' | 'random'

// ---------- helpers ----------
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const randomBetween = (min, max) => min + Math.random() * (max - min);
const shuffle = (items) =>
  items
    .map((item) => ({ item, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ item }) => item);
const average = (vals) => (!vals.length ? 70 : vals.reduce((a, b) => a + b, 0) / vals.length);
function weightedAverage(values, weights) {
  const tw = weights.slice(0, values.length).reduce((a, b) => a + b, 0);
  return values.reduce((s, v, i) => s + v * weights[i], 0) / tw;
}

// ---------- normalize players ----------
// Sim values cap at 92 (simulation.js); draft tiering uses raw OVR (draft.js).
function normalize(r) {
  const name = (r.Player_Name || "").trim();
  return {
    id: `${name}|${r.Franchise}|${r.Season}`,
    name,
    fr: r.Franchise,
    season: r.Season,
    primaryRole: r.Primary_Role,
    battingOrder: r.Batting_Order,
    isWk: r.Is_Wicketkeeper === "1",
    isOverseas: r.Nationality === "Overseas",
    ovrRaw: +r.OVR || 0,
    ovr: Math.min(+r.OVR || 70, 92),
    bat: Math.min(+r.Bat_Rat || +r.OVR || 70, 92),
    bowl: Math.min(+r.Bowl_Rat || +r.OVR || 65, 92),
  };
}

const allPlayers = rows
  .filter((r) => r.Player_Name && r.Franchise && r.Season)
  .map(normalize);

// byTeamSeason + spin pool (draft.js buildData)
const byTeamSeason = new Map();
for (const p of allPlayers) {
  const key = `${p.fr}|${p.season}`;
  if (!byTeamSeason.has(key)) byTeamSeason.set(key, []);
  byTeamSeason.get(key).push(p);
}
const teamStrengthMap = {}; // "FR|SEASON" -> mean top-5 raw OVR
for (const [key, squad] of byTeamSeason) {
  if (squad.length < 11) continue;
  const top = squad.map((p) => p.ovrRaw).sort((a, b) => b - a).slice(0, 5);
  teamStrengthMap[key] = top.reduce((a, b) => a + b, 0) / top.length;
}
const spinPool = [];
for (const [key, avgOVR] of Object.entries(teamStrengthMap)) {
  const [fr, season] = key.split("|");
  spinPool.push({ fr, season, avgOVR });
}

// ======================= DRAFT ENGINE (draft.js) =======================
const SLOT_LABELS = [
  "Opener", "Opener",
  "Opener / Middle Order", "Middle Order", "Middle Order", "Middle Order",
  "Finisher / All-Rounder",
  "Bowler / All-Rounder", "Bowler", "Bowler", "Bowler",
];

function canFillSlot7(p) {
  if (p.battingOrder === "Opener") return false;
  if (p.primaryRole === "Bowler" && p.battingOrder === "Lower Order") return false;
  return (
    p.battingOrder === "Finisher" ||
    p.battingOrder === "Middle Order" ||
    p.isWk ||
    p.primaryRole === "All-Rounder"
  );
}

function eligibleSlots(p) {
  let slots;
  if (p.primaryRole === "Bowler") {
    slots = [7, 8, 9, 10];
  } else {
    switch (p.battingOrder) {
      case "Opener": slots = [0, 1, 2]; break;
      case "Middle Order": slots = [2, 3, 4, 5]; break;
      case "Finisher": slots = [6, 5, 4]; break;
      case "Lower Order": slots = [7, 8, 9, 10, 6]; break;
      default: slots = [2, 3, 4, 5, 6, 7, 8, 9, 10];
    }
  }
  const has6 = slots.includes(6);
  if (canFillSlot7(p) && !has6) slots = [...slots, 6];
  else if (!canFillSlot7(p) && has6) slots = slots.filter((s) => s !== 6);
  return slots;
}

function getTeamTier(avgOVR) {
  if (avgOVR >= 84) return 1;
  if (avgOVR >= 80) return 2;
  if (avgOVR >= 76) return 3;
  return 4;
}
function getSpinWeights(state) {
  let w1 = 42, w2 = 33, w3 = 20, w4 = 5;
  const t1 = Math.max(0, state.tier1Hits - 1) * 5;
  w1 = Math.max(30, w1 - t1);
  const t2 = Math.max(0, state.tier2Hits - 2) * 2;
  w2 = Math.max(26, w2 - t2);
  const lost = t1 + t2;
  w3 += lost * 0.75;
  w4 += lost * 0.25;
  return { w1, w2, w3, w4 };
}
const tierWeight = (tier, w) => (tier === 1 ? w.w1 : tier === 2 ? w.w2 : tier === 3 ? w.w3 : w.w4);
function weightedPick(items, weightOf) {
  const total = items.reduce((a, it) => a + weightOf(it), 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= weightOf(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}
function pickTeam(spinState) {
  const valid = spinPool.filter((e) => +e.season >= ERA_FROM && +e.season <= ERA_TO);
  if (!valid.length) return spinPool[Math.floor(Math.random() * spinPool.length)];
  const weights = getSpinWeights(spinState);
  const tierCounts = valid.reduce((c, e) => {
    const t = getTeamTier(e.avgOVR);
    c[t] = (c[t] || 0) + 1;
    return c;
  }, {});
  const entry = weightedPick(valid, (e) => {
    const t = getTeamTier(e.avgOVR);
    return tierWeight(t, weights) / (tierCounts[t] || 1);
  });
  const tier = getTeamTier(entry.avgOVR);
  if (tier === 1) spinState.tier1Hits++;
  if (tier === 2) spinState.tier2Hits++;
  spinState.spinNumber++;
  return { fr: entry.fr, season: entry.season };
}

// One full draft, mirroring user flow: spin -> squad -> legal picks -> place.
// chooser(legal, xi) optionally overrides pick selection (default: PICK_STRATEGY).
function simulateDraft(chooser) {
  const xi = new Array(11).fill(null);
  const spinState = { tier1Hits: 0, tier2Hits: 0, spinNumber: 0 };
  const inXi = (name) => xi.some((p) => p && p.name === name);
  const overseasCount = () => xi.filter((p) => p && p.isOverseas).length;
  const canDraft = (p) => {
    if (inXi(p.name)) return false;
    if (p.isOverseas && overseasCount() >= MAX_OVERSEAS) return false;
    return eligibleSlots(p).some((i) => xi[i] === null);
  };

  let guard = 0;
  while (xi.some((s) => s === null) && guard < 5000) {
    guard++;
    const picked = xi.filter(Boolean).length;
    const wkFilled = xi.slice(0, 7).some((p) => p && p.isWk);

    let entry;
    // Anti-softlock: after pick 9 with no WK, force a squad that has a WK.
    if (picked >= 9 && !wkFilled) {
      let wkPool = spinPool.filter((e) => {
        if (+e.season < ERA_FROM || +e.season > ERA_TO) return false;
        return (byTeamSeason.get(`${e.fr}|${e.season}`) || []).some((p) => p.isWk);
      });
      if (!wkPool.length) wkPool = spinPool;
      entry = wkPool[Math.floor(Math.random() * wkPool.length)];
    } else {
      entry = pickTeam(spinState);
    }

    const squad = byTeamSeason.get(`${entry.fr}|${entry.season}`) || [];
    const legal = squad.filter(canDraft);
    if (!legal.length) continue; // retry spin

    let choice;
    if (chooser) {
      choice = chooser(legal, xi, picked);
      if (!choice) continue; // chooser rejected this squad — respin
    } else {
      choice =
        PICK_STRATEGY === "greedy"
          ? [...legal].sort((a, b) => b.ovr - a.ovr)[0]
          : legal[Math.floor(Math.random() * legal.length)];
    }

    const slot = eligibleSlots(choice).find((i) => xi[i] === null);
    if (slot === undefined) continue;
    xi[slot] = choice;
  }
  return xi;
}

// ======================= SIMULATION ENGINE (simulation.js) =======================
function chemistryScore(players) {
  const pen = players.reduce((sum, p, i) => {
    if (p.primaryRole === "Bowler" && i < 7) return sum + 7;
    if (p.battingOrder === "Opener" && i > 2) return sum + 3;
    if (p.battingOrder === "Lower Order" && i < 6) return sum + 3;
    return sum;
  }, 0);
  return Math.max(55, 92 - pen);
}
function teamStrength(players, isUser = false) {
  const topSix = players.slice(0, 6);
  const bowlers = [...players].sort((a, b) => b.bowl - a.bowl).slice(0, 5);
  const batting = weightedAverage(topSix.map((p) => p.bat || p.ovr), [1.25, 1.18, 1.1, 1, 0.92, 0.85]);
  const bowling = weightedAverage(bowlers.map((p) => p.bowl || p.ovr), [1.22, 1.12, 1.04, 0.96, 0.88]);
  const depth = average(players.slice(6).map((p) => p.ovr));
  const chemistry = chemistryScore(players);
  let total = batting * 0.46 + bowling * 0.42 + depth * 0.08 + chemistry * 0.04;
  if (isUser) total *= 0.975;
  return { batting, bowling, depth, chemistry, total };
}
function selectBalancedXI(squad) {
  const pool = [...squad].sort((a, b) => b.ovr - a.ovr);
  const used = new Set();
  const take = (n, pred) => {
    const picked = [];
    for (const p of pool) {
      if (picked.length >= n) break;
      if (used.has(p) || !pred(p)) continue;
      used.add(p);
      picked.push(p);
    }
    return picked;
  };
  const openers = take(2, (p) => p.battingOrder === "Opener");
  const middle = take(4, (p) => p.battingOrder === "Middle Order");
  const finisher = take(1, (p) => p.battingOrder === "Finisher" || p.isWk);
  const bowlers = take(4, (p) => p.primaryRole === "Bowler");
  const result = [...openers, ...middle, ...finisher, ...bowlers];
  result.push(...take(11 - result.length, () => true));
  return result.slice(0, 11);
}
function makeTeam(id, squad) {
  const players =
    id === USER_ID
      ? [...squad].slice(0, 11)
      : selectBalancedXI(squad);
  const strength = teamStrength(players, id === USER_ID);
  return { id, name: id, short: id, players, strength };
}
function buildOpponentTeams() {
  const needed = new Set([...GROUPS.A, ...GROUPS.B].filter((id) => id !== USER_ID));
  const grouped = {};
  allPlayers
    .filter((p) => p.season === "2026" && needed.has(p.fr))
    .forEach((p) => (grouped[p.fr] = grouped[p.fr] || []).push(p));
  return Object.entries(grouped).map(([fr, squad]) => makeTeam(fr, squad));
}

function penalizedBat(player, slotIndex) {
  let rat = player.bat || player.ovr;
  if (player.primaryRole === "Bowler" && slotIndex < 7) rat *= 0.72;
  if (player.battingOrder === "Lower Order" && slotIndex < 5) rat *= 0.8;
  return rat;
}
function penalizedBowl(player) {
  let rat = player.bowl || player.ovr;
  if (player.battingOrder === "Opener" && player.primaryRole !== "All-Rounder") rat *= 0.75;
  if (player.battingOrder === "Middle Order" && player.primaryRole !== "All-Rounder") rat *= 0.85;
  return rat;
}
function splitByWeights(total, weights) {
  const positive = weights.map((w) => Math.max(0.01, w));
  const sum = positive.reduce((a, b) => a + b, 0);
  const raw = positive.map((w) => Math.floor((w / sum) * total));
  const remainder = total - raw.reduce((a, b) => a + b, 0);
  const fracs = positive
    .map((w, i) => ({ i, f: (w / sum) * total - raw[i] }))
    .sort((a, b) => b.f - a.f);
  for (let k = 0; k < remainder; k++) raw[fracs[k].i]++;
  return raw;
}

const PITCH_MODS = {
  batting: { runs: +25, wickets: -1.5, srBonus: +18 },
  neutral: { runs: +8, wickets: 0, srBonus: +5 },
  bowling: { runs: -12, wickets: +1.2, srBonus: -8 },
};
function getPitchType() {
  const r = Math.random();
  if (r < 0.4) return "batting";
  if (r < 0.9) return "neutral";
  return "bowling";
}

function distributeBatting(team, opponent, runs, wickets, isKnockout = false) {
  const battersUsed = wickets >= 10 ? 11 : clamp(wickets + 2, 3, 11);
  const activePlayers = team.players.slice(0, battersUsed);
  const oppBowlAvg =
    [...opponent.players].sort((a, b) => b.bowl - a.bowl).slice(0, 4)
      .reduce((s, p) => s + (p.bowl || p.ovr), 0) / 4;

  const weights = activePlayers.map((p, i) => {
    const rat = penalizedBat(p, i);
    const matchup = Math.max(5, rat - oppBowlAvg * 0.35);
    const posBonus = Math.pow(0.75, i);
    const noise = isKnockout ? randomBetween(0.3, 2.5) : randomBetween(0.4, 2.0);
    const flop = Math.random() < 0.25 ? randomBetween(0.05, 0.18) : 1;
    return Math.max(0.5, matchup * posBonus * noise * flop);
  });

  const rawRuns = splitByWeights(runs, weights);

  const top3Max = Math.max(...rawRuns.slice(0, Math.min(3, rawRuns.length)));
  if (runs >= 160 && top3Max < 35) {
    const bestIdx = weights.slice(0, 3).indexOf(Math.max(...weights.slice(0, 3)));
    const boost = 40 - rawRuns[bestIdx];
    rawRuns[bestIdx] += boost;
    const deductFrom = [3, 4, 5].filter((j) => j < rawRuns.length && rawRuns[j] > 5);
    deductFrom.forEach((j) => (rawRuns[j] = Math.max(3, rawRuns[j] - Math.floor(boost / deductFrom.length))));
  }

  const INNINGS_CAP = 90;
  rawRuns.forEach((r, i) => {
    if (r > INNINGS_CAP) {
      const excess = r - INNINGS_CAP;
      rawRuns[i] = INNINGS_CAP;
      const others = rawRuns.map((_, j) => j).filter((j) => j !== i);
      const ot = others.reduce((a, j) => a + rawRuns[j], 0);
      others.forEach((j) => { if (ot > 0) rawRuns[j] += Math.round((excess * rawRuns[j]) / ot); });
    }
  });

  const heroMin = isKnockout ? 45 : 35;
  if (runs >= 150 && Math.max(...rawRuns) < heroMin) {
    const topIdx = weights.indexOf(Math.max(...weights));
    const boost = heroMin - rawRuns[topIdx];
    rawRuns[topIdx] += boost;
    const ot = rawRuns.reduce((a, b, i) => (i === topIdx ? a : a + b), 0);
    rawRuns.forEach((_, i) => {
      if (i !== topIdx && ot > 0) rawRuns[i] = Math.max(0, rawRuns[i] - Math.round((boost * rawRuns[i]) / ot));
    });
  }

  const runDiff = runs - rawRuns.reduce((a, b) => a + b, 0);
  if (runDiff !== 0) {
    const topIdx = rawRuns.indexOf(Math.max(...rawRuns));
    rawRuns[topIdx] = Math.max(0, rawRuns[topIdx] + runDiff);
  }

  return team.players.map((p, i) =>
    i >= battersUsed
      ? { player: p, runs: 0, didBat: false }
      : { player: p, runs: rawRuns[i], didBat: true }
  );
}

function distributeBowling(team, runs, wickets) {
  const bowlers = [...team.players].sort((a, b) => b.bowl - a.bowl).slice(0, 5);
  const runWeights = bowlers.map((p) => {
    const base = 110 - penalizedBowl(p);
    const smashed = Math.random() < 0.2 ? randomBetween(1.6, 2.6) : 1;
    return Math.max(1, base * smashed + randomBetween(-10, 10));
  });
  const wicketWeights = bowlers.map((p) => {
    const cold = Math.random() < 0.33 ? randomBetween(0.08, 0.35) : 1;
    return Math.max(0.5, penalizedBowl(p) * cold + randomBetween(-8, 8));
  });
  const runSplit = splitByWeights(runs, runWeights);
  const wicketSplit = splitByWeights(wickets, wicketWeights);
  return bowlers.map((p, i) => ({ player: p, runs: runSplit[i], wickets: wicketSplit[i] }));
}

function buildInnings(battingTeam, bowlingTeam, options = {}) {
  let batAdv = battingTeam.strength.batting - bowlingTeam.strength.bowling;
  let totalAdv = battingTeam.strength.total - bowlingTeam.strength.total;
  // Knockout step-up: trim the user's edge so the cup is genuinely earned.
  if (options.knockout) {
    if (battingTeam.id === USER_ID) { batAdv -= 1.5; totalAdv -= 1.5; }
    else if (bowlingTeam.id === USER_ID) { batAdv += 1.5; totalAdv += 1.5; }
  }
  const pressure = options.knockout ? randomBetween(-16, 16) : randomBetween(-18, 18);
  const pitch = options.pitch || { runs: 0, wickets: 0, srBonus: 0 };
  let projected = 172 + batAdv * 2.4 + totalAdv * 1.6 + pressure + pitch.runs;
  if (options.target) projected = Math.min(projected, options.target + randomBetween(-16, 10));
  const runs = clamp(Math.round(projected), 148, 230);
  const wickets = clamp(Math.round(randomBetween(3, 8) - batAdv / 18 + pitch.wickets), 2, 10);
  const balls = wickets >= 10 ? Math.round(randomBetween(103, 120)) : 120;
  const batting = distributeBatting(battingTeam, bowlingTeam, runs, wickets, options.knockout);
  const bowling = distributeBowling(bowlingTeam, runs, wickets);
  return { runs, wickets, balls, batting, bowling };
}

function simulateMatch(home, away, options = {}) {
  const pitch = PITCH_MODS[getPitchType()];
  const homeInnings = buildInnings(home, away, { ...options, pitch });
  const chaseTarget = homeInnings.runs + 1;
  const awayInnings = buildInnings(away, home, { ...options, pitch, target: chaseTarget });
  if (awayInnings.runs > homeInnings.runs) awayInnings.runs = chaseTarget;
  else if (awayInnings.runs === homeInnings.runs) awayInnings.runs += 1;
  const winner = homeInnings.runs > awayInnings.runs ? home : away;
  const loser = winner.id === home.id ? away : home;
  return {
    home, away, winner, loser,
    innings: { [home.id]: homeInnings, [away.id]: awayInnings },
    scoreFor: (id) => (id === home.id ? homeInnings : awayInnings),
  };
}

// ---------- fixtures (simulation.js buildGroupFixtures) ----------
function buildGroupFixtures(teams) {
  const byId = {};
  teams.forEach((t) => (byId[t.id] = t));
  const groupA = GROUPS.A.map((id) => byId[id]);
  const groupB = GROUPS.B.map((id) => byId[id]);
  const matches = [];
  const add = (h, a) => matches.push([h, a]);
  [groupA, groupB].forEach((group) => {
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        add(group[i], group[j]);
        add(group[j], group[i]);
      }
  });
  for (let i = 0; i < groupA.length; i++)
    for (let j = 0; j < groupB.length; j++) {
      add(groupA[i], groupB[j]);
      if (i === j) add(groupB[j], groupA[i]);
    }
  return matches;
}

// ======================= SEASON =======================
function applyCatchupBuff(teams) {
  const sorted = [...teams].sort((a, b) => b.strength.total - a.strength.total);
  const top = sorted[0].strength.total;
  sorted.forEach((team, rank) => {
    if (team.id === USER_ID) return;
    const gap = top - team.strength.total;
    const buffFactor = rank >= 6 ? 0.45 : rank >= 4 ? 0.25 : 0;
    if (buffFactor === 0) return;
    const buff = gap * buffFactor;
    team.strength.batting += buff * 0.5;
    team.strength.bowling += buff * 0.5;
    team.strength.total += buff;
  });
}

function runSeason(userXi) {
  const userTeam = makeTeam(USER_ID, userXi);
  const teams = [userTeam, ...buildOpponentTeams()];
  applyCatchupBuff(teams);
  const standings = {};
  teams.forEach((t) => (standings[t.id] = {
    team: t, p: 0, w: 0, l: 0, pts: 0,
    runsFor: 0, ballsFor: 0, runsAgainst: 0, ballsAgainst: 0,
  }));

  const fixtures = buildGroupFixtures(teams);
  let userWins = 0, userLosses = 0;
  fixtures.forEach(([home, away]) => {
    const m = simulateMatch(home, away);
    [home, away].forEach((team) => {
      const row = standings[team.id];
      const own = m.scoreFor(team.id);
      const other = m.scoreFor(team.id === home.id ? away.id : home.id);
      row.p += 1;
      const won = m.winner.id === team.id;
      row.w += won ? 1 : 0;
      row.l += won ? 0 : 1;
      row.pts += won ? 2 : 0;
      row.runsFor += own.runs; row.ballsFor += own.balls;
      row.runsAgainst += other.runs; row.ballsAgainst += other.balls;
    });
    if (home.id === USER_ID || away.id === USER_ID) {
      if (m.winner.id === USER_ID) userWins++; else userLosses++;
    }
  });

  const nrr = (r) =>
    r.runsFor / Math.max(r.ballsFor / 6, 1) - r.runsAgainst / Math.max(r.ballsAgainst / 6, 1);
  const ranked = Object.values(standings)
    .sort((a, b) => b.pts - a.pts || nrr(b) - nrr(a) || b.w - a.w);
  const rank = ranked.findIndex((r) => r.team.id === USER_ID) + 1;

  let stage = "league";
  let champion = false;
  if (rank <= 4) {
    const top4 = ranked.slice(0, 4).map((r) => r.team);
    const ko = (h, a) => simulateMatch(h, a, { knockout: true });
    const tally = (m) => {
      if (m.home.id === USER_ID || m.away.id === USER_ID) {
        if (m.winner.id === USER_ID) userWins++; else userLosses++;
      }
    };
    // Q1: 1 v 2
    const q1 = ko(top4[0], top4[1]); tally(q1);
    // Eliminator: 3 v 4
    const elim = ko(top4[2], top4[3]); tally(elim);
    let finalistA = q1.winner;
    // Q2: Q1 loser v Eliminator winner
    const q2 = ko(q1.loser, elim.winner); tally(q2);
    const finalistB = q2.winner;
    stage = "playoffs";
    // user out before final?
    if (finalistA.id === USER_ID || finalistB.id === USER_ID) {
      const final = ko(finalistA, finalistB); tally(final);
      stage = "final";
      if (final.winner.id === USER_ID) { champion = true; stage = "champion"; }
    }
  }

  return { wins: userWins, losses: userLosses, rank, stage, champion };
}

// ======================= RUN N =======================
function runN(n) {
  const results = [];
  for (let i = 0; i < n; i++) {
    const xi = simulateDraft();
    results.push({ xi, result: runSeason(xi) });
  }
  return results;
}

function analyze(label, results) {
  const n = results.length;
  const champRate = results.filter((r) => r.result.champion).length / n;
  const perfect = results.filter((r) => r.result.wins === 16 && r.result.losses === 0);
  const top4Rate = results.filter((r) => r.result.rank <= 4).length / n;
  const avgWins = results.reduce((a, r) => a + r.result.wins, 0) / n;
  console.log(`\n=== ${label} (${n} runs) ===`);
  console.log(`Championship rate: ${(champRate * 100).toFixed(1)}%`);
  console.log(`16-0 rate:         ${((perfect.length / n) * 100).toFixed(2)}%  (${perfect.length} teams)`);
  console.log(`Top-4 rate:        ${(top4Rate * 100).toFixed(1)}%`);
  console.log(`Avg total wins:    ${avgWins.toFixed(2)}`);

  // win distribution (league + playoffs combined)
  const dist = {};
  results.forEach((r) => (dist[r.result.wins] = (dist[r.result.wins] || 0) + 1));
  console.log("Win distribution:");
  Object.entries(dist).sort((a, b) => +a[0] - +b[0]).forEach(([w, c]) =>
    console.log(`  ${String(w).padStart(2)} wins: ${"█".repeat(Math.round((c / n) * 40))} ${(c / n * 100).toFixed(1)}%`)
  );

  // best players by avg total wins per appearance
  const pw = {};
  results.forEach(({ xi, result }) =>
    xi.forEach((p) => {
      if (!p) return;
      pw[p.id] = pw[p.id] || { wins: 0, apps: 0, name: p.name, fr: p.fr, season: p.season, ovr: p.ovr };
      pw[p.id].apps++;
      pw[p.id].wins += result.wins;
    })
  );
  const best = Object.values(pw)
    .filter((p) => p.apps >= 8)
    .map((p) => ({ ...p, avg: p.wins / p.apps }))
    .sort((a, b) => b.avg - a.avg);
  console.log("\nTop 15 players by avg wins/appearance (min 8 drafts):");
  best.slice(0, 15).forEach((p, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. ${p.name} (${p.fr} ${p.season}, OVR ${p.ovr}) — ${p.avg.toFixed(2)} avg wins, ${p.apps} drafts`)
  );

  if (perfect.length) {
    console.log(`\nSample 16-0 XI:`);
    perfect[0].xi.forEach((p, i) =>
      console.log(`  ${i + 1}. ${p.name} ${p.fr} ${p.season} OVR:${p.ovr}`)
    );
  }
  return { label, champRate, perfectRate: perfect.length / n, top4Rate, avgWins, best: best.slice(0, 50), dist };
}

// expose engine for extra analyses
function setStrategy(s) { PICK_STRATEGY = s; }
const SLOTS = SLOT_LABELS;
module.exports = {
  allPlayers, spinPool, byTeamSeason, SLOTS,
  simulateDraft, runSeason, runN, analyze, setStrategy,
  eligibleSlots, pickTeam, GROUPS, ERA_FROM, ERA_TO, MAX_OVERSEAS,
};

// ======================= MAIN =======================
if (require.main === module) {
  const RUNS = parseInt(process.argv[2], 10) || 2500;
  console.log(`Stress test — ${RUNS} drafts per strategy. Loaded ${allPlayers.length} player-seasons, ${spinPool.length} draftable squads.`);

  PICK_STRATEGY = "greedy";
  const greedy = analyze("GREEDY DRAFT", runN(RUNS));

  PICK_STRATEGY = "random";
  const random = analyze("RANDOM DRAFT", runN(RUNS));

  fs.writeFileSync(
    `${__dirname}/stress_test_results.json`,
    JSON.stringify({ runs: RUNS, greedy, random }, null, 2)
  );
  console.log("\nResults saved to stress_test_results.json");
}
