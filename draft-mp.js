// ===================== 16-0 — Phase 2: draft (real data) =====================
// Loads the real CSV, spins a tier-weighted franchise+season (slot-machine
// style), shows that squad, one pick per spin, drag to reorder the XI.

// ---------- config from the setup screen ----------
const DEFAULT_CONFIG = {
  difficulty: "normal",
  showRatings: "on",
  playerRatings: "career",
  eraFrom: 2008,
  eraTo: 2026,
};
function loadConfig() {
  try {
    const raw = localStorage.getItem("draftConfig");
    return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
  } catch (_) {
    return { ...DEFAULT_CONFIG };
  }
}
// ---------- multiplayer identity (config arrives from the room, set in init) ----------
const MP_SUPA = (typeof initSupabase === "function" && initSupabase()) || (typeof supabaseClient !== "undefined" ? supabaseClient : null);
const MP_PID = sessionStorage.getItem("mp_pid");
const MP_ROOM = new URLSearchParams(location.search).get("room");
const MP = !!MP_ROOM;
if (MP && (!MP_SUPA || !MP_PID)) { location.href = "lobby.html"; }

let config = { ...DEFAULT_CONFIG };
if (!MP) { config = loadConfig(); if (config.difficulty === "hard") config.showRatings = "off"; }

const DIFFICULTY = {
  easy: { respins: 3, enforceWk: false, label: "Easy" },
  normal: { respins: 1, enforceWk: true, label: "Normal" },
  hard: { respins: 0, enforceWk: true, label: "Hard" },
};
let diff = DIFFICULTY[config.difficulty] || DIFFICULTY.normal;
let isPrime = config.playerRatings === "prime";

// If the previous season was completed, clear it so we start a new draft
try {
  const saved = JSON.parse(localStorage.getItem("seasonState") || "null");
  if (saved && saved.completed) {
    localStorage.removeItem("seasonState");
  }
} catch (_) {}


// ---------- XI structure ----------
// 11 batting positions. Bands drive auto-placement; drag can override order.
const SLOT_LABELS = [
  "Opener", "Opener",
  "Opener / Middle Order", "Middle Order", "Middle Order", "Middle Order",
  "Middle Order / Finisher",
  "Bowler / Finisher", "Bowler", "Bowler", "Bowler",
];
// Slots (0-indexed): 0,1 Opener · 2 Opener/Mid · 3,4,5 Mid · 6 Finisher · 7-10 Bowler.
// Batting_Order decides WHERE a player bats. Primary_Role only confines specialist
// bowlers — never blocks a batsman/all-rounder from a batting slot.
// Returns eligible slots in auto-placement preference order.
function eligibleSlots(p) {
  let slots;
  if (p.primaryRole === "Bowler") {
    slots = [7, 8, 9, 10]; // specialist bowler: slots 8-11
  } else {
    switch (p.battingOrder) {
      case "Opener": slots = [0, 1, 2]; break; // slots 1,2,3
      case "Middle Order": slots = [2, 3, 4, 5]; break; // slots 3-6
      case "Finisher": slots = [6, 5, 4]; break; // slots 5-7 (prefer 7)
      case "Lower Order": slots = [7, 8, 9, 10, 6]; break; // slots 7-11
      default: slots = [2, 3, 4, 5, 6, 7, 8, 9, 10];
    }
  }
  // Slot 7 (index 6) is the flexible Finisher/WK slot — see canFillSlot7.
  const has6 = slots.includes(6);
  if (canFillSlot7(p) && !has6) slots = [...slots, 6];
  else if (!canFillSlot7(p) && has6) slots = slots.filter((s) => s !== 6);
  return slots;
}

// Slot 7 (index 6): allow finishers, keepers, middle-order bats, and
// all-rounders. Block only openers and pure tail-enders (specialist bowlers
// who bat lower order).
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

function displayRole(p) {
  return p.battingOrder; // Opener / Middle Order / Finisher / Lower Order
}

function roleBadgeClass(p) {
  switch (p.battingOrder) {
    case "Opener": return "role-opener";
    case "Middle Order": return "role-middle";
    case "Finisher": return "role-finisher";
    case "Lower Order": return "role-lower";
    default: return "";
  }
}

// The role that actually drives slot eligibility (for accurate toasts).
function slotRole(p) {
  return p.primaryRole === "Bowler" ? "Bowler" : p.battingOrder;
}

function wrongPosToast(p) {
  const role = slotRole(p);
  const article = /^[aeiou]/i.test(role) ? "an" : "a";
  showToast(`Wrong position — ${playerLabel(p)} is ${article} ${role}, can't bat here`, "error");
}

// ---------- white card icons (PNG line-art from pngs/) ----------
// onerror hides any icon whose file hasn't been added yet (no broken glyphs).
const icon = (src, className = "") =>
  `<img class="ic${className ? ` ${className}` : ""}" src="pngs/${src}" alt="" onerror="this.style.display='none'" />`;
const IC_BAT = icon("bat.png");
const IC_BALL = icon("ball.png");
const IC_ALLROUND = icon("batandball.png", "ic-allround");
const IC_PLANE = icon("plane.png", "ic-plane");

// discipline icon from Primary_Role
function disciplineIcons(p) {
  if (p.primaryRole === "Bowler") return IC_BALL;
  if (p.primaryRole === "All-Rounder") return IC_ALLROUND;
  return IC_BAT; // Batsman / Wicketkeeper
}

// ---------- state ----------
const xi = new Array(SLOT_LABELS.length).fill(null);
let allPlayers = [];
let byTeamSeason = new Map(); // "FR|SEASON" -> [player]
let seasonsByFranchise = {}; // FR -> [season strings]
let fullNames = {}; // FR -> Franchise_Full
let mappedNames = {}; // Master_DB_Name -> Impact_CSV_Name
let franchises = [];
let teamStrength = {}; // "FR|SEASON" -> mean of top-5 OVR (the draftable stars)
let spinPool = [];    // flat array of { fr, season, avgOVR } for pickTeam

// Dynamic Probability Engine ("Gambler's Curve"). Reset on each fresh draft page.
const spinState = {
  tier1Hits: 0,
  tier2Hits: 0,
  spinNumber: 0,
};

let pendingSquad = null; // squad currently shown, not yet drafted from
let currentTeam = null; // { fr, season }
let respinsLeft = diff.respins;
let spinning = false;
let dragFrom = null;
// Captain is tracked by player identity (name|fr|season) so the (C) follows the
// player even when slots are dragged around.
let captainKey = null;
let captainMode = false; // true while the user is tapping a player to make captain
const playerKey = (p) => `${p.name}|${p.fr}|${p.season}`;
const captainOf = () => xi.find((p) => p && playerKey(p) === captainKey) || null;

// Era-correct franchise naming: `fr` is the current short code, but a few clubs
// rebranded mid-history. Show the name the club actually used that season.
function eraAbbr(fr, season) {
  const y = +season || 0;
  if (fr === "PBKS") return y <= 2020 ? "KXIP" : "PBKS"; // Kings XI Punjab -> Punjab Kings (2021)
  if (fr === "DC") return y <= 2018 ? "DD" : "DC";        // Delhi Daredevils -> Delhi Capitals (2019)
  return fr;
}
function eraFull(fr, season) {
  const y = +season || 0;
  if (fr === "PBKS") return y <= 2020 ? "Kings XI Punjab" : "Punjab Kings";
  if (fr === "DC") return y <= 2018 ? "Delhi Daredevils" : "Delhi Capitals";
  if (fr === "RCB") return y <= 2023 ? "Royal Challengers Bangalore" : "Royal Challengers Bengaluru";
  return null;
}

// ---------- elements ----------
const spinBtn = document.getElementById("spinBtn");
const rerollBtn = document.getElementById("rerollBtn");
const reelClub = document.getElementById("reelClub");
const reelSeason = document.getElementById("reelSeason");
const spinMeta = document.getElementById("spinMeta");
const squadGrid = document.getElementById("squadGrid");
const xiSlotsEl = document.getElementById("xiSlots");
const pickCountEl = document.getElementById("pickCount");
const overseasCountEl = document.getElementById("overseasCount");
const completeBtn = document.getElementById("completeBtn");
const rulesBar = document.getElementById("rulesBar");
const body = document.body;

// ---------- helpers ----------
function tierClass(ovr) {
  if (ovr >= 92) return "ovr-gold";
  if (ovr >= 89) return "ovr-blue";
  if (ovr >= 85) return "ovr-green";
  return "ovr-white";
}
function ovrOf(p) {
  return p.ovr;
}
function keyStat(p) {
  return p.primaryRole === "Bowler" ? `${p.wkts} wkts` : `${p.runs} runs`;
}
function ratingStats(p) {
  if (p.primaryRole === "Bowler") {
    return `<span class="rat"><b>BWL</b> ${p.bowl}</span>`;
  }
  if (p.primaryRole === "All-Rounder") {
    return `
        <span class="rat"><b>BAT</b> ${p.bat}</span>
        <span class="rat"><b>BWL</b> ${p.bowl}</span>
    `;
  }
  return `<span class="rat"><b>BAT</b> ${p.bat}</span>`;
}
function playerLabel(p) {
  return p.displayName || p.name;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}
function inXi(name) {
  return xi.some((p) => p && p.name === name);
}
function overseasCount() {
  return xi.filter((p) => p && p.isOverseas).length;
}

const MAX_OVERSEAS = 4;

// Check if we are in the "danger zone" (exactly 1 empty slot in the top 7, and no wicketkeeper has been selected yet)
function getDangerWkSlot() {
  if (!diff.enforceWk) return null;
  const top7 = xi.slice(0, 7);
  if (top7.some((p) => p && p.isWk)) return null;

  const emptyTop7 = [];
  for (let i = 0; i < 7; i++) if (xi[i] === null) emptyTop7.push(i);
  return emptyTop7.length === 1 ? emptyTop7[0] : null;
}

// The slot a player would actually take, honouring the reserved keeper slot:
// non-keepers may not occupy the reserved slot.
function slotFor(p) {
  const reserved = getDangerWkSlot() ?? -1;
  return eligibleSlots(p).find(
    (i) => xi[i] === null && (p.isWk || i !== reserved)
  );
}

// Can this player be drafted into the current XI right now?
function canDraft(p) {
  if (inXi(p.name)) return false;
  if (p.isOverseas && overseasCount() >= MAX_OVERSEAS) return false;

  const dangerSlot = getDangerWkSlot();
  if (dangerSlot !== null) {
    // If we absolutely need a WK in the top 7, we can ONLY draft this player if:
    // 1. They are a WK, OR
    // 2. They can be placed in the lower order (slots 8-11)
    if (!p.isWk) {
      const validLowerSlots = [7, 8, 9, 10].filter((i) => xi[i] === null && eligibleSlots(p).includes(i));
      if (validLowerSlots.length === 0) return false;
    }
  }

  return slotFor(p) !== undefined;
}

let toastTimer;
function showToast(message, kind = "") {
  const toast = document.querySelector(".toast");
  toast.textContent = message;
  toast.className = "toast is-visible" + (kind ? ` is-${kind}` : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

// ---------- load CSVs ----------
function loadCsv(path) {
  return new Promise((resolve, reject) => {
    Papa.parse(path, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (res) => resolve(res.data),
      error: reject,
    });
  });
}

// ---------- init ----------
// Solo: config is already loaded from localStorage. Multiplayer: pull the room's
// settings from Supabase FIRST (so prime-boost / era / difficulty are correct
// before buildData), then load the CSV and start.
(async function init() {
  try {
    if (MP) {
      const { data: room } = await MP_SUPA.from("rooms").select("*").eq("id", MP_ROOM).single();
      if (!room) { location.href = "lobby.html"; return; }
      const s = room.settings || {};
      config.difficulty = s.difficulty || "normal";
      config.showRatings = config.difficulty === "hard" ? "off" : "on";
      config.playerRatings = s.ratings || "career";
      config.eraFrom = s.era && s.era !== "all" ? +s.era : 2008;
      config.eraTo = 2026;
      const { data: meRow } = await MP_SUPA.from("players").select("*").eq("id", MP_PID).eq("room_id", MP_ROOM).single();
      config.teamName = (meRow && meRow.username) || "Your XI";
      diff = DIFFICULTY[config.difficulty] || DIFFICULTY.normal;
      isPrime = config.playerRatings === "prime";
      respinsLeft = diff.respins;
      window.__mpRoom = room;
    }
    const [playerRows, nameRows] = await Promise.all([
      loadCsv("ipl_master_calibrated.csv"),
      loadCsv("mapped_names.csv").catch(() => []),
    ]);
    buildNameMap(nameRows);
    buildData(playerRows);
    initUI();
    if (MP) mpStart();
  } catch (err) {
    spinMeta.textContent = "Could not load data — run via a local server.";
    console.error(err);
  }
})();

function buildNameMap(rows) {
  mappedNames = {};
  rows.forEach((r) => {
    const masterName = (r.Master_DB_Name || "").trim();
    const displayName = (r.Impact_CSV_Name || "").trim();
    if (masterName && displayName) mappedNames[masterName] = displayName;
  });
}

function buildData(rows) {
  allPlayers = rows
    .filter((r) => r.Player_Name && r.Franchise && r.Season)
    .map((r) => ({
      name: r.Player_Name,
      displayName: mappedNames[(r.Player_Name || "").trim()] || r.Player_Name,
      season: r.Season,
      origSeason: r.Season,
      fr: r.Franchise,
      frFull: r.Franchise_Full || r.Franchise,
      primaryRole: r.Primary_Role,
      battingOrder: r.Batting_Order,
      isWk: r.Is_Wicketkeeper === "1",
      isOverseas: r.Nationality === "Overseas",
      matches: +r.Matches_Played || 0,
      runs: +r.Batting_Runs || 0,
      sr: +r.Batting_Strike_Rate || 0,
      wkts: +r.Bowling_Wickets || 0,
      econ: +r.Bowling_Economy || 0,
      ovr: +r.OVR || 0,
      bat: +r.Bat_Rat || 0,
      bowl: +r.Bowl_Rat || 0,
    }));

  const primeObjByName = {};
  for (const p of allPlayers) {
    const prev = primeObjByName[p.name];
    if (!prev || p.ovr > prev.ovr) {
      primeObjByName[p.name] = p;
    }
  }

  for (const p of allPlayers) {
    const key = `${p.fr}|${p.season}`;
    if (!byTeamSeason.has(key)) byTeamSeason.set(key, []);
    byTeamSeason.get(key).push(p);
    fullNames[p.fr] = p.frFull;
  }

  if (isPrime) {
    for (const p of allPlayers) {
      const prime = primeObjByName[p.name];
      if (prime) {
        p.ovr = prime.ovr;
        p.bat = prime.bat;
        p.bowl = prime.bowl;
        p.runs = prime.runs;
        p.wkts = prime.wkts;
        p.sr = prime.sr;
        p.econ = prime.econ;
        p.matches = prime.matches;
        p.season = prime.season;
      }
    }
  }

  // seasons per franchise where the squad can field an XI (>= 11 players)
  const seasonsSet = {};
  for (const [key, squad] of byTeamSeason) {
    if (squad.length < 11) continue;
    const [fr, season] = key.split("|");
    (seasonsSet[fr] = seasonsSet[fr] || new Set()).add(season);
  }
  for (const fr of Object.keys(seasonsSet)) {
    seasonsByFranchise[fr] = [...seasonsSet[fr]].sort();
  }
  franchises = Object.keys(seasonsByFranchise);

  // squad strength = mean of the top-5 OVRs (the draftable stars)
  for (const [key, squad] of byTeamSeason) {
    if (squad.length < 11) continue;
    const top = squad
      .map((p) => p.ovr)
      .sort((a, b) => b - a)
      .slice(0, 5);
    teamStrength[key] = top.reduce((a, b) => a + b, 0) / top.length;
  }
  // Build spin pool: one entry per franchise-season. Dynamic tier weights are
  // applied at spin time so previous elite/strong hits can throttle future odds.
  spinPool = [];
  for (const [key, avgOVR] of Object.entries(teamStrength)) {
    const [fr, season] = key.split("|");
    spinPool.push({ fr, season, avgOVR });
  }
}

// ---------- rules bar ----------
function renderRulesBar() {
  const chips = [
    diff.label,
    config.showRatings === "on" ? "Ratings On" : "Blind Draft",
    isPrime ? "Prime Mode" : "Career Seasons",
    `Era ${config.eraFrom}–${config.eraTo}`,
  ];
  rulesBar.innerHTML = chips
    .map((c) => `<span class="rule-chip">${c}</span>`)
    .join("");
}

function updateSpinMeta(text) {
  if (text) {
    spinMeta.textContent = text;
    return;
  }
  const picked = xi.filter(Boolean).length;
  if (picked >= SLOT_LABELS.length) {
    spinMeta.textContent = "XI complete — drag to reorder, then finish";
  } else if (pendingSquad) {
    spinMeta.textContent = "Pick one player, or reroll for a new club";
  } else {
    spinMeta.textContent = "Spin for your next pick";
  }
}

// Show Spin before a squad, Reroll (with count) once a squad is on screen.
function updateControls() {
  const picked = xi.filter(Boolean).length;
  const full = picked >= SLOT_LABELS.length;

  if (full) {
    spinBtn.hidden = true;
    rerollBtn.hidden = true;
    return;
  }

  if (pendingSquad) {
    spinBtn.hidden = true;
    rerollBtn.hidden = false;
    if (respinsLeft <= 0) {
      rerollBtn.disabled = true;
      rerollBtn.innerHTML = "No rerolls left";
    } else {
      rerollBtn.disabled = false;
      rerollBtn.innerHTML = `Reroll · <span id="rerollLeft">${respinsLeft}</span> left`;
    }
  } else {
    spinBtn.hidden = false;
    rerollBtn.hidden = true;
  }
}

// ---------- dynamic probability franchise+season pick ----------
function getTeamTier(avgOVR) {
  if (avgOVR >= 84) return 1;
  if (avgOVR >= 81) return 2;
  return 3;
}

function getSpinWeights(state) {
  let w1 = 42, w2 = 33, w3 = 25;

  const t1Penalty = Math.max(0, state.tier1Hits - 1) * 5;
  w1 = Math.max(30, w1 - t1Penalty);

  const t2Penalty = Math.max(0, state.tier2Hits - 2) * 2;
  w2 = Math.max(26, w2 - t2Penalty);

  const lost = t1Penalty + t2Penalty;
  w3 += lost;

  return { w1, w2, w3 };
}

function tierWeight(tier, weights) {
  if (tier === 1) return weights.w1;
  if (tier === 2) return weights.w2;
  return weights.w3;
}

function weightedPick(items, weightOf) {
  const total = items.reduce((a, it) => a + weightOf(it), 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= weightOf(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

function pickTeam(forceWk = false) {
  const from = config.eraFrom;
  const to = config.eraTo;

  let valid = spinPool.filter((e) => {
    if (+e.season < from || +e.season > to) return false;
    const squad = byTeamSeason.get(`${e.fr}|${e.season}`) || [];
    return squad.some(p => canDraft(p) && (!forceWk || p.isWk));
  });

  if (!valid.length) {
    if (forceWk) showToast("Relaxing era filter to find a valid pick", "error");
    valid = spinPool.filter((e) => {
      const squad = byTeamSeason.get(`${e.fr}|${e.season}`) || [];
      return squad.some(p => canDraft(p) && (!forceWk || p.isWk));
    });
  }

  if (!valid.length) {
    valid = spinPool.filter((e) => {
      const squad = byTeamSeason.get(`${e.fr}|${e.season}`) || [];
      return squad.some(p => canDraft(p));
    });
  }

  if (!valid.length) return spinPool[Math.floor(Math.random() * spinPool.length)];

  const weights = getSpinWeights(spinState);
  const tierCounts = valid.reduce((counts, entry) => {
    const tier = getTeamTier(entry.avgOVR);
    counts[tier] = (counts[tier] || 0) + 1;
    return counts;
  }, {});

  const entry = weightedPick(valid, (e) => {
    const tier = getTeamTier(e.avgOVR);
    return tierWeight(tier, weights) / (tierCounts[tier] || 1);
  });

  const tier = getTeamTier(entry.avgOVR);
  if (tier === 1) spinState.tier1Hits++;
  if (tier === 2) spinState.tier2Hits++;
  spinState.spinNumber++;

  return { fr: entry.fr, season: entry.season };
}

// ---------- spin (slot-machine reels) ----------
// Shrink the text until the whole value fits on one line in the reel.
function fitReelText(item, box) {
  let size = parseFloat(getComputedStyle(item).fontSize);
  let guard = 0;
  while (item.scrollWidth > box.clientWidth && size > 9 && guard < 60) {
    size -= 1;
    item.style.fontSize = `${size}px`;
    guard += 1;
  }
}

// Render a single static value filling the reel window.
// If the text overflows, apply a slow horizontal marquee so it reads fully.
function setReel(box, value) {
  const h = box.clientHeight;
  const item = document.createElement("div");
  item.className = "reel-item";
  item.style.height = `${h}px`;
  item.textContent = value;
  box.innerHTML = "";
  box.appendChild(item);
  requestAnimationFrame(() => {
    const overflow = item.scrollWidth - box.clientWidth;
    if (overflow > 2) {
      item.style.setProperty("--scroll-dist", `-${overflow + 8}px`);
      item.classList.add("is-marquee");
    }
  });
}

// Build a tall strip of random values ending on finalValue, then scroll to it.
function rollReel(box, pool, finalValue, duration) {
  return new Promise((resolve) => {
    const itemH = box.clientHeight;
    const spinCount = 28;
    const values = [];
    for (let i = 0; i < spinCount; i++) {
      values.push(pool[Math.floor(Math.random() * pool.length)]);
    }
    values.push(finalValue);

    const strip = document.createElement("div");
    strip.className = "reel-strip";
    strip.innerHTML = values
      .map((v) => `<div class="reel-item" style="height:${itemH}px">${v}</div>`)
      .join("");
    box.innerHTML = "";
    box.appendChild(strip);

    const distance = itemH * (values.length - 1);
    // two frames so the browser registers the start position before transitioning
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        strip.style.transition = `transform ${duration}ms cubic-bezier(0.16, 0.85, 0.2, 1)`;
        strip.style.transform = `translateY(${-distance}px)`;
      });
    });

    setTimeout(() => {
      setReel(box, finalValue); // settle to a clean static value
      resolve();
    }, duration + 40);
  });
}

async function doSpin() {
  if (spinning) return;
  const picked = xi.filter(Boolean).length;
  if (picked >= SLOT_LABELS.length) {
    showToast("Your XI is already full", "error");
    return;
  }
  // re-spin only costs when rejecting a squad you haven't drafted from
  if (pendingSquad) {
    if (respinsLeft <= 0) {
      showToast(`No re-spins left (${diff.label})`, "error");
      return;
    }
    respinsLeft -= 1;
  }

  spinning = true;
  spinBtn.disabled = true;
  squadGrid.innerHTML = "";
  pendingSquad = null;
  reelClub.classList.remove("spent");
  reelSeason.classList.remove("spent");
  updateSpinMeta("Spinning…");

  const wkFilled = xi.slice(0, 7).some((p) => p && p.isWk);

  // After pick 8 with no WK yet — warn
  if (picked === 8 && !wkFilled && diff.enforceWk) {
    showToast("No wicketkeeper yet — pick one soon or you can't finish", "error");
  }

  let forceWk = false;
  if (picked >= 9 && !wkFilled && diff.enforceWk) {
    forceWk = true;
  }

  const target = pickTeam(forceWk);

  const clubPool2 = franchises.map((fr) => fullNames[fr]);
  const seasonPool2 = seasonsByFranchise[target.fr];

  await Promise.all([
    rollReel(reelClub, clubPool2, eraFull(target.fr, target.season) || fullNames[target.fr], 2200),
    rollReel(reelSeason, seasonPool2, target.season, 2900),
  ]);

  currentTeam = target;
  pendingSquad = (byTeamSeason.get(`${target.fr}|${target.season}`) || [])
    .slice()
    .sort((a, b) => ovrOf(b) - ovrOf(a));

  renderSquad();
  spinning = false;
  spinBtn.disabled = false;
  updateControls();
  updateSpinMeta();
}

spinBtn.addEventListener("click", doSpin);
rerollBtn.addEventListener("click", doSpin);

// ---------- squad render ----------
function renderSquad() {
  squadGrid.innerHTML = "";
  if (!pendingSquad) return;

  let pool = [...pendingSquad];

  // Shuffle the pool completely if blind mode is active
  if (config.showRatings === "off") {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
  }

  // pickable players first; unpickable ones greyed at the bottom.
  // Within those groups, preserve the randomized order when ratings are off.
  const ordered = pool.sort((a, b) => {
    const ca = canDraft(a);
    const cb = canDraft(b);
    if (ca !== cb) return ca ? -1 : 1;
    if (config.showRatings === "off") return 0; // maintain stable shuffled order
    return ovrOf(b) - ovrOf(a);
  });

  ordered.forEach((p) => {
    const ovr = ovrOf(p);
    const blocked = !canDraft(p);
    const name = escapeHtml(playerLabel(p));
    const card = document.createElement("button");
    card.type = "button";
    card.className = "player-card" + (blocked ? " is-blocked" : "");
    card.innerHTML = `
      <div class="card-top">
        <span class="card-name">${name}</span>
        <span class="ovr ${tierClass(ovr)}">${ovr}</span>
      </div>
      <div class="card-meta">
        <span class="role-badge ${roleBadgeClass(p)}">${displayRole(p)}</span>
        <span class="ic-group">${disciplineIcons(p)}${p.isOverseas ? IC_PLANE : ""}</span>
        ${p.isWk ? '<span class="wk-badge">WK</span>' : ""}
      </div>
      <div class="card-stats">
        ${ratingStats(p)}
        <span class="key-stat" style="margin-left:auto">${keyStat(p)}</span>
      </div>
    `;
    if (!blocked) card.addEventListener("click", () => draftPlayer(p));
    squadGrid.appendChild(card);
  });
}

// ---------- draft (one pick per spin) ----------
function draftPlayer(p) {
  if (!pendingSquad || !p) return;

  if (inXi(p.name)) {
    showToast(`${playerLabel(p)} is already in your XI`, "error");
    return;
  }
  if (p.isOverseas && overseasCount() >= MAX_OVERSEAS) {
    showToast(`Max ${MAX_OVERSEAS} overseas players in an XI`, "error");
    return;
  }

  const slot = slotFor(p);
    if (slot === undefined) {
      if (xi.every((x) => x !== null)) {
        showToast("Your XI is already full", "error");
      } else if (getDangerWkSlot() !== null && !p.isWk) {
        showToast("Last spot is reserved — pick a wicketkeeper", "error");
      } else {
        showToast(`No open ${slotRole(p)} position left`, "error");
      }
      return;
    }

  xi[slot] = p;
  // pick is locked in — one pick per team, clear the squad, must spin again
  pendingSquad = null;
  squadGrid.innerHTML = "";
  reelClub.classList.add("spent");
  reelSeason.classList.add("spent");

  renderXI();
  updateControls();
  updateSpinMeta();
  if (MP) mpAfterPick();
}

// ---------- XI sidebar + drag reorder ----------
function renderXI() {
  xiSlotsEl.innerHTML = "";

  SLOT_LABELS.forEach((label, i) => {
    const p = xi[i];
    const li = document.createElement("li");
    li.className = "xi-slot" + (p ? " is-filled" : "");
    li.dataset.idx = String(i);

    if (p) {
      const ovr = ovrOf(p);
      const name = escapeHtml(playerLabel(p));
      const origin = escapeHtml(`${eraAbbr(p.fr, p.season)} ${p.season}`);
      const isCap = captainKey === playerKey(p);
      // Disable dragging while picking a captain so a tap reliably registers as a
      // click on touch devices (draggable elements often swallow taps on mobile).
      li.draggable = !captainMode;
      li.innerHTML = `
        <span class="slot-num">${i + 1}</span>
        <span class="slot-body">
          <span class="slot-role">${label}</span>
          <span class="slot-player-row">
            <span class="slot-player">${name}${p.isWk ? " (wk)" : ""}${isCap ? ' <span class="cap-badge">(C)</span>' : ""}</span>
            <span class="slot-icons">${disciplineIcons(p)}${p.isOverseas ? IC_PLANE : ""}</span>
          </span>
          <span class="slot-origin">${origin}</span>
        </span>
        <span class="slot-ovr ${tierClass(ovr)}">${ovr}</span>
      `;
    } else {
      li.innerHTML = `
        <span class="slot-num">${i + 1}</span>
        <span class="slot-body">
          <span class="slot-role">${label}</span>
          <span class="slot-player" style="color:#5f5f5f">Empty</span>
        </span>
      `;
    }

    addDragHandlers(li, i);
    xiSlotsEl.appendChild(li);
  });

  const picks = xi.filter(Boolean);
  const picked = picks.length;
  pickCountEl.textContent = String(picked);
  overseasCountEl.textContent = String(overseasCount());

  const xiHint = document.getElementById("xiHint");
  if (xiHint) xiHint.hidden = picked < 1;
  completeBtn.hidden = picked !== SLOT_LABELS.length;
  updateCaptainBtn();

  const ovrDisplay = document.getElementById("xiOvrDisplay");
  if (picked > 0 && config.showRatings !== "off") {
    let bat, bowl, avg;
    if (picked === 11) {
      const wAvg = (vals, wts) => {
        const tw = wts.slice(0, vals.length).reduce((sum, w) => sum + w, 0);
        return vals.reduce((s, v, i) => s + v * wts[i], 0) / tw;
      };
      const topSix = xi.slice(0, 6);
      const bowlers = [...xi]
        .sort((a, b) => (b.bowl || b.ovr) - (a.bowl || a.ovr))
        .slice(0, 5);

      const batting = wAvg(topSix.map((p) => p.bat || p.ovr), [1.25, 1.18, 1.1, 1, 0.92, 0.85]);
      const bowling = wAvg(bowlers.map((p) => p.bowl || p.ovr), [1.22, 1.12, 1.04, 0.96, 0.88]);
      const depth = xi.slice(6).reduce((s, p) => s + p.ovr, 0) / 5;

      const pen = xi.reduce((sum, p, i) => {
        if (p.primaryRole === "Bowler" && i < 7) return sum + 7;
        if (p.battingOrder === "Opener" && i > 2) return sum + 3;
        if (p.battingOrder === "Lower Order" && i < 6) return sum + 3;
        return sum;
      }, 0);
      const chemistry = Math.max(55, 92 - pen);

      // Displayed OVR is the true team rating (no difficulty/mode handicap —
      // that's a sim-only knob, kept out of the visible rating).
      const total = batting * 0.46 + bowling * 0.42 + depth * 0.08 + chemistry * 0.04;

      bat = Math.round(batting);
      bowl = Math.round(bowling);
      avg = Math.round(total);
    } else {
      avg = Math.round(picks.reduce((a, p) => a + ovrOf(p), 0) / picked);
      const topBat = [...picks].sort((a, b) => (b.bat || b.ovr) - (a.bat || a.ovr)).slice(0, Math.min(6, picked));
      const topBowl = [...picks].sort((a, b) => (b.bowl || b.ovr) - (a.bowl || a.ovr)).slice(0, Math.min(5, picked));
      bat = Math.round(topBat.reduce((a, p) => a + (p.bat || p.ovr), 0) / topBat.length);
      bowl = Math.round(topBowl.reduce((a, p) => a + (p.bowl || p.ovr), 0) / topBowl.length);
    }

    const batVal = document.getElementById("xiBatVal");
    const bowlVal = document.getElementById("xiBowlVal");
    const ovrVal = document.getElementById("xiOvrVal");
    batVal.textContent = bat;   batVal.className = "xi-ovr-val " + tierClass(bat);
    bowlVal.textContent = bowl; bowlVal.className = "xi-ovr-val " + tierClass(bowl);
    ovrVal.textContent = avg;   ovrVal.className = "xi-ovr-val " + tierClass(avg);
    ovrDisplay.hidden = false;
  } else {
    ovrDisplay.hidden = true;
  }
}

function addDragHandlers(li, index) {
  li.addEventListener("dragstart", () => {
    dragFrom = index;
    li.classList.add("is-dragging");
  });
  li.addEventListener("dragend", () => {
    dragFrom = null;
    li.classList.remove("is-dragging");
    xiSlotsEl
      .querySelectorAll(".drag-over")
      .forEach((el) => el.classList.remove("drag-over"));
  });
  li.addEventListener("dragover", (e) => {
    if (dragFrom === null || dragFrom === index) return;
    e.preventDefault();
    li.classList.add("drag-over");
  });
  li.addEventListener("dragleave", () => li.classList.remove("drag-over"));
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    li.classList.remove("drag-over");
    if (dragFrom === null || dragFrom === index) return;

    const moving = xi[dragFrom];
    const displaced = xi[index]; // may be null (move into empty slot)

    // moved player must be allowed in the target slot
    if (!eligibleSlots(moving).includes(index)) {
      wrongPosToast(moving);
      return;
    }
    // on a swap, the displaced player must be allowed in the vacated slot
    if (displaced && !eligibleSlots(displaced).includes(dragFrom)) {
      wrongPosToast(displaced);
      return;
    }

    xi[index] = moving;
    xi[dragFrom] = displaced;
    renderXI();
    updateSpinMeta();
  });
}

// ---------- complete ----------
// ---------- captain ----------
const captainBtn = document.getElementById("captainBtn");

function updateCaptainBtn() {
  const picked = xi.filter(Boolean).length;
  captainBtn.hidden = picked === 0;
  const cap = captainOf();
  if (captainMode) {
    captainBtn.textContent = "Tap a player to make captain · Cancel";
    captainBtn.classList.add("is-picking");
  } else {
    captainBtn.classList.remove("is-picking");
    captainBtn.textContent = cap
      ? `(C) ${playerLabel(cap)} · Change`
      : "+ Appoint Captain";
  }
  xiSlotsEl.classList.toggle("captain-picking", captainMode);
}

captainBtn.addEventListener("click", () => {
  captainMode = !captainMode;
  renderXI();
});

// While in captain mode, tapping a filled slot makes that player captain.
xiSlotsEl.addEventListener("click", (e) => {
  if (!captainMode) return;
  const li = e.target.closest(".xi-slot.is-filled");
  if (!li) return;
  const p = xi[Number(li.dataset.idx)];
  if (!p) return;
  const key = playerKey(p);
  captainKey = captainKey === key ? null : key; // tap current captain again to clear
  captainMode = false;
  renderXI();
});

completeBtn.addEventListener("click", () => {
  if (diff.enforceWk) {
    const wkInTop7 = xi.slice(0, 7).some((p) => p && p.isWk);
    if (!wkInTop7) {
      showToast("Your XI needs a wicketkeeper in the top 7", "error");
      return;
    }
  }
  if (!captainOf()) {
    showToast("Appoint a captain before continuing", "error");
    if (!captainMode) {
      captainMode = true;
      renderXI();
    }
    return;
  }
  if (MP) { mpComplete(); return; }
  try {
    localStorage.setItem(
      "seasonState",
      JSON.stringify({
        config,
        xi: xi.map((p, slot) => ({
          ...p,
          slot,
          simOvr: ovrOf(p),
          isCaptain: captainKey === playerKey(p),
        })),
        createdAt: Date.now(),
      })
    );
  } catch (_) {
    showToast("Could not save XI for simulation", "error");
    return;
  }
  window.location.href = "simulation.html";
});

// Helper for testgreatestxi shortcut
function findGreatestXI() {
  const sorted = [...allPlayers].sort((a, b) => b.ovr - a.ovr);
  
  const slotCandidates = [];
  for (let slot = 0; slot < 11; slot++) {
    const cand = [];
    for (const p of sorted) {
      if (eligibleSlots(p).includes(slot)) {
        cand.push(p);
        if (cand.length >= 8) break;
      }
    }
    slotCandidates.push(cand);
  }

  const maxRemainingOvr = [];
  for (let slot = 0; slot < 11; slot++) {
    let sum = 0;
    for (let s = slot; s < 11; s++) {
      sum += slotCandidates[s][0].ovr;
    }
    maxRemainingOvr.push(sum);
  }
  maxRemainingOvr.push(0);

  let bestXi = null;
  let bestOvrSum = -1;

  // Find a baseline
  let baselineXi = [];
  let baselineNames = new Set();
  let baselineOverseas = 0;
  let baselineWk = 0;
  for (let slot = 0; slot < 11; slot++) {
    const p = slotCandidates[slot].find(cand => 
      !baselineNames.has(cand.name) &&
      (baselineOverseas + (cand.isOverseas ? 1 : 0) <= 4) &&
      (slot >= 7 || cand.isWk || baselineWk > 0 || slotCandidates.slice(slot + 1, 7).some(cList => cList.some(c => c.isWk && !baselineNames.has(c.name))))
    );
    if (p) {
      baselineXi.push(p);
      baselineNames.add(p.name);
      if (p.isOverseas) baselineOverseas++;
      if (p.isWk && slot < 7) baselineWk++;
    }
  }
  if (baselineXi.length === 11 && baselineWk > 0) {
    bestXi = baselineXi;
    bestOvrSum = baselineXi.reduce((sum, p) => sum + p.ovr, 0);
  }

  function search(slot, currentXi, usedNames, overseasCount, wkCount) {
    if (slot === 11) {
      if (wkCount === 0) return;
      const ovrSum = currentXi.reduce((sum, p) => sum + p.ovr, 0);
      if (ovrSum > bestOvrSum) {
        bestOvrSum = ovrSum;
        bestXi = [...currentXi];
      }
      return;
    }

    const currentSum = currentXi.slice(0, slot).reduce((sum, p) => sum + p.ovr, 0);
    if (currentSum + maxRemainingOvr[slot] <= bestOvrSum) {
      return;
    }

    const candidates = slotCandidates[slot];
    for (const p of candidates) {
      if (usedNames.has(p.name)) continue;
      
      const isO = p.isOverseas ? 1 : 0;
      if (overseasCount + isO > 4) continue;
      
      const isW = (p.isWk && slot < 7) ? 1 : 0;
      
      currentXi[slot] = p;
      usedNames.add(p.name);
      
      search(slot + 1, currentXi, usedNames, overseasCount + isO, wkCount + isW);
      
      usedNames.delete(p.name);
    }
  }

  search(0, new Array(11), new Set(), 0, 0);
  return bestXi;
}

// ---------- init ----------
function initUI() {
  if (config.showRatings === "off") body.classList.add("hide-ratings");
  const customName = (config.teamName || "").trim();
  if (!MP && customName.toLowerCase() === "testgreatestxi") {
    const greatestXI = findGreatestXI();
    if (greatestXI) {
      try {
        localStorage.setItem(
          "seasonState",
          JSON.stringify({
            config,
            xi: greatestXI.map((p, slot) => ({ ...p, slot, simOvr: ovrOf(p) })),
            createdAt: Date.now(),
          })
        );
      } catch (_) {}
      window.location.href = "simulation.html";
      return;
    }
  }
  if (!MP && customName.toLowerCase() === "csk2013test") {
    const cskNames = [
      "MEK Hussey",
      "M Vijay",
      "SK Raina",
      "S Badrinath",
      "MS Dhoni",
      "RA Jadeja",
      "JA Morkel",
      "DJ Bravo",
      "CH Morris",
      "R Ashwin",
      "MM Sharma"
    ];
    const cskPlayers = [];
    for (const name of cskNames) {
      const p = allPlayers.find(pl => pl.name === name && pl.origSeason === "2013" && pl.fr === "CSK");
      if (p) cskPlayers.push(p);
    }
    if (cskPlayers.length < 11) {
      const cskAll = allPlayers.filter(pl => pl.origSeason === "2013" && pl.fr === "CSK");
      cskPlayers.push(...cskAll.slice(0, 11 - cskPlayers.length));
    }
    try {
      localStorage.setItem(
        "seasonState",
        JSON.stringify({
          config,
          xi: cskPlayers.map((p, slot) => ({ ...p, slot, simOvr: ovrOf(p) })),
          createdAt: Date.now(),
        })
      );
    } catch (_) {}
    window.location.href = "simulation.html";
    return;
  }
  if (!MP && customName.toLowerCase() === "haaarcbxi") {
    const rcbNames = [
      "V Kohli",
      "CH Gayle",
      "KL Rahul",
      "AB de Villiers",
      "SR Watson",
      "SN Khan",
      "Sachin Baby",
      "STR Binny",
      "YS Chahal",
      "S Aravind",
      "CJ Jordan"
    ];
    const rcbPlayers = [];
    for (const name of rcbNames) {
      const p = allPlayers.find(pl => pl.name === name && pl.origSeason === "2016" && pl.fr === "RCB");
      if (p) rcbPlayers.push(p);
    }
    if (rcbPlayers.length < 11) {
      const rcbAll = allPlayers.filter(pl => pl.origSeason === "2016" && pl.fr === "RCB");
      rcbPlayers.push(...rcbAll.slice(0, 11 - rcbPlayers.length));
    }
    try {
      localStorage.setItem(
        "seasonState",
        JSON.stringify({
          config,
          xi: rcbPlayers.map((p, slot) => ({ ...p, slot, simOvr: ovrOf(p) })),
          createdAt: Date.now(),
        })
      );
    } catch (_) {}
    window.location.href = "simulation.html";
    return;
  }
  if (!MP && customName.toLowerCase() === "test") {
    const randomPlayers = [...allPlayers].sort(() => Math.random() - 0.5).slice(0, 11);
    try {
      localStorage.setItem(
        "seasonState",
        JSON.stringify({
          config,
          xi: randomPlayers.map((p, slot) => ({ ...p, slot, simOvr: ovrOf(p) })),
          createdAt: Date.now(),
        })
      );
    } catch (_) {}
    window.location.href = "simulation.html";
    return;
  }
  if (customName) {
    const titleEl = document.querySelector(".xi-title");
    if (titleEl) titleEl.textContent = customName;
  }
  setReel(reelClub, "—");
  setReel(reelSeason, "—");
  renderRulesBar();
  renderXI();
  updateControls();
  updateSpinMeta();
}

// ===================================================================
// ===================== MULTIPLAYER LEAGUE LAYER =====================
// Appended for draft-mp.html. Everything above is the faithful solo
// draft engine; below adds the per-pick timer, live save, host-driven
// bots, and the ready -> simulation handoff. No opponent picks shown.
// ===================================================================
let mpPlayers = [], mpFullToFr = {}, finishedMp = false;
let mpTimerIv = null, mpTimeLeft = 60, mpTransitioning = false, mpRedirecting = false;

function mpIsHost() { return window.__mpRoom && window.__mpRoom.host_id === MP_PID; }

async function mpStart() {
  for (const fr in fullNames) mpFullToFr[fullNames[fr]] = fr;
  await mpRefreshPlayers();
  mpSubscribe();
  resetTimer();
  // leave = delete my row, then go home
  const back = document.querySelector(".back-link");
  if (back) back.addEventListener("click", async (e) => {
    e.preventDefault();
    try { await MP_SUPA.from("players").delete().eq("id", MP_PID).eq("room_id", MP_ROOM); } catch (_) {}
    location.href = "index.html";
  });
  if (mpIsHost()) driveBots();

  // Polling fallback — realtime UPDATEs (ready/done) can be missed; keep the
  // waiting overlay and the host's transition check fresh.
  setInterval(async () => {
    await mpRefreshPlayers();
    if (finishedMp) renderWaitingOverlay();
    if (mpIsHost()) checkAllDone();
  }, 2500);
}

// ---------- per-pick timer ----------
function resetTimer() {
  if (finishedMp) return;
  clearInterval(mpTimerIv);
  mpTimeLeft = 60;
  const el = document.getElementById("mpTimer");
  if (el) { el.textContent = 60; el.className = "mp-timer"; }
  mpTimerIv = setInterval(() => {
    mpTimeLeft--;
    if (el) { el.textContent = Math.max(0, mpTimeLeft); el.className = "mp-timer" + (mpTimeLeft <= 10 ? " crit" : mpTimeLeft <= 20 ? " warn" : ""); }
    if (mpTimeLeft <= 0) { clearInterval(mpTimerIv); autoPick(); }
  }, 1000);
}
function autoPick() {
  if (finishedMp || xi.filter(Boolean).length >= 11) return;
  if (!pendingSquad) {
    const need = getDangerWkSlot() !== null;
    const t = pickTeam(need); currentTeam = t;
    pendingSquad = (byTeamSeason.get(`${t.fr}|${t.season}`) || []).slice().sort((a, b) => ovrOf(b) - ovrOf(a));
  }
  const best = pendingSquad.filter(canDraft).sort((a, b) => ovrOf(b) - ovrOf(a))[0];
  if (best) { showToast("Auto-picked — time up", "error"); draftPlayer(best); }
  else { pendingSquad = null; renderSquad(); resetTimer(); }
}

// ---------- persistence ----------
function mpXiPayload() {
  return xi.map((p, slot) => p ? {
    name: p.displayName || p.name, ovr: ovrOf(p), bat: p.bat, bowl: p.bowl,
    fr: p.fr, frFull: p.frFull, season: p.season, isWk: p.isWk, isOverseas: p.isOverseas,
    primaryRole: p.primaryRole, battingOrder: p.battingOrder, slot,
    isCaptain: captainKey === playerKey(p),
  } : null).filter(Boolean);
}
function mpAfterPick() {
  mpSaveProgress();
  if (xi.filter(Boolean).length >= 11) {
    clearInterval(mpTimerIv);
    const el = document.getElementById("mpTimer"); if (el) el.textContent = "✓";
  } else resetTimer();
}
async function mpSaveProgress() {
  const filled = xi.filter(Boolean).length;
  try { await MP_SUPA.from("players").update({ xi: mpXiPayload(), status: filled >= 11 ? "done" : "drafting" }).eq("id", MP_PID).eq("room_id", MP_ROOM); } catch (_) {}
}

// ---------- realtime ----------
async function mpRefreshPlayers() {
  const { data } = await MP_SUPA.from("players").select("*").eq("room_id", MP_ROOM).order("joined_at", { ascending: true });
  mpPlayers = data || [];
}
function mpSubscribe() {
  const ch = MP_SUPA.channel("draftmp:" + MP_ROOM);
  ch.on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `room_id=eq.${MP_ROOM}` }, async () => {
    await mpRefreshPlayers();
    if (finishedMp) renderWaitingOverlay();
    if (mpIsHost()) checkAllDone();
  });
  ch.on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${MP_ROOM}` }, (pl) => {
    if (pl.new && pl.new.status === "league") gotoSim();
  });
  ch.subscribe();
}

// ---------- complete -> waiting -> sim ----------
async function mpComplete() {
  finishedMp = true;
  clearInterval(mpTimerIv);
  const el = document.getElementById("mpTimer"); if (el) el.textContent = "✓";
  try { await MP_SUPA.from("players").update({ xi: mpXiPayload(), status: "ready_sim" }).eq("id", MP_PID).eq("room_id", MP_ROOM); } catch (_) {}
  await mpRefreshPlayers();
  renderWaitingOverlay();
  if (mpIsHost()) checkAllDone();
}
function renderWaitingOverlay() {
  const ov = document.getElementById("mpOverlay");
  if (!ov) return;
  ov.hidden = false;
  const humans = mpPlayers.filter((p) => !p.is_bot);
  const ready = humans.filter((p) => p.status === "ready_sim").length;
  ov.innerHTML = `
    <h2>XI Locked In</h2>
    <p>Waiting for every manager to finish drafting — the league starts automatically.</p>
    <ul class="roster">
      ${humans.map((p) => {
        const st = p.status === "ready_sim" ? '<span class="st">Ready</span>'
          : (Array.isArray(p.xi) && p.xi.length >= 11) ? '<span class="st">Done</span>'
          : `<span class="st wait">Drafting ${(Array.isArray(p.xi) ? p.xi.length : 0)}/11</span>`;
        return `<li><span>${(p.username || "").replace(/[<>&]/g, "")}${p.id === MP_PID ? " (you)" : ""}</span>${st}</li>`;
      }).join("")}
    </ul>
    <p>${ready}/${humans.length} managers ready</p>`;
}

let mpTransitionTried = false;
async function checkAllDone() {
  if (!mpIsHost() || mpTransitionTried) return;
  const humans = mpPlayers.filter((p) => !p.is_bot);
  const bots = mpPlayers.filter((p) => p.is_bot);
  const humansReady = humans.length > 0 && humans.every((p) => p.status === "ready_sim");
  const botsDone = bots.every((p) => Array.isArray(p.xi) && p.xi.length >= 11);
  if (humansReady && botsDone) {
    mpTransitionTried = true;
    try { await MP_SUPA.from("rooms").update({ status: "league" }).eq("id", MP_ROOM); } catch (_) { mpTransitionTried = false; }
  }
}
function gotoSim() {
  if (mpRedirecting) return; mpRedirecting = true;
  clearInterval(mpTimerIv);
  const ov = document.getElementById("mpOverlay");
  ov.hidden = false;
  let n = 3;
  (function tick() { ov.innerHTML = `<div class="mp-cd">${n}</div>`; if (n-- > 0) setTimeout(tick, 1000); else location.href = `sim-mp.html?room=${MP_ROOM}`; })();
}

// ---------- bots (host builds their XI from the real 2026 squad) ----------
function buildBotXI(botFullName) {
  const fr = mpFullToFr[botFullName]; if (!fr) return [];
  const squad = (byTeamSeason.get(`${fr}|2026`) || []).slice().sort((a, b) => ovrOf(b) - ovrOf(a));
  const slots = new Array(11).fill(null);
  const has = (n) => slots.some((x) => x && x.name === n);
  const os = () => slots.filter((x) => x && x.isOverseas).length;
  const dangerWk = () => { const t7 = slots.slice(0, 7); if (t7.some((x) => x && x.isWk)) return null; const e = []; for (let i = 0; i < 7; i++) if (slots[i] === null) e.push(i); return e.length === 1 ? e[0] : null; };
  const slotForBot = (p) => { const res = dangerWk() ?? -1; return eligibleSlots(p).find((i) => slots[i] === null && (p.isWk || i !== res)); };
  for (const p of squad) {
    if (slots.every((x) => x)) break;
    if (has(p.name)) continue;
    if (p.isOverseas && os() >= MAX_OVERSEAS) continue;
    const dw = dangerWk();
    if (dw !== null && !p.isWk) { const low = [7, 8, 9, 10].filter((i) => slots[i] === null && eligibleSlots(p).includes(i)); if (!low.length) continue; }
    const s = slotForBot(p); if (s === undefined) continue;
    slots[s] = p;
  }
  return slots.map((p, slot) => p ? {
    name: p.displayName || p.name, ovr: ovrOf(p), bat: p.bat, bowl: p.bowl, fr: p.fr, frFull: p.frFull,
    season: p.season, isWk: p.isWk, isOverseas: p.isOverseas, primaryRole: p.primaryRole, battingOrder: p.battingOrder, slot,
    isCaptain: false,
  } : null).filter(Boolean);
}
async function driveBots() {
  const bots = mpPlayers.filter((p) => p.is_bot && (!Array.isArray(p.xi) || p.xi.length < 11));
  for (const bot of bots) {
    const full = buildBotXI(bot.bot_team || bot.username);
    if (!full.length) { try { await MP_SUPA.from("players").update({ status: "done" }).eq("id", bot.id).eq("room_id", MP_ROOM); } catch (_) {} continue; }
    for (let n = 1; n <= full.length; n++) {
      await new Promise((r) => setTimeout(r, 500 + Math.random() * 800));
      try { await MP_SUPA.from("players").update({ xi: full.slice(0, n), status: n >= full.length ? "done" : "drafting" }).eq("id", bot.id).eq("room_id", MP_ROOM); } catch (_) {}
    }
  }
}
