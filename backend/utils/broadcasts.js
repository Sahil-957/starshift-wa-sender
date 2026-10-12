/**
 * Auto Broadcast engine.
 *
 * A broadcast sends ONE "current" file (plus an optional caption) to a saved recipient list, over
 * and over on a recurring schedule: several times a day (e.g. 10:00, 12:00, 14:00) on a daily /
 * weekly / monthly / yearly cadence. Only the latest file is kept - uploading a new one replaces
 * (and deletes) the old, so the seller just drops in today's image and the schedule keeps firing it.
 *
 * All times are India time (IST). State lives in data/broadcasts/<mobile>.json and the media in
 * data/broadcasts/media/<mobile>-<id>.json, so a restart loses nothing: a single polling tick
 * recomputes what is due, with no in-memory timers.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const wa = require("./waSessions");
const lists = require("./lists");
const userStore = require("./userStore");
const { personalize } = require("./messaging");
const { writeJsonAtomic } = require("./atomicWrite");

const DIR = path.join(__dirname, "..", "data", "broadcasts");
const MEDIA_DIR = path.join(DIR, "media");
const TICK_MS = 30 * 1000;
const SEND_GAP_MS = 7 * 1000; // gap between two recipients in one run (burst safety)
const RUN_HISTORY = 20;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const FREQUENCIES = ["daily", "weekly", "monthly", "yearly"];

let ticking = false;

// ---------- storage ----------
function file(mobile) {
  return path.join(DIR, `${String(mobile).replace(/\D/g, "")}.json`);
}
function loadAll(mobile) {
  try { return JSON.parse(fs.readFileSync(file(mobile), "utf8")); } catch { return []; }
}
function saveAll(mobile, items) { writeJsonAtomic(file(mobile), items); }
function find(mobile, id) { return loadAll(mobile).find((b) => b.id === id) || null; }
function update(mobile, id, mutator) {
  const items = loadAll(mobile);
  const idx = items.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  mutator(items[idx]);
  saveAll(mobile, items);
  return items[idx];
}

function mediaFile(mobile, id) {
  return path.join(MEDIA_DIR, `${String(mobile).replace(/\D/g, "")}-${id}.json`);
}
function saveMedia(mobile, id, media) { writeJsonAtomic(mediaFile(mobile, id), media); }
function loadMedia(mobile, id) {
  try { return JSON.parse(fs.readFileSync(mediaFile(mobile, id), "utf8")); } catch { return null; }
}
function deleteMedia(mobile, id) {
  try { fs.unlinkSync(mediaFile(mobile, id)); } catch { /* already gone */ }
}

function accessProblem(mobile) {
  if (mobile === process.env.ADMIN_MOBILE) return null;
  const user = userStore.get(mobile);
  if (!user?.active) return "Your account is not active. Please contact the seller.";
  if (user.expiresAt && Date.parse(user.expiresAt) <= Date.now()) {
    return `Your plan expired on ${new Date(user.expiresAt).toDateString()}. Please renew it with the seller.`;
  }
  return null;
}

// ---------- time helpers (all IST) ----------
/** "HH:MM", "H:MM AM/PM" or a bare hour "14" -> minutes since midnight, or null. */
function parseTimeToMinutes(value) {
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*([aApP][mM])?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const min = Number(m[2] || 0);
  const ampm = (m[3] || "").toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || min > 59) return null;
  return hour * 60 + min;
}
const minutesToHHMM = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

/** A Date whose UTC fields read as the IST wall-clock for `ms`. */
function istDate(ms) { return new Date(ms + IST_OFFSET_MS); }
/** IST year/month/day/hour/min -> real UTC milliseconds. */
function istToUtc(y, mon, d, hh, mm) { return Date.UTC(y, mon, d, hh, mm) - IST_OFFSET_MS; }
function daysInMonth(y, mon) { return new Date(Date.UTC(y, mon + 1, 0)).getUTCDate(); }

/** The next scheduled slot strictly after `afterMs`, or null if none within a year. */
function computeNextRun(b, afterMs) {
  const times = (b.times || []).slice().sort((a, c) => a - c);
  if (!times.length) return null;
  const anchor = istDate(b.anchorDate || b.createdAt || Date.now());
  const aWeekday = anchor.getUTCDay();
  const aDom = anchor.getUTCDate();
  const aMonth = anchor.getUTCMonth();

  const cur = istDate(afterMs);
  cur.setUTCHours(0, 0, 0, 0); // midnight IST of the "after" day
  for (let off = 0; off <= 366; off++) {
    const y = cur.getUTCFullYear(), mon = cur.getUTCMonth(), d = cur.getUTCDate();
    let match = false;
    if (b.frequency === "daily") match = true;
    else if (b.frequency === "weekly") match = cur.getUTCDay() === aWeekday;
    else if (b.frequency === "monthly") match = d === Math.min(aDom, daysInMonth(y, mon));
    else if (b.frequency === "yearly") match = mon === aMonth && d === Math.min(aDom, daysInMonth(y, mon));
    if (match) {
      for (const mins of times) {
        const slot = istToUtc(y, mon, d, Math.floor(mins / 60), mins % 60);
        if (slot > afterMs) return slot;
      }
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return null;
}

// ---------- sending ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function recipientsFor(mobile, listId) {
  const l = lists.list(mobile).find((x) => x.id === listId);
  return l ? { name: l.name, recipients: l.recipients || [] } : null;
}

/** Sends the current file/caption to every recipient of the broadcast's list. Returns { sent, failed }. */
async function runBroadcast(mobile, id) {
  const b = find(mobile, id);
  if (!b) return { sent: 0, failed: 0 };
  const picked = recipientsFor(mobile, b.listId);
  if (!picked || !picked.recipients.length) return { sent: 0, failed: 0, error: "List is empty or missing." };

  const media = b.file ? loadMedia(mobile, id) : null;
  let sent = 0, failed = 0;
  for (let i = 0; i < picked.recipients.length; i++) {
    if (wa.status(mobile).state !== "open") break; // lost connection mid-run: stop, next tick retries the slot
    const r = picked.recipients[i];
    const caption = personalize(b.caption || "", { name: r.name, custom1: r.custom1, custom2: r.custom2, fields: r.fields });
    const attachment = media ? { ...media, caption: caption || undefined } : null;
    const message = caption; // ignored when an attachment is present; the text body when it isn't
    const target =
      r.source === "group" ? { type: "group", name: r.name }
      : r.source === "contact" ? { type: "contact", name: r.name }
      : { type: "number", phone: r.mobile };
    try {
      await wa.send(mobile, { target, message: message || undefined, attachment });
      sent++;
    } catch {
      failed++;
    }
    if (i < picked.recipients.length - 1) await sleep(SEND_GAP_MS);
  }
  return { sent, failed };
}

/** One scheduler pass: run every active broadcast whose next slot is due. */
async function tick() {
  if (ticking || !fs.existsSync(DIR)) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(DIR)) {
      if (!name.endsWith(".json")) continue;
      const mobile = name.replace(/\.json$/, "");
      for (const b of loadAll(mobile)) {
        if (!b.active) continue;
        // Make sure a next slot is known.
        if (!b.nextRunAt) {
          const next = computeNextRun(b, now);
          update(mobile, b.id, (x) => (x.nextRunAt = next));
          continue;
        }
        if (b.nextRunAt > now) continue;
        if (wa.status(mobile).state !== "open" || accessProblem(mobile)) continue; // retry next tick, no backlog
        if (!b.file && !String(b.caption || "").trim()) continue; // nothing to send yet

        const result = await runBroadcast(mobile, b.id);
        const afterRun = computeNextRun(b, Date.now());
        update(mobile, b.id, (x) => {
          x.lastRunAt = Date.now();
          x.nextRunAt = afterRun;
          x.runs = [{ at: Date.now(), ...result }, ...(x.runs || [])].slice(0, RUN_HISTORY);
        });
      }
    }
  } catch (err) {
    console.warn("[broadcasts tick]", err.message || err);
  } finally {
    ticking = false;
  }
}

// ---------- input helpers ----------
function normalizeTimes(raw) {
  const arr = Array.isArray(raw) ? raw : String(raw || "").split(/[,\n]/);
  const mins = arr.map(parseTimeToMinutes).filter((m) => m !== null);
  return [...new Set(mins)].sort((a, b) => a - b);
}

// ---------- public API ----------
function publicView(mobile, b) {
  const l = lists.list(mobile).find((x) => x.id === b.listId);
  return {
    id: b.id, name: b.name, listId: b.listId, listName: l ? l.name : "(deleted list)",
    recipientCount: l ? (l.recipients || []).length : 0,
    caption: b.caption || "", times: (b.times || []).map(minutesToHHMM), frequency: b.frequency,
    active: !!b.active, file: b.file || null, createdAt: b.createdAt,
    lastRunAt: b.lastRunAt || null, nextRunAt: b.nextRunAt || null, runs: (b.runs || []).slice(0, 5),
  };
}

function list(mobile) {
  return loadAll(mobile).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((b) => publicView(mobile, b));
}
function get(mobile, id) {
  const b = find(mobile, id);
  return b ? publicView(mobile, b) : null;
}

/** input: { name, listId, caption, times, frequency, file?, active? } */
function create(mobile, input = {}) {
  const times = normalizeTimes(input.times);
  if (!times.length) throw Object.assign(new Error("Add at least one send time (e.g. 10:00, 14:00)."), { status: 400 });
  if (!FREQUENCIES.includes(input.frequency)) throw Object.assign(new Error("Choose daily, weekly, monthly or yearly."), { status: 400 });
  if (!recipientsFor(mobile, input.listId)) throw Object.assign(new Error("Pick a saved list for the recipients."), { status: 400 });
  const hasFile = !!(input.file && input.file.dataUrl);
  if (!hasFile && !String(input.caption || "").trim()) {
    throw Object.assign(new Error("Add a file or a caption to send."), { status: 400 });
  }

  const id = crypto.randomUUID();
  if (hasFile) saveMedia(mobile, id, { dataUrl: input.file.dataUrl, name: input.file.name || "file", mimeType: input.file.mimeType || "application/octet-stream" });

  const now = Date.now();
  const b = {
    id,
    name: String(input.name || "").trim() || "Auto Broadcast",
    listId: input.listId,
    caption: String(input.caption || ""),
    times, frequency: input.frequency,
    active: input.active !== false,
    file: hasFile ? { name: input.file.name || "file", mimeType: input.file.mimeType || "application/octet-stream", updatedAt: now } : null,
    createdAt: now, anchorDate: now,
    lastRunAt: null, runs: [],
    nextRunAt: null,
  };
  b.nextRunAt = computeNextRun(b, now);
  saveAll(mobile, [b, ...loadAll(mobile)]);
  return publicView(mobile, b);
}

/** Patch name/listId/caption/times/frequency/active; recomputes the next slot. */
function edit(mobile, id, changes = {}) {
  const b = update(mobile, id, (x) => {
    if (typeof changes.name === "string") x.name = changes.name.trim() || x.name;
    if (changes.listId && recipientsFor(mobile, changes.listId)) x.listId = changes.listId;
    if (typeof changes.caption === "string") x.caption = changes.caption;
    if (changes.times !== undefined) { const t = normalizeTimes(changes.times); if (t.length) x.times = t; }
    if (FREQUENCIES.includes(changes.frequency)) x.frequency = changes.frequency;
    if (typeof changes.active === "boolean") x.active = changes.active;
    x.nextRunAt = computeNextRun(x, Date.now());
  });
  return b ? publicView(mobile, b) : null;
}

/** Replaces the current file - the old one is deleted (only the latest is ever kept). */
function setFile(mobile, id, fileInput) {
  if (!find(mobile, id)) return null;
  if (!fileInput || !fileInput.dataUrl) throw Object.assign(new Error("No file received."), { status: 400 });
  saveMedia(mobile, id, { dataUrl: fileInput.dataUrl, name: fileInput.name || "file", mimeType: fileInput.mimeType || "application/octet-stream" });
  const b = update(mobile, id, (x) => {
    x.file = { name: fileInput.name || "file", mimeType: fileInput.mimeType || "application/octet-stream", updatedAt: Date.now() };
  });
  return publicView(mobile, b);
}

async function runNow(mobile, id) {
  const b = find(mobile, id);
  if (!b) return null;
  if (wa.status(mobile).state !== "open") throw Object.assign(new Error("Link the server WhatsApp first."), { status: 400 });
  const problem = accessProblem(mobile);
  if (problem) throw Object.assign(new Error(problem), { status: 403 });
  const result = await runBroadcast(mobile, id);
  update(mobile, id, (x) => {
    x.lastRunAt = Date.now();
    x.runs = [{ at: Date.now(), manual: true, ...result }, ...(x.runs || [])].slice(0, RUN_HISTORY);
  });
  return { ...result };
}

function remove(mobile, id) {
  const items = loadAll(mobile);
  if (!items.some((b) => b.id === id)) return false;
  saveAll(mobile, items.filter((b) => b.id !== id));
  deleteMedia(mobile, id);
  return true;
}

function start() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  setInterval(() => tick().catch(() => {}), TICK_MS);
  tick().catch(() => {});
}

module.exports = { list, get, create, edit, setFile, runNow, remove, start };
