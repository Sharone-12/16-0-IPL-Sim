// Verifiable link display script
(function() {
  const mainContent = document.getElementById("mainContent");

  const FRANCHISE_NAMES = {
    "CSK": "Chennai Super Kings",
    "MI": "Mumbai Indians",
    "RCB": "Royal Challengers Bangalore",
    "KKR": "Kolkata Knight Riders",
    "SRH": "Sunrisers Hyderabad",
    "RR": "Rajasthan Royals",
    "DC": "Delhi Capitals",
    "DD": "Delhi Daredevils",
    "KXIP": "Kings XI Punjab",
    "PBKS": "Punjab Kings",
    "GT": "Gujarat Titans",
    "LSG": "Lucknow Super Giants",
    "RPS": "Rising Pune Supergiant",
    "GL": "Gujarat Lions",
    "KTK": "Kochi Tuskers Kerala",
    "PW": "Pune Warriors"
  };

  // Helper functions
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

  function rosterRoleInfo(p) {
    if (p.primaryRole === "Bowler") {
      return { label: "BWL", cls: "badge-lower" };
    }
    if (p.primaryRole === "All-Rounder") {
      return { label: "ALL", cls: "badge-finisher" };
    }
    switch (p.battingOrder) {
      case "Opener": return { label: "OPN", cls: "badge-opener" };
      case "Middle Order": return { label: "MID", cls: "badge-middle" };
      case "Finisher": return { label: "FIN", cls: "badge-finisher" };
      case "Lower Order": return { label: "LOW", cls: "badge-lower" };
      default: return { label: "MID", cls: "badge-middle" };
    }
  }

  function getFranchiseFullName(frCode) {
    if (!frCode) return "";
    const clean = frCode.trim().toUpperCase();
    const mapped = FRANCHISE_NAMES[clean];
    if (mapped) return mapped;
    return frCode.toUpperCase();
  }

  function showError(title, message) {
    if (mainContent) {
      mainContent.innerHTML = `
        <div class="error-msg">
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(message)}</p>
        </div>`;
    }
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

      const o = data.payload;

      const difficulty = o.mode || "Normal";
      const stageText = o.stage || "ELIMINATED";
      const stageColor = stageText.startsWith("CHAMPION") 
        ? "var(--color-brand-green)" 
        : stageText.startsWith("RUNNER") 
          ? "var(--color-ovr-blue)" 
          : "#ff4a4a";

      // Build titles section
      const titlesHtml = `
        <section class="titles-section" aria-label="Team Overview">
          <h1>${escapeHtml(o.teamName)}</h1>
          <p>${escapeHtml(difficulty)} · <span style="color: ${stageColor}; font-weight: 700;">${escapeHtml(stageText)}</span></p>
        </section>
      `;

      // Build stats grid
      const statsHtml = `
        <section class="stats-grid" aria-label="Match Stats">
          <div class="stat-card">
            <div class="stat-value">${o.teamOvr}</div>
            <div class="stat-label">OVR</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${o.pts}</div>
            <div class="stat-label">POINTS</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${o.wins}-${o.losses}</div>
            <div class="stat-label">RECORD</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${ordinal(o.leagueFinish)}</div>
            <div class="stat-label">FINISHED</div>
          </div>
        </section>
      `;

      // Build awards grid
      const orangeCapWinner = o.topScorer ? o.topScorer.name : "—";
      const orangeCapDetail = o.topScorer ? `${o.topScorer.runs} runs` : "";
      const purpleCapWinner = o.topWicketer ? o.topWicketer.name : "—";
      const purpleCapDetail = o.topWicketer ? `${o.topWicketer.wickets} wkts` : "";

      const capSvg = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; vertical-align: middle; margin-right: 4px;">
          <path d="M18 11a6 6 0 0 0-12 0v3h12v-3z"/>
          <path d="M2 14h20v2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-2z"/>
          <path d="M12 5V3"/>
        </svg>
      `;

      const awardsHtml = `
        <section class="awards-grid" aria-label="Individual Awards">
          <div class="award-card">
            <span class="award-title orange">
              ${capSvg}Orange Cap
            </span>
            <h3 class="award-winner">${escapeHtml(orangeCapWinner)}</h3>
            <span class="award-detail orange">${escapeHtml(orangeCapDetail)}</span>
          </div>
          <div class="award-card">
            <span class="award-title purple">
              ${capSvg}Purple Cap
            </span>
            <h3 class="award-winner">${escapeHtml(purpleCapWinner)}</h3>
            <span class="award-detail purple">${escapeHtml(purpleCapDetail)}</span>
          </div>
        </section>
      `;

      // Build roster list
      const rosterRowsHtml = (o.xi || []).map(p => {
        const roleInfo = rosterRoleInfo(p);
        let subText = "";
        
        // Mention the team player came from: full name mapping or frFull
        const teamName = p.frFull || getFranchiseFullName(p.fr);
        if (teamName && p.season) {
          subText = `${teamName} · ${p.season}`;
        } else if (teamName) {
          subText = teamName;
        } else if (p.season) {
          subText = p.season;
        } else {
          subText = "";
        }

        // Determine correct PNG role icon
        let roleIconSrc = "/pngs/bat.png"; // Default
        if (p.primaryRole === "Bowler") {
          roleIconSrc = "/pngs/ball.png";
        } else if (p.primaryRole === "All-Rounder") {
          roleIconSrc = "/pngs/batandball.png";
        }

        const isOverseas = Boolean(p.isOverseas);

        return `
          <article class="player-row">
            <span class="player-slot ${roleInfo.cls}">${roleInfo.label}</span>
            <div class="player-info">
              <div style="display: flex; align-items: center; gap: var(--space-xs, 8px); min-width: 0;">
                <h4 class="player-name" style="margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto;">${escapeHtml(p.name)}</h4>
                <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
                  <img src="${roleIconSrc}" alt="${p.primaryRole}" style="height: 14px; width: 14px; object-fit: contain; opacity: 0.9;" />
                  ${isOverseas ? `<img src="/pngs/plane.png" alt="Overseas" title="Overseas Player" style="height: 12px; width: 12px; object-fit: contain; opacity: 0.85;" />` : ''}
                </div>
              </div>
              <span class="player-sub">${escapeHtml(subText)}</span>
            </div>
            <span class="player-ovr ${ovrTierClass(p.ovr)}">${p.ovr}</span>
          </article>
        `;
      }).join("");

      const rosterHtml = `
        <section class="roster-list" aria-label="Team Roster">
          ${rosterRowsHtml}
        </section>
      `;

      if (mainContent) {
        mainContent.innerHTML = titlesHtml + statsHtml + awardsHtml + rosterHtml;
      }
    } catch (err) {
      console.error("Error loading verification result:", err);
      showError("Verification Failed", "There was an error communicating with the server. Please try again later.");
    }
  }

  // Run on load
  loadResult();
})();
