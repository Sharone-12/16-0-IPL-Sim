// Verifiable link display script
(function() {
  const cardSlot = document.getElementById("cardSlot");

  // Helper functions matching simulation.js exactly
  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function ordinal(n) {
    const suffix = n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th";
    return `${n}${suffix}`;
  }

  function ovrTierClass(ovr) {
    if (ovr >= 92) return "ovr-gold";
    if (ovr >= 89) return "ovr-blue";
    if (ovr >= 85) return "ovr-green";
    return "ovr-white";
  }

  function rosterRole(p) {
    if (p.primaryRole === "Bowler") return { label: "Bowler", cls: "role-lower" };
    if (p.primaryRole === "All-Rounder") return { label: "All-Rounder", cls: "role-finisher" };
    switch (p.battingOrder) {
      case "Opener": return { label: "Opener", cls: "role-opener" };
      case "Middle Order": return { label: "Middle", cls: "role-middle" };
      case "Finisher": return { label: "Finisher", cls: "role-finisher" };
      case "Lower Order": return { label: "Lower", cls: "role-lower" };
      default: return { label: p.battingOrder || "—", cls: "role-middle" };
    }
  }

  function slotBadgeClass(p) {
    const r = rosterRole(p);
    if (r.cls === "role-opener") return "pos-red";
    if (r.cls === "role-middle") return "pos-green";
    if (r.cls === "role-finisher") return "pos-gold";
    if (r.cls === "role-lower") return "pos-blue";
    return "pos-green";
  }

  function badgeStyle(stage) {
    if (stage.startsWith("CHAMPIONS")) return "badge-gold";
    if (stage.startsWith("RUNNERS")) return "badge-silver";
    return "badge-red";
  }

  function resultCardHtml(o) {
    const badge = badgeStyle(o.stage);
    const playerRow = (p) => `
      <div class="rc-player">
        <span class="rc-slot ${slotBadgeClass(p)}">${p.slot + 1}</span>
        <span class="rc-pname">${escapeHtml(p.name)}</span>
        <span class="rc-povr ${ovrTierClass(p.ovr)}">${p.ovr}</span>
      </div>`;
    const left = o.xi.slice(0, 6).map(playerRow).join("");
    const right = o.xi.slice(6).map(playerRow).join("");
    return `
      <div class="rc-head">
        <span class="rc-wordmark">16-0</span>
        <span class="rc-tags">
          <span class="rc-tag">${escapeHtml(o.mode)}</span>
          <span class="rc-tag rc-ovr-tag">OVR ${o.teamOvr}</span>
        </span>
      </div>
      <div class="rc-team">${escapeHtml(o.teamName)}</div>
      <div class="rc-record">${o.wins} - ${o.losses}</div>
      <div class="rc-wl">WON · LOST</div>
      <div class="rc-sub">${o.pts} pts · Finished ${ordinal(o.leagueFinish)}</div>
      <div class="rc-badge-wrap"><span class="rc-badge ${badge}">${escapeHtml(o.stage)}</span></div>
      <div class="rc-xi">
        <div class="rc-col">${left}</div>
        <div class="rc-col">${right}</div>
      </div>
      <div class="rc-leaders">
        <div class="rc-leader">
          <span class="rc-leader-label">Top Scorer</span>
          <strong>${o.topScorer ? escapeHtml(o.topScorer.name) : "—"}</strong>
          <em>${o.topScorer ? `${o.topScorer.runs} runs` : ""}</em>
        </div>
        <div class="rc-leader">
          <span class="rc-leader-label">Top Wkts</span>
          <strong>${o.topWicketer ? escapeHtml(o.topWicketer.name) : "—"}</strong>
          <em>${o.topWicketer ? `${o.topWicketer.wickets} wkts` : ""}</em>
        </div>
      </div>
      <div class="rc-foot">
        <span>Think you can beat this?</span>
        <span class="rc-brand">16-0game.vercel.app</span>
      </div>`;
  }

  function showError(title, message) {
    cardSlot.innerHTML = `
      <div class="error-msg">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
      </div>`;
  }

  async function loadResult() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");

    if (!id) {
      showError("Invalid Link", "No score ID was specified in the URL.");
      return;
    }

    const client = typeof initSupabase === "function" ? initSupabase() : null;

    if (!client) {
      showError("Configuration Error", "Supabase client failed to initialize.");
      return;
    }

    try {
      const { data, error } = await client
        .from("leaderboards")
        .select("payload")
        .eq("id", id)
        .single();

      if (error) throw error;

      if (!data || !data.payload) {
        showError("Not Found", "We couldn't find a verified score matching this link.");
        return;
      }

      // Render the result card
      const cardDiv = document.createElement("div");
      cardDiv.className = "result-card";
      cardDiv.innerHTML = resultCardHtml(data.payload);
      
      cardSlot.innerHTML = "";
      cardSlot.appendChild(cardDiv);
    } catch (err) {
      console.error("Error loading verification result:", err);
      showError("Verification Failed", "There was an error communicating with the server. Please try again later.");
    }
  }

  // Run on load
  loadResult();
})();
