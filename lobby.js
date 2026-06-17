// ===================== 16-0 — Multiplayer League: Lobby =====================
// Pure vanilla JS + Supabase Realtime. Create/join rooms, live player list,
// bot-fill preview from the 2026 squads, ready/start flow, countdown -> draft-mp.

// ---------- Supabase ----------
const supa = (typeof initSupabase === "function" && initSupabase()) || (typeof supabaseClient !== "undefined" ? supabaseClient : null);

// ---------- persistent identity ----------
function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "p_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
let PLAYER_ID = localStorage.getItem("mp_pid");
if (!PLAYER_ID) { PLAYER_ID = uid(); localStorage.setItem("mp_pid", PLAYER_ID); }

// ---------- state ----------
const state = {
  room: null,       // room row
  players: [],      // player rows
  isHost: false,
  channel: null,
  online: new Set(),
  botTeams: [],     // [{name, ovr}]
  createOpts: { era: "all", difficulty: "normal", maxPlayers: 6 },
};

// ---------- elements ----------
const $ = (id) => document.getElementById(id);
const views = {
  chooser: $("view-chooser"),
  create: $("view-create"),
  join: $("view-join"),
  waiting: $("view-waiting"),
};
function show(view) {
  Object.values(views).forEach((v) => v.classList.add("hidden"));
  views[view].classList.remove("hidden");
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 1600);
}

// ---------- avatars ----------
const AVATARS = ["🏏", "🦁", "🐯", "⚡", "🔥", "🦅", "🐉", "👑", "🚀", "💎", "🎯", "🦈"];
function avatarFor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATARS[h % AVATARS.length];
}

// ===================== CSV: bot team ratings =====================
// Top 2026 franchises by average squad OVR fill the remaining slots.
let csvReady = false;
function loadBotTeams() {
  return new Promise((resolve) => {
    Papa.parse("ipl_master_calibrated.csv", {
      download: true, header: true, skipEmptyLines: true,
      complete: (res) => {
        const byTeam = {};
        for (const r of res.data) {
          if ((r.Season || "").trim() !== "2026") continue;
          const full = (r.Franchise_Full || r.Franchise || "").trim();
          if (!full) continue;
          (byTeam[full] = byTeam[full] || []).push(+r.OVR || 0);
        }
        const teams = Object.entries(byTeam)
          .map(([name, ovrs]) => {
            const top = ovrs.sort((a, b) => b - a).slice(0, 11);
            const avg = top.reduce((a, b) => a + b, 0) / (top.length || 1);
            return { name, ovr: Math.round(avg) };
          })
          .filter((t) => byTeam[t.name].length >= 11)
          .sort((a, b) => b.ovr - a.ovr);
        state.botTeams = teams;
        csvReady = true;
        resolve(teams);
      },
      error: () => { csvReady = true; resolve([]); },
    });
  });
}

// ===================== room helpers =====================
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
function genCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function requireSupa() {
  if (!supa) {
    alert("Multiplayer needs the database to be configured. (supabase_config.js)");
    return false;
  }
  return true;
}

// ===================== CREATE =====================
$("goCreate").onclick = () => show("create");
$("goJoin").onclick = () => show("join");
$("createBack").onclick = () => show("chooser");
$("joinBack").onclick = () => show("chooser");

// slider
$("maxPlayers").addEventListener("input", (e) => {
  const v = e.target.value;
  $("maxVal").textContent = v;
  $("maxValBig").textContent = v;
  state.createOpts.maxPlayers = +v;
});
// segmented controls
function wireSeg(segId, key) {
  $(segId).querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      $(segId).querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      state.createOpts[key] = b.dataset.v;
    };
  });
}
wireSeg("segEra", "era");
wireSeg("segDiff", "difficulty");

$("createBtn").onclick = async () => {
  if (!requireSupa()) return;
  const name = ($("roomName").value || "").trim() || "16-0 League";
  $("createErr").textContent = "";
  $("createBtn").disabled = true;
  $("createBtn").innerHTML = '<span class="spin"></span>';
  try {
    // generate a unique room code (retry on collision)
    let code, ok = false, tries = 0;
    while (!ok && tries < 6) {
      code = genCode();
      const { error } = await supa.from("rooms").insert({
        id: code,
        name,
        host_id: PLAYER_ID,
        status: "waiting",
        settings: {
          era: state.createOpts.era,
          difficulty: state.createOpts.difficulty,
          max_players: state.createOpts.maxPlayers,
        },
      });
      if (!error) ok = true;
      else if (error.code === "23505") { tries++; continue; } // PK collision
      else throw error;
    }
    if (!ok) throw new Error("Could not generate a free room code, try again.");

    // host joins as a player
    const hostName = (localStorage.getItem("mp_name") || "Host").slice(0, 18);
    await supa.from("players").insert({
      id: PLAYER_ID, room_id: code, username: hostName,
      is_host: true, is_bot: false, status: "ready", xi: null,
    });
    enterRoom(code, true);
  } catch (e) {
    $("createErr").textContent = e.message || "Failed to create room.";
    $("createBtn").disabled = false;
    $("createBtn").textContent = "Create Room";
  }
};

// ===================== JOIN =====================
$("joinCode").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });

$("joinBtn").onclick = async () => {
  if (!requireSupa()) return;
  const code = ($("joinCode").value || "").trim().toUpperCase();
  const name = ($("joinName").value || "").trim();
  $("joinErr").textContent = "";
  if (code.length !== 6) { $("joinErr").textContent = "Enter the full 6-character code."; return; }
  if (!name) { $("joinErr").textContent = "Enter your name."; return; }
  localStorage.setItem("mp_name", name.slice(0, 18));

  $("joinBtn").disabled = true;
  $("joinBtn").innerHTML = '<span class="spin"></span>';
  try {
    const { data: room, error } = await supa.from("rooms").select("*").eq("id", code).single();
    if (error || !room) throw new Error("Room not found.");
    if (room.status !== "waiting") throw new Error("That room has already started.");

    const { data: existing } = await supa.from("players").select("id,is_bot").eq("room_id", code);
    const humans = (existing || []).filter((p) => !p.is_bot);
    const already = humans.find((p) => p.id === PLAYER_ID);
    if (!already && humans.length >= (room.settings?.max_players || 10)) {
      throw new Error("Room is full.");
    }
    // upsert self (so re-join works)
    await supa.from("players").upsert({
      id: PLAYER_ID, room_id: code, username: name.slice(0, 18),
      is_host: room.host_id === PLAYER_ID, is_bot: false,
      status: "waiting", xi: null,
    });
    enterRoom(code, room.host_id === PLAYER_ID);
  } catch (e) {
    $("joinErr").textContent = e.message || "Could not join.";
    $("joinBtn").disabled = false;
    $("joinBtn").textContent = "Join Lobby";
  }
};

// ===================== WAITING ROOM =====================
async function enterRoom(code, isHost) {
  state.isHost = isHost;
  localStorage.setItem("mp_room", code);
  show("waiting");
  $("wCode").textContent = code;

  await refreshRoom(code);
  await refreshPlayers(code);
  subscribe(code);
  renderWaiting();

  // tap-to-copy code + share link
  $("wCode").onclick = () => { navigator.clipboard?.writeText(code); toast("Room code copied"); };
  $("shareLink").onclick = (e) => {
    e.preventDefault();
    const url = `${location.origin}/lobby.html?room=${code}`;
    navigator.clipboard?.writeText(url);
    toast("Invite link copied");
  };
}

async function refreshRoom(code) {
  const { data } = await supa.from("rooms").select("*").eq("id", code).single();
  if (data) {
    state.room = data;
    // status moved on -> go to the right page
    if (data.status === "drafting") return gotoDraft(code);
  }
}
async function refreshPlayers(code) {
  const { data } = await supa.from("players").select("*").eq("room_id", code).order("joined_at", { ascending: true });
  state.players = data || [];
}

function subscribe(code) {
  if (state.channel) supa.removeChannel(state.channel);
  const ch = supa.channel("room:" + code, { config: { presence: { key: PLAYER_ID } } });

  ch.on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `room_id=eq.${code}` },
    async () => { await refreshPlayers(code); renderWaiting(); });

  ch.on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${code}` },
    (payload) => {
      state.room = payload.new || state.room;
      if (state.room && state.room.status === "drafting") gotoDraft(code);
    });

  ch.on("presence", { event: "sync" }, () => {
    const st = ch.presenceState();
    state.online = new Set(Object.keys(st));
    renderWaiting();
  });

  ch.subscribe(async (status) => {
    if (status === "SUBSCRIBED") await ch.track({ pid: PLAYER_ID, at: Date.now() });
  });
  state.channel = ch;
}

function renderWaiting() {
  const room = state.room;
  if (!room) return;
  const max = room.settings?.max_players || 10;
  $("wRoomName").textContent = room.name || "Lobby";
  const eraLabel = { all: "All eras", modern: "Modern '15+", golden: "Golden '08–14" }[room.settings?.era] || "All eras";
  $("wRules").textContent = `${eraLabel} · ${(room.settings?.difficulty || "normal")} · up to ${max} teams`;

  const humans = state.players.filter((p) => !p.is_bot);
  const botCount = Math.max(0, max - humans.length);

  // player list
  const list = $("playerList");
  list.innerHTML = humans.map((p) => {
    const online = state.online.has(p.id) || p.id === PLAYER_ID;
    const tags = [];
    if (p.is_host) tags.push('<span class="ptag host">Host</span>');
    if (!p.is_host && p.status === "ready") tags.push('<span class="ptag ready">Ready</span>');
    return `<li>
      <span class="ava">${avatarFor(p.id)}</span>
      <span class="pname">${escapeHtml(p.username)}${p.id === PLAYER_ID ? " (you)" : ""}</span>
      ${tags.join("")}
      <span class="dot ${online ? "" : "off"}"></span>
    </li>`;
  }).join("");
  $("playerCount").textContent = `${humans.length}/${max}`;

  // bot fill
  $("fillNote").innerHTML = botCount > 0
    ? `<b>${humans.length}</b>/${max} players — <b>${botCount}</b> bot team${botCount > 1 ? "s" : ""} will fill the rest.`
    : `Full lobby — no bots needed.`;
  const bots = state.botTeams.slice(0, botCount);
  $("botList").innerHTML = bots.map((t, i) =>
    `<li><span class="rank">${i + 1}</span> 🤖 ${escapeHtml(t.name)} <span class="bovr">OVR ${t.ovr}</span></li>`
  ).join("");
  $("botPanel").classList.toggle("hidden", botCount === 0 || !csvReady);

  // controls
  const startBtn = $("startBtn");
  const readyBtn = $("readyBtn");
  const me = humans.find((p) => p.id === PLAYER_ID);
  const nonHostHumans = humans.filter((p) => !p.is_host);
  const allReady = nonHostHumans.every((p) => p.status === "ready");

  if (state.isHost) {
    startBtn.classList.remove("hidden");
    readyBtn.classList.add("hidden");
    const canStart = humans.length >= 2 && allReady;
    startBtn.disabled = !canStart;
    startBtn.textContent = humans.length < 2 ? "Need 2+ players" : (allReady ? "Start Draft" : "Waiting for players to ready up");
    $("waitMsg").classList.add("hidden");
  } else {
    startBtn.classList.add("hidden");
    readyBtn.classList.remove("hidden");
    const ready = me && me.status === "ready";
    readyBtn.className = "btn " + (ready ? "accent" : "ghost");
    readyBtn.textContent = ready ? "✓ Ready — tap to unready" : "I'm Ready";
    $("waitMsg").classList.remove("hidden");
    $("waitMsg").textContent = "Waiting for the host to start the draft…";
  }
}

// ready toggle
$("readyBtn").onclick = async () => {
  const me = state.players.find((p) => p.id === PLAYER_ID);
  const next = me && me.status === "ready" ? "waiting" : "ready";
  await supa.from("players").update({ status: next }).eq("id", PLAYER_ID).eq("room_id", state.room.id);
};

// host: start draft -> insert bots, set room status, countdown
$("startBtn").onclick = async () => {
  if (!state.isHost || !state.room) return;
  $("startBtn").disabled = true;
  const code = state.room.id;
  const max = state.room.settings?.max_players || 10;
  const humans = state.players.filter((p) => !p.is_bot);
  const botCount = Math.max(0, max - humans.length);
  const bots = state.botTeams.slice(0, botCount);

  try {
    if (bots.length) {
      const rows = bots.map((t) => ({
        id: "bot_" + uid(), room_id: code, username: t.name,
        is_host: false, is_bot: true, bot_team: t.name, status: "ready", xi: null,
      }));
      await supa.from("players").insert(rows);
    }
    await supa.from("rooms").update({ status: "drafting" }).eq("id", code);
    // realtime will fire the redirect for everyone (incl. host)
  } catch (e) {
    $("waitErr").textContent = e.message || "Could not start.";
    $("startBtn").disabled = false;
  }
};

let redirecting = false;
function gotoDraft(code) {
  if (redirecting) return;
  redirecting = true;
  // 3-2-1 countdown overlay, then redirect
  const ov = document.createElement("div");
  ov.className = "countdown";
  document.body.appendChild(ov);
  let n = 3;
  const tick = () => {
    ov.innerHTML = `<div class="num">${n}</div>`;
    if (n-- > 0) setTimeout(tick, 1000);
    else location.href = `draft-mp.html?room=${code}`;
  };
  tick();
}

// leave
$("leaveBtn").onclick = async () => {
  if (state.room && supa) {
    try { await supa.from("players").delete().eq("id", PLAYER_ID).eq("room_id", state.room.id); } catch (_) {}
    if (state.channel) supa.removeChannel(state.channel);
  }
  localStorage.removeItem("mp_room");
  location.href = "index.html";
};

// ---------- util ----------
function escapeHtml(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ===================== boot =====================
(async function boot() {
  await loadBotTeams();
  // deep link: ?room=CODE -> prefill join
  const params = new URLSearchParams(location.search);
  const roomParam = (params.get("room") || "").toUpperCase();
  if (roomParam) {
    show("join");
    $("joinCode").value = roomParam;
    const savedName = localStorage.getItem("mp_name");
    if (savedName) $("joinName").value = savedName;
  }
})();
