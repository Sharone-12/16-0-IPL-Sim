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
let ERA_FROM = 2008;
let ERA_TO = 2026;
let DIFFICULTY = "normal";
let IS_PRIME = false;

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
  if (avgOVR >= 81) return 2;
  return 3;
}
function getSpinWeights(state) {
  let w1 = 42, w2 = 33, w3 = 25;
  const t1 = Math.max(0, state.tier1Hits - 1) * 5;
  w1 = Math.max(30, w1 - t1);
  const t2 = Math.max(0, state.tier2Hits - 2) * 2;
  w2 = Math.max(26, w2 - t2);
  const lost = t1 + t2;
  w3 += lost;
  return { w1, w2, w3 };
}
const tierWeight = (tier, w) => (tier === 1 ? w.w1 : tier === 2 ? w.w2 : w.w3);
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
function simulateDraft(chooser, options = {}) {
  const forceOverseas = options.forceOverseas; // undefined | 0 | 4
  const xi = new Array(11).fill(null);
  const spinState = { tier1Hits: 0, tier2Hits: 0, spinNumber: 0 };
  const inXi = (name) => xi.some((p) => p && p.name === name);
  const overseasCount = () => xi.filter((p) => p && p.isOverseas).length;
  const canDraft = (p) => {
    if (inXi(p.name)) return false;

    const count = overseasCount();
    const picked = xi.filter(Boolean).length;
    const remaining = 11 - picked;

    if (forceOverseas === 0) {
      if (p.isOverseas) return false;
    } else if (forceOverseas === 4) {
      const needed = 4 - count;
      if (p.isOverseas && count >= 4) return false;
      if (!p.isOverseas && remaining <= needed) return false;
    } else {
      if (p.isOverseas && count >= MAX_OVERSEAS) return false;
    }

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
  if (isUser) {
    const base = IS_PRIME ? 1.0 : 0.95; // mirrors simulation.js handicap
    const dFactor = DIFFICULTY === "hard" ? 0.95 : DIFFICULTY === "easy" ? 1.02 : 1.0;
    total *= base * dFactor;
  }
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
    const posBonus = Math.pow(0.85, i);
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

  const INNINGS_CAP = 72;
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
    const topCand = weights
      .map((w, i) => ({ w, i }))
      .sort((a, b) => b.w - a.w)
      .slice(0, 4);
    const topIdx = topCand[Math.floor(Math.random() * topCand.length)].i;
    const boost = heroMin - rawRuns[topIdx];
    rawRuns[topIdx] += boost;
    const othersTotal = rawRuns.reduce((a, b, i) => (i === topIdx ? a : a + b), 0);
    rawRuns.forEach((_, i) => {
      if (i !== topIdx && othersTotal > 0) {
        rawRuns[i] = Math.max(0, rawRuns[i] - Math.round((boost * rawRuns[i]) / othersTotal));
      }
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

  const leaders = {};
  teams.forEach((team) => {
    team.players.forEach((p) => {
      leaders[p.id] = {
        name: p.name,
        year: p.season,
        team: team.id,
        runs: 0,
        wickets: 0,
      };
    });
  });

  const updateStats = (m) => {
    [m.home.id, m.away.id].forEach((tid) => {
      const inn = m.scoreFor(tid);
      inn.batting.forEach((b) => {
        if (leaders[b.player.id]) {
          leaders[b.player.id].runs += b.runs;
        }
      });
      const oppId = tid === m.home.id ? m.away.id : m.home.id;
      const oppInn = m.scoreFor(oppId);
      oppInn.bowling.forEach((bwl) => {
        if (leaders[bwl.player.id]) {
          leaders[bwl.player.id].wickets += bwl.wickets;
        }
      });
    });
  };

  const fixtures = buildGroupFixtures(teams);
  let userWins = 0, userLosses = 0;
  fixtures.forEach(([home, away]) => {
    const m = simulateMatch(home, away);
    updateStats(m);
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
    const q1 = ko(top4[0], top4[1]); tally(q1); updateStats(q1);
    // Eliminator: 3 v 4
    const elim = ko(top4[2], top4[3]); tally(elim); updateStats(elim);
    let finalistA = q1.winner;
    // Q2: Q1 loser v Eliminator winner
    const q2 = ko(q1.loser, elim.winner); tally(q2); updateStats(q2);
    const finalistB = q2.winner;
    stage = "playoffs";
    // user out before final?
    if (finalistA.id === USER_ID || finalistB.id === USER_ID) {
      const final = ko(finalistA, finalistB); tally(final); updateStats(final);
      stage = "final";
      if (final.winner.id === USER_ID) { champion = true; stage = "champion"; }
    }
  }

  const leadersList = Object.values(leaders);
  const orangeCapRaw = [...leadersList].sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name))[0];
  const purpleCapRaw = [...leadersList].sort((a, b) => b.wickets - a.wickets || a.name.localeCompare(b.name))[0];

  const orangeCap = orangeCapRaw ? { name: orangeCapRaw.name, year: orangeCapRaw.year, runs: orangeCapRaw.runs } : null;
  const purpleCap = purpleCapRaw ? { name: purpleCapRaw.name, year: purpleCapRaw.year, wickets: purpleCapRaw.wickets } : null;

  return { wins: userWins, losses: userLosses, rank, stage, champion, orangeCap, purpleCap };
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
  console.log("\nTop 20 players by avg wins/appearance (min 8 drafts):");
  best.slice(0, 20).forEach((p, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. ${p.name} (${p.fr} ${p.season}, OVR ${p.ovr}) — ${p.avg.toFixed(2)} avg wins, ${p.apps} drafts`)
  );

  if (perfect.length) {
    console.log(`\nAll ${perfect.length} perfect 16-0 team(s) found:`);
    perfect.forEach((t, ti) => {
      console.log(`\n  --- 16-0 team #${ti + 1} (OVR ${t.result.teamOvr ?? "?"}) ---`);
      t.xi.forEach((p, i) =>
        console.log(`    ${i + 1}. ${p.name} ${p.fr} ${p.season} OVR:${p.ovr}`)
      );
    });
  } else {
    console.log(`\nNo perfect 16-0 teams found in ${n} drafts.`);
  }
  return { label, champRate, perfectRate: perfect.length / n, top4Rate, avgWins, best: best.slice(0, 50), dist };
}

// expose engine for extra analyses
function setStrategy(s) { PICK_STRATEGY = s; }
function setDifficulty(d) { DIFFICULTY = d; }
function setIsPrime(p) { IS_PRIME = p; }
function applyPrimeRatings() {
  IS_PRIME = true;
  const primeObjByName = {};
  for (const p of allPlayers) {
    const prev = primeObjByName[p.name];
    if (!prev || p.ovrRaw > prev.ovrRaw) {
      primeObjByName[p.name] = p;
    }
  }
  for (const p of allPlayers) {
    const prime = primeObjByName[p.name];
    if (prime) {
      p.ovr = prime.ovr;
      p.bat = prime.bat;
      p.bowl = prime.bowl;
      p.ovrRaw = prime.ovrRaw;
    }
  }
}
const SLOTS = SLOT_LABELS;
module.exports = {
  allPlayers, spinPool, byTeamSeason, SLOTS,
  simulateDraft, runSeason, runN, analyze, setStrategy,
  eligibleSlots, pickTeam, GROUPS, ERA_FROM, ERA_TO, MAX_OVERSEAS,
  evaluatePlayerForStrategy, evaluateOptimalPlayer, runDraftWithStrategy,
  simulateDraftNoChemistry, runComprehensiveStressTest,
  setDifficulty, setIsPrime, applyPrimeRatings
};

/**
 * Evaluates a player option based on the chosen drafting strategy.
 * @param {Object} player - The player object (contains ratings like bat, bowl, ovr).
 * @param {string} strategy - 'batting_heavy' | 'bowling_heavy'
 * @returns {number} The calculated score/value of this player for the draft.
 */
function evaluatePlayerForStrategy(player, strategy) {
  let baseValue = player.ovr || 50;
  if (strategy === 'batting_heavy') {
    const batRating = player.bat || 0;
    const bowlRating = player.bowl || 0;
    if (batRating > bowlRating) {
      return baseValue + (batRating * 0.3);
    }
    return baseValue - 10;
  }
  if (strategy === 'bowling_heavy') {
    const batRating = player.bat || 0;
    const bowlRating = player.bowl || 0;
    if (bowlRating > batRating) {
      return baseValue + (bowlRating * 0.3);
    }
    return baseValue - 10;
  }
  return baseValue;
}

/**
 * Evaluates a player based on projected team rating, enforcing roster rules.
 */
function evaluateOptimalPlayer(player, currentRoster, pickNumber) {
  // 1. Enforce Overseas Limit (Max 4)
  const overseasCount = currentRoster.filter(p => p && p.isOverseas).length;
  if (player.isOverseas && overseasCount >= 4) {
    return -9999; // Block pick
  }
  // 2. Enforce Wicketkeeper Rule
  // If we are late in the draft (e.g., pick 8+) and don't have a WK in slots 1-7,
  // we must aggressively prioritize Wicketkeepers.
  const hasWK = currentRoster.some((p, idx) => idx <= 6 && p && p.isWk);
  if (!hasWK && pickNumber >= 8) {
    if (player.isWk) {
      return player.ovr + 50; // Massively prioritize
    } else {
      return player.ovr - 50; // Deprioritize non-WKs
    }
  }
  // 3. Find the best slot for this player to avoid Chemistry Penalties
  let bestSlotScore = -9999;
  
  // Constrain by eligible slots
  const allowedSlots = eligibleSlots(player);
  for (let slot = 0; slot < 11; slot++) {
    if (!allowedSlots.includes(slot)) continue;
    if (currentRoster[slot] !== null) continue; // Already filled
    let score = player.ovr;
    let penalty = 0;
    // Apply chemistry penalties based on slot
    const isBowler = player.primaryRole === 'Bowler' || player.battingOrder === 'Lower Order';
    const isOpener = player.battingOrder === 'Opener';
    
    if (slot <= 6 && isBowler) penalty += 7; // Specialist bowler in slots 1-7
    if (slot >= 3 && isOpener) penalty += 3; // Opener in slots 4-11
    if (slot <= 5 && player.battingOrder === 'Lower Order') penalty += 3; // Lower order in slots 1-6
    score -= penalty;
    // Weight the score by the importance of the slot
    // Batting weights for top 6: [1.25, 1.18, 1.1, 1.0, 0.92, 0.85]
    if (slot === 0) score += (player.bat * 0.25);
    if (slot === 1) score += (player.bat * 0.18);
    if (slot === 2) score += (player.bat * 0.10);
    
    // Bowling weights for bowlers (slots 7-10)
    if (slot >= 7) {
      score += (player.bowl * 0.20);
    }
    if (score > bestSlotScore) {
      bestSlotScore = score;
    }
  }
  return bestSlotScore;
}

/**
 * Runs a draft simulation utilizing a specific drafting strategy.
 */
function runDraftWithStrategy(strategy) {
  if (strategy === 'batting_heavy' || strategy === 'bowling_heavy') {
    return simulateDraft((legal) => {
      const sorted = [...legal].sort((a, b) => {
        return evaluatePlayerForStrategy(b, strategy) - evaluatePlayerForStrategy(a, strategy);
      });
      return sorted[0];
    });
  } else if (strategy === 'optimal') {
    return simulateDraft((legal, xi, picked) => {
      const sorted = [...legal].sort((a, b) => {
        return evaluateOptimalPlayer(b, xi, picked) - evaluateOptimalPlayer(a, xi, picked);
      });
      return sorted[0];
    });
  } else {
    return simulateDraft();
  }
}

/**
 * Runs a draft ignoring chemistry rules: placing players in the first empty slot.
 */
function simulateDraftNoChemistry() {
  const xi = new Array(11).fill(null);
  const spinState = { tier1Hits: 0, tier2Hits: 0, spinNumber: 0 };
  const inXi = (name) => xi.some((p) => p && p.name === name);
  const overseasCount = () => xi.filter((p) => p && p.isOverseas).length;
  
  const canDraftNoChem = (p) => {
    if (inXi(p.name)) return false;
    if (p.isOverseas && overseasCount() >= MAX_OVERSEAS) return false;
    return xi.some((s) => s === null); // any empty slot is fine
  };

  let guard = 0;
  while (xi.some((s) => s === null) && guard < 5000) {
    guard++;

    let entry = pickTeam(spinState);
    const squad = byTeamSeason.get(`${entry.fr}|${entry.season}`) || [];
    const legal = squad.filter(canDraftNoChem);
    if (!legal.length) continue;

    // Pick the player with the highest OVR (greedy)
    const choice = [...legal].sort((a, b) => b.ovr - a.ovr)[0];
    
    // Place in the first available empty slot
    const slot = xi.indexOf(null);
    if (slot === -1) continue;
    xi[slot] = choice;
  }
  return xi;
}

/**
 * Runs the comprehensive calibration experiments with 12,000 total drafts and tracks cap awards.
 */
async function runComprehensiveStressTest() {
  // Track who wins the caps and their scores
  const orangeCapTallies = {};
  const purpleCapTallies = {};
  const capWinnerStats = {
    orangeCapRuns: [],
    purpleCapWickets: []
  };

  const recordSeasonResult = (seasonResult) => {
    const oCap = seasonResult.orangeCap;
    if (oCap) {
      const key = `${oCap.name} (${oCap.year})`;
      if (!orangeCapTallies[key]) {
        orangeCapTallies[key] = { count: 0, totalRuns: 0 };
      }
      orangeCapTallies[key].count++;
      orangeCapTallies[key].totalRuns += oCap.runs;
      capWinnerStats.orangeCapRuns.push(oCap.runs);
    }
    const pCap = seasonResult.purpleCap;
    if (pCap) {
      const key = `${pCap.name} (${pCap.year})`;
      if (!purpleCapTallies[key]) {
        purpleCapTallies[key] = { count: 0, totalWickets: 0 };
      }
      purpleCapTallies[key].count++;
      purpleCapTallies[key].totalWickets += pCap.wickets;
      capWinnerStats.purpleCapWickets.push(pCap.wickets);
    }
  };

  const experimentResults = {};

  // ==========================================
  // EXPERIMENT 1: Chemistry Penalty Impact
  // ==========================================
  console.log("\n>>> RUNNING EXPERIMENT 1: Chemistry Penalty Impact (3,000 drafts)...");
  
  console.log("Simulating 1,500 drafts with Perfect Chemistry (Optimal Bot)...");
  const chemPerfWins = [];
  let chemPerfChamps = 0;
  for (let i = 0; i < 1500; i++) {
    const team = runDraftWithStrategy('optimal');
    const res = runSeason(team);
    chemPerfWins.push(res.wins);
    if (res.champion) chemPerfChamps++;
    recordSeasonResult(res);
  }

  console.log("Simulating 1,500 drafts ignoring chemistry rules (Bowlers in top order, Openers at 11)...");
  const chemNoWins = [];
  let chemNoChamps = 0;
  for (let i = 0; i < 1500; i++) {
    const team = simulateDraftNoChemistry();
    const res = runSeason(team);
    chemNoWins.push(res.wins);
    if (res.champion) chemNoChamps++;
    recordSeasonResult(res);
  }

  experimentResults.chemistry = {
    perfect: {
      avgWins: chemPerfWins.reduce((a, b) => a + b, 0) / 1500,
      champsPct: (chemPerfChamps / 1500 * 100).toFixed(2),
      perfectCount: chemPerfWins.filter(w => w === 16).length
    },
    ignored: {
      avgWins: chemNoWins.reduce((a, b) => a + b, 0) / 1500,
      champsPct: (chemNoChamps / 1500 * 100).toFixed(2),
      perfectCount: chemNoWins.filter(w => w === 16).length
    }
  };

  // ==========================================
  // EXPERIMENT 2: Difficulty Level Calibration
  // ==========================================
  console.log("\n>>> RUNNING EXPERIMENT 2: Difficulty Level Calibration (3,000 drafts)...");
  
  const diffs = ['easy', 'normal', 'hard'];
  experimentResults.difficulty = {};
  
  for (const diff of diffs) {
    console.log(`Simulating 1,000 drafts on ${diff.toUpperCase()} mode...`);
    DIFFICULTY = diff;
    const diffWins = [];
    let diffChamps = 0;
    for (let i = 0; i < 1000; i++) {
      const team = runDraftWithStrategy('optimal');
      const res = runSeason(team);
      diffWins.push(res.wins);
      if (res.champion) diffChamps++;
      recordSeasonResult(res);
    }
    experimentResults.difficulty[diff] = {
      avgWins: diffWins.reduce((a, b) => a + b, 0) / 1000,
      champsPct: (diffChamps / 1000 * 100).toFixed(2),
      perfectCount: diffWins.filter(w => w === 16).length
    };
  }
  DIFFICULTY = "normal"; // Reset

  // ==========================================
  // EXPERIMENT 3: The "No-Overseas" Challenge
  // ==========================================
  console.log("\n>>> RUNNING EXPERIMENT 3: The 'No-Overseas' Challenge (3,000 drafts)...");
  
  console.log("Simulating 1,500 drafts with exactly 4 overseas players...");
  const overseas4Wins = [];
  let overseas4Champs = 0;
  for (let i = 0; i < 1500; i++) {
    const team = simulateDraft((legal, xi, picked) => {
      const sorted = [...legal].sort((a, b) => {
        return evaluateOptimalPlayer(b, xi, picked) - evaluateOptimalPlayer(a, xi, picked);
      });
      return sorted[0];
    }, { forceOverseas: 4 });
    const res = runSeason(team);
    overseas4Wins.push(res.wins);
    if (res.champion) overseas4Champs++;
    recordSeasonResult(res);
  }

  console.log("Simulating 1,500 drafts with 0 overseas players (Indian Players Only)...");
  const overseas0Wins = [];
  let overseas0Champs = 0;
  for (let i = 0; i < 1500; i++) {
    const team = simulateDraft((legal, xi, picked) => {
      const sorted = [...legal].sort((a, b) => {
        return evaluateOptimalPlayer(b, xi, picked) - evaluateOptimalPlayer(a, xi, picked);
      });
      return sorted[0];
    }, { forceOverseas: 0 });
    const res = runSeason(team);
    overseas0Wins.push(res.wins);
    if (res.champion) overseas0Champs++;
    recordSeasonResult(res);
  }

  experimentResults.overseas = {
    four: {
      avgWins: overseas4Wins.reduce((a, b) => a + b, 0) / 1500,
      champsPct: (overseas4Champs / 1500 * 100).toFixed(2),
      perfectCount: overseas4Wins.filter(w => w === 16).length
    },
    zero: {
      avgWins: overseas0Wins.reduce((a, b) => a + b, 0) / 1500,
      champsPct: (overseas0Champs / 1500 * 100).toFixed(2),
      perfectCount: overseas0Wins.filter(w => w === 16).length
    }
  };

  // ==========================================
  // EXPERIMENT 4: Era Filter Impact
  // ==========================================
  console.log("\n>>> RUNNING EXPERIMENT 4: Era Filter Impact (3,000 drafts)...");
  
  const origFrom = ERA_FROM;
  const origTo = ERA_TO;

  console.log("Simulating 1,500 drafts using only the Early Era (2008-2015)...");
  ERA_FROM = 2008;
  ERA_TO = 2015;
  const earlyWins = [];
  let earlyChamps = 0;
  for (let i = 0; i < 1500; i++) {
    const team = runDraftWithStrategy('optimal');
    const res = runSeason(team);
    earlyWins.push(res.wins);
    if (res.champion) earlyChamps++;
    recordSeasonResult(res);
  }

  console.log("Simulating 1,500 drafts using only the Modern Era (2016-2026)...");
  ERA_FROM = 2016;
  ERA_TO = 2026;
  const modernWins = [];
  let modernChamps = 0;
  for (let i = 0; i < 1500; i++) {
    const team = runDraftWithStrategy('optimal');
    const res = runSeason(team);
    modernWins.push(res.wins);
    if (res.champion) modernChamps++;
    recordSeasonResult(res);
  }

  // Restore eras
  ERA_FROM = origFrom;
  ERA_TO = origTo;

  experimentResults.era = {
    early: {
      avgWins: earlyWins.reduce((a, b) => a + b, 0) / 1500,
      champsPct: (earlyChamps / 1500 * 100).toFixed(2),
      perfectCount: earlyWins.filter(w => w === 16).length
    },
    modern: {
      avgWins: modernWins.reduce((a, b) => a + b, 0) / 1500,
      champsPct: (modernChamps / 1500 * 100).toFixed(2),
      perfectCount: modernWins.filter(w => w === 16).length
    }
  };

  // --- PRINT COMPREHENSIVE EXPERIMENT REPORT ---
  console.log("\n=================== CALIBRATION & EXPERIMENT REPORT ===================");
  console.log(`Total Drafts Simulated: 12,000`);
  console.log("-----------------------------------------------------------------------");
  
  console.log("\n1. CHEMISTRY PENALTY IMPACT (Perfect vs. Zero Chemistry):");
  console.log(`- Perfect Chemistry: Avg Wins: ${experimentResults.chemistry.perfect.avgWins.toFixed(2)} / 16, Champ Rate: ${experimentResults.chemistry.perfect.champsPct}%, 16-0s: ${experimentResults.chemistry.perfect.perfectCount}`);
  console.log(`- Ignored Chemistry: Avg Wins: ${experimentResults.chemistry.ignored.avgWins.toFixed(2)} / 16, Champ Rate: ${experimentResults.chemistry.ignored.champsPct}%, 16-0s: ${experimentResults.chemistry.ignored.perfectCount}`);
  
  console.log("\n2. DIFFICULTY LEVEL CALIBRATION (Easy vs. Normal vs. Hard):");
  for (const diff of diffs) {
    const r = experimentResults.difficulty[diff];
    console.log(`- ${diff.toUpperCase()} Mode: Avg Wins: ${r.avgWins.toFixed(2)} / 16, Champ Rate: ${r.champsPct}%, 16-0s: ${r.perfectCount}`);
  }
  
  console.log("\n3. THE 'NO-OVERSEAS' CHALLENGE (4 Overseas vs. 0 Overseas):");
  console.log(`- Exactly 4 Overseas: Avg Wins: ${experimentResults.overseas.four.avgWins.toFixed(2)} / 16, Champ Rate: ${experimentResults.overseas.four.champsPct}%, 16-0s: ${experimentResults.overseas.four.perfectCount}`);
  console.log(`- 0 Overseas:         Avg Wins: ${experimentResults.overseas.zero.avgWins.toFixed(2)} / 16, Champ Rate: ${experimentResults.overseas.zero.champsPct}%, 16-0s: ${experimentResults.overseas.zero.perfectCount}`);
  
  console.log("\n4. ERA FILTER IMPACT (Early Era 2008-2015 vs. Modern Era 2016-2026):");
  console.log(`- Early Era (2008-2015):  Avg Wins: ${experimentResults.era.early.avgWins.toFixed(2)} / 16, Champ Rate: ${experimentResults.era.early.champsPct}%, 16-0s: ${experimentResults.era.early.perfectCount}`);
  console.log(`- Modern Era (2016-2026): Avg Wins: ${experimentResults.era.modern.avgWins.toFixed(2)} / 16, Champ Rate: ${experimentResults.era.modern.champsPct}%, 16-0s: ${experimentResults.era.modern.perfectCount}`);
  
  console.log("================================================-----------------------");

  // --- PRINT INDIVIDUAL AWARDS STRESS TEST ---
  console.log("\n================ INDIVIDUAL AWARDS STRESS TEST ================");
  // Sort and get Top 10 Orange Cap winners
  const topOrange = Object.entries(orangeCapTallies)
      .map(([player, data]) => ({ player, ...data, avgRuns: Math.round(data.totalRuns / data.count) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  console.log("\n🏆 TOP 10 ORANGE CAP WINNERS (Most Frequent):");
  topOrange.forEach((p, idx) => {
      console.log(`  #${idx + 1}: ${p.player} - Won ${p.count} times (Avg: ${p.avgRuns} runs)`);
  });
  
  // Sort and get Top 10 Purple Cap winners
  const topPurple = Object.entries(purpleCapTallies)
      .map(([player, data]) => ({ player, ...data, avgWickets: Math.round(data.totalWickets / data.count) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  console.log("\n💜 TOP 10 PURPLE CAP WINNERS (Most Frequent):");
  topPurple.forEach((p, idx) => {
      console.log(`  #${idx + 1}: ${p.player} - Won ${p.count} times (Avg: ${p.avgWickets} wickets)`);
  });
  
  // Calculate statistical averages of the winners
  const avgOrangeRuns = Math.round(capWinnerStats.orangeCapRuns.reduce((s, r) => s + r, 0) / capWinnerStats.orangeCapRuns.length);
  const maxOrangeRuns = Math.max(...capWinnerStats.orangeCapRuns);
  const minOrangeRuns = Math.min(...capWinnerStats.orangeCapRuns);
  const avgPurpleWickets = Math.round(capWinnerStats.purpleCapWickets.reduce((s, w) => s + w, 0) / capWinnerStats.purpleCapWickets.length);
  const maxPurpleWickets = Math.max(...capWinnerStats.purpleCapWickets);
  const minPurpleWickets = Math.min(...capWinnerStats.purpleCapWickets);
  console.log("\n📊 CAP STATS CALIBRATION CHECK:");
  console.log(`- Orange Cap Runs: Avg ${avgOrangeRuns} runs (Range: ${minOrangeRuns} - ${maxOrangeRuns})`);
  console.log(`- Purple Cap Wickets: Avg ${avgPurpleWickets} wickets (Range: ${minPurpleWickets} - ${maxPurpleWickets})`);
  console.log("===============================================================");

  fs.writeFileSync(
    `${__dirname}/stress_test_results.json`,
    JSON.stringify({ totalRuns: 12000, experimentResults, orangeCapTallies, purpleCapTallies, capWinnerStats }, null, 2)
  );
  console.log("\nResults saved to stress_test_results.json");
}

// ======================= MAIN =======================
if (require.main === module) {
  runComprehensiveStressTest().catch(console.error);
}

