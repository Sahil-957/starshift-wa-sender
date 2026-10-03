const $ = (id) => document.getElementById(id);
const tokenKey = "starshiftToken";
let token = sessionStorage.getItem(tokenKey) || "";
let statusPoller, progressPoller, countdownTimer, reportsPoller;
let activeCampaignId = null;
let excelContacts = null; // set when a spreadsheet is uploaded; cleared when the textarea is edited by hand
let attachment = null; // { dataUrl, name, mimeType } when a file is attached
const MAX_ATTACH_MB = 45;

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
function signedIn(mobile, role) {
  document.body.classList.remove("locked");
  $("login-view").classList.add("hidden");
  $("logout").classList.remove("hidden");
  $("admin-link").classList.toggle("hidden", role !== "admin");
  $("account-label").textContent = mobile ? `Logged in as +${mobile}` : "";
  showPage("campaign");
  refreshStatus();
  loadActiveCampaign();
  updatePreview();
}

function signOut() {
  sessionStorage.removeItem(tokenKey);
  token = "";
  [statusPoller, progressPoller, reportsPoller].forEach(clearTimeout);
  clearInterval(countdownTimer);
  document.body.classList.add("locked");
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
    signedIn(result.mobile, result.role);
  } catch (error) {
    $("login-error").textContent = error.message;
  }
});

$("logout").addEventListener("click", signOut);

// ---------- Navigation ----------
function showPage(page) {
  document.querySelectorAll(".nav-tab").forEach((tab) => tab.setAttribute("aria-selected", tab.dataset.page === page));
  $("page-campaign").classList.toggle("hidden", page !== "campaign");
  $("page-reports").classList.toggle("hidden", page !== "reports");
  clearTimeout(reportsPoller);
  if (page === "reports") loadReports();
}
document.querySelectorAll(".nav-tab").forEach((tab) => tab.addEventListener("click", () => showPage(tab.dataset.page)));

// ---------- WhatsApp connection ----------
$("wa-chip-btn").addEventListener("click", () => $("wa-panel").classList.toggle("hidden"));

async function refreshStatus() {
  try {
    const status = await api("/wa/status");
    const connected = status.state === "open";
    $("status-text").textContent = connected
      ? `WhatsApp: +${status.me || ""}`
      : status.state === "qr" ? "Scan QR to link"
      : status.state === "connecting" ? "Connecting…" : "WhatsApp not linked";
    $("status-dot").className = "wa-dot " + (connected ? "ok" : status.state === "disconnected" ? "off" : "busy");
    $("connection-state").textContent = connected
      ? `Connected as +${status.me || ""}. Messages send from this server, even with your browser closed.`
      : status.state === "qr" ? "Scan this QR in WhatsApp → Linked devices → Link a device."
      : status.state === "connecting" ? "Preparing a secure connection…" : "Click “Link WhatsApp”, then scan the QR with your phone.";
    if (status.qr) { $("qr").src = status.qr; $("qr").classList.remove("hidden"); } else $("qr").classList.add("hidden");
    $("connect").classList.toggle("hidden", connected || status.state === "qr");
    $("unlink").classList.toggle("hidden", !connected);
    if (status.state === "qr" || status.state === "connecting") $("wa-panel").classList.remove("hidden");
    $("send").disabled = !connected;
    $("direct-send").disabled = !connected;
    clearTimeout(statusPoller);
    statusPoller = setTimeout(refreshStatus, connected ? 10000 : 2500);
  } catch (error) {
    $("status-text").textContent = "Server unavailable";
    $("status-dot").className = "wa-dot bad";
    $("connection-state").textContent = error.message;
    statusPoller = setTimeout(refreshStatus, 10000);
  }
}

$("connect").addEventListener("click", async () => {
  $("wa-panel").classList.remove("hidden");
  $("connect").disabled = true;
  try { await api("/wa/connect", "POST", {}); await refreshStatus(); }
  catch (error) { $("connection-state").textContent = error.message; }
  finally { $("connect").disabled = false; }
});

$("unlink").addEventListener("click", async () => {
  if (!confirm("Unlink this WhatsApp account from the server?")) return;
  try { await api("/wa/logout", "POST", {}); await refreshStatus(); }
  catch (error) { $("connection-state").textContent = error.message; }
});

// ---------- Compose helpers ----------
function insertAtCursor(box, text) {
  const [s, e] = [box.selectionStart, box.selectionEnd];
  box.value = box.value.slice(0, s) + text + box.value.slice(e);
  box.focus();
  box.selectionStart = box.selectionEnd = s + text.length;
  updatePreview();
}
document.querySelectorAll(".chip[data-ph]").forEach((chip) => chip.addEventListener("click", () => insertAtCursor($("message"), chip.dataset.ph)));

// Formatting toolbar (WhatsApp markup)
function wrapSel(box, ch) {
  const [s, e] = [box.selectionStart, box.selectionEnd];
  const sel = box.value.slice(s, e) || "text";
  box.value = box.value.slice(0, s) + ch + sel + ch + box.value.slice(e);
  box.focus(); box.selectionStart = s + ch.length; box.selectionEnd = s + ch.length + sel.length;
  updatePreview();
}
function prefixLines(box, pre) {
  const [s, e] = [box.selectionStart, box.selectionEnd];
  const sel = box.value.slice(s, e) || "item";
  box.value = box.value.slice(0, s) + sel.split("\n").map((l) => pre + l).join("\n") + box.value.slice(e);
  box.focus(); updatePreview();
}
document.querySelectorAll(".toolbar [data-wrap]").forEach((b) => b.addEventListener("click", () => wrapSel($("message"), b.dataset.wrap)));
document.querySelectorAll(".toolbar [data-prefix]").forEach((b) => b.addEventListener("click", () => prefixLines($("message"), b.dataset.prefix.replace("&gt;", ">"))));

// Emoji picker
const EMOJIS = ["😊","👍","🙏","🎉","✅","❤️","🔥","⭐","📌","📞","🛒","💰","🎁","😀","🙌","📣","✨","👇","📅","⚡"];
$("emoji-btn").addEventListener("click", () => {
  const p = $("emoji-picker");
  if (!p.innerHTML) {
    p.innerHTML = EMOJIS.map((e) => `<button type="button">${e}</button>`).join("");
    p.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { insertAtCursor($("message"), b.textContent); p.classList.add("hidden"); }));
  }
  p.classList.toggle("hidden");
});

// Live preview
function waFormat(t) {
  return esc(t)
    .replace(/```([\s\S]+?)```/g, "<code>$1</code>")
    .replace(/\*(.+?)\*/g, "<b>$1</b>")
    .replace(/_(.+?)_/g, "<i>$1</i>")
    .replace(/~(.+?)~/g, "<s>$1</s>")
    .replace(/\n/g, "<br>");
}
function updatePreview() {
  let t = ($("message").value || "").replace(/\{\{\s*name\s*\}\}/gi, "Asha").replace(/\{\{\s*custom1\s*\}\}/gi, "Gold").replace(/\{\{\s*custom2\s*\}\}/gi, "");
  if ($("footer-enabled").checked && $("footer-text").value.trim()) t = (t ? t + "\n\n" : "") + $("footer-text").value.trim();
  $("preview-bubble").innerHTML = t.trim() ? waFormat(t) : '<span class="muted">Your message appears here.</span>';
}
["message", "footer-text"].forEach((id) => $(id).addEventListener("input", updatePreview));
$("footer-enabled").addEventListener("change", updatePreview);

// Slider <-> number sync
function syncSlider(rangeId, numId, min, max) {
  const r = $(rangeId), n = $(numId);
  if (!r || !n) return;
  r.addEventListener("input", () => (n.value = r.value));
  n.addEventListener("input", () => (r.value = Math.min(max, Math.max(min, Number(n.value) || min))));
}
syncSlider("gap-range", "gap", 15, 180);
syncSlider("batch-size-range", "batch-size", 1, 100);
syncSlider("batch-pause-range", "batch-pause", 30, 600);

// ---------- Recipients ----------
function parseTextarea(value) {
  return value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const [first, second] = line.split(",").map((p) => (p || "").trim());
    const mobile = (second || first).replace(/\D/g, "");
    return { name: second ? first : "", mobile };
  }).filter((e) => e.mobile.length >= 7);
}

function parseExcel(rows) {
  const pick = (row, ...names) => {
    for (const key of Object.keys(row)) if (names.includes(key.trim().toLowerCase())) return String(row[key] ?? "").trim();
    return "";
  };
  const contacts = [];
  for (const row of rows) {
    const num = pick(row, "mobile number", "mobile", "number", "phone").replace(/\D/g, "");
    if (!num) continue;
    const cc = pick(row, "country code", "code").replace(/\D/g, "");
    const mobile = cc && num.length <= 10 && !num.startsWith(cc) ? cc + num : num;
    contacts.push({ name: pick(row, "name"), mobile, custom1: pick(row, "custom1"), custom2: pick(row, "custom2") });
  }
  return contacts;
}

$("excel").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
    excelContacts = parseExcel(rows);
    if (!excelContacts.length) { excelContacts = null; $("excel-info").textContent = "No valid numbers in that file."; return; }
    $("recipients").value = excelContacts.map((c) => (c.name ? `${c.name},${c.mobile}` : c.mobile)).join("\n");
    $("excel-info").textContent = `${excelContacts.length} loaded from ${file.name}`;
    updateCount();
  } catch (error) { excelContacts = null; $("excel-info").textContent = `Could not read: ${error.message}`; }
});

$("recipients").addEventListener("input", () => { excelContacts = null; $("excel-info").textContent = ""; updateCount(); });
function buildContacts() { return excelContacts && excelContacts.length ? excelContacts : parseTextarea($("recipients").value); }
function updateCount() { const n = buildContacts().length; $("recipient-count").textContent = n ? `${n} valid recipient${n > 1 ? "s" : ""}` : ""; }

// ---------- Attachment ----------
const readAsDataUrl = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result); r.onerror = () => rej(new Error("Could not read that file."));
  r.readAsDataURL(file);
});

$("attach").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > MAX_ATTACH_MB * 1024 * 1024) { $("attach-info").textContent = `Too big (max ${MAX_ATTACH_MB} MB).`; event.target.value = ""; return; }
  try {
    attachment = { dataUrl: await readAsDataUrl(file), name: file.name, mimeType: file.type || "application/octet-stream" };
    $("attach-info").textContent = `📎 ${file.name} (${Math.round(file.size / 1024)} KB) — message is the caption.`;
    $("attach-clear").classList.remove("hidden");
  } catch (error) { attachment = null; $("attach-info").textContent = error.message; }
});
$("attach-clear").addEventListener("click", () => {
  attachment = null; $("attach").value = "";
  $("attach-info").textContent = "Photo, video, PDF or document. The message above is sent as its caption.";
  $("attach-clear").classList.add("hidden");
});

// ---------- Schedule ----------
document.querySelectorAll('input[name="when"]').forEach((r) =>
  r.addEventListener("change", () =>
    $("schedule-opts").classList.toggle("hidden", document.querySelector('input[name="when"]:checked').value !== "later")
  )
);

// ---------- Create campaign ----------
function buildPacing() {
  const base = {
    batchEnabled: $("batch-enabled").checked,
    batchSize: Math.max(1, Number($("batch-size").value) || 25),
    batchPauseSeconds: Math.max(1, Number($("batch-pause").value) || 180),
  };
  return document.querySelector('input[name="pace"]:checked').value === "random"
    ? { mode: "random", minGap: Math.max(15, Number($("min-gap").value) || 20), maxGap: Math.max(15, Number($("max-gap").value) || 60), ...base }
    : { mode: "fixed", gapSeconds: Math.max(15, Number($("gap").value) || 20), ...base };
}

async function createCampaign(forceNow) {
  const contacts = buildContacts();
  const template = $("message").value.trim();
  if (!contacts.length) return alert("Add at least one valid phone number.");
  if (!template && !attachment) return alert("Write a message or attach a file first.");

  let scheduleAt = null, repeat = { mode: "none" };
  if (!forceNow && document.querySelector('input[name="when"]:checked').value === "later") {
    const when = $("schedule-at").value ? new Date($("schedule-at").value).getTime() : 0;
    if (!when || when <= Date.now()) return alert("Pick a future date and time.");
    scheduleAt = when; repeat = { mode: $("repeat").value };
  }

  const footer = { enabled: $("footer-enabled").checked, text: $("footer-text").value.trim(), keyword: $("footer-keyword").value.trim() };

  $("send").disabled = true; $("direct-send").disabled = true;
  try {
    const { campaign } = await api("/campaigns", "POST", {
      name: $("campaign-name").value.trim() || `Campaign ${new Date().toLocaleString()}`,
      messageTemplate: template, caption: $("caption").value.trim(),
      pacing: buildPacing(), attachment, scheduleAt, repeat, footer, contacts,
    });
    activeCampaignId = campaign.id;
    trackProgress();
    refreshSummary();
  } catch (error) { $("send").disabled = false; $("direct-send").disabled = false; alert(error.message); }
}

$("send").addEventListener("click", () => createCampaign(false));
$("direct-send").addEventListener("click", () => createCampaign(true));

async function refreshSummary() {
  try {
    const { campaigns = [] } = await api("/campaigns");
    const s = campaigns.filter((c) => c.status === "scheduled").length;
    const d = campaigns.filter((c) => c.status === "completed").length;
    $("campaign-summary").textContent = `${s} scheduled · ${d} completed`;
  } catch { /* ignore */ }
}

$("cancel").addEventListener("click", async () => {
  if (!activeCampaignId || !confirm("Cancel this campaign?")) return;
  try { await api(`/campaigns/${activeCampaignId}/cancel`, "POST", {}); trackProgress(); } catch (error) { alert(error.message); }
});

// ---------- Live progress (campaign card) ----------
const LABEL = { scheduled: "Scheduled", running: "Sending", paused: "Paused", completed: "Completed", cancelled: "Cancelled" };

function renderProgress(c) {
  const total = c.contacts.length, sent = c.sentCount || 0, failed = c.failedCount || 0, done = sent + failed;
  const active = ["scheduled", "running", "paused"].includes(c.status);
  $("progress-bar").style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  $("progress-count").textContent = c.status === "running" && done < total
    ? `Sending ${done + 1} of ${total}`
    : `${LABEL[c.status] || c.status} · ${sent} sent · ${failed} failed · ${total - done} pending`;
  const act = $("activity");
  act.classList.toggle("fail", failed > 0);
  act.textContent = c.cancelReason || c.waitingReason ||
    (c.status === "completed" ? `Done. ${sent} sent, ${failed} failed.`
      : c.status === "scheduled" ? `Scheduled for ${new Date(c.scheduleAt).toLocaleString()}.`
      : `${sent} sent, ${failed} failed, ${total - done} pending.`);
  $("cancel").classList.toggle("hidden", !active);
  if (!active) $("send").disabled = false;
  startCountdown(c);
}

function startCountdown(c) {
  clearInterval(countdownTimer);
  const box = $("countdown");
  const pending = c.contacts.length - (c.sentCount || 0) - (c.failedCount || 0);
  if (!(["scheduled", "running"].includes(c.status) && pending > 0)) { box.classList.add("hidden"); return; }
  const tick = () => {
    const left = Math.max(0, Math.round(((c.nextSendAt || Date.now()) - Date.now()) / 1000));
    box.classList.remove("hidden");
    box.textContent = c.waitingReason ? `⏳ ${c.waitingReason}`
      : c.status === "scheduled" ? (left > 90 ? `⏳ Scheduled for ${new Date(c.scheduleAt).toLocaleString()}` : `⏳ Starts in ${left}s`)
      : left > 0 ? `⏳ Next message in ${left}s` : "⏳ Sending…";
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

async function trackProgress() {
  clearTimeout(progressPoller);
  if (!activeCampaignId) return;
  try {
    const { campaign } = await api(`/campaigns/${activeCampaignId}`);
    renderProgress(campaign);
    if (["scheduled", "running", "paused"].includes(campaign.status)) progressPoller = setTimeout(trackProgress, 3000);
  } catch (error) { $("activity").textContent = error.message; progressPoller = setTimeout(trackProgress, 8000); }
}

async function loadActiveCampaign() {
  try {
    const { campaigns = [] } = await api("/campaigns");
    $("campaign-summary").textContent = `${campaigns.filter((c) => c.status === "scheduled").length} scheduled · ${campaigns.filter((c) => c.status === "completed").length} completed`;
    const current = campaigns.find((c) => ["scheduled", "running", "paused"].includes(c.status)) || campaigns[0];
    if (!current) return;
    activeCampaignId = current.id;
    renderProgress(current);
    if (["scheduled", "running", "paused"].includes(current.status)) trackProgress();
  } catch { /* none yet */ }
}

// ---------- Reports ----------
async function loadReports() {
  try {
    const { campaigns = [] } = await api("/campaigns");
    const sum = (k) => campaigns.reduce((n, c) => n + (c[k] || 0), 0);
    const sent = sum("sentCount"), failed = sum("failedCount");
    const pending = campaigns.reduce((n, c) => n + c.contacts.filter((x) => x.status === "pending").length, 0);
    const rate = sent + failed ? Math.round((sent / (sent + failed)) * 100) : 100;
    $("reports-stats").innerHTML = [
      [campaigns.length, "Campaigns"], [sent, "Messages sent"], [failed, "Failed"], [pending, "Pending"], [rate + "%", "Success rate"],
    ].map(([n, l]) => `<div class="stat"><span>${n}</span><small>${l}</small></div>`).join("");

    $("reports-list").innerHTML = campaigns.length
      ? campaigns.map(renderCampaignRow).join("")
      : `<p class="hint">No campaigns yet.</p>`;
    document.querySelectorAll("[data-act]").forEach((b) =>
      b.addEventListener("click", async () => {
        try { await api(`/campaigns/${b.dataset.id}/${b.dataset.act}`, "POST", {}); loadReports(); if (b.dataset.id === activeCampaignId) trackProgress(); }
        catch (e) { alert(e.message); }
      })
    );
    clearTimeout(reportsPoller);
    if (campaigns.some((c) => ["scheduled", "running", "paused"].includes(c.status))) reportsPoller = setTimeout(loadReports, 4000);
  } catch (error) { $("reports-list").innerHTML = `<p class="error">${error.message}</p>`; }
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function renderCampaignRow(c) {
  const total = c.contacts.length, sent = c.sentCount || 0, failed = c.failedCount || 0, done = sent + failed;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const act = (a, label) => `<button data-act="${a}" data-id="${c.id}">${label}</button>`;
  let actions = "";
  if (["running"].includes(c.status)) actions = act("pause", "Pause") + act("cancel", "Cancel");
  else if (c.status === "scheduled") actions = act("start-now", "Start now") + act("cancel", "Cancel");
  else if (c.status === "paused") actions = act("resume", "Resume") + act("cancel", "Cancel");
  const repeat = c.repeat?.mode && c.repeat.mode !== "none" ? ` · repeats ${c.repeat.mode}` : "";
  const when = c.scheduleAt ? ` · scheduled ${new Date(c.scheduleAt).toLocaleString()}` : "";
  return `<div class="campaign-item">
    <div class="head"><span>${esc(c.name)}</span><span class="status-badge status-${c.status}">${LABEL[c.status] || c.status}</span></div>
    <div class="campaign-meta">${total} recipient(s) · gap ${c.gapSeconds}s${c.attachment ? " · attachment" : ""}${repeat}${when}</div>
    <div class="progress-bar"><div class="fill" style="width:${pct}%"></div></div>
    <div class="campaign-meta">Sent: ${sent} | Failed: ${failed} | Pending: ${total - done}${c.cancelReason ? " · " + esc(c.cancelReason) : ""}</div>
    ${actions ? `<div class="campaign-actions">${actions}</div>` : ""}
  </div>`;
}

// ---------- Boot ----------
if (token) api("/auth/me").then((me) => signedIn(me.mobile, me.role)).catch(() => signOut());
