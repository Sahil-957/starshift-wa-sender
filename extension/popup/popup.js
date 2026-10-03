const el = (id) => document.getElementById(id);

const VIEWS = ["view-login", "view-activate", "view-forgot", "view-home"];

function show(viewId) {
  VIEWS.forEach((id) => el(id).classList.toggle("hidden", id !== viewId));
}

function setMessage(id, text) {
  el(id).textContent = text || "";
  el(id).classList.toggle("hidden", !text);
}

const showError = (msg) => setMessage("login-error", msg);
const clearError = () => setMessage("login-error", "");

/** Stores a login the server just handed us, from either the password form or an activation code. */
async function saveSession(data) {
  await chrome.storage.local.set({
    authToken: data.token,
    authMobile: data.mobile,
    authRole: data.role,
    authExpiresAt: data.expiresAt || null,
    licenseCheckedAt: Date.now(),
  });
}

async function refresh() {
  const { authToken, authMobile, authRole, authExpiresAt } = await chrome.storage.local.get([
    "authToken",
    "authMobile",
    "authRole",
    "authExpiresAt",
  ]);
  show(authToken ? "view-home" : "view-login");
  el("user-mobile").textContent = authMobile ? `+${authMobile}` : "";
  el("btn-open-admin").classList.toggle("hidden", authRole !== "admin");

  el("plan-info").classList.toggle("hidden", !authExpiresAt);
  if (authExpiresAt) {
    const days = Math.max(0, Math.ceil((Date.parse(authExpiresAt) - Date.now()) / (24 * 60 * 60 * 1000)));
    el("plan-info").textContent = `Plan valid till ${new Date(authExpiresAt).toLocaleDateString()} (${days} day${days === 1 ? "" : "s"} left).`;
  }
}

async function init() {
  await refresh();
  const { authToken } = await chrome.storage.local.get("authToken");
  if (!authToken) return;
  // Re-check with the server, so a deactivated account is logged out here too.
  const license = await checkLicense();
  if (!license.ok) showError(license.reason);
  await refresh();
}

/** Runs an async button action with a "busy" label, reporting failures into `errorId`. */
async function withButton(button, busyLabel, errorId, action) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  setMessage(errorId, "");
  try {
    await action();
  } catch (err) {
    setMessage(errorId, err.status ? err.message : "Could not reach the server. Is it running?");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// ---------- Password login ----------
el("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError();
  const mobileRaw = el("mobile").value.trim();
  const password = el("password").value;
  if (!/^\d{6,10}$/.test(mobileRaw)) return showError("Enter a valid mobile number.");
  if (!password) return showError("Enter your password.");

  await withButton(el("btn-login"), "Logging in...", "login-error", async () => {
    const data = await apiFetch("/auth/login", {
      method: "POST",
      body: { mobile: `${el("country-code").value}${mobileRaw}`, password },
    });
    await saveSession(data);
    el("password").value = "";
    await refresh();
  });
});

// ---------- Activation code ----------
/** Accepts the whole link or just the code, so it doesn't matter which one gets pasted. */
function codeFromInput(value) {
  const text = value.trim();
  const match = text.match(/[?&]t=([^&\s]+)/);
  return (match ? match[1] : text).trim();
}

el("btn-activate").addEventListener("click", async () => {
  const token = codeFromInput(el("activate-code").value);
  if (!token) return setMessage("activate-error", "Paste the activation link or code first.");

  await withButton(el("btn-activate"), "Activating...", "activate-error", async () => {
    const data = await apiFetch("/auth/activate", { method: "POST", body: { token } });
    await saveSession(data);
    el("activate-code").value = "";
    await refresh();
  });
});

// ---------- Forgot password ----------
function forgotMobile() {
  const raw = el("forgot-mobile").value.trim();
  return /^\d{6,10}$/.test(raw) ? `${el("forgot-country-code").value}${raw}` : null;
}

el("btn-send-code").addEventListener("click", async () => {
  const mobile = forgotMobile();
  if (!mobile) return setMessage("forgot-error", "Enter a valid mobile number.");

  await withButton(el("btn-send-code"), "Sending...", "forgot-error", async () => {
    const data = await apiFetch("/auth/forgot-password", { method: "POST", body: { mobile } });
    setMessage("forgot-note", data.message);
    el("forgot-step2").classList.remove("hidden");
  });
});

el("btn-reset-password").addEventListener("click", async () => {
  const mobile = forgotMobile();
  const otp = el("forgot-otp").value.trim();
  const password = el("forgot-password").value;
  if (!mobile) return setMessage("forgot-error", "Enter a valid mobile number.");
  if (!/^\d{4,8}$/.test(otp)) return setMessage("forgot-error", "Enter the code from the SMS.");
  if (!/^\S{6,64}$/.test(password)) return setMessage("forgot-error", "Password must be 6-64 characters with no spaces.");

  await withButton(el("btn-reset-password"), "Saving...", "forgot-error", async () => {
    await apiFetch("/auth/reset-password", { method: "POST", body: { mobile, otp, password } });
    // Straight into the app: the new password is already known here.
    const data = await apiFetch("/auth/login", { method: "POST", body: { mobile, password } });
    await saveSession(data);
    ["forgot-otp", "forgot-password", "forgot-mobile"].forEach((id) => (el(id).value = ""));
    el("forgot-step2").classList.add("hidden");
    setMessage("forgot-note", "");
    await refresh();
  });
});

// ---------- Navigation ----------
el("go-activate").addEventListener("click", () => {
  setMessage("activate-error", "");
  show("view-activate");
});
el("go-forgot").addEventListener("click", () => {
  setMessage("forgot-error", "");
  show("view-forgot");
});
el("back-from-activate").addEventListener("click", () => show("view-login"));
el("back-from-forgot").addEventListener("click", () => show("view-login"));

el("btn-open-dashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
});

el("btn-open-admin").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("admin/admin.html") });
});

el("btn-logout").addEventListener("click", async () => {
  await logout();
  await refresh();
});

// One support contact, filled in from config.js.
el("support-link").textContent = SUPPORT_LABEL;
el("support-link").href = SUPPORT_WA_LINK;

init();
