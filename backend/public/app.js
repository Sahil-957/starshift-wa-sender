const $ = (id) => document.getElementById(id);
const tokenKey = "starshiftToken";
let token = sessionStorage.getItem(tokenKey) || "";
let statusPoller;
let progressPoller;
let activeCampaignId = null;
let excelContacts = null; // set when a spreadsheet is uploaded; cleared when the textarea is edited by hand

const api = async (path, method = "GET", body) => {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) signOut();
    throw new Error(data.message || `Request failed (${response.status})`);
  }
  return data;
};

// ---------- Auth ----------
function signedIn(mobile) {
  $("login-view").classList.add("hidden");
  $("app-view").classList.remove("hidden");
  $("logout").classList.remove("hidden");
  $("account-label").textContent = mobile ? `+${mobile}` : "Account";
  refreshStatus();
  loadActiveCampaign();
}

function signOut() {
  sessionStorage.removeItem(tokenKey);
  token = "";
  clearTimeout(statusPoller);
  clearTimeout(progressPoller);
  $("app-view").classList.add("hidden");
  $("login-view").classList.remove("hidden");
  $("logout").classList.add("hidden");
  $("account-label").textContent = "";
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";
  try {
    const mobile = $("mobile").value.replace(/\D/g, "");
    const result = await api("/auth/login", "POST", { mobile, password: $("password").value });
    token = result.token;
    sessionStorage.setItem(tokenKey, token);
    signedIn(result.mobile);
  } catch (error) {
    $("login-error").textContent = error.message;
  }
});

$("logout").addEventListener("click", signOut);

// ---------- WhatsApp connection ----------
async function refreshStatus() {
  try {
    const status = await api("/wa/status");
    const connected = status.state === "open";
    $("status-text").textContent = connected
      ? `WhatsApp linked${status.me ? ` · +${status.me}` : ""}`
      : status.state === "qr"
        ? "Scan QR to link WhatsApp"
        : status.state === "connecting"
          ? "Connecting to WhatsApp"
          : "WhatsApp not linked";
    $("status-dot").className = connected ? "ok" : status.state === "disconnected" ? "bad" : "";
    $("connection-state").textContent = connected
      ? `Connected${status.me ? ` as +${status.me}` : ""}. Messages send from this server.`
      : status.state === "qr"
        ? "Scan this QR using WhatsApp → Linked devices → Link a device."
        : status.state === "connecting"
          ? "Preparing a secure connection…"
          : "Connect your WhatsApp account to begin sending.";
    $("qr").classList.toggle("hidden", !status.qr);
    if (status.qr) $("qr").src = status.qr;
    $("connect").classList.toggle("hidden", connected || status.state === "qr");
    $("unlink").classList.toggle("hidden", !connected);
    $("send").disabled = !connected;
    clearTimeout(statusPoller);
    statusPoller = setTimeout(refreshStatus, connected ? 10000 : 2500);
  } catch (error) {
    $("connection-state").textContent = error.message;
    $("status-text").textContent = "Server unavailable";
    $("status-dot").className = "bad";
    statusPoller = setTimeout(refreshStatus, 10000);
  }
}

$("connect").addEventListener("click", async () => {
  $("connect").disabled = true;
  try {
    await api("/wa/connect", "POST", {});
    await refreshStatus();
  } catch (error) {
    $("connection-state").textContent = error.message;
  } finally {
    $("connect").disabled = false;
  }
});

$("unlink").addEventListener("click", async () => {
  if (!confirm("Unlink this WhatsApp account from the server?")) return;
  try {
    await api("/wa/logout", "POST", {});
    await refreshStatus();
  } catch (error) {
    $("connection-state").textContent = error.message;
  }
});

// ---------- Recipients ----------
function parseTextarea(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [first, second] = line.split(",").map((part) => (part || "").trim());
      const mobile = (second || first).replace(/\D/g, "");
      return { name: second ? first : "", mobile };
    })
    .filter((entry) => entry.mobile.length >= 7);
}

/** Reads the first sheet and maps common column names to { name, mobile, custom1, custom2 }. */
function parseExcel(rows) {
  const pick = (row, ...names) => {
    for (const key of Object.keys(row)) {
      const norm = key.trim().toLowerCase();
      if (names.includes(norm)) return String(row[key] ?? "").trim();
    }
    return "";
  };
  const contacts = [];
  for (const row of rows) {
    const name = pick(row, "name");
    const num = pick(row, "mobile number", "mobile", "number", "phone").replace(/\D/g, "");
    const cc = pick(row, "country code", "code").replace(/\D/g, "");
    if (!num) continue; // group-only rows aren't supported in Phase 1
    const mobile = cc && num.length <= 10 && !num.startsWith(cc) ? cc + num : num;
    contacts.push({ name, mobile, custom1: pick(row, "custom1"), custom2: pick(row, "custom2") });
  }
  return contacts;
}

$("excel").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
    excelContacts = parseExcel(rows);
    if (!excelContacts.length) {
      excelContacts = null;
      $("excel-info").textContent = "No valid numbers found in that file.";
      return;
    }
    $("recipients").value = excelContacts.map((c) => (c.name ? `${c.name},${c.mobile}` : c.mobile)).join("\n");
    $("excel-info").textContent = `${excelContacts.length} recipients loaded from ${file.name}.`;
  } catch (error) {
    excelContacts = null;
    $("excel-info").textContent = `Could not read that file: ${error.message}`;
  }
});

// Editing the textarea by hand overrides whatever was uploaded.
$("recipients").addEventListener("input", () => {
  excelContacts = null;
  $("excel-info").textContent = "";
});

function buildContacts() {
  return excelContacts && excelContacts.length ? excelContacts : parseTextarea($("recipients").value);
}

// ---------- Campaign (server-side) ----------
$("send").addEventListener("click", async () => {
  const contacts = buildContacts();
  const template = $("message").value.trim();
  const gap = Math.max(15, Math.min(3600, Number($("gap").value) || 20));
  if (!contacts.length) return alert("Add at least one valid phone number.");
  if (!template) return alert("Write a message first.");

  $("send").disabled = true;
  try {
    const { campaign } = await api("/campaigns", "POST", {
      name: `Campaign ${new Date().toLocaleString()}`,
      messageTemplate: template,
      gapSeconds: gap,
      contacts,
    });
    activeCampaignId = campaign.id;
    trackProgress();
  } catch (error) {
    $("send").disabled = false;
    alert(error.message);
  }
});

$("cancel").addEventListener("click", async () => {
  if (!activeCampaignId || !confirm("Cancel this campaign? Messages already sent cannot be recalled.")) return;
  try {
    await api(`/campaigns/${activeCampaignId}/cancel`, "POST", {});
    trackProgress();
  } catch (error) {
    alert(error.message);
  }
});

const STATUS_LABEL = {
  scheduled: "Scheduled",
  running: "Sending",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
};

function renderProgress(campaign) {
  const total = campaign.contacts.length;
  const sent = campaign.sentCount || 0;
  const failed = campaign.failedCount || 0;
  const done = sent + failed;
  const active = ["scheduled", "running", "paused"].includes(campaign.status);

  $("progress-bar").style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  $("progress-count").textContent =
    campaign.status === "running" && done < total
      ? `Sending ${done + 1} of ${total}`
      : `${STATUS_LABEL[campaign.status] || campaign.status} · ${sent} sent · ${failed} failed · ${total - done} pending`;

  const activity = $("activity");
  activity.classList.remove("muted");
  activity.classList.toggle("fail", failed > 0);
  activity.textContent =
    campaign.cancelReason ||
    campaign.waitingReason ||
    (campaign.status === "completed"
      ? `Done. ${sent} sent, ${failed} failed.`
      : campaign.status === "scheduled"
        ? `Scheduled to start ${new Date(campaign.scheduleAt).toLocaleString()}.`
        : `${sent} sent, ${failed} failed, ${total - done} pending.`);

  $("cancel").classList.toggle("hidden", !active);
  $("send").disabled = active || $("send").disabled; // re-enabled by refreshStatus once connected and idle
  if (!active) $("send").disabled = false;
}

/** Polls the active campaign until it finishes. The campaign runs on the server, so closing this page is fine. */
async function trackProgress() {
  clearTimeout(progressPoller);
  if (!activeCampaignId) return;
  try {
    const { campaign } = await api(`/campaigns/${activeCampaignId}`);
    renderProgress(campaign);
    if (["scheduled", "running", "paused"].includes(campaign.status)) {
      progressPoller = setTimeout(trackProgress, 3000);
    }
  } catch (error) {
    $("activity").textContent = error.message;
    progressPoller = setTimeout(trackProgress, 8000);
  }
}

/** On sign-in (or page reload), pick up a campaign that is still running on the server. */
async function loadActiveCampaign() {
  try {
    const { campaigns = [] } = await api("/campaigns");
    const current = campaigns.find((c) => ["scheduled", "running", "paused"].includes(c.status)) || campaigns[0];
    if (!current) return;
    activeCampaignId = current.id;
    renderProgress(current);
    if (["scheduled", "running", "paused"].includes(current.status)) trackProgress();
  } catch {
    /* no campaigns yet */
  }
}

// ---------- Boot ----------
if (token) {
  api("/auth/me").then((me) => signedIn(me.mobile)).catch(() => signOut());
}
