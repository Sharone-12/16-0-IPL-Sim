// Escape-hatch inventory for the auction → simulation flow.
//
// WHAT THIS IS: a structural smoke check. It asserts that the code implementing
// each escape from a stuck state is still PRESENT. It does NOT prove any of them
// works — that belongs in auction_flow.test.js, which drives the real functions
// (see the pause-escape and kick sections there).
//
// It exists because these hatches are easy to delete by accident during a
// refactor and their absence is invisible until a live room freezes. Treat a
// pass as "nobody removed the fix", not as "the room cannot deadlock".
//
//   node auction_deadlock.test.js
const fs = require("fs");

const room = fs.readFileSync("auction-room.js", "utf8");
const sim = fs.readFileSync("sim-mp.js", "utf8");

let pass = 0, fail = 0;
function check(phase, name, present, why) {
  if (present) { pass++; console.log(`  PASS  [${phase}] ${name}`); }
  else {
    fail++;
    console.log(`  FAIL  [${phase}] ${name}\n        without it: ${why}`);
  }
}

console.log("\nEvery point the room waits on something, and how it gets unstuck:\n");

// ---------- the auction ----------
check("auction", "a lot nobody can bid on is auto-passed",
  room.includes("shouldAutoPass") && room.includes("resolveLot(null, 0)"),
  "a lot no one is eligible for would run its full clock every time");
check("auction", "an unusable deadline is cleared and reopened",
  room.includes("update({ ends_at: null })"),
  "a corrupt ends_at would hang the current lot forever");
check("auction", "a non-host can lift a pause after the grace period",
  room.includes("PAUSE_GRACE_MS") && room.includes("canResume()"),
  "a host who closes their tab mid-pause freezes the room permanently");
check("auction", "a pause lifts itself even if nobody presses resume",
  room.includes("PAUSE_AUTO_MS") && room.includes("auto-resume failed"),
  "a pause with no host and no willing manager never ends");
check("auction", "removed managers cannot hold the skip-set vote",
  room.includes('x.status !== "kicked"'),
  "one absent manager blocks the shortcut past a dead set");
check("auction", "the auction ends once every squad is full",
  room.includes("isAuctionComplete"),
  "the room would sit through hundreds of unwanted lots");

// ---------- the handover ----------
check("handover", "a stranded league_setup claim is taken over",
  room.includes("league setup stalled"),
  "if the claiming client dies, nothing can ever claim it again");
check("handover", "a failed setup releases its claim",
  room.includes('update({ status: "auction" }).eq("id", ROOM)'),
  "the room stays wedged in league_setup with Proceed disabled");
check("handover", "short squads are completed before seats are counted",
  room.includes("shortOnes") && room.includes("fillShortSquads"),
  "a manager under 11 is silently dropped and the league is short a team");
check("handover", "managers who never press Proceed are pulled in anyway",
  room.includes('r.data.status === "league") gotoSim()'),
  "anyone who did not click sits on a dead auction screen");

// ---------- the simulation ----------
check("simulation", "closed tabs stop counting toward gates",
  sim.includes("MP_PRESENCE_WINDOW_MS"),
  "one person quitting holds every remaining vote forever");
check("simulation", "removed managers stop counting toward gates",
  sim.includes('p.status !== "kicked"'),
  "an idle manager with the tab open blocks the room and presence cannot see it");
check("simulation", "an all-bot knockout advances on its own",
  sim.includes("mpScheduleAutoAdvance"),
  "a fixture with no human in it waits for a vote nobody can cast");
check("simulation", "the host can clear a blocker mid-season",
  sim.includes("mpRenderKickBar") && sim.includes("mpOutstanding"),
  "no way to remove someone once the league has started");
check("simulation", "an empty roster never counts as 'nobody needs to vote'",
  sim.includes("if (!mpPlayers.length) return;"),
  "a failed fetch would auto-run the entire tournament unattended");
check("simulation", "votes above the ladder are clamped",
  sim.includes("mpVoteStep"),
  "a stale sim_ready_step reads as 'ready for everything' and skips every gate");

console.log(`\n${pass} present, ${fail} missing`);
process.exit(fail ? 1 : 0);
