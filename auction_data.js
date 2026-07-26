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
  // Ordered exactly as they come under the hammer. Marquee first, then the
  // role sets split A/B by rating, then unsold players get an accelerated round.
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

    const unique = bestSeasonPerPlayer(players, eraFrom, eraTo);

    // 1) Marquee: the very best overall, capped so it stays a showcase. Anyone
    //    rated 92+ who misses this cut is NOT dropped — step 2 picks them up in
    //    their own role set, exactly as the real auction does.
    const byOvr = [...unique].sort((a, b) => b.ovr - a.ovr || a.name.localeCompare(b.name));
    const marqueeCount = Math.min(
      quotaFor(MARQUEE_PER_TEAM, teams),
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
      const take = pool.slice(0, quotaFor(role.perTeam, teams));
      selected.push(...take);
      // Split this role's chosen players at their own median (they are already
      // sorted best-first), so both tier sets are populated and the role's lots
      // arrive as two separated blocks instead of one long slog.
      if (SPLIT_ROLES.has(role.id)) {
        take.slice(0, Math.ceil(take.length / 2)).forEach((p) => tierA.add(p.name));
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

  return {
    LAKH_PER_CRORE,
    PURSE,
    MIN_BASE,
    MAX_OVERSEAS,
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
    checkSupply,
    maxBid,
  };
});
