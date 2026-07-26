// ===================== 16-0 — Auction room =====================
// The lot list is NEVER stored. Every client derives the identical ordered pool
// from the CSV via auction_data.js (same room settings in → same lots out), so
// the only shared state is which lot is live and what it is going for. Same
// "derive locally, sync a pointer" approach as the simulation.
//
// Contention is resolved by conditional UPDATE, exactly like the league's
// sim_round compare-and-swap:
//   • a bid only lands if it beats the stored price
//   • a lot is only sold once, guarded by the (room_id, lot_index) primary key
//   • the pointer only advances from the index the mover actually saw

const SUPA = (typeof initSupabase === "function" && initSupabase()) ||
  (typeof supabaseClient !== "undefined" ? supabaseClient : null);
const PID = sessionStorage.getItem("mp_pid");
const ROOM = new URLSearchParams(location.search).get("room");

const CLOCKS = {
  snappy:  { open: 6000,  bump: 5000, pass: 3500 },
  brisk:   { open: 8000,  bump: 6000, pass: 4500 },
  relaxed: { open: 12000, bump: 8000, pass: 6000 },
};

const A = window.AuctionData;

const S = {
  room: null,
  managers: [],      // players rows
  auction: null,     // auction_state row
  buys: [],          // auction_buys rows
  lots: [],
  clock: CLOCKS.brisk,
  ready: false,
  finishing: false,
  optimistic: null,  // { lotIndex, price } — our own bid, echoed before the server confirms
};

const $ = (id) => document.getElementById(id);
let toastTimer;
function toast(msg, kind) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (kind ? " is-" + kind : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 2200);
}
function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const money = (l) => A.formatMoney(l);

// ---------- derived views ----------
function myBuys() { return S.buys.filter((b) => b.buyer === PID); }
function squadOf(id) { return S.buys.filter((b) => b.buyer === id).map((b) => b.player); }
function spentBy(id) { return S.buys.filter((b) => b.buyer === id).reduce((a, b) => a + (b.price || 0), 0); }
function purseOf(id) { return A.PURSE - spentBy(id); }
function managerView(p) { return { id: p.id, squad: squadOf(p.id), purse: purseOf(p.id) }; }
function allManagerViews() { return S.managers.map(managerView); }
function currentLot() { return S.auction ? S.lots[S.auction.lot_index] : null; }

// The price a bidder must beat: the opening base price, or one increment above
// the standing bid.
function askingPrice() {
  const lot = currentLot();
  if (!lot) return 0;
  const p = S.auction.price;
  return p == null ? lot.basePrice : A.nextBid(p);
}

function iCanBid() {
  const lot = currentLot();
  if (!lot || !S.auction || S.auction.status !== "live") return false;
  if (S.auction.high_bidder === PID) return false; // already leading
  return A.canBidOn(managerView({ id: PID }), lot, askingPrice());
}

// ---------- boot ----------
async function boot() {
  if (!SUPA || !PID || !ROOM) { location.href = "auction.html"; return; }
  try {
    const { data: room } = await SUPA.from("rooms").select("*").eq("id", ROOM).single();
    if (!room) { location.href = "auction.html"; return; }
    S.room = room;
    const st = room.settings || {};
    S.clock = CLOCKS[st.clock] || CLOCKS.brisk;

    const rows = await loadCsv();
    S.rows = rows;
    const teams = Math.max(2, Number(st.teams) || 2);
    let players = rows;
    if (st.ratings === "prime") {
      const best = {};
      for (const p of rows) if (!best[p.name] || p.ovr > best[p.name].ovr) best[p.name] = p;
      players = rows.map((p) => ({ ...p, ...best[p.name] }));
    }
    S.reserve = A.bestSeasonPerPlayer(players, st.era && st.era !== "all" ? +st.era : 2008, 2026);
    S.lots = A.buildAuctionPool(players, {
      teams,
      eraFrom: st.era && st.era !== "all" ? +st.era : 2008,
      eraTo: 2026,
    }).lots;

    await refresh();
    subscribe();
    setInterval(refresh, 2500);   // polling fallback
    setInterval(tick, 120);       // clock + local resolution
    S.ready = true;
    render();
  } catch (err) {
    console.error(err);
    $("lotCard").innerHTML = '<div class="lot-empty">Could not load the auction. Has mp_auction.sql been run?</div>';
  }
}

function loadCsv() {
  return new Promise((resolve, reject) => {
    Papa.parse("ipl_master_calibrated.csv", {
      download: true, header: true, skipEmptyLines: true,
      complete: (res) => resolve((res.data || [])
        .filter((r) => r.Player_Name && r.Franchise && r.Season)
        .map((r) => ({
          name: r.Player_Name,
          displayName: r.Player_Name,
          season: r.Season,
          fr: r.Franchise,
          frFull: r.Franchise_Full,
          ovr: Math.min(+r.OVR || 70, 100),
          bat: +r.Bat_Rat || +r.OVR || 70,
          bowl: +r.Bowl_Rat || +r.OVR || 60,
          primaryRole: r.Primary_Role,
          battingOrder: r.Batting_Order,
          isWk: r.Is_Wicketkeeper === "1",
          isOverseas: r.Nationality === "Overseas",
        }))),
      error: reject,
    });
  });
}

async function refresh() {
  try {
    const [r, p, a, b] = await Promise.all([
      SUPA.from("rooms").select("*").eq("id", ROOM).single(),
      SUPA.from("players").select("id,username,is_bot,purse").eq("room_id", ROOM),
      SUPA.from("auction_state").select("*").eq("room_id", ROOM).single(),
      SUPA.from("auction_buys").select("*").eq("room_id", ROOM).order("lot_index", { ascending: true }),
    ]);
    if (r.data) S.room = r.data;
    if (p.data) S.managers = p.data.filter((x) => !x.is_bot);
    if (a.data) S.auction = a.data;
    if (b.data) { S.buys = b.data; announceSales(); }
    // Our optimistic echo is spent once the server reports an equal-or-better bid.
    if (S.optimistic && S.auction &&
        (S.auction.lot_index !== S.optimistic.lotIndex || (S.auction.price || 0) >= S.optimistic.price)) {
      S.optimistic = null;
    }
  } catch (_) {}
  if (S.ready) render();
}

// ---------- hammer-fall announcement ----------
// "SOLD — Chris Gayle to Sharone for ₹14 Cr". Lots already resolved before this
// client loaded are marked seen rather than replayed, so joining mid-auction
// does not fire a burst of stale popups.
const announced = new Set();
let saleTimer = null;
function announceSales() {
  const fresh = [];
  for (const b of S.buys) {
    if (announced.has(b.lot_index)) continue;
    announced.add(b.lot_index);
    if (S.seenFirstLoad && b.buyer) fresh.push(b);
  }
  S.seenFirstLoad = true;
  // If several resolved at once (a skipped set), only the last one is worth showing.
  const last = fresh[fresh.length - 1];
  if (last) showSale(last);
}

function showSale(buy) {
  const p = buy.player || {};
  const pop = $("salePop");
  $("saleCard").className = "sale-card";
  $("saleCard").innerHTML = `
    <div class="sale-stamp">Sold</div>
    <div class="sale-player">${esc(p.displayName || p.name || "Player")}</div>
    <div class="sale-to">to <span class="sale-buyer">${esc(nameOf(buy.buyer))}</span></div>
    <div class="sale-price">${money(buy.price)}</div>`;
  pop.hidden = false;
  clearTimeout(saleTimer);
  saleTimer = setTimeout(() => { pop.hidden = true; }, 2600);
}

function subscribe() {
  try {
    const ch = SUPA.channel("auction:" + ROOM);
    ch.on("postgres_changes", { event: "*", schema: "public", table: "auction_state", filter: `room_id=eq.${ROOM}` },
      (p) => { if (p.new) { S.auction = p.new; if (S.ready) render(); } });
    ch.on("postgres_changes", { event: "*", schema: "public", table: "auction_buys", filter: `room_id=eq.${ROOM}` },
      () => refresh());
    ch.on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${ROOM}` },
      (p) => { if (p.new) { S.room = p.new; if (p.new.status === "league") gotoSim(); } });
    ch.subscribe();
  } catch (_) {}
}

// ---------- the clock ----------
function msLeft() {
  if (!S.auction || !S.auction.ends_at) return null;
  return Date.parse(S.auction.ends_at) - Date.now();
}

// Runs ~8x a second on every client. Whoever notices an expiry first resolves
// it; the conditional writes make the duplicate attempts harmless.
async function tick() {
  if (!S.ready || !S.auction || S.auction.status !== "live" || S.finishing) return;
  renderTimer();

  const lot = currentLot();
  if (!lot) { finishAuction(); return; }

  // Everyone is full — stop, whatever lots remain.
  if (A.isAuctionComplete(allManagerViews())) { finishAuction(); return; }

  // Nobody can bid on this lot: pass it immediately rather than run the clock.
  if (!S.auction.ends_at && A.shouldAutoPass(allManagerViews(), lot, lot.basePrice)) {
    await resolveLot(null, 0);
    return;
  }

  // Open the clock on a fresh lot.
  if (!S.auction.ends_at) {
    await SUPA.from("auction_state")
      .update({ ends_at: new Date(Date.now() + S.clock.open).toISOString() })
      .eq("room_id", ROOM).eq("lot_index", S.auction.lot_index).is("ends_at", null);
    return;
  }

  // Hammer.
  if (msLeft() <= 0) {
    await resolveLot(S.auction.high_bidder, S.auction.price || 0);
  }
}

// Sell (or pass) the current lot and advance. The primary key on
// (room_id, lot_index) means only one client's insert lands, so a lot can never
// be sold twice or charged twice even with every client racing.
async function resolveLot(buyer, price) {
  const idx = S.auction.lot_index;
  const lot = S.lots[idx];
  if (!lot) return;
  try {
    await SUPA.from("auction_buys").insert({
      room_id: ROOM, lot_index: idx,
      buyer: buyer || null, player: buyer ? lot : null, price: buyer ? price : null,
    });
  } catch (_) { /* someone else already resolved it — fine */ }

  await SUPA.from("auction_state")
    .update({ lot_index: idx + 1, price: null, high_bidder: null, ends_at: null, skip_votes: [] })
    .eq("room_id", ROOM).eq("lot_index", idx);

  if (buyer) {
    // Cached purse for the lobby/room UI; the truth is always auction_buys.
    await SUPA.from("players").update({ purse: A.PURSE - spentBy(buyer) - price })
      .eq("id", buyer).eq("room_id", ROOM);
  }
  refresh();
}

// ---------- bidding ----------
// The timer RESETS on every accepted bid, so a lot only closes once the room
// has gone quiet for a full bump interval. That is also the anti-snipe: a late
// bid always buys everyone else another window to respond.
async function placeBid() {
  const lot = currentLot();
  if (!lot || !iCanBid()) return;
  const price = askingPrice();

  S.optimistic = { lotIndex: S.auction.lot_index, price };
  render();

  const { data, error } = await SUPA.from("auction_state")
    .update({
      price,
      high_bidder: PID,
      ends_at: new Date(Date.now() + S.clock.bump).toISOString(),
      skip_votes: [],
    })
    .eq("room_id", ROOM)
    .eq("lot_index", S.auction.lot_index)
    .or(`price.is.null,price.lt.${price}`)
    .select("*");

  if (error) { S.optimistic = null; toast("Bid failed", "error"); refresh(); return; }
  if (!data || !data.length) {
    // Someone beat us to that price — snap the optimistic echo back.
    S.optimistic = null;
    toast("Outbid — someone got there first");
  } else {
    S.auction = data[0];
  }
  refresh();
}

// ---------- move to next set ----------
async function voteSkip() {
  const idx = S.auction.lot_index;
  const votes = new Set(S.auction.skip_votes || []);
  if (votes.has(PID)) return;
  votes.add(PID);
  const needed = A.skipSetVoters(allManagerViews(), S.lots, idx);
  const all = needed.every((id) => votes.has(id));

  if (all) {
    // Pass every remaining lot in this set in one go.
    const end = A.nextSetIndex(S.lots, idx);
    const rows = [];
    for (let i = idx; i < end; i++) {
      rows.push({ room_id: ROOM, lot_index: i, buyer: null, player: null, price: null });
    }
    try { await SUPA.from("auction_buys").upsert(rows, { onConflict: "room_id,lot_index" }); } catch (_) {}
    await SUPA.from("auction_state")
      .update({ lot_index: end, price: null, high_bidder: null, ends_at: null, skip_votes: [] })
      .eq("room_id", ROOM).eq("lot_index", idx);
    toast("Skipped to the next set");
  } else {
    await SUPA.from("auction_state").update({ skip_votes: [...votes] })
      .eq("room_id", ROOM).eq("lot_index", idx);
  }
  refresh();
}

// ---------- finishing ----------
// Convert each manager's purchases into an XI (with slots assigned) written to
// players.xi — the exact shape sim-mp.js already consumes, so the league and
// knockouts run afterwards with no changes at all.
async function finishAuction() {
  if (S.finishing) return;
  S.finishing = true;
  try {
    await SUPA.from("auction_state").update({ status: "done" }).eq("room_id", ROOM);

    // Accelerated round: anyone still short is handed the best remaining legal
    // player at base price. Simulation showed the one real stranding case —
    // reaching ten players with no keeper and all four overseas slots spent —
    // so this draws on the wider database when the pool is exhausted.
    const views = allManagerViews();
    const taken = S.buys.filter((b) => b.buyer).map((b) => b.player.name);
    const awarded = A.fillShortSquads(views, S.lots, taken, S.reserve || []);
    if (awarded.length) {
      let nextIdx = S.lots.length + 1;
      for (const a of awarded) {
        try {
          await SUPA.from("auction_buys").insert({
            room_id: ROOM, lot_index: nextIdx++, buyer: a.buyer,
            player: a.player, price: a.price,
          });
        } catch (_) {}
      }
      await refresh();
      toast(`${awarded.length} squad slot(s) filled in the accelerated round`);
    }

    for (const m of S.managers) {
      const squad = squadOf(m.id);
      const slots = A.assignSlots(squad) || squad.map((_, i) => i);
      const xi = squad.map((p, i) => ({
        name: p.displayName || p.name,
        displayName: p.displayName || p.name,
        ovr: p.ovr, bat: p.bat, bowl: p.bowl,
        fr: p.fr, frFull: p.frFull, season: p.season,
        isWk: p.isWk, isOverseas: p.isOverseas,
        primaryRole: p.primaryRole, battingOrder: p.battingOrder,
        slot: slots[i],
        isCaptain: false,
      })).sort((a, b) => a.slot - b.slot);
      if (xi.length) xi[0].isCaptain = true; // top-order anchor captains by default
      await SUPA.from("players").update({ xi, status: "ready_sim" }).eq("id", m.id).eq("room_id", ROOM);
    }
    render();
  } catch (err) {
    console.error(err);
    S.finishing = false;
  }
}

// The league needs ten teams so every side plays a full 14-game slate. Any seat
// the auction did not fill is taken by a real 2026 franchise, exactly as the
// league lobby does it — sim-mp.js builds their XI from the franchise's actual
// squad off the `bot_team` name, so nothing else has to change.
const LEAGUE_SIZE = 10;

function botTeamsByStrength() {
  const byTeam = {};
  for (const r of S.rows || []) {
    if (String(r.season).trim() !== "2026") continue;
    const full = (r.frFull || r.fr || "").trim();
    if (!full) continue;
    (byTeam[full] = byTeam[full] || []).push(r.ovr || 0);
  }
  return Object.entries(byTeam)
    .filter(([, ovrs]) => ovrs.length >= 11)
    .map(([name, ovrs]) => {
      const top = ovrs.sort((a, b) => b - a).slice(0, 11);
      return { name, ovr: Math.round(top.reduce((a, b) => a + b, 0) / top.length) };
    })
    .sort((a, b) => b.ovr - a.ovr);
}

function botId() {
  return "bot_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

async function proceed() {
  const btn = $("proceedBtn");
  btn.disabled = true;
  btn.textContent = "Setting up the league…";
  try {
    const { data: existing } = await SUPA.from("players").select("id,is_bot").eq("room_id", ROOM);
    const humans = (existing || []).filter((p) => !p.is_bot);
    const alreadyBots = (existing || []).filter((p) => p.is_bot).length;
    const need = Math.max(0, LEAGUE_SIZE - humans.length - alreadyBots);

    if (need) {
      const bots = botTeamsByStrength().slice(0, need);
      if (bots.length) {
        await SUPA.from("players").insert(bots.map((t) => ({
          id: botId(), room_id: ROOM, username: t.name,
          is_host: false, is_bot: true, bot_team: t.name,
          status: "done", xi: null, sim_ready_step: -1,
        })));
      }
    }

    // Start the shared progression from the top: kickoff vote, 14 rounds, then
    // the per-fixture knockout gates — all handled by sim-mp.js unchanged.
    await SUPA.from("players").update({ sim_ready_step: -1 }).eq("room_id", ROOM);
    await SUPA.from("rooms").update({ status: "league", sim_round: -1 }).eq("id", ROOM);
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = "Proceed to Simulation";
    toast("Could not start the league", "error");
    return;
  }
  gotoSim();
}
let goingSim = false;
function gotoSim() {
  if (goingSim) return;
  goingSim = true;
  location.href = `sim-mp.html?room=${ROOM}`;
}

// ---------- rendering ----------
function ovrClass(o) {
  if (o >= 92) return "ovr-gold";
  if (o >= 89) return "ovr-blue";
  if (o >= 85) return "ovr-green";
  return "ovr-white";
}
function roleBadge(p) {
  if (p.primaryRole === "Bowler") return { label: "Bowler", cls: "role-lower" };
  if (p.primaryRole === "All-Rounder") return { label: "All-Rounder", cls: "role-finisher" };
  switch (p.battingOrder) {
    case "Opener": return { label: "Opener", cls: "role-opener" };
    case "Finisher": return { label: "Finisher", cls: "role-finisher" };
    case "Lower Order": return { label: "Lower Order", cls: "role-lower" };
    default: return { label: "Middle Order", cls: "role-middle" };
  }
}
const SLOT_LABELS = [
  "Opener", "Opener", "Opener / Middle Order", "Middle Order", "Middle Order",
  "Middle Order", "Middle Order / Finisher", "Bowler / Finisher", "Bowler", "Bowler", "Bowler",
];

function render() {
  if (!S.auction) return;
  renderSetBar();
  renderLot();
  renderBid();
  renderSquad();
  renderManagers();
  renderFeed();
  renderTimer();

  const done = S.auction.status === "done" || !currentLot();
  $("proceedBtn").classList.toggle("hidden", !done);
  $("phasePill").textContent = done ? "Complete" : "Auction";
}

function renderSetBar() {
  const seen = [];
  S.lots.forEach((l) => { if (!seen.length || seen[seen.length - 1].id !== l.setId) seen.push({ id: l.setId, start: seen.length ? null : 0 }); });
  const idx = S.auction.lot_index;
  const currentSet = S.lots[idx] ? S.lots[idx].setId : null;
  const order = [];
  S.lots.forEach((l) => { if (!order.includes(l.setId)) order.push(l.setId); });
  const pos = order.indexOf(currentSet);
  $("setBar").innerHTML = order.map((id, i) =>
    `<span class="set-seg ${i < pos ? "is-done" : i === pos ? "is-live" : ""}"></span>`
  ).join("");
}

function renderLot() {
  const lot = currentLot();
  const card = $("lotCard");
  if (!lot) {
    card.className = "lot-card";
    card.innerHTML = '<div class="lot-empty">Auction complete — every squad is set.</div>';
    $("lotSet").textContent = "Done";
    $("lotCount").textContent = "";
    return;
  }
  const badge = roleBadge(lot);
  card.className = "lot-card";
  card.innerHTML = `
    <div class="lot-main">
      <h2 class="lot-name">${esc(lot.displayName)}</h2>
      <div class="lot-sub">${esc(lot.fr)} ${esc(lot.season)} &middot; base ${money(lot.basePrice)}</div>
      <div class="lot-badges">
        <span class="badge ${badge.cls}">${badge.label}</span>
        ${lot.isWk ? '<span class="badge wk">Wicketkeeper</span>' : ""}
        ${lot.isOverseas ? '<span class="badge overseas">Overseas</span>' : ""}
        <span class="badge">BAT ${lot.bat}</span>
        <span class="badge">BOWL ${lot.bowl}</span>
      </div>
    </div>
    <div class="lot-ovr ${ovrClass(lot.ovr)}">${lot.ovr}</div>`;
  $("lotSet").textContent = lot.setLabel;
  const setLots = S.lots.filter((l) => l.setId === lot.setId);
  const within = setLots.indexOf(lot) + 1;
  $("lotCount").textContent = `Lot ${S.auction.lot_index + 1} of ${S.lots.length} · ${within}/${setLots.length} in set`;
}

function renderBid() {
  const lot = currentLot();
  const btn = $("bidBtn");
  if (!lot) { btn.disabled = true; btn.textContent = "Auction complete"; $("bidNote").textContent = ""; $("skipBtn").hidden = true; return; }

  const shown = S.optimistic ? S.optimistic.price : S.auction.price;
  const leader = S.optimistic ? PID : S.auction.high_bidder;
  $("bidPrice").textContent = shown == null ? money(lot.basePrice) : money(shown);
  const holderEl = $("bidHolder");
  if (!leader) { holderEl.textContent = "No bids yet — opens at base price"; holderEl.className = "bid-holder"; }
  else if (leader === PID) { holderEl.textContent = "You are leading"; holderEl.className = "bid-holder is-you"; }
  else { holderEl.textContent = `${nameOf(leader)} leading`; holderEl.className = "bid-holder"; }

  const me = managerView({ id: PID });
  const ask = askingPrice();
  const leading = leader === PID;
  btn.classList.toggle("is-leading", leading);

  if (leading) { btn.disabled = true; btn.textContent = "You hold the bid"; }
  else if (iCanBid()) { btn.disabled = false; btn.textContent = `Bid ${money(ask)}`; }
  else { btn.disabled = true; btn.textContent = `Bid ${money(ask)}`; }

  // Say WHY you cannot bid — silent disabled buttons are the worst part of
  // auction UIs.
  let note = "";
  if (!leading && !iCanBid()) {
    if (me.squad.length >= A.XI_SIZE) note = "Your XI is full — you are out of the auction.";
    else if (A.maxBid(me.purse, A.XI_SIZE - me.squad.length) < ask) note = `Beyond your max bid of ${money(A.maxBid(me.purse, A.XI_SIZE - me.squad.length))}.`;
    else if (!A.canAdd(me.squad, lot)) note = "No legal slot for this player in your XI.";
  }
  // Mandatory signings outstanding — the warning that stops a manager filling
  // ten slots and only then discovering the last one has to be a keeper.
  const needs = A.outstandingNeeds(me.squad);
  if (needs.length && me.squad.length < A.XI_SIZE) {
    const n = needs[0];
    const slotsLeft = A.XI_SIZE - me.squad.length;
    note = (note ? note + "  " : "") +
      `Still need ${n.what} — ${slotsLeft} slot${slotsLeft === 1 ? "" : "s"} left.`;
  }
  $("bidNote").textContent = note;

  // Skip-set vote — only offered to managers who could still bid in this set.
  const voters = A.skipSetVoters(allManagerViews(), S.lots, S.auction.lot_index);
  const votes = S.auction.skip_votes || [];
  const skip = $("skipBtn");
  if (!voters.includes(PID)) { skip.hidden = true; }
  else {
    skip.hidden = false;
    const mine = votes.includes(PID);
    skip.disabled = mine;
    skip.textContent = mine
      ? `Waiting… ${votes.filter((v) => voters.includes(v)).length}/${voters.length}`
      : voters.length > 1
        ? `Move to Next Set (${votes.filter((v) => voters.includes(v)).length}/${voters.length})`
        : "Move to Next Set";
  }
}

function renderTimer() {
  const ms = msLeft();
  const ring = $("timerRing");
  const num = $("timerNum");
  if (ms == null || !currentLot()) { num.textContent = "—"; ring.className = "timer-ring"; return; }
  const secs = Math.max(0, Math.ceil(ms / 1000));
  num.textContent = secs;
  ring.className = "timer-ring" + (secs <= 3 ? " is-crit" : secs <= 5 ? " is-warn" : "");
}

function nameOf(id) {
  const m = S.managers.find((x) => x.id === id);
  return m ? (m.username || "Manager") : "Manager";
}

function renderSquad() {
  const squad = squadOf(PID);
  const slots = A.assignSlots(squad) || [];
  const filled = new Array(11).fill(null);
  squad.forEach((p, i) => { const s = slots[i]; if (s != null && s >= 0) filled[s] = { p, price: myBuys()[i] ? myBuys()[i].price : null }; });

  $("squadCount").textContent = `${squad.length}/11`;
  $("overseasCount").textContent = `${squad.filter((p) => p.isOverseas).length}/4 overseas`;
  const left = A.XI_SIZE - squad.length;
  $("maxBidVal").textContent = left > 0 ? `max ${money(A.maxBid(purseOf(PID), left))}` : "squad complete";
  $("purseVal").textContent = money(purseOf(PID));

  $("squadList").innerHTML = SLOT_LABELS.map((label, i) => {
    const cell = filled[i];
    if (!cell) {
      return `<li><span class="slot-num">${i + 1}</span>
        <span class="slot-body"><span class="slot-role">${label}</span>
        <span class="slot-player" style="color:#5f5f5f">Empty</span></span></li>`;
    }
    const { p, price } = cell;
    return `<li class="is-filled"><span class="slot-num">${i + 1}</span>
      <span class="slot-body">
        <span class="slot-role">${label}</span>
        <span class="slot-player">${esc(p.displayName)}${p.isWk ? " (wk)" : ""}</span>
        <span class="slot-paid">${price != null ? money(price) : ""}</span>
      </span>
      <span class="slot-ovr ${ovrClass(p.ovr)}">${p.ovr}</span></li>`;
  }).join("");
}

function renderManagers() {
  const lot = currentLot();
  $("mgrList").innerHTML = S.managers.map((m) => {
    const sq = squadOf(m.id);
    const full = sq.length >= A.XI_SIZE;
    const live = lot && A.canBidOn(managerView(m), lot, askingPrice());
    return `<li class="${m.id === PID ? "is-you " : ""}${full ? "is-full" : ""}">
      <span class="m-name">${esc(m.username || "Manager")}${m.id === PID ? " (you)" : ""}</span>
      <span class="m-squad">${sq.length}/11</span>
      ${live ? '<span class="m-bidding">in</span>' : ""}
      <span class="m-purse">${money(purseOf(m.id))}</span>
    </li>`;
  }).join("");
}

function renderFeed() {
  const recent = S.buys.slice().sort((a, b) => b.lot_index - a.lot_index).slice(0, 12);
  $("soldFeed").innerHTML = recent.map((b) => {
    if (!b.buyer) {
      const lot = S.lots[b.lot_index];
      return `<div class="sold-row is-unsold"><span class="s-name">${esc(lot ? lot.displayName : "Lot")}</span>
        <span class="s-buyer">unsold</span></div>`;
    }
    const p = b.player || {};
    return `<div class="sold-row"><span class="s-name">${esc(p.displayName || p.name)}</span>
      <span class="s-buyer">${esc(nameOf(b.buyer))}</span>
      <span class="s-price">${money(b.price)}</span></div>`;
  }).join("");
}

// ---------- wiring ----------
$("bidBtn").addEventListener("click", placeBid);
$("skipBtn").addEventListener("click", voteSkip);
$("proceedBtn").addEventListener("click", proceed);
// Space bar bids — auctions are fast and the mouse is slow.
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.repeat) { e.preventDefault(); if (iCanBid()) placeBid(); }
});

boot();
