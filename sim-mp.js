// ===================== 16-0 — Multiplayer League: Simulation =====================
// Reuses the REAL simulation.js match engine (pitch types, buildInnings,
// distributeBatting/Bowling, dismissals, MOTM, resultMargin) so knockouts and
// the final show full detailed scorecards exactly like the solo game.
// Host authoritatively simulates the tournament once; everyone renders the same.

const supa = (typeof initSupabase === "function" && initSupabase()) || (typeof supabaseClient !== "undefined" ? supabaseClient : null);
const PID = sessionStorage.getItem("mp_pid");
const ROOM = new URLSearchParams(location.search).get("room");
const $ = (id) => document.getElementById(id);
const content = $("content");
if (!supa || !ROOM) location.href = "lobby.html";

let room = null, players = [], teams = [], nameById = {}, isHost = false, stage = 0, channel = null, simStarted = false;

const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ====================== REAL ENGINE (verbatim from simulation.js) ======================
const randomBetween = (min, max) => min + Math.random() * (max - min);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function weightedAverage(values, weights) {
  const tw = weights.slice(0, values.length).reduce((a, b) => a + b, 0);
  return values.reduce((s, v, i) => s + v * weights[i], 0) / tw;
}
function average(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 70; }
function chemistryScore(players) {
  const pen = players.reduce((s, p, i) => {
    if (p.primaryRole === "Bowler" && i < 7) return s + 7;
    if (p.battingOrder === "Opener" && i > 2) return s + 3;
    if (p.battingOrder === "Lower Order" && i < 6) return s + 3;
    return s;
  }, 0);
  let score = Math.max(55, 92 - pen);
  const cap = players.find((p) => p.isCaptain);
  if (cap) { let b = 1; if (cap.ovr >= 93) b = 5; else if (cap.ovr >= 90) b = 4; else if (cap.ovr >= 87) b = 3; else if (cap.ovr >= 83) b = 2; score += b; }
  return Math.min(100, score);
}
function teamStrength(players) {
  const topSix = players.slice(0, 6);
  const bowlers = [...players].sort((a, b) => b.bowl - a.bowl).slice(0, 5);
  const batting = weightedAverage(topSix.map((p) => p.bat || p.ovr), [1.25, 1.18, 1.1, 1, 0.92, 0.85]);
  const bowling = weightedAverage(bowlers.map((p) => p.bowl || p.ovr), [1.22, 1.12, 1.04, 0.96, 0.88]);
  const depth = average(players.slice(6).map((p) => p.ovr));
  const chemistry = chemistryScore(players);
  const overall = batting * 0.46 + bowling * 0.42 + depth * 0.08 + chemistry * 0.04;
  return { batting, bowling, depth, chemistry, overall, total: overall };
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
  const pos = weights.map((w) => Math.max(0.01, w));
  const sum = pos.reduce((a, b) => a + b, 0);
  const raw = pos.map((w) => Math.floor((w / sum) * total));
  const rem = total - raw.reduce((a, b) => a + b, 0);
  const fr = pos.map((w, i) => ({ i, f: (w / sum) * total - raw[i] })).sort((a, b) => b.f - a.f);
  for (let k = 0; k < rem; k++) raw[fr[k].i]++;
  return raw;
}
function dismissal(opp) {
  const bowler = [...opp.players].sort((a, b) => b.bowl - a.bowl)[Math.floor(randomBetween(0, 5))];
  const t = ["c", "b", "lbw", "run out", "st"][Math.floor(Math.random() * 5)];
  return `${t} ${bowler.displayName}`;
}
function distributeBatting(team, opponent, runs, wickets, balls, isKnockout = false, srBonus = 0) {
  const battersUsed = wickets >= 10 ? 11 : clamp(wickets + 2, 3, 11);
  const activePlayers = team.players.slice(0, battersUsed);
  const oppBowlAvg = [...opponent.players].sort((a, b) => b.bowl - a.bowl).slice(0, 4).reduce((s, p) => s + (p.bowl || p.ovr), 0) / 4;
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
    const boost = 40 - rawRuns[bestIdx]; rawRuns[bestIdx] += boost;
    const deductFrom = [3, 4, 5].filter((j) => j < rawRuns.length && rawRuns[j] > 5);
    deductFrom.forEach((j) => { rawRuns[j] = Math.max(3, rawRuns[j] - Math.floor(boost / deductFrom.length)); });
  }
  const INNINGS_CAP = 72;
  rawRuns.forEach((r, i) => {
    if (r > INNINGS_CAP) {
      const ex = r - INNINGS_CAP; rawRuns[i] = INNINGS_CAP;
      const others = rawRuns.map((_, j) => j).filter((j) => j !== i);
      const ot = others.reduce((a, j) => a + rawRuns[j], 0);
      others.forEach((j) => { if (ot > 0) rawRuns[j] += Math.round((ex * rawRuns[j]) / ot); });
    }
  });
  const heroMin = isKnockout ? 45 : 35;
  if (runs >= 150 && Math.max(...rawRuns) < heroMin) {
    const cand = weights.map((w, i) => ({ w, i })).sort((a, b) => b.w - a.w).slice(0, 4);
    const ti = cand[Math.floor(Math.random() * cand.length)].i;
    const boost = heroMin - rawRuns[ti]; rawRuns[ti] += boost;
    const ot = rawRuns.reduce((a, b, i) => (i === ti ? a : a + b), 0);
    rawRuns.forEach((_, i) => { if (i !== ti && ot > 0) rawRuns[i] = Math.max(0, rawRuns[i] - Math.round((boost * rawRuns[i]) / ot)); });
  }
  const diff = runs - rawRuns.reduce((a, b) => a + b, 0);
  if (diff !== 0) { const ti = rawRuns.indexOf(Math.max(...rawRuns)); rawRuns[ti] = Math.max(0, rawRuns[ti] + diff); }
  const rawBalls = activePlayers.map((p, i) => {
    const baseSR = i < 2 ? randomBetween(128, 168) : i < 5 ? randomBetween(118, 158) : i < 7 ? randomBetween(135, 178) : randomBetween(100, 138);
    const ratBonus = ((p.bat || p.ovr) - 70) * 0.35;
    const sr = Math.max(95, baseSR + ratBonus + srBonus + randomBetween(-10, 10));
    return Math.max(1, Math.round((rawRuns[i] / sr) * 100));
  });
  const totalRaw = rawBalls.reduce((a, b) => a + b, 0);
  const scaled = rawBalls.map((b) => Math.max(1, Math.round((b * 120) / totalRaw)));
  const bd = 120 - scaled.reduce((a, b) => a + b, 0);
  const tbi = scaled.indexOf(Math.max(...scaled)); scaled[tbi] = Math.max(1, scaled[tbi] + bd);
  return team.players.map((p, i) => {
    if (i >= battersUsed) return { player: p, runs: 0, balls: 0, out: false, didBat: false, howOut: "DNB" };
    const notOut = wickets >= 10 ? 1 : 2;
    const out = i < battersUsed - notOut;
    return { player: p, runs: rawRuns[i], balls: scaled[i], out, didBat: true, howOut: out ? dismissal(opponent) : "not out" };
  });
}
function distributeBowling(team, opponent, runs, wickets) {
  const bowlers = [...team.players].sort((a, b) => b.bowl - a.bowl).slice(0, 5);
  const overs = [4, 4, 4, 4, 4];
  const runW = bowlers.map((p) => { const base = 110 - penalizedBowl(p); const smashed = Math.random() < 0.2 ? randomBetween(1.6, 2.6) : 1; return Math.max(1, base * smashed + randomBetween(-10, 10)); });
  const wktW = bowlers.map((p) => { const cold = Math.random() < 0.33 ? randomBetween(0.08, 0.35) : 1; return Math.max(0.5, penalizedBowl(p) * cold + randomBetween(-8, 8)); });
  const rs = splitByWeights(runs, runW), ws = splitByWeights(wickets, wktW);
  return bowlers.map((p, i) => ({ player: p, overs: overs[i], runs: rs[i], wickets: ws[i], economy: (rs[i] / overs[i]).toFixed(2) }));
}
function getPitchType() { const r = Math.random(); return r < 0.40 ? "batting" : r < 0.90 ? "neutral" : "bowling"; }
const PITCH_MODS = { batting: { runs: 25, wickets: -1.5, srBonus: 18 }, neutral: { runs: 8, wickets: 0, srBonus: 5 }, bowling: { runs: -12, wickets: 1.2, srBonus: -8 } };
function buildInnings(bat, bowl, options = {}) {
  const batAdv = bat.strength.batting - bowl.strength.bowling;
  const totAdv = bat.strength.total - bowl.strength.total;
  const pressure = options.knockout ? randomBetween(-16, 16) : randomBetween(-18, 18);
  const pitch = options.pitch || { runs: 0, wickets: 0, srBonus: 0 };
  let proj = 172 + batAdv * 2.4 + totAdv * 1.6 + pressure + pitch.runs;
  if (options.target) proj = Math.min(proj, options.target + randomBetween(-16, 10));
  const runs = clamp(Math.round(proj), 148, 230);
  const wickets = clamp(Math.round(randomBetween(3, 8) - batAdv / 18 + pitch.wickets), 2, 10);
  const balls = wickets >= 10 ? Math.round(randomBetween(103, 120)) : 120;
  const batting = distributeBatting(bat, bowl, runs, wickets, balls, options.knockout, pitch.srBonus);
  const bowling = distributeBowling(bowl, bat, runs, wickets);
  return { runs, wickets, balls, batting, bowling };
}
function simulateMatch(home, away, options = {}) {
  const pitchType = getPitchType();
  const pitch = PITCH_MODS[pitchType];
  const homeInn = buildInnings(home, away, { ...options, pitch });
  const target = homeInn.runs + 1;
  const awayInn = buildInnings(away, home, { ...options, pitch, target });
  if (awayInn.runs > homeInn.runs) awayInn.runs = target;
  else if (awayInn.runs === homeInn.runs) awayInn.runs += 1;
  const winner = homeInn.runs > awayInn.runs ? home : away;
  return { home, away, pitchType, innings: { [home.id]: homeInn, [away.id]: awayInn }, winner, scoreFor: (id) => id === home.id ? homeInn : awayInn };
}
const formatScore = (s) => `${s.runs}/${s.wickets}`;
const strikeRate = (r, b) => ((r / Math.max(b, 1)) * 100).toFixed(1);
function resultMargin(match) {
  const chase = match.scoreFor(match.away.id), def = match.scoreFor(match.home.id);
  return match.winner.id === match.away.id ? `by ${10 - chase.wickets} wickets` : `by ${def.runs - chase.runs} runs`;
}
function manOfTheMatch(match) {
  const inn = match.scoreFor(match.winner.id);
  const tb = [...inn.batting].sort((a, b) => b.runs - a.runs)[0];
  const tw = [...inn.bowling].sort((a, b) => b.wickets - a.wickets || a.runs - b.runs)[0];
  return tb.runs >= 55 || tb.runs > tw.wickets * 18 ? `${tb.player.displayName} (${tb.runs})` : `${tw.player.displayName} (${tw.wickets}/${tw.runs})`;
}

// ---------- serialise a match -> plain scorecard data ----------
function matchToCard(match, knockoutLabel) {
  const side = (team) => {
    const inn = match.scoreFor(team.id);
    return {
      name: team.name, runs: inn.runs, wickets: inn.wickets,
      bat: inn.batting.map((r) => ({ n: r.player.displayName, r: r.runs, b: r.balls, dnb: !r.didBat, how: r.howOut })),
      bowl: inn.bowling.map((r) => ({ n: r.player.displayName, o: r.overs, r: r.runs, w: r.wickets, e: r.economy })),
    };
  };
  return {
    label: knockoutLabel, pitch: match.pitchType,
    home: side(match.home), away: side(match.away),
    winnerId: match.winner.id, winnerName: match.winner.name, margin: resultMargin(match), motm: manOfTheMatch(match),
    aId: match.home.id, bId: match.away.id,
  };
}

// ====================== teams ======================
function buildTeam(p) {
  const players = (Array.isArray(p.xi) ? [...p.xi] : []).sort((a, b) => (a.slot || 0) - (b.slot || 0)).map((x) => ({
    name: x.name, displayName: x.name, ovr: x.ovr || 70, bat: x.bat || x.ovr || 70, bowl: x.bowl || x.ovr || 65,
    battingOrder: x.battingOrder, primaryRole: x.primaryRole, isWk: x.isWk, isOverseas: x.isOverseas, isCaptain: x.isCaptain,
  }));
  return { id: p.id, name: p.username, short: (p.username || "").slice(0, 12), isBot: p.is_bot, players, strength: teamStrength(players) };
}

// ====================== tournament (host) ======================
function runTournament(teams) {
  const table = {};
  teams.forEach((t) => { table[t.id] = { id: t.id, name: t.name, isBot: t.isBot, p: 0, w: 0, l: 0, rf: 0, ra: 0 }; });
  for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++) {
    const m = simulateMatch(teams[i], teams[j]);
    const a = teams[i].id, b = teams[j].id;
    const sa = m.scoreFor(a), sb = m.scoreFor(b);
    table[a].p++; table[b].p++;
    table[a].rf += sa.runs; table[a].ra += sb.runs; table[b].rf += sb.runs; table[b].ra += sa.runs;
    if (m.winner.id === a) { table[a].w++; table[b].l++; } else { table[b].w++; table[a].l++; }
  }
  const standings = Object.values(table).map((r) => ({ ...r, pts: r.w * 2, nrr: +((r.rf / (20 * r.p)) - (r.ra / (20 * r.p))).toFixed(3) }))
    .sort((a, b) => b.pts - a.pts || b.nrr - a.nrr);
  const byId = (id) => teams.find((t) => t.id === id);
  const t4 = standings.slice(0, 4).map((s) => byId(s.id));
  const q1m = simulateMatch(t4[0], t4[1], { knockout: true });
  const elimm = simulateMatch(t4[2], t4[3], { knockout: true });
  const q1w = q1m.winner, q1l = q1w.id === t4[0].id ? t4[1] : t4[0], elimw = elimm.winner;
  const q2m = simulateMatch(q1l, elimw, { knockout: true });
  const finalm = simulateMatch(q1w, q2m.winner, { knockout: true });
  return {
    standings,
    ko: {
      q1: matchToCard(q1m, "Qualifier 1 · 1st vs 2nd"),
      elim: matchToCard(elimm, "Eliminator · 3rd vs 4th"),
      q2: matchToCard(q2m, "Qualifier 2 · Q1 loser vs Eliminator winner"),
      final: matchToCard(finalm, "The Final"),
    },
    championId: finalm.winner.id, championName: finalm.winner.name,
  };
}

// ====================== boot ======================
(async function boot() {
  const { data: r } = await supa.from("rooms").select("*").eq("id", ROOM).single();
  if (!r) { location.href = "lobby.html"; return; }
  room = r; isHost = r.host_id === PID;
  const { data: pl } = await supa.from("players").select("*").eq("room_id", ROOM).order("joined_at", { ascending: true });
  players = pl || [];
  teams = players.map(buildTeam);
  teams.forEach((t) => { nameById[t.id] = t.name; });
  subscribe();
  render();
  $("leaveBtn").addEventListener("click", (e) => { e.preventDefault(); location.href = "index.html"; });
})();

function subscribe() {
  channel = supa.channel("simmp:" + ROOM);
  channel.on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${ROOM}` }, (pl) => { if (pl.new) { room = pl.new; render(); } });
  channel.subscribe();
}
const results = () => room && room.settings && room.settings.results;

// ====================== render router ======================
function render() {
  const res = results();
  if (!res) return renderPreSim();
  $("phaseChip").textContent = stage === 0 ? "League" : stage === 1 ? "Knockouts" : "Final";
  if (stage === 0) renderLeague(res);
  else if (stage === 1) renderKnockouts(res);
  else renderFinal(res);
}

function renderPreSim() {
  $("phaseChip").textContent = "League";
  if (isHost) {
    content.innerHTML = `<h2 class="title">League Ready</h2><p class="sub">${teams.length} teams drafted. Simulate the round-robin, playoffs and final.</p><button class="btn" id="simBtn">Simulate League</button>`;
    $("simBtn").onclick = startSim;
  } else {
    content.innerHTML = `<div class="status-msg"><span class="spin"></span>Waiting for the host to start the simulation…</div>`;
  }
}
async function startSim() {
  if (simStarted) return; simStarted = true;
  const b = $("simBtn"); if (b) { b.disabled = true; b.innerHTML = '<span class="spin"></span>Simulating…'; }
  const res = runTournament(teams);
  const newSettings = { ...(room.settings || {}), results: res };
  try { await supa.from("rooms").update({ settings: newSettings, status: "finished" }).eq("id", ROOM); room.settings = newSettings; render(); }
  catch (e) { simStarted = false; if (b) { b.disabled = false; b.textContent = "Simulate League"; } }
}

function teamCell(id) {
  const t = teams.find((x) => x.id === id);
  return `${esc(nameById[id] || "—")}${t && t.isBot ? '<span class="bot">BOT</span>' : ""}`;
}

// ---------- league ----------
function renderLeague(res) {
  const rows = res.standings.map((s, i) => `
    <tr class="${s.id === PID ? "me" : ""} ${i < 4 ? "q" : ""}">
      <td class="l rank">${i + 1}</td><td class="l tname">${teamCell(s.id)}</td>
      <td>${s.p}</td><td>${s.w}</td><td>${s.l}</td>
      <td>${s.nrr > 0 ? "+" : ""}${s.nrr.toFixed(2)}</td><td class="pts">${s.pts}</td>
    </tr>${i === 3 ? '<tr><td colspan="7" class="qline">— top 4 qualify —</td></tr>' : ""}`).join("");
  content.innerHTML = `
    <h2 class="title">League Table</h2><p class="sub">Round-robin complete — every team played every other once.</p>
    <table><thead><tr><th class="l">#</th><th class="l">Team</th><th>P</th><th>W</th><th>L</th><th>NRR</th><th>Pts</th></tr></thead><tbody>${rows}</tbody></table>
    <button class="btn" id="nextBtn">Continue to Knockouts →</button>`;
  $("nextBtn").onclick = () => { stage = 1; render(); };
}

// ---------- scorecard (detailed, like solo) ----------
function inningsBlock(side) {
  const bat = side.bat.map((r) => `
    <div class="score-row bat ${r.dnb ? "is-dnb" : ""}">
      <div class="c-name">${esc(r.n)}</div><div class="c-dis">${r.dnb ? "DNB" : esc(r.how)}</div>
      <div>${r.dnb ? "-" : r.r}</div><div>${r.dnb ? "-" : r.b}</div><div>${r.dnb ? "-" : strikeRate(r.r, r.b)}</div>
    </div>`).join("");
  const bowl = side.bowl.map((r) => `
    <div class="score-row bowl"><div class="c-name">${esc(r.n)}</div><div>${r.o}</div><div>${r.w}</div><div>${r.r}</div><div>${r.e}</div></div>`).join("");
  return `<div class="innings-block">
    <h3>${esc(side.name)} ${side.runs}/${side.wickets}</h3>
    <div class="score-table"><div class="score-row bat head"><div class="c-name">Batter</div><div class="c-dis">Dismissal</div><div>R</div><div>B</div><div>SR</div></div>${bat}</div>
    <div class="score-table"><div class="score-row bowl head"><div class="c-name">Bowler</div><div>O</div><div>W</div><div>R</div><div>Econ</div></div>${bowl}</div>
  </div>`;
}
function matchCard(c, open) {
  return `<details class="ko-match" ${open ? "open" : ""}>
    <summary>
      <span class="ko-label">${esc(c.label)}</span>
      <span class="ko-score">
        <span class="${c.winnerId === c.aId ? "w" : ""}">${teamCell(c.aId)} ${c.home.runs}/${c.home.wickets}</span>
        <span class="ko-vs">vs</span>
        <span class="${c.winnerId === c.bId ? "w" : ""}">${teamCell(c.bId)} ${c.away.runs}/${c.away.wickets}</span>
      </span>
      <span class="ko-result">${esc(c.winnerName)} won ${esc(c.margin)} · ${c.pitch} pitch</span>
    </summary>
    <div class="scorecard">${inningsBlock(c.home)}${inningsBlock(c.away)}<div class="motm">Man of the Match: ${esc(c.motm)}</div></div>
  </details>`;
}
function renderKnockouts(res) {
  const k = res.ko;
  content.innerHTML = `
    <h2 class="title">Playoffs</h2><p class="sub">Tap a match to expand the full scorecard.</p>
    ${matchCard(k.q1)}${matchCard(k.elim)}${matchCard(k.q2)}
    <button class="btn" id="nextBtn">Continue to the Final →</button>`;
  $("nextBtn").onclick = () => { stage = 2; render(); };
}

// ---------- final + champion ----------
function renderFinal(res) {
  const f = res.ko.final;
  const winName = nameById[res.championId], isMe = res.championId === PID;
  content.innerHTML = `
    <div class="champ"><div class="crown">League Champions</div><div class="cname">${esc(winName)}</div><div class="ctrophy">🏆 ${isMe ? "YOU WON THE LEAGUE" : "CHAMPION"}</div></div>
    ${matchCard(f, true)}
    <button class="btn" id="shareBtn">Share Result</button>
    <button class="btn ghost" id="againBtn">Back to Lobby</button>`;
  if (isMe) confetti();
  $("shareBtn").onclick = () => { navigator.clipboard?.writeText(`${winName} won the 16-0 Multiplayer League 🏏🏆 — ${teams.length} teams, one champion. Play at 16-0game.vercel.app`); $("shareBtn").textContent = "Copied!"; setTimeout(() => ($("shareBtn").textContent = "Share Result"), 1500); };
  $("againBtn").onclick = () => { location.href = "lobby.html"; };
}
function confetti() {
  const cols = ["#00ff87", "#f5c451", "#6db8ff", "#ff5e5e", "#fff"];
  for (let i = 0; i < 80; i++) { const c = document.createElement("div"); c.className = "confetti"; c.style.left = Math.random() * 100 + "vw"; c.style.background = cols[i % cols.length]; c.style.animationDuration = 2 + Math.random() * 2.5 + "s"; c.style.animationDelay = Math.random() * 0.6 + "s"; document.body.appendChild(c); setTimeout(() => c.remove(), 5000); }
}
