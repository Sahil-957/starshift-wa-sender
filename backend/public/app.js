const $ = (id) => document.getElementById(id);
const tokenKey = "starshiftToken";
let token = sessionStorage.getItem(tokenKey) || "";
let statusPoller, progressPoller, countdownTimer, reportsPoller, sheetPoller, bcPoller;
let activeCampaignId = null;
let accountMobile = ""; // the logged-in account's number, used to prefill phone-code linking
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
// Premium add-ons the seller can switch off per account; an unset flag means on.
let features = { chatbot: true, extract: true };
function applyFeatures() {
  const map = { chatbot: features.chatbot !== false, extract: features.extract !== false };
  document.querySelectorAll(".nav-tab[data-page]").forEach((tab) => {
    const page = tab.dataset.page;
    if (page in map) tab.classList.toggle("hidden", !map[page]);
  });
  // If the open page just got switched off, fall back to New Campaign.
  const current = document.querySelector('.nav-tab[aria-selected="true"]')?.dataset.page;
  if (current && current in map && !map[current]) showPage("campaign");
}

function signedIn(mobile, role, feats) {
  features = feats || { chatbot: true, extract: true };
  document.body.classList.remove("locked");
  $("login-view").classList.add("hidden");
  $("forgot-view").classList.add("hidden");
  $("logout").classList.remove("hidden");
  $("admin-link").classList.toggle("hidden", role !== "admin");
  accountMobile = mobile || "";
  $("account-label").textContent = mobile ? `Logged in as +${mobile}` : "";
  applyFeatures();
  showPage("campaign");
  refreshStatus();
  loadActiveCampaign();
  updatePreview();
  loadSelected();
  renderSelected();
  loadDrafts();
  // Show cached contacts/groups instantly, then refresh them in the background - a refresh never empties them.
  _contacts = cacheGet("starshiftContacts");
  _groups = cacheGet("starshiftGroups");
  renderContacts("");
  renderGroups("");
  syncContacts(false);
  syncGroups(false);
  restoreWatches();
}

function signOut() {
  sessionStorage.removeItem(tokenKey);
  token = "";
  [statusPoller, progressPoller, reportsPoller, sheetPoller, bcPoller].forEach(clearTimeout);
  clearInterval(countdownTimer);
  clearInterval(bcWatchTimer); bcWatchTimer = null; bcHandles.clear();
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
    signedIn(result.mobile, result.role, result.features);
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
const PAGES = ["campaign", "sheet", "broadcast", "reports", "chatbot", "quick", "unsub", "extract", "api"];
function showPage(page) {
  document.querySelectorAll(".nav-tab").forEach((tab) => tab.setAttribute("aria-selected", tab.dataset.page === page));
  PAGES.forEach((p) => { const sec = $("page-" + p); if (sec) sec.classList.toggle("hidden", p !== page); });
  clearTimeout(reportsPoller);
  clearTimeout(sheetPoller);
  if (page === "reports") loadReports();
  if (page === "chatbot") loadBot();
  if (page === "quick") renderQuick();
  if (page === "unsub") loadUnsub();
  if (page === "sheet") loadSheetJobs();
  if (page === "broadcast") loadBroadcasts();
  if (page === "extract") loadChats();
  if (page === "api") loadApiKey();
}
document.querySelectorAll(".nav-tab").forEach((tab) => tab.addEventListener("click", () => showPage(tab.dataset.page)));

// ---------- WhatsApp connection ----------
$("wa-chip-btn").addEventListener("click", () => $("wa-panel").classList.toggle("hidden"));

async function refreshStatus() {
  try {
    const status = await api("/wa/status");
    const connected = status.state === "open";
    const pairing = status.state === "pairing";
    $("status-text").textContent = connected
      ? `WhatsApp: +${status.me || ""}`
      : status.state === "qr" ? "Scan QR to link"
      : pairing ? "Enter code on phone"
      : status.state === "connecting" ? "Connecting…" : "WhatsApp not linked";
    $("status-dot").className = "wa-dot " + (connected ? "ok" : status.state === "disconnected" ? "off" : "busy");
    $("connection-state").textContent = connected
      ? `Connected as +${status.me || ""}. Messages send from this server, even with your browser closed.`
      : status.state === "qr" ? "Scan this QR in WhatsApp → Linked devices → Link a device."
      : pairing ? "Type the code below into your phone to link."
      : status.state === "connecting" ? "Preparing a secure connection…" : "Click “Link WhatsApp”, then choose Scan QR or Use mobile number.";
    if (status.qr) { $("qr").src = status.qr; $("qr").classList.remove("hidden"); } else $("qr").classList.add("hidden");
    if (pairing && status.pairingCode) {
      const c = status.pairingCode;
      $("pair-code").textContent = c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
      $("pair-code").classList.remove("hidden");
      $("pair-box").classList.remove("hidden");
    }
    $("link-methods").classList.toggle("hidden", connected);
    $("connect").classList.toggle("hidden", connected || status.state === "qr" || pairing);
    $("unlink").classList.toggle("hidden", !connected);
    if (status.state === "qr" || status.state === "connecting" || pairing) $("wa-panel").classList.remove("hidden");
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

// Linking method: Scan QR (default) vs enter a code on the phone.
$("method-qr").addEventListener("click", async () => {
  $("pair-box").classList.add("hidden");
  $("connection-state").textContent = "Starting QR…";
  try { await api("/wa/logout", "POST", {}); await api("/wa/connect", "POST", {}); await refreshStatus(); }
  catch (error) { $("connection-state").textContent = error.message; }
});

$("method-phone").addEventListener("click", () => {
  $("qr").classList.add("hidden");
  $("pair-code").classList.add("hidden");
  $("pair-box").classList.remove("hidden");
  if (!$("pair-phone").value) $("pair-phone").value = accountMobile;
});

$("pair-get").addEventListener("click", async () => {
  const phone = $("pair-phone").value.replace(/\D/g, "");
  if (phone.length < 10) { $("connection-state").textContent = "Enter the number with country code, e.g. 919876543210."; return; }
  const btn = $("pair-get");
  btn.disabled = true;
  $("pair-code").classList.add("hidden");
  $("connection-state").textContent = "Requesting a code from WhatsApp…";
  try {
    await api("/wa/logout", "POST", {}); // reset any QR attempt in progress
    const res = await api("/wa/connect", "POST", { phone });
    if (res.pairingCode) {
      const c = res.pairingCode;
      $("pair-code").textContent = c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
      $("pair-code").classList.remove("hidden");
      $("connection-state").textContent = "Type this code into your phone to link.";
    } else {
      $("connection-state").textContent = "Could not get a code — try Scan QR instead.";
    }
    await refreshStatus();
  } catch (error) {
    $("connection-state").textContent = error.message;
  } finally {
    btn.disabled = false;
  }
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
    ? selected.map((r, i) => `<div class="pick-row"><div><div class="pname">${esc(r.name || r.mobile)}</div><div class="ptarget">${r.source === "group" ? "Group" : r.mobile || "contact"}</div></div><button data-rm="${i}">Remove</button></div>`).join("")
    : `<p class="empty-note">Nobody selected yet.</p>`;
  $("selected-list").querySelectorAll("[data-rm]").forEach((b) =>
    b.addEventListener("click", () => { selected.splice(Number(b.dataset.rm), 1); renderSelected(); })
  );
  saveSelected();
}
// allowDup: imports (Excel / Google Sheets) keep every row even if the number repeats; picking from
// contacts/groups/lists stays deduped so an accidental double-click doesn't add the same person twice.
function addRecipient(r, allowDup) {
  const rec = { source: r.source || "number", name: r.name || "", mobile: (r.mobile || "").replace(/\D/g, ""), custom1: r.custom1 || "", custom2: r.custom2 || "", fields: r.fields || {} };
  if (allowDup || !selected.some((x) => recKey(x) === recKey(rec))) selected.push(rec);
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
    parsed.forEach((c) => addRecipient({ source: "number", ...c }, true));
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
    parsed.forEach((c) => addRecipient({ source: "number", ...c }, true));
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

// ---------- Saved drafts (the whole compose form, reusable later) ----------
let draftsById = {};

// Snapshot every compose field (including any attachment) so a draft restores the form exactly.
function collectForm() {
  return {
    name: $("campaign-name").value,
    message: $("message").value,
    caption: $("caption").value,
    footer: { enabled: $("footer-enabled").checked, text: $("footer-text").value, keyword: $("footer-keyword").value },
    pace: document.querySelector('input[name="pace"]:checked').value,
    gap: $("gap").value, minGap: $("min-gap").value, maxGap: $("max-gap").value,
    batchEnabled: $("batch-enabled").checked, batchSize: $("batch-size").value, batchPause: $("batch-pause").value,
    when: document.querySelector('input[name="when"]:checked').value,
    scheduleAt: $("schedule-at").value, repeat: $("repeat").value,
    attachment, // { dataUrl, name, mimeType } or null
  };
}

function applyForm(f) {
  if (!f) return;
  $("campaign-name").value = f.name || "";
  $("message").value = f.message || "";
  $("caption").value = f.caption || "";
  const ft = f.footer || {};
  $("footer-enabled").checked = !!ft.enabled;
  if (ft.text != null) $("footer-text").value = ft.text;
  if (ft.keyword != null) $("footer-keyword").value = ft.keyword;

  const paceEl = document.querySelector(`input[name="pace"][value="${f.pace === "fixed" ? "fixed" : "random"}"]`);
  if (paceEl) { paceEl.checked = true; paceEl.dispatchEvent(new Event("change")); }
  if (f.gap != null) { $("gap").value = f.gap; $("gap-range").value = f.gap; }
  if (f.minGap != null) $("min-gap").value = f.minGap;
  if (f.maxGap != null) $("max-gap").value = f.maxGap;
  $("batch-enabled").checked = f.batchEnabled !== false;
  if (f.batchSize != null) { $("batch-size").value = f.batchSize; $("batch-size-range").value = f.batchSize; }
  if (f.batchPause != null) { $("batch-pause").value = f.batchPause; $("batch-pause-range").value = f.batchPause; }

  const whenEl = document.querySelector(`input[name="when"][value="${f.when === "later" ? "later" : "now"}"]`);
  if (whenEl) { whenEl.checked = true; whenEl.dispatchEvent(new Event("change")); }
  if (f.scheduleAt != null) $("schedule-at").value = f.scheduleAt;
  if (f.repeat != null) $("repeat").value = f.repeat;

  if (f.attachment && f.attachment.dataUrl) {
    attachment = f.attachment;
    $("attach-info").textContent = `📎 ${f.attachment.name || "file"} — message is the caption.`;
    $("attach-clear").classList.remove("hidden");
  } else {
    attachment = null; $("attach").value = "";
    $("attach-info").textContent = "Photo, video, PDF or document.";
    $("attach-clear").classList.add("hidden");
  }
  updatePreview();
}

async function loadDrafts() {
  try {
    const { drafts = [], max = 5 } = await api("/drafts");
    draftsById = Object.fromEntries(drafts.map((d) => [d.id, d]));
    $("drafts-count").textContent = `(${drafts.length}/${max})`;
    $("drafts-list").innerHTML = drafts.length
      ? drafts.map((d) => `<div class="pick-row"><div style="flex:1"><div class="pname">${esc(d.name)}</div><div class="ptarget">Saved ${new Date(d.savedAt).toLocaleDateString()}</div></div><div class="row-actions"><button data-loaddraft="${d.id}">Load</button><button data-deldraft="${d.id}">Delete</button></div></div>`).join("")
      : `<p class="empty-note">No saved drafts yet. Fill the form, then “Save as draft”.</p>`;
    $("drafts-list").querySelectorAll("[data-loaddraft]").forEach((b) => b.addEventListener("click", () => applyForm(draftsById[b.dataset.loaddraft]?.form)));
    $("drafts-list").querySelectorAll("[data-deldraft]").forEach((b) => b.addEventListener("click", async () => { if (confirm("Delete this draft?")) { await api(`/drafts/${b.dataset.deldraft}`, "DELETE"); loadDrafts(); } }));
  } catch (e) { $("drafts-list").innerHTML = `<p class="empty-note">${esc(e.message)}</p>`; }
}

$("save-draft").addEventListener("click", async () => {
  if (!$("message").value.trim() && !attachment) return alert("Write a message or attach a file first.");
  const name = prompt("Name this draft (saving over the same name updates it):", $("campaign-name").value.trim());
  if (!name) return;
  try { await api("/drafts", "POST", { name, form: collectForm() }); loadDrafts(); }
  catch (e) { alert(e.message); }
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

// Pause while running, Resume while paused (the button's text says which it does now).
$("pause").addEventListener("click", async () => {
  if (!activeCampaignId) return;
  const action = $("pause").dataset.resume === "1" ? "resume" : "pause";
  try { await api(`/campaigns/${activeCampaignId}/${action}`, "POST", {}); trackProgress(); } catch (error) { alert(error.message); }
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
  // Pause/Resume: shown while active, and only once sending has actually started (can't pause a plain schedule).
  const pausable = active && c.status !== "scheduled";
  $("pause").classList.toggle("hidden", !pausable);
  $("pause").textContent = c.status === "paused" ? "Resume" : "Pause";
  $("pause").dataset.resume = c.status === "paused" ? "1" : "0";
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

// ---------- Sheet Scheduler ----------
const SHEET_LABEL = { active: "Active", cancelled: "Cancelled" };

async function loadSheetJobs() {
  clearTimeout(sheetPoller);
  try {
    const { batches = [] } = await api("/sheet-jobs");
    $("sheet-sched-list").innerHTML = batches.length
      ? batches.map(renderSheetBatch).join("")
      : `<p class="hint">No scheduled sheets yet.</p>`;
    $("sheet-sched-list").querySelectorAll("[data-sheet-act]").forEach((b) =>
      b.addEventListener("click", () => sheetAction(b.dataset.id, b.dataset.sheetAct, b)));
    if (batches.some((b) => b.status === "active" && b.counts.pending > 0)) sheetPoller = setTimeout(loadSheetJobs, 8000);
  } catch (e) { $("sheet-sched-list").innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

function renderSheetBatch(b) {
  const c = b.counts || {};
  const next = b.nextSendAt ? ` · next ${new Date(b.nextSendAt).toLocaleString()}` : "";
  const synced = b.source === "sheet" ? ` · ${b.syncEnabled ? "auto-sync on" : "sync off"}${b.lastSyncedAt ? ` (last ${new Date(b.lastSyncedAt).toLocaleTimeString()})` : ""}` : "";
  const act = (a, label) => `<button data-sheet-act="${a}" data-id="${b.id}">${label}</button>`;
  let actions = "";
  if (b.status === "active") {
    if (b.source === "sheet") actions += act("resync", "Sync now");
    actions += act("cancel", "Cancel") + act("delete", "Delete");
  } else actions = act("delete", "Delete");
  const rows = (b.rows || []).slice(0, 60).map((r) => {
    const badge = r.status === "sent" ? "status-completed" : r.status === "failed" ? "status-cancelled" : r.status === "invalid" ? "status-paused" : "status-scheduled";
    const when = r.sendAt ? new Date(r.sendAt).toLocaleString() : `${esc(r.rawDate || "")} ${esc(r.rawTime || "")}`;
    const note = r.failReason ? ` — ${esc(r.failReason)}` : "";
    return `<div class="sheet-row-item"><span class="status-badge ${badge}">${r.status}</span><span class="sheet-row-to">${esc(r.name || r.mobile)}</span><span class="sheet-row-when">${esc(when)}</span>${r.attachmentUrl ? '<span class="sheet-row-att">📎</span>' : ""}<span class="sheet-row-note">${note}</span></div>`;
  }).join("");
  return `<div class="campaign-item">
    <div class="head"><span>${esc(b.name)}</span><span class="status-badge status-${b.status === "active" ? "running" : "cancelled"}">${SHEET_LABEL[b.status] || b.status}</span></div>
    <div class="campaign-meta">${b.source === "sheet" ? "Google Sheet" : "Uploaded file"} · ${b.total} row(s)${synced}${next}</div>
    <div class="campaign-meta">Sent: ${c.sent || 0} | Failed: ${c.failed || 0} | Pending: ${c.pending || 0} | Invalid: ${c.invalid || 0}</div>
    <div class="sheet-rows">${rows}${b.rows && b.rows.length > 60 ? `<div class="hint" style="padding:6px">…and ${b.rows.length - 60} more</div>` : ""}</div>
    <div class="campaign-actions">${actions}</div>
  </div>`;
}

async function sheetAction(id, action, btn) {
  if (action === "delete" && !confirm("Delete this scheduled sheet? Pending rows will not be sent.")) return;
  if (action === "cancel" && !confirm("Cancel the pending rows in this sheet?")) return;
  if (btn) btn.disabled = true;
  try {
    if (action === "delete") await api(`/sheet-jobs/${id}`, "DELETE");
    else await api(`/sheet-jobs/${id}/${action}`, "POST", {});
    loadSheetJobs();
  } catch (e) { alert(e.message); if (btn) btn.disabled = false; }
}

$("sheet-sched-load").addEventListener("click", async () => {
  const url = $("sheet-sched-url").value.trim();
  if (!url) return alert("Paste the Google Sheet link first.");
  $("sheet-sched-load").disabled = true;
  $("sheet-sched-status").textContent = "Reading the sheet…";
  try {
    const { batch } = await api("/sheet-jobs", "POST", {
      mode: "sheet", url, name: $("sheet-sched-name").value.trim(), autoSync: $("sheet-sched-sync").checked,
    });
    $("sheet-sched-status").textContent = `Scheduled ${batch.counts.pending} row(s)${batch.counts.invalid ? `, ${batch.counts.invalid} skipped` : ""}.`;
    $("sheet-sched-url").value = ""; $("sheet-sched-name").value = "";
    loadSheetJobs();
  } catch (e) { $("sheet-sched-status").textContent = e.message; } finally { $("sheet-sched-load").disabled = false; }
});

$("sheet-sched-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  $("sheet-sched-file-info").textContent = "Reading…";
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
    const { batch } = await api("/sheet-jobs", "POST", { mode: "upload", name: $("sheet-sched-name").value.trim() || file.name, rows });
    $("sheet-sched-file-info").textContent = `${batch.counts.pending} row(s) scheduled${batch.counts.invalid ? `, ${batch.counts.invalid} skipped` : ""} from ${file.name}.`;
    loadSheetJobs();
  } catch (e) { $("sheet-sched-file-info").textContent = `Could not use that file: ${e.message}`; }
  finally { event.target.value = ""; }
});

// ---------- Auto Broadcast ----------
let bcEditing = null;        // id being edited, or null
let bcPendingFile = null;    // { dataUrl, name, mimeType } chosen before create
const FREQ_LABEL = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" };

async function populateBcLists(selectedId) {
  try {
    const { lists = [] } = await api("/lists");
    $("bc-list").innerHTML = `<option value="">— pick a saved list —</option>` +
      lists.map((l) => `<option value="${l.id}" ${l.id === selectedId ? "selected" : ""}>${esc(l.name)} (${l.recipients.length})</option>`).join("");
  } catch { /* ignore */ }
}

async function loadBroadcasts() {
  clearTimeout(bcPoller);
  await populateBcLists($("bc-list").value);
  try {
    const { broadcasts = [] } = await api("/broadcasts");
    $("bc-list-view").innerHTML = broadcasts.length
      ? broadcasts.map(renderBroadcast).join("")
      : `<p class="hint">No broadcasts yet.</p>`;
    $("bc-list-view").querySelectorAll("[data-bc-act]").forEach((b) =>
      b.addEventListener("click", () => bcAction(b.dataset.id, b.dataset.bcAct, b)));
    if (broadcasts.some((b) => b.active)) bcPoller = setTimeout(loadBroadcasts, 15000);
  } catch (e) { $("bc-list-view").innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

function renderBroadcast(b) {
  const times = b.times.join(", ");
  const next = b.nextRunAt ? new Date(b.nextRunAt).toLocaleString() : "—";
  const last = b.lastRunAt ? new Date(b.lastRunAt).toLocaleString() : "never";
  const lastRun = b.runs && b.runs[0] ? ` · last run: ${b.runs[0].sent || 0} sent, ${b.runs[0].failed || 0} failed` : "";
  const act = (a, label) => `<button data-bc-act="${a}" data-id="${b.id}">${label}</button>`;
  const watching = bcHandles.has(b.id);
  const watchLine = FS_SUPPORTED
    ? `<div class="campaign-meta" id="bc-watch-${b.id}">${watching ? "👁️ Watching your PC folder — keep this tab open." : "Not watching a PC folder."}</div>`
    : `<div class="campaign-meta">Live PC-folder watch needs Chrome or Edge.</div>`;
  const watchBtn = !FS_SUPPORTED ? ""
    : watching ? act("unwatch", "Stop watching folder") : act("watch", "👁️ Watch a PC folder (auto)");
  return `<div class="campaign-item">
    <div class="head"><span>${esc(b.name)}</span><span class="status-badge status-${b.active ? "running" : "paused"}">${b.active ? "Active" : "Paused"}</span></div>
    <div class="campaign-meta">To: ${esc(b.listName)} (${b.recipientCount}) · ${FREQ_LABEL[b.frequency] || b.frequency} at ${esc(times)}</div>
    <div class="campaign-meta">📁 Folder: ${b.file ? esc(b.file.name) : "— empty (caption only)"} · next: ${esc(next)} · last: ${esc(last)}${lastRun}</div>
    ${watchLine}
    <div class="campaign-actions">
      ${act("run-now", "Send now")}
      ${act(b.active ? "pause" : "resume", b.active ? "Pause" : "Resume")}
      ${act("edit", "Edit")}
      ${act("replace", "Put new file in folder")}
      ${watchBtn}
      ${act("delete", "Delete")}
    </div>
  </div>`;
}

// Picks the newest real file out of a folder selection (skips OS junk / hidden files).
function newestFile(fileList) {
  const junk = /(^|\/)(\.|~\$)|(^|\/)(thumbs\.db|desktop\.ini|\.ds_store)$/i;
  const files = [...(fileList || [])].filter((f) => f.size > 0 && !junk.test(f.webkitRelativePath || f.name));
  if (!files.length) return null;
  return files.sort((a, b) => b.lastModified - a.lastModified)[0];
}

// Row "Put new file in folder" — opens a folder picker and uploads its newest file.
const hiddenBcReplace = document.createElement("input");
hiddenBcReplace.type = "file";
hiddenBcReplace.webkitdirectory = true;
hiddenBcReplace.multiple = true;
hiddenBcReplace.className = "hidden";
document.body.appendChild(hiddenBcReplace);
let bcReplaceId = null;
hiddenBcReplace.addEventListener("change", async () => {
  const file = newestFile(hiddenBcReplace.files);
  if (!file || !bcReplaceId) { hiddenBcReplace.value = ""; bcReplaceId = null; if (hiddenBcReplace.files.length) alert("No usable file in that folder."); return; }
  if (file.size > MAX_ATTACH_MB * 1024 * 1024) { alert(`Newest file is too big (max ${MAX_ATTACH_MB} MB).`); hiddenBcReplace.value = ""; return; }
  try {
    const payload = { dataUrl: await readAsDataUrl(file), name: file.name, mimeType: file.type || "application/octet-stream" };
    await api(`/broadcasts/${bcReplaceId}/file`, "POST", { file: payload });
    loadBroadcasts();
  } catch (e) { alert(e.message); } finally { hiddenBcReplace.value = ""; bcReplaceId = null; }
});

async function bcAction(id, action, btn) {
  try {
    if (action === "delete") {
      if (!confirm("Delete this broadcast? Its file is removed too.")) return;
      await api(`/broadcasts/${id}`, "DELETE");
    } else if (action === "pause" || action === "resume") {
      await api(`/broadcasts/${id}`, "PATCH", { active: action === "resume" });
    } else if (action === "run-now") {
      if (btn) btn.disabled = true;
      const r = await api(`/broadcasts/${id}/run-now`, "POST", {});
      alert(`Sent ${r.sent}, failed ${r.failed}.`);
    } else if (action === "replace") {
      bcReplaceId = id; hiddenBcReplace.click(); return;
    } else if (action === "edit") {
      return bcStartEdit(id);
    } else if (action === "watch") {
      return bcStartWatch(id);
    } else if (action === "unwatch") {
      return bcStopWatch(id);
    }
    loadBroadcasts();
  } catch (e) { alert(e.message); if (btn) btn.disabled = false; }
}

// ---------- Live PC-folder watching (File System Access API; Chrome/Edge) ----------
// While this tab stays open, the chosen folder is polled: the newest file is uploaded to the
// broadcast (replacing the old on the server) and the older files in the folder are deleted.
const FS_SUPPORTED = typeof window.showDirectoryPicker === "function";
const bcHandles = new Map(); // broadcastId -> { handle, lastKey }
let bcWatchTimer = null;

function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("swasWatch", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("handles");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbPut(k, v) { const db = await idbOpen(); return new Promise((res, rej) => { const t = db.transaction("handles", "readwrite"); t.objectStore("handles").put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
async function idbGet(k) { const db = await idbOpen(); return new Promise((res) => { const rq = db.transaction("handles", "readonly").objectStore("handles").get(k); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); }); }
async function idbDel(k) { const db = await idbOpen(); return new Promise((res) => { const t = db.transaction("handles", "readwrite"); t.objectStore("handles").delete(k); t.oncomplete = () => res(); }); }
async function idbKeys() { const db = await idbOpen(); return new Promise((res) => { const rq = db.transaction("handles", "readonly").objectStore("handles").getAllKeys(); rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]); }); }

const JUNK_RE = /^(\.|~\$)|^(thumbs\.db|desktop\.ini|\.ds_store)$/i;
async function dirFilesNewestFirst(handle) {
  const files = [];
  for await (const entry of handle.values()) {
    if (entry.kind !== "file" || JUNK_RE.test(entry.name)) continue;
    const f = await entry.getFile();
    if (f.size > 0) files.push({ name: entry.name, file: f, lastModified: f.lastModified });
  }
  return files.sort((a, b) => b.lastModified - a.lastModified);
}

function setWatchStatus(id, text) { const el = $(`bc-watch-${id}`); if (el) el.textContent = text; }

async function bcStartWatch(id) {
  if (!FS_SUPPORTED) return alert("This needs Chrome or Edge.");
  let handle;
  try { handle = await window.showDirectoryPicker({ mode: "readwrite" }); }
  catch { return; } // user cancelled
  if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") return alert("Folder permission is needed.");
  bcHandles.set(id, { handle, lastKey: null });
  try { await idbPut(id, handle); } catch { /* handle not storable: in-memory only */ }
  loadBroadcasts();
  startWatchLoop();
  bcWatchTick();
}

async function bcStopWatch(id) {
  bcHandles.delete(id);
  await idbDel(id).catch(() => {});
  loadBroadcasts();
}

async function bcWatchTick() {
  for (const [id, info] of bcHandles) {
    try {
      if ((await info.handle.queryPermission({ mode: "readwrite" })) !== "granted") {
        setWatchStatus(id, "👁️ Paused — click “Watch a PC folder” again to re-allow (needed after a reload).");
        continue;
      }
      const files = await dirFilesNewestFirst(info.handle); // newest modified-time first
      if (!files.length) { setWatchStatus(id, "👁️ Watching — folder is empty."); info.seen = new Set(); info.currentName = null; continue; }
      const names = new Set(files.map((f) => f.name));

      // Which file is "just dropped in": one whose name wasn't there last check (newest among them).
      let picked = null;
      if (!info.seen) picked = files[0]; // first look after starting/reloading
      else picked = files.filter((f) => !info.seen.has(f.name)).sort((a, b) => b.lastModified - a.lastModified)[0] || null;
      info.seen = names;

      // If the file we think is current has vanished, fall back to the newest.
      if (!info.currentName || !names.has(info.currentName)) picked = picked || files[0];

      let uploadedName = null;
      if (picked) {
        const dataUrl = await readAsDataUrl(picked.file);
        await api(`/broadcasts/${id}/file`, "POST", { file: { dataUrl, name: picked.name, mimeType: picked.file.type || "application/octet-stream" } });
        info.currentName = picked.name;
        uploadedName = picked.name;
      }

      // Invariant: the folder keeps ONLY the current file. Every tick, remove the rest
      // (so stray old files are gone within one tick even when nothing new was added).
      let removed = 0, failed = 0;
      for (const f of files) {
        if (f.name === info.currentName) continue;
        try { await info.handle.removeEntry(f.name); removed++; } catch { failed++; }
      }
      if (uploadedName) setWatchStatus(id, `👁️ Sent: ${uploadedName}${removed ? ` · removed ${removed} old` : ""}${failed ? ` · ${failed} couldn't be removed (use a non-OneDrive folder)` : ""}`);
      else if (removed || failed) setWatchStatus(id, `👁️ Folder cleaned — kept ${info.currentName}${failed ? ` · ${failed} couldn't be removed (use a non-OneDrive folder)` : ""}`);
      else setWatchStatus(id, `👁️ Watching — current: ${info.currentName}`);
      if (uploadedName) loadBroadcasts();
    } catch { /* retry next tick */ }
  }
}

function startWatchLoop() {
  if (bcWatchTimer || !bcHandles.size) return;
  bcWatchTimer = setInterval(bcWatchTick, 15000);
}

async function restoreWatches() {
  if (!FS_SUPPORTED) return;
  try {
    for (const id of await idbKeys()) {
      const handle = await idbGet(id);
      if (handle) bcHandles.set(id, { handle, lastKey: null });
    }
  } catch { /* ignore */ }
  startWatchLoop();
  bcWatchTick();
}

async function bcStartEdit(id) {
  try {
    const { broadcasts = [] } = await api("/broadcasts");
    const b = broadcasts.find((x) => x.id === id);
    if (!b) return;
    bcEditing = id;
    $("bc-name").value = b.name;
    await populateBcLists(b.listId);
    $("bc-list").value = b.listId;
    $("bc-times").value = b.times.join(", ");
    $("bc-freq").value = b.frequency;
    $("bc-caption").value = b.caption;
    $("bc-file-info").textContent = b.file ? `In folder: ${b.file.name} (use “Put new file in folder” to change)` : "Folder is empty.";
    $("bc-save").textContent = "Update broadcast";
    $("bc-cancel-edit").classList.remove("hidden");
    $("bc-name").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (e) { alert(e.message); }
}

function bcResetForm() {
  bcEditing = null; bcPendingFile = null;
  $("bc-name").value = ""; $("bc-times").value = ""; $("bc-caption").value = ""; $("bc-freq").value = "daily";
  $("bc-list").value = ""; $("bc-file").value = ""; $("bc-folder").value = "";
  $("bc-file-info").textContent = "Folder is empty — caption-only is allowed.";
  $("bc-save").textContent = "Create broadcast";
  $("bc-cancel-edit").classList.add("hidden");
}
$("bc-cancel-edit").addEventListener("click", bcResetForm);

async function bcAcceptFile(file) {
  if (!file) return;
  if (file.size > MAX_ATTACH_MB * 1024 * 1024) { $("bc-file-info").textContent = `Too big (max ${MAX_ATTACH_MB} MB).`; return; }
  try {
    bcPendingFile = { dataUrl: await readAsDataUrl(file), name: file.name, mimeType: file.type || "application/octet-stream" };
    $("bc-file-info").textContent = `📁 In folder: ${file.name} (${Math.round(file.size / 1024)} KB)`;
    // When editing an existing broadcast, put it in the folder straight away.
    if (bcEditing) { try { await api(`/broadcasts/${bcEditing}/file`, "POST", { file: bcPendingFile }); bcPendingFile = null; $("bc-status").textContent = "Folder updated."; loadBroadcasts(); } catch (e) { alert(e.message); } }
  } catch (e) { bcPendingFile = null; $("bc-file-info").textContent = e.message; }
}
$("bc-file").addEventListener("change", (event) => { bcAcceptFile(event.target.files[0]); event.target.value = ""; });
$("bc-folder").addEventListener("change", (event) => {
  const file = newestFile(event.target.files);
  if (!file && event.target.files.length) $("bc-file-info").textContent = "No usable file in that folder.";
  bcAcceptFile(file);
  event.target.value = "";
});

$("bc-save").addEventListener("click", async () => {
  const body = {
    name: $("bc-name").value.trim(),
    listId: $("bc-list").value,
    times: $("bc-times").value,
    frequency: $("bc-freq").value,
    caption: $("bc-caption").value,
  };
  if (!body.listId) return alert("Pick a saved list.");
  if (!body.times.trim()) return alert("Add at least one send time.");
  $("bc-save").disabled = true;
  $("bc-status").textContent = "Saving…";
  try {
    if (bcEditing) {
      await api(`/broadcasts/${bcEditing}`, "PATCH", body);
      if (bcPendingFile) await api(`/broadcasts/${bcEditing}/file`, "POST", { file: bcPendingFile });
      $("bc-status").textContent = "Updated.";
    } else {
      await api("/broadcasts", "POST", { ...body, file: bcPendingFile });
      $("bc-status").textContent = "Broadcast created.";
    }
    bcResetForm();
    loadBroadcasts();
  } catch (e) { $("bc-status").textContent = e.message; } finally { $("bc-save").disabled = false; }
});

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
let botSettings = null, botRules = [], unsubscribers = [], botSyncSeq = 0, botLoaded = false, editingRule = -1;

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
  $("bot-rewelcome").value = s.rewelcomeMinutes ?? 2;
  $("bot-auto-unsub").checked = !!s.autoUnsubscribe;
  $("bot-stop-kw").value = s.stopKeywords || "";
  $("bot-start-kw").value = s.startKeywords || "";
  $("bot-unsub-reply").value = s.unsubscribeReply || "";
  $("bot-bilingual").checked = !!s.bilingual;
  $("bot-lang-menu").value = s.languageMenu || "";
  $("bot-welcome-msg-en").value = s.welcomeMessageEn || "";
  $("bot-fallback-msg-en").value = s.fallbackMessageEn || "";
  $("bot-unsub-reply-en").value = s.unsubscribeReplyEn || "";
  $("bot-lookup-enabled").checked = !!s.lookupEnabled;
  $("bot-lookup-kw").value = s.lookupKeywords || "";
  $("bot-lookup-notreg").value = s.notRegisteredMessage || "";
  toggleBilingual();
  renderRules();
  loadBotData();
}

function toggleBilingual() {
  const on = $("bot-bilingual").checked;
  $("bilingual-fields").classList.toggle("hidden", !on);
  $("welcome-lang-note").textContent = on ? "(Marathi)" : "";
}
$("bot-bilingual").addEventListener("change", toggleBilingual);

function renderRules() {
  $("rule-list").innerHTML = botRules.length
    ? botRules.map((r, i) => `<div class="pick-row rule-row ${r.enabled === false ? "off" : ""} ${i === editingRule ? "editing" : ""}"><label class="rule-toggle"><input type="checkbox" data-rule-on="${i}" ${r.enabled === false ? "" : "checked"} /></label><div class="rule-body"><div class="pname">${esc(r.keyword)} <span class="match-badge">${esc(r.match || "contains")}</span></div><div class="ptext">${esc(r.reply)}</div></div><div class="row-actions"><button data-rule-edit="${i}">Edit</button><button data-rule-del="${i}">Delete</button></div></div>`).join("")
    : `<p class="empty-note">No rules yet.</p>`;
  $("rule-list").querySelectorAll("[data-rule-on]").forEach((c) => c.addEventListener("change", () => { botRules[c.dataset.ruleOn].enabled = c.checked; }));
  $("rule-list").querySelectorAll("[data-rule-del]").forEach((b) => b.addEventListener("click", () => { const i = Number(b.dataset.ruleDel); botRules.splice(i, 1); if (editingRule === i) resetRuleForm(); renderRules(); }));
  $("rule-list").querySelectorAll("[data-rule-edit]").forEach((b) => b.addEventListener("click", () => {
    const r = botRules[Number(b.dataset.ruleEdit)];
    $("rule-kw").value = r.keyword; $("rule-match").value = r.match || "contains"; $("rule-reply").value = r.reply; $("rule-reply-en").value = r.replyEn || "";
    editingRule = Number(b.dataset.ruleEdit);
    $("rule-add").textContent = "Update rule";
    renderRules();
    $("rule-kw").scrollIntoView({ behavior: "smooth", block: "center" }); $("rule-kw").focus();
  }));
}

function resetRuleForm() {
  editingRule = -1;
  $("rule-kw").value = ""; $("rule-reply").value = ""; $("rule-reply-en").value = ""; $("rule-match").value = "contains";
  $("rule-add").textContent = "Add rule";
}

$("rule-add").addEventListener("click", () => {
  const keyword = $("rule-kw").value.trim(), reply = $("rule-reply").value.trim(), replyEn = $("rule-reply-en").value.trim();
  if (!keyword || !reply) return alert("Enter a keyword and a reply.");
  const match = $("rule-match").value;
  if (editingRule >= 0) {
    botRules[editingRule] = { ...botRules[editingRule], keyword, match, reply, replyEn };
  } else {
    botRules.push({ id: "r" + Date.now(), keyword, match, enabled: true, reply, replyEn });
  }
  resetRuleForm();
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
    rewelcomeMinutes: Number($("bot-rewelcome").value) || 0,
    autoUnsubscribe: $("bot-auto-unsub").checked,
    stopKeywords: $("bot-stop-kw").value,
    startKeywords: $("bot-start-kw").value,
    unsubscribeReply: $("bot-unsub-reply").value,
    bilingual: $("bot-bilingual").checked,
    languageMenu: $("bot-lang-menu").value,
    welcomeMessageEn: $("bot-welcome-msg-en").value,
    fallbackMessageEn: $("bot-fallback-msg-en").value,
    unsubscribeReplyEn: $("bot-unsub-reply-en").value,
    lookupEnabled: $("bot-lookup-enabled").checked,
    lookupKeywords: $("bot-lookup-kw").value,
    notRegisteredMessage: $("bot-lookup-notreg").value,
  };
}

// ---------- Chatbot data-lookup sheet ----------
async function loadBotData() {
  try {
    const d = await api("/wa/bot/data");
    $("bot-data-clear").classList.toggle("hidden", !d.loaded);
    $("bot-data-status").textContent = d.loaded
      ? `✅ ${d.count} number(s) loaded · columns: ${d.headers.join(", ")}${d.updatedAt ? ` · updated ${new Date(d.updatedAt).toLocaleString()}` : ""}`
      : "No data sheet loaded yet.";
  } catch (e) { $("bot-data-status").textContent = e.message; }
}

async function uploadBotData(rows, sourceLabel) {
  $("bot-data-status").textContent = "Loading…";
  try {
    const d = await api("/wa/bot/data", "POST", { rows });
    $("bot-data-status").textContent = `✅ ${d.count} number(s) loaded from ${sourceLabel} · columns: ${d.headers.join(", ")}`;
    $("bot-data-clear").classList.remove("hidden");
  } catch (e) { $("bot-data-status").textContent = e.message; }
}

$("bot-data-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
    await uploadBotData(rows, file.name);
  } catch (e) { $("bot-data-status").textContent = `Could not read: ${e.message}`; }
  finally { event.target.value = ""; }
});

$("bot-data-import").addEventListener("click", async () => {
  const url = $("bot-data-url").value.trim();
  if (!url) return;
  $("bot-data-import").disabled = true;
  try {
    const { csv } = await api("/import/sheets", "POST", { url });
    const wb = XLSX.read(csv, { type: "string" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
    await uploadBotData(rows, "Google Sheets");
    $("bot-data-url").value = "";
  } catch (e) { $("bot-data-status").textContent = e.message; } finally { $("bot-data-import").disabled = false; }
});

$("bot-data-clear").addEventListener("click", async () => {
  if (!confirm("Clear the loaded data sheet?")) return;
  try { await api("/wa/bot/data", "DELETE"); loadBotData(); } catch (e) { alert(e.message); }
});

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

// ---------- Chat Extract ----------
const RANGE_LABEL = { today: "today", "7days": "last-7-days", "15days": "last-15-days", "1month": "last-1-month", "2months": "last-2-months", all: "all" };

function pad2(n) { return String(n).padStart(2, "0"); }
function fmtDate(ms) { const d = new Date(ms); return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}`; }
function fmtTime(ms) { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function safeName(s) { return String(s || "").replace(/[^\w.-]+/g, "_").slice(0, 40) || "export"; }

/** Saves rows (array of flat objects) as an .xlsx download. */
function downloadXlsx(rows, sheetName, fileName) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, fileName);
}

function optionsHtml(items) {
  return items.map((it) => `<option value="${esc(it.jid)}">${esc(it.label)}</option>`).join("");
}

// The full picker contents, kept so the search box can filter without re-fetching. { recorded, groups, contacts }.
let _extractItems = { recorded: [], groups: [], contacts: [] };

/** Rebuilds the <select> from _extractItems, keeping only rows whose label matches the query. */
function renderExtractOptions(query = "") {
  const sel = $("extract-chat");
  const q = query.trim().toLowerCase();
  const hit = (it) => !q || it.label.toLowerCase().includes(q);
  const recorded = _extractItems.recorded.filter(hit);
  const groups = _extractItems.groups.filter(hit);
  const contacts = _extractItems.contacts.filter(hit);
  const current = sel.value;
  sel.innerHTML =
    (q ? "" : '<option value="all">All chats</option>') +
    (recorded.length ? `<optgroup label="Recorded chats">${optionsHtml(recorded)}</optgroup>` : "") +
    (groups.length ? `<optgroup label="Groups">${optionsHtml(groups)}</optgroup>` : "") +
    (contacts.length ? `<optgroup label="Contacts">${optionsHtml(contacts)}</optgroup>` : "");
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
  else if (sel.options.length) sel.selectedIndex = 0;
}

async function loadChats() {
  $("extract-status").textContent = "Loading groups and contacts…";
  try {
    // Recorded chats definitely have messages; groups and contacts let the user pick a target up front
    // even before anything is recorded for it. All three are keyed by the same jid the export filters on.
    const [{ chats }, groupsRes, contactsRes] = await Promise.all([
      api("/wa/chats"),
      api("/wa/groups").catch(() => ({ groups: [] })),
      api("/wa/contacts").catch(() => ({ contacts: [] })),
    ]);
    const seen = new Set(chats.map((c) => c.jid));
    _extractItems = {
      recorded: chats.map((c) => ({
        jid: c.jid,
        label: `${c.name || c.number || "Unknown"}${c.group ? " (Group)" : c.number ? ` · ${c.number}` : ""} — ${c.count} msg`,
      })),
      groups: (groupsRes.groups || [])
        .filter((g) => g.jid && !seen.has(g.jid))
        .map((g) => ({ jid: g.jid, label: g.name })),
      contacts: (contactsRes.contacts || [])
        .filter((c) => c.number)
        .map((c) => ({ jid: `${c.number}@s.whatsapp.net`, label: `${c.name || c.number} · ${c.number}` }))
        .filter((c) => !seen.has(c.jid)),
    };
    renderExtractOptions($("extract-search").value);
    // Group-members picker gets every group the account is in (not just the unrecorded ones).
    const allGroups = (groupsRes.groups || []).slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const mg = $("members-group");
    const mgCurrent = mg.value;
    mg.innerHTML = '<option value="">— pick a group —</option>' + allGroups.map((g) => `<option value="${esc(g.jid)}">${esc(g.name)}</option>`).join("");
    if ([...mg.options].some((o) => o.value === mgCurrent)) mg.value = mgCurrent;
    const total = _extractItems.recorded.length + _extractItems.groups.length + _extractItems.contacts.length;
    $("extract-status").textContent = total ? "" : "Link the server WhatsApp to see your groups and contacts.";
  } catch (e) {
    $("extract-status").textContent = e.message;
  }
}

$("extract-refresh").addEventListener("click", loadChats);
$("extract-search").addEventListener("input", (e) => renderExtractOptions(e.target.value));

$("extract-download").addEventListener("click", async () => {
  // A typed number wins over the dropdown; otherwise use the selected group/contact (or all chats).
  const typed = $("extract-number").value.replace(/\D/g, "");
  const jid = typed ? `${typed}@s.whatsapp.net` : $("extract-chat").value;
  const range = $("extract-range").value;
  const btn = $("extract-download");
  btn.disabled = true;
  $("extract-status").textContent = "Preparing Excel…";
  try {
    const { rows } = await api(`/wa/chat-export?jid=${encodeURIComponent(jid)}&range=${encodeURIComponent(range)}`);
    if (!rows.length) { $("extract-status").textContent = "No messages recorded yet for this chat and date range. They are saved from now on."; return; }
    const out = rows.map((r) => ({
      Date: fmtDate(r.at),
      Time: fmtTime(r.at),
      Chat: r.chat,
      Type: r.type,
      Direction: r.direction,
      Name: r.name,
      Mobile: r.number,
      Message: r.text,
    }));
    const who = typed ? typed : jid === "all" ? "all-chats" : safeName($("extract-chat").selectedOptions[0]?.text.split(" — ")[0]);
    downloadXlsx(out, "Chats", `chat-${who}-${RANGE_LABEL[range] || range}.xlsx`);
    $("extract-status").textContent = `Downloaded ${rows.length} message${rows.length === 1 ? "" : "s"}.`;
  } catch (e) {
    $("extract-status").textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

$("extract-older").addEventListener("click", async () => {
  const typed = $("extract-number").value.replace(/\D/g, "");
  const jid = typed ? `${typed}@s.whatsapp.net` : $("extract-chat").value;
  if (!jid || jid === "all") { $("extract-status").textContent = "Pick one chat (a group or a contact) first."; return; }
  const btn = $("extract-older");
  btn.disabled = true;
  $("extract-status").textContent = "Asking WhatsApp for older messages…";
  try {
    await api("/wa/chat-history", "POST", { jid, count: 50 });
    $("extract-status").textContent = "Requested. Older messages are arriving — wait ~5 seconds, then Download again.";
    setTimeout(loadChats, 6000); // refresh counts once they land
  } catch (e) {
    $("extract-status").textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

$("members-download").addEventListener("click", async () => {
  const jid = $("members-group").value;
  if (!jid) { $("members-status").textContent = "Pick a group first."; return; }
  const btn = $("members-download");
  btn.disabled = true;
  $("members-status").textContent = "Fetching members…";
  try {
    const { subject, members } = await api(`/wa/group-members?jid=${encodeURIComponent(jid)}`);
    if (!members.length) { $("members-status").textContent = "No members found for this group."; return; }
    const out = members.map((m) => ({ Name: m.name || "", Mobile: m.number || "", Role: m.role || "" }));
    downloadXlsx(out, "Members", `group-members-${safeName(subject)}.xlsx`);
    const withNum = members.filter((m) => m.number).length;
    $("members-status").textContent = `Downloaded ${members.length} members (${withNum} with a number).`;
  } catch (e) {
    $("members-status").textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

$("numbers-download").addEventListener("click", async () => {
  const btn = $("numbers-download");
  btn.disabled = true;
  $("numbers-status").textContent = "Preparing Excel…";
  try {
    const { contacts } = await api("/wa/contacts");
    if (!contacts.length) { $("numbers-status").textContent = "No contacts known yet. Sync contacts from New Campaign first."; return; }
    const out = contacts.map((c) => ({ Name: c.name || "", Mobile: c.number || "" }));
    downloadXlsx(out, "Numbers", "mobile-numbers.xlsx");
    $("numbers-status").textContent = `Downloaded ${contacts.length} number${contacts.length === 1 ? "" : "s"}.`;
  } catch (e) {
    $("numbers-status").textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- API key ----------
let _apiKey = "";
function renderApiExamples() {
  const base = location.origin;
  $("api-base").textContent = base;
  const key = _apiKey || "YOUR_API_KEY";
  $("api-ex-send").textContent =
    `curl -X POST ${base}/api/v1/send \\\n` +
    `  -H "x-api-key: ${key}" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"to":"919876543210","message":"Hi {{name}}","name":"Ramesh"}'`;
  $("api-ex-campaign").textContent =
    `curl -X POST ${base}/api/v1/campaign \\\n` +
    `  -H "x-api-key: ${key}" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"name":"Offer","message":"Hi {{name}}","gapSeconds":20,` +
    `"recipients":[{"mobile":"919876543210","name":"Ramesh"},{"mobile":"919812345678","name":"Sita"}]}'`;
}
async function loadApiKey() {
  try {
    const { apiKey } = await api("/account/apikey");
    _apiKey = apiKey || "";
    $("api-key").value = _apiKey;
    renderApiExamples();
  } catch (e) { $("api-status").textContent = e.message; }
}
$("api-rotate").addEventListener("click", async () => {
  if (_apiKey && !confirm("Generate a new key? The current key stops working immediately.")) return;
  try {
    const { apiKey } = await api("/account/apikey/rotate", "POST", {});
    _apiKey = apiKey; $("api-key").value = apiKey; renderApiExamples();
    $("api-status").textContent = "New key generated — copy and store it safely.";
  } catch (e) { $("api-status").textContent = e.message; }
});
$("api-copy").addEventListener("click", () => {
  if (!_apiKey) { $("api-status").textContent = "Generate a key first."; return; }
  navigator.clipboard?.writeText(_apiKey);
  $("api-status").textContent = "Copied.";
});

// ---------- Boot ----------
if (token) api("/auth/me").then((me) => signedIn(me.mobile, me.role, me.features)).catch(() => signOut());
