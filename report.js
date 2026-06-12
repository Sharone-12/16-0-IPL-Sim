// ===================== 16-0 — Report Issues modal =====================
// Shared across index / draft / simulation. Fill in your EmailJS keys below
// (https://dashboard.emailjs.com → Account, Email Services, Email Templates).

const REPORT_CONFIG = {
  publicKey: "YOUR_PUBLIC_KEY",
  serviceId: "YOUR_SERVICE_ID",
  templateId: "YOUR_TEMPLATE_ID",
};

(function initReporting() {
  if (
    typeof emailjs !== "undefined" &&
    REPORT_CONFIG.publicKey &&
    REPORT_CONFIG.publicKey !== "YOUR_PUBLIC_KEY"
  ) {
    emailjs.init(REPORT_CONFIG.publicKey);
  }
})();

function reportingConfigured() {
  return (
    typeof emailjs !== "undefined" &&
    REPORT_CONFIG.serviceId !== "YOUR_SERVICE_ID" &&
    REPORT_CONFIG.templateId !== "YOUR_TEMPLATE_ID"
  );
}

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

  if (!reportingConfigured()) {
    status.hidden = false;
    status.style.color = "#f2cd5c";
    status.textContent = "⚠️ Reporting isn't configured yet.";
    return;
  }

  submit.disabled = true;
  submit.textContent = "Sending...";

  const payload = {
    message,
    page: window.location.pathname,
    device: /Mobile|Android|iPhone|iPad/i.test(navigator.userAgent) ? "Mobile" : "Desktop",
    time: new Date().toLocaleString(),
  };

  try {
    await emailjs.send(REPORT_CONFIG.serviceId, REPORT_CONFIG.templateId, payload);
    status.hidden = false;
    status.style.color = "#4ade80";
    status.textContent = "✅ Report sent! Thank you.";
    submit.textContent = "Sent ✓";
    setTimeout(closeBugModal, 2000);
  } catch (err) {
    console.error("Report send failed:", err);
    status.hidden = false;
    status.style.color = "#ef4444";
    status.textContent = "❌ Failed to send. Try again.";
    submit.textContent = "Send Report";
    submit.disabled = false;
  }
}

// Close on backdrop click
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
