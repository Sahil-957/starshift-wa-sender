const $ = (id) => document.getElementById(id);
const tokenKey = "starshiftToken";
let token = sessionStorage.getItem(tokenKey) || "";
let statusPoller, progressPoller, countdownTimer, reportsPoller, sheetPoller, bcPoller;
let activeCampaignId = null;
let accountMobile = ""; // the logged-in account's number, used to prefill phone-code linking
let attachment = null; // { dataUrl, name, mimeType } when a file is attached
const MAX_ATTACH_MB = 45;
let campaignBotLinkInfo = null;

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

async function autoFillBotLink(inputId, statusId) {
  const status = $(statusId);
  status.textContent = "Getting the bot linkâ€¦";
  try {
    const [waStatus, bot] = await Promise.all([api("/wa/status"), api("/wa/bot")]);
    const number = String(waStatus.me || "").replace(/\D/g, "");
    if (waStatus.state !== "open" || !number) throw new Error("Link Server WhatsApp first.");
    const settings = bot.settings || {};
    let startText = "hi";
    if (settings.bot2SalonEnabled) startText = "book";
    else if (!settings.enabled && !settings.bot3Enabled) throw new Error("Enable the chatbot and save its settings first.");
    $(inputId).value = `https://wa.me/${number}?text=${startText}`;
    status.textContent = startText === "book" ? "Bot 2 booking link filled automatically." : "Chatbot link filled automatically.";
  } catch (error) { status.textContent = error.message || String(error); }
}

// ---------- Auth ----------
// Premium add-ons the seller can switch off per account; an unset flag means on.
let features = {};
let maxBots = 3;
let allowedBots = new Set([1, 2, 3]);
function applyFeatures() {
  document.querySelectorAll(".nav-tab[data-page]").forEach((tab) => {
    const page = tab.dataset.page;
    tab.classList.toggle("hidden", features[page] === false);
  });
  const current = document.querySelector('.nav-tab[aria-selected="true"]')?.dataset.page;
  if (current && features[current] === false) showPage(PAGES.find((page) => features[page] !== false) || null);
}

function applyBotLimit() {
  document.querySelectorAll("[data-bot-slot]").forEach((label) => { label.classList.toggle("hidden", !allowedBots.has(Number(label.dataset.botSlot))); });
  const selector = $("bot-selector");
  if (!selector) return;
  [...selector.options].forEach((option) => { option.hidden = !allowedBots.has(Number(option.value)); });
  if (!allowedBots.has(Number(selector.value))) setSelectedBot(String([...allowedBots].sort((a, b) => a - b)[0] || 1));
  // Button actions that belong to one bot only show when the customer has that bot.
  const ctaAction = $("cta-action");
  if (ctaAction) {
    const needs = { book: 2, lead: 3, hotel: 4 };
    [...ctaAction.options].forEach((option) => { option.hidden = !!needs[option.value] && !allowedBots.has(needs[option.value]); });
    if (ctaAction.selectedOptions[0]?.hidden) {
      ctaAction.value = "botlink";
      ctaAction.dispatchEvent(new Event("change"));
    }
  }
  const ctaBots = $("cta-bot-select");
  if (ctaBots) {
    [...ctaBots.options].forEach((option) => { option.hidden = !allowedBots.has(Number(option.value.replace("bot", ""))); });
    // Start on a bot this customer actually has, not a hidden one.
    if (ctaBots.selectedOptions[0]?.hidden) ctaBots.value = [...ctaBots.options].find((option) => !option.hidden)?.value || ctaBots.value;
  }
}

function signedIn(mobile, role, feats, botLimit = 3, bots = null) {
  features = feats || {};
  maxBots = role === "admin" ? 5 : Math.max(1, Math.min(5, Number(botLimit) || 3));
  allowedBots = new Set(role === "admin" ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    : Array.isArray(bots) && bots.length ? bots.map(Number) : Array.from({ length: maxBots }, (_, i) => i + 1));
  document.body.classList.remove("locked");
  $("login-view").classList.add("hidden");
  $("forgot-view").classList.add("hidden");
  $("logout").classList.remove("hidden");
  $("admin-link").classList.toggle("hidden", role !== "admin");
  accountMobile = mobile || "";
  $("account-label").textContent = mobile ? `Logged in as +${mobile}` : "";
  applyFeatures();
  applyBotLimit();
  showPage("campaign");
  refreshStatus();
  loadActiveCampaign();
  updatePreview();
  loadSelected();
  renderSelected();
  loadDrafts();
  // Show cached contacts/groups instantly, then refresh them in the background - a refresh never empties them.
  _contacts = cacheGet("starshiftContactsV2");
  _groups = cacheGet("starshiftGroups");
  renderContacts("");
  renderGroups("");
  syncContacts(false);
  syncGroups(false);
  restoreWatches();
  ensureBotState().then(syncCampaignMapLocation).catch(() => {});
}

function signOut() {
  sessionStorage.removeItem(tokenKey);
  token = "";
  [statusPoller, progressPoller, reportsPoller, sheetPoller, bcPoller].forEach(clearTimeout);
  stopChatPolling(); _chatJid = "";
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
    signedIn(result.mobile, result.role, result.features, result.maxBots, result.bots);
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
  $("forgot-status").textContent = "Sending codeâ€¦";
  try {
    const result = await api("/auth/forgot-password", "POST", { mobile: $("forgot-mobile").value.replace(/\D/g, "") });
    $("forgot-status").textContent = result.message || "If that number has an account, a code has been sent.";
    $("reset-fields").classList.remove("hidden");
  } catch (error) { $("forgot-status").textContent = error.message; }
});
$("reset-password").addEventListener("click", async () => {
  $("forgot-status").textContent = "Updating passwordâ€¦";
  try {
    await api("/auth/reset-password", "POST", { mobile: $("forgot-mobile").value.replace(/\D/g, ""), otp: $("forgot-otp").value.trim(), password: $("forgot-password").value });
    $("forgot-status").textContent = "Password updated. Sign in with your new password.";
    $("forgot-view").classList.add("hidden"); $("login-view").classList.remove("hidden");
  } catch (error) { $("forgot-status").textContent = error.message; }
});

$("logout").addEventListener("click", signOut);

// ---------- The one Menu dropdown (pages + WhatsApp + Support/Admin/Log out) ----------
const pageMenuBtn = $("page-menu-btn"), pageMenuDropdown = $("page-menu-dropdown");
function closePageMenu() { pageMenuDropdown.classList.add("hidden"); pageMenuBtn.setAttribute("aria-expanded", "false"); }
pageMenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const opened = pageMenuDropdown.classList.toggle("hidden") === false;
  pageMenuBtn.setAttribute("aria-expanded", opened ? "true" : "false");
});
pageMenuDropdown.querySelectorAll(".nav-tab, #connect, #unlink, #admin-link, #logout").forEach((t) => t.addEventListener("click", closePageMenu));
document.addEventListener("click", (e) => {
  if (!pageMenuDropdown.classList.contains("hidden") && !e.target.closest(".page-menu")) closePageMenu();
});

// ---------- Navigation ----------
const PAGES = ["campaign", "sheet", "broadcast", "reports", "chatbot", "quick", "unsub", "extract", "chat", "api"];
function showPage(page) {
  if (features[page] === false || !page) page = PAGES.find((candidate) => features[candidate] !== false) || null;
  if (!page) {
    document.querySelectorAll(".nav-tab").forEach((tab) => tab.setAttribute("aria-selected", "false"));
    PAGES.forEach((p) => { const sec = $("page-" + p); if (sec) sec.classList.add("hidden"); });
    clearTimeout(reportsPoller); clearTimeout(sheetPoller); stopChatPolling();
    return;
  }
  document.querySelectorAll(".nav-tab").forEach((tab) => tab.setAttribute("aria-selected", tab.dataset.page === page));
  PAGES.forEach((p) => { const sec = $("page-" + p); if (sec) sec.classList.toggle("hidden", p !== page); });
  clearTimeout(reportsPoller);
  clearTimeout(sheetPoller);
  stopChatPolling(); // leaving any page stops the chat pollers; re-armed when the Chat page opens
  if (page === "reports") loadReports();
  if (page === "chat") openChatPage();
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
$("wa-chip-btn").addEventListener("click", () => { $("wa-panel").classList.toggle("hidden"); closePageMenu(); });

// ---------- Block WhatsApp calls ----------
let callSettingsLoaded = false;
async function loadCallSettings() {
  callSettingsLoaded = true;
  try {
    const s = await api("/wa/calls");
    $("call-reject").checked = !!s.reject;
    $("call-message").value = s.message || "";
  } catch (error) { callSettingsLoaded = false; $("call-status").textContent = error.message; }
}
$("call-save").addEventListener("click", async () => {
  $("call-save").disabled = true;
  try {
    await api("/wa/calls", "POST", { reject: $("call-reject").checked, message: $("call-message").value });
    $("call-status").textContent = $("call-reject").checked ? "Saved. Calls will be cut automatically." : "Saved. Calls are allowed.";
  } catch (error) { $("call-status").textContent = error.message; }
  finally { $("call-save").disabled = false; }
});

async function refreshStatus() {
  try {
    const status = await api("/wa/status");
    const connected = status.state === "open";
    const pairing = status.state === "pairing";
    $("status-text").textContent = connected
      ? `WhatsApp: +${status.me || ""}`
      : status.state === "qr" ? "Scan QR to link"
      : pairing ? "Enter code on phone"
      : status.state === "connecting" ? "Connectingâ€¦" : "WhatsApp not linked";
    $("status-dot").className = "wa-dot " + (connected ? "ok" : status.state === "disconnected" ? "off" : "busy");
    $("connection-state").textContent = connected
      ? `Connected as +${status.me || ""}. Messages send from this server, even with your browser closed.`
      : status.state === "qr" ? "Scan this QR in WhatsApp â†’ Linked devices â†’ Link a device."
      : pairing ? "Type the code below into your phone to link."
      : status.state === "connecting" ? "Preparing a secure connectionâ€¦" : "Click â€œLink WhatsAppâ€, then choose Scan QR or Use mobile number.";
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
    $("call-block").classList.toggle("hidden", !connected);
    if (connected && !callSettingsLoaded) loadCallSettings();
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
  $("connection-state").textContent = "Starting QRâ€¦";
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
  $("connection-state").textContent = "Requesting a code from WhatsAppâ€¦";
  try {
    await api("/wa/logout", "POST", {}); // reset any QR attempt in progress
    const res = await api("/wa/connect", "POST", { phone });
    if (res.pairingCode) {
      const c = res.pairingCode;
      $("pair-code").textContent = c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
      $("pair-code").classList.remove("hidden");
      $("connection-state").textContent = "Type this code into your phone to link.";
    } else {
      $("connection-state").textContent = "Could not get a code â€” try Scan QR instead.";
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
const EMOJIS = ["ðŸ˜Š","ðŸ‘","ðŸ™","ðŸŽ‰","âœ…","â¤ï¸","ðŸ”¥","â­","ðŸ“Œ","ðŸ“ž","ðŸ›’","ðŸ’°","ðŸŽ","ðŸ˜€","ðŸ™Œ","ðŸ“£","âœ¨","ðŸ‘‡","ðŸ“…","âš¡"];
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
  if (showLoading) $("contact-list").innerHTML = `<p class="empty-note">Loadingâ€¦</p>`;
  try {
    _contacts = (await api("/wa/contacts")).contacts || [];
    cacheSet("starshiftContactsV2", _contacts);
    renderContacts($("contact-search").value.trim().toLowerCase());
  } catch (e) { if (showLoading) $("contact-list").innerHTML = `<p class="empty-note">${esc(e.message)}</p>`; }
}
function renderContacts(q) {
  const list = _contacts.filter((c) => !q || c.name.toLowerCase().includes(q) || c.number.includes(q));
  $("contact-list").innerHTML = list.length
    ? list.slice(0, 800).map((c) => `<div class="pick-row"><div><div class="pname">${esc(c.name)}</div><div class="ptarget">${esc(c.number)}</div></div><button data-add="${esc(c.number)}" data-name="${esc(c.name)}">Add</button></div>`).join("")
    : `<p class="empty-note">No contacts found. Click â€œSync contactsâ€.</p>`;
  $("contact-list").querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => { addRecipient({ source: "number", name: b.dataset.name, mobile: b.dataset.add }); markAdded(b); }));
}
$("sync-contacts").addEventListener("click", () => syncContacts(true));
$("contact-search").addEventListener("input", () => renderContacts($("contact-search").value.trim().toLowerCase()));

// Group
let _groups = [];
async function syncGroups(showLoading) {
  if (showLoading) $("group-list").innerHTML = `<p class="empty-note">Loadingâ€¦</p>`;
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
    : `<p class="empty-note">No groups found. Click â€œSync groupsâ€.</p>`;
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
      : `<p class="empty-note">No saved lists yet. Select recipients, then â€œSave as listâ€.</p>`;
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
    ctaEnabled: $("cta-enabled").checked,
    ctaAction: $("cta-action").value,
    ctaBot: $("cta-bot-select").value,
    ctaLocationUrl: $("cta-location-url").value,
    ctaLabel: $("cta-label").value === "custom" ? $("cta-custom-label").value : $("cta-label").value,
    ctaCustom: $("cta-label").value === "custom",
    ctaUrl: $("cta-url").value,
    ctaGroup: $("cta-group").value,
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
  $("cta-enabled").checked = !!f.ctaEnabled;
  if (f.ctaAction) $("cta-action").value = f.ctaAction;
  if (f.ctaBot) $("cta-bot-select").value = f.ctaBot;
  $("cta-location-url").value = f.ctaLocationUrl || "";
  $("cta-options").classList.toggle("hidden", !f.ctaEnabled);
  const savedCtaLabel = f.ctaLabel || "Join group";
  const ctaPresets = ["Join group", "Open link", "Shop now", "Book now", "Learn more"];
  $("cta-label").value = f.ctaCustom || !ctaPresets.includes(savedCtaLabel) ? "custom" : savedCtaLabel;
  $("cta-custom-label").value = f.ctaCustom || !ctaPresets.includes(savedCtaLabel) ? savedCtaLabel : "";
  $("cta-custom-label").classList.toggle("hidden", $("cta-label").value !== "custom");
  $("cta-url").value = f.ctaUrl || "";
  $("cta-group").value = f.ctaGroup || "";
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
    $("attach-info").textContent = `ðŸ“Ž ${f.attachment.name || "file"} â€” message is the caption.`;
    $("attach-clear").classList.remove("hidden");
  } else {
    attachment = null; $("attach").value = "";
    $("attach-info").textContent = "Photo, video, PDF or document.";
    $("attach-clear").classList.add("hidden");
  }
  updateCampaignCtaOptions();
  updatePreview();
}

function renderSavedAttachmentOptions(drafts = []) {
  const select = $("saved-attachment-select");
  const saved = drafts.filter((draft) => draft.form?.attachment?.dataUrl);
  select.innerHTML = '<option value="">Choose a saved attachment</option>' + saved.map((draft) =>
    `<option value="${esc(draft.id)}">${esc(draft.form.attachment.name || "file")} ? ${esc(draft.name)}</option>`
  ).join("");
  $("saved-attachment-status").textContent = saved.length
    ? `${saved.length} attachment(s) saved with campaigns. Choose one to use it.`
    : "No saved attachments yet. Save a campaign with a file to add it here.";
}

$("saved-attachment-select").addEventListener("change", () => {
  const id = $("saved-attachment-select").value;
  const form = draftsById[id]?.form;
  if (!form?.attachment?.dataUrl) return;
  attachment = form.attachment;
  $("attach").value = "";
  $("caption").value = form.caption || "";
  $("attach-info").textContent = `?? ${attachment.name || "Saved file"} ? selected from saved campaigns.`;
  $("attach-clear").classList.remove("hidden");
  updatePreview();
});

async function loadDrafts(preferredName = "") {
  const select = $("drafts-select");
  try {
    const { drafts = [], max = 5 } = await api("/drafts");
    draftsById = Object.fromEntries(drafts.map((d) => [d.id, d]));
    renderSavedAttachmentOptions(drafts);
    $("drafts-count").textContent = `(${drafts.length}/${max})`;
    select.innerHTML = '<option value="">Choose a saved campaign</option>' + drafts.map((d) => `<option value="${esc(d.id)}">${esc(d.name)} ? ${new Date(d.savedAt).toLocaleDateString()}</option>`).join("");
    const preferred = drafts.find((d) => d.name.toLowerCase() === preferredName.toLowerCase());
    if (preferred) select.value = preferred.id;
    $("load-draft").disabled = !select.value;
    $("delete-draft").disabled = !select.value;
  } catch (e) {
    renderSavedAttachmentOptions([]);
    select.innerHTML = `<option value="">${esc(e.message)}</option>`;
    $("load-draft").disabled = true;
    $("delete-draft").disabled = true;
  }
}

$("drafts-select").addEventListener("change", () => {
  const selected = Boolean($("drafts-select").value);
  $("load-draft").disabled = !selected;
  $("delete-draft").disabled = !selected;
});
$("load-draft").addEventListener("click", () => applyForm(draftsById[$("drafts-select").value]?.form));
$("delete-draft").addEventListener("click", async () => {
  const id = $("drafts-select").value;
  if (!id || !confirm("Delete this saved campaign?")) return;
  try { await api(`/drafts/${id}`, "DELETE"); await loadDrafts(); }
  catch (e) { alert(e.message); }
});

$("save-draft").addEventListener("click", async () => {
  if (!$("message").value.trim() && !attachment) return alert("Write a message or attach a file first.");
  const name = $("campaign-name").value.trim() || prompt("Name this campaign:");
  if (!name) return;
  $("campaign-name").value = name;
  try { await api("/drafts", "POST", { name, form: collectForm() }); await loadDrafts(name); }
  catch (e) { alert(e.message); }
});

// ---------- Attachment ----------
function updateCampaignCtaOptions() {
  const enabled = $("cta-enabled").checked;
  const action = $("cta-action").value;
  const interested = action === "lead";
  const botLink = action === "botlink";
  const needsBot = interested || botLink;
  const hotelBooking = action === "hotel";
  $("cta-options").classList.toggle("hidden", !enabled);
  $("cta-book-options").classList.toggle("hidden", interested || botLink || hotelBooking);
  $("cta-botlink-options").classList.toggle("hidden", !needsBot);
  $("cta-hotel-options").classList.toggle("hidden", !hotelBooking);
  if (interested) { $("cta-bot-select").value = "bot3"; updateCampaignBotLinkStatus(); }
  $("cta-lead-hint").classList.toggle("hidden", !interested || !enabled);
  if (enabled && (needsBot || hotelBooking)) loadCampaignBotLinkInfo();
}
$("cta-enabled").addEventListener("change", updateCampaignCtaOptions);
$("cta-action").addEventListener("change", updateCampaignCtaOptions);
$("cta-bot-select").addEventListener("change", () => updateCampaignBotLinkStatus());
async function loadCampaignBotLinkInfo() {
  const status = $("cta-bot-select-status");
  status.textContent = "Loading bot names and WhatsApp linkâ€¦";
  try {
    const [waStatus, bot] = await Promise.all([api("/wa/status"), api("/wa/bot")]);
    const settings = bot.settings || {};
    const number = String(waStatus.me || "").replace(/\D/g, "");
    if (waStatus.state !== "open" || !number) throw new Error("Link Server WhatsApp first.");
    campaignBotLinkInfo = {
      number,
      bot1: { name: String(settings.shopName || settings.botName || "Existing chatbot"), text: "hi", title: "Open chatbot" },
      bot2: { name: String(settings.bot2SalonName || "Bot 2"), text: "book", title: "Book" },
      bot3: { name: String(settings.bot3CompanyName || "Bot 3"), text: "Interested", title: "Interested" },
      bot4: { name: String(settings.bot4Name || "Table booking"), text: "table", title: "Book a table", url: settings.bot4Enabled && settings.bot4Branches?.[0] ? `${window.location.origin}/table-booking.html?mobile=${number}&branch=${encodeURIComponent(settings.bot4Branches[0].id)}` : "" },
      bot5: { name: String(settings.bot5Name || "Bot 5"), text: String(settings.bot5Keywords || "hi").split(",")[0].trim() || "hi", title: "Open Bot 5" },
      // Bot 6 is the website bot: in a campaign its button opens the website straight away.
      bot6: { name: String(settings.bot6Name || "Bot 6"), text: String(settings.bot6Keywords || settings.bot6Name || "").split(",")[0].trim() || "hi", title: String(settings.bot6ButtonText || "").trim() || "Visit Website for order", url: /^https?:\/\//i.test(String(settings.bot6Website || "").trim()) ? String(settings.bot6Website).trim() : "" },
    };
    for (const id of ["bot1", "bot2", "bot3", "bot4", "bot5", "bot6"]) $("cta-bot-select").querySelector(`option[value="${id}"]`).textContent = campaignBotLinkInfo[id].name;
    updateCampaignBotLinkStatus();
  } catch (error) {
    campaignBotLinkInfo = null;
    status.textContent = error.message || String(error);
  }
}
function updateCampaignBotLinkStatus() {
  const bot = campaignBotLinkInfo?.[$("cta-bot-select").value];
  if ($("cta-action").value === "hotel") {
    const hotel = campaignBotLinkInfo?.bot4;
    $("cta-hotel-status").textContent = hotel?.url ? `Uses ${hotel.name}; booking opens only after the 50 metre location check.` : "Enable Bot 4 and save its shop coordinates to use the hotel booking button.";
    return;
  }
  $("cta-bot-select-status").textContent = $("cta-action").value === "lead"
    ? "Interested lead collection runs through Bot 3. Select Bot 3, or choose Open a bot link to use another bot."
    : bot?.url ? `Button "${bot.title}" opens ${bot.url} directly.`
    : $("cta-bot-select").value === "bot6" ? "Save the website link in Bot 6 first."
    : bot ? `Button opens ${bot.name} on WhatsApp. The customer sends ?${bot.text}? to start that bot.`
      : "Choose which bot's WhatsApp link to attach.";
}
async function loadCtaGroups() {
  const select = $("cta-group");
  if (select.dataset.loaded === "true") return;
  try {
    const { groups = [] } = await api("/wa/groups");
    select.innerHTML = '<option value="">â€” Choose a group â€”</option>' + groups.map((g) => `<option value="${esc(g.jid)}">${esc(g.name)}</option>`).join("");
    select.dataset.loaded = "true";
  } catch (error) { $("cta-group-status").textContent = error.message; }
}
$("cta-group").addEventListener("change", async () => {
  const jid = $("cta-group").value;
  if (!jid) return;
  $("cta-url").value = "";
  $("cta-group-status").textContent = "Getting the group invite linkâ€¦";
  try {
    const { url } = await api(`/wa/groups/invite-link?jid=${encodeURIComponent(jid)}`);
    $("cta-url").value = url;
    $("cta-group-status").textContent = "Group invite link filled automatically. You can also paste a different link below.";
  } catch (error) { $("cta-group-status").textContent = error.message; }
});
$("cta-label").addEventListener("change", () => $("cta-custom-label").classList.toggle("hidden", $("cta-label").value !== "custom"));
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
    $("attach-info").textContent = `ðŸ“Ž ${file.name} (${Math.round(file.size / 1024)} KB) â€” message is the caption.`;
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
  await ensureBotState();
  syncCampaignMapLocation();
  const contacts = overrideRecipients || buildContacts();
  const template = $("message").value.trim();
  if (!contacts.length) return alert("Add at least one recipient.");
  if (!template && !attachment) return alert("Write a message or attach a file first.");
  const ctaAction = $("cta-action").value;
  if ($("cta-enabled").checked && ["botlink", "lead", "hotel"].includes(ctaAction) && !campaignBotLinkInfo) await loadCampaignBotLinkInfo();
  const selectedBotLink = campaignBotLinkInfo?.[$("cta-bot-select").value];
  if ($("cta-enabled").checked && ["botlink", "lead"].includes(ctaAction) && (!selectedBotLink || !campaignBotLinkInfo?.number)) return alert("Connect Server WhatsApp to choose the bot for this button.");
  if ($("cta-enabled").checked && ctaAction === "hotel" && !campaignBotLinkInfo?.bot4?.url) return alert("Enable Bot 4 and save its hotel name and shop coordinates first.");
  if ($("cta-enabled").checked && ctaAction === "lead" && $("cta-bot-select").value !== "bot3") return alert("Interested lead collection uses Bot 3. Choose Bot 3 or select Open a bot link.");
  if ($("cta-enabled").checked && ctaAction === "book" && !/^https:\/\/(maps\.app\.goo\.gl|goo\.gl|([a-z0-9-]+\.)?google\.(com|co\.in))(\/|$)/i.test($("cta-location-url").value.trim())) return alert("Add a valid Google Maps location link.");

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
      urlButton: $("cta-enabled").checked ? (ctaAction === "lead" ? { title: "Interested", action: "lead" } : ctaAction === "hotel" ? { title: "Book a table", url: campaignBotLinkInfo.bot4.url } : ctaAction === "botlink" ? { title: selectedBotLink.title, url: selectedBotLink.url || `https://wa.me/${campaignBotLinkInfo.number}?text=${encodeURIComponent(selectedBotLink.text)}` } : { title: "Book", action: "book", locationUrl: $("cta-location-url").value.trim() }) : null,
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
    $("campaign-summary").textContent = `${s} scheduled Â· ${d} completed`;
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
    : `${LABEL[c.status] || c.status} Â· ${sent} sent Â· ${failed} failed Â· ${total - done} pending`;
  const act = $("activity");
  act.classList.toggle("fail", failed > 0);
  act.textContent = c.cancelReason || c.waitingReason ||
    (c.status === "completed" ? `Done. ${sent} sent, ${failed} failed.`
      : c.status === "scheduled" ? `Scheduled for ${new Date(c.scheduleAt).toLocaleString()}.`
      : `${sent} sent, ${failed} failed, ${total - done} pending.`);
  $("cancel").classList.toggle("hidden", !active);
  // Pause/Resume: shown whenever the campaign is active (scheduled, running or paused).
  $("pause").classList.toggle("hidden", !active);
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
    box.textContent = c.waitingReason ? `â³ ${c.waitingReason}`
      : c.status === "scheduled" ? (left > 90 ? `â³ Scheduled for ${new Date(c.scheduleAt).toLocaleString()}` : `â³ Starts in ${left}s`)
      : left > 0 ? `â³ Next message in ${left}s` : "â³ Sendingâ€¦";
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
    $("campaign-summary").textContent = `${campaigns.filter((c) => c.status === "scheduled").length} scheduled Â· ${campaigns.filter((c) => c.status === "completed").length} completed`;
    const current = campaigns.find((c) => ["scheduled", "running", "paused"].includes(c.status)) || campaigns[0];
    if (!current) return;
    activeCampaignId = current.id;
    renderProgress(current);
    if (["scheduled", "running", "paused"].includes(current.status)) trackProgress();
  } catch { /* none yet */ }
}

// ---------- Sheet Scheduler ----------
async function loadSheetCtaGroups() {
  const select = $("sheet-cta-group");
  if (select.dataset.loaded === "true") return;
  try {
    const { groups = [] } = await api("/wa/groups");
    select.innerHTML = '<option value="">â€” Choose a group â€”</option>' + groups.map((g) => `<option value="${esc(g.jid)}">${esc(g.name)}</option>`).join("");
    select.dataset.loaded = "true";
  } catch (error) { $("sheet-cta-group-status").textContent = error.message; }
}
$("sheet-cta-enabled").addEventListener("change", () => {
  $("sheet-cta-options").classList.toggle("hidden", !$("sheet-cta-enabled").checked);
});
$("sheet-cta-label").addEventListener("change", () => $("sheet-cta-custom-label").classList.toggle("hidden", $("sheet-cta-label").value !== "custom"));
$("sheet-cta-group").addEventListener("change", async () => {
  const jid = $("sheet-cta-group").value;
  if (!jid) return;
  $("sheet-cta-url").value = "";
  $("sheet-cta-group-status").textContent = "Getting the group invite linkâ€¦";
  try {
    const { url } = await api(`/wa/groups/invite-link?jid=${encodeURIComponent(jid)}`);
    $("sheet-cta-url").value = url;
    $("sheet-cta-group-status").textContent = "Group invite link filled automatically. You can also paste a different link below.";
  } catch (error) { $("sheet-cta-group-status").textContent = error.message; }
});
function sheetUrlButton() {
  if (!$("sheet-cta-enabled").checked) return null;
  return { title: "Book", action: "book" };
}
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
  const next = b.nextSendAt ? ` Â· next ${new Date(b.nextSendAt).toLocaleString()}` : "";
  const synced = b.source === "sheet" ? ` Â· ${b.syncEnabled ? "auto-sync on" : "sync off"}${b.lastSyncedAt ? ` (last ${new Date(b.lastSyncedAt).toLocaleTimeString()})` : ""}` : "";
  const act = (a, label) => `<button data-sheet-act="${a}" data-id="${b.id}">${label}</button>`;
  let actions = "";
  if (b.status === "active") {
    if (b.source === "sheet") actions += act("resync", "Sync now");
    actions += act("cancel", "Cancel") + act("delete", "Delete");
  } else actions = act("delete", "Delete");
  const rows = (b.rows || []).slice(0, 60).map((r) => {
    const badge = r.status === "sent" ? "status-completed" : r.status === "failed" ? "status-cancelled" : r.status === "invalid" ? "status-paused" : "status-scheduled";
    const when = r.sendAt ? new Date(r.sendAt).toLocaleString() : `${esc(r.rawDate || "")} ${esc(r.rawTime || "")}`;
    const note = r.failReason ? ` â€” ${esc(r.failReason)}` : "";
    return `<div class="sheet-row-item"><span class="status-badge ${badge}">${r.status}</span><span class="sheet-row-to">${esc(r.name || r.mobile)}</span><span class="sheet-row-when">${esc(when)}</span>${r.attachmentUrl ? '<span class="sheet-row-att">ðŸ“Ž</span>' : ""}<span class="sheet-row-note">${note}</span></div>`;
  }).join("");
  return `<div class="campaign-item">
    <div class="head"><span>${esc(b.name)}</span><span class="status-badge status-${b.status === "active" ? "running" : "cancelled"}">${SHEET_LABEL[b.status] || b.status}</span></div>
    <div class="campaign-meta">${b.source === "sheet" ? "Google Sheet" : "Uploaded file"} Â· ${b.total} row(s)${synced}${next}</div>
    <div class="campaign-meta">Sent: ${c.sent || 0} | Failed: ${c.failed || 0} | Pending: ${c.pending || 0} | Invalid: ${c.invalid || 0}</div>
    <div class="sheet-rows">${rows}${b.rows && b.rows.length > 60 ? `<div class="hint" style="padding:6px">â€¦and ${b.rows.length - 60} more</div>` : ""}</div>
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
  const urlButton = sheetUrlButton();
  if (urlButton && !urlButton.url) return alert("Select a WhatsApp group or enter the link for the link button.");
  $("sheet-sched-load").disabled = true;
  $("sheet-sched-status").textContent = "Reading the sheetâ€¦";
  try {
    const { batch } = await api("/sheet-jobs", "POST", {
      mode: "sheet", url, name: $("sheet-sched-name").value.trim(), autoSync: $("sheet-sched-sync").checked, urlButton,
    });
    $("sheet-sched-status").textContent = `Scheduled ${batch.counts.pending} row(s)${batch.counts.invalid ? `, ${batch.counts.invalid} skipped` : ""}.`;
    $("sheet-sched-url").value = ""; $("sheet-sched-name").value = "";
    loadSheetJobs();
  } catch (e) { $("sheet-sched-status").textContent = e.message; } finally { $("sheet-sched-load").disabled = false; }
});

$("sheet-sched-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const urlButton = sheetUrlButton();
  if (urlButton && !urlButton.url) { $("sheet-sched-file-info").textContent = "Select a WhatsApp group or enter the link for the link button."; event.target.value = ""; return; }
  $("sheet-sched-file-info").textContent = "Readingâ€¦";
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
    const { batch } = await api("/sheet-jobs", "POST", { mode: "upload", name: $("sheet-sched-name").value.trim() || file.name, rows, urlButton });
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
    $("bc-list").innerHTML = `<option value="">â€” pick a saved list â€”</option>` +
      lists.map((l) => `<option value="${l.id}" ${l.id === selectedId ? "selected" : ""}>${esc(l.name)} (${l.recipients.length})</option>`).join("");
  } catch { /* ignore */ }
}

async function loadBcCtaGroups() {
  const select = $("bc-cta-group");
  if (select.dataset.loaded === "true") return;
  try {
    const { groups = [] } = await api("/wa/groups");
    select.innerHTML = '<option value="">â€” Choose a group â€”</option>' + groups.map((g) => `<option value="${esc(g.jid)}">${esc(g.name)}</option>`).join("");
    select.dataset.loaded = "true";
  } catch (error) { $("bc-cta-group-status").textContent = error.message; }
}
$("bc-cta-enabled").addEventListener("change", () => {
  $("bc-cta-options").classList.toggle("hidden", !$("bc-cta-enabled").checked);
});
$("bc-cta-label").addEventListener("change", () => $("bc-cta-custom-label").classList.toggle("hidden", $("bc-cta-label").value !== "custom"));
$("bc-cta-group").addEventListener("change", async () => {
  const jid = $("bc-cta-group").value;
  if (!jid) return;
  $("bc-cta-url").value = "";
  $("bc-cta-group-status").textContent = "Getting the group invite linkâ€¦";
  try {
    const { url } = await api(`/wa/groups/invite-link?jid=${encodeURIComponent(jid)}`);
    $("bc-cta-url").value = url;
    $("bc-cta-group-status").textContent = "Group invite link filled automatically. You can also paste a different link below.";
  } catch (error) { $("bc-cta-group-status").textContent = error.message; }
});

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
  const next = b.nextRunAt ? new Date(b.nextRunAt).toLocaleString() : "â€”";
  const last = b.lastRunAt ? new Date(b.lastRunAt).toLocaleString() : "never";
  const lastRun = b.runs && b.runs[0] ? ` Â· last run: ${b.runs[0].sent || 0} sent, ${b.runs[0].failed || 0} failed` : "";
  const act = (a, label) => `<button data-bc-act="${a}" data-id="${b.id}">${label}</button>`;
  const watching = bcHandles.has(b.id);
  const watchLine = FS_SUPPORTED
    ? `<div class="campaign-meta" id="bc-watch-${b.id}">${watching ? "ðŸ‘ï¸ Watching your PC folder â€” keep this tab open." : "Not watching a PC folder."}</div>`
    : `<div class="campaign-meta">Live PC-folder watch needs Chrome or Edge.</div>`;
  const watchBtn = !FS_SUPPORTED ? ""
    : watching ? act("unwatch", "Stop watching folder") : act("watch", "ðŸ‘ï¸ Watch a PC folder (auto)");
  return `<div class="campaign-item">
    <div class="head"><span>${esc(b.name)}</span><span class="status-badge status-${b.active ? "running" : "paused"}">${b.active ? "Active" : "Paused"}</span></div>
    <div class="campaign-meta">To: ${esc(b.listName)} (${b.recipientCount}) Â· ${FREQ_LABEL[b.frequency] || b.frequency} at ${esc(times)}</div>
    <div class="campaign-meta">ðŸ“ Folder: ${b.file ? esc(b.file.name) : "â€” empty (caption only)"} Â· next: ${esc(next)} Â· last: ${esc(last)}${lastRun}</div>
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

// Row "Put new file in folder" â€” opens a folder picker and uploads its newest file.
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
        setWatchStatus(id, "ðŸ‘ï¸ Paused â€” click â€œWatch a PC folderâ€ again to re-allow (needed after a reload).");
        continue;
      }
      const files = await dirFilesNewestFirst(info.handle); // newest modified-time first
      if (!files.length) { setWatchStatus(id, "ðŸ‘ï¸ Watching â€” folder is empty."); info.seen = new Set(); info.currentName = null; continue; }
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
      if (uploadedName) setWatchStatus(id, `ðŸ‘ï¸ Sent: ${uploadedName}${removed ? ` Â· removed ${removed} old` : ""}${failed ? ` Â· ${failed} couldn't be removed (use a non-OneDrive folder)` : ""}`);
      else if (removed || failed) setWatchStatus(id, `ðŸ‘ï¸ Folder cleaned â€” kept ${info.currentName}${failed ? ` Â· ${failed} couldn't be removed (use a non-OneDrive folder)` : ""}`);
      else setWatchStatus(id, `ðŸ‘ï¸ Watching â€” current: ${info.currentName}`);
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
    const button = b.urlButton || null;
    $("bc-location-url").value = botSettings?.bot2GoogleMapsUrl || button?.locationUrl || "";
    $("bc-cta-enabled").checked = !!button;
    $("bc-cta-options").classList.toggle("hidden", !button);
    const bcPresets = ["Join group", "Open link", "Shop now", "Book now", "Learn more"];
    $("bc-cta-label").value = button && !bcPresets.includes(button.title) ? "custom" : (button?.title || "Join group");
    $("bc-cta-custom-label").value = button && !bcPresets.includes(button.title) ? button.title : "";
    $("bc-cta-custom-label").classList.toggle("hidden", $("bc-cta-label").value !== "custom");
    $("bc-cta-url").value = button?.url || "";
    if (button?.groupJid) { await loadBcCtaGroups(); $("bc-cta-group").value = button.groupJid; }
    else $("bc-cta-group").value = "";
    $("bc-file-info").textContent = b.file ? `In folder: ${b.file.name} (use â€œPut new file in folderâ€ to change)` : "Folder is empty.";
    $("bc-save").textContent = "Update broadcast";
    $("bc-cancel-edit").classList.remove("hidden");
    $("bc-name").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (e) { alert(e.message); }
}

function bcResetForm() {
  bcEditing = null; bcPendingFile = null;
  $("bc-name").value = ""; $("bc-times").value = ""; $("bc-caption").value = ""; $("bc-freq").value = "daily";
  $("bc-list").value = ""; $("bc-file").value = ""; $("bc-folder").value = "";
  $("bc-file-info").textContent = "Folder is empty â€” caption-only is allowed.";
  $("bc-cta-enabled").checked = false; $("bc-cta-options").classList.add("hidden");
  $("bc-location-url").value = "";
  $("bc-cta-label").value = "Join group"; $("bc-cta-custom-label").value = "";
  $("bc-cta-custom-label").classList.add("hidden"); $("bc-cta-group").value = "";
  $("bc-cta-url").value = ""; $("bc-cta-group-status").textContent = "Select a group to fill its invite link automatically.";
  $("bc-save").textContent = "Create broadcast";
  $("bc-cancel-edit").classList.add("hidden");
}
$("bc-cancel-edit").addEventListener("click", bcResetForm);

async function bcAcceptFile(file) {
  if (!file) return;
  if (file.size > MAX_ATTACH_MB * 1024 * 1024) { $("bc-file-info").textContent = `Too big (max ${MAX_ATTACH_MB} MB).`; return; }
  try {
    bcPendingFile = { dataUrl: await readAsDataUrl(file), name: file.name, mimeType: file.type || "application/octet-stream" };
    $("bc-file-info").textContent = `ðŸ“ In folder: ${file.name} (${Math.round(file.size / 1024)} KB)`;
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
  await ensureBotState();
  syncCampaignMapLocation();
  const body = {
    name: $("bc-name").value.trim(),
    listId: $("bc-list").value,
    times: $("bc-times").value,
    frequency: $("bc-freq").value,
    caption: $("bc-caption").value,
    urlButton: $("bc-cta-enabled").checked ? { title: "Book", action: "book", locationUrl: $("bc-location-url").value.trim() } : null,
  };
  if ($("bc-cta-enabled").checked && !/^https:\/\/(maps\.app\.goo\.gl|goo\.gl|([a-z0-9-]+\.)?google\.(com|co\.in))(\/|$)/i.test($("bc-location-url").value.trim())) return alert("Add a valid Google Maps location link.");
  if (!body.listId) return alert("Pick a saved list.");
  if (!body.times.trim()) return alert("Add at least one send time.");
  $("bc-save").disabled = true;
  $("bc-status").textContent = "Savingâ€¦";
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
  const repeat = c.repeat?.mode && c.repeat.mode !== "none" ? ` Â· repeats ${c.repeat.mode}` : "";
  const when = c.scheduleAt ? ` Â· scheduled ${new Date(c.scheduleAt).toLocaleString()}` : "";
  return `<div class="campaign-item">
    <div class="head"><span>${esc(c.name)}</span><span class="status-badge status-${c.status}">${LABEL[c.status] || c.status}</span></div>
    <div class="campaign-meta">${total} recipient(s) Â· gap ${c.gapSeconds}s${c.attachment ? " Â· attachment" : ""}${repeat}${when}</div>
    <div class="progress-bar"><div class="fill" style="width:${pct}%"></div></div>
    <div class="campaign-meta">Sent: ${sent} | Failed: ${failed} | Pending: ${total - done}${c.cancelReason ? " Â· " + esc(c.cancelReason) : ""}</div>
    ${actions ? `<div class="campaign-actions">${actions}</div>` : ""}
  </div>`;
}

// ---------- Chatbot ----------
let botSettings = null, botRules = [], unsubscribers = [], botSyncSeq = 0, botLoaded = false, editingRule = -1;

function syncCampaignMapLocation() {
  const url = botSettings?.bot2GoogleMapsUrl || "";
  $("cta-location-url").value = url;
  $("bc-location-url").value = url;
}

async function ensureBotState() {
  if (botLoaded) return;
  const data = await api("/wa/bot");
  botSettings = data.settings;
  botRules = data.rules || [];
  unsubscribers = data.unsubscribers || [];
  botSyncSeq = data.seq || 0;
  if (!botSettings) {
    // A new account starts with every bot blank; only the STOP / START compliance keywords are filled in.
    const def = await api("/wa/bot/defaults");
    botSettings = {
      bot1Name: "",
      autoUnsubscribe: true,
      stopKeywords: def.settings?.stopKeywords || "6, stop, unsubscribe",
      startKeywords: "start",
      unsubscribeReply: def.settings?.unsubscribeReply || "",
      rewelcomeMinutes: 0,
    };
  }
  botLoaded = true;
  syncCampaignMapLocation();
}

async function loadBot() {
  try { await ensureBotState(); renderBotUI(); }
  catch (e) { $("bot-status").textContent = e.message; }
}

function renderWorkerSchedule() {
  const list = $("bot2-worker-schedule-list");
  const schedule = Array.isArray(botSettings?.bot2WorkerSchedule) ? botSettings.bot2WorkerSchedule : [];
  if (!schedule.length) {
    list.textContent = "No date-specific worker counts. The default count applies.";
    return;
  }
  list.innerHTML = schedule.map((entry, index) => `<div class="row" style="align-items:center;gap:8px;margin-top:6px"><span>${esc(entry.date)} â€” ${Number(entry.workers)} worker${Number(entry.workers) === 1 ? "" : "s"}</span><button type="button" class="btn-link" data-remove-worker-date="${index}">Remove</button></div>`).join("");
  list.querySelectorAll("[data-remove-worker-date]").forEach((button) => button.addEventListener("click", () => {
    const updated = [...schedule];
    updated.splice(Number(button.dataset.removeWorkerDate), 1);
    botSettings = { ...(botSettings || {}), bot2WorkerSchedule: updated };
    renderWorkerSchedule();
  }));
}

function updateBot2NameDisplay() {
  const shopName = $("bot2-salon-name").value.trim();
  $("bot2-title").textContent = shopName ? `Bot 2: ${shopName}` : "Bot 2: Salon booking";
  const option = document.querySelector('#bot-selector option[value="2"]');
  if (option) option.textContent = shopName ? `Bot 2 - ${shopName}` : "Bot 2 - Salon booking";
}

function updateBot3NameDisplay() {
  const botName = $("bot3-company-name").value.trim();
  $("bot3-title").textContent = botName ? "Bot 3: " + botName : "Bot 3: Interested leads";
  const option = document.querySelector('#bot-selector option[value="3"]');
  if (option) option.textContent = botName ? "Bot 3 - " + botName : "Bot 3 - Interested leads";
}
$("bot3-company-name").addEventListener("input", updateBot3NameDisplay);

function updateExtraBotNameDisplay(number) {
  const nameInput = $(`bot${number}-name`);
  const name = (number === 4 ? $("bot4-shop-name")?.value.trim() : nameInput?.value.trim()) || (number === 4 ? "Table booking" : `Bot ${number}`);
  $(`bot${number}-title`).textContent = name;
  const option = document.querySelector(`#bot-selector option[value="${number}"]`);
  if (option) option.textContent = name;
}
for (const number of [4, 5, 6]) $(`bot${number}-name`)?.addEventListener("input", () => updateExtraBotNameDisplay(number));
$("bot4-shop-name")?.addEventListener("input", () => updateExtraBotNameDisplay(4));

function renderBot4Settings(settings) {
  $("bot4-shop-name").value = settings.bot4Name || "";
  const welcome = settings.bot4Welcome || "Welcome to {{shop}}, {{branch}}! Tap Book a table to join today's queue.";
  $("bot4-welcome").value = /\{\{\s*branch\s*\}\}/i.test(welcome) ? welcome : welcome.replace(/\{\{\s*shop\s*\}\}/i, "{{shop}}, {{branch}}");
  const branches = Array.isArray(settings.bot4Branches) && settings.bot4Branches.length ? settings.bot4Branches : [{
    id: "main", name: "Main branch", openTime: settings.bot4OpenTime || "11:00", closeTime: settings.bot4CloseTime || "22:00",
    waitMinutes: settings.bot4WaitMinutes || 15, latitude: settings.bot4Latitude || "", longitude: settings.bot4Longitude || "", notifyNumber: settings.bot4NotifyNumber || "",
  }];
  $("bot4-branches").innerHTML = "";
  branches.forEach(addBot4BranchCard);
  updateExtraBotNameDisplay(4);
}

function escHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
async function branchQrWithCaption(qrDataUrl, shopName, branchName) {
  const qrImage = new Image();
  qrImage.src = qrDataUrl;
  await new Promise((resolve, reject) => { qrImage.onload = resolve; qrImage.onerror = () => reject(new Error("Could not prepare the branch QR image.")); });
  const scale = 2, qrSide = qrImage.naturalWidth * scale, footerHeight = 132;
  const canvas = document.createElement("canvas");
  canvas.width = qrSide; canvas.height = qrSide + footerHeight;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false; ctx.drawImage(qrImage, 0, 0, qrSide, qrSide);
  ctx.fillStyle = "#102b25"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  let shopFont = 30;
  do { ctx.font = `700 ${shopFont}px Arial, sans-serif`; if (ctx.measureText(shopName).width <= qrSide - 24) break; shopFont--; } while (shopFont > 18);
  ctx.font = `700 ${shopFont}px Arial, sans-serif`; ctx.fillText(shopName, qrSide / 2, qrSide + 42, qrSide - 24);
  ctx.font = "600 27px Arial, sans-serif"; ctx.fillText(branchName, qrSide / 2, qrSide + 91, qrSide - 24);
  return canvas.toDataURL("image/png");
}

function addBot4BranchCard(branch = {}) {
  const id = String(branch.id || (crypto.randomUUID ? crypto.randomUUID() : `branch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`));
  const card = document.createElement("div");
  card.className = "card bot4-branch-card"; card.dataset.branchId = id; card.style.margin = "12px 0";
  card.innerHTML = `<h3>Branch</h3>
    <label>Branch name</label><input data-field="name" value="${escHtml(branch.name || "")}" placeholder="Baner" />
    <div class="row" style="gap:10px;flex-wrap:wrap"><div class="field"><label>Opening time</label><input data-field="openTime" type="time" value="${escHtml(branch.openTime || "10:00")}" /></div><div class="field"><label>Closing time</label><input data-field="closeTime" type="time" value="${escHtml(branch.closeTime || "23:00")}" /></div><div class="field"><label>Minutes per queue wait cycle</label><input data-field="waitMinutes" type="number" min="1" max="240" value="${Number(branch.waitMinutes) || 15}" /></div></div>
    <div class="row" style="gap:10px;flex-wrap:wrap"><div class="field"><label>Number of tables</label><input data-field="tableCount" type="number" min="1" max="500" value="${Number(branch.tableCount) > 0 ? Number(branch.tableCount) : ""}" placeholder="Enter table count" /></div><div class="field"><label>Total seating capacity (all tables)</label><input data-field="seatingCapacity" type="number" min="1" max="2000" value="${Number(branch.seatingCapacity) > 0 ? Number(branch.seatingCapacity) : ""}" placeholder="Enter total seats" /></div></div>
    <p class="hint">Fill in both values. Queue wait is estimated from available tables, total seats, and minutes per wait cycle.</p>
    <p class="hint">Tip: paste the Google Maps "latitude, longitude" pair into the latitude box - it fills both boxes.</p>
    <label>Branch latitude</label><input data-field="latitude" type="text" inputmode="decimal" value="${escHtml(branch.latitude || "")}" placeholder="18.5204" />
    <label>Branch longitude</label><input data-field="longitude" type="text" inputmode="decimal" value="${escHtml(branch.longitude || "")}" placeholder="73.8567" />
    <label>Booking alert WhatsApp number (country code included)</label><input data-field="notifyNumber" type="tel" value="${escHtml(branch.notifyNumber || "")}" placeholder="919876543210" />
    <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap"><button type="button" class="btn-secondary" data-branch-qr>Generate branch QR</button><button type="button" class="btn-secondary" data-branch-remove>Remove branch</button></div>
    <div class="hidden" data-qr-wrap style="margin-top:10px"><img data-qr alt="Branch table booking QR" style="width:220px;max-width:100%" /><div><a data-qr-download>Download QR</a> <button type="button" class="btn-secondary" data-branch-copy>Copy booking link</button></div><input data-branch-link readonly /></div>`;
  $("bot4-branches").append(card);
}
function readBot4Branches() {
  return [...document.querySelectorAll(".bot4-branch-card")].map((card) => {
    const read = (key) => card.querySelector(`[data-field="${key}"]`).value.trim();
    return { id: card.dataset.branchId, name: read("name"), openTime: read("openTime"), closeTime: read("closeTime"), waitMinutes: Math.min(240, Math.max(1, Number(read("waitMinutes")) || 15)), tableCount: Math.min(500, Math.max(0, Number(read("tableCount")) || 0)), seatingCapacity: Math.min(2000, Math.max(0, Number(read("seatingCapacity")) || 0)), latitude: read("latitude"), longitude: read("longitude"), notifyNumber: read("notifyNumber") };
  });
}
$("bot4-add-branch").addEventListener("click", () => addBot4BranchCard());
// Split a pasted "lat, long" pair (from Google Maps) into the two coordinate boxes.
$("bot4-branches").addEventListener("input", (event) => {
  const input = event.target.closest('[data-field="latitude"], [data-field="longitude"]'); if (!input) return;
  const pair = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(input.value);
  if (!pair) return;
  const card = input.closest(".bot4-branch-card");
  card.querySelector('[data-field="latitude"]').value = pair[1];
  card.querySelector('[data-field="longitude"]').value = pair[2];
});
function bot4CoordinateProblem() {
  for (const branch of readBot4Branches()) {
    const lat = Number(branch.latitude), lon = Number(branch.longitude);
    if (!branch.latitude && !branch.longitude) continue;
    if (!branch.latitude || !branch.longitude || !Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180)
      return `Branch "${branch.name || "unnamed"}": enter both latitude and longitude as numbers (e.g. 18.4083 and 76.5604).`;
  }
  return "";
}
$("bot4-branches").addEventListener("click", async (event) => {
  const card = event.target.closest(".bot4-branch-card"); if (!card) return;
  if (event.target.closest("[data-branch-remove]")) { card.remove(); return; }
  if (event.target.closest("[data-branch-copy]")) { await navigator.clipboard.writeText(card.querySelector("[data-branch-link]").value); return; }
  const button = event.target.closest("[data-branch-qr]"); if (!button) return;
  try {
    const read = (key) => card.querySelector(`[data-field="${key}"]`).value.trim();
    const name = read("name"), lat = Number(read("latitude")), lon = Number(read("longitude"));
    if ($("bot-selector").value !== "4" || !$("bot4-enabled").checked) throw new Error("Select Bot 4, enable it, and save its settings first.");
    if (!name) throw new Error("Enter a branch name first.");
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) throw new Error("Enter valid branch coordinates first.");
    const notify = read("notifyNumber").replace(/\D/g, "");
    if (notify.length < 7 || notify.length > 15) throw new Error("Enter the branch WhatsApp alert number with country code.");
    const status = await api("/wa/status"), number = String(status.me || "").replace(/\D/g, ""), mobile = String(accountMobile || "").replace(/\D/g, "");
    if (status.state !== "open" || !number) throw new Error("Link Server WhatsApp first.");
    if (!mobile) throw new Error("Please sign in again to generate this branch QR.");
    const url = `${window.location.origin}/table-booking.html?mobile=${encodeURIComponent(mobile)}&branch=${encodeURIComponent(card.dataset.branchId)}`;
    const qr = await api("/wa/bot/booking-qr", "POST", { url });
    const labeledQr = await branchQrWithCaption(qr.dataUrl, $("bot4-shop-name").value.trim() || "Table booking", name);
    card.querySelector("[data-branch-link]").value = url; card.querySelector("[data-qr]").src = labeledQr;
    card.querySelector("[data-qr]").alt = `Table booking QR for ${$("bot4-shop-name").value.trim() || "Table booking"}, ${name}`;
    const download = card.querySelector("[data-qr-download]"); download.href = labeledQr; download.download = `${safeName(name)}-table-booking-qr.png`; download.className = "btn-secondary";
    card.querySelector("[data-qr-wrap]").classList.remove("hidden"); $("bot4-link-status").textContent = `QR ready for ${name}. Save Bot 4 settings before sharing.`;
  } catch (error) { $("bot4-link-status").textContent = error.message || String(error); }
});

function renderBotUI() {
  const s = botSettings || {};
  const today = new Date();
  const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const salonHours = String(s.bot2SalonHours || "");
  const timeMatches = [...salonHours.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/ig)];
  const toTimeInput = (m) => {
    if (!m) return "";
    let hour = Number(m[1]) % 12;
    if (m[3].toLowerCase() === "pm") hour += 12;
    return `${String(hour).padStart(2, "0")}:${String(Number(m[2] || 0)).padStart(2, "0")}`;
  };
  $("bot2-salon-name").value = s.bot2SalonName || "";
  $("bot2-map-location").value = s.bot2GoogleMapsUrl || "";
  syncCampaignMapLocation();
  updateBot2NameDisplay();
  $("bot2-salon-services").value = s.bot2SalonServices || "";
  $("bot2-salon-days").value = salonHours.replace(/,?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*[-â€“â€”]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm).*$/i, "").trim();
  $("bot2-start-date").value = s.bot2StartDate || localToday;
  $("bot2-open-time").value = toTimeInput(timeMatches[0]) || "10:00";
  $("bot2-close-time").value = toTimeInput(timeMatches[1]) || "20:00";
  $("bot2-break-from").value = s.bot2BreakFrom || "";
  $("bot2-break-to").value = s.bot2BreakTo || "";
  $("bot2-default-workers").value = Math.min(10, Math.max(1, Number(s.bot2DefaultWorkers) || 1));
  $("bot2-worker-date").value = localToday;
  $("bot2-report-date").value = localToday;
  $("bot2-worker-count").value = "1";
  $("bot2-notify-number").value = s.bot2NotifyNumber || "";
  $("bot2-summary-interval").value = Math.min(1440, Math.max(0, Number(s.bot2SummaryIntervalMinutes) || 0));
  $("bot2-start-message").value = s.bot2StartMessage || "";
  $("bot2-thankyou-message").value = s.bot2ThankYouMessage || "Thank you, {{name}}! ðŸ™";
  $("bot2-welcome-message").value = s.bot2WelcomeMessage || "Welcome to {{salon}} â€” we look forward to seeing you.";
  $("bot3-keywords").value = s.bot3Keywords || "";
  $("bot3-reply").value = s.bot3Reply || "";
  $("bot3-company-name").value = s.bot3CompanyName || "";
  $("bot3-notify-number").value = s.bot3NotifyNumber || "";
  $("bot3-report-interval").value = Math.min(1440, Math.max(1, Number(s.bot3ReportIntervalMinutes) || 60));
  $("bot3-report-time").value = s.bot3ReportTime || "23:59";
  $("bot3-report-email").value = s.bot3ReportEmail || "";
  updateBot3NameDisplay();
  $("bot3-city-question").value = s.bot3CityQuestion || "à¤•à¥ƒà¤ªà¤¯à¤¾ à¤¤à¥à¤®à¤šà¥à¤¯à¤¾ à¤¶à¤¹à¤°à¤¾à¤šà¥‡ à¤¨à¤¾à¤µ à¤¸à¤¾à¤‚à¤—à¤¾.";
  $("bot3-duplicate-reply").value = s.bot3DuplicateReply || "";
  $("bot3-final-thankyou").value = s.bot3FinalThankYou || "";
  $("bot3-final-welcome").value = s.bot3FinalWelcome || "";
  $("bot4-thankyou-message").value = s.bot4ThankYouMessage || "";
  $("bot4-welcome-message").value = s.bot4WelcomeMessage || "";
  $("bot3-thankyou").value = s.bot3ThankYou || "à¤§à¤¨à¥à¤¯à¤µà¤¾à¤¦! {{shop}} à¤šà¥‡ à¤ªà¥à¤°à¤¤à¤¿à¤¨à¤¿à¤§à¥€ 24 à¤¤à¤¾à¤¸à¤¾à¤‚à¤šà¥à¤¯à¤¾ à¤†à¤¤ à¤¤à¥à¤®à¤šà¥à¤¯à¤¾à¤¶à¥€ à¤¸à¤‚à¤ªà¤°à¥à¤• à¤•à¤°à¤¤à¥€à¤².";
  for (const number of [4, 5, 6]) {
    const nameInput = number === 4 ? $("bot4-shop-name") : $(`bot${number}-name`);
    nameInput.value = s[`bot${number}Name`] || (number === 4 ? "" : `Bot ${number}`);
    if (number === 5) {
      $(`bot${number}-keywords`).value = s[`bot${number}Keywords`] || "";
      $(`bot${number}-reply`).value = s[`bot${number}Reply`] || "";
    }
    $(`bot${number}-enabled`).checked = !!s[`bot${number}Enabled`];
    updateExtraBotNameDisplay(number);
  }
  renderBot4Settings(s);
  $("bot6-welcome").value = s.bot6Welcome || "";
  $("bot6-website").value = s.bot6Website || "";
  $("bot6-button-text").value = s.bot6ButtonText || "";
  $("bot6-keywords").value = s.bot6Keywords || "";
  $("bot5-columns").value = s.bot5Columns || "";
  $("bot5-details-title").value = s.bot5DetailsTitle || "";
  $("bot5-not-found").value = s.bot5NotFound || "";
  if (!$("bot5-keywords").value) $("bot5-keywords").value = "my details";
  loadBot5Data();
  const selectedBot = "1";
  $("bot1-enabled").checked = !!s.enabled;
  $("bot2-enabled").checked = !!s.bot2SalonEnabled;
  $("bot3-enabled").checked = !!s.bot3Enabled;
  setSelectedBot(selectedBot);
  $("bot1-name").value = s.bot1Name === undefined ? "Starshift WA Sender" : s.bot1Name;
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
  renderWorkerSchedule();
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

// Show settings for the selected bot; each bot has an independent enable switch.
function setSelectedBot(bot) {
  $("bot-selector").value = bot;
  $("page-chatbot").querySelectorAll("[data-bot-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.botPanel !== bot);
  });
}
$("bot-selector").addEventListener("change", () => setSelectedBot($("bot-selector").value));
$("bot2-salon-name").addEventListener("input", updateBot2NameDisplay);

$("bot2-worker-add").addEventListener("click", () => {
  const date = $("bot2-worker-date").value;
  const workers = Number($("bot2-worker-count").value);
  if (!date || !Number.isInteger(workers) || workers < 1 || workers > 10) {
    $("bot-status").textContent = "Choose a date and enter 1â€“10 workers.";
    return;
  }
  const schedule = [...(Array.isArray(botSettings?.bot2WorkerSchedule) ? botSettings.bot2WorkerSchedule : [])];
  const existing = schedule.findIndex((entry) => entry.date === date);
  const entry = { date, workers };
  if (existing >= 0) schedule[existing] = entry;
  else schedule.push(entry);
  schedule.sort((a, b) => a.date.localeCompare(b.date));
  botSettings = { ...(botSettings || {}), bot2WorkerSchedule: schedule };
  $("bot-status").textContent = "Worker count added. Save selected bot settings to apply it.";
  renderWorkerSchedule();
});

$("bot2-link-generate").addEventListener("click", async () => {
  const button = $("bot2-link-generate");
  const status = $("bot2-link-status");
  button.disabled = true;
  status.textContent = "Generating booking linkâ€¦";
  try {
    if ($("bot-selector").value !== "2" || !$("bot2-enabled").checked) throw new Error("Select Bot 2, enable it, and save its settings first.");
    const waStatus = await api("/wa/status");
    const number = String(waStatus.me || "").replace(/\D/g, "");
    if (waStatus.state !== "open" || !number) throw new Error("Link Server WhatsApp first, then generate the booking link.");
    const link = `https://wa.me/${number}?text=book`;
    $("bot2-chat-link").value = link;
    const qr = await api("/wa/bot/booking-qr", "POST", { url: link });
    $("bot2-booking-qr").src = qr.dataUrl;
    const salonName = $("bot2-salon-name").value.trim() || "Salon";
    $("bot2-booking-qr").alt = `Booking QR code for ${salonName}`;
    $("bot2-qr-name").textContent = salonName;
    $("bot2-qr-result").classList.remove("hidden");
    $("bot2-qr-copy").classList.remove("hidden");
    $("bot2-qr-download").classList.remove("hidden");
    $("bot2-link-copy").disabled = false;
    status.textContent = "Booking link and QR code ready. Share either with customers.";
  } catch (error) {
    status.textContent = error.message || String(error);
  } finally {
    button.disabled = false;
  }
});

$("bot2-qr-generate").addEventListener("click", () => $("bot2-link-generate").click());

// ---- Bot 5: customer sheet + link / QR ----
function showBot5Data(d) {
  $("bot5-data-clear").classList.toggle("hidden", !d.loaded);
  $("bot5-data-status").textContent = d.loaded
    ? `Loaded ${d.count} rows for ${d.customers} mobile numbers (mobile column: ${d.mobileHeader}).`
    : "No sheet uploaded yet.";
  $("bot5-columns-hint").textContent = d.loaded && d.headers.length ? `Columns in your sheet: ${d.headers.join(", ")}` : "";
}
async function loadBot5Data() {
  try { showBot5Data(await api("/wa/bot/bot5-data")); } catch { /* not allowed or offline */ }
}
$("bot5-data-file").addEventListener("change", async (event) => {
  const file = event.target.files[0]; event.target.value = "";
  if (!file) return;
  $("bot5-data-status").textContent = "Uploading...";
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
    showBot5Data(await api("/wa/bot/bot5-data", "POST", { rows }));
  } catch (e) { $("bot5-data-status").textContent = e.message || String(e); }
});
$("bot5-data-clear").addEventListener("click", async () => {
  if (!confirm("Remove the Bot 5 customer sheet?")) return;
  try { showBot5Data(await api("/wa/bot/bot5-data", "DELETE")); } catch (e) { alert(e.message); }
});
$("bot5-link-generate").addEventListener("click", async () => {
  const status = $("bot5-link-status");
  try {
    const waStatus = await api("/wa/status");
    const number = String(waStatus.me || "").replace(/\D/g, "");
    if (waStatus.state !== "open" || !number) throw new Error("Link Server WhatsApp first, then generate the link.");
    const keyword = ($("bot5-keywords").value.split(",")[0] || "").trim() || "my details";
    // The QR/link opens a small page where the customer picks WhatsApp or WhatsApp Business.
    const link = `${window.location.origin}/wa-open.html?phone=${number}&text=${encodeURIComponent(keyword)}`;
    $("bot5-chat-link").value = link; $("bot5-link-copy").disabled = false;
    const qr = await api("/wa/bot/booking-qr", "POST", { url: link });
    $("bot5-qr").src = qr.dataUrl; $("bot5-qr-download").href = qr.dataUrl;
    $("bot5-qr-wrap").classList.remove("hidden");
    status.textContent = $("bot5-enabled").checked ? "Link and QR ready. Save Bot 5 settings before sharing." : "Link and QR ready. Turn ON 'Enable Bot 5' at the top and Save, otherwise the bot will not reply.";
  } catch (error) { status.textContent = error.message || String(error); }
});
$("bot6-link-generate").addEventListener("click", async () => {
  const status = $("bot6-link-status");
  try {
    const waStatus = await api("/wa/status");
    const number = String(waStatus.me || "").replace(/\D/g, "");
    if (waStatus.state !== "open" || !number) throw new Error("Link Server WhatsApp first, then generate the link.");
    const keyword = ($("bot6-keywords").value.split(",")[0] || "").trim() || $("bot6-name").value.trim();
    if (!keyword) throw new Error("Enter the shop name (or the link / QR text) first.");
    const link = `${window.location.origin}/wa-open.html?phone=${number}&text=${encodeURIComponent(keyword)}`;
    $("bot6-chat-link").value = link; $("bot6-link-copy").disabled = false;
    const qr = await api("/wa/bot/booking-qr", "POST", { url: link });
    $("bot6-qr").src = qr.dataUrl; $("bot6-qr-download").href = qr.dataUrl;
    $("bot6-qr-wrap").classList.remove("hidden");
    status.textContent = $("bot6-enabled").checked ? "Link and QR ready. Save Bot 6 settings before sharing." : "Link and QR ready. Turn ON 'Enable Bot 6' at the top and Save, otherwise the bot will not reply.";
  } catch (error) { status.textContent = error.message || String(error); }
});
$("bot6-link-copy").addEventListener("click", async () => { await navigator.clipboard.writeText($("bot6-chat-link").value); $("bot6-link-status").textContent = "Link copied."; });
$("bot5-link-copy").addEventListener("click", async () => { await navigator.clipboard.writeText($("bot5-chat-link").value); $("bot5-link-status").textContent = "Link copied."; });

$("bot4-bookings-export").addEventListener("click", async () => {
  const status = $("bot4-bookings-status");
  status.textContent = "Loading booking registerâ€¦";
  try {
    const { bookings = [] } = await api("/wa/bot/hotel-bookings");
    if (!bookings.length) throw new Error("No table bookings to export yet.");
    const rows = bookings.map((entry) => ({ Branch: entry.branchName, "Queue date": entry.date, "Booking number": entry.queueNo, Time: entry.time, Name: entry.name, Mobile: entry.number, Members: entry.members, Distance: `${entry.distanceMeters} m`, "Estimated wait (min)": entry.estimatedWaitMinutes, Status: entry.status, "Created at": new Date(entry.createdAt).toLocaleString() }));
    downloadXlsx(rows, "Table bookings", `${safeName($("bot4-shop-name").value || "hotel")}-table-bookings.xlsx`);
    status.textContent = `${bookings.length} booking(s) exported.`;
  } catch (error) { status.textContent = error.message || String(error); }
});

async function brandedBookingQrCanvas() {
  const image = $("bot2-booking-qr");
  if (!image.src) throw new Error("Generate the booking QR first.");
  await image.decode();
  const salonName = $("bot2-salon-name").value.trim() || "Salon";
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const qrSize = 240;
  const padding = 24;
  const labelWidth = 296;
  const lines = [];
  ctx.font = "600 16px Arial, sans-serif";
  let line = "";
  for (const word of salonName.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > labelWidth) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  canvas.width = qrSize + padding * 2;
  canvas.height = padding * 2 + qrSize + 12 + Math.max(1, lines.length) * 22;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, padding, padding, qrSize, qrSize);
  ctx.font = "600 16px Arial, sans-serif";
  ctx.fillStyle = "#12332d";
  ctx.textAlign = "center";
  lines.forEach((text, index) => ctx.fillText(text, canvas.width / 2, padding + qrSize + 29 + index * 22, labelWidth));
  return { canvas, salonName };
}

$("bot2-qr-copy").addEventListener("click", async () => {
  try {
    const { canvas } = await brandedBookingQrCanvas();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not prepare the QR image.");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    $("bot2-link-status").textContent = "QR image copied. Paste it into the WhatsApp message box and send it as an image.";
  } catch (error) {
    $("bot2-link-status").textContent = `Could not copy image: ${error.message || error}. Download the QR and attach it using Photos & videos.`;
  }
});

$("bot2-qr-download").addEventListener("click", async () => {
  try {
    const { canvas, salonName } = await brandedBookingQrCanvas();
    const link = document.createElement("a");
    link.href = canvas.toDataURL("image/png");
    const safeName = salonName.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "Salon";
    link.download = `${safeName}-booking-qr.png`;
    link.click();
  } catch (error) {
    $("bot2-link-status").textContent = error.message || String(error);
  }
});

$("bot2-link-copy").addEventListener("click", async () => {
  const link = $("bot2-chat-link").value;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    $("bot2-link-status").textContent = "Booking link copied. Paste it into a WhatsApp message.";
  } catch {
    $("bot2-chat-link").select();
    $("bot2-link-status").textContent = "Select the link and copy it with Ctrl+C.";
  }
});

function bot2ReportDateKey(booking) {
  const key = String(booking.dateKey || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
  const value = String(booking.date || "").trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  match = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(value);
  if (match) return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && value.length > 5
    ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(parsed))
    : "";
}

function bot2BookingsRows(bookings) {
  return bookings.map((booking) => ({
    Date: booking.date || booking.dateKey || "",
    Time: booking.time || booking.timeKey || "",
    Customer: booking.name || "",
    Mobile: booking.number || "",
    Service: booking.service || "",
    Worker: booking.worker || "Worker 1",
    Status: booking.status === "cancelled" ? "Cancelled" : "Booked",
    "Booked at": booking.createdAt ? new Date(booking.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "",
  }));
}

function bot2WriteBookingsWorkbook(rows, fileSuffix) {
  const headers = ["Date", "Time", "Customer", "Mobile", "Service", "Worker", "Status", "Booked at"];
  const bookedRows = rows.filter((row) => row.Status !== "Cancelled");
  const cancelledRows = rows.filter((row) => row.Status === "Cancelled");
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(bookedRows, { header: headers }), "Booked");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(cancelledRows, { header: headers }), "Cancelled");
  XLSX.writeFile(workbook, `${safeName($("bot2-salon-name").value || "salon")}-${fileSuffix}.xlsx`);
  return { booked: bookedRows.length, cancelled: cancelledRows.length };
}

const reportDateInput = $("bot2-report-date");
if (reportDateInput && !reportDateInput.value) {
  reportDateInput.value = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

$("bot2-date-report-export").addEventListener("click", async () => {
  const button = $("bot2-date-report-export");
  const status = $("bot2-date-report-status");
  const selectedDate = reportDateInput.value;
  button.disabled = true;
  status.textContent = "Preparing date reportâ€¦";
  try {
    if (!selectedDate) throw new Error("Select a date first.");
    const { bookings = [] } = await api("/wa/bot/bookings");
    const selected = bookings.filter((booking) => bot2ReportDateKey(booking) === selectedDate);
    if (!selected.length) throw new Error(`No appointments found for ${selectedDate}.`);
    const counts = bot2WriteBookingsWorkbook(bot2BookingsRows(selected), `report-${selectedDate}`);
    status.textContent = `${selectedDate}: ${counts.booked} booked, ${counts.cancelled} cancelled.`;
  } catch (error) {
    status.textContent = error.message || String(error);
  } finally {
    button.disabled = false;
  }
});

$("bot2-bookings-export").addEventListener("click", async () => {
  const button = $("bot2-bookings-export");
  const status = $("bot2-bookings-status");
  button.disabled = true;
  status.textContent = "Preparing bookings sheetâ€¦";
  try {
    const { bookings = [] } = await api("/wa/bot/bookings");
    if (!bookings.length) throw new Error("No appointments to export yet.");
    const rows = bookings.map((booking) => ({
      Date: booking.date || booking.dateKey || "",
      Time: booking.time || booking.timeKey || "",
      Customer: booking.name || "",
      Mobile: booking.number || "",
      Service: booking.service || "",
      Worker: booking.worker || "Worker 1",
      Status: booking.status === "cancelled" ? "Cancelled" : "Booked",
      "Booked at": booking.createdAt ? new Date(booking.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "",
    }));
    const headers = ["Date", "Time", "Customer", "Mobile", "Service", "Worker", "Status", "Booked at"];
    const bookedRows = rows.filter((row) => row.Status !== "Cancelled");
    const cancelledRows = rows.filter((row) => row.Status === "Cancelled");
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(bookedRows, { header: headers }), "Booked");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(cancelledRows, { header: headers }), "Cancelled");
    XLSX.writeFile(workbook, `${safeName($("bot2-salon-name").value || "salon")}-bookings-${date}.xlsx`);
    status.textContent = `Generated sheet: ${bookedRows.length} booked and ${cancelledRows.length} cancelled.`;
  } catch (error) {
    status.textContent = error.message || String(error);
  } finally {
    button.disabled = false;
  }
});

$("bot-link-generate").addEventListener("click", async () => {
  const button = $("bot-link-generate");
  const status = $("bot-link-status");
  button.disabled = true;
  status.textContent = "Generating linkâ€¦";
  try {
    if (!$("bot1-enabled").checked) throw new Error("Enable the selected bot and save its settings first.");
    const waStatus = await api("/wa/status");
    const number = String(waStatus.me || "").replace(/\D/g, "");
    if (waStatus.state !== "open" || !number) throw new Error("Link Server WhatsApp first, then generate the chatbot link.");
    const link = `https://wa.me/${number}?text=hi`;
    $("bot-chat-link").value = link;
    $("bot-link-copy").disabled = false;
    status.textContent = "Link ready. Paste it into a campaign message or image caption.";
  } catch (error) {
    status.textContent = error.message || String(error);
  } finally {
    button.disabled = false;
  }
});

$("bot-link-copy").addEventListener("click", async () => {
  const link = $("bot-chat-link").value;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    $("bot-link-status").textContent = "Link copied. Paste it into your campaign message or caption.";
  } catch {
    $("bot-chat-link").select();
    $("bot-link-status").textContent = "Select the link and copy it with Ctrl+C.";
  }
});

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
  const selectedBot = $("bot-selector").value;
  const timeLabel = (value) => {
    const [hourText, minute] = value.split(":");
    const hour = Number(hourText);
    return `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
  };
  botSettings = {
    ...(botSettings || {}),
    bot2SalonEnabled: $("bot2-enabled").checked,
    bot2SalonName: $("bot2-salon-name").value.trim(),
    bot2GoogleMapsUrl: $("bot2-map-location").value.trim(),
    bot2SalonServices: $("bot2-salon-services").value.trim(),
    bot2SalonHours: `${$("bot2-salon-days").value.trim()}, ${timeLabel($("bot2-open-time").value)}-${timeLabel($("bot2-close-time").value)}`.replace(/^,\s*/, ""),
    bot2BreakFrom: $("bot2-break-from").value,
    bot2BreakTo: $("bot2-break-to").value,
    bot2StartDate: $("bot2-start-date").value,
    bot2DefaultWorkers: Math.min(10, Math.max(1, Number($("bot2-default-workers").value) || 1)),
    bot2WorkerSchedule: Array.isArray(botSettings?.bot2WorkerSchedule) ? botSettings.bot2WorkerSchedule : [],
    bot2NotifyNumber: $("bot2-notify-number").value.trim(),
    bot2SummaryIntervalMinutes: Math.min(1440, Math.max(0, Number($("bot2-summary-interval").value) || 0)),
    bot2StartMessage: $("bot2-start-message").value.trim(),
    bot2ThankYouMessage: $("bot2-thankyou-message").value.trim(),
    bot2WelcomeMessage: $("bot2-welcome-message").value.trim(),
    bot3Enabled: $("bot3-enabled").checked,
    bot3Keywords: $("bot3-keywords").value.trim(),
    bot3Reply: $("bot3-reply").value.trim(),
    bot3CompanyName: $("bot3-company-name").value.trim(),
    bot3NotifyNumber: $("bot3-notify-number").value.trim(),
    bot3ReportIntervalMinutes: Math.min(1440, Math.max(1, Number($("bot3-report-interval").value) || 60)),
    bot3ReportTime: $("bot3-report-time").value,
    bot3ReportEmail: $("bot3-report-email").value.trim(),
    bot3CityQuestion: $("bot3-city-question").value.trim(),
    bot3ThankYou: $("bot3-thankyou").value.trim(),
    bot3DuplicateReply: $("bot3-duplicate-reply").value.trim(),
    bot3FinalThankYou: $("bot3-final-thankyou").value.trim(),
    bot3FinalWelcome: $("bot3-final-welcome").value.trim(),
    bot4Enabled: allowedBots.has(4) && $("bot4-enabled").checked,
    bot4Name: $("bot4-shop-name").value.trim(),
    bot4Branches: readBot4Branches(),
    bot4Keywords: "table",
    bot4Reply: "",
    bot4Welcome: $("bot4-welcome").value.trim(),
    bot4ConfirmMessage: "",
    bot4ThankYouMessage: $("bot4-thankyou-message").value.trim(),
    bot4WelcomeMessage: $("bot4-welcome-message").value.trim(),
    bot4OpenTime: readBot4Branches()[0]?.openTime || "10:00",
    bot4CloseTime: readBot4Branches()[0]?.closeTime || "23:00",
    bot4WaitMinutes: readBot4Branches()[0]?.waitMinutes || 15,
    bot4Latitude: readBot4Branches()[0]?.latitude || "",
    bot4Longitude: readBot4Branches()[0]?.longitude || "",
    bot4NotifyNumber: readBot4Branches()[0]?.notifyNumber || "",
    bot5Enabled: allowedBots.has(5) && $("bot5-enabled").checked,
    bot6Enabled: allowedBots.has(6) && $("bot6-enabled").checked,
    bot6Name: $("bot6-name").value.trim(),
    bot6Welcome: $("bot6-welcome").value.trim(),
    bot6Website: $("bot6-website").value.trim(),
    bot6ButtonText: $("bot6-button-text").value.trim(),
    bot6Keywords: $("bot6-keywords").value.trim(),
    bot5Name: $("bot5-name").value.trim(),
    bot5Keywords: $("bot5-keywords").value.trim() || "my details",
    bot5Columns: $("bot5-columns").value.trim(),
    bot5DetailsTitle: $("bot5-details-title").value.trim(),
    bot5NotFound: $("bot5-not-found").value.trim(),
    bot5Reply: $("bot5-reply").value.trim(),
    enabled: $("bot1-enabled").checked,
    bot1Name: $("bot1-name").value.trim(),
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
      ? `âœ… ${d.count} number(s) loaded Â· columns: ${d.headers.join(", ")}${d.updatedAt ? ` Â· updated ${new Date(d.updatedAt).toLocaleString()}` : ""}`
      : "No data sheet loaded yet.";
  } catch (e) { $("bot-data-status").textContent = e.message; }
}

async function uploadBotData(rows, sourceLabel) {
  $("bot-data-status").textContent = "Loadingâ€¦";
  try {
    const d = await api("/wa/bot/data", "POST", { rows });
    $("bot-data-status").textContent = `âœ… ${d.count} number(s) loaded from ${sourceLabel} Â· columns: ${d.headers.join(", ")}`;
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

async function syncBot({ applyShopNameToProfile = false } = {}) {
  const result = await api("/wa/bot/sync", "POST", {
    config: { settings: botSettings, rules: botRules, footerKeywords: botSettings?.stopKeywords || "" },
    unsubscribers,
    since: botSyncSeq,
    applyShopNameToProfile,
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

// Persist the enable switch immediately so a refresh cannot restore its previous state.
document.querySelectorAll(".bot-enabled").forEach((toggle) => toggle.addEventListener("change", async () => {
  readBotUI();
  document.querySelectorAll(".bot-enabled").forEach((item) => { item.disabled = true; });
  $("bot-status").textContent = "Saving bot status?";
  try {
    const result = await syncBot();
    $("bot-status").textContent = result.running ? "Bot settings saved. Enabled bots are active." : result.active ? "Bot settings saved. They will reply once WhatsApp is linked." : "All bots are off.";
  } catch (error) {
    $("bot-status").textContent = error.message || String(error);
  } finally {
    document.querySelectorAll(".bot-enabled").forEach((item) => { item.disabled = false; });
  }
}));

$("bot-save").addEventListener("click", async () => {
  const coordinateProblem = bot4CoordinateProblem();
  if (coordinateProblem) { $("bot-status").textContent = coordinateProblem; alert(coordinateProblem); return; }
  readBotUI();
  $("bot-save").disabled = true;
  $("bot-status").textContent = "Savingâ€¦";
  try {
    const r = await syncBot({ applyShopNameToProfile: true });
    syncCampaignMapLocation();
    $("bot-status").textContent = r.shopProfileNameError
      ? `Settings saved, but WhatsApp could not update the profile name: ${r.shopProfileNameError}`
      : r.shopProfileNamePending
        ? "Settings saved. Link WhatsApp, then save again to apply the shop name to its profile."
        : r.shopProfileNameUpdated
          ? "Settings saved. Bot replies and the linked WhatsApp profile now use the shop name. Customers can save the number under that name."
          : r.running ? "Saved. Replies go out from the server." : r.active ? "Saved. Will reply once WhatsApp is linked." : "Saved. Chatbot is off.";
  } catch (e) { $("bot-status").textContent = e.message; } finally { $("bot-save").disabled = false; }
});

// Test reply â€” same matching engine the server uses (chatbot.js), on the current (even unsaved) config.
$("bot-test-btn").addEventListener("click", () => {
  readBotUI();
  if (!window.SwasBot) return alert("Chatbot engine not loaded â€” refresh the page.");
  const config = SwasBot.buildConfig(botSettings, botRules, botSettings.stopKeywords || "");
  const action = SwasBot.matchMessage($("bot-test-input").value, config, { inSession: $("bot-test-session").checked, unsubscribed: $("bot-test-unsub").checked });
  const box = $("bot-test-result");
  box.classList.remove("hidden");
  box.innerHTML = action
    ? `<p class="hint" style="margin:0 0 6px">${esc(action.label)}</p><div class="bubble">${esc(action.reply).replace(/\n/g, "<br>")}</div>`
    : `<p class="hint" style="margin:0">No reply â€” the bot would stay silent for this message.</p>`;
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
  $("unsub-status").textContent = "Savingâ€¦";
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

$("bot3-leads-export").addEventListener("click", async () => {
  const button = $("bot3-leads-export");
  const status = $("bot3-leads-status");
  button.disabled = true;
  status.textContent = "Preparing Excelâ€¦";
  try {
    const { leads = [] } = await api("/wa/bot/leads");
    if (!leads.length) throw new Error("No interested leads have been collected yet.");
    const rows = leads.map((lead) => ({ Name: lead.name || "", Mobile: lead.number || "", City: lead.city || "", Date: lead.date || "", Time: lead.time || "", Status: lead.status || (lead.duplicate ? "Duplicate" : "New") }));
    downloadXlsx(rows, "Interested Leads", `${safeName($("bot3-company-name").value || "company")}-interested-leads.xlsx`);
    status.textContent = `${rows.length} lead(s) exported.`;
  } catch (error) {
    status.textContent = error.message || String(error);
  } finally {
    button.disabled = false;
  }
});

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
  $("extract-status").textContent = "Loading groups and contactsâ€¦";
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
        label: `${c.name || c.number || "Unknown"}${c.group ? " (Group)" : c.number ? ` Â· ${c.number}` : ""} â€” ${c.count} msg`,
      })),
      groups: (groupsRes.groups || [])
        .filter((g) => g.jid && !seen.has(g.jid))
        .map((g) => ({ jid: g.jid, label: g.name })),
      contacts: (contactsRes.contacts || [])
        .filter((c) => c.number)
        .map((c) => ({ jid: `${c.number}@s.whatsapp.net`, label: `${c.name || c.number} Â· ${c.number}` }))
        .filter((c) => !seen.has(c.jid)),
    };
    renderExtractOptions($("extract-search").value);
    // Group-members picker gets every group the account is in (not just the unrecorded ones).
    const allGroups = (groupsRes.groups || []).slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const mg = $("members-group");
    const mgCurrent = mg.value;
    mg.innerHTML = '<option value="">â€” pick a group â€”</option>' + allGroups.map((g) => `<option value="${esc(g.jid)}">${esc(g.name)}</option>`).join("");
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
  $("extract-status").textContent = "Preparing Excelâ€¦";
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
    const who = typed ? typed : jid === "all" ? "all-chats" : safeName($("extract-chat").selectedOptions[0]?.text.split(" â€” ")[0]);
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
  $("extract-status").textContent = "Asking WhatsApp for older messagesâ€¦";
  try {
    await api("/wa/chat-history", "POST", { jid, count: 50 });
    $("extract-status").textContent = "Requested. Older messages are arriving â€” wait ~5 seconds, then Download again.";
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
  $("members-status").textContent = "Fetching membersâ€¦";
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
  $("numbers-status").textContent = "Preparing Excelâ€¦";
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
    $("api-status").textContent = "New key generated â€” copy and store it safely.";
  } catch (e) { $("api-status").textContent = e.message; }
});
$("api-copy").addEventListener("click", () => {
  if (!_apiKey) { $("api-status").textContent = "Generate a key first."; return; }
  navigator.clipboard?.writeText(_apiKey);
  $("api-status").textContent = "Copied.";
});

// ---------- Chat (live two-way) ----------
// Reads recorded messages for the open thread and polls for new ones; sends through the same linked
// WhatsApp as campaigns. Pollers run only while the Chat page is open (see showPage/stopChatPolling).
let _chatThreads = [];
let _chatJid = "";          // the open conversation's jid ("" = none)
let _chatSendTarget = null; // { type:"jid", jid } for a known thread, or { type:"number", phone } for a new chat
let _chatAttach = null;     // { dataUrl, name, mimeType } staged for the next send
let _chatReplyTo = null;    // { id, who, text } the message being replied to, or null
let _chatMsgPoller = null, _chatThreadPoller = null, _chatLastKey = "";
const CHAT_MSG_MS = 5000, CHAT_THREAD_MS = 12000; // modest intervals keep server load low

function stopChatPolling() { clearTimeout(_chatMsgPoller); clearTimeout(_chatThreadPoller); _chatMsgPoller = _chatThreadPoller = null; }

async function openChatPage() {
  loadChatContacts();        // in the background â€” gives names to threads and powers the name/number search
  await loadChatThreads();
  if (_chatJid) loadChatMessages(); // re-open the last conversation if one was active
}

// Reuse the very same contact list the campaign picker uses (_contacts: synced from /wa/contacts and
// cached), so Chat search finds exactly the contacts that appear after "Sync contacts" in a campaign.
async function loadChatContacts() {
  try {
    if (!_contacts.length) await syncContacts(false);         // nothing cached yet â€” fetch now
    else syncContacts(false).then(() => renderChatThreads($("chat-thread-search").value)); // refresh in bg
  } catch { /* contacts are a convenience; search still covers existing chats */ }
  renderChatThreads($("chat-thread-search").value);
}
function chatContactName(number) {
  if (!number) return "";
  return _contacts.find((c) => c.number === number)?.name || "";
}

async function loadChatThreads() {
  try {
    const { chats } = await api("/wa/chat/threads");
    _chatThreads = chats || [];
    renderChatThreads($("chat-thread-search").value);
    $("chat-threads-status").textContent = _chatThreads.length ? "" : "No chats yet. Start one with a number above.";
  } catch (e) {
    $("chat-threads-status").textContent = e.message;
  }
  clearTimeout(_chatThreadPoller);
  _chatThreadPoller = setTimeout(loadChatThreads, CHAT_THREAD_MS);
}

function renderChatThreads(filter = "") {
  const q = filter.trim().toLowerCase();
  const match = (name, number) => !q || `${name} ${number}`.toLowerCase().includes(q);

  // Existing chats first (names resolved from contacts where WhatsApp gave us only a number).
  const threadItems = _chatThreads
    .map((c) => {
      const name = c.name && c.name !== c.number ? c.name : (chatContactName(c.number) || c.name || c.number || "Unknown");
      return { jid: c.jid, number: c.number || "", name, group: c.group, count: c.count, contact: false };
    })
    .filter((c) => match(c.name, c.number));

  // While searching, also surface saved contacts that aren't already a chat â€” find anyone by name or number.
  const haveNumbers = new Set(_chatThreads.map((t) => t.number).filter(Boolean));
  const contactItems = (q ? _contacts : [])
    .filter((c) => c.number && !haveNumbers.has(c.number) && match(c.name || "", c.number))
    .slice(0, 200)
    .map((c) => ({ jid: `${c.number}@s.whatsapp.net`, number: c.number, name: c.name || c.number, group: false, count: 0, contact: true }));

  const all = threadItems.concat(contactItems);
  $("chat-thread-list").innerHTML = all.length ? all.map((c) => {
    const sub = c.group ? "Group" : (c.number || "");
    const tail = c.contact ? " Â· contact" : (c.count ? ` Â· ${c.count} msg` : "");
    return `<button type="button" class="chat-thread ${c.jid === _chatJid ? "active" : ""}" data-jid="${esc(c.jid)}" data-title="${esc(c.name)}" data-sub="${esc(sub)}" data-number="${esc(c.number)}" data-group="${c.group ? 1 : 0}" data-contact="${c.contact ? 1 : 0}">
      <span class="chat-thread-name">${esc(c.name)}</span>
      <span class="chat-thread-sub">${esc(sub)}${tail}</span>
    </button>`;
  }).join("") : `<p class="hint" style="padding:8px">No matching chats or contacts.</p>`;

  $("chat-thread-list").querySelectorAll(".chat-thread").forEach((b) => b.addEventListener("click", () => {
    const d = b.dataset;
    // A saved contact (no recorded thread yet) is opened by number, which resolves to the real thread on
    // the first send; an existing chat is opened by its exact jid.
    const target = d.contact === "1" ? { type: "number", phone: d.number } : { type: "jid", jid: d.jid };
    openChatThread(d.jid, d.title, d.sub, target, d.group === "1");
  }));
}

function openChatThread(jid, title, sub, sendTarget, group = false) {
  _chatJid = jid;
  _chatSendTarget = sendTarget;
  _chatLastKey = "";
  clearReply(); // a pending reply belongs to the chat you were in, not the one you're opening
  $("chat-convo-title").textContent = title || "Chat";
  $("chat-convo-sub").textContent = sub || "";
  $("chat-messages").innerHTML = `<p class="chat-empty">Loadingâ€¦</p>`;
  // Sending to a group by jid works; a direct chat whose number we never learned (a private @lid id) can
  // still be viewed, and replies sent, because we send by the thread's exact jid.
  $("chat-send").disabled = false;
  renderChatThreads($("chat-thread-search").value);
  loadChatMessages();
}

async function loadChatMessages() {
  if (!_chatJid) return;
  const jid = _chatJid;
  try {
    const { rows } = await api(`/wa/chat/thread?jid=${encodeURIComponent(jid)}&range=all`);
    if (jid !== _chatJid) return; // the user switched threads while this was in flight
    renderChatMessages(rows || []);
  } catch (e) {
    $("chat-send-status").textContent = e.message;
  }
  clearTimeout(_chatMsgPoller);
  _chatMsgPoller = setTimeout(loadChatMessages, CHAT_MSG_MS);
}

// Turns URLs in already-escaped message text into clickable links (http/https or bare www.).
function linkify(escaped) {
  return escaped.replace(/(https?:\/\/[^\s<]+|www\.[^\s<]+)/g, (u) => {
    const href = u.startsWith("http") ? u : `https://${u}`;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${u}</a>`;
  });
}

function renderChatMessages(rows) {
  const box = $("chat-messages");
  if (!rows.length) { box.innerHTML = `<p class="chat-empty">No messages yet. Say hello ðŸ‘‹</p>`; return; }
  // Only redraw (and auto-scroll) when something changed, so polling doesn't fight the user's scroll.
  const key = rows.length + ":" + (rows[rows.length - 1]?.at || 0);
  if (key === _chatLastKey) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = rows.map((r) => {
    const mine = r.direction === "Sent";
    const who = mine ? "" : (r.name || r.number || "");
    const reply = r.id ? `<button type="button" class="chat-reply-btn" data-id="${esc(r.id)}" data-who="${esc(mine ? "You" : who)}" data-text="${esc(r.text)}" title="Reply">â†©</button>` : "";
    return `<div class="chat-bubble ${mine ? "mine" : "theirs"}">
      ${who ? `<span class="chat-bubble-who">${esc(who)}</span>` : ""}
      <span class="chat-bubble-text">${linkify(esc(r.text))}</span>
      <span class="chat-bubble-time">${fmtTime(r.at)}${reply}</span>
    </div>`;
  }).join("");
  box.querySelectorAll(".chat-reply-btn").forEach((b) => b.addEventListener("click", () => startReply(b.dataset.id, b.dataset.who, b.dataset.text)));
  _chatLastKey = key;
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

// New chat from a typed number: we don't have a jid yet, so send by number; the recorded outgoing message
// then creates the real thread, which the thread poller picks up and we open by matching number.
function startNewChat() {
  const digits = $("chat-new-number").value.replace(/\D/g, "");
  if (digits.length < 8) { $("chat-threads-status").textContent = "Enter a valid number with country code."; return; }
  const jid = `${digits}@s.whatsapp.net`;
  openChatThread(jid, digits, digits, { type: "number", phone: digits }, false);
  $("chat-new-number").value = "";
}

function readAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ dataUrl: reader.result, name: file.name, mimeType: file.type || "application/octet-stream" });
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });
}

// Reply to a specific message â€” shows the quote bar and remembers which message to quote on send.
function startReply(id, who, text) {
  _chatReplyTo = { id, who, text };
  const bar = $("chat-reply-bar");
  bar.innerHTML = `<div class="chat-reply-info"><span class="chat-reply-who">â†© ${esc(who || "")}</span><span class="chat-reply-text">${esc((text || "").slice(0, 120))}</span></div><button type="button" id="chat-reply-cancel" title="Cancel">âœ•</button>`;
  bar.classList.remove("hidden");
  $("chat-reply-cancel").addEventListener("click", clearReply);
  $("chat-input").focus();
}
function clearReply() {
  _chatReplyTo = null;
  $("chat-reply-bar").classList.add("hidden");
  $("chat-reply-bar").innerHTML = "";
}

async function sendChatMessage() {
  if (!_chatSendTarget) { $("chat-send-status").textContent = "Pick a chat or start a new one first."; return; }
  const text = $("chat-input").value.trim();
  if (!text && !_chatAttach) return;
  const btn = $("chat-send");
  btn.disabled = true;
  $("chat-send-status").textContent = "Sendingâ€¦";
  try {
    const body = { target: _chatSendTarget, message: text };
    if (_chatAttach) body.attachment = { ..._chatAttach, caption: text };
    if (_chatReplyTo) body.quotedId = _chatReplyTo.id;
    const { jid } = await api("/wa/chat/send", "POST", body);
    $("chat-input").value = ""; $("chat-input").style.height = "auto";
    clearChatAttach();
    clearReply();
    $("chat-send-status").textContent = "";
    _chatLastKey = ""; // force a redraw on the next poll
    // A brand-new chat's thread now exists under the jid WhatsApp actually used (may be an @lid id);
    // switch the open conversation to it so the sent message and future replies land here.
    if (jid && _chatSendTarget.type === "number") {
      _chatJid = jid;
      _chatSendTarget = { type: "jid", jid };
      loadChatThreads();
    }
    setTimeout(loadChatMessages, 600);
  } catch (e) {
    $("chat-send-status").textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

function clearChatAttach() {
  _chatAttach = null;
  $("chat-attach-input").value = "";
  $("chat-attach-chip").classList.add("hidden");
  $("chat-attach-chip").textContent = "";
}

$("chat-refresh").addEventListener("click", loadChatThreads);
$("chat-thread-search").addEventListener("input", (e) => renderChatThreads(e.target.value));
$("chat-new-open").addEventListener("click", startNewChat);
$("chat-new-number").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); startNewChat(); } });
$("chat-composer").addEventListener("submit", (e) => { e.preventDefault(); sendChatMessage(); });
$("chat-input").addEventListener("input", (e) => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px"; });
$("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChatMessage(); } });
// Emoji picker for the chat composer (a broad set, incl. party/birthday ones), inserted at the cursor.
const CHAT_EMOJIS = (
  "ðŸ˜€ ðŸ˜ ðŸ˜‚ ðŸ¤£ ðŸ˜Š ðŸ˜ ðŸ˜˜ ðŸ˜Ž ðŸ¤© ðŸ¥³ ðŸ˜‡ ðŸ™‚ ðŸ˜‰ ðŸ˜Œ ðŸ˜‹ ðŸ˜œ ðŸ¤— ðŸ¤” ðŸ˜ ðŸ˜´ " +
  "ðŸ˜¢ ðŸ˜­ ðŸ˜¤ ðŸ˜  ðŸ˜¡ ðŸ¥º ðŸ˜³ ðŸ˜± ðŸ˜¬ ðŸ™„ ðŸ˜® ðŸ˜… ðŸ˜” ðŸ˜© ðŸ¤¯ ðŸ˜· ðŸ¤’ ðŸ¤• ðŸ¤§ ðŸ¥° " +
  "ðŸ‘ ðŸ‘Ž ðŸ‘ ðŸ™ ðŸ™Œ ðŸ‘Œ ðŸ¤ ðŸ’ª âœŒï¸ ðŸ¤ž ðŸ‘‹ ðŸ«¶ ðŸ¤™ âœï¸ ðŸ‘‡ ðŸ‘† ðŸ‘‰ ðŸ‘ˆ âœŠ ðŸ”¥ " +
  "â¤ï¸ ðŸ§¡ ðŸ’› ðŸ’š ðŸ’™ ðŸ’œ ðŸ–¤ ðŸ¤ ðŸ’— ðŸ’– ðŸ’ ðŸ’˜ ðŸ’• â£ï¸ ðŸ’” âœ¨ â­ ðŸŒŸ ðŸ’« ðŸŽ¯ " +
  "ðŸŽ‰ ðŸŽŠ ðŸŽ‚ ðŸ° ðŸŽ ðŸŽˆ ðŸŽ€ ðŸª„ ðŸ§¨ ðŸŽ† ðŸŽ‡ ðŸª… ðŸ•¯ï¸ ðŸ† ðŸ¥‡ ðŸ‘‘ ðŸ’ ðŸŒ¹ ðŸŒ¸ ðŸŒˆ " +
  "âœ… â˜‘ï¸ âŒ âš ï¸ â— â“ ðŸ“Œ ðŸ“ž ðŸ“² ðŸ’¬ ðŸ“£ ðŸ“… â° ðŸ’° ðŸ›’ ðŸ¤‘ ðŸ“ˆ ðŸš€ âš¡ â˜•"
).split(" ").filter(Boolean);

$("chat-emoji-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const p = $("chat-emoji-picker");
  if (!p.dataset.built) {
    p.innerHTML = CHAT_EMOJIS.map((em) => `<button type="button" tabindex="-1">${em}</button>`).join("");
    p.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      const box = $("chat-input");
      const [s, en] = [box.selectionStart ?? box.value.length, box.selectionEnd ?? box.value.length];
      box.value = box.value.slice(0, s) + b.textContent + box.value.slice(en);
      box.focus();
      box.selectionStart = box.selectionEnd = s + b.textContent.length;
      box.dispatchEvent(new Event("input")); // keep the auto-grow height in sync
    }));
    p.dataset.built = "1";
  }
  p.classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".chat-emoji-wrap")) $("chat-emoji-picker")?.classList.add("hidden");
});

$("chat-attach-btn").addEventListener("click", () => $("chat-attach-input").click());
$("chat-attach-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 16 * 1024 * 1024) { $("chat-send-status").textContent = "File is too large (max 16 MB)."; e.target.value = ""; return; }
  try {
    _chatAttach = await readAttachment(file);
    const chip = $("chat-attach-chip");
    chip.innerHTML = `ðŸ“Ž ${esc(file.name)} <button type="button" id="chat-attach-clear" class="btn-link">remove</button>`;
    chip.classList.remove("hidden");
    $("chat-attach-clear").addEventListener("click", clearChatAttach);
  } catch (err) { $("chat-send-status").textContent = err.message; }
});

// ---------- Boot ----------
if (token) api("/auth/me").then((me) => signedIn(me.mobile, me.role, me.features, me.maxBots, me.bots)).catch(() => signOut());
