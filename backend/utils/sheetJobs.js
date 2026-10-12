/**
 * Sheet-driven per-row scheduler.
 *
 * Unlike the campaign engine (one shared message, one shared time, one shared attachment for the
 * whole list), this engine schedules EACH ROW on its own: every row carries its own message, its
 * own send date/time and its own attachment link. The seller fills a Google Sheet (or an Excel/CSV
 * file) and every row goes out at exactly the date & time written in it.
 *
 * Columns (header names are case-insensitive, extra columns are kept as {{placeholders}}):
 *   name        - recipient name (used for {{name}})
 *   mobile      - number with or without country code (aliases: number, phone, whatsapp)
 *   code        - optional country code, prefixed when the number looks local (aliases: country code)
 *   message     - the text to send (aliases: text, msg); {{name}} and {{any_column}} work
 *   date        - send date DD-MM-YYYY (aliases: send date) - India time
 *   time        - send time hh:mm AM/PM (aliases: send time) - India time
 *   attachment  - optional public file link: Google Drive share link or a direct file URL
 *                 (aliases: file, link, url, media, image, pdf)
 *
 * State lives in data/sheetjobs/<mobile>.json, so it survives a restart with no in-memory timers:
 * a single tick scans the files for rows that are due. Live Google Sheets are re-read periodically,
 * so new rows added to the sheet get picked up (and pending rows deleted from the sheet are dropped).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const wa = require("./waSessions");
const userStore = require("./userStore");
const { personalize } = require("./messaging");
const { writeJsonAtomic } = require("./atomicWrite");

const DIR = path.join(__dirname, "..", "data", "sheetjobs");
const TICK_MS = 15 * 1000; // how often we look for rows that are due
const SYNC_MS = 5 * 60 * 1000; // how often live Google Sheets are re-read
const SEND_GAP_MS = 6 * 1000; // minimum gap between two sends in the same tick (burst safety)
const MAX_PER_TICK = 20; // never fire more than this many in one tick
const MAX_ATTACH_BYTES = 45 * 1024 * 1024;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

let ticking = false;

// ---------- storage ----------
function file(mobile) {
  return path.join(DIR, `${String(mobile).replace(/\D/g, "")}.json`);
}
function loadAll(mobile) {
  try {
    return JSON.parse(fs.readFileSync(file(mobile), "utf8"));
  } catch {
    return [];
  }
}
function saveAll(mobile, batches) {
  writeJsonAtomic(file(mobile), batches);
}
function find(mobile, id) {
  return loadAll(mobile).find((b) => b.id === id) || null;
}
function update(mobile, id, mutator) {
  const batches = loadAll(mobile);
  const idx = batches.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  mutator(batches[idx]);
  saveAll(mobile, batches);
  return batches[idx];
}

/** Why this account can't send right now, or null if it can. Admin is always fine. */
function accessProblem(mobile) {
  if (mobile === process.env.ADMIN_MOBILE) return null;
  const user = userStore.get(mobile);
  if (!user?.active) return "Your account is not active. Please contact the seller.";
  if (user.expiresAt && Date.parse(user.expiresAt) <= Date.now()) {
    return `Your plan expired on ${new Date(user.expiresAt).toDateString()}. Please renew it with the seller.`;
  }
  return null;
}

// ---------- parsing ----------
/** Splits CSV text into rows of cells, honouring quoted fields with commas / newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  const s = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** CSV text -> array of { header: value } objects, using the first non-empty row as headers. */
function csvToObjects(text) {
  const rows = parseCsv(text).filter((r) => r.some((c) => String(c).trim() !== ""));
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h).trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = r[i] ?? ""; });
    return obj;
  });
}

const fieldKey = (h) => String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Reads one labelled value from a raw row by any of its accepted header names. */
function pick(entries, ...names) {
  for (const [k, v] of entries) if (names.includes(String(k).trim().toLowerCase())) return String(v ?? "").trim();
  return "";
}

/**
 * Parses an India-time date + time into a UTC millisecond timestamp.
 * date: DD-MM-YYYY or DD/MM/YYYY. time: "hh:mm AM/PM" or "HH:mm" (24h fallback).
 * Returns null when either part can't be understood.
 */
function parseWhen(dateStr, timeStr) {
  const d = String(dateStr).trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (!d) return null;
  let [, day, month, year] = d.map(Number);
  if (year < 100) year += 2000;

  const t = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})\s*([aApP][mM])?$/);
  if (!t) return null;
  let hour = Number(t[1]);
  const min = Number(t[2]);
  const ampm = (t[3] || "").toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || min > 59 || month < 1 || month > 12 || day < 1 || day > 31) return null;

  return Date.UTC(year, month - 1, day, hour, min) - IST_OFFSET_MS;
}

/** Maps raw sheet/Excel rows into schedulable rows. Invalid rows are kept with a reason so the UI can show them. */
function mapRows(rawRows) {
  return (rawRows || []).map((raw) => {
    const entries = Object.entries(raw);
    const num = pick(entries, "mobile number", "mobile", "number", "phone", "whatsapp").replace(/\D/g, "");
    const cc = pick(entries, "country code", "code", "cc").replace(/\D/g, "");
    const mobile = cc && num.length <= 10 && !num.startsWith(cc) ? cc + num : num;
    const name = pick(entries, "name");
    const message = pick(entries, "message", "text", "msg");
    const attachmentUrl = pick(entries, "attachment", "file", "link", "url", "media", "image", "pdf");
    const rawDate = pick(entries, "date", "send date", "send_date");
    const rawTime = pick(entries, "time", "send time", "send_time");
    const sendAt = parseWhen(rawDate, rawTime);

    const fields = {};
    for (const [k, v] of entries) { const fk = fieldKey(k); if (fk) fields[fk] = String(v ?? "").trim(); }

    let invalidReason = null;
    if (!mobile || mobile.length < 7) invalidReason = "No valid mobile number";
    else if (!message && !attachmentUrl) invalidReason = "No message or attachment";
    else if (sendAt === null) invalidReason = "Date/time not understood (use DD-MM-YYYY and hh:mm AM/PM)";

    return {
      key: `${mobile}|${rawDate}|${rawTime}|${message}`,
      name, mobile, message, attachmentUrl, rawDate, rawTime, sendAt, fields,
      status: invalidReason ? "invalid" : "pending",
      invalidReason,
    };
  });
}

// ---------- attachments ----------
/** Rewrites a Google Drive share link into a direct-download URL; other URLs pass through. */
function directDownloadUrl(url) {
  const m = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([a-zA-Z0-9_-]+)/);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  return url;
}

function filenameFrom(url, disposition) {
  const d = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition || "");
  if (d) return decodeURIComponent(d[1]);
  try {
    const name = path.basename(new URL(url).pathname);
    if (name && name.includes(".")) return name;
  } catch { /* not a parseable URL */ }
  return "file";
}

/** Downloads a public file URL into an attachment { dataUrl, name, mimeType } the sender understands. */
async function downloadAttachment(url) {
  const r = await fetch(directDownloadUrl(url), { redirect: "follow" });
  if (!r.ok) throw new Error(`attachment download failed (${r.status})`);
  const type = (r.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_ATTACH_BYTES) throw new Error("attachment is larger than 45 MB");
  // A Drive link that still returns the HTML virus-scan page, not the file.
  if (type.startsWith("text/html") && /drive\.google\.com/.test(url)) {
    throw new Error("Drive link needs 'Anyone with the link'; large files aren't supported");
  }
  return {
    dataUrl: `data:${type};base64,${buf.toString("base64")}`,
    name: filenameFrom(url, r.headers.get("content-disposition")),
    mimeType: type,
  };
}

// ---------- sending ----------
/** Sends one row and records the outcome on the batch. */
async function sendRow(mobile, batchId, rowKey) {
  const batch = find(mobile, batchId);
  const row = batch?.rows.find((x) => x.key === rowKey);
  if (!row || row.status !== "pending") return;

  const message = personalize(row.message, { name: row.name, fields: row.fields });
  let attachment = null;
  try {
    if (row.attachmentUrl) attachment = { ...(await downloadAttachment(row.attachmentUrl)), caption: message || undefined };
  } catch (err) {
    update(mobile, batchId, (b) => {
      const t = b.rows.find((x) => x.key === rowKey);
      if (t && t.status === "pending") { t.status = "failed"; t.failReason = err.message || String(err); t.sentAt = Date.now(); }
    });
    return;
  }

  const target = { type: "number", phone: row.mobile };
  try {
    await wa.send(mobile, { target, message, attachment });
    update(mobile, batchId, (b) => {
      const t = b.rows.find((x) => x.key === rowKey);
      if (t) { t.status = "sent"; t.sentAt = Date.now(); t.failReason = undefined; }
    });
  } catch (err) {
    // A drop mid-send leaves the row pending so the next tick retries it.
    if (wa.status(mobile).state !== "open") return;
    update(mobile, batchId, (b) => {
      const t = b.rows.find((x) => x.key === rowKey);
      if (t) { t.status = "failed"; t.failReason = err.message || String(err); t.sentAt = Date.now(); }
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One scheduler pass: find every row that is due across all accounts and send them, gently paced. */
async function tick() {
  if (ticking || !fs.existsSync(DIR)) return;
  ticking = true;
  try {
    const now = Date.now();
    const due = [];
    for (const name of fs.readdirSync(DIR)) {
      if (!name.endsWith(".json")) continue;
      const mobile = name.replace(/\.json$/, "");
      for (const b of loadAll(mobile)) {
        if (b.status === "cancelled") continue;
        for (const row of b.rows) {
          if (row.status === "pending" && row.sendAt !== null && row.sendAt <= now) {
            due.push({ mobile, batchId: b.id, rowKey: row.key, sendAt: row.sendAt });
          }
        }
      }
    }
    if (!due.length) return;
    due.sort((a, b) => a.sendAt - b.sendAt);

    const openCache = new Map();
    const isOpen = (m) => {
      if (!openCache.has(m)) openCache.set(m, wa.status(m).state === "open" && !accessProblem(m));
      return openCache.get(m);
    };

    let fired = 0;
    for (const job of due) {
      if (fired >= MAX_PER_TICK) break;
      if (!isOpen(job.mobile)) continue; // not linked / inactive: leave pending, retry next tick
      if (fired > 0) await sleep(SEND_GAP_MS);
      await sendRow(job.mobile, job.batchId, job.rowKey);
      fired++;
    }
  } catch (err) {
    console.warn("[sheetJobs tick]", err.message || err);
  } finally {
    ticking = false;
  }
}

// ---------- live Google Sheet sync ----------
/** Re-reads a published Google Sheet as CSV. */
async function fetchSheetRows(url) {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) throw new Error("That doesn't look like a Google Sheets link.");
  const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1] || "0";
  const csvUrl = `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
  const r = await fetch(csvUrl, { redirect: "follow" });
  const csv = await r.text();
  if (!r.ok || csv.trim().startsWith("<")) {
    throw new Error("Couldn't read the sheet. Share it: Anyone with the link → Viewer.");
  }
  return mapRows(csvToObjects(csv));
}

/**
 * Merges a fresh read of the sheet into a batch: adds genuinely new rows, drops pending rows that
 * were removed from the sheet, and keeps already sent/failed rows as history (never resent).
 */
function mergeRows(existing, fresh) {
  const freshByKey = new Map(fresh.map((r) => [r.key, r]));
  const seen = new Set();
  const kept = [];
  for (const row of existing) {
    if (row.status === "pending" || row.status === "invalid") {
      if (freshByKey.has(row.key)) { kept.push(row); seen.add(row.key); } // still in the sheet
      // else: removed from the sheet -> drop it
    } else {
      kept.push(row); // sent / failed stay as history
      seen.add(row.key);
    }
  }
  for (const row of fresh) if (!seen.has(row.key)) kept.push(row);
  return kept;
}

async function resync(mobile, id) {
  const batch = find(mobile, id);
  if (!batch || batch.source !== "sheet" || !batch.sheetUrl) return batch;
  const fresh = await fetchSheetRows(batch.sheetUrl);
  return update(mobile, id, (b) => { b.rows = mergeRows(b.rows, fresh); b.lastSyncedAt = Date.now(); });
}

async function syncAll() {
  if (!fs.existsSync(DIR)) return;
  for (const name of fs.readdirSync(DIR)) {
    if (!name.endsWith(".json")) continue;
    const mobile = name.replace(/\.json$/, "");
    for (const b of loadAll(mobile)) {
      if (b.source === "sheet" && b.syncEnabled && b.status !== "cancelled") {
        try { await resync(mobile, b.id); } catch (err) { console.warn(`[sheetJobs sync ${mobile}/${b.id}]`, err.message || err); }
      }
    }
  }
}

// ---------- public API ----------
function summarize(batch) {
  const counts = { pending: 0, sent: 0, failed: 0, invalid: 0 };
  for (const r of batch.rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const next = batch.rows
    .filter((r) => r.status === "pending" && r.sendAt !== null)
    .reduce((min, r) => (min === null || r.sendAt < min ? r.sendAt : min), null);
  return {
    id: batch.id, name: batch.name, source: batch.source, sheetUrl: batch.sheetUrl || null,
    syncEnabled: !!batch.syncEnabled, status: batch.status, createdAt: batch.createdAt,
    lastSyncedAt: batch.lastSyncedAt || null, total: batch.rows.length, counts, nextSendAt: next,
    rows: batch.rows.map((r) => ({
      name: r.name, mobile: r.mobile, message: r.message, attachmentUrl: r.attachmentUrl,
      rawDate: r.rawDate, rawTime: r.rawTime, sendAt: r.sendAt, status: r.status,
      failReason: r.failReason || r.invalidReason || null, sentAt: r.sentAt || null,
    })),
  };
}

function list(mobile) {
  return loadAll(mobile).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(summarize);
}

function get(mobile, id) {
  const b = find(mobile, id);
  return b ? summarize(b) : null;
}

/**
 * Creates a scheduled batch.
 * input (sheet):  { mode:"sheet", name, url, autoSync }
 * input (upload): { mode:"upload", name, rows:[ rawRowObjects ] }
 */
async function create(mobile, input = {}) {
  let rows, source, sheetUrl = null, syncEnabled = false;
  if (input.mode === "sheet") {
    sheetUrl = String(input.url || "").trim();
    rows = await fetchSheetRows(sheetUrl);
    source = "sheet";
    syncEnabled = input.autoSync !== false;
  } else {
    rows = mapRows(Array.isArray(input.rows) ? input.rows : []);
    source = "upload";
  }
  if (!rows.length) throw Object.assign(new Error("No rows found. Check the columns: name, mobile, message, date, time."), { status: 400 });
  if (!rows.some((r) => r.status === "pending")) {
    const why = rows[0]?.invalidReason ? ` (${rows[0].invalidReason})` : "";
    throw Object.assign(new Error(`No valid rows to schedule${why}.`), { status: 400 });
  }

  const batch = {
    id: crypto.randomUUID(),
    name: String(input.name || "").trim() || `Sheet ${new Date().toLocaleString()}`,
    source, sheetUrl, syncEnabled,
    status: "active",
    createdAt: Date.now(),
    lastSyncedAt: source === "sheet" ? Date.now() : null,
    rows,
  };
  saveAll(mobile, [batch, ...loadAll(mobile)]);
  tick().catch(() => {}); // fire any rows already due
  return summarize(batch);
}

function cancel(mobile, id) {
  // Cancelling stops pending rows; sent history is kept.
  const b = update(mobile, id, (batch) => {
    batch.status = "cancelled";
    batch.syncEnabled = false;
    for (const r of batch.rows) if (r.status === "pending") { r.status = "invalid"; r.invalidReason = "Cancelled"; }
  });
  return b ? summarize(b) : null;
}

function remove(mobile, id) {
  const batches = loadAll(mobile);
  if (!batches.some((b) => b.id === id)) return false;
  saveAll(mobile, batches.filter((b) => b.id !== id));
  return true;
}

function start() {
  fs.mkdirSync(DIR, { recursive: true });
  setInterval(() => tick().catch(() => {}), TICK_MS);
  setInterval(() => syncAll().catch(() => {}), SYNC_MS);
  tick().catch(() => {});
}

module.exports = { list, get, create, cancel, remove, resync, start };
