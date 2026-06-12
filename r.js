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

  // 356 mapped display names of overseas players to support legacy verification links
  const OVERSEAS_PLAYERS = new Set([
    'AB de Villiers', 'AM Ghazanfar', 'Aaron Finch', 'Abdur Razzak', 'Adam Gilchrist', 'Adam Milne', 'Adam Voges', 'Adam Zampa', 'Adil Rashid', 'Adrian Barath', 'Aiden Blizzard', 'Aiden Markram', 'Ajantha Mendis', 'Akeal Hosein', 'Akila Dananjaya', 'Albie Morkel', 'Alex Carey', 'Alex Hales', 'Alfonso Thomas', 'Alzarri Joseph', 'Andre Nel', 'Andre Russell', 'Andrew Flintoff', 'Andrew McDonald', 'Andrew Symonds', 'Andrew Tye', 'Angelo Mathews', 'Anrich Nortje', 'Ashley Noffke', 'Ashton Turner', 'Azhar Mahmood', 'Azmatullah Omarzai', 'Ben Cutting', 'Ben Dunk', 'Ben Dwarshuis', 'Ben Hilfenhaus', 'Ben Laughlin', 'Ben Rohrer', 'Ben Stokes', 'Beuran Hendricks', 'Bhanuka Rajapaksa', 'Billy Stanlake', 'Blessing Muzarabani', 'Brad Haddin', 'Brad Hodge', 'Brad Hogg', 'Brendon McCullum', 'Brett Geeves', 'Brett Lee', 'Callum Ferguson', 'Cameron Green', 'Cameron White', 'Carlos Brathwaite', 'Chamara Kapugedera', 'Chamara Silva', 'Chaminda Vaas', 'Charl Langeveldt', 'Chris Gayle', 'Chris Green', 'Chris Jordan', 'Chris Lynn', 'Chris Morris', 'Chris Woakes', 'Clint McKay', 'Colin Ingram', 'Colin Munro', 'Colin de Grandhomme', 'Cooper Connolly', 'Corbin Bosch', 'Corey Anderson', "D'Arcy Short", 'Dale Steyn', 'Damien Martyn', 'Dan Christian', 'Daniel Harris', 'Daniel Sams', 'Daniel Vettori', 'Daren Sammy', 'Darren Bravo', 'Darren Lehmann', 'Daryl Mitchell', 'Dasun Shanaka', 'David Hussey', 'David Miller', 'David Payne', 'David Warner', 'David Wiese', 'David Willey', 'Davy Jacobs', 'Dawid Malan', 'Devon Conway', 'Dewald Brevis', 'Dilhara Fernando', 'Dillon du Preez', 'Dilshan Madushanka', 'Dimitri Mascarenhas', 'Dirk Nannes', 'Dominic Thornely', 'Donovan Ferreira', 'Doug Bollinger', 'Doug Bracewell', 'Duan Jansen', 'Dushmantha Chameera', 'Dwaine Pretorius', 'Dwayne Bravo', 'Dwayne Smith', 'Eoin Morgan', 'Eshan Malinga', 'Evin Lewis', 'Fabian Allen', 'Faf du Plessis', 'Farhaan Behardien', 'Farveez Maharoof', 'Fazalhaq Farooqi', 'Fidel Edwards', 'Finn Allen', 'George Bailey', 'George Garton', 'George Linde', 'Gerald Coetzee', 'Glenn Maxwell', 'Glenn McGrath', 'Glenn Phillips', 'Graeme Smith', 'Graham Napier', 'Gulbadin Naib', 'Hardus Viljoen', 'Harry Brook', 'Harry Gurney', 'Hashim Amla', 'Heinrich Klaasen', 'Herschelle Gibbs', 'Imran Tahir', 'Ish Sodhi', 'Isuru Udana', 'Jacob Bethell', 'Jacob Duffy', 'Jacob Oram', 'Jacques Kallis', 'Jake Fraser-McGurk', 'James Faulkner', 'James Franklin', 'James Hopes', 'James Neesham', 'James Pattinson', 'Jamie Overton', 'Jason Behrendorff', 'Jason Holder', 'Jason Roy', 'Javon Searles', 'Jean-Paul Duminy', 'Jeevan Mendis', 'Jerome Taylor', 'Jesse Ryder', 'Jhye Richardson', 'Joe Denly', 'Joe Root', 'Jofra Archer', 'Johan Botha', 'Johan van der Wath', 'John Hastings', 'Jonny Bairstow', 'Jos Buttler', 'Josh Hazlewood', 'Josh Inglis', 'Josh Little', 'Josh Philippe', 'Junior Dala', 'Justin Kemp', 'Kagiso Rabada', 'Kamindu Mendis', 'Kamran Akmal', 'Kane Richardson', 'Kane Williamson', 'Karim Janat', 'Keemo Paul', 'Kemar Roach', 'Keshav Maharaj', 'Kevin Pietersen', 'Kevon Cooper', 'Kieron Pollard', 'Krishmar Santokie', 'Kumar Sangakkara', 'Kusal Mendis', 'Kusal Perera', 'Kwena Maphaka', 'Kyle Abbott', 'Kyle Jamieson', 'Kyle Mayers', 'Lasith Malinga', 'Lee Carseldine', 'Lendl Simmons', 'Lhuan-dre Pretorius', 'Liam Livingstone', 'Liam Plunkett', 'Litton Das', 'Lizaad Williams', 'Lockie Ferguson', 'Luke Pomersbach', 'Luke Ronchi', 'Luke Wood', 'Luke Wright', 'Lungi Ngidi', 'Maheesh Theekshana', 'Mahela Jayawardene', 'Makhaya Ntini', 'Marchant de Lange', 'Marco Jansen', 'Marcus Stoinis', 'Mark Boucher', 'Mark Wood', 'Marlon Samuels', 'Martin Guptill', 'Mashrafe Mortaza', 'Matheesha Pathirana', 'Matt Henry', 'Matthew Breetzke', 'Matthew Hayden', 'Matthew Short', 'Matthew Wade', 'Michael Bracewell', 'Michael Clarke', 'Michael Hussey', 'Michael Klinger', 'Michael Lumb', 'Michael Neser', 'Misbah-ul-Haq', 'Mitchell Johnson', 'Mitchell Marsh', 'Mitchell McClenaghan', 'Mitchell Owen', 'Mitchell Santner', 'Mitchell Starc', 'Moeen Ali', 'Mohammad Ashraful', 'Mohammad Asif', 'Mohammad Hafeez', 'Mohammad Nabi', 'Moises Henriques', 'Morne Morkel', 'Morne van Wyk', 'Mujeeb Ur Rahman', 'Mustafizur Rahman', 'Muthiah Muralidaran', 'Nandre Burger', 'Nathan Coulter-Nile', 'Nathan Ellis', 'Nathan McCullum', 'Nathan Rimmington', 'Naveen-ul-Haq', 'Nic Maddinson', 'Nicholas Pooran', 'Noor Ahmad', 'Nuwan Kulasekara', 'Nuwan Thushara', 'Nuwan Zoysa', 'Obed McCoy', 'Odean Smith', 'Oshane Thomas', 'Owais Shah', 'Pat Cummins', 'Pathum Nissanka', 'Paul Collingwood', 'Peter Handscomb', 'Phil Salt', 'Quinton de Kock', 'Rachin Ravindra', 'Rahmanullah Gurbaz', 'Ramnaresh Sarwan', 'Rashid Khan', 'Rassie van der Dussen', 'Ravi Bopara', 'Ravi Rampaul', 'Ray Price', 'Reece Topley', 'Richard Gleeson', 'Richard Levi', 'Ricky Ponting', 'Rilee Rossouw', 'Riley Meredith', 'Rob Quiney', 'Robin Peterson', 'Roelof van der Merwe', 'Romario Shepherd', 'Ross Taylor', 'Rovman Powell', 'Rusty Theron', 'Ryan Harris', 'Ryan McLaren', 'Ryan Rickelton', 'Ryan ten Doeschate', 'Sachithra Senanayake', 'Salman Butt', 'Sam Billings', 'Sam Curran', 'Samuel Badree', 'Sanath Jayasuriya', 'Sandeep Lamichhane', 'Scott Boland', 'Scott Kuggeleijn', 'Scott Styris', 'Sean Abbott', 'Sediqullah Atal', 'Shahid Afridi', 'Shai Hope', 'Shakib Al Hasan', 'Shamar Joseph', 'Shane Bond', 'Shane Harwood', 'Shane Warne', 'Shane Watson', 'Shaun Marsh', 'Shaun Pollock', 'Shane Tait', 'Sheldon Cottrell', 'Sherfane Rutherford', 'Shimron Hetmyer', 'Shivnarine Chanderpaul', 'Shoaib Akhtar', 'Shoaib Malik', 'Sikandar Raza', 'Simon Katich', 'Sisanda Magala', 'Sohail Tanvir', 'Spencer Johnson', 'Stephen Fleming', 'Steven Smith', 'Sunil Narine', 'Suraj Randiv', 'Tabraiz Shamsi', 'Tom Banton', 'Tom Curran', 'Tom Kohler-Cadmore', 'Travis Birt', 'Travis Head', 'Trent Boult', 'Tristan Stubbs', 'Tymal Mills', 'Tyron Henderson', 'Umar Gul', 'Usman Khawaja', 'Vijayakanth Viyaskanth', "W O'Rourke", 'Wanindu Hasaranga', 'Wayne Parnell', 'Wiaan Mulder', 'Will Jacks', 'Xavier Bartlett', 'Younis Khan'
  ]);

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

        // Detect overseas players from database boolean OR our offline master lookup set
        const isOverseas = Boolean(p.isOverseas) || OVERSEAS_PLAYERS.has(p.name);

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
