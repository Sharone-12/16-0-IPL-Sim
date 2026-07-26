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
    { id: "marquee", label: "Marquee", perTeam: 2 },
    { id: "openersA", label: "Openers — Tier A", perTeam: 1.5 },
    { id: "wicketkeepers", label: "Wicketkeepers", perTeam: 2 },
    { id: "middleA", label: "Middle Order — Tier A", perTeam: 2.5 },
    { id: "allrounders", label: "All-Rounders", perTeam: 2 },
    { id: "bowlersA", label: "Bowlers — Tier A", perTeam: 3 },
    { id: "finishers", label: "Finishers", perTeam: 1.5 },
    { id: "openersB", label: "Openers — Tier B", perTeam: 2 },
    { id: "middleB", label: "Middle Order — Tier B", perTeam: 2.5 },
    { id: "bowlersB", label: "Bowlers — Tier B", perTeam: 3 },
  ];

  const TIER_A_MIN = 85;

  // Which set a player belongs to. Order matters: marquee wins over everything,
  // then keeper, then all-rounder, then specialist bowler, then batting order.
  function setIdFor(p) {
    if (p.ovr >= 92) return "marquee";
    if (p.isWk) return "wicketkeepers";
    if (p.primaryRole === "All-Rounder") return "allrounders";
    if (p.primaryRole === "Bowler") return p.ovr >= TIER_A_MIN ? "bowlersA" : "bowlersB";
    if (p.battingOrder === "Opener") return p.ovr >= TIER_A_MIN ? "openersA" : "openersB";
    if (p.battingOrder === "Finisher") return "finishers";
    return p.ovr >= TIER_A_MIN ? "middleA" : "middleB";
  }

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

  // Per-team quota → absolute count, clamped to what actually exists.
  function quotaFor(set, teams) {
    return Math.max(1, Math.ceil(set.perTeam * teams));
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

    // Bucket by set, best first — quotas then skim the top of each bucket.
    const buckets = {};
    for (const set of SETS) buckets[set.id] = [];
    for (const p of unique) buckets[setIdFor(p)].push(p);
    for (const id of Object.keys(buckets)) buckets[id].sort((a, b) => b.ovr - a.ovr);

    const lots = [];
    const setSummary = [];
    for (const set of SETS) {
      const want = quotaFor(set, teams);
      const got = buckets[set.id].slice(0, want);
      setSummary.push({
        id: set.id,
        label: set.label,
        wanted: want,
        got: got.length,
        available: buckets[set.id].length,
      });
      got.forEach((p) => {
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
          setId: set.id,
          setLabel: set.label,
          basePrice: basePriceFor(p.ovr),
        });
      });
    }

    return {
      lots,
      sets: setSummary,
      purse: PURSE,
      shortfalls: checkSupply(lots, teams),
    };
  }

  // Can every manager legally fill an XI from this pool? Checks the binding
  // constraints from SLOT_LABELS: 2 openers, 4 middle-ish, 4 bowlers, 1 keeper
  // in the top 7 — per team. Returns [] when the pool is safe.
  function checkSupply(lots, teams) {
    const count = (fn) => lots.filter(fn).length;
    const openers = count((p) => eligibleSlots(p).some((s) => s <= 2) && p.battingOrder === "Opener");
    const middle = count((p) => p.battingOrder === "Middle Order" && p.primaryRole !== "Bowler");
    const bowlers = count((p) => p.primaryRole === "Bowler");
    const keepers = count((p) => p.isWk && eligibleSlots(p).some((s) => s <= 6));

    const need = [
      ["openers", openers, 2 * teams],
      ["middle order", middle, 4 * teams],
      ["bowlers", bowlers, 4 * teams],
      ["wicketkeepers (top 7)", keepers, 1 * teams],
    ];
    return need
      .filter(([, have, want]) => have < want)
      .map(([what, have, want]) => ({ what, have, want }));
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
    SETS,
    basePriceFor,
    bidIncrement,
    nextBid,
    formatMoney,
    setIdFor,
    eligibleSlots,
    canFillSlot7,
    bestSeasonPerPlayer,
    buildAuctionPool,
    checkSupply,
    maxBid,
  };
});
