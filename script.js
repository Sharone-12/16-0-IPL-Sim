// ===================== 16-0 — Phase 2: setup screen =====================

const MIN_YEAR = 2008;
const MAX_YEAR = 2026;
const TOTAL_SEASONS = MAX_YEAR - MIN_YEAR + 1; // 19

// Chosen config — read by the wheel in the next phase.
const draftConfig = {
  difficulty: "normal",
  showRatings: "on",
  playerRatings: "career",
  eraFrom: MIN_YEAR,
  eraTo: MAX_YEAR,
  teamName: "",
};

// ---------- screen switching ----------
const body = document.body;
const screens = {
  landing: document.getElementById("landing"),
  setup: document.getElementById("setup"),
};

function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) {
    const active = key === name;
    el.classList.toggle("is-active", active);
    el.setAttribute("aria-hidden", String(!active));
  }
  body.classList.toggle("setup-active", name === "setup");
  if (name === "setup") screens.setup.scrollTop = 0;
}

document
  .querySelector(".start-button")
  .addEventListener("click", () => showScreen("setup"));

document
  .querySelector(".back-btn")
  .addEventListener("click", () => showScreen("landing"));

// ---------- option groups (single-select) ----------
document.querySelectorAll(".group .options").forEach((groupEl) => {
  groupEl.addEventListener("click", (e) => {
    const opt = e.target.closest(".opt");
    if (!opt) return;

    const setting = opt.closest(".group").dataset.setting;
    const value = opt.dataset.value;

    // Sync difficulty and ratings logic: Hard mode strictly forces blind ratings
    if (setting === "showRatings" && value === "on" && draftConfig.difficulty === "hard") {
      showToast("Ratings must be blind in Hard mode");
      return;
    }

    if (opt.classList.contains("is-selected")) return;

    groupEl.querySelectorAll(".opt").forEach((o) => {
      const on = o === opt;
      o.classList.toggle("is-selected", on);
      o.setAttribute("aria-pressed", String(on));
    });

    if (setting === "era") {
      applyEraPreset(value);
    } else {
      draftConfig[setting] = value;
    }

    // If difficulty was changed to hard, force showRatings to off
    if (setting === "difficulty" && value === "hard") {
      draftConfig.showRatings = "off";
      const ratingsGroup = document.querySelector('.group[data-setting="showRatings"] .options');
      if (ratingsGroup) {
        ratingsGroup.querySelectorAll(".opt").forEach((o) => {
          const isOff = o.dataset.value === "off";
          o.classList.toggle("is-selected", isOff);
          o.setAttribute("aria-pressed", String(isOff));
        });
      }
    }
  });
});

// ---------- era dual-range slider ----------
const eraMin = document.getElementById("eraMin");
const eraMax = document.getElementById("eraMax");
const eraFromLbl = document.getElementById("eraFrom");
const eraToLbl = document.getElementById("eraTo");
const eraCountLbl = document.getElementById("eraCount");
const eraFill = document.querySelector(".era-fill");

function updateEra(source) {
  let lo = Number(eraMin.value);
  let hi = Number(eraMax.value);

  // keep the handles from crossing
  if (lo > hi) {
    if (source === "min") {
      lo = hi;
      eraMin.value = String(lo);
    } else {
      hi = lo;
      eraMax.value = String(hi);
    }
  }

  draftConfig.eraFrom = lo;
  draftConfig.eraTo = hi;

  eraFromLbl.textContent = String(lo);
  eraToLbl.textContent = String(hi);
  eraCountLbl.textContent = `${hi - lo + 1} of ${TOTAL_SEASONS} seasons`;

  const leftPct = ((lo - MIN_YEAR) / (TOTAL_SEASONS - 1)) * 100;
  const rightPct = ((hi - MIN_YEAR) / (TOTAL_SEASONS - 1)) * 100;
  eraFill.style.left = `${leftPct}%`;
  eraFill.style.width = `${rightPct - leftPct}%`;
}

function applyEraPreset(value) {
  const from = value === "all" ? MIN_YEAR : Number(value);
  eraMin.value = String(from);
  eraMax.value = String(MAX_YEAR);
  updateEra();
}

function clearEraPreset() {
  document
    .querySelectorAll('.group[data-setting="era"] .opt')
    .forEach((o) => {
      o.classList.remove("is-selected");
      o.setAttribute("aria-pressed", "false");
    });
}

eraMin.addEventListener("input", () => {
  updateEra("min");
  clearEraPreset();
});
eraMax.addEventListener("input", () => {
  updateEra("max");
  clearEraPreset();
});

updateEra(); // initialise readout + fill

// ---------- begin draft (placeholder until the wheel exists) ----------
let toastTimer;
function showToast(message) {
  const toast = document.querySelector(".toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

document.getElementById("beginDraft").addEventListener("click", () => {
  const nameInput = document.getElementById("teamNameInput");
  const teamName = nameInput ? nameInput.value.trim().slice(0, 18) : "";
  
  if (!teamName) {
    showToast("Please enter a team name before starting!");
    return;
  }
  
  draftConfig.teamName = teamName;
  try {
    localStorage.setItem("draftConfig", JSON.stringify(draftConfig));
  } catch (_) {
    /* storage may be unavailable — draft page falls back to defaults */
  }
  window.location.href = "draft.html";
});

// ---------- How to Play card deck ----------
(function setupHowTo() {
  const modal = document.getElementById("howToModal");
  if (!modal) return;
  const steps = Array.from(modal.querySelectorAll(".how-to-step"));
  const dotsWrap = document.getElementById("howToDots");
  const backBtn = document.getElementById("howToBack");
  const nextBtn = document.getElementById("howToNext");
  let index = 0;

  // build dots
  steps.forEach(() => {
    const dot = document.createElement("span");
    dot.className = "how-to-dot";
    dotsWrap.appendChild(dot);
  });
  const dots = Array.from(dotsWrap.children);

  function render() {
    steps.forEach((s, i) => s.classList.toggle("is-active", i === index));
    dots.forEach((d, i) => d.classList.toggle("is-active", i === index));
    backBtn.disabled = index === 0;
    nextBtn.textContent = index === steps.length - 1 ? "Got it" : "Next";
  }

  function open() {
    index = 0;
    render();
    modal.hidden = false;
  }
  function close() {
    modal.hidden = true;
  }

  document.getElementById("howToBtn").addEventListener("click", open);
  modal.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", close)
  );
  backBtn.addEventListener("click", () => {
    if (index > 0) { index--; render(); }
  });
  nextBtn.addEventListener("click", () => {
    if (index < steps.length - 1) { index++; render(); }
    else close();
  });
  document.addEventListener("keydown", (e) => {
    if (modal.hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") nextBtn.click();
    else if (e.key === "ArrowLeft") backBtn.click();
  });
})();
