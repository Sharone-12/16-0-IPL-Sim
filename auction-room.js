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
  // Batting order. `order` is the current slot-by-slot layout (player names);
  // `pinned` is the subset the manager placed by hand, which survives a re-solve
  // when a new signing doesn't fit around everyone's current position.
  order: [],
  pinned: new Set(),
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
  if (S.auction.paused) return false;
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

    const { auc, mas } = await loadPool();
    S.rows = mas;                       // master rows, for deriving bot franchises
    const teams = Math.max(2, Number(st.teams) || 2);
    const pool = A.buildCuratedPool(auc, mas, { teams });
    S.lots = pool.lots;
    S.reserve = pool.lots;              // accelerated round draws on the same pool
    if (pool.unmatched.length) {
      console.warn("[auction] lots with no master row (skipped):", pool.unmatched);
    }
    if (pool.shortfalls.length) {
      console.warn("[auction] pool shortfalls:", pool.shortfalls);
    }

    loadOrder();
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

// Both CSVs: the curated auction file (sets, tiers, calibrated OVR, base
// price) and the master file it is joined to for Batting_Order / Bat_Rat /
// Bowl_Rat, which the XI slot rules and the match engine need.
function parseCsv(path) {
  return new Promise((resolve, reject) => {
    Papa.parse(path, {
      download: true, header: true, skipEmptyLines: true,
      complete: (res) => resolve(res.data || []),
      error: reject,
    });
  });
}

async function loadPool() {
  const [aucRaw, masRaw] = await Promise.all([
    parseCsv("ipl_auction_career_final.csv"),
    parseCsv("ipl_master_calibrated.csv"),
  ]);
  const auc = aucRaw.filter((r) => r.Player_Name).map(A.normalizeAuctionRow);
  const mas = masRaw.filter((r) => r.Player_Name && r.Season).map(A.normalizeMasterRow);
  return { auc, mas };
}

async function refresh() {
  try {
    const [r, p, a, b] = await Promise.all([
      SUPA.from("rooms").select("*").eq("id", ROOM).single(),
      SUPA.from("players").select("id,username,is_bot,purse").eq("room_id", ROOM),
      SUPA.from("auction_state").select("*").eq("room_id", ROOM).single(),
      SUPA.from("auction_buys").select("*").eq("room_id", ROOM).order("lot_index", { ascending: true }),
    ]);
    if (a.error && a.error.code !== "PGRST116") console.error("[auction] state read failed:", a.error);
    // Managers who never pressed Proceed are pulled into the league too. The
    // realtime subscription normally does this; the poll is the fallback for
    // when the socket is down, so nobody is left stranded on a dead auction.
    if (r.data) { S.room = r.data; if (r.data.status === "league") gotoSim(); }
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
let ticking = false;
async function tick() {
  if (!S.ready || !S.auction || S.auction.status !== "live" || S.finishing) return;
  renderTimer();
  // setInterval does not wait for an async callback, so without this guard ~8
  // overlapping ticks a second each fire their own resolveLot.
  if (ticking) return;
  ticking = true;
  try { await tickOnce(); } finally { ticking = false; }
}

function isPaused() { return !!(S.auction && S.auction.paused); }
function isHost() { return !!(S.room && S.room.host_id === PID); }

// ---------- host pause ----------
// Banks the time LEFT on the current lot and clears the deadline. Without that
// the absolute deadline would quietly expire during the pause and the lot would
// hammer the instant play resumed.
async function togglePause() {
  if (!isHost() || !S.auction) return;
  const btn = $("pauseBtn");
  btn.disabled = true;
  try {
    if (isPaused()) {
      const banked = Number(S.auction.remaining_ms);
      const patch = { paused: false, remaining_ms: null };
      // A lot paused before its clock ever opened just starts fresh on resume.
      if (Number.isFinite(banked) && banked > 0) {
        patch.ends_at = new Date(Date.now() + banked).toISOString();
      }
      const { error } = await SUPA.from("auction_state").update(patch).eq("room_id", ROOM);
      if (error) throw error;
    } else {
      const left = msLeft();
      const { error } = await SUPA.from("auction_state").update({
        paused: true,
        remaining_ms: Number.isFinite(left) ? Math.max(0, left) : null,
        ends_at: null,
      }).eq("room_id", ROOM);
      if (error) throw error;
    }
  } catch (err) {
    console.error("[auction] pause failed:", err);
    toast("Pause failed — has mp_auction_pause.sql been run?", "error");
  }
  btn.disabled = false;
  refresh();
}

async function tickOnce() {
  // Paused: no clock opens, nothing resolves, nothing auto-passes.
  if (isPaused()) return;

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
    const open = await SUPA.from("auction_state")
      .update({ ends_at: new Date(Date.now() + S.clock.open).toISOString() })
      .eq("room_id", ROOM).eq("lot_index", S.auction.lot_index).is("ends_at", null);
    if (open.error) {
      console.error("[auction] could not open the clock:", open.error);
      toast("Could not start the clock — check the console", "error");
    }
    return;
  }

  // Hammer.
  const left = msLeft();
  if (Number.isFinite(left) && left <= 0) {
    await resolveLot(S.auction.high_bidder, S.auction.price || 0);
    return;
  }

  // Self-heal: if the deadline is well past and the lot still has not moved,
  // something went wrong writing the result. Re-read the truth and try again
  // rather than sitting on a dead 0.
  if (!Number.isFinite(left) || left < -3000) {
    console.warn("[auction] lot", S.auction.lot_index, "stuck at deadline; re-syncing", {
      ends_at: S.auction.ends_at, left,
    });
    await refresh();
    if (S.auction && Number.isFinite(msLeft()) && msLeft() <= 0) {
      await resolveLot(S.auction.high_bidder, S.auction.price || 0);
    } else if (S.auction && !Number.isFinite(msLeft())) {
      // ends_at unusable — clear it so the next tick opens a fresh clock.
      await SUPA.from("auction_state").update({ ends_at: null })
        .eq("room_id", ROOM).eq("lot_index", S.auction.lot_index);
    }
  }
}

// Sell (or pass) the current lot and advance. The primary key on
// (room_id, lot_index) means only one client's insert lands, so a lot can never
// be sold twice or charged twice even with every client racing.
async function resolveLot(buyer, price) {
  const idx = S.auction.lot_index;
  const lot = S.lots[idx];
  if (!lot) return;

  // A duplicate-key error here is EXPECTED — every client races to resolve and
  // the primary key lets exactly one win. Anything else is a real fault and
  // must be visible, not swallowed.
  const ins = await SUPA.from("auction_buys").insert({
    room_id: ROOM, lot_index: idx,
    buyer: buyer || null, player: buyer ? lot : null, price: buyer ? price : null,
  });
  if (ins.error && ins.error.code !== "23505") {
    console.error("[auction] could not record the sale:", ins.error);
    toast("Could not record the sale — check the console", "error");
  }

  const adv = await SUPA.from("auction_state")
    .update({ lot_index: idx + 1, price: null, high_bidder: null, ends_at: null, skip_votes: [] })
    .eq("room_id", ROOM).eq("lot_index", idx);
  if (adv.error) {
    console.error("[auction] could not advance the lot:", adv.error);
    toast("Could not advance the lot — check the console", "error");
  }

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
// A bid EXTENDS the clock; it used to replace it with `now + bump`, which is not
// what the lobby advertises ("8s · +6s on a bid") and behaved badly in two ways:
// bidding with 5s left on a brisk clock moved it to 6s — visibly "+1 second" —
// and the first bid on a relaxed 12s clock SHORTENED it to 8s.
//
// Capped at the opening duration so a long bidding war can't inflate the timer
// without bound, and floored at the bump so a late bid always leaves a fair
// window to respond.
function bumpedDeadline() {
  const left = Math.max(0, msLeft() || 0);
  const ms = Math.min(Math.max(left + S.clock.bump, S.clock.bump), S.clock.open);
  return new Date(Date.now() + ms).toISOString();
}

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
      ends_at: bumpedDeadline(),
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
  if (isPaused()) return;
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

// Move a sub-rating by the same amount the headline OVR moved between the two
// scales, so a player's batting/bowling stay in proportion to the OVR shown.
function shiftRating(value, auctionOvr, masterOvr) {
  const v = Number(value);
  if (!Number.isFinite(v)) return v;
  const delta = Number.isFinite(Number(masterOvr)) ? Number(auctionOvr) - Number(masterOvr) : 0;
  return Math.max(30, Math.min(99, Math.round(v + delta)));
}

// Turn a manager's purchases into the XI shape sim-mp.js consumes. For the local
// manager the batting order they dragged out is honoured; for anyone else the
// slot solver picks a legal arrangement.
function buildXi(id) {
  const squad = squadOf(id);
  if (!squad.length) return [];
  let slots;
  if (id === PID) {
    squadLayout(); // refresh S.order against the final squad
    slots = squad.map((p) => S.order.indexOf(p.name));
  }
  if (!slots || slots.some((s) => s < 0)) slots = A.assignSlots(squad) || squad.map((_, i) => i);

  const xi = squad.map((p, i) => ({
    name: p.displayName || p.name,
    displayName: p.displayName || p.name,
    // WYSIWYG: the rating on the card you bid for is the rating that walks out
    // to bat. The auction's calibrated OVR sits ~5 below the master scale the
    // engine was tuned on, so bat/bowl are shifted by that same delta —
    // otherwise the sim would DISPLAY the auction number while PLAYING the
    // master one, which is the mismatch this removes.
    ovr: p.ovr, simOvr: p.ovr,
    bat: shiftRating(p.bat, p.ovr, p.simOvr),
    bowl: shiftRating(p.bowl, p.ovr, p.simOvr),
    fr: p.fr, frFull: p.frFull, season: p.season,
    isWk: p.isWk, isOverseas: p.isOverseas,
    primaryRole: p.primaryRole, battingOrder: p.battingOrder,
    slot: slots[i],
    isCaptain: false,
  })).sort((a, b) => a.slot - b.slot);
  if (xi.length) xi[0].isCaptain = true; // top-order anchor captains by default
  return xi;
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

    // Write ONLY our own XI. This used to write every manager's, from every
    // client — which meant the last writer's auto-assignment overwrote whatever
    // batting order the manager had dragged out for themselves. Anyone not here
    // to set their own is filled in later by setUpLeague, which is single-writer.
    await SUPA.from("players")
      .update({ xi: buildXi(PID), status: "ready_sim" })
      .eq("id", PID).eq("room_id", ROOM);
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

// Bot ids are DERIVED, not random. Every client that clicks Proceed computes the
// identical seat list, so concurrent setup attempts collide on players.id and
// the upsert dedupes them. Random ids meant two managers clicking together each
// inserted a full set of eight — a league of eighteen teams, of which only ten
// got fixtures.
function botId(seat) {
  return `bot_${ROOM}_${seat}`;
}

// Exactly one client sets the league up. Everyone else waits for it, because the
// setup RESETS every ready-vote: a second client running it a moment later would
// wipe the votes already cast in the simulation and stall the room on 0/N.
async function proceed() {
  const btn = $("proceedBtn");
  btn.disabled = true;
  btn.textContent = "Setting up the league…";
  try {
    const { data: claimed, error: claimErr } = await SUPA.from("rooms")
      .update({ status: "league_setup" })
      .eq("id", ROOM)
      .eq("status", "auction")
      .select("id");
    if (claimErr) throw claimErr;

    if (claimed && claimed.length) {
      try {
        await setUpLeague();
      } catch (e) {
        // Hand the claim back, or the room is wedged in league_setup for good
        // and nobody can ever retry.
        await SUPA.from("rooms").update({ status: "auction" }).eq("id", ROOM);
        throw e;
      }
    } else {
      // Someone else won the claim — wait for them to finish before entering.
      for (let i = 0; i < 80; i++) {
        const { data: r } = await SUPA.from("rooms").select("status").eq("id", ROOM).single();
        if (r && r.status === "league") break;
        await new Promise((res) => setTimeout(res, 250));
      }
    }
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = "Proceed to Simulation";
    toast("Could not start the league", "error");
    return;
  }
  gotoSim();
}

async function setUpLeague() {
  // finishAuction writes each XI asynchronously. Clicking Proceed the instant
  // the hammer falls could otherwise read a manager mid-write, count them out,
  // and seat a bot in their place.
  let existing = null;
  const incomplete = (p) => !p.is_bot && !(Array.isArray(p.xi) && p.xi.length >= 11);
  for (let i = 0; i < 40; i++) {
    const { data } = await SUPA.from("players").select("id,is_bot,xi").eq("room_id", ROOM);
    existing = data || [];
    if (!existing.some(incomplete)) break;
    await new Promise((res) => setTimeout(res, 250));
  }

  // Whoever never wrote their own is not here to set a batting order — give them
  // a solver-assigned XI so their squad still takes the field. Only this client
  // does it, so nobody's dragged order can be overwritten by a late writer.
  for (const p of (existing || []).filter(incomplete)) {
    const xi = buildXi(p.id);
    if (xi.length >= 11) {
      await SUPA.from("players").update({ xi, status: "ready_sim" }).eq("id", p.id).eq("room_id", ROOM);
      p.xi = xi;
    }
  }
  // Only a manager holding a full XI takes a league seat. The simulation ignores
  // anyone short of eleven, so counting them here would leave the league nine
  // teams strong — an odd number, which has no 14-round fixture list at all.
  const humans = (existing || []).filter((p) => !p.is_bot && Array.isArray(p.xi) && p.xi.length >= 11);
  const need = Math.max(0, LEAGUE_SIZE - humans.length);

  if (need) {
    const bots = botTeamsByStrength().slice(0, need);
    // A part-filled league has no 14-game slate — better to say so than to start
    // a season where half the table plays nothing.
    if (bots.length < need) {
      throw new Error(`only ${humans.length + bots.length} of ${LEAGUE_SIZE} league seats could be filled`);
    }
    if (bots.length) {
      await SUPA.from("players").upsert(
        bots.map((t, i) => ({
          id: botId(i), room_id: ROOM, username: t.name,
          is_host: false, is_bot: true, bot_team: t.name,
          status: "done", xi: null, sim_ready_step: -1,
        })),
        { onConflict: "id" }
      );
      // Sweep any bot that isn't one of these seats — randomly-named strays left
      // by a room that ran the old duplicating setup.
      await SUPA.from("players").delete()
        .eq("room_id", ROOM).eq("is_bot", true)
        .not("id", "in", `(${bots.map((_, i) => botId(i)).join(",")})`);
    }
  }

  // Start the shared progression from the top: kickoff vote, 14 rounds, then
  // the per-fixture knockout gates — all handled by sim-mp.js unchanged.
  await SUPA.from("players").update({ sim_ready_step: -1 }).eq("room_id", ROOM);
  await SUPA.from("rooms").update({ status: "league", sim_round: -1 }).eq("id", ROOM);
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
  renderPause();
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
  // Thirteen sets won't fit as labels, so each segment names itself on hover.
  $("setBar").innerHTML = order.map((id, i) => {
    const n = S.lots.filter((l) => l.setId === id).length;
    return `<span class="set-seg ${i < pos ? "is-done" : i === pos ? "is-live" : ""}" title="${esc(id)} · ${n} lots"></span>`;
  }).join("");
}

let lastLotIndex = -1;
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
  // Only animate when the hammer actually moves on — renderLot runs on every
  // poll and every bid, and re-triggering the entrance each time would strobe.
  const fresh = S.auction.lot_index !== lastLotIndex;
  lastLotIndex = S.auction.lot_index;
  card.className = "lot-card" + (fresh ? " is-new" : "");
  card.innerHTML = `
    <div class="lot-main">
      <h2 class="lot-name">${esc(lot.displayName)}</h2>
      <div class="lot-sub">${esc(lot.fr)} ${esc(lot.season)} &middot; base <b>${money(lot.basePrice)}</b></div>
      <div class="lot-badges">
        <span class="badge ${badge.cls}">${badge.label}</span>
        ${lot.isWk ? '<span class="badge wk">Wicketkeeper</span>' : ""}
        ${lot.isOverseas ? '<span class="badge overseas">Overseas</span>' : ""}
        <span class="badge stat">BAT ${lot.bat}</span>
        <span class="badge stat">BOWL ${lot.bowl}</span>
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

  if (isPaused()) { btn.disabled = true; btn.textContent = "Paused"; }
  else if (leading) { btn.disabled = true; btn.textContent = "You hold the bid"; }
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

function renderPause() {
  const paused = isPaused();
  const banner = $("pauseBanner");
  banner.hidden = !paused;
  if (paused) {
    $("pauseText").textContent = isHost()
      ? "You have the auction paused"
      : "Auction paused by the host";
  }
  const btn = $("pauseBtn");
  btn.hidden = !isHost();
  if (isHost()) {
    btn.textContent = paused ? "Resume Auction" : "Pause Auction";
    btn.classList.toggle("is-active", paused);
  }
}

// The ring sweeps from full to empty. Its total is captured the first time we
// see a given deadline, because the clock length varies — an opening bid gets
// longer than a bump, and an auto-pass shorter than either.
let ringDeadline = null;
let ringTotal = 1;

function renderTimer() {
  const ring = $("timerRing");
  const num = $("timerNum");
  if (isPaused()) {
    const banked = Number(S.auction.remaining_ms);
    num.textContent = Number.isFinite(banked) ? Math.max(0, Math.ceil(banked / 1000)) : "II";
    ring.className = "timer-ring is-paused";
    ringDeadline = null;
    return;
  }
  const ms = msLeft();
  if (ms == null || !currentLot()) {
    num.textContent = "—";
    ring.className = "timer-ring";
    ring.style.setProperty("--p", 0);
    ringDeadline = null;
    return;
  }
  // A fresh deadline snaps the ring back to full without animating, so a bid
  // that resets the clock doesn't look like the timer running backwards.
  const reset = S.auction.ends_at !== ringDeadline;
  if (reset) {
    ringDeadline = S.auction.ends_at;
    ringTotal = Math.max(1, ms);
  }
  const secs = Math.max(0, Math.ceil(ms / 1000));
  num.textContent = secs;
  ring.className = "timer-ring" +
    (secs <= 3 ? " is-crit" : secs <= 5 ? " is-warn" : "") +
    (reset ? " is-reset" : "");
  ring.style.setProperty("--p", Math.max(0, Math.min(100, (ms / ringTotal) * 100)).toFixed(1));
}

function nameOf(id) {
  const m = S.managers.find((x) => x.id === id);
  return m ? (m.username || "Manager") : "Manager";
}

// Work out where everyone stands, preferring stability over a fresh solve.
//   1. keep every player exactly where they already are
//   2. if a new signing won't fit, hold only the hand-placed slots and re-solve
//   3. if even those are unsatisfiable, start clean and say so
// The result is written back to S.order, so the layout is the same on the next
// render instead of shuffling every time the panel repaints.
// Best-effort seating for a squad the exact solver can't satisfy: most
// constrained first into a legal free slot, then anything left into any gap.
function looseLayout(squad) {
  console.warn("[auction] no legal XI arrangement — falling back to a loose order");
  const used = new Array(A.XI_SIZE).fill(false);
  const out = new Array(squad.length).fill(-1);
  const byOptions = squad
    .map((p, i) => ({ i, opts: A.eligibleSlots(p) }))
    .sort((a, b) => a.opts.length - b.opts.length);
  for (const { i, opts } of byOptions) {
    const s = opts.find((x) => !used[x]);
    if (s != null) { used[s] = true; out[i] = s; }
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i] >= 0) continue;
    const s = used.indexOf(false);
    if (s < 0) break;
    used[s] = true; out[i] = s;
  }
  return out;
}

// A refresh mid-auction shouldn't cost you the batting order you set. Stale
// names need no cleanup: squadLayout rebuilds S.order from the current squad
// every call, and pins are only consulted for players you still own.
const ORDER_KEY = `auction_order_${ROOM}_${PID}`;
function saveOrder() {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify({ order: S.order, pinned: [...S.pinned] }));
  } catch (_) {}
}
function loadOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(ORDER_KEY) || "null");
    if (saved && Array.isArray(saved.order)) {
      S.order = saved.order;
      S.pinned = new Set(Array.isArray(saved.pinned) ? saved.pinned : []);
    }
  } catch (_) {}
}

function squadLayout() {
  const squad = squadOf(PID);
  const at = (name) => S.order.indexOf(name);
  const pinsFor = (test) => {
    const pins = {};
    squad.forEach((p, i) => { const s = at(p.name); if (s >= 0 && test(p)) pins[i] = s; });
    return pins;
  };

  let slots = A.assignSlots(squad, pinsFor(() => true));
  if (!slots) slots = A.assignSlots(squad, pinsFor((p) => S.pinned.has(p.name)));
  if (!slots) {
    if (S.pinned.size) {
      S.pinned.clear();
      toast("Batting order rebuilt to fit the new signing");
    }
    slots = A.assignSlots(squad);
  }
  // Unreachable while every purchase is gated on squadFeasible, but if it ever
  // happens, seat people where they legally can go and only then dump the
  // remainder into whatever is free — an approximate order beats inventing an
  // illegal one, and beats a blank panel hiding players you paid for.
  if (!slots) slots = looseLayout(squad);

  S.order = new Array(A.XI_SIZE).fill(null);
  squad.forEach((p, i) => {
    const s = slots[i];
    if (s >= 0 && s < A.XI_SIZE) S.order[s] = p.name;
  });
  return squad;
}

function renderSquad() {
  const squad = squadLayout();
  const prices = {};
  myBuys().forEach((b) => { if (b.player) prices[b.player.name] = b.price; });
  const byName = {};
  squad.forEach((p) => (byName[p.name] = p));

  $("squadCount").textContent = `${squad.length}/11`;
  $("overseasCount").textContent = `${squad.filter((p) => p.isOverseas).length}/4 overseas`;
  const left = A.XI_SIZE - squad.length;
  $("maxBidVal").textContent = left > 0 ? `max ${money(A.maxBid(purseOf(PID), left))}` : "squad complete";
  $("purseVal").textContent = money(purseOf(PID));
  const hint = $("squadHint");
  if (hint) hint.hidden = squad.length < 2;

  // Repainting mid-drag would tear the list out from under the pointer and the
  // drop would never land — the 2.5s poll alone would make reordering a coin flip.
  if (dragFrom !== null) return;

  // Slot numbers are tinted by phase of the innings: top order, middle, bowling.
  const phase = (i) => (i < 3 ? "ph-top" : i < 7 ? "ph-middle" : "ph-bowl");

  $("squadList").innerHTML = SLOT_LABELS.map((label, i) => {
    const p = byName[S.order[i]];
    if (!p) {
      return `<li data-slot="${i}"><span class="slot-num ${phase(i)}">${i + 1}</span>
        <span class="slot-body"><span class="slot-role">${label}</span>
        <span class="slot-player" style="color:#5f5f5f">Empty</span></span></li>`;
    }
    const price = prices[p.name];
    return `<li class="is-filled" data-slot="${i}" draggable="true"><span class="slot-num ${phase(i)}">${i + 1}</span>
      <span class="slot-body">
        <span class="slot-role">${label}</span>
        <span class="slot-player">${esc(p.displayName)}${p.isWk ? " (wk)" : ""}</span>
        <span class="slot-paid">${price != null ? money(price) : ""}</span>
      </span>
      <span class="slot-ovr ${ovrClass(p.ovr)}">${p.ovr}</span></li>`;
  }).join("");
}

// ---------- drag to reorder ----------
// Same rules as the draft board: a player can only be dropped into a slot their
// role allows, and on a swap the displaced player must be legal in the slot
// being vacated. Both moves are hand-placed from then on, so a later signing
// gets fitted around them rather than shunting them aside.
let dragFrom = null;

function moveSlot(from, to) {
  if (from === to || !Number.isInteger(from) || !Number.isInteger(to)) return;
  const byName = {};
  squadOf(PID).forEach((p) => (byName[p.name] = p));
  const moving = byName[S.order[from]];
  if (!moving) return;
  const displaced = byName[S.order[to]];

  if (!A.eligibleSlots(moving).includes(to)) {
    toast(`${moving.displayName} can't bat at ${to + 1}`, "error");
    return;
  }
  if (displaced && !A.eligibleSlots(displaced).includes(from)) {
    toast(`${displaced.displayName} can't bat at ${from + 1}`, "error");
    return;
  }

  S.order[to] = moving.name;
  S.order[from] = displaced ? displaced.name : null;
  S.pinned.add(moving.name);
  if (displaced) S.pinned.add(displaced.name);
  saveOrder();
  renderSquad();
}

// Delegated, because the list is rebuilt from innerHTML on every poll — per-row
// listeners would be re-attached several times a second.
function wireSquadDrag() {
  const list = $("squadList");
  const rowAt = (e) => e.target.closest("li[data-slot]");
  const clearMarks = () =>
    list.querySelectorAll(".is-dragging, .drag-over")
        .forEach((el) => el.classList.remove("is-dragging", "drag-over"));

  list.addEventListener("dragstart", (e) => {
    const li = rowAt(e);
    if (!li || !li.classList.contains("is-filled")) return;
    dragFrom = Number(li.dataset.slot);
    li.classList.add("is-dragging");
    try {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(dragFrom)); // Firefox needs a payload
    } catch (_) {}
  });
  list.addEventListener("dragend", () => { dragFrom = null; clearMarks(); renderSquad(); });
  list.addEventListener("dragover", (e) => {
    const li = rowAt(e);
    if (!li || dragFrom === null || Number(li.dataset.slot) === dragFrom) return;
    e.preventDefault();
    li.classList.add("drag-over");
  });
  list.addEventListener("dragleave", (e) => {
    const li = rowAt(e);
    if (li) li.classList.remove("drag-over");
  });
  list.addEventListener("drop", (e) => {
    e.preventDefault();
    const li = rowAt(e);
    const from = dragFrom;
    dragFrom = null;
    clearMarks();
    if (li && from !== null) moveSlot(from, Number(li.dataset.slot));
  });
}

function renderManagers() {
  const lot = currentLot();
  $("mgrList").innerHTML = S.managers.map((m) => {
    const sq = squadOf(m.id);
    const full = sq.length >= A.XI_SIZE;
    const live = lot && A.canBidOn(managerView(m), lot, askingPrice());
    const left = purseOf(m.id);
    const pct = Math.max(0, Math.min(100, (left / A.PURSE) * 100));
    return `<li class="${m.id === PID ? "is-you " : ""}${full ? "is-full" : ""}">
      <span class="m-name">${esc(m.username || "Manager")}${m.id === PID ? " (you)" : ""}</span>
      <span class="m-squad">${sq.length}/11</span>
      <span class="m-purse">${money(left)}</span>
      <span class="m-bar"><span style="width:${pct.toFixed(1)}%"></span></span>
      ${live ? '<span class="m-bidding">still bidding</span>' : ""}
    </li>`;
  }).join("");
}

// Only the genuinely new row slides in. The feed is rebuilt from innerHTML on
// every 2.5s poll, so animating every row would make the whole list twitch on a
// loop for no reason.
let lastFeedTop = null;
function renderFeed() {
  const recent = S.buys.slice().sort((a, b) => b.lot_index - a.lot_index).slice(0, 12);
  const topIdx = recent.length ? recent[0].lot_index : null;
  const fresh = topIdx !== null && topIdx !== lastFeedTop && lastFeedTop !== null;
  lastFeedTop = topIdx;

  $("soldFeed").innerHTML = recent.map((b, i) => {
    const anim = i === 0 && fresh ? " is-new" : "";
    if (!b.buyer) {
      const lot = S.lots[b.lot_index];
      return `<div class="sold-row is-unsold${anim}"><span class="s-name">${esc(lot ? lot.displayName : "Lot")}</span>
        <span class="s-buyer">unsold</span></div>`;
    }
    const p = b.player || {};
    return `<div class="sold-row${anim}"><span class="s-name">${esc(p.displayName || p.name)}</span>
      <span class="s-buyer">${esc(nameOf(b.buyer))}</span>
      <span class="s-price">${money(b.price)}</span></div>`;
  }).join("");
}

// ---------- wiring ----------
wireSquadDrag();
$("bidBtn").addEventListener("click", placeBid);
$("skipBtn").addEventListener("click", voteSkip);
$("pauseBtn").addEventListener("click", togglePause);
$("proceedBtn").addEventListener("click", proceed);
// Space bar bids — auctions are fast and the mouse is slow.
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.repeat) { e.preventDefault(); if (iCanBid()) placeBid(); }
});

boot();
