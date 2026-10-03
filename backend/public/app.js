const $ = (id) => document.getElementById(id);
const tokenKey = "starshiftToken";
let token = sessionStorage.getItem(tokenKey) || "";
let statusPoller, progressPoller, countdownTimer, reportsPoller;
let activeCampaignId = null;
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
  $("forgot-view").classList.add("hidden");
  $("logout").classList.remove("hidden");
  $("admin-link").classList.toggle("hidden", role !== "admin");
  $("account-label").textContent = mobile ? `Logged in as +${mobile}` : "";
  showPage("campaign");
  refreshStatus();
  loadActiveCampaign();
  updatePreview();
  loadSelected();
  renderSelected();
  // Show cached contacts/groups instantly, then refresh them in the background - a refresh never empties them.
  _contacts = cacheGet("starshiftContacts");
  _groups = cacheGet("starshiftGroups");
  renderContacts("");
  renderGroups("");
  syncContacts(false);
  syncGroups(false);
}

function signOut() {
  sessionStorage.removeItem(tokenKey);
  token = "";
  [statusPoller, progressPoller, reportsPoller].forEach(clearTimeout);
  clearInterval(countdownTimer);
  selected = [];
  try { ["starshiftSelected", "starshiftContacts", "starshiftGroups"].forEach((k) => localStorage.removeItem(k)); } catch { /* private mode */ }
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

$("forgot-open").addEventListener("click", () => {
  $("login-view").classList.add("hidden");
  $("forgot-view").classList.remove("hidden");
  $("forgot-mobile").value = $("mobile").value.replace(/\D/g, "");
  $("forgot-status").textContent = "";
});
$("forgot-back").addEventListener("click", () => {
  $("forgot-view").classList.add("hidden");
  $("login-view").classList.remove("hidden");
});
$("send-code").addEventListener("click", async () => {
  $("forgot-status").textContent = "Sending code…";
  try {
    const result = await api("/auth/forgot-password", "POST", { mobile: $("forgot-mobile").value.replace(/\D/g, "") });
    $("forgot-status").textContent = result.message || "If that number has an account, a code has been sent.";
    $("reset-fields").classList.remove("hidden");
  } catch (error) { $("forgot-status").textContent = error.message; }
});
$("reset-password").addEventListener("click", async () => {
  $("forgot-status").textContent = "Updating password…";
  try {
    await api("/auth/reset-password", "POST", { mobile: $("forgot-mobile").value.replace(/\D/g, ""), otp: $("forgot-otp").value.trim(), password: $("forgot-password").value });
    $("forgot-status").textContent = "Password updated. Sign in with your new password.";
    $("forgot-view").classList.add("hidden"); $("login-view").classList.remove("hidden");
  } catch (error) { $("forgot-status").textContent = error.message; }
});

$("logout").addEventListener("click", signOut);

// ---------- Navigation ----------
const PAGES = ["campaign", "reports", "chatbot", "quick", "unsub"];
function showPage(page) {
  document.querySelectorAll(".nav-tab").forEach((tab) => tab.setAttribute("aria-selected", tab.dataset.page === page));
  PAGES.forEach((p) => { const sec = $("page-" + p); if (sec) sec.classList.toggle("hidden", p !== page); });
  clearTimeout(reportsPoller);
  if (page === "reports") loadReports();
  if (page === "chatbot") loadBot();
  if (page === "quick") renderQuick();
  if (page === "unsub") loadUnsub();
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
let selected = [];
const recKey = (r) => `${r.source}|${(r.mobile || r.name).toLowerCase()}`;
function buildContacts() { return selected; }
function saveSelected() { try { localStorage.setItem("starshiftSelected", JSON.stringify(selected)); } catch { /* private mode */ } }
function loadSelected() { try { selected = JSON.parse(localStorage.getItem("starshiftSelected") || "[]"); } catch { selected = []; } }

function renderSelected() {
  $("selected-count").textContent = selected.length;
  $("selected-list").innerHTML = selected.length
    ? selected.map((r) => `<div class="pick-row"><div><div class="pname">${esc(r.name || r.mobile)}</div><div class="ptarget">${r.source === "group" ? "Group" : r.mobile || "contact"}</div></div><button data-rm="${esc(recKey(r))}">Remove</button></div>`).join("")
    : `<p class="empty-note">Nobody selected yet.</p>`;
  $("selected-list").querySelectorAll("[data-rm]").forEach((b) =>
    b.addEventListener("click", () => { selected = selected.filter((r) => recKey(r) !== b.dataset.rm); renderSelected(); })
  );
  saveSelected();
}
function addRecipient(r) {
  const rec = { source: r.source || "number", name: r.name || "", mobile: (r.mobile || "").replace(/\D/g, ""), custom1: r.custom1 || "", custom2: r.custom2 || "", fields: r.fields || {} };
  if (!selected.some((x) => recKey(x) === recKey(rec))) selected.push(rec);
  renderSelected();
}
$("clear-selected").addEventListener("click", () => { selected = []; renderSelected(); });

// Sub-tabs
document.querySelectorAll(".rtab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".rtab").forEach((x) => x.setAttribute("aria-selected", x === t));
    document.querySelectorAll("[data-rpanel]").forEach((p) => p.classList.toggle("hidden", p.dataset.rpanel !== t.dataset.rtab));
    if (t.dataset.rtab === "lists") loadLists();
  })
);

function markAdded(btn) { btn.textContent = "Added"; btn.classList.add("added"); }

// Cache the synced contact/group lists so a page refresh shows them instantly (then refreshes in the background).
function cacheSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }
function cacheGet(k) { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch { return []; } }

// Contact
let _contacts = [];
async function syncContacts(showLoading) {
  if (showLoading) $("contact-list").innerHTML = `<p class="empty-note">Loading…</p>`;
  try {
    _contacts = (await api("/wa/contacts")).contacts || [];
    cacheSet("starshiftContacts", _contacts);
    renderContacts($("contact-search").value.trim().toLowerCase());
  } catch (e) { if (showLoading) $("contact-list").innerHTML = `<p class="empty-note">${esc(e.message)}</p>`; }
}
function renderContacts(q) {
  const list = _contacts.filter((c) => !q || c.name.toLowerCase().includes(q) || c.number.includes(q));
  $("contact-list").innerHTML = list.length
    ? list.slice(0, 800).map((c) => `<div class="pick-row"><div><div class="pname">${esc(c.name)}</div><div class="ptarget">${esc(c.number)}</div></div><button data-add="${esc(c.number)}" data-name="${esc(c.name)}">Add</button></div>`).join("")
    : `<p class="empty-note">No contacts found. Click “Sync contacts”.</p>`;
  $("contact-list").querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => { addRecipient({ source: "number", name: b.dataset.name, mobile: b.dataset.add }); markAdded(b); }));
}
$("sync-contacts").addEventListener("click", () => syncContacts(true));
$("contact-search").addEventListener("input", () => renderContacts($("contact-search").value.trim().toLowerCase()));

// Group
let _groups = [];
async function syncGroups(showLoading) {
  if (showLoading) $("group-list").innerHTML = `<p class="empty-note">Loading…</p>`;
  try {
    _groups = (await api("/wa/groups")).groups || [];
    cacheSet("starshiftGroups", _groups);
    renderGroups($("group-search").value.trim().toLowerCase());
  } catch (e) { if (showLoading) $("group-list").innerHTML = `<p class="empty-note">${esc(e.message)}</p>`; }
}
function renderGroups(q) {
  const list = _groups.filter((g) => !q || g.name.toLowerCase().includes(q));
  $("group-list").innerHTML = list.length
    ? list.map((g) => `<div class="pick-row"><span class="pname">${esc(g.name)}</span><button data-addg="${esc(g.name)}">Add</button></div>`).join("")
    : `<p class="empty-note">No groups found. Click “Sync groups”.</p>`;
  $("group-list").querySelectorAll("[data-addg]").forEach((b) => b.addEventListener("click", () => { addRecipient({ source: "group", name: b.dataset.addg }); markAdded(b); }));
}
$("sync-groups").addEventListener("click", () => syncGroups(true));
$("group-search").addEventListener("input", () => renderGroups($("group-search").value.trim().toLowerCase()));

// Numbers (manual + Excel)
$("num-add").addEventListener("click", () => {
  const cc = $("num-cc").value.replace(/\D/g, ""), ph = $("num-phone").value.replace(/\D/g, "");
  if (!ph) return alert("Enter a number.");
  addRecipient({ source: "number", name: $("num-name").value.trim(), mobile: ph.length <= 10 && cc ? cc + ph : ph });
  $("num-phone").value = ""; $("num-name").value = "";
});
const fieldKey = (h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
function parseExcel(rows) {
  const out = [];
  for (const row of rows) {
    const entries = Object.entries(row);
    const get = (...names) => { for (const [k, v] of entries) if (names.includes(k.trim().toLowerCase())) return String(v ?? "").trim(); return ""; };
    const num = get("mobile number", "mobile", "number", "phone").replace(/\D/g, "");
    if (!num) continue;
    const cc = get("country code", "code").replace(/\D/g, "");
    const fields = {};
    for (const [k, v] of entries) { const fk = fieldKey(k); if (fk) fields[fk] = String(v ?? "").trim(); }
    out.push({ name: get("name"), mobile: cc && num.length <= 10 && !num.startsWith(cc) ? cc + num : num, custom1: get("custom1"), custom2: get("custom2"), fields });
  }
  return out;
}
$("excel").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const parsed = parseExcel(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" }));
    if (!parsed.length) { $("excel-info").textContent = "No valid numbers in that file."; return; }
    parsed.forEach((c) => addRecipient({ source: "number", ...c }));
    $("excel-info").textContent = `${parsed.length} added from ${file.name}`;
  } catch (e) { $("excel-info").textContent = `Could not read: ${e.message}`; }
});

// Google Sheets import (server fetches the published CSV)
$("sheet-import").addEventListener("click", async () => {
  const url = $("sheet-url").value.trim();
  if (!url) return;
  $("sheet-import").disabled = true;
  try {
    const { csv } = await api("/import/sheets", "POST", { url });
    const wb = XLSX.read(csv, { type: "string" });
    const parsed = parseExcel(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" }));
    if (!parsed.length) return alert("No valid numbers in that sheet.");
    parsed.forEach((c) => addRecipient({ source: "number", ...c }));
    alert(`${parsed.length} added from Google Sheets.`);
  } catch (e) { alert(e.message); } finally { $("sheet-import").disabled = false; }
});

// Saved Lists
async function loadLists() {
  try {
    const { lists = [] } = await api("/lists");
    const byId = Object.fromEntries(lists.map((l) => [l.id, l]));
    $("lists-list").innerHTML = lists.length
      ? `<div style="margin-bottom:10px"><button type="button" class="btn-secondary" id="send-ticked">Send to ticked lists</button></div>` +
        lists.map((l) => `<div class="pick-row"><label class="list-pick" style="flex:1"><input type="checkbox" data-tick="${l.id}" /><div><div class="pname">${esc(l.name)}</div><div class="ptarget">${l.recipients.length} recipient(s)</div></div></label><div class="row-actions"><button data-addlist="${l.id}">Add all</button><button data-sendlist="${l.id}">Send</button><button data-dellist="${l.id}">Delete</button></div></div>`).join("")
      : `<p class="empty-note">No saved lists yet. Select recipients, then “Save as list”.</p>`;
    $("lists-list").querySelectorAll("[data-addlist]").forEach((b) => b.addEventListener("click", () => { (byId[b.dataset.addlist]?.recipients || []).forEach(addRecipient); markAdded(b); }));
    $("lists-list").querySelectorAll("[data-sendlist]").forEach((b) => b.addEventListener("click", () => createCampaign(false, byId[b.dataset.sendlist]?.recipients || [])));
    $("lists-list").querySelectorAll("[data-dellist]").forEach((b) => b.addEventListener("click", async () => { if (confirm("Delete this list?")) { await api(`/lists/${b.dataset.dellist}`, "DELETE"); loadLists(); } }));
    const ticked = document.getElementById("send-ticked");
    if (ticked) ticked.addEventListener("click", () => {
      const ids = [...$("lists-list").querySelectorAll("[data-tick]:checked")].map((c) => c.dataset.tick);
      if (!ids.length) return alert("Tick at least one list.");
      const seen = new Set(), recs = [];
      ids.forEach((id) => (byId[id]?.recipients || []).forEach((r) => { const k = recKey(r); if (!seen.has(k)) { seen.add(k); recs.push(r); } }));
      createCampaign(false, recs);
    });
  } catch (e) { $("lists-list").innerHTML = `<p class="empty-note">${esc(e.message)}</p>`; }
}
$("save-as-list").addEventListener("click", async () => {
  if (!selected.length) return alert("Select recipients first.");
  const name = prompt("Name this list:");
  if (!name) return;
  try { await api("/lists", "POST", { name, recipients: selected }); alert("List saved."); } catch (e) { alert(e.message); }
});

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

async function createCampaign(forceNow, overrideRecipients) {
  const contacts = overrideRecipients || buildContacts();
  const template = $("message").value.trim();
  if (!contacts.length) return alert("Add at least one recipient.");
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

// ---------- Chatbot ----------
let botSettings = null, botRules = [], unsubscribers = [], botSyncSeq = 0, botLoaded = false;

async function ensureBotState() {
  if (botLoaded) return;
  const data = await api("/wa/bot");
  botSettings = data.settings;
  botRules = data.rules || [];
  unsubscribers = data.unsubscribers || [];
  botSyncSeq = data.seq || 0;
  if (!botSettings) {
    const def = await api("/wa/bot/defaults");
    botSettings = def.settings;
    if (!botRules.length) botRules = def.rules || [];
  }
  botLoaded = true;
}

async function loadBot() {
  try { await ensureBotState(); renderBotUI(); }
  catch (e) { $("bot-status").textContent = e.message; }
}

function renderBotUI() {
  const s = botSettings || {};
  $("bot-enabled").checked = !!s.enabled;
  $("bot-welcome-kw").value = s.welcomeKeywords || "";
  $("bot-welcome-msg").value = s.welcomeMessage || "";
  $("bot-fallback-enabled").checked = !!s.fallbackEnabled;
  $("bot-fallback-msg").value = s.fallbackMessage || "";
  $("bot-auto-unsub").checked = !!s.autoUnsubscribe;
  $("bot-stop-kw").value = s.stopKeywords || "";
  $("bot-start-kw").value = s.startKeywords || "";
  $("bot-unsub-reply").value = s.unsubscribeReply || "";
  renderRules();
}

function renderRules() {
  $("rule-list").innerHTML = botRules.length
    ? botRules.map((r, i) => `<div class="pick-row rule-row ${r.enabled === false ? "off" : ""}"><label class="rule-toggle"><input type="checkbox" data-rule-on="${i}" ${r.enabled === false ? "" : "checked"} /></label><div class="rule-body"><div class="pname">${esc(r.keyword)} <span class="match-badge">${esc(r.match || "contains")}</span></div><div class="ptext">${esc(r.reply)}</div></div><button data-rule-del="${i}">Delete</button></div>`).join("")
    : `<p class="empty-note">No rules yet.</p>`;
  $("rule-list").querySelectorAll("[data-rule-on]").forEach((c) => c.addEventListener("change", () => { botRules[c.dataset.ruleOn].enabled = c.checked; }));
  $("rule-list").querySelectorAll("[data-rule-del]").forEach((b) => b.addEventListener("click", () => { botRules.splice(Number(b.dataset.ruleDel), 1); renderRules(); }));
}

$("rule-add").addEventListener("click", () => {
  const keyword = $("rule-kw").value.trim(), reply = $("rule-reply").value.trim();
  if (!keyword || !reply) return alert("Enter a keyword and a reply.");
  botRules.push({ id: "r" + Date.now(), keyword, match: $("rule-match").value, enabled: true, reply });
  $("rule-kw").value = ""; $("rule-reply").value = "";
  renderRules();
});

function readBotUI() {
  botSettings = {
    ...(botSettings || {}),
    enabled: $("bot-enabled").checked,
    welcomeKeywords: $("bot-welcome-kw").value,
    welcomeMessage: $("bot-welcome-msg").value,
    fallbackEnabled: $("bot-fallback-enabled").checked,
    fallbackMessage: $("bot-fallback-msg").value,
    autoUnsubscribe: $("bot-auto-unsub").checked,
    stopKeywords: $("bot-stop-kw").value,
    startKeywords: $("bot-start-kw").value,
    unsubscribeReply: $("bot-unsub-reply").value,
  };
}

async function syncBot() {
  const result = await api("/wa/bot/sync", "POST", {
    config: { settings: botSettings, rules: botRules, footerKeywords: botSettings?.stopKeywords || "" },
    unsubscribers,
    since: botSyncSeq,
  });
  botSyncSeq = result.seq || 0;
  if (result.changes?.length) {
    for (const ch of result.changes) {
      if (ch.op === "remove") unsubscribers = unsubscribers.filter((e) => !ch.entries.includes(e));
      else { const have = new Set(unsubscribers.map((e) => e.toLowerCase())); unsubscribers.push(...ch.entries.filter((e) => !have.has(e.toLowerCase()))); }
    }
  }
  return result;
}

$("bot-save").addEventListener("click", async () => {
  readBotUI();
  $("bot-save").disabled = true;
  $("bot-status").textContent = "Saving…";
  try {
    const r = await syncBot();
    $("bot-status").textContent = r.running ? "Saved. Replies go out from the server." : r.active ? "Saved. Will reply once WhatsApp is linked." : "Saved. Chatbot is off.";
  } catch (e) { $("bot-status").textContent = e.message; } finally { $("bot-save").disabled = false; }
});

// Test reply — same matching engine the server uses (chatbot.js), on the current (even unsaved) config.
$("bot-test-btn").addEventListener("click", () => {
  readBotUI();
  if (!window.SwasBot) return alert("Chatbot engine not loaded — refresh the page.");
  const config = SwasBot.buildConfig(botSettings, botRules, botSettings.stopKeywords || "");
  const action = SwasBot.matchMessage($("bot-test-input").value, config, { inSession: $("bot-test-session").checked, unsubscribed: $("bot-test-unsub").checked });
  const box = $("bot-test-result");
  box.classList.remove("hidden");
  box.innerHTML = action
    ? `<p class="hint" style="margin:0 0 6px">${esc(action.label)}</p><div class="bubble">${esc(action.reply).replace(/\n/g, "<br>")}</div>`
    : `<p class="hint" style="margin:0">No reply — the bot would stay silent for this message.</p>`;
});

// ---------- Unsubscribers ----------
async function loadUnsub() {
  try {
    await ensureBotState();
    $("unsub-text").value = unsubscribers.join("\n");
    $("unsub-count").textContent = unsubscribers.length;
  } catch (e) { $("unsub-status").textContent = e.message; }
}
$("unsub-save").addEventListener("click", async () => {
  unsubscribers = $("unsub-text").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  $("unsub-save").disabled = true;
  $("unsub-status").textContent = "Saving…";
  try { await syncBot(); $("unsub-count").textContent = unsubscribers.length; $("unsub-text").value = unsubscribers.join("\n"); $("unsub-status").textContent = "Saved."; }
  catch (e) { $("unsub-status").textContent = e.message; } finally { $("unsub-save").disabled = false; }
});

// ---------- Quick replies (local) ----------
function quickList() { try { return JSON.parse(localStorage.getItem("starshiftQuick") || "[]"); } catch { return []; } }
function renderQuick() {
  const list = quickList();
  $("qr-list").innerHTML = list.length
    ? list.map((q, i) => `<div class="pick-row"><div><div class="pname">${esc(q.title)}</div><div class="ptext">${esc(q.text)}</div></div><div class="row-actions"><button data-qr-copy="${i}">Copy</button><button data-qr-del="${i}">Delete</button></div></div>`).join("")
    : `<p class="empty-note">No quick replies yet.</p>`;
  $("qr-list").querySelectorAll("[data-qr-copy]").forEach((b) => b.addEventListener("click", () => { navigator.clipboard?.writeText(list[b.dataset.qrCopy].text); b.textContent = "Copied"; }));
  $("qr-list").querySelectorAll("[data-qr-del]").forEach((b) => b.addEventListener("click", () => { const l = quickList(); l.splice(Number(b.dataset.qrDel), 1); localStorage.setItem("starshiftQuick", JSON.stringify(l)); renderQuick(); }));
}
$("qr-add").addEventListener("click", () => {
  const title = $("qr-title").value.trim(), text = $("qr-text").value.trim();
  if (!title || !text) return alert("Enter a title and reply text.");
  const l = quickList(); l.unshift({ title, text });
  try { localStorage.setItem("starshiftQuick", JSON.stringify(l)); } catch { /* private mode */ }
  $("qr-title").value = ""; $("qr-text").value = "";
  renderQuick();
});

// ---------- Boot ----------
if (token) api("/auth/me").then((me) => signedIn(me.mobile, me.role)).catch(() => signOut());
