// ===================== 16-0 — Auction data layer =====================
// Turns the calibrated player database into an IPL-style auction: ordered sets,
// base prices, and a pool sized so every manager in the room can legally fill
// an XI. Pure functions, no DOM, no network — so it runs identically in the
// browser and under Node for the test harness (auction_data.test.js).
//
// WHY A QUOTA PER SET RATHER THAN A TOP-N CUT:
// the obvious "auction the best 200 players" is broken for this game. Finishers
// and middle-order bats carry lower OVR than bowlers and openers, so a global
// rating cut starves them — a top-220 cut yields 26 middle-order bats (10 teams
// need ~40) and just 2 of the 24 finishers in the whole database. Managers then
// physically cannot fill slots 3-6. So the pool is filled per set, to a quota
// derived from what an XI actually requires.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AuctionData = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- money ----------
  // Everything is integer LAKH internally (₹1 crore = 100 lakh) so there is no
  // floating-point drift on purses or bids. Only the display layer converts.
  const LAKH_PER_CRORE = 100;
  const PURSE = 100 * LAKH_PER_CRORE; // ₹100 crore, as per the real auction

  // Base price by rating tier, mirroring the game's existing OVR bands.
  const BASE_PRICE_TIERS = [
    { min: 92, price: 2 * LAKH_PER_CRORE },
    { min: 89, price: 150 },
    { min: 85, price: 125 },
    { min: 81, price: 100 },
    { min: 75, price: 75 },
    { min: 0, price: 50 },
  ];
  const MIN_BASE = 50;

  function basePriceFor(ovr) {
    const tier = BASE_PRICE_TIERS.find((t) => ovr >= t.min);
    return tier ? tier.price : MIN_BASE;
  }

  // Bid increments climb with the price, like the real auction.
  function bidIncrement(current) {
    if (current < 100) return 10;
    if (current < 200) return 20;
    if (current < 500) return 25;
    return 50;
  }

  function nextBid(current) {
    return current + bidIncrement(current);
  }

  function formatMoney(lakh) {
    if (lakh == null || Number.isNaN(lakh)) return "—";
    const cr = lakh / LAKH_PER_CRORE;
    return `₹${cr % 1 === 0 ? cr.toFixed(0) : cr.toFixed(2)} Cr`;
  }

  // ---------- sets ----------
  // The pool is CURATED, not computed: ipl_auction_career_final.csv carries the
  // set, tier, calibrated OVR and base price for every lot. This is the running
  // order those sets come under the hammer in — Marquee first, then each tier
  // cycling through the roles so no role ever runs as one long block.
  const SET_ORDER = [
    "Marquee",
    "Batters - A", "Wicketkeepers - A", "All-Rounders - A", "Bowlers - A",
    "Batters - B", "Wicketkeepers - B", "All-Rounders - B", "Bowlers - B",
    "Batters - C", "Wicketkeepers - C", "All-Rounders - C", "Bowlers - C",
  ];

  // Retained only for the legacy computed-pool path used by older tests.
  const SETS = [
    { id: "marquee", label: "Marquee" },
    { id: "openersA", label: "Openers — Tier A" },
    { id: "wicketkeepers", label: "Wicketkeepers" },
    { id: "middleA", label: "Middle Order — Tier A" },
    { id: "allrounders", label: "All-Rounders" },
    { id: "bowlersA", label: "Bowlers — Tier A" },
    { id: "finishers", label: "Finishers" },
    { id: "openersB", label: "Openers — Tier B" },
    { id: "middleB", label: "Middle Order — Tier B" },
    { id: "bowlersB", label: "Bowlers — Tier B" },
  ];

  const TIER_A_MIN = 85;
  const MARQUEE_MIN = 92;

  // Selection is quota'd by ROLE, never by the A/B display tier. Quota'ing the
  // tiers separately caused a rating inversion — Bowlers A capped at 30 of 60
  // dropped Rabada (87) while Bowlers B admitted its top 30 at ~84, so a worse
  // bowler made the auction and a better one did not. Roles are the real
  // constraint (an XI needs openers/bowlers/keepers), so roles carry the quota
  // and A/B is applied afterwards purely to order the lots.
  const ROLE_QUOTAS = [
    { id: "opener", perTeam: 3.5 },
    { id: "middle", perTeam: 5 },
    { id: "finisher", perTeam: 1.5 },
    { id: "wk", perTeam: 2 },
    { id: "allrounder", perTeam: 2 },
    { id: "bowler", perTeam: 6 },
  ];
  const MARQUEE_PER_TEAM = 2;
  // Smallest room the catalogue is ever sized for. A 2-player auction gets the
  // same breadth of players as a 6-player one; only the scarcity differs.
  const DEFAULT_MIN_DEPTH = 6;

  // The player's role for quota purposes — independent of rating.
  function roleFor(p) {
    if (p.isWk) return "wk";
    if (p.primaryRole === "All-Rounder") return "allrounder";
    if (p.primaryRole === "Bowler") return "bowler";
    if (p.battingOrder === "Opener") return "opener";
    if (p.battingOrder === "Finisher") return "finisher";
    return "middle";
  }

  // Which auction set a player is presented in.
  //   isMarquee — decided during pool construction (top N overall), so a 92+
  //     player who misses the marquee cut is NOT dropped, they appear in their
  //     own role set instead.
  //   tierA — also decided during construction, by splitting each role's
  //     SELECTED players at their median rather than at a fixed OVR line. A
  //     fixed line put all 60 chosen bowlers in Tier A and left Tier B empty,
  //     giving 60 bowler lots back to back — a quarter of the auction with
  //     nothing else to bid on. A median split keeps both blocks populated and
  //     separated in the running order.
  function setIdFor(p, isMarquee, tierA) {
    if (isMarquee) return "marquee";
    if (tierA === undefined) tierA = p.ovr >= TIER_A_MIN;
    switch (roleFor(p)) {
      case "wk": return "wicketkeepers";
      case "allrounder": return "allrounders";
      case "bowler": return tierA ? "bowlersA" : "bowlersB";
      case "opener": return tierA ? "openersA" : "openersB";
      case "finisher": return "finishers";
      default: return tierA ? "middleA" : "middleB";
    }
  }

  // Roles presented across two tiered sets, so their block is split in the order.
  const SPLIT_ROLES = new Set(["bowler", "opener", "middle"]);

  // Which XI slots a player can legally occupy — mirrors draft.js eligibleSlots
  // so the pool is validated against the same rules the XI builder enforces.
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
    if (canFillSlot7(p) && !has6) slots = slots.concat([6]);
    else if (!canFillSlot7(p) && has6) slots = slots.filter((s) => s !== 6);
    return slots;
  }

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

  // ---------- pool construction ----------

  // Collapse player-seasons into ONE lot per player. An auction cannot offer
  // Gayle 2011 and Gayle 2012 as rival lots, so each player enters at their
  // best season inside the room's era window.
  function bestSeasonPerPlayer(players, eraFrom, eraTo) {
    const best = new Map();
    for (const p of players) {
      const season = Number(p.season);
      if (Number.isFinite(season) && (season < eraFrom || season > eraTo)) continue;
      const prev = best.get(p.name);
      if (!prev || p.ovr > prev.ovr) best.set(p.name, p);
    }
    return [...best.values()];
  }

  // Per-team quota → absolute count.
  function quotaFor(perTeam, teams) {
    return Math.max(1, Math.ceil(perTeam * teams));
  }

  // Row mappings for the two CSVs, defined once so the lobby, the room and the
  // test harness cannot drift apart on column names.
  function normalizeAuctionRow(r) {
    return {
      name: r.Player_Name,
      displayName: r.Display_Name || r.Player_Name,
      season: r.Season,
      fr: r.Franchise,
      ovr: +r.OVR || 0,
      careerOvr: +r.Career_OVR || 0,
      tier: r.Tier,
      status: r.Status,
      auctionSet: r.Auction_Set,
      auctionRole: r.Auction_Role,
      basePrice: Math.round(parseFloat(r.Base_Price_Cr || 0) * LAKH_PER_CRORE),
      isWk: r.Is_Wicketkeeper === "1",
      isOverseas: r.Nationality === "Overseas",
    };
  }

  function normalizeMasterRow(r) {
    return {
      name: r.Player_Name,
      season: r.Season,
      frFull: r.Franchise_Full,
      ovr: Math.min(+r.OVR || 70, 100),
      bat: +r.Bat_Rat || +r.OVR || 70,
      bowl: +r.Bowl_Rat || +r.OVR || 60,
      primaryRole: r.Primary_Role,
      battingOrder: r.Batting_Order,
    };
  }

  // ---------- curated pool (ipl_auction_career_final.csv) ----------
  // The auction file is authoritative for everything the AUCTION cares about:
  // which set a player is in, their tier, their calibrated OVR and their base
  // price. It carries no Batting_Order / Bat_Rat / Bowl_Rat, so those are joined
  // from ipl_master_calibrated.csv on (Player_Name, Season) — a join verified to
  // cover all 322 rows exactly.
  //
  // TWO RATING SCALES, DELIBERATELY:
  //   ovr    — the auction file's calibrated rating. Drives the card, the tier
  //            and the base price. Runs about 5 points below the master scale.
  //   simOvr/bat/bowl — master's ratings, handed to the simulation untouched.
  // They are kept apart on purpose. Bot franchises are built from master, so
  // feeding the compressed scale into human squads alone would quietly weaken
  // every human team, and would invalidate the 100k-season balance tuning the
  // match engine was calibrated against.
  function buildCuratedPool(auctionRows, masterRows, opts) {
    const teams = Math.max(1, Number(opts && opts.teams) || 10);
    const master = new Map();
    for (const m of masterRows || []) {
      master.set(`${String(m.name || "").trim()}|${String(m.season || "").trim()}`, m);
    }

    const lots = [];
    const unmatched = [];
    for (const r of auctionRows || []) {
      if (!r.name) continue;
      const m = master.get(`${String(r.name).trim()}|${String(r.season).trim()}`);
      if (!m) { unmatched.push(r.name); continue; }
      lots.push({
        name: r.name,
        displayName: r.displayName || r.name,
        season: r.season,
        fr: r.fr,
        frFull: m.frFull || r.fr,
        // auction-facing
        ovr: r.ovr,
        careerOvr: r.careerOvr,
        tier: r.tier,
        status: r.status,
        basePrice: r.basePrice,
        setId: r.auctionSet,
        setLabel: r.auctionSet,
        auctionRole: r.auctionRole,
        // simulation-facing (master scale — see note above)
        simOvr: m.ovr,
        bat: m.bat,
        bowl: m.bowl,
        primaryRole: m.primaryRole,
        battingOrder: m.battingOrder,
        isWk: r.isWk,
        isOverseas: r.isOverseas,
      });
    }

    // Order by the canonical running order; anything with an unrecognised set
    // is appended rather than dropped, so a new set in the CSV still shows up.
    const rank = (id) => {
      const i = SET_ORDER.indexOf(id);
      return i === -1 ? SET_ORDER.length : i;
    };
    lots.sort((a, b) => rank(a.setId) - rank(b.setId) || b.ovr - a.ovr ||
      String(a.name).localeCompare(String(b.name)));

    const seen = [];
    for (const l of lots) {
      const row = seen.find((s) => s.id === l.setId);
      if (row) row.got++;
      else seen.push({ id: l.setId, label: l.setLabel, got: 1 });
    }

    return {
      lots,
      sets: seen,
      purse: PURSE,
      unmatched,
      shortfalls: checkSupply(lots, teams),
    };
  }

  /**
   * Build the ordered auction for a room.
   * @param players normalized players ({name, season, ovr, bat, bowl, primaryRole,
   *                battingOrder, isWk, isOverseas, fr, frFull})
   * @param opts    { teams, eraFrom, eraTo }
   * @returns { lots, sets, purse, shortfalls }
   */
  function buildAuctionPool(players, opts) {
    const teams = Math.max(1, Number(opts && opts.teams) || 10);
    const eraFrom = Number(opts && opts.eraFrom) || 2008;
    const eraTo = Number(opts && opts.eraTo) || 2026;

    // DEPTH IS NOT THE SAME AS SCARCITY. Quotas were originally scaled by team
    // count alone, which meant a two-manager room got 45 lots and a four-player
    // Marquee — no Dhoni, no Gill, no Raina. Those managers only need 22 players
    // between them, so a bigger catalogue costs them nothing but choice. Sizing
    // therefore uses a FLOOR: small rooms get the same breadth as a mid-size
    // one, while scarcity still comes from real demand (11 x teams).
    const depth = Math.max(teams, Number(opts && opts.minDepth) || DEFAULT_MIN_DEPTH);

    const unique = bestSeasonPerPlayer(players, eraFrom, eraTo);

    // 1) Marquee: the very best overall, capped so it stays a showcase. Anyone
    //    rated 92+ who misses this cut is NOT dropped — step 2 picks them up in
    //    their own role set, exactly as the real auction does.
    const byOvr = [...unique].sort((a, b) => b.ovr - a.ovr || a.name.localeCompare(b.name));
    const marqueeCount = Math.min(
      quotaFor(MARQUEE_PER_TEAM, depth),
      byOvr.filter((p) => p.ovr >= MARQUEE_MIN).length
    );
    const marquee = new Set(byOvr.slice(0, marqueeCount).map((p) => p.name));

    // 2) Fill each ROLE to its quota, best first, from everyone not already
    //    marquee. Because the quota is per role, a player can never be cut while
    //    a lower-rated player of the same role is admitted.
    const selected = byOvr.filter((p) => marquee.has(p.name));
    const roleAvailable = {};
    const tierA = new Set(); // names presented in the Tier A half of their role
    for (const role of ROLE_QUOTAS) {
      const pool = byOvr.filter((p) => !marquee.has(p.name) && roleFor(p) === role.id);
      roleAvailable[role.id] = pool.length;
      const take = pool.slice(0, quotaFor(role.perTeam, depth));
      selected.push(...take);
      // Split this role's chosen players at their own median (they are already
      // sorted best-first), so both tier sets are populated and the role's lots
      // arrive as two separated blocks instead of one long slog.
      if (SPLIT_ROLES.has(role.id)) {
        take.slice(0, Math.ceil(take.length / 2)).forEach((p) => tierA.add(p.name));
      }
    }

    // 2b) Guarantee the one signing that can actually strand a manager. A
    // manager who spends all four overseas places before buying a keeper needs
    // an INDIAN keeper, and in a small room the keeper quota can come back
    // almost entirely overseas. Top the pool up so there is always one per team.
    const chosen = new Set(selected.map((p) => p.name));
    const indianKeepers = selected.filter((p) => p.isWk && !p.isOverseas).length;
    if (indianKeepers < teams) {
      const extra = byOvr.filter((p) => p.isWk && !p.isOverseas && !chosen.has(p.name));
      for (const p of extra.slice(0, teams - indianKeepers)) {
        selected.push(p);
        chosen.add(p.name);
      }
    }

    // 3) Order the chosen players into their display sets.
    const bySet = {};
    for (const set of SETS) bySet[set.id] = [];
    for (const p of selected) {
      bySet[setIdFor(p, marquee.has(p.name), tierA.has(p.name))].push(p);
    }
    for (const id of Object.keys(bySet)) bySet[id].sort((a, b) => b.ovr - a.ovr);

    const lots = [];
    const setSummary = [];
    for (const set of SETS) {
      const members = bySet[set.id];
      setSummary.push({ id: set.id, label: set.label, got: members.length });
      members.forEach((p) => {
        lots.push({
          name: p.name,
          displayName: p.displayName || p.name,
          season: p.season,
          fr: p.fr,
          frFull: p.frFull,
          ovr: p.ovr,
          bat: p.bat,
          bowl: p.bowl,
          primaryRole: p.primaryRole,
          battingOrder: p.battingOrder,
          isWk: p.isWk,
          isOverseas: p.isOverseas,
          role: roleFor(p),
          setId: set.id,
          setLabel: set.label,
          basePrice: basePriceFor(p.ovr),
        });
      });
    }

    return {
      lots,
      sets: setSummary,
      roleAvailable,
      purse: PURSE,
      shortfalls: checkSupply(lots, teams),
    };
  }

  const MAX_OVERSEAS = 4; // per XI, same rule as the draft

  // Can every manager legally fill an XI from this pool? Checks the binding
  // constraints from SLOT_LABELS — 2 openers, 4 middle-ish, 4 bowlers, 1 keeper
  // in the top 7, per team — AND the overseas cap, which limits each XI to 4
  // overseas players and therefore demands at least 7 Indians per team.
  // Returns [] when the pool is safe.
  function checkSupply(lots, teams) {
    const count = (fn) => lots.filter(fn).length;
    const isOpener = (p) => p.battingOrder === "Opener";
    const isMiddle = (p) => p.battingOrder === "Middle Order" && p.primaryRole !== "Bowler";
    const isBowler = (p) => p.primaryRole === "Bowler";
    const isKeeper = (p) => p.isWk && eligibleSlots(p).some((s) => s <= 6);

    const need = [
      ["openers", count(isOpener), 2 * teams],
      ["middle order", count(isMiddle), 4 * teams],
      ["bowlers", count(isBowler), 4 * teams],
      ["wicketkeepers (top 7)", count(isKeeper), 1 * teams],
      // Overseas cap: every team needs at least 11 - 4 = 7 Indians.
      ["indian players", count((p) => !p.isOverseas), (11 - MAX_OVERSEAS) * teams],
      // A manager who spends all four overseas slots before signing a keeper can
      // only be rescued by an INDIAN keeper. Simulation showed this is the one
      // way a squad actually gets stranded, so the pool must guarantee one per
      // team even in the worst case.
      ["indian wicketkeepers", count((p) => p.isWk && !p.isOverseas), teams],
    ];

    const short = need
      .filter(([, have, want]) => have < want)
      .map(([what, have, want]) => ({ what, have, want }));

    // Per role, the league can cover demand from Indians plus at most
    // MAX_OVERSEAS * teams overseas signings. Necessary condition, not
    // sufficient (true feasibility is a matching problem), but it catches the
    // realistic failure: a role that is overwhelmingly overseas.
    const overseasBudget = MAX_OVERSEAS * teams;
    [
      ["openers", isOpener, 2 * teams],
      ["middle order", isMiddle, 4 * teams],
      ["bowlers", isBowler, 4 * teams],
    ].forEach(([what, fn, want]) => {
      const indian = count((p) => fn(p) && !p.isOverseas);
      const overseas = count((p) => fn(p) && p.isOverseas);
      const reachable = indian + Math.min(overseas, overseasBudget);
      if (reachable < want) {
        short.push({ what: what + " (within overseas cap)", have: reachable, want });
      }
    });

    return short;
  }

  // The most this manager can bid and still afford to fill every empty slot at
  // base price. Without this, people strand themselves broke with holes in the XI.
  function maxBid(purseLeft, slotsRemaining) {
    const reserveFor = Math.max(0, slotsRemaining - 1);
    return purseLeft - reserveFor * MIN_BASE;
  }

  // ---------- squad legality ----------
  const XI_SIZE = 11;
  const TOP_ORDER_SLOTS = 7; // a keeper must end up in slots 0-6

  // Exact assignment of players to distinct XI slots, by backtracking over the
  // most-constrained player first. Greedy placement is not enough: buying an
  // opener can force an earlier opener out of slot 2, and only a full search
  // sees that. Returns a slot-per-player array, or null if no arrangement fits.
  //
  // `pins` optionally fixes some players in place ({ playerIndex: slot }) and
  // fits everyone else around them — that is how a manually dragged batting
  // order survives the next signing instead of being recomputed from scratch. A
  // pin that has become illegal or collides is dropped rather than throwing,
  // because the squad changes under the manager's feet as lots are won.
  function assignSlots(players, pins) {
    const used = new Array(XI_SIZE).fill(false);
    const out = new Array(players.length).fill(-1);
    const loose = [];
    for (let i = 0; i < players.length; i++) {
      const s = pins && pins[i] != null ? Number(pins[i]) : null;
      if (s == null || !Number.isInteger(s) || s < 0 || s >= XI_SIZE ||
          used[s] || !eligibleSlots(players[i]).includes(s)) {
        loose.push(i);
        continue;
      }
      used[s] = true;
      out[i] = s;
    }
    const order = loose
      .map((i) => ({ i, opts: eligibleSlots(players[i]) }))
      .sort((a, b) => a.opts.length - b.opts.length);

    function place(k) {
      if (k === order.length) return true;
      const { i, opts } = order[k];
      for (const s of opts) {
        if (used[s]) continue;
        used[s] = true;
        out[i] = s;
        if (place(k + 1)) return true;
        used[s] = false;
        out[i] = -1;
      }
      return false;
    }
    return place(0) ? out : null;
  }

  // Could this squad still become a legal XI? Checks slot assignment, the
  // overseas cap, and that a keeper can still reach the top order.
  function squadFeasible(players) {
    if (players.length > XI_SIZE) return false;
    if (players.filter((p) => p.isOverseas).length > MAX_OVERSEAS) return false;

    const slots = assignSlots(players);
    if (!slots) return false;

    // Keeper rule. Once the XI is full a keeper must actually be in the top 7;
    // before that it is enough that a top-order slot is still free for one.
    const keeperUp = players.some((p, i) => p.isWk && slots[i] < TOP_ORDER_SLOTS);
    if (keeperUp) return true;
    if (players.length >= XI_SIZE) return false;
    const topUsed = slots.filter((s) => s < TOP_ORDER_SLOTS).length;
    return topUsed < TOP_ORDER_SLOTS;
  }

  // Can this manager add this player and still finish with a legal XI?
  function canAdd(squad, player) {
    if (squad.length >= XI_SIZE) return false;
    if (squad.some((p) => p.name === player.name)) return false;
    return squadFeasible(squad.concat([player]));
  }

  // ---------- bidding eligibility ----------
  // A manager may bid only if they can afford the price AND the player can
  // legally join their XI. This is what lets dead lots pass instantly instead
  // of burning a timer nobody is going to use.
  function canBidOn(manager, lot, price) {
    const squad = manager.squad || [];
    if (squad.length >= XI_SIZE) return false;
    if (maxBid(manager.purse, XI_SIZE - squad.length) < price) return false;
    return canAdd(squad, lot);
  }

  function eligibleBidders(managers, lot, price) {
    return managers.filter((m) => canBidOn(m, lot, price)).map((m) => m.id);
  }

  // Nobody in the room can bid — pass immediately rather than run the clock.
  function shouldAutoPass(managers, lot, price) {
    return eligibleBidders(managers, lot, price).length === 0;
  }

  // Every manager has a full XI — the auction is over, whatever lots remain.
  function isAuctionComplete(managers) {
    return managers.length > 0 && managers.every((m) => (m.squad || []).length >= XI_SIZE);
  }

  // Index of the first lot of the NEXT set — what the "Move to next set" vote
  // jumps to. Returns lots.length when the current set is the last one.
  function nextSetIndex(lots, fromIndex) {
    if (fromIndex >= lots.length) return lots.length;
    const current = lots[fromIndex].setId;
    let i = fromIndex;
    while (i < lots.length && lots[i].setId === current) i++;
    return i;
  }

  // ---------- mandatory-signing warnings ----------
  // What a manager MUST still buy to end up legal. Surfacing this is what stops
  // the one real stranding case: filling ten slots, spending all four overseas
  // places, and only then discovering the last signing has to be an Indian
  // keeper who may no longer be available.
  function outstandingNeeds(squad) {
    const needs = [];
    const slots = assignSlots(squad) || [];
    const hasKeeperUp = squad.some((p, i) => p.isWk && slots[i] < TOP_ORDER_SLOTS);
    const left = XI_SIZE - squad.length;
    if (!hasKeeperUp) {
      const overseasFull = squad.filter((p) => p.isOverseas).length >= MAX_OVERSEAS;
      needs.push({
        what: overseasFull ? "an INDIAN wicketkeeper" : "a wicketkeeper in the top 7",
        urgent: left <= 2,
        indianOnly: overseasFull,
      });
    }
    return needs;
  }

  // Accelerated round: hand any manager who is still short the best remaining
  // player they can legally take, at base price. Real auctions have exactly this
  // safety net, and without it a cautious manager who never bid on a keeper ends
  // the auction with ten players and an illegal XI.
  // `reserve` is the wider player database. The auction pool is only ~2x demand,
  // so a manager who reaches ten players with no keeper and no overseas budget
  // left can need an Indian keeper after every one in the pool has gone. Real
  // auctions bring in replacement players for exactly this; without a reserve to
  // draw on, that manager simply cannot field a legal XI.
  function fillShortSquads(managers, lots, takenNames, reserve) {
    const taken = new Set(takenNames || []);
    const awarded = [];
    const extras = (reserve || []).map((p) =>
      p.basePrice ? p : Object.assign({}, p, { basePrice: basePriceFor(p.ovr) })
    );
    // Neediest first, so scarce keepers go where they are mandatory.
    const order = [...managers].sort((a, b) => a.squad.length - b.squad.length);
    for (const m of order) {
      const squad = m.squad.slice();
      let purse = m.purse;
      while (squad.length < XI_SIZE) {
        // Prefer whatever satisfies an outstanding requirement first.
        const needsKeeper = outstandingNeeds(squad).length > 0;
        const usable = (list) =>
          list.filter((l) => !taken.has(l.name) && l.basePrice <= purse && canAdd(squad, l));
        let candidates = usable(lots);
        if (!candidates.length) candidates = usable(extras); // replacement players
        if (!candidates.length) break;
        const pick =
          (needsKeeper && candidates.find((l) => l.isWk)) ||
          candidates.reduce((best, l) => (l.ovr > best.ovr ? l : best), candidates[0]);
        taken.add(pick.name);
        squad.push(pick);
        purse -= pick.basePrice;
        awarded.push({ buyer: m.id, player: pick, price: pick.basePrice });
      }
      m.squad = squad;
      m.purse = purse;
    }
    return awarded;
  }

  // Who has to agree to skip the rest of a set: everyone who could still bid in
  // it. A manager with a full XI has no stake and is not asked — same rule the
  // knockouts use, where only the teams in the fixture vote.
  function skipSetVoters(managers, lots, fromIndex) {
    const end = nextSetIndex(lots, fromIndex);
    const remaining = lots.slice(fromIndex, end);
    return managers
      .filter((m) => remaining.some((lot) => canBidOn(m, lot, lot.basePrice)))
      .map((m) => m.id);
  }

  return {
    LAKH_PER_CRORE,
    PURSE,
    MIN_BASE,
    MAX_OVERSEAS,
    DEFAULT_MIN_DEPTH,
    SETS,
    basePriceFor,
    bidIncrement,
    nextBid,
    formatMoney,
    setIdFor,
    eligibleSlots,
    canFillSlot7,
    roleFor,
    bestSeasonPerPlayer,
    buildAuctionPool,
    buildCuratedPool,
    normalizeAuctionRow,
    normalizeMasterRow,
    SET_ORDER,
    checkSupply,
    maxBid,
    XI_SIZE,
    assignSlots,
    squadFeasible,
    canAdd,
    canBidOn,
    eligibleBidders,
    shouldAutoPass,
    isAuctionComplete,
    nextSetIndex,
    skipSetVoters,
    outstandingNeeds,
    fillShortSquads,
  };
});
