// ===================== 16-0 — Auction lobby =====================
// Mirrors lobby.js (create / join / waiting room) but for auction rooms.
// Auction rooms live in the SAME `rooms` + `players` tables as league rooms,
// tagged with settings.mode = "auction", so the finished squads flow into the
// existing simulation without any changes there.

const supa = (typeof initSupabase === "function" && initSupabase()) ||
  (typeof supabaseClient !== "undefined" ? supabaseClient : null);

// ---------- identity ----------
function uid() {
  return "p_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
let PLAYER_ID = sessionStorage.getItem("mp_pid");
if (!PLAYER_ID) { PLAYER_ID = uid(); sessionStorage.setItem("mp_pid", PLAYER_ID); }

const MAX_MANAGERS = 10;

const state = {
  room: null,
  players: [],
  isHost: false,
  poll: null,
  channel: null,
  createOpts: { clock: "brisk", ratings: "career", era: "all" },
};

const $ = (id) => document.getElementById(id);
const views = {
  chooser: $("view-chooser"),
  create: $("view-create"),
  join: $("view-join"),
  waiting: $("view-waiting"),
};
function show(view) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle("hidden", k !== view));
}
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}
function escapeHtml(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function initialOf(name) {
  const s = String(name || "?").trim();
  return (s[0] || "?").toUpperCase();
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
function genCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
function requireSupa() {
  if (!supa) { alert("Auction mode needs the database configured (supabase_config.js)."); return false; }
  return true;
}

// ---------- pool preview for the lobby ----------
// Same two CSVs and same builder the room uses, so the preview cannot promise
// an auction different from the one that actually runs.
let poolCache = null;
function parseCsv(path) {
  return new Promise((resolve) => {
    Papa.parse(path, {
      download: true, header: true, skipEmptyLines: true,
      complete: (res) => resolve(res.data || []),
      error: () => resolve([]),
    });
  });
}
async function loadPool() {
  if (poolCache) return poolCache;
  const [aucRaw, masRaw] = await Promise.all([
    parseCsv("ipl_auction_career_final.csv"),
    parseCsv("ipl_master_calibrated.csv"),
  ]);
  poolCache = {
    auc: aucRaw.filter((r) => r.Player_Name).map(AuctionData.normalizeAuctionRow),
    mas: masRaw.filter((r) => r.Player_Name && r.Season).map(AuctionData.normalizeMasterRow),
  };
  return poolCache;
}

// ---------- create ----------
$("goCreate").onclick = () => show("create");
$("goJoin").onclick = () => show("join");
$("createBack").onclick = () => show("chooser");
$("joinBack").onclick = () => show("chooser");

document.querySelectorAll(".options[data-key]").forEach((grp) => {
  const key = grp.dataset.key;
  grp.querySelectorAll(".opt").forEach((b) => {
    b.onclick = () => {
      grp.querySelectorAll(".opt").forEach((x) => x.classList.remove("is-selected"));
      b.classList.add("is-selected");
      state.createOpts[key] = b.dataset.v;
    };
  });
});

$("createBtn").onclick = async () => {
  if (!requireSupa()) return;
  const name = ($("roomName").value || "").trim() || "16-0 Auction";
  $("createErr").textContent = "";
  $("createBtn").disabled = true;
  $("createBtn").innerHTML = '<span class="spin"></span>';
  try {
    let code, ok = false, tries = 0;
    while (!ok && tries < 6) {
      code = genCode();
      const { error } = await supa.from("rooms").insert({
        id: code,
        name,
        host_id: PLAYER_ID,
        status: "waiting",
        settings: {
          mode: "auction",
          clock: state.createOpts.clock,
          ratings: state.createOpts.ratings,
          era: state.createOpts.era,
          difficulty: "normal",
          max_players: MAX_MANAGERS,
        },
      });
      if (!error) ok = true;
      else if (error.code === "23505") { tries++; continue; }
      else throw error;
    }
    if (!ok) throw new Error("Could not generate a free room code, try again.");

    const hostName = (($("hostName").value || "").trim() || localStorage.getItem("mp_name") || "Host").slice(0, 18);
    localStorage.setItem("mp_name", hostName);
    await supa.from("players").upsert({
      id: PLAYER_ID, room_id: code, username: hostName,
      is_host: true, is_bot: false, status: "waiting", xi: null,
    });
    enterRoom(code, true);
  } catch (e) {
    $("createErr").textContent = e.message || "Failed to create auction.";
    $("createBtn").disabled = false;
    $("createBtn").textContent = "Create Auction";
  }
};

// ---------- join ----------
$("joinCode").addEventListener("input", (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

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
    if ((room.settings || {}).mode !== "auction") throw new Error("That code is a league room, not an auction.");
    if (room.status !== "waiting") throw new Error("That auction has already started.");

    const { data: existing } = await supa.from("players").select("id,is_bot").eq("room_id", code);
    const humans = (existing || []).filter((p) => !p.is_bot);
    if (!humans.find((p) => p.id === PLAYER_ID) && humans.length >= MAX_MANAGERS) {
      throw new Error("Auction is full.");
    }
    await supa.from("players").upsert({
      id: PLAYER_ID, room_id: code, username: name.slice(0, 18),
      is_host: room.host_id === PLAYER_ID, is_bot: false, status: "waiting", xi: null,
    });
    enterRoom(code, room.host_id === PLAYER_ID);
  } catch (e) {
    $("joinErr").textContent = e.message || "Could not join.";
    $("joinBtn").disabled = false;
    $("joinBtn").textContent = "Join Auction";
  }
};

// ---------- waiting room ----------
async function enterRoom(code, isHost) {
  state.isHost = isHost;
  localStorage.setItem("mp_room", code);
  show("waiting");
  $("wCode").textContent = code;

  await refresh(code);
  subscribe(code);
  render();

  $("wCode").onclick = () => { navigator.clipboard?.writeText(code); toast("Room code copied"); };
  $("shareLink").onclick = (e) => {
    e.preventDefault();
    navigator.clipboard?.writeText(`${location.origin}/auction.html?room=${code}`);
    toast("Invite link copied");
  };

  clearInterval(state.poll);
  state.poll = setInterval(async () => { await refresh(code); render(); }, 2500);
}

async function refresh(code) {
  const [r, p] = await Promise.all([
    supa.from("rooms").select("*").eq("id", code).single(),
    supa.from("players").select("*").eq("room_id", code).order("joined_at", { ascending: true }),
  ]);
  if (r.data) state.room = r.data;
  if (p.data) state.players = p.data;
  if (state.room && state.room.status === "auction") gotoRoom(code);
}

function subscribe(code) {
  if (state.channel) supa.removeChannel(state.channel);
  const ch = supa.channel("auctionlobby:" + code);
  ch.on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `room_id=eq.${code}` },
    async () => { await refresh(code); render(); });
  ch.on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${code}` },
    (pl) => { if (pl.new) { state.room = pl.new; if (pl.new.status === "auction") gotoRoom(code); } render(); });
  ch.subscribe();
  state.channel = ch;
}

async function render() {
  if (!state.room) return;
  const humans = state.players.filter((p) => !p.is_bot);
  $("wRoomName").textContent = state.room.name || "Auction Room";
  $("wCount").textContent = `${humans.length}/${MAX_MANAGERS}`;
  $("wSub").textContent = humans.length < 2
    ? "At least 2 managers needed to start."
    : `${humans.length} managers ready to bid.`;

  $("wPlayers").innerHTML = humans.map((p) => {
    const host = p.id === state.room.host_id;
    return `<li>
      <span class="ava${host ? " host" : ""}">${escapeHtml(initialOf(p.username))}</span>
      <span class="pname">${escapeHtml(p.username || "Manager")}${p.id === PLAYER_ID ? " (you)" : ""}</span>
      ${host ? '<span class="ptag host">Host</span>' : ""}
      <span class="dot"></span>
    </li>`;
  }).join("");

  // Preview the actual auction that will run.
  const { auc, mas } = await loadPool();
  if (auc.length && typeof AuctionData !== "undefined") {
    const pool = AuctionData.buildCuratedPool(auc, mas, { teams: Math.max(2, humans.length) });
    $("wPreview").innerHTML = pool.sets.map((set, i) =>
      `<li><span class="rank">${i + 1}</span><span class="bname">${escapeHtml(set.label)}</span>
        <span class="bovr">${set.got} lots</span></li>`
    ).join("") +
      `<li><span class="rank"></span><span class="bname"><b>Total</b></span>
        <span class="bovr">${pool.lots.length} lots</span></li>`;
  }

  const canStart = state.isHost && humans.length >= 2;
  $("startBtn").classList.toggle("hidden", !state.isHost);
  $("startBtn").disabled = !canStart;
  $("startBtn").textContent = canStart ? "Start Auction" : "Need 2+ managers";
  $("waitMsg").classList.toggle("hidden", state.isHost);
}

$("startBtn").onclick = async () => {
  if (!state.room) return;
  $("startBtn").disabled = true;
  $("startBtn").innerHTML = '<span class="spin"></span>';
  try {
    const humans = state.players.filter((p) => !p.is_bot);
    // Seed every manager's purse, then open the auction.
    await supa.from("players")
      .update({ purse: AuctionData.PURSE, xi: [] })
      .eq("room_id", state.room.id);
    await supa.from("auction_state").upsert({
      room_id: state.room.id,
      lot_index: 0, price: null, high_bidder: null, ends_at: null,
      status: "live", skip_votes: [],
    });
    await supa.from("rooms").update({
      status: "auction",
      settings: { ...(state.room.settings || {}), teams: humans.length },
    }).eq("id", state.room.id);
  } catch (e) {
    $("waitErr").textContent = e.message || "Could not start. Has mp_auction.sql been run?";
    $("startBtn").disabled = false;
    $("startBtn").textContent = "Start Auction";
  }
};

let redirecting = false;
function gotoRoom(code) {
  if (redirecting) return;
  redirecting = true;
  clearInterval(state.poll);
  const ov = document.createElement("div");
  ov.className = "countdown";
  document.body.appendChild(ov);
  let n = 3;
  (function tick() {
    ov.innerHTML = `<div class="num">${n}</div>`;
    if (n-- > 0) setTimeout(tick, 1000);
    else location.href = `auction-room.html?room=${code}`;
  })();
}

$("leaveBtn").onclick = async () => {
  clearInterval(state.poll);
  if (state.room && supa) {
    try { await supa.from("players").delete().eq("id", PLAYER_ID).eq("room_id", state.room.id); } catch (_) {}
    if (state.channel) supa.removeChannel(state.channel);
  }
  localStorage.removeItem("mp_room");
  location.href = "index.html";
};

// Deep link: /auction.html?room=CODE prefills the join screen.
(function boot() {
  const code = new URLSearchParams(location.search).get("room");
  if (code) {
    show("join");
    $("joinCode").value = code.toUpperCase();
    $("joinName").value = localStorage.getItem("mp_name") || "";
  }
})();
