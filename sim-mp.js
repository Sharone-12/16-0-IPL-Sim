// ===================== 16-0 — Multiplayer League: Simulation =====================
// Host authoritatively simulates the whole tournament (round-robin -> playoffs
// -> final) once and writes the result to the room; every client renders the
// same data with a staged reveal. Keeps results identical for all viewers.

const supa = (typeof initSupabase === "function" && initSupabase()) || (typeof supabaseClient !== "undefined" ? supabaseClient : null);
const PID = sessionStorage.getItem("mp_pid");
const ROOM = new URLSearchParams(location.search).get("room");
const $ = (id) => document.getElementById(id);
const content = $("content");
if (!supa || !ROOM) location.href = "lobby.html";

let room = null, players = [], teams = [], nameById = {}, isHost = false, stage = 0, channel = null, simStarted = false;

const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- match engine (ported essence of simulation.js) ----------
function strengthOf(xi) {
  const list = Array.isArray(xi) ? xi : [];
  const ordered = [...list].sort((a, b) => (a.slot || 0) - (b.slot || 0));
  const bats = ordered.slice(0, 6).map((p) => p.bat || p.ovr || 70);
  const bowls = [...list].sort((a, b) => (b.bowl || b.ovr || 0) - (a.bowl || a.ovr || 0)).slice(0, 5).map((p) => p.bowl || p.ovr || 65);
  const wavg = (v, w) => { const tw = w.slice(0, v.length).reduce((a, b) => a + b, 0) || 1; return v.reduce((s, x, i) => s + x * (w[i] || 0), 0) / tw; };
  const batting = wavg(bats, [1.25, 1.18, 1.1, 1, 0.92, 0.85]);
  const bowling = wavg(bowls, [1.22, 1.12, 1.04, 0.96, 0.88]);
  const rest = ordered.slice(6);
  const depth = rest.length ? rest.reduce((s, p) => s + (p.ovr || 70), 0) / rest.length : 75;
  const overall = batting * 0.46 + bowling * 0.42 + depth * 0.08 + 85 * 0.04;
  return { batting, bowling, overall };
}
function innings(bat, bowl) {
  const batAdv = bat.batting - bowl.bowling;
  const totAdv = bat.overall - bowl.overall;
  const proj = 172 + batAdv * 2.4 + totAdv * 1.6 + rnd(-18, 18);
  return clamp(Math.round(proj), 120, 235);
}
function simMatch(A, B) {
  let a = innings(A.s, B.s), b = innings(B.s, A.s);
  if (a === b) (Math.random() < 0.5 ? a++ : b++);
  return { sa: a, sb: b, wId: a > b ? A.id : B.id };
}

function runTournament(teams) {
  const table = {};
  teams.forEach((t) => { table[t.id] = { id: t.id, name: t.name, isBot: t.isBot, p: 0, w: 0, l: 0, rf: 0, ra: 0 }; });
  for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++) {
    const A = teams[i], B = teams[j], m = simMatch(A, B);
    table[A.id].p++; table[B.id].p++;
    table[A.id].rf += m.sa; table[A.id].ra += m.sb; table[B.id].rf += m.sb; table[B.id].ra += m.sa;
    if (m.wId === A.id) { table[A.id].w++; table[B.id].l++; } else { table[B.id].w++; table[A.id].l++; }
  }
  const standings = Object.values(table)
    .map((r) => ({ ...r, pts: r.w * 2, nrr: +((r.rf / (20 * r.p)) - (r.ra / (20 * r.p))).toFixed(3) }))
    .sort((a, b) => b.pts - a.pts || b.nrr - a.nrr);
  const byId = (id) => teams.find((t) => t.id === id);
  const t4 = standings.slice(0, 4).map((s) => byId(s.id));
  const q1 = simMatch(t4[0], t4[1]);
  const elim = simMatch(t4[2], t4[3]);
  const q1w = byId(q1.wId), q1l = q1.wId === t4[0].id ? t4[1] : t4[0], elimw = byId(elim.wId);
  const q2 = simMatch(q1l, elimw), q2w = byId(q2.wId);
  const fin = simMatch(q1w, q2w), champ = byId(fin.wId);
  const M = (m, a, b) => ({ a: a.id, b: b.id, sa: m.sa, sb: m.sb, w: m.wId });
  return {
    standings,
    ko: { q1: M(q1, t4[0], t4[1]), elim: M(elim, t4[2], t4[3]), q2: M(q2, q1l, elimw), final: M(fin, q1w, q2w) },
    championId: champ.id, championName: champ.name,
  };
}

// ---------- load + boot ----------
(async function boot() {
  const { data: r } = await supa.from("rooms").select("*").eq("id", ROOM).single();
  if (!r) { location.href = "lobby.html"; return; }
  room = r; isHost = r.host_id === PID;
  const { data: pl } = await supa.from("players").select("*").eq("room_id", ROOM).order("joined_at", { ascending: true });
  players = pl || [];
  teams = players.map((p) => ({ id: p.id, name: p.username, isBot: p.is_bot, s: strengthOf(p.xi) }));
  teams.forEach((t) => { nameById[t.id] = t.name; });

  subscribe();
  render();

  $("leaveBtn").addEventListener("click", (e) => { e.preventDefault(); location.href = "index.html"; });
})();

function subscribe() {
  channel = supa.channel("simmp:" + ROOM);
  channel.on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${ROOM}` }, (pl) => {
    if (pl.new) { room = pl.new; render(); }
  });
  channel.subscribe();
}

function results() { return room && room.settings && room.settings.results; }

// ---------- render router ----------
function render() {
  const res = results();
  if (!res) { renderPreSim(); return; }
  $("phaseChip").textContent = stage === 0 ? "League" : stage === 1 ? "Knockouts" : "Final";
  if (stage === 0) renderLeague(res);
  else if (stage === 1) renderKnockouts(res);
  else renderFinal(res);
}

function renderPreSim() {
  $("phaseChip").textContent = "League";
  if (isHost) {
    content.innerHTML = `
      <h2 class="title">League Ready</h2>
      <p class="sub">${teams.length} teams drafted. Run the round-robin, playoffs and final.</p>
      <button class="btn" id="simBtn">Simulate League</button>`;
    $("simBtn").onclick = startSim;
  } else {
    content.innerHTML = `<div class="status-msg"><span class="spin"></span>Waiting for the host to start the simulation…</div>`;
  }
}

async function startSim() {
  if (simStarted) return; simStarted = true;
  $("simBtn") && ($("simBtn").disabled = true, $("simBtn").innerHTML = '<span class="spin"></span>Simulating…');
  const res = runTournament(teams);
  const newSettings = { ...(room.settings || {}), results: res };
  try {
    await supa.from("rooms").update({ settings: newSettings, status: "finished" }).eq("id", ROOM);
    room.settings = newSettings; render();
  } catch (e) { simStarted = false; if ($("simBtn")) { $("simBtn").disabled = false; $("simBtn").textContent = "Simulate League"; } }
}

// ---------- league table ----------
function teamCell(id) {
  const t = teams.find((x) => x.id === id);
  const bot = t && t.isBot ? '<span class="bot">BOT</span>' : "";
  return `${esc(nameById[id] || "—")}${bot}`;
}
function renderLeague(res) {
  const rows = res.standings.map((s, i) => {
    return `<tr class="${s.id === PID ? "me" : ""} ${i < 4 ? "q" : ""}">
      <td class="l rank">${i + 1}</td>
      <td class="l tname">${teamCell(s.id)}</td>
      <td>${s.p}</td><td>${s.w}</td><td>${s.l}</td>
      <td>${s.nrr > 0 ? "+" : ""}${s.nrr.toFixed(2)}</td>
      <td class="pts">${s.pts}</td>
    </tr>${i === 3 ? '<tr><td colspan="7" class="qline">— top 4 qualify —</td></tr>' : ""}`;
  }).join("");
  content.innerHTML = `
    <h2 class="title">League Table</h2>
    <p class="sub">Round-robin complete — every team played every other once.</p>
    <table>
      <thead><tr><th class="l">#</th><th class="l">Team</th><th>P</th><th>W</th><th>L</th><th>NRR</th><th>Pts</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <button class="btn" id="nextBtn">Continue to Knockouts →</button>`;
  $("nextBtn").onclick = () => { stage = 1; render(); };
}

// ---------- knockouts ----------
function matchCard(label, m) {
  const win = (id) => id === m.w ? "win" : "";
  return `<div class="match">
    <div class="ml">${label}</div>
    <div class="row ${win(m.a)}"><span>${teamCell(m.a)}</span><span class="sc">${m.sa}</span></div>
    <div class="vs">vs</div>
    <div class="row ${win(m.b)}"><span>${teamCell(m.b)}</span><span class="sc">${m.sb}</span></div>
  </div>`;
}
function renderKnockouts(res) {
  const k = res.ko;
  content.innerHTML = `
    <h2 class="title">Playoffs</h2>
    <p class="sub">Qualifier 1, Eliminator, Qualifier 2 — then the Final.</p>
    <div class="bracket">
      ${matchCard("Qualifier 1 · 1st vs 2nd", k.q1)}
      ${matchCard("Eliminator · 3rd vs 4th", k.elim)}
      ${matchCard("Qualifier 2 · Q1 loser vs Eliminator winner", k.q2)}
    </div>
    <button class="btn" id="nextBtn">Continue to the Final →</button>`;
  $("nextBtn").onclick = () => { stage = 2; render(); };
}

// ---------- final + champion ----------
function renderFinal(res) {
  const f = res.ko.final;
  const winName = nameById[res.championId];
  const isMe = res.championId === PID;
  content.innerHTML = `
    <div class="champ">
      <div class="crown">League Champions</div>
      <div class="cname">${esc(winName)}</div>
      <div class="ctrophy">🏆 ${isMe ? "YOU WON THE LEAGUE" : "CHAMPION"}</div>
    </div>
    <div class="final-card">
      <div class="fc-head">
        <span class="${f.w === f.a ? "w" : ""}">${teamCell(f.a)} ${f.sa}</span>
        <span class="${f.w === f.b ? "w" : ""}">${f.sb} ${teamCell(f.b)}</span>
      </div>
      <div class="fc-line">The Final — ${esc(nameById[f.w])} win by ${Math.abs(f.sa - f.sb)} runs</div>
    </div>
    <button class="btn" id="shareBtn">Share Result</button>
    <button class="btn ghost" id="againBtn">Back to Lobby</button>`;
  if (isMe) confetti();
  $("shareBtn").onclick = () => {
    const txt = `${winName} won the 16-0 Multiplayer League 🏏🏆 — ${teams.length} teams, one champion. Play at 16-0game.vercel.app`;
    navigator.clipboard?.writeText(txt);
    $("shareBtn").textContent = "Copied!";
    setTimeout(() => ($("shareBtn").textContent = "Share Result"), 1500);
  };
  $("againBtn").onclick = () => { location.href = "lobby.html"; };
}

function confetti() {
  const colors = ["#00ff87", "#f5c451", "#6db8ff", "#ff5e5e", "#fff"];
  for (let i = 0; i < 80; i++) {
    const c = document.createElement("div");
    c.className = "confetti";
    c.style.left = Math.random() * 100 + "vw";
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = 2 + Math.random() * 2.5 + "s";
    c.style.animationDelay = Math.random() * 0.6 + "s";
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 5000);
  }
}
