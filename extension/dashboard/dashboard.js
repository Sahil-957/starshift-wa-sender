const el = (id) => document.getElementById(id);

// Columns with a fixed meaning; every other Excel/Sheet column becomes a {{placeholder}}.
const RESERVED_COLUMNS = new Set(["sr_no", "name", "mobile_number", "country_code", "group_name"]);
const EMOJIS = "😀 😁 😂 😊 😍 😎 🤩 🙏 👍 👏 🙌 💪 🎉 🎁 🔥 ✨ ⭐ ❤️ 💯 ✅ ❌ ⚡ 📢 📣 📌 📍 📞 📱 💬 📦 🛒 💰 🏷️ 🎯 ⏰ 📅 🪔 🌟 👉 👇".split(" ");

let attachmentData = null; // { name, mimeType, dataUrl }
let selectedRecipients = []; // { id, name, source: 'contact'|'group'|'number', mobile, custom1, custom2, fields }
let syncedContacts = []; // { name, type } scraped from WhatsApp
let syncedGroups = [];
let lastSyncedAt = 0; // when the saved sync was taken; 0 = never synced on this machine
const extractPicks = new Set(); // chat/group names ticked on the Extract page
const openReports = new Set(); // campaign ids whose detail table is expanded
let reportFilter = "all"; // which status the Campaigns list is showing
// Shown whenever a background run finds nothing, since a hidden tab is the usual reason.
const EMPTY_HINT = ' If this keeps coming back empty, tick "Show WhatsApp while it works" and try once more.';
let savedLists = []; // { id, name, recipients } - cached so the recipients table can show list chips

function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
  );
}

async function getList(key) {
  const data = await chrome.storage.local.get(key);
  return data[key] || [];
}

async function setList(key, list) {
  await chrome.storage.local.set({ [key]: list });
}

// ---------- Auth guard: the dashboard only works for a logged-in, active account ----------
async function initAuth() {
  const license = await checkLicense();
  document.body.classList.toggle("locked", !license.ok);
  el("license-lock").classList.toggle("hidden", license.ok);
  el("link-admin").classList.toggle("hidden", !license.ok || license.role !== "admin");
  if (!license.ok) {
    el("license-reason").textContent = `${license.reason} Need help? WhatsApp ${SUPPORT_LABEL}.`;
    el("logged-in-as").textContent = "Not logged in";
    return;
  }
  const { authMobile } = await chrome.storage.local.get("authMobile");
  el("logged-in-as").textContent = `Logged in as +${authMobile}`;
  el("server-wa-chip").classList.remove("hidden");
  refreshServerWhatsApp();
}

// ---------- Server WhatsApp: link once by QR, then campaigns send without WhatsApp Web ----------
let serverWaTimer = null;

/** The chip in the nav row says only what the state is; the panel below carries the detail and the QR. */
function setServerWaChip(state, me) {
  const chip = {
    open: { label: me ? `WhatsApp: +${me}` : "WhatsApp linked", dot: "ok" },
    qr: { label: "Scan the QR code", dot: "busy" },
    connecting: { label: "Connecting...", dot: "busy" },
    disconnected: { label: "WhatsApp not linked", dot: "off" },
  }[state] || { label: state, dot: "bad" };
  el("server-wa-label").textContent = chip.label;
  el("server-wa-dot").className = `wa-dot ${chip.dot}`;
}

function toggleServerWaPanel(open) {
  el("server-wa").classList.toggle("hidden", !open);
  el("btn-server-wa-panel").setAttribute("aria-expanded", String(open));
}

function showServerWhatsApp({ state, qr, me }) {
  const text = {
    open: `Connected${me ? ` as +${me}` : ""}. Campaigns to numbers and groups send from the server - WhatsApp Web doesn't need to be open. (Saved contacts picked by name still use WhatsApp Web.)`,
    qr: "On your phone: WhatsApp > Linked devices > Link a device, then scan this code.",
    connecting: "Connecting...",
    disconnected: "Not linked. Campaigns send through WhatsApp Web. Link WhatsApp here to send from the server instead.",
  };
  el("server-wa-status").textContent = text[state] || state;
  el("server-wa-qr").classList.toggle("hidden", state !== "qr");
  if (qr) el("server-wa-qr").src = qr;
  el("btn-server-wa-connect").classList.toggle("hidden", state !== "disconnected");
  el("btn-server-wa-logout").classList.toggle("hidden", state !== "open" && state !== "qr");
  setServerWaChip(state, me);
  // A waiting QR is useless unopened, so show the panel itself; once linked, get out of the way again.
  if (state === "qr") toggleServerWaPanel(true);
  if (state === "open") toggleServerWaPanel(false);
  // Keep polling while a QR is up or a link is in progress, so the page follows the phone.
  clearTimeout(serverWaTimer);
  if (state === "qr" || state === "connecting") serverWaTimer = setTimeout(refreshServerWhatsApp, 3000);
}

el("btn-server-wa-panel").addEventListener("click", () => {
  toggleServerWaPanel(el("server-wa").classList.contains("hidden"));
});

async function refreshServerWhatsApp() {
  try {
    showServerWhatsApp(await apiFetch("/wa/status"));
  } catch (err) {
    el("server-wa-status").textContent = `Can't reach the server: ${err.message}`;
    setServerWaChip("Server unreachable");
  }
}

el("btn-server-wa-connect").addEventListener("click", async () => {
  try {
    showServerWhatsApp(await apiFetch("/wa/connect", { method: "POST" }));
  } catch (err) {
    el("server-wa-status").textContent = err.message;
    toggleServerWaPanel(true);
  }
});

el("btn-server-wa-logout").addEventListener("click", async () => {
  if (!confirm("Unlink the server WhatsApp? Campaigns will go back to sending through WhatsApp Web.")) return;
  try {
    showServerWhatsApp(await apiFetch("/wa/logout", { method: "POST" }));
  } catch (err) {
    el("server-wa-status").textContent = err.message;
    toggleServerWaPanel(true);
  }
});

// ---------- Page navigation ----------
function showPage(page) {
  document.querySelectorAll(".nav-tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.page === page)));
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("hidden", p.id !== `page-${page}`));
}

document.querySelectorAll(".nav-tab").forEach((tab) => tab.addEventListener("click", () => showPage(tab.dataset.page)));

// ---------- Recipient tabs ----------
document.querySelectorAll(".rtab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".rtab").forEach((t) => t.setAttribute("aria-selected", "false"));
    tab.setAttribute("aria-selected", "true");
    document.querySelectorAll(".rpanel").forEach((p) => p.classList.add("hidden"));
    el(`rpanel-${tab.dataset.tab}`).classList.remove("hidden");
  });
});

// ---------- Selected recipients (shared list) ----------
function recipientKey(r) {
  return `${r.source}:${r.mobile || r.name}`;
}

function addRecipient(r, render = true) {
  const key = recipientKey(r);
  if (selectedRecipients.some((existing) => recipientKey(existing) === key)) return false;
  selectedRecipients.push({ id: crypto.randomUUID(), custom1: "", custom2: "", fields: {}, ...r });
  if (render) renderSelected();
  return true;
}

function isSelected(r) {
  return selectedRecipients.some((existing) => recipientKey(existing) === recipientKey(r));
}

function extraFieldsText(r) {
  return Object.entries(r.fields || {})
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
}

function renderSelected() {
  el("selected-count").textContent = selectedRecipients.length;
  renderPlaceholderChips();
  updatePreview();

  const table = el("contacts-table");
  const tbody = table.querySelector("tbody");
  tbody.innerHTML = "";

  if (!selectedRecipients.length) {
    table.classList.add("hidden");
    return;
  }
  table.classList.remove("hidden");

  tbody.innerHTML = selectedRecipients
    .map(
      (r, i) =>
        `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.mobile || r.name)}</td><td>${esc(r.source)}</td>` +
        `<td class="fields">${esc(extraFieldsText(r))}</td><td class="lists">${listsCell(r)}</td>` +
        `<td class="rm"><button data-remove="${r.id}" aria-label="Remove">&times;</button></td></tr>`
    )
    .join("");

  tbody.querySelectorAll("button[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedRecipients = selectedRecipients.filter((r) => r.id !== btn.dataset.remove);
      renderSelected();
      renderPickList("contact");
      renderPickList("group");
    });
  });
}

el("btn-clear-selected").addEventListener("click", () => {
  selectedRecipients = [];
  renderSelected();
  renderPickList("contact");
  renderPickList("group");
});

// ---------- Sync from WhatsApp (Contact / Group tabs) ----------
function renderPickList(kind) {
  const listEl = el(`list-${kind}`);
  const source = kind === "contact" ? syncedContacts : syncedGroups;
  const query = el(`search-${kind}`).value.trim().toLowerCase();
  const filtered = source.filter((c) => `${c.name} ${c.number || ""}`.toLowerCase().includes(query));

  listEl.innerHTML = "";
  if (!filtered.length) {
    listEl.innerHTML = `<div class="empty-note">${
      source.length ? "No matches." : 'Nothing synced yet - click "Sync from WhatsApp".'
    }</div>`;
    return;
  }

  filtered.forEach((c) => {
    // A number the sync already read lets the server WhatsApp send to this chat (see sendViaServer).
    const recipient = { name: c.name, source: kind, mobile: kind === "group" ? null : c.number || null };
    const already = isSelected(recipient);
    const row = document.createElement("div");
    row.className = "pick-row";
    row.innerHTML = `
      <div>
        <button type="button" class="pname open-chat" title="Open this chat on WhatsApp Web">${esc(c.name)}</button>
        <div class="ptarget">${kind === "group" ? "Group" : esc(c.number || "Chat - number not read yet")}</div>
      </div>
      <div class="row-actions">
        ${kind === "group" ? '<button type="button" data-act="members">Members to Excel</button>' : ""}
        <button type="button" data-act="add" ${already ? 'class="added" disabled' : ""}>${already ? "Added" : "Add"}</button>
      </div>
    `;
    row.querySelector('[data-act="add"]').addEventListener("click", () => {
      addRecipient(recipient);
      renderPickList(kind);
    });
    row.querySelector(".open-chat").addEventListener("click", () => openWhatsAppChat(c.name, c.number, el("sync-contact-status")));
    row.querySelector('[data-act="members"]')?.addEventListener("click", () => exportGroupMembers(c.name));
    listEl.appendChild(row);
  });
}

function applySyncedChats({ chats = [], syncedAt = 0 } = {}) {
  syncedContacts = chats.filter((c) => c.type === "individual");
  syncedGroups = chats.filter((c) => c.type === "group");
  lastSyncedAt = syncedAt;
}

function syncSummary() {
  if (!lastSyncedAt) return "";
  return (
    `${syncedContacts.length} contact(s) and ${syncedGroups.length} group(s) saved from the sync on ` +
    `${new Date(lastSyncedAt).toLocaleString()} - sync again only to refresh the list. ` +
    `(Auto-detected - some may be miscategorized if a group has no default icon.)`
  );
}

/** The scraped chats live in storage, so one sync is enough: the lists are still there after a reload. */
async function loadSyncedChats() {
  const { syncedChats } = await chrome.storage.local.get("syncedChats");
  applySyncedChats(syncedChats);
  renderPickList("contact");
  renderPickList("group");
  el("sync-contact-status").textContent = syncSummary();
  el("sync-group-status").textContent = syncSummary();
  renderExtractList();
}

async function syncChats(kind) {
  const statusEl = el(`sync-${kind}-status`);
  statusEl.textContent = "Syncing from WhatsApp Web... make sure a WhatsApp Web tab is open and logged in.";
  try {
    const result = await runTabTask({ type: "SYNC_CHATS" }, statusEl, (r) => !r.chats.length);
    if (!result?.success) throw new Error(result?.reason || "Sync failed.");
    if (!result.chats.length) throw new Error(`WhatsApp Web returned no chats.${EMPTY_HINT}`);
    await chrome.storage.local.set({ syncedChats: { chats: result.chats, syncedAt: Date.now() } });
    await loadSyncedChats();
  } catch (err) {
    statusEl.textContent = `Could not sync: ${err.message}`;
  }
}

el("btn-sync-contacts").addEventListener("click", () => syncChats("contact"));
el("btn-sync-groups").addEventListener("click", () => syncChats("group"));
el("search-contact").addEventListener("input", () => renderPickList("contact"));
el("search-group").addEventListener("input", () => renderPickList("group"));

// ---------- Excel export of the synced chats ----------
/**
 * Writes rows out as .xlsx. SheetJS builds the download link itself; if that ever fails, the manual
 * blob below still produces the file rather than the button appearing to do nothing.
 */
function downloadSheet(rows, sheetName, fileName) {
  const safeName = fileName.replace(/[\\/:*?"<>|]+/g, "_");
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows, { cellDates: true }), sheetName);
  try {
    XLSX.writeFile(workbook, safeName);
  } catch {
    const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
    const type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = safeName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

/** Writes the numbers read from opened chats back into the saved sync, so it is done only once. */
async function mergeResolvedNumbers(resolved) {
  const byName = new Map(resolved.map((r) => [r.name, r.number]));
  syncedContacts.forEach((c) => {
    const number = byName.get(c.name);
    if (number) c.number = number;
  });
  await chrome.storage.local.set({
    syncedChats: { chats: [...syncedContacts, ...syncedGroups], syncedAt: lastSyncedAt || Date.now() },
  });
}

/**
 * What the two extract buttons act on: exactly the chats ticked on the Extract page. Nothing ticked
 * means nothing runs - extracting all 50-odd chats by accident is a long wait for a file full of
 * conversations nobody asked for. "Tick all" is there for when everything really is wanted.
 */
function exportTarget() {
  const all = [...syncedContacts, ...syncedGroups];
  return {
    rows: all
      .filter((c) => extractPicks.has(c.name))
      .map((c) => ({ name: c.name, number: c.number || "", type: c.type === "group" ? "Group" : "Chat" })),
  };
}

function downloadTarget(target, fileName, statusEl) {
  const rows = target.rows.map((r, i) => ({
    sr_no: i + 1,
    name: r.name,
    mobile_number: r.number,
    type: r.type,
  }));
  downloadSheet(rows, "Chats", fileName);
  const withNumber = rows.filter((row) => row.mobile_number).length;
  statusEl.textContent = `Downloaded ${rows.length} ticked chat(s) - ${withNumber} with a number, ${rows.length - withNumber} blank.`;
}

function nothingToExport(target, statusEl) {
  if (target.rows.length) return false;
  statusEl.textContent = (syncedContacts.length || syncedGroups.length)
    ? "Tick the chats you want first - only ticked chats are extracted. Use “Tick all” for every chat."
    : 'Nothing synced yet - click "Sync from WhatsApp" first.';
  return true;
}

/** While a numbers run is going, only Stop stays live. */
function setExtracting(running) {
  el("btn-stop-extract").classList.toggle("hidden", !running);
  el("btn-stop-extract").disabled = false;
  ["btn-export-numbers", "btn-export-chats", "btn-sync-extract", "btn-sync-contacts"].forEach(
    (id) => (el(id).disabled = running)
  );
}

el("btn-stop-extract").addEventListener("click", async () => {
  el("btn-stop-extract").disabled = true;
  el("extract-status").textContent = "Stopping after this chat - the numbers read so far are kept...";
  await chrome.runtime.sendMessage({ type: "CANCEL_EXTRACT" });
});


// ---------- Extract page ----------
/** Every synced chat and group, in one list, filtered by the Extract page's own search box. */
function extractRows() {
  const query = el("search-extract").value.trim().toLowerCase();
  return [...syncedContacts, ...syncedGroups].filter((c) =>
    `${c.name} ${c.number || ""}`.toLowerCase().includes(query)
  );
}

function renderExtractList() {
  const listEl = el("list-extract");
  const rows = extractRows();
  const total = syncedContacts.length + syncedGroups.length;

  el("extract-count").textContent = total
    ? `${extractPicks.size} of ${total} ticked${extractPicks.size ? " - only these are extracted" : " - tick the chats you want"}.`
    : "";

  listEl.replaceChildren();
  if (!rows.length) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = total ? "No matches." : 'Nothing synced yet - click "Sync from WhatsApp".';
    listEl.append(note);
    return;
  }

  for (const chat of rows) {
    const isGroup = chat.type === "group";
    const row = document.createElement("label");
    row.className = "pick-row list-pick";
    row.innerHTML = `
      <input type="checkbox" ${extractPicks.has(chat.name) ? "checked" : ""} />
      <div>
        <button type="button" class="pname open-chat" title="Open this chat on WhatsApp Web">${esc(chat.name)}</button>
        <div class="ptarget">${isGroup ? "Group" : esc(chat.number || "Chat - number not read yet")}</div>
      </div>
      <div class="row-actions">
        ${isGroup ? '<button type="button" data-act="members">Members to Excel</button>' : ""}
      </div>
    `;
    row.querySelector('input[type="checkbox"]').addEventListener("change", (e) => {
      if (e.target.checked) extractPicks.add(chat.name);
      else extractPicks.delete(chat.name);
      renderExtractList();
    });
    row.querySelector(".open-chat").addEventListener("click", (e) => {
      e.preventDefault(); // the row is a <label>, so a plain click would also toggle the tick
      openWhatsAppChat(chat.name, chat.number, el("extract-status"));
    });
    row.querySelector('[data-act="members"]')?.addEventListener("click", (e) => {
      e.preventDefault();
      exportGroupMembers(chat.name);
    });
    listEl.append(row);
  }
}

el("search-extract").addEventListener("input", renderExtractList);
el("btn-sync-extract").addEventListener("click", () => syncChats("contact"));
el("btn-extract-all").addEventListener("click", () => {
  extractRows().forEach((c) => extractPicks.add(c.name));
  renderExtractList();
});
el("btn-extract-none").addEventListener("click", () => {
  extractPicks.clear();
  renderExtractList();
});

/** Opens a chat on WhatsApp Web and brings it to the front - by number when we know it. */
async function openWhatsAppChat(name, number, statusEl) {
  if (statusEl) statusEl.textContent = `Opening "${name}" on WhatsApp Web...`;
  const result = await chrome.runtime.sendMessage({ type: "OPEN_CHAT", name, number: number || null });
  if (statusEl) statusEl.textContent = result?.success ? "" : `Could not open "${name}": ${result?.reason || "unknown error"}`;
}

/** Everything that drives the WhatsApp tab runs hidden unless this box is ticked. */
function showWhileWorking() {
  return el("extract-visible").checked;
}


/**
 * Runs a job on the WhatsApp tab, hidden unless the box is ticked.
 *
 * Chrome does not lay out a minimised window, and WhatsApp only fills its chat list and message
 * pane once they have been laid out - so a background run can come back with nothing through no
 * fault of the search. Rather than leave that looking like a broken button, an empty result offers
 * one retry with the tab on screen.
 */
async function runTabTask(message, statusEl, isEmpty) {
  const send = async (visible) => {
    setExtracting(true);
    try {
      return await chrome.runtime.sendMessage({ ...message, visible });
    } catch (err) {
      return { success: false, reason: err.message || String(err) };
    } finally {
      setExtracting(false);
    }
  };

  let result = await send(showWhileWorking());
  if (result?.success && isEmpty(result) && !showWhileWorking()) {
    const retry = confirm(
      "Nothing came back while WhatsApp was out of sight.\n\n" +
        "Chrome does not draw a minimised window, and WhatsApp only fills its lists once they are drawn.\n\n" +
        "OK - bring WhatsApp to the front and try again.\n" +
        "Cancel - leave it, and keep the empty result."
    );
    if (retry) {
      el("extract-visible").checked = true;
      statusEl.textContent = "Trying again with WhatsApp on screen...";
      result = await send(true);
    }
  }
  return result;
}

/** Saves one captured picture as its own file next to the spreadsheet. */
function downloadImage(dataUrl, fileName) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = fileName.replace(/[\\/:*?"<>|]+/g, "_");
  document.body.append(link);
  link.click();
  link.remove();
}

const MAX_IMAGES = 200; // Chrome asks about every file; hundreds of prompts helps nobody

/**
 * Writes each captured picture out and puts its file name in the row, so the spreadsheet and the
 * image files line up. Returns how many were saved.
 */
async function saveImages(messages, statusEl) {
  const withImages = messages.filter((m) => m.image);
  const capped = withImages.slice(0, MAX_IMAGES);
  for (let i = 0; i < capped.length; i++) {
    const message = capped[i];
    message.imageFile = `${message.chat}_${String(i + 1).padStart(3, "0")}.jpg`;
    downloadImage(message.image, message.imageFile);
    statusEl.textContent = `Saving image ${i + 1} of ${capped.length}...`;
    await new Promise((resolve) => setTimeout(resolve, 150)); // let Chrome keep up with the saves
  }
  return { saved: capped.length, skipped: withImages.length - capped.length };
}

/** Turns an empty chat run into the actual reason, rather than a shrug. */
function emptyChatsReason(stats, asked) {
  if (!stats) return `No messages found in ${asked} chat(s) for ${rangeLabel()}.${EMPTY_HINT}`;
  if (stats.failures?.length) return `Could not open ${stats.failures.length} chat(s): ${stats.failures.join("; ")}`;
  if (!stats.opened) return `None of the ${asked} ticked chat(s) could be opened on WhatsApp Web.`;
  if (!stats.bubbles) {
    return (
      `Opened ${stats.opened} chat(s) but WhatsApp drew no messages in them` +
      (stats.hidden
        ? " - the tab was hidden, and Chrome does not draw a hidden window. Tick \u201cShow WhatsApp while it works\u201d."
        : " - open one of those chats by hand, check the messages load, then try again.")
    );
  }
  return `Read ${stats.bubbles} message(s) in ${stats.opened} chat(s), but none fall inside ${rangeLabel()}. Try a wider period.`;
}

/** Start and end of the period the Messages-from box is asking for, in ms. */
function chatDateRange() {
  const choice = el("chat-range").value;
  if (choice === "all") return { since: null, until: null };
  if (choice === "custom") {
    const from = el("chat-from").value;
    const to = el("chat-to").value;
    return {
      since: from ? new Date(`${from}T00:00`).getTime() : null,
      until: to ? new Date(`${to}T23:59:59`).getTime() : null,
    };
  }
  // "Today" is 0 days back, "last 3 days" is 2, and so on - always from midnight.
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - Number(choice));
  return { since: start.getTime(), until: null };
}

function rangeLabel() {
  const select = el("chat-range");
  const choice = select.value;
  if (choice !== "custom") return select.options[select.selectedIndex].text.toLowerCase();
  const { since, until } = chatDateRange();
  const from = since ? new Date(since).toLocaleDateString() : "the beginning";
  const to = until ? new Date(until).toLocaleDateString() : "today";
  return `${from} to ${to}`;
}

el("chat-range").addEventListener("change", () => {
  const custom = el("chat-range").value === "custom";
  el("chat-from").classList.toggle("hidden", !custom);
  el("chat-to").classList.toggle("hidden", !custom);
});

/**
 * Turns collected messages into the spreadsheet. Shared by the normal finish and by the rescue path
 * that writes whatever a run had streamed over before it stopped reporting.
 */
function writeMessagesSheet(messages, names, statusEl, { prefix = "", suffix = "", images, withImages }) {
  // Each chat is read on its own, so the pieces arrive chat by chat. Ordering the whole set by
  // time here is what makes the sheet read as one conversation history.
  const ordered = [...messages].sort((a, b) => (a.at || Infinity) - (b.at || Infinity));
  const rows = ordered.map((m, i) => ({
    sr_no: i + 1,
    chat: m.chat,
    // A real date object becomes a date cell; the text columns stay for reading at a glance.
    sent_on: m.at ? new Date(m.at) : "",
    date: m.date,
    time: m.time,
    approx_time: m.approximate ? "yes" : "",
    direction: m.direction,
    sender: m.sender,
    message: m.text,
    image_file: m.imageFile || "",
  }));
  downloadSheet(rows, "Messages", "whatsapp_chat_messages.xlsx");

  const imageNote = withImages
    ? ` ${images.saved} image(s) saved${images.skipped ? `, ${images.skipped} left out (limit ${MAX_IMAGES})` : ""}.`
    : "";
  statusEl.textContent =
    `${prefix}Downloaded ${rows.length} message(s) from ${names.length} chat(s), ${rangeLabel()}.${imageNote}${suffix}`;
}

/**
 * Downloads the conversations themselves: every message in the chosen period, from the chats you
 * added. Each chat is opened and scrolled back until its history reaches past the start date.
 */
async function exportChatsExcel() {
  const statusEl = el("extract-status");
  const target = exportTarget();
  if (nothingToExport(target, statusEl)) return;

  const names = target.rows.map((r) => r.name);
  const { since, until } = chatDateRange();
  statusEl.textContent = `Reading ${names.length} ticked chat(s) - ${rangeLabel()}: ${names.join(", ")}`;

  const withImages = el("extract-images").checked;
  streamedRows = [];
  const result = await runTabTask(
    { type: "CHAT_MESSAGES", names, since, until, withImages },
    statusEl,
    (r) => !r.messages.length
  );
  if (!result?.success) {
    // The run did not report back, but the rows it streamed along the way are still good.
    const rescued = streamedRows.filter((m) => {
      if (!m.at) return !since && !until;
      return (!since || m.at >= since) && (!until || m.at <= until);
    });
    if (rescued.length) {
      writeMessagesSheet(rescued, names, statusEl, {
        prefix: "The run did not finish, but what it had read was saved - ",
        images: { saved: 0, skipped: 0 },
        withImages: false,
      });
      return;
    }
    statusEl.textContent = `Could not read the chats: ${result?.reason || "no answer from the WhatsApp Web tab - reload it and try again."}`;
    return;
  }
  if (!result.messages.length) {
    statusEl.textContent = emptyChatsReason(result.stats, names.length);
    return;
  }

  const images = withImages ? await saveImages(result.messages, statusEl) : { saved: 0, skipped: 0 };
  writeMessagesSheet(result.messages, names, statusEl, {
    prefix: result.cancelled ? "Stopped early - " : "",
    suffix: result.stats?.undated
      ? " WhatsApp gave no readable timestamps in these chats, so the period could not be applied - everything was exported."
      : "",
    images,
    withImages,
  });
}

/**
 * The same chats, but with the missing numbers filled in first. WhatsApp shows a number in the chat
 * list only for people who are not in your address book; for everyone else the chat has to be
 * opened and read. What it finds is saved into the sync, so the slow pass happens only once.
 */
async function exportNumbersExcel() {
  const statusEl = el("extract-status");
  let target = exportTarget();
  if (nothingToExport(target, statusEl)) return;

  // Groups have no phone number of their own, so they are never worth opening.
  const missing = target.rows.filter((r) => !r.number && r.type === "Chat").map((r) => r.name);
  if (missing.length) {
    const ask =
      `${missing.length} of ${target.rows.length} chats do not show a number in the chat list ` +
      `(saved contacts show only their name).\n\n` +
      `OK - open those chats one by one and read each number. Roughly ${Math.ceil((missing.length * 4) / 60)} minute(s), ` +
      `and WhatsApp Web has to stay in front while it runs.\n\n` +
      `Cancel - download now, leaving those numbers blank.`;
    if (confirm(ask)) {
      statusEl.textContent = `Reading numbers for ${missing.length} chat(s)...`;
      const result = await runTabTask(
        { type: "RESOLVE_NUMBERS", names: missing },
        statusEl,
        (r) => !r.resolved.some((entry) => entry.number)
      );
      if (!result?.success) {
        statusEl.textContent = `Could not read the numbers: ${result?.reason || "no answer from the WhatsApp Web tab - reload it and try again."}`;
        return;
      }
      // Whatever was read before a Stop is still worth keeping and downloading.
      await mergeResolvedNumbers(result.resolved);
      renderPickList("contact");
      renderExtractList();
      target = exportTarget(); // rebuilt so it picks up what was just found
      if (result.cancelled) {
        statusEl.textContent = `Stopped after ${result.resolved.length} of ${missing.length} chat(s). Downloading what was read...`;
      }
    }
  }

  downloadTarget(target, "whatsapp_numbers.xlsx", statusEl);
}

/** The group list itself (names only - WhatsApp gives a group no phone number). */
function exportGroupsExcel() {
  const statusEl = el("sync-group-status");
  if (!syncedGroups.length) {
    statusEl.textContent = 'Nothing to export yet - click "Sync from WhatsApp" first.';
    return;
  }
  downloadSheet(
    syncedGroups.map((g, i) => ({ sr_no: i + 1, group_name: g.name })),
    "Groups",
    "whatsapp_groups.xlsx"
  );
  statusEl.textContent = `Downloaded ${syncedGroups.length} group(s). Use "Members to Excel" on a group for its people.`;
}

/** Everyone in one group, as its own Excel file. */
async function exportGroupMembers(name) {
  const statusEl = el("sync-group-status");
  statusEl.textContent = `Opening "${name}" and reading its members - leave WhatsApp Web in front...`;
  const result = await runTabTask({ type: "GROUP_MEMBERS", name }, statusEl, (r) => !r.members.length);
  if (!result?.success) {
    statusEl.textContent = `Could not read the members of "${name}": ${result?.reason || "no answer from the WhatsApp Web tab - reload it and try again."}`;
    return;
  }
  const rows = result.members.map((m, i) => ({
    sr_no: i + 1,
    name: m.name,
    mobile_number: m.number || "",
    group_name: name,
  }));
  downloadSheet(rows, "Members", `${name}_members.xlsx`);
  const withNumber = rows.filter((r) => r.mobile_number).length;
  statusEl.textContent =
    `Downloaded ${rows.length} member(s) of "${name}" - ${withNumber} with a number. ` +
    `WhatsApp hides the number of anyone already saved in your address book.`;
}

el("btn-export-chats").addEventListener("click", exportChatsExcel);
el("btn-export-numbers").addEventListener("click", exportNumbersExcel);
el("btn-export-groups").addEventListener("click", exportGroupsExcel);

// Rows handed over by the WhatsApp tab while it works, so a run that never reports back - a long
// chat, a dropped connection - still leaves something to write out.
let streamedRows = [];

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "EXTRACT_ROWS") streamedRows.push(...msg.rows);
});

// Progress of a long number-reading run, sent from the WhatsApp Web tab.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "EXTRACT_PROGRESS") return;
  el("extract-status").textContent =
    msg.done >= msg.total
      ? "Finishing up..."
      : `Reading numbers ${msg.done + 1} of ${msg.total}${msg.label ? ` - ${msg.label}` : ""}...`;
});


loadSyncedChats();

// ---------- Saved recipient lists (people messaged regularly; one person can be in many lists) ----------
/** Adds recipients to the list with this name, creating it if needed. People already in it are skipped. */
async function saveRecipientsToList(name, recipients) {
  const lists = await getList("recipientLists");
  let list = lists.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (!list) {
    list = { id: crypto.randomUUID(), name, recipients: [] };
    lists.push(list);
  }
  const known = new Set(list.recipients.map(recipientKey));
  const additions = recipients.map(({ id, ...recipient }) => recipient).filter((r) => !known.has(recipientKey(r)));
  list.recipients.push(...additions);
  await setList("recipientLists", lists);
  return { list, added: additions.length };
}

/** Chips for the lists this recipient is in, plus a picker to add them to another list. */
function listsCell(r) {
  const key = recipientKey(r);
  const chips = savedLists
    .filter((list) => list.recipients.some((member) => recipientKey(member) === key))
    .map(
      (list) =>
        `<span class="list-chip">${esc(list.name)}<button type="button" data-unlist="${esc(list.id)}" data-rid="${r.id}" aria-label="Remove from ${esc(list.name)}">&times;</button></span>`
    )
    .join("");
  const options = savedLists.map((list) => `<option value="${esc(list.id)}">${esc(list.name)}</option>`).join("");
  return `${chips}<select class="add-to-list" data-add-to-list="${r.id}" aria-label="Add ${esc(r.name)} to a list"><option value="">+ Add to list</option>${options}<option value="__new">New list...</option></select>`;
}

async function renderSavedLists() {
  savedLists = await getList("recipientLists");
  const ticked = new Set(Array.from(document.querySelectorAll("[data-pick-list]:checked"), (box) => box.dataset.pickList));
  el("list-saved").innerHTML = savedLists.length
    ? savedLists
        .map(
          (list) => `
      <div class="pick-row${list.auto ? " has-auto" : ""}">
        <label class="list-pick">
          <input type="checkbox" data-pick-list="${esc(list.id)}" ${ticked.has(list.id) ? "checked" : ""} />
          <span><span class="pname">${esc(list.name)}</span><span class="ptarget">${list.recipients.length} recipient(s)</span></span>
        </label>
        <div class="row-actions">
          <button type="button" data-list-action="add" data-list-id="${esc(list.id)}">Add all</button>
          <button type="button" data-list-action="send" data-list-id="${esc(list.id)}">Send</button>
          <button type="button" data-list-action="folder" data-list-id="${esc(list.id)}"
            title="Images put in this folder go to the list automatically">&#128193; ${list.auto ? "Change folder" : "Folder"}</button>
          <button type="button" data-list-action="delete" data-list-id="${esc(list.id)}">Delete</button>
        </div>
        ${list.auto ? autoBar(list) : ""}
      </div>`
        )
        .join("")
    : '<div class="empty-note">No saved lists yet. Use "+ Add to list" on a selected recipient, or "Save as list".</div>';
  renderSelected(); // refresh each recipient's list chips
}

el("btn-save-list").addEventListener("click", async () => {
  const statusEl = el("list-status");
  if (!selectedRecipients.length) {
    statusEl.textContent = "Select recipients first, then save them as a list.";
    return;
  }
  const name = prompt("List name (a new name creates a list, an existing name adds to it):")?.trim();
  if (!name) return;
  const { list, added } = await saveRecipientsToList(name, selectedRecipients);
  statusEl.textContent = `Added ${added} recipient(s) to "${list.name}" (${list.recipients.length} in total).`;
});

el("contacts-table").addEventListener("change", async (e) => {
  const select = e.target.closest("select[data-add-to-list]");
  if (!select) return;
  const recipient = selectedRecipients.find((r) => r.id === select.dataset.addToList);
  const name =
    select.value === "__new" ? prompt("New list name:")?.trim() : savedLists.find((l) => l.id === select.value)?.name;
  select.value = "";
  if (!recipient || !name) return;
  const { list, added } = await saveRecipientsToList(name, [recipient]);
  el("list-status").textContent = added
    ? `Added ${recipient.name} to "${list.name}".`
    : `${recipient.name} is already in "${list.name}".`;
});

el("contacts-table").addEventListener("click", async (e) => {
  const chip = e.target.closest("[data-unlist]");
  if (!chip) return;
  const recipient = selectedRecipients.find((r) => r.id === chip.dataset.rid);
  const lists = await getList("recipientLists");
  const list = lists.find((l) => l.id === chip.dataset.unlist);
  if (!recipient || !list) return;
  list.recipients = list.recipients.filter((member) => recipientKey(member) !== recipientKey(recipient));
  await setList("recipientLists", lists);
  el("list-status").textContent = `Removed ${recipient.name} from "${list.name}".`;
});

/** Selects everyone in a saved list, noting the list on each person for the report. Returns how many were new. */
function selectListRecipients(list) {
  let added = 0;
  list.recipients.forEach((member) => {
    const existing = selectedRecipients.find((r) => recipientKey(r) === recipientKey(member));
    if (existing) existing.fromLists = [...new Set([...(existing.fromLists || []), list.name])];
    else if (addRecipient({ ...member, fromLists: [list.name] }, false)) added += 1;
  });
  return added;
}

/** Sends the current message to exactly these lists' people; anyone in several lists gets it once. */
async function sendLists(lists) {
  const statusEl = el("list-status");
  const names = lists.map((list) => `"${list.name}"`).join(" + ");
  const people = new Set(lists.flatMap((list) => list.recipients.map(recipientKey))).size;
  const later = document.querySelector('input[name="when"]:checked').value === "later";
  const whenText = later ? `at ${el("schedule-date").value} ${el("schedule-time").value}` : "now";
  if (!confirm(`Send the current message to ${people} recipient(s) in ${names} ${whenText}?`)) return;

  selectedRecipients = [];
  lists.forEach(selectListRecipients);
  renderSelected();
  renderPickList("contact");
  renderPickList("group");

  const error = await startCampaign({ fromLists: true });
  statusEl.textContent = error ? `Not sent: ${error}` : `Campaign for ${names} started - see Reports for progress.`;
}

el("list-saved").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-list-action]");
  if (!btn) return;
  const lists = await getList("recipientLists");
  const list = lists.find((l) => l.id === btn.dataset.listId);
  if (!list) return;
  const action = btn.dataset.listAction;

  if (action.startsWith("auto-") || action === "folder") {
    await handleAutoAction(action, list, btn);
  } else if (action === "delete") {
    if (confirm(`Delete the saved list "${list.name}"? The people in it are not affected.`)) {
      await setList("recipientLists", lists.filter((l) => l.id !== list.id));
    }
  } else if (action === "send") {
    await sendLists([list]);
  } else {
    const added = selectListRecipients(list);
    renderSelected();
    renderPickList("contact");
    renderPickList("group");
    const already = list.recipients.length - added;
    el("list-status").textContent = `Added ${added} recipient(s) from "${list.name}"${
      already ? ` (${already} already selected)` : ""
    }.`;
  }
});

el("btn-send-lists").addEventListener("click", async () => {
  const ticked = new Set(Array.from(document.querySelectorAll("[data-pick-list]:checked"), (box) => box.dataset.pickList));
  const lists = (await getList("recipientLists")).filter((list) => ticked.has(list.id));
  if (!lists.length) {
    el("list-status").textContent = "Tick the lists you want to send to first.";
    return;
  }
  await sendLists(lists);
});

// ---------- Saved list: images from a folder, at set times ----------
// A saved list can have a folder on this computer. At each of its times (10:00, 12:00, 14:00, 16:00
// and 18:00 unless changed) the newest image in that folder goes to the list, whether or not it has
// gone before: the folder holds what is being sent, so swapping the file is the only thing to do to
// change the message. One campaign at a time, so two never fight over WhatsApp Web. It runs while
// Chrome and this dashboard are open; a time missed while the dashboard was closed is caught up the
// next time it opens. The folder handle lives in IndexedDB: chrome.storage cannot hold it.
const AUTO_TIMES = ["10:00", "12:00", "14:00", "16:00", "18:00"];
const AUTO_IMAGE = /\.(jpe?g|png|webp|gif)$/i;
const AUTO_TICK_MS = 30 * 1000;
// With "Keep newest only" on, the folder is kept down to the one image the list is being sent: every
// older one is deleted - permanently, not to the Recycle Bin - whether or not it ever went out. An
// image queued to go is kept until it has gone.

function folderStore(mode, action) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("swas-folders", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("handles");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = action(open.result.transaction("handles", mode).objectStore("handles"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    };
  });
}
const getFolderHandle = (listId) => folderStore("readonly", (store) => store.get(listId));
const putFolderHandle = (listId, handle) => folderStore("readwrite", (store) => store.put(handle, listId));
const deleteFolderHandle = (listId) => folderStore("readwrite", (store) => store.delete(listId));

/** The folder's images, oldest first. The key changes if a file is replaced, so a new photo under an old name still goes. */
async function folderImages(handle) {
  const images = [];
  for await (const entry of handle.values()) {
    if (entry.kind !== "file" || !AUTO_IMAGE.test(entry.name)) continue;
    const file = await entry.getFile();
    images.push({ key: `${entry.name}|${file.size}|${file.lastModified}`, file });
  }
  return images.sort((a, b) => a.file.lastModified - b.file.lastModified);
}

/** "2026-09-29 12:00" for the latest of these times already reached today; null before the first one. */
function latestSlot(times, now = new Date()) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const reached = times.filter((time) => {
    const [h, m] = time.split(":").map(Number);
    return h * 60 + m <= minutes;
  });
  if (!reached.length) return null;
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `${day} ${reached.sort().at(-1)}`;
}

/** "10:00, 12:00" (typed any which way) -> ["10:00", "12:00"], or null if any part is not a time. */
function parseTimes(text) {
  const times = String(text || "")
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(\d{1,2})(?:[:.](\d{2}))?$/);
      if (!match || Number(match[1]) > 23 || Number(match[2] || 0) > 59) return null;
      return `${match[1].padStart(2, "0")}:${match[2] || "00"}`;
    });
  return times.length && !times.includes(null) ? [...new Set(times)].sort() : null;
}

async function updateSavedList(listId, mutate) {
  const lists = await getList("recipientLists");
  const list = lists.find((l) => l.id === listId);
  if (!list) return null;
  mutate(list);
  await setList("recipientLists", lists);
  return list;
}

function autoBar(list) {
  const { auto } = list;
  const waiting = auto.pending?.length ? ` · ${auto.pending.length} waiting to send` : "";
  const deleting = auto.deleteSent ? " · only the newest image is kept" : "";
  return `
        <div class="auto-bar">
          <span class="auto-line">&#128193; <b>${esc(auto.folderName)}</b> · ${esc(auto.times.join(", "))} ·
            ${auto.enabled ? '<span class="auto-on">Auto ON</span>' : '<span class="auto-off">Paused</span>'}${waiting}${deleting}</span>
          <button type="button" data-list-action="auto-caption" data-list-id="${esc(list.id)}">Caption</button>
          <button type="button" data-list-action="auto-times" data-list-id="${esc(list.id)}">Times</button>
          <button type="button" data-list-action="auto-toggle" data-list-id="${esc(list.id)}">${auto.enabled ? "Pause" : "Resume"}</button>
          <button type="button" data-list-action="auto-delete" data-list-id="${esc(list.id)}"
            title="Keeps only the newest image in the folder and deletes every older one permanently">&#128465; Keep newest only: ${auto.deleteSent ? "ON" : "OFF"}</button>
          <button type="button" data-list-action="auto-remove" data-list-id="${esc(list.id)}">Remove folder</button>
          <div class="auto-caption hidden" data-caption-for="${esc(list.id)}">
            <textarea rows="3" placeholder="Sent with every image of this list (optional)">${esc(auto.caption || "")}</textarea>
            <button type="button" data-list-action="auto-caption-save" data-list-id="${esc(list.id)}">Save caption</button>
          </div>
        </div>`;
}

async function handleAutoAction(action, list, btn) {
  const status = el("list-status");
  if (action === "folder") {
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: "swas-auto-send", mode: "read" });
    } catch {
      return; // picker closed
    }
    const existing = await folderImages(handle);
    await putFolderHandle(list.id, handle);
    const times = list.auto?.times || AUTO_TIMES;
    await updateSavedList(list.id, (l) => {
      l.auto = {
        enabled: true,
        folderName: handle.name,
        caption: l.auto?.caption || "",
        times,
        pending: [],
        lastSlot: latestSlot(times),
        activeCampaignId: null,
      };
    });
    status.textContent =
      `"${handle.name}" attached to "${list.name}". Its newest image goes out at ${times.join(", ")}` +
      (existing.length ? `, starting with the ${existing.length} already in it.` : ".");
  } else if (action === "auto-caption") {
    btn.closest(".auto-bar").querySelector(".auto-caption").classList.toggle("hidden");
  } else if (action === "auto-caption-save") {
    const caption = btn.closest(".auto-caption").querySelector("textarea").value.trim();
    await updateSavedList(list.id, (l) => (l.auto.caption = caption));
    status.textContent = `Caption saved for "${list.name}".`;
  } else if (action === "auto-times") {
    const typed = prompt("Send times, 24-hour, separated by commas:", list.auto.times.join(", "));
    if (typed === null) return;
    const times = parseTimes(typed);
    if (!times) {
      status.textContent = 'Times not changed - write them like "10:00, 12:00, 14:00".';
      return;
    }
    await updateSavedList(list.id, (l) => {
      l.auto.times = times;
      l.auto.lastSlot = latestSlot(times); // a time just added that has already passed does not fire at once
    });
    status.textContent = `"${list.name}" now sends at ${times.join(", ")}.`;
  } else if (action === "auto-toggle") {
    await updateSavedList(list.id, (l) => {
      l.auto.enabled = !l.auto.enabled;
      if (l.auto.enabled) l.auto.lastSlot = latestSlot(l.auto.times); // resume from the next time on
    });
  } else if (action === "auto-delete") {
    if (list.auto.deleteSent) {
      await updateSavedList(list.id, (l) => (l.auto.deleteSent = false));
      status.textContent = `Images in "${list.auto.folderName}" are no longer deleted.`;
      return;
    }
    const sure = confirm(
      `In "${list.auto.folderName}", keep only the newest image and delete every older one?\n\n` +
        "They are deleted permanently - not to the Recycle Bin - and cannot be brought back, whether or not they were ever sent."
    );
    if (!sure) return;
    const handle = await getFolderHandle(list.id);
    const granted = handle && (await handle.requestPermission({ mode: "readwrite" }).catch(() => "denied")) === "granted";
    if (!granted) {
      status.textContent = "Chrome did not allow changes to that folder, so nothing will be deleted.";
      return;
    }
    await updateSavedList(list.id, (l) => (l.auto.deleteSent = true));
    status.textContent = `In "${list.auto.folderName}", only the newest image will be kept from now on.`;
  } else if (action === "auto-remove") {
    if (!confirm(`Stop sending images from "${list.auto.folderName}" to "${list.name}"?`)) return;
    await deleteFolderHandle(list.id);
    await updateSavedList(list.id, (l) => delete l.auto);
  }
}

/** Builds the campaign for one image: the list's people, the image, and the list's caption as the message. */
async function buildAutoCampaign(list, file) {
  const unsubscribers = await getList("unsubscribers");
  const recipients = list.recipients.filter((r) => !isUnsubscribed(r, unsubscribers));
  if (!recipients.length) return null;
  const { pacing, unsubscribeFooter } = readSendOptions();
  return {
    id: crypto.randomUUID(),
    name: `${list.name} - ${file.name}`,
    lists: [list.name],
    messageTemplate: list.auto.caption || "",
    // An empty caption makes the message (the list's caption, plus the footer) go under the image.
    attachment: { name: file.name, mimeType: file.type || "image/jpeg", dataUrl: await fileToDataUrl(file), caption: "" },
    pacing,
    unsubscribeFooter,
    scheduleAt: null,
    repeat: { mode: "none", until: null },
    runNumber: 1,
    createdAt: Date.now(),
    status: "running",
    contacts: recipients.map((r) => ({ id: crypto.randomUUID(), ...r, status: "pending" })),
    sentCount: 0,
    failedCount: 0,
    skippedCount: 0,
    excludedCount: list.recipients.length - recipients.length,
    auto: true,
  };
}

async function autoSendList(list, handle) {
  const slot = latestSlot(list.auto.times);
  if (slot && slot !== list.auto.lastSlot) {
    // Whatever is in the folder at the time goes out - the newest image, sent before or not. It
    // replaces anything still queued: the folder at the time is what the list is meant to get.
    const newest = (await folderImages(handle)).at(-1);
    list = await updateSavedList(list.id, (l) => {
      l.auto.lastSlot = slot;
      l.auto.pending = newest ? [newest.key] : [];
    });
    console.log(`[SWAS AUTO] "${list.name}" ${slot}: ${newest ? `queued "${newest.file.name}"` : "folder is empty"}`);
  }
  if (!list?.auto.pending?.length) return;

  // One image at a time: the next starts once this list's previous one has finished.
  const previous = (await getList("campaigns")).find((c) => c.id === list.auto.activeCampaignId);
  if (previous && ["running", "scheduled", "paused"].includes(previous.status)) return;

  const [key, ...rest] = list.auto.pending;
  const image = (await folderImages(handle)).find((candidate) => candidate.key === key);
  const campaign = image ? await buildAutoCampaign(list, image.file) : null;
  // Taken off the queue before it is launched: a failure can lose one image, never send it twice.
  await updateSavedList(list.id, (l) => {
    l.auto.pending = rest;
    l.auto.activeCampaignId = campaign?.id || null;
  });
  if (!campaign) {
    console.log(`[SWAS AUTO] "${list.name}": ${image ? "nobody left to send to" : `"${key.split("|")[0]}" is no longer in the folder`} - skipped`);
    return;
  }
  await launchCampaign(campaign);
  console.log(`[SWAS AUTO] "${list.name}": sending "${image.file.name}" to ${campaign.contacts.length} recipient(s)`);
}

/**
 * "Keep newest only": leaves just the newest image in the folder - the one the list is being sent -
 * and removes every older one, sent or not, permanently and not to the Recycle Bin. An image queued
 * to go out is kept until it has gone, so nothing waiting is lost.
 * Returns false when Chrome's permission to change the folder is missing.
 */
async function autoDeleteSent(list, handle) {
  if (!list.auto.deleteSent) return true;
  const images = await folderImages(handle); // oldest first
  const queued = new Set(list.auto.pending || []);
  const newest = images.at(-1);
  const older = images.filter((image) => image !== newest && !queued.has(image.key));
  if (!older.length) return true;
  if ((await handle.queryPermission({ mode: "readwrite" })) !== "granted") return false;

  for (const image of older) {
    await handle.removeEntry(image.file.name);
    console.log(`[SWAS AUTO] "${list.name}": deleted older image "${image.file.name}"`);
  }
  return true;
}

let autoTicking = false;

async function autoSendTick() {
  if (autoTicking || document.body.classList.contains("locked")) return;
  autoTicking = true;
  const needPermission = [];
  try {
    for (const list of (await getList("recipientLists")).filter((l) => l.auto)) {
      try {
        const handle = await getFolderHandle(list.id);
        if (!handle) continue;
        if ((await handle.queryPermission({ mode: "read" })) !== "granted") {
          if (list.auto.enabled || list.auto.deleteSent) needPermission.push(list.auto.folderName);
          continue;
        }
        if (list.auto.enabled) await autoSendList(list, handle);
        // Read again: sending may have just emptied the queue.
        const current = (await getList("recipientLists")).find((l) => l.id === list.id);
        if (current?.auto && !(await autoDeleteSent(current, handle))) needPermission.push(list.auto.folderName);
      } catch (err) {
        console.warn(`[SWAS AUTO] "${list.name}":`, err.message || err);
      }
    }
  } finally {
    autoTicking = false;
  }
  // Chrome may ask again after a restart; reading a folder needs one click from the user.
  el("auto-banner").classList.toggle("hidden", !needPermission.length);
  el("auto-banner-text").textContent = `Scheduled images are waiting: allow Chrome to use ${[...new Set(needPermission)]
    .map((name) => `"${name}"`)
    .join(", ")}.`;
}

el("btn-auto-allow").addEventListener("click", async () => {
  for (const list of (await getList("recipientLists")).filter((l) => l.auto)) {
    const handle = await getFolderHandle(list.id).catch(() => null);
    const mode = list.auto.deleteSent ? "readwrite" : "read"; // deleting needs permission to change the folder
    if (handle && (await handle.queryPermission({ mode })) !== "granted") {
      await handle.requestPermission({ mode }).catch(() => {});
    }
  }
  autoSendTick();
});

setInterval(autoSendTick, AUTO_TICK_MS);
setTimeout(autoSendTick, 3000);

// ---------- Numbers tab: add single number ----------
el("btn-add-number").addEventListener("click", () => {
  const cc = el("new-number-cc").value;
  const name = el("new-number-name").value.trim();
  const mobileRaw = el("new-number-mobile").value.trim();

  if (!/^\d{6,10}$/.test(mobileRaw)) {
    el("new-number-mobile").focus();
    return;
  }
  const mobile = `${cc}${mobileRaw}`;
  addRecipient({ name: name || mobile, source: "number", mobile });

  el("new-number-name").value = "";
  el("new-number-mobile").value = "";
});

// ---------- Template download ----------
el("download-template").addEventListener("click", (e) => {
  e.preventDefault();
  const url = chrome.runtime.getURL("assets/bulk_contacts_template.xlsx");
  chrome.downloads
    ? chrome.downloads.download({ url, filename: "bulk_contacts_template.xlsx" })
    : window.open(url, "_blank");
});

// ---------- Numbers tab: Excel / Google Sheets import ----------
function importRows(rows) {
  let added = 0;
  const errors = [];

  rows.forEach((row, idx) => {
    const fields = {};
    for (const [header, value] of Object.entries(row)) {
      const key = fieldKey(header);
      if (key) fields[key] = String(value ?? "").trim();
    }
    if (!Object.values(fields).some(Boolean)) return; // blank row

    const mobileRaw = digitsOnly(fields.mobile_number);
    const groupName = fields.group_name || "";

    if (!mobileRaw && !groupName) {
      errors.push(`Row ${idx + 2}: needs either Mobile Number or Group Name.`);
      return;
    }
    if (mobileRaw && groupName) {
      errors.push(`Row ${idx + 2}: has both Mobile Number and Group Name - only one is allowed.`);
      return;
    }

    const extras = Object.fromEntries(Object.entries(fields).filter(([key]) => !RESERVED_COLUMNS.has(key)));
    const base = { custom1: extras.custom1 || "", custom2: extras.custom2 || "", fields: extras };
    const recipient = groupName
      ? { ...base, name: groupName, source: "group", mobile: null }
      : {
          ...base,
          name: fields.name || mobileRaw,
          source: "number",
          mobile: `${digitsOnly(fields.country_code) || "91"}${mobileRaw}`,
        };

    if (addRecipient(recipient, false)) added += 1;
  });

  renderSelected();
  return { added, errors };
}

function importSummary({ added, errors }, sourceName) {
  if (!errors.length) return esc(`Added ${added} recipient(s) from ${sourceName}.`);
  return `Added ${added} recipient(s). ${errors.length} row(s) skipped:<br>${errors.slice(0, 5).map(esc).join("<br>")}${
    errors.length > 5 ? "<br>...and more" : ""
  }`;
}

el("excel-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
  el("excel-status").innerHTML = importSummary(importRows(rows), file.name);
  e.target.value = "";
});

function sheetCsvUrl(link) {
  const id = link.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1];
  if (!id) return null;
  const gid = link.match(/[#&?]gid=(\d+)/)?.[1] || "0";
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

el("btn-import-sheet").addEventListener("click", async () => {
  const statusEl = el("sheet-status");
  const url = sheetCsvUrl(el("sheet-link").value.trim());
  if (!url) {
    statusEl.textContent = "Paste a Google Sheets link (https://docs.google.com/spreadsheets/d/...).";
    return;
  }
  const btn = el("btn-import-sheet");
  btn.disabled = true;
  statusEl.textContent = "Importing...";
  try {
    const res = await fetch(url, { credentials: "include" });
    const text = await res.text();
    // A private sheet redirects to Google's sign-in page instead of returning CSV.
    if (!res.ok || /^\s*<(!doctype html|html)/i.test(text)) {
      throw new Error('Could not read the sheet. In Google Sheets click Share -> "Anyone with the link" -> Viewer, then try again.');
    }
    const workbook = XLSX.read(text, { type: "string" });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
    statusEl.innerHTML = importSummary(importRows(rows), "Google Sheet");
  } catch (err) {
    statusEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Compose: formatting toolbar ----------
function notifyComposeChanged(textarea) {
  textarea.focus();
  textarea.dispatchEvent(new Event("input"));
}

function wrapSelection(textarea, marker) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  const selected = value.slice(start, end) || "text";
  textarea.setRangeText(`${marker}${selected}${marker}`, start, end);
  textarea.setSelectionRange(start + marker.length, start + marker.length + selected.length);
  notifyComposeChanged(textarea);
}

function prefixLines(textarea, makePrefix) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = value.indexOf("\n", end);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const lines = value.slice(lineStart, lineEnd).split("\n").map((line, i) => makePrefix(i) + line);
  textarea.setRangeText(lines.join("\n"), lineStart, lineEnd, "select");
  notifyComposeChanged(textarea);
}

function insertAtCursor(textarea, text) {
  textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, "end");
  notifyComposeChanged(textarea);
}

// WhatsApp's own markers: *bold*, _italic_, ~strike~, ```mono```, "- " lists, "1. " lists, "> " quotes.
const WRAP_MARKERS = { bold: "*", italic: "_", strike: "~", mono: "```" };
const LINE_PREFIXES = { bullet: () => "- ", number: (i) => `${i + 1}. `, quote: () => "> " };

document.querySelectorAll("[data-format]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const textarea = el("message-template");
    const format = btn.dataset.format;
    if (WRAP_MARKERS[format]) wrapSelection(textarea, WRAP_MARKERS[format]);
    else prefixLines(textarea, LINE_PREFIXES[format]);
  });
});

el("emoji-picker").innerHTML = EMOJIS.map((emoji) => `<button type="button" data-emoji="${emoji}">${emoji}</button>`).join("");

el("btn-emoji").addEventListener("click", () => {
  const picker = el("emoji-picker");
  picker.classList.toggle("hidden");
  el("btn-emoji").setAttribute("aria-expanded", String(!picker.classList.contains("hidden")));
});

el("emoji-picker").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-emoji]");
  if (btn) insertAtCursor(el("message-template"), btn.dataset.emoji);
});

// ---------- Compose: placeholders + live preview ----------
function renderPlaceholderChips() {
  const keys = new Set(["name", "custom1", "custom2"]);
  selectedRecipients.forEach((r) => Object.keys(r.fields || {}).forEach((key) => keys.add(key)));
  el("placeholder-chips").innerHTML = [...keys]
    .map((key) => `<button type="button" class="chip" data-key="${esc(key)}">{{${esc(key)}}}</button>`)
    .join("");
}

el("placeholder-chips").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-key]");
  if (chip) insertAtCursor(el("message-template"), `{{${chip.dataset.key}}}`);
});

/** Renders WhatsApp formatting markers the way WhatsApp shows them. Input is escaped first. */
function formatWhatsApp(text) {
  const edge = "(?=[\\s.,!?:;)]|$)";
  const styled = (marker) =>
    new RegExp(`(^|[\\s(])\\${marker}(\\S(?:[^${marker}\\n]*\\S)?)\\${marker}${edge}`, "gm");
  return esc(text)
    .replace(/```([\s\S]+?)```/g, "<code>$1</code>")
    .replace(styled("*"), "$1<b>$2</b>")
    .replace(styled("_"), "$1<i>$2</i>")
    .replace(styled("~"), "$1<s>$2</s>")
    .replace(/\n/g, "<br>");
}

function updatePreview() {
  const sample = selectedRecipients[0] || { name: "Customer", fields: {} };
  const caption = el("attachment-caption").value.trim();
  // content.js sends the caption (or the message when there's no caption) with an attachment.
  const text = attachmentData && caption ? caption : el("message-template").value;

  el("preview-to").textContent = selectedRecipients[0]
    ? `Preview for ${sample.name}`
    : "Preview (add recipients to see their details filled in)";
  const body = withFooter(personalize(text, sample).trim(), readSendOptions().unsubscribeFooter);
  const fileLine = attachmentData ? `<div class="bubble-file">📎 ${esc(attachmentData.name)}</div>` : "";
  el("preview-bubble").innerHTML =
    fileLine + (body ? formatWhatsApp(body) : '<span class="muted">Your message preview appears here.</span>');
}

el("message-template").addEventListener("input", updatePreview);
el("attachment-caption").addEventListener("input", updatePreview);

// ---------- Compose: saved templates ----------
async function renderTemplateSelect() {
  const templates = await getList("templates");
  const select = el("template-select");
  const current = select.value;
  select.innerHTML =
    `<option value="">Saved templates (${templates.length})</option>` +
    templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  select.value = templates.some((t) => t.id === current) ? current : "";
}

el("template-select").addEventListener("change", async (e) => {
  const template = (await getList("templates")).find((t) => t.id === e.target.value);
  if (!template) return;
  el("message-template").value = template.text;
  updatePreview();
});

el("btn-save-template").addEventListener("click", async () => {
  const text = el("message-template").value.trim();
  if (!text) {
    el("compose-status").textContent = "Write a message first, then save it as a template.";
    return;
  }
  const name = prompt("Template name:")?.trim();
  if (!name) return;
  const templates = await getList("templates");
  const template = { id: crypto.randomUUID(), name, text };
  await setList("templates", [template, ...templates]);
  await renderTemplateSelect();
  el("template-select").value = template.id;
  el("compose-status").textContent = `Saved template "${name}".`;
});

el("btn-delete-template").addEventListener("click", async () => {
  const id = el("template-select").value;
  if (!id) return;
  await setList("templates", (await getList("templates")).filter((t) => t.id !== id));
  await renderTemplateSelect();
  el("compose-status").textContent = "Template deleted.";
});

// ---------- Compose: translate (Chrome's built-in on-device Translator API) ----------
el("btn-translate").addEventListener("click", async () => {
  const statusEl = el("translate-status");
  const textarea = el("message-template");
  const target = el("translate-lang").value;
  const text = textarea.value.trim();

  if (!text) {
    statusEl.textContent = "Write a message first.";
    return;
  }
  if (!("Translator" in self) || !("LanguageDetector" in self)) {
    statusEl.textContent = "Translation needs Chrome 138 or newer.";
    return;
  }

  const btn = el("btn-translate");
  btn.disabled = true;
  try {
    statusEl.textContent = "Detecting language...";
    const detector = await LanguageDetector.create();
    const source = (await detector.detect(text))[0]?.detectedLanguage;
    if (!source || source === "und") throw new Error("could not detect the message language.");
    if (source === target) {
      statusEl.textContent = "The message is already in that language.";
      return;
    }

    const availability = await Translator.availability({ sourceLanguage: source, targetLanguage: target });
    if (availability === "unavailable") throw new Error(`Chrome can't translate ${source} to ${target} on this device.`);
    statusEl.textContent = availability === "available" ? "Translating..." : "Downloading language pack (first time only)...";
    const translator = await Translator.create({ sourceLanguage: source, targetLanguage: target });

    // Shield {{placeholders}} so they aren't translated.
    const placeholders = [];
    const shielded = text.replace(/\{\{[^{}]+\}\}/g, (match) => `[${placeholders.push(match) - 1}]`);
    const translated = (await translator.translate(shielded)).replace(
      /\[\s*(\d+)\s*\]/g,
      (match, index) => placeholders[index] ?? match
    );

    textarea.value = translated;
    updatePreview();
    statusEl.textContent = `Translated ${source} -> ${target}. Check the preview before sending.`;
  } catch (err) {
    statusEl.textContent = `Translation failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Attachment ----------
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Drops the attached file - the picker itself keeps the old filename until it is reset too. */
function clearAttachment() {
  attachmentData = null;
  el("attachment-file").value = "";
  el("attachment-preview").textContent = "";
  el("attachment-row").classList.add("hidden");
  updatePreview();
}

el("btn-remove-attachment").addEventListener("click", clearAttachment);

el("attachment-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) {
    clearAttachment();
    return;
  }
  const dataUrl = await fileToDataUrl(file);
  attachmentData = { name: file.name, mimeType: file.type, dataUrl };
  el("attachment-preview").textContent = `Attached: ${file.name} (${Math.round(file.size / 1024)} KB)`;
  el("attachment-row").classList.remove("hidden");
  updatePreview();
});

// ---------- Saved attachment + caption (up to 5) ----------
// The same photo and caption often go out campaign after campaign; a saved pair comes back in one click.
const MAX_PRESETS = 5;

function presetStatus(text) {
  el("preset-status").textContent = text;
}

function presetThumb(preset) {
  const file = preset.attachment;
  if (file?.mimeType?.startsWith("image/")) return `<img class="preset-thumb" src="${esc(file.dataUrl)}" alt="" />`;
  const type = file?.mimeType || "";
  const icon = !file ? "📝" : type.startsWith("video/") ? "🎬" : type.startsWith("audio/") ? "🎤" : type === "application/pdf" ? "📄" : "📎";
  return `<span class="preset-thumb preset-icon">${icon}</span>`;
}

async function renderPresets() {
  const presets = await getList("attachmentPresets");
  el("preset-count").textContent = presets.length;
  el("preset-list").classList.toggle("hidden", !presets.length);
  el("preset-list").innerHTML = presets
    .map((p) => {
      const detail = [p.attachment?.name || "No attachment", (p.caption || "").split("\n")[0]].filter(Boolean).join(" - ");
      return `
      <div class="pick-row preset-row">
        ${presetThumb(p)}
        <div class="preset-body"><div class="pname">${esc(p.name)}</div><div class="ptext">${esc(detail)}</div></div>
        <div class="row-actions">
          <button type="button" data-use-preset="${esc(p.id)}">Use</button>
          <button type="button" data-remove-preset="${esc(p.id)}">Delete</button>
        </div>
      </div>`;
    })
    .join("");
}

el("btn-save-preset").addEventListener("click", async () => {
  const caption = el("attachment-caption").value.trim();
  if (!attachmentData && !caption) {
    presetStatus("Attach a file or write a caption first, then save.");
    return;
  }
  const presets = await getList("attachmentPresets");
  if (presets.length >= MAX_PRESETS) {
    presetStatus(`Only ${MAX_PRESETS} can be saved - delete one below first.`);
    return;
  }
  const suggested = (caption.split("\n")[0] || attachmentData?.name || "").slice(0, 40);
  const name = prompt("Name for this attachment + caption:", suggested)?.trim();
  if (!name) return;
  try {
    await setList("attachmentPresets", [...presets, { id: crypto.randomUUID(), name, caption, attachment: attachmentData }]);
    presetStatus(`Saved "${name}".`);
  } catch (err) {
    presetStatus(`Could not save: ${err.message}`);
  }
});

el("preset-list").addEventListener("click", async (e) => {
  const use = e.target.closest("[data-use-preset]");
  const remove = e.target.closest("[data-remove-preset]");
  const presets = await getList("attachmentPresets");
  const preset = presets.find((p) => p.id === (use || remove)?.dataset[use ? "usePreset" : "removePreset"]);
  if (!preset) return;

  if (remove) {
    if (!confirm(`Delete saved "${preset.name}"?`)) return;
    await setList("attachmentPresets", presets.filter((p) => p.id !== preset.id));
    presetStatus(`Deleted "${preset.name}".`);
    return;
  }
  // Puts back exactly the saved pair: its file (or none) and its caption.
  el("attachment-caption").value = preset.caption || "";
  if (preset.attachment) {
    attachmentData = { ...preset.attachment };
    el("attachment-file").value = "";
    el("attachment-preview").textContent = `Attached: ${preset.attachment.name} (saved "${preset.name}")`;
    el("attachment-row").classList.remove("hidden");
    updatePreview();
  } else {
    clearAttachment();
  }
  presetStatus(`Using "${preset.name}".`);
});

el("repeat-mode").addEventListener("change", () => {
  el("repeat-until-field").classList.toggle("hidden", el("repeat-mode").value === "none");
});

// ---------- Schedule toggle ----------
document.querySelectorAll('input[name="when"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const isLater = document.querySelector('input[name="when"]:checked').value === "later";
    el("schedule-fields").classList.toggle("hidden", !isLater);
  });
});

// ---------- More Options: pacing + unsubscribe footer (remembered between campaigns) ----------
const OPTION_INPUTS = [
  "gap-range",
  "gap-seconds",
  "gap-min",
  "gap-max",
  "batch-enabled",
  "batch-size-range",
  "batch-size",
  "batch-pause-range",
  "batch-pause",
  "footer-enabled",
  "footer-text",
  "footer-keyword",
];

function bindSlider(rangeId, numberId) {
  el(rangeId).addEventListener("input", () => (el(numberId).value = el(rangeId).value));
  el(numberId).addEventListener("input", () => (el(rangeId).value = el(numberId).value));
}

bindSlider("gap-range", "gap-seconds");
bindSlider("batch-size-range", "batch-size");
bindSlider("batch-pause-range", "batch-pause");

function gapMode() {
  return document.querySelector('input[name="gap-mode"]:checked').value;
}

function syncOptionStates() {
  const random = gapMode() === "random";
  ["gap-range", "gap-seconds"].forEach((id) => (el(id).disabled = random));
  ["gap-min", "gap-max"].forEach((id) => (el(id).disabled = !random));
  ["batch-size-range", "batch-size", "batch-pause-range", "batch-pause"].forEach(
    (id) => (el(id).disabled = !el("batch-enabled").checked)
  );
  ["footer-text", "footer-keyword"].forEach((id) => (el(id).disabled = !el("footer-enabled").checked));
}

function readSendOptions() {
  const num = (id, fallback, min) => Math.max(min, parseInt(el(id).value, 10) || fallback);
  const minGap = num("gap-min", 20, 3);
  return {
    pacing: {
      mode: gapMode(),
      gapSeconds: num("gap-seconds", 15, 3),
      minGap,
      maxGap: Math.max(minGap, num("gap-max", 60, 3)),
      batchEnabled: el("batch-enabled").checked,
      batchSize: num("batch-size", 25, 1),
      batchPauseSeconds: num("batch-pause", 180, 10),
    },
    unsubscribeFooter: {
      enabled: el("footer-enabled").checked,
      text: el("footer-text").value.trim(),
      keyword: el("footer-keyword").value.trim(),
    },
  };
}

async function saveSendOptions() {
  syncOptionStates();
  updatePreview();
  await chrome.storage.local.set({ sendOptions: readSendOptions() });
}

async function loadSendOptions() {
  const { sendOptions } = await chrome.storage.local.get("sendOptions");
  if (sendOptions) {
    const { pacing: p, unsubscribeFooter: f } = sendOptions;
    const modeRadio = document.querySelector(`input[name="gap-mode"][value="${p.mode === "fixed" ? "fixed" : "random"}"]`);
    modeRadio.checked = true;
    el("gap-seconds").value = el("gap-range").value = p.gapSeconds;
    el("gap-min").value = p.minGap;
    el("gap-max").value = p.maxGap;
    el("batch-enabled").checked = p.batchEnabled;
    el("batch-size").value = el("batch-size-range").value = p.batchSize;
    el("batch-pause").value = el("batch-pause-range").value = p.batchPauseSeconds;
    el("footer-enabled").checked = f.enabled;
    el("footer-text").value = f.text;
    el("footer-keyword").value = f.keyword;
  }
  syncOptionStates();
  updatePreview();
}

document.querySelectorAll('input[name="gap-mode"]').forEach((radio) => radio.addEventListener("change", saveSendOptions));
OPTION_INPUTS.forEach((id) => el(id).addEventListener("change", saveSendOptions));
el("footer-text").addEventListener("input", updatePreview);

// ---------- Start / Schedule campaign ----------
/**
 * Creates a campaign from the form for the selected recipients. fromLists is set when sending saved lists:
 * the campaign is named after the lists and the message is kept for the next send.
 * Returns an error message, or null once the campaign is saved and started.
 */
/** Saves a new campaign and hands it to the background worker, which sends it. */
async function launchCampaign(campaign) {
  await setList("campaigns", [campaign, ...(await getList("campaigns"))]);
  const footer = campaign.unsubscribeFooter;
  if (footer.enabled) {
    // content.js watches incoming replies for these keywords.
    const keywords = await getList("unsubscribeKeywords");
    if (!keywords.some((k) => k.toLowerCase() === footer.keyword.toLowerCase())) {
      await setList("unsubscribeKeywords", [...keywords, footer.keyword]);
    }
  }
  chrome.runtime.sendMessage({ type: "CAMPAIGN_CREATED", campaignId: campaign.id });
}

/**
 * `direct`: Direct Send - goes out right now with no campaign name, schedule or repeat needed. It is
 * still a campaign underneath (named after the time), so its delivery shows in Reports like any other.
 */
async function startCampaign({ fromLists = false, direct = false } = {}) {
  el("campaign-error").classList.add("hidden");

  // Saved lists the selected people came from; shown in the report and used as the default name.
  const lists = [...new Set(selectedRecipients.flatMap((r) => r.fromLists || []))];
  const listsName = lists.length ? `${lists.join(" + ")} - ${new Date().toLocaleDateString()}` : "";
  const directName = `Direct send - ${new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
  const name = (!fromLists && el("campaign-name").value.trim()) || listsName || (direct ? directName : "");
  const messageTemplate = el("message-template").value.trim();
  const { pacing, unsubscribeFooter } = readSendOptions();
  const when = direct ? "now" : document.querySelector('input[name="when"]:checked').value;

  if (!name) return showCampaignError("Please enter a campaign name.");
  if (!selectedRecipients.length) return showCampaignError("Pick at least one contact, group or number first.");
  if (!messageTemplate && !attachmentData) return showCampaignError("Add a message or an attachment.");
  if (unsubscribeFooter.enabled && (!unsubscribeFooter.text || !unsubscribeFooter.keyword)) {
    return showCampaignError("Fill in the unsubscribe message and keyword, or turn the footer off.");
  }

  let scheduleAt = null;
  if (when === "later") {
    const date = el("schedule-date").value;
    const time = el("schedule-time").value;
    if (!date || !time) return showCampaignError("Pick both date and time for scheduling.");
    scheduleAt = new Date(`${date}T${time}`).getTime();
    if (scheduleAt <= Date.now()) return showCampaignError("Scheduled time must be in the future.");
  }

  const unsubscribers = await getList("unsubscribers");
  const recipients = selectedRecipients.filter((r) => !isUnsubscribed(r, unsubscribers));
  if (!recipients.length) return showCampaignError("Every selected recipient is on the Unsubscribers list.");

  const repeatMode = direct ? "none" : el("repeat-mode").value;
  const repeatUntil = !direct && el("repeat-until").value ? new Date(`${el("repeat-until").value}T23:59`).getTime() : null;
  if (repeatMode !== "none" && repeatUntil && repeatUntil <= Date.now()) {
    return showCampaignError('"Repeat until" must be a future date.');
  }

  const caption = el("attachment-caption").value.trim();
  const attachment = attachmentData ? { ...attachmentData, caption } : null;

  const campaign = {
    id: crypto.randomUUID(),
    name,
    lists,
    messageTemplate,
    attachment,
    pacing,
    unsubscribeFooter,
    scheduleAt, // null = send now
    repeat: { mode: repeatMode, until: repeatUntil },
    runNumber: 1,
    createdAt: Date.now(),
    status: scheduleAt ? "scheduled" : "running",
    contacts: recipients.map((r) => ({ ...r, status: "pending" })),
    sentCount: 0,
    failedCount: 0,
    skippedCount: 0,
    excludedCount: selectedRecipients.length - recipients.length,
  };

  await launchCampaign(campaign);

  if (fromLists) {
    selectedRecipients = [];
    renderSelected();
    renderPickList("contact");
    renderPickList("group");
  } else if (direct) {
    // Stays on this page: the progress shows right under the buttons.
    resetForm();
    el("campaign-live").scrollIntoView({ behavior: "smooth", block: "center" });
  } else {
    resetForm();
    showPage("reports");
  }
  renderCampaigns();
  return null;
}

el("btn-start-campaign").addEventListener("click", () => startCampaign());
el("btn-direct-send").addEventListener("click", () => startCampaign({ direct: true }));

function showCampaignError(msg) {
  const errEl = el("campaign-error");
  errEl.textContent = msg;
  errEl.classList.remove("hidden");
  return msg;
}

function resetForm() {
  el("campaign-name").value = "";
  el("repeat-mode").value = "none";
  el("repeat-until").value = "";
  el("repeat-until-field").classList.add("hidden");
  el("message-template").value = "";
  el("attachment-file").value = "";
  el("attachment-caption").value = "";
  el("attachment-row").classList.add("hidden");
  el("attachment-preview").textContent = "";
  el("template-select").value = "";
  el("translate-status").textContent = "";
  el("compose-status").textContent = "";
  attachmentData = null;
  selectedRecipients = [];
  renderSelected();
  renderPickList("contact");
  renderPickList("group");
}

// ---------- Reports ----------
function statusBadge(status) {
  const labels = {
    scheduled: "Scheduled",
    paused: "Paused",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    pending: "Pending",
    sent: "Sent",
    skipped: "Skipped",
  };
  return `<span class="status-badge status-${esc(status)}">${esc(labels[status] || status)}</span>`;
}

function reportTable(c) {
  const rows = c.contacts
    .map(
      (r, i) =>
        `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.mobile || r.name)}</td>` +
        `<td>${esc((r.fromLists || []).join(", "))}</td><td>${statusBadge(r.status)}</td>` +
        `<td>${r.sentAt ? esc(new Date(r.sentAt).toLocaleString()) : ""}</td><td class="reason">${esc(r.failReason || r.note || "")}</td></tr>`
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>#</th><th>Name</th><th>Target</th><th>List</th><th>Status</th><th>Time</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function exportReport(c) {
  const rows = c.contacts.map((r, i) => ({
    "#": i + 1,
    Name: r.name,
    Target: r.mobile || r.name,
    List: (r.fromLists || []).join(", "),
    Type: r.source,
    Status: r.status,
    Time: r.sentAt ? new Date(r.sentAt) : "",
    Reason: r.failReason || r.note || "",
  }));
  downloadSheet(rows, "Report", `${c.name}_report.xlsx`);
}

function pacingText(c) {
  const p = c.pacing || { mode: "fixed", gapSeconds: c.gapSeconds };
  const gap = p.mode === "random" ? `gap ${p.minGap}-${p.maxGap}s (random)` : `gap ${p.gapSeconds}s`;
  const batch = p.batchEnabled ? ` - batches of ${p.batchSize}, ${p.batchPauseSeconds}s pause` : "";
  return gap + batch + (c.unsubscribeFooter?.enabled ? " - unsubscribe footer" : "");
}

const REPEAT_TEXT = { daily: "repeats daily", weekly: "repeats weekly", monthly: "repeats monthly" };

/** "Pending" on a campaign means it still has messages to go out - scheduled, sending or paused. */
function isPending(c) {
  return ["scheduled", "running", "paused"].includes(c.status);
}

/** Pause / Resume / Start now / Cancel, in the combination that makes sense for this status. */
function controlButtons(c) {
  const id = esc(c.id);
  const button = (action, label) => `<button type="button" data-action="${action}" data-id="${id}">${label}</button>`;
  const buttons = [];
  if (c.status === "scheduled") buttons.push(button("startnow", "Start now"), button("pause", "Pause"));
  if (c.status === "running") buttons.push(button("pause", "Pause"));
  if (c.status === "paused") buttons.push(button("resume", "Resume"), button("startnow", "Start now"));
  if (isPending(c)) buttons.push(button("cancel", "Cancel"));
  return buttons.join("\n");
}

/** Sends the message behind a control button; returns false when the user backs out. */
async function runCampaignAction(action, campaignId) {
  const types = {
    pause: "CAMPAIGN_PAUSE",
    resume: "CAMPAIGN_RESUME",
    startnow: "CAMPAIGN_START_NOW",
    cancel: "CAMPAIGN_CANCEL",
  };
  if (!types[action]) return false;
  if (action === "cancel" && !confirm("Cancel this campaign? The messages still pending will not be sent.")) {
    return false;
  }
  if (action === "startnow" && !confirm("Start sending now instead of waiting for the scheduled time?")) {
    return false;
  }
  await chrome.runtime.sendMessage({ type: types[action], campaignId });
  return true;
}

/** The live block inside "5. Campaign": what is going out now, and the buttons to hold it. */
function renderCampaignLive(campaigns) {
  const box = el("campaign-live");
  const active = campaigns.filter(isPending);
  const scheduled = campaigns.filter((c) => c.status === "scheduled").length;
  const completed = campaigns.filter((c) => c.status === "completed").length;
  const counts = `<div class="live-counts">${scheduled} scheduled &middot; ${completed} completed</div>`;

  if (!active.length) {
    box.innerHTML = `<div class="live-idle">Nothing sending right now.</div>${counts}`;
    return;
  }

  box.innerHTML =
    active
      .map((c) => {
        const total = c.contacts.length;
        const done = (c.sentCount || 0) + (c.failedCount || 0) + (c.skippedCount || 0);
        const when =
          c.status === "scheduled" && c.scheduleAt
            ? ` &middot; starts ${esc(new Date(c.scheduleAt).toLocaleString())}`
            : "";
        return `
          <div class="live-row">
            <div class="live-name">${statusBadge(c.status)} <b>${esc(c.name)}</b></div>
            <div class="progress-bar"><div class="fill" style="width:${total ? Math.round((done / total) * 100) : 0}%"></div></div>
            <div class="campaign-meta">${done} of ${total} done &middot; ${total - done} still to go${when}</div>
            <div class="campaign-actions">${controlButtons(c)}</div>
          </div>`;
      })
      .join("") + counts;
}

el("campaign-live").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (btn) await runCampaignAction(btn.dataset.action, btn.dataset.id);
});

/** The line that answers "what is actually going out right now, and what is queued after it". */
function renderActiveNow(campaigns) {
  const active = campaigns.filter(isPending);
  const box = el("active-now");
  box.classList.toggle("idle", !active.length);
  if (!active.length) {
    box.textContent = "Nothing running or scheduled right now.";
    return;
  }

  box.innerHTML = active
    .map((c) => {
      const total = c.contacts.length;
      const done = (c.sentCount || 0) + (c.failedCount || 0) + (c.skippedCount || 0);
      let detail;
      if (c.status === "running") {
        const next = c.nextSendAt > Date.now() ? ` - next at ${esc(new Date(c.nextSendAt).toLocaleTimeString())}` : "";
        detail = `sending ${done}/${total}${next}`;
      } else if (c.status === "paused") {
        detail = `held at ${done}/${total} - Resume to carry on`;
      } else {
        detail = `waiting for ${esc(new Date(c.scheduleAt).toLocaleString())}`;
      }
      return `<div class="active-line">${statusBadge(c.status)} <b>${esc(c.name)}</b> - ${detail}</div>`;
    })
    .join("");
}

function renderReportFilters(campaigns) {
  const counts = {
    all: campaigns.length,
    running: campaigns.filter((c) => c.status === "running").length,
    scheduled: campaigns.filter((c) => c.status === "scheduled").length,
    paused: campaigns.filter((c) => c.status === "paused").length,
    completed: campaigns.filter((c) => c.status === "completed").length,
    cancelled: campaigns.filter((c) => c.status === "cancelled").length,
  };
  document.querySelectorAll("#report-filters button[data-filter]").forEach((btn) => {
    const key = btn.dataset.filter;
    const label = key === "all" ? "All" : key[0].toUpperCase() + key.slice(1);
    btn.textContent = `${label} (${counts[key]})`;
    btn.setAttribute("aria-selected", String(key === reportFilter));
  });
  el("btn-clear-completed").classList.toggle("hidden", !counts.completed);
}

async function renderCampaigns() {
  const campaigns = await getList("campaigns");

  const totals = { sent: 0, failed: 0, skipped: 0 };
  campaigns.forEach((c) => {
    totals.sent += c.sentCount || 0;
    totals.failed += c.failedCount || 0;
    totals.skipped += (c.skippedCount || 0) + (c.excludedCount || 0);
  });
  const attempted = totals.sent + totals.failed;
  el("stat-campaigns").textContent = campaigns.length;
  el("stat-sent").textContent = totals.sent;
  el("stat-failed").textContent = totals.failed;
  el("stat-skipped").textContent = totals.skipped;
  el("stat-rate").textContent = attempted ? `${Math.round((totals.sent / attempted) * 100)}%` : "-";

  renderReportFilters(campaigns);
  renderActiveNow(campaigns);
  renderCampaignLive(campaigns);

  const container = el("campaigns-list");
  const shown = reportFilter === "all" ? campaigns : campaigns.filter((c) => c.status === reportFilter);
  if (!shown.length) {
    container.innerHTML = `<p class="hint">${campaigns.length ? "No campaigns with this status." : "No campaigns yet."}</p>`;
    return;
  }

  container.innerHTML = shown
    .map((c) => {
      const total = c.contacts.length;
      const sent = c.sentCount || 0;
      const failed = c.failedCount || 0;
      const skipped = c.skippedCount || 0;
      const done = sent + failed + skipped;
      const pct = total ? Math.round((done / total) * 100) : 0;
      const open = openReports.has(c.id);
      const id = esc(c.id);
      return `
        <div class="campaign-item">
          <div class="head"><span>${esc(c.name)}</span>${statusBadge(c.status)}</div>
          <div class="campaign-meta">
            ${c.lists?.length ? `Lists: <b>${esc(c.lists.join(", "))}</b> - ` : ""}${total} recipient(s) - ${esc(pacingText(c))}
            ${c.status === "running" && c.nextSendAt > Date.now() ? `- next message at ${esc(new Date(c.nextSendAt).toLocaleTimeString())}` : ""}
            ${c.scheduleAt ? `- scheduled for ${esc(new Date(c.scheduleAt).toLocaleString())}` : "- sent immediately"}
            ${REPEAT_TEXT[c.repeat?.mode] ? `- ${REPEAT_TEXT[c.repeat.mode]}${c.runNumber > 1 ? ` (run ${c.runNumber})` : ""}` : ""}
            ${c.repeat?.until ? `until ${esc(new Date(c.repeat.until).toLocaleDateString())}` : ""}
            ${c.excludedCount ? `- ${c.excludedCount} excluded (unsubscribed)` : ""}
            ${c.cancelReason ? `- stopped: ${esc(c.cancelReason)}` : ""}
          </div>
          <div class="progress-bar"><div class="fill" style="width:${pct}%"></div></div>
          <div class="campaign-meta">Sent: ${sent} | Failed: ${failed} | Skipped: ${skipped} | Pending: ${total - done}</div>
          <div class="campaign-actions">
            <button data-action="details" data-id="${id}">${open ? "Hide details" : "View details"}</button>
            <button data-action="export" data-id="${id}">Download report</button>
            ${controlButtons(c)}
            <button data-action="delete" data-id="${id}">Delete</button>
          </div>
          ${open ? `<div class="report-details">${reportTable(c)}</div>` : ""}
        </div>`;
    })
    .join("");
}

el("report-filters").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn) return;
  reportFilter = btn.dataset.filter;
  renderCampaigns();
});

el("btn-clear-completed").addEventListener("click", async () => {
  const campaigns = await getList("campaigns");
  const done = campaigns.filter((c) => c.status === "completed");
  if (!done.length) return;
  if (!confirm(`Delete ${done.length} completed campaign(s) and their reports? This cannot be undone.`)) return;
  await setList("campaigns", campaigns.filter((c) => c.status !== "completed"));
});

el("campaigns-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  const campaign = (await getList("campaigns")).find((c) => c.id === id);
  if (!campaign) return;

  const action = btn.dataset.action;
  if (action === "details") {
    if (openReports.has(id)) openReports.delete(id);
    else openReports.add(id);
    renderCampaigns();
  } else if (action === "export") {
    exportReport(campaign);
  } else if (await runCampaignAction(action, id)) {
    return; // storage.onChanged re-renders once the worker has applied it
  } else if (action === "delete") {
    if (!confirm(`Delete campaign "${campaign.name}" and its report?`)) return;
    if (campaign.status === "scheduled" || campaign.status === "running") {
      await chrome.runtime.sendMessage({ type: "CAMPAIGN_CANCEL", campaignId: id });
    }
    await setList("campaigns", (await getList("campaigns")).filter((c) => c.id !== id));
  }
});

// ---------- Chatbot ----------
// Matching and the default Starshift menu live in common/chatbot.js (SwasBot), which the WhatsApp
// Web content script uses too, so Test Reply picks exactly what the real bot would send.
const BOT_TEXT_FIELDS = {
  welcomeKeywords: "bot-welcome-keywords",
  welcomeMessage: "bot-welcome-message",
  fallbackMessage: "bot-fallback-message",
  stopKeywords: "bot-stop-keywords",
  startKeywords: "bot-start-keywords",
  unsubscribeReply: "bot-unsub-reply",
};
let editingRuleId = null; // the rule loaded into the form by Edit; null while adding a new one

function botSettingsFromForm() {
  const text = Object.fromEntries(Object.entries(BOT_TEXT_FIELDS).map(([key, id]) => [key, el(id).value.trim()]));
  return {
    ...text,
    enabled: el("bot-enabled").checked,
    autoUnsubscribe: el("bot-auto-unsub").checked,
    fallbackEnabled: el("bot-fallback-enabled").checked,
  };
}

/** Adds whichever default menu rules are missing (matched by id), leaving the user's own rules alone. */
async function addMenuRules() {
  const rules = await getList("botRules");
  const have = new Set(rules.map((r) => r.id));
  const missing = SwasBot.DEFAULT_RULES.filter((r) => !have.has(r.id)).map((r) => ({ ...r }));
  if (missing.length) await setList("botRules", [...rules, ...missing]);
  return missing.length;
}

async function loadBotSettings() {
  const { botSettings = {} } = await chrome.storage.local.get("botSettings");
  // The first time this version runs, the bot starts from the Starshift menu. Only once, so a
  // rule deleted later stays deleted.
  if (!botSettings.menuSeeded) {
    await addMenuRules();
    await chrome.storage.local.set({ botSettings: { ...botSettings, menuSeeded: true } });
  }
  const settings = SwasBot.resolveSettings(botSettings);
  el("bot-enabled").checked = !!settings.enabled;
  el("bot-auto-unsub").checked = settings.autoUnsubscribe;
  el("bot-fallback-enabled").checked = !!settings.fallbackEnabled;
  Object.entries(BOT_TEXT_FIELDS).forEach(([key, id]) => (el(id).value = settings[key]));
}

async function saveBotSettings() {
  const { botSettings = {} } = await chrome.storage.local.get("botSettings");
  const form = botSettingsFromForm();
  if (!form.unsubscribeReply) el("bot-unsub-reply").value = form.unsubscribeReply = SwasBot.DEFAULT_SETTINGS.unsubscribeReply;
  await chrome.storage.local.set({ botSettings: { ...botSettings, ...form } });
}

["bot-enabled", "bot-auto-unsub", "bot-fallback-enabled", ...Object.values(BOT_TEXT_FIELDS)].forEach((id) =>
  el(id).addEventListener("change", saveBotSettings)
);


/** Who is sending the replies right now: the server WhatsApp, or this Chrome's WhatsApp Web tab. */
async function renderBotEngine() {
  const { serverBot } = await chrome.storage.local.get("serverBot");
  const line = el("bot-engine");
  const fresh = serverBot && Date.now() - serverBot.checkedAt < 25 * 60 * 1000;
  line.className = `bot-engine ${fresh && serverBot.running ? "on" : "off"}`;
  if (fresh && serverBot.running) {
    line.textContent = "⚡ Replies go instantly from the server WhatsApp - nothing is typed in WhatsApp Web.";
  } else if (fresh && serverBot.error) {
    line.textContent = `Server not reachable (${serverBot.error}) - replies go through WhatsApp Web, so keep a tab open.`;
  } else {
    line.textContent = "Replies go through WhatsApp Web (keep a tab open). Link the server WhatsApp (top right) for instant replies.";
  }
}

function setRuleStatus(text, isError = false) {
  el("rule-status").textContent = text;
  el("rule-status").className = isError ? "error" : "hint";
}

async function renderBotRules() {
  const rules = await getList("botRules");
  el("rules-list").innerHTML = rules.length
    ? rules
        .map((r) => {
          const on = r.enabled !== false;
          const chips = String(r.keyword || "")
            .split(/[,\n]/)
            .map((k) => k.trim())
            .filter(Boolean)
            .map((k) => `<span class="kw-chip">${esc(k)}</span>`)
            .join("");
          return `
      <div class="pick-row rule-row${on ? "" : " off"}${r.id === editingRuleId ? " editing" : ""}">
        <label class="rule-toggle" title="${on ? "On - untick to pause this rule" : "Off - tick to turn this rule on"}">
          <input type="checkbox" data-toggle-rule="${esc(r.id)}" aria-label="Rule ${esc(r.keyword)} enabled" ${on ? "checked" : ""} />
        </label>
        <div class="rule-body">
          <div class="pname"><span class="match-badge">${r.match === "exact" ? "Exactly" : "Contains"}</span>${chips}</div>
          <div class="ptext">${esc(r.reply)}</div>
        </div>
        <div class="row-actions">
          <button type="button" data-edit-rule="${esc(r.id)}">Edit</button>
          <button type="button" data-remove-rule="${esc(r.id)}">Delete</button>
        </div>
      </div>`;
        })
        .join("")
    : '<div class="empty-note">No rules yet. Add one above, or restore the Starshift menu rules.</div>';
}

function resetRuleForm() {
  editingRuleId = null;
  el("rule-keyword").value = "";
  el("rule-reply").value = "";
  el("rule-match").value = "contains";
  el("btn-add-rule").textContent = "Add keyword";
  el("btn-cancel-rule").classList.add("hidden");
  setRuleStatus("");
}

el("btn-add-rule").addEventListener("click", async () => {
  const keyword = el("rule-keyword").value.trim();
  const reply = el("rule-reply").value.trim();
  if (!SwasBot.keywordList(keyword).length || !reply) {
    setRuleStatus("Enter a keyword (letters or numbers) and the automatic reply.", true);
    return;
  }
  const rules = await getList("botRules");
  const fields = { keyword, match: el("rule-match").value, reply };
  const index = rules.findIndex((r) => r.id === editingRuleId);
  if (index >= 0) rules[index] = { ...rules[index], ...fields };
  else rules.push({ id: crypto.randomUUID(), ...fields, enabled: true });
  resetRuleForm();
  await setList("botRules", rules);
});

el("btn-cancel-rule").addEventListener("click", () => {
  resetRuleForm();
  renderBotRules();
});

el("btn-seed-menu").addEventListener("click", async () => {
  const added = await addMenuRules();
  setRuleStatus(added ? `Added ${added} Starshift menu rule(s).` : "All Starshift menu rules are already in the list.");
});

el("rules-list").addEventListener("click", async (e) => {
  const edit = e.target.closest("[data-edit-rule]");
  const remove = e.target.closest("[data-remove-rule]");
  if (edit) {
    const rule = (await getList("botRules")).find((r) => r.id === edit.dataset.editRule);
    if (!rule) return;
    editingRuleId = rule.id;
    el("rule-keyword").value = rule.keyword;
    el("rule-match").value = rule.match === "exact" ? "exact" : "contains";
    el("rule-reply").value = rule.reply;
    el("btn-add-rule").textContent = "Save changes";
    el("btn-cancel-rule").classList.remove("hidden");
    setRuleStatus("");
    renderBotRules();
    el("rule-keyword").scrollIntoView({ behavior: "smooth", block: "center" });
    el("rule-keyword").focus({ preventScroll: true });
  } else if (remove) {
    if (remove.dataset.removeRule === editingRuleId) resetRuleForm();
    await setList("botRules", (await getList("botRules")).filter((r) => r.id !== remove.dataset.removeRule));
  }
});

el("rules-list").addEventListener("change", async (e) => {
  const toggle = e.target.closest("[data-toggle-rule]");
  if (!toggle) return;
  const rules = await getList("botRules");
  const rule = rules.find((r) => r.id === toggle.dataset.toggleRule);
  if (!rule) return;
  rule.enabled = toggle.checked;
  await setList("botRules", rules);
});

async function testBotReply() {
  const message = el("test-message").value;
  el("test-result").classList.remove("hidden");
  if (!message.trim()) {
    el("test-label").textContent = "Type a customer message first.";
    el("test-bubble").classList.add("hidden");
    return;
  }
  const { botRules = [], unsubscribeKeywords = [] } = await chrome.storage.local.get(["botRules", "unsubscribeKeywords"]);
  const form = botSettingsFromForm();
  // Tested as if the chatbot were on, so rules can be tried out before switching it on; the form is
  // read directly so an edit not yet saved is tested too.
  const config = SwasBot.buildConfig({ ...form, enabled: true }, botRules, unsubscribeKeywords);
  const action = SwasBot.matchMessage(message, config, {
    unsubscribed: el("test-unsubscribed").checked,
    inSession: el("test-in-session").checked,
  });
  const off = form.enabled ? "" : " (Chatbot is off - enable it above for real replies.)";

  if (!action) {
    el("test-label").textContent = `No reply - nothing matches, so the chat stays unread.${off}`;
    el("test-bubble").classList.add("hidden");
    return;
  }
  const effect = action.type === "unsubscribe" ? " - contact is added to Unsubscribers" : "";
  el("test-label").textContent = `Matched: ${action.label}${effect}.${off}`;
  el("test-bubble").innerHTML = formatWhatsApp(action.reply);
  el("test-bubble").classList.remove("hidden");
}

el("btn-test-reply").addEventListener("click", testBotReply);
el("test-message").addEventListener("keydown", (e) => {
  if (e.key === "Enter") testBotReply();
});
["test-unsubscribed", "test-in-session"].forEach((id) =>
  el(id).addEventListener("change", () => {
    if (el("test-message").value.trim()) testBotReply();
  })
);

// ---------- Quick replies ----------
async function renderQuickReplies() {
  const replies = await getList("quickReplies");
  el("quick-list").innerHTML = replies.length
    ? replies
        .map(
          (q) => `
      <div class="pick-row">
        <div><div class="pname">${esc(q.title)}</div><div class="ptext">${esc(q.text)}</div></div>
        <button type="button" data-remove-quick="${esc(q.id)}">Delete</button>
      </div>`
        )
        .join("")
    : '<div class="empty-note">No quick replies yet.</div>';
}

el("btn-add-quick").addEventListener("click", async () => {
  const title = el("quick-title").value.trim();
  const text = el("quick-text").value.trim();
  if (!title || !text) {
    el("quick-status").textContent = "Enter both a title and the reply text.";
    return;
  }
  const replies = await getList("quickReplies");
  replies.push({ id: crypto.randomUUID(), title, text });
  await setList("quickReplies", replies);
  el("quick-title").value = "";
  el("quick-text").value = "";
  el("quick-status").textContent = "";
});

el("quick-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-remove-quick]");
  if (btn) await setList("quickReplies", (await getList("quickReplies")).filter((q) => q.id !== btn.dataset.removeQuick));
});

// ---------- Unsubscribers ----------
async function renderUnsubscribers() {
  const list = await getList("unsubscribers");
  el("unsub-count").textContent = list.length;
  el("unsub-list").innerHTML = list.length
    ? list
        .map(
          (entry) =>
            `<div class="pick-row"><div class="pname">${esc(entry)}</div><button type="button" data-remove-unsub="${esc(entry)}">Remove</button></div>`
        )
        .join("")
    : '<div class="empty-note">Nobody has unsubscribed.</div>';
}

el("btn-add-unsub").addEventListener("click", async () => {
  const entries = el("unsub-input").value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!entries.length) return;
  const list = await getList("unsubscribers");
  const known = new Set(list.map((entry) => entry.toLowerCase()));
  entries.forEach((entry) => {
    if (known.has(entry.toLowerCase())) return;
    known.add(entry.toLowerCase());
    list.push(entry);
  });
  await setList("unsubscribers", list);
  el("unsub-input").value = "";
});

el("unsub-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-remove-unsub]");
  if (btn) {
    await setList("unsubscribers", (await getList("unsubscribers")).filter((entry) => entry !== btn.dataset.removeUnsub));
  }
});

// ---------- Live updates (background campaign progress, chatbot unsubscribes) ----------
const RENDERERS = {
  campaigns: renderCampaigns,
  unsubscribers: renderUnsubscribers,
  quickReplies: renderQuickReplies,
  botRules: renderBotRules,
  serverBot: renderBotEngine,
  attachmentPresets: renderPresets,
  recipientLists: renderSavedLists,
  syncedChats: loadSyncedChats, // a sync done in another dashboard tab shows up here too
  authToken: initAuth, // logging in or out from the popup
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  Object.keys(changes).forEach((key) => RENDERERS[key]?.());
});

el("support-link").href = SUPPORT_WA_LINK;
el("support-link").title = `Need help? WhatsApp ${SUPPORT_LABEL}`;

initAuth();
setInterval(initAuth, 15 * 60 * 1000); // lock a deactivated account without needing a reload
renderSelected();
renderTemplateSelect();
renderCampaigns();
renderBotRules();
renderQuickReplies();
renderUnsubscribers();
loadBotSettings();
renderBotEngine();
renderPresets();
loadSendOptions();
renderSavedLists();
