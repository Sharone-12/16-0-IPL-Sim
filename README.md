<div align="center">

# 16-0

### Can you draft an IPL XI and go a perfect season unbeaten?

**[▶ Play live → 16-0game.vercel.app](https://16-0game.vercel.app)**

*A fantasy IPL draft-and-simulate game built on a hand-calibrated ratings engine, a tier-weighted draft wheel, and a ball-by-ball-flavoured match simulator — tuned against 50,000+ headless simulated seasons.*

</div>

---

## About

**16-0** drops you into the GM chair. Spin a slot machine of real IPL franchise-seasons (2008–2026), draft one player per spin into a structured XI, appoint a captain, then simulate a full league campaign + playoff bracket against the rest of the league. Win all 16 and you've gone **16-0** — a feat that, across tens of thousands of simulated seasons with *optimal* drafting, has **never** happened. It's the unicorn the whole game is named after.

No accounts. No installs. Pure vanilla JS, deployed on Vercel, backed by Supabase for a global leaderboard and verifiable share links.

---

## ✨ Feature highlights

- **🎰 Tier-weighted draft wheel** — a "gambler's curve" probability engine that dynamically re-weights franchise tiers as you hit them, so you can't just farm elite squads.
- **📊 Custom player ratings engine** — every one of **808 players across 3,353 player-seasons** carries a hand-calibrated **OVR / Batting / Bowling** rating derived from real per-season stats, with a reputation floor and seasonal-realism overrides.
- **🧮 Structured XI builder** — 11 role-locked slots (openers, middle order, finisher, bowlers), a reserved-keeper rule, a 4-overseas cap, and drag-to-reorder. Illegal placements are rejected with contextual toasts.
- **👑 Captaincy** — appoint a captain in the draft; the **(C)** badge follows the player through every roster, result card, and shared link.
- **⚙️ Two rating modes × three difficulties** — **Career** (each player's real season ratings) vs **Prime** (everyone at their peak season), each across **Easy / Normal / Hard** with a mode- *and* difficulty-aware handicap.
- **🏟️ Match simulator** — per-match pitch types (flat / balanced / bowling tracks), positional run distribution, realistic strike rates, hero-knock guarantees, NRR, Man of the Match, and end-of-season **Orange Cap / Purple Cap** awards.
- **🥇 Global leaderboard** — every completed season is ranked (wins → NRR) in Supabase; the result card shows your live **"rank #N of M."**
- **🔗 Verified share links** — a short-code permalink (`/v/<code>`) renders a tamper-evident card of your exact XI, record, and awards for anyone to view.
- **🧪 Headless simulation harness** — the entire draft + sim engine is ported to Node for **50k/100k-run** balance testing (see below).

---

## 🏗️ Architecture

A deliberately dependency-light **multi-page vanilla JS** app — no framework, no build step, no bundler. Each phase of the game is its own page with a focused script:

```
index.html        → Landing / mode + difficulty + era setup
  └ script.js

draft.html        → The draft: slot-machine spin, squad view, XI builder, captain
  └ draft.js       (tier-weighted spin engine, slot eligibility, drag-and-drop)

simulation.html   → Season sim: league table, fixtures, scorecards, playoffs, result card
  └ simulation.js  (match engine, standings, NRR, awards, leaderboard submit)

leaderboard.html  → Global rankings (Supabase, wins → NRR)

r.html            → Verified shared-result viewer (renders any /v/<short_code>)
  └ r.js

supabase_config.js → Supabase client (anon key)
report.js          → Shared "Report an Issue" modal
```

**Data layer:** `ipl_master_calibrated.csv` (the calibrated ratings database) + `mapped_names.csv` (display-name mapping for overseas players).

**Tooling / offline scripts:**
```
stress_test.js          → Faithful Node port of draft.js + simulation.js (no DOM)
stress_test_extra.js    → Extra strategy harnesses
run_50k_test.js         → 50,000-season Career balance run
run_50k_prime_easy.js   → 50,000-season Prime/Easy run
run_100k_test.js        → 100,000-season run
recalibrate.js          → Ratings recalibration pipeline
apply_overrides.py      → Manual per-player rating overrides
```

---

## 📐 The ratings engine

Ratings aren't pulled from anywhere — they're **computed and calibrated from real per-season performance**. Each player-season row carries batting/bowling/fielding/keeping stats, which feed a weighted model producing:

| Field | Meaning |
|---|---|
| `OVR` | Overall rating (≈ 50–95) |
| `Bat_Rat` | Batting rating |
| `Bowl_Rat` | Bowling rating |
| `Primary_Role` | Batsman / Bowler / All-Rounder / Wicketkeeper |
| `Batting_Order` | Opener / Middle Order / Finisher / Lower Order |

The calibration is intentionally **top-heavy and scarce** — of 3,353 player-seasons, only a handful crack the top tier:

```
OVR 92+  ████ ~13 player-seasons   (the genuine GOATs — gold tier)
OVR 89+  ████████ tier             (elite — blue tier)
OVR 85+  ███████████ tier          (very good — green tier)
OVR 60   ████████████████████████  (the floor — most journeymen)
```

A **reputation floor** keeps legends from cratering on an off-season, and per-player overrides fix edge cases the pure-stats model gets wrong. Drafting tiers (84 / 81 thresholds) drive the spin-wheel weighting.

---

## 🎰 Draft mechanics

- **Slot-machine spin** picks a `franchise × season`, weighted by a 3-tier system (`getSpinWeights`).
- **Gambler's curve:** every time you land a Tier-1 or Tier-2 squad, its weight decays — the wheel actively pushes back so you can't repeatedly spin the same elite teams.
- **11 structured slots** with eligibility rules (`eligibleSlots` / `canFillSlot7`): specialist bowlers are confined to the tail; the flexible slot 7 accepts finishers/keepers/all-rounders only.
- **Constraints:** max 4 overseas players, a wicketkeeper required in the top 7 (Normal/Hard), and an anti-softlock guarantee that every spun squad contains at least one draftable player.
- **Difficulty gates the draft too:** Easy = 3 re-spins, Normal = 1, Hard = 0 re-spins **and** blind ratings.

---

## ⚔️ Simulation engine

A full season is **14 league games + playoff bracket** (Qualifiers / Eliminator / Final) across two groups of five, with Your XI replacing one franchise.

- **Team strength** = weighted batting (46%) + bowling (42%) + depth (8%) + chemistry (4%), with a chemistry penalty for misused players (bowlers shoved up the order, openers buried, etc.).
- **Per-match pitch** (flat / balanced / bowling) shifts totals and strike rates for *both* innings.
- **Run distribution** spreads an innings total across the order by rating × position × variance, with hero-knock guarantees and a realistic per-batter innings cap — so the **Orange Cap lands around a believable ~700**, not 1,000+.
- **Dynamic catch-up:** weaker AI sides get a rank-based buff so the league stays competitive.
- **Awards & stats:** NRR, Man of the Match, Orange Cap (runs), Purple Cap (wickets), and a full downloadable/shareable result card.

---

## 🧪 Simulation & balance testing

The headline number this whole project is tuned around: the engine is **ported 1:1 to Node** so the draft + season can run **headless, tens of thousands of times**, to measure championship rates, win distributions, and player win-contribution — then feed difficulty tuning.

**Representative run — 1,000 optimal ("greedy") drafts, full season each:**

| Metric | Result |
|---|---|
| Championship rate | **~25%** |
| Top-4 rate | **~67%** |
| Average wins | **8.9 / 16** |
| Perfect **16-0** | **0 in 1,000** (and 0 across 50k+) |

```
Win distribution (greedy, 1,000 seasons):
  7  wins ██████ 16%
  10 wins █████  14%
  11 wins ██████ 15%
  15 wins        0.3%   ← best anyone managed
  16 wins        0.0%   ← the unicorn
```

This harness is what surfaced and fixed real balance bugs — e.g. the **Prime-mode opponent bug** (a season-field rewrite was silently gutting the AI squads, making Prime trivially winnable) and the inflated Orange Cap totals. Run it yourself:

```bash
node stress_test.js 1000        # 1,000 greedy + random drafts, full reporting
node run_50k_test.js            # 50,000 Career seasons
node run_50k_prime_easy.js      # 50,000 Prime / Easy seasons
```

---

## 🛠️ Tech stack

- **Frontend:** Vanilla HTML / CSS / JavaScript (zero framework, zero build)
- **Data:** CSV ratings database parsed client-side with PapaParse
- **Backend:** Supabase (Postgres) — leaderboard + verified share links
- **Hosting:** Vercel (with Web Analytics)
- **Sim/testing:** Node.js headless port of the live engine

---

## 🚀 Running locally

It's a static site — serve the folder with anything:

```bash
# clone, then from the project root:
python3 -m http.server 8000
# open http://localhost:8000
```

For the leaderboard/share features, copy `supabase_config.example.js` → `supabase_config.js` and add your Supabase URL + anon key.

---

## ⚖️ Disclaimer

16-0 is an independent, fan-made game inspired by **38-0.app**. It is not affiliated with, endorsed by, or associated with any cricket team, franchise, league, governing body, or ratings provider. All team names, player names, ratings, statistics and season data are used for informational, descriptive and editorial purposes only. No official logos, crests, player images, likenesses, or branding are used. All trademarks and intellectual property remain the property of their respective owners.
