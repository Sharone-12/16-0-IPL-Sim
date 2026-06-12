// ===================== 16-0 — Report Issues modal =====================
// Shared across index / draft / simulation. Uses Web3Forms (no SDK needed) —
// the access key is public by design. https://web3forms.com

const WEB3FORMS_KEY = "1c22d3f1-f67c-4882-b69b-e6f7e055c712";

function openBugModal() {
  const modal = document.getElementById("bugModal");
  if (!modal) return;
  modal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeBugModal() {
  const modal = document.getElementById("bugModal");
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = "";
  const text = document.getElementById("bugText");
  const status = document.getElementById("bugStatus");
  const submit = document.getElementById("bugSubmit");
  if (text) { text.value = ""; text.style.borderColor = ""; }
  if (status) { status.hidden = true; status.textContent = ""; }
  if (submit) { submit.textContent = "Send Report"; submit.disabled = false; }
}

async function submitBug() {
  const text = document.getElementById("bugText");
  const status = document.getElementById("bugStatus");
  const submit = document.getElementById("bugSubmit");
  const message = text.value.trim();

  if (!message) {
    text.style.borderColor = "#ef4444";
    return;
  }
  text.style.borderColor = "";
  submit.disabled = true;
  submit.textContent = "Sending...";

  const device = /Mobile|Android|iPhone|iPad/i.test(navigator.userAgent) ? "Mobile" : "Desktop";

  try {
    const res = await fetch("https://api.web3forms.com/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        access_key: WEB3FORMS_KEY,
        subject: "16-0 — Issue Report",
        from_name: "16-0 Bug Reporter",
        message,
        page: window.location.pathname,
        device,
        time: new Date().toLocaleString(),
      }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.message || "send failed");

    status.hidden = false;
    status.style.color = "#4ade80";
    status.textContent = "Report sent — thank you.";
    submit.textContent = "Sent";
    setTimeout(closeBugModal, 2000);
  } catch (err) {
    console.error("Report send failed:", err);
    status.hidden = false;
    status.style.color = "#ef4444";
    status.textContent = "Failed to send. Try again.";
    submit.textContent = "Send Report";
    submit.disabled = false;
  }
}

// Close on backdrop click / Escape
document.addEventListener("DOMContentLoaded", () => {
  const modal = document.getElementById("bugModal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeBugModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    const m = document.getElementById("bugModal");
    if (m && !m.hidden && e.key === "Escape") closeBugModal();
  });
});
