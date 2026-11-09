/**
 * Per-account data sheet for the chatbot's "my details" lookup.
 *
 * The seller attaches an Excel/CSV (or Google Sheet) keyed by mobile number - e.g. a loan ledger with
 * columns like Name, Loan Amount, Interest, Total Outstanding. When a customer whose number is in the
 * sheet sends the lookup keyword (e.g. "1"), the bot replies with THAT customer's own row. Numbers not
 * in the sheet get the "not registered" message.
 *
 * Stored at data/bots/<mobile>-data.json as { headers, rows: { <last10digits>: {col:val} }, mobileHeader }.
 */
const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("./atomicWrite");

const DIR = path.join(__dirname, "..", "data", "bots");
const MOBILE_ALIASES = ["mobile number", "mobile no", "mobile", "number", "phone", "whatsapp", "contact"];

function file(mobile) {
  return path.join(DIR, `${String(mobile).replace(/\D/g, "")}-data.json`);
}

/** Last 10 digits - so 917588258599 and 7588258599 match the same customer. */
function key10(value) {
  const d = String(value || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}

function load(mobile) {
  try {
    return JSON.parse(fs.readFileSync(file(mobile), "utf8"));
  } catch {
    return null;
  }
}

/** Builds the keyed store from raw sheet rows ([{Header: value}]). Returns a summary. */
function setFromRows(mobile, rawRows) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  if (!rows.length) throw Object.assign(new Error("The sheet has no rows."), { status: 400 });

  // Find the mobile column from the first row's headers.
  const headers = Object.keys(rows[0]);
  const mobileHeader = headers.find((h) => MOBILE_ALIASES.includes(String(h).trim().toLowerCase()));
  if (!mobileHeader) {
    throw Object.assign(new Error("No mobile column found. Add a column named Mobile (or Number/Phone)."), { status: 400 });
  }
  const dataHeaders = headers.filter((h) => h !== mobileHeader && String(h).trim() !== "");

  const keyed = {};
  let count = 0;
  for (const row of rows) {
    const k = key10(row[mobileHeader]);
    if (k.length < 10) continue;
    const entry = {};
    for (const h of dataHeaders) entry[h] = String(row[h] ?? "").trim();
    keyed[k] = entry;
    count++;
  }
  if (!count) throw Object.assign(new Error("No valid 10-digit mobile numbers in the sheet."), { status: 400 });

  const store = { headers: dataHeaders, mobileHeader, rows: keyed, count, updatedAt: Date.now() };
  writeJsonAtomic(file(mobile), store);
  return summary(mobile, store);
}

function summary(mobile, store = load(mobile)) {
  if (!store) return { loaded: false, count: 0, headers: [], updatedAt: null };
  return { loaded: true, count: store.count || 0, headers: store.headers || [], updatedAt: store.updatedAt || null };
}

function clear(mobile) {
  try { fs.unlinkSync(file(mobile)); } catch { /* already gone */ }
  return { loaded: false, count: 0, headers: [] };
}

/** The reply for a sender, or null if their number isn't in the sheet. Auto-formats every column. */
function lookupReply(mobile, senderNumber) {
  const store = load(mobile);
  if (!store) return null;
  const row = store.rows[key10(senderNumber)];
  if (!row) return null;
  const lines = store.headers
    .map((h) => [h, row[h]])
    .filter(([, v]) => String(v || "").trim() !== "")
    .map(([h, v]) => `${h}: ${v}`);
  return lines.join("\n");
}

// ---- Bot 5: its own sheet. Keeps EVERY row of a number (a customer can have several rows). ----
function bot5File(mobile) {
  return path.join(DIR, `${String(mobile).replace(/\D/g, "")}-bot5-data.json`);
}
function bot5Load(mobile) {
  try { return JSON.parse(fs.readFileSync(bot5File(mobile), "utf8")); } catch { return null; }
}
function bot5SetFromRows(mobile, rawRows) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  if (!rows.length) throw Object.assign(new Error("The sheet has no rows."), { status: 400 });
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
  const mobileHeader = headers.find((h) => MOBILE_ALIASES.includes(String(h).trim().toLowerCase()))
    || headers.find((h) => /mobile|phone|whats\s*app|contact\s*no|number/i.test(String(h)));
  if (!mobileHeader) throw Object.assign(new Error("No mobile column found. Add a column named Mobile (or Number/Phone/WhatsApp)."), { status: 400 });
  const dataHeaders = headers.filter((h) => String(h).trim() !== "" && !/^__EMPTY/.test(h));
  const keyed = {};
  let count = 0;
  for (const row of rows) {
    const k = key10(row[mobileHeader]);
    if (k.length < 10) continue;
    const entry = {};
    for (const h of dataHeaders) entry[h] = String(row[h] ?? "").trim();
    (keyed[k] || (keyed[k] = [])).push(entry);
    count++;
  }
  if (!count) throw Object.assign(new Error("No valid 10-digit mobile numbers in the sheet."), { status: 400 });
  const store = { headers: dataHeaders, mobileHeader, rows: keyed, count, customers: Object.keys(keyed).length, updatedAt: Date.now() };
  writeJsonAtomic(bot5File(mobile), store);
  return bot5Summary(mobile, store);
}
function bot5Summary(mobile, store = bot5Load(mobile)) {
  if (!store) return { loaded: false, count: 0, customers: 0, headers: [], mobileHeader: "", updatedAt: null };
  return { loaded: true, count: store.count || 0, customers: store.customers || Object.keys(store.rows || {}).length, headers: store.headers || [], mobileHeader: store.mobileHeader || "", updatedAt: store.updatedAt || null };
}
function bot5Clear(mobile) {
  try { fs.unlinkSync(bot5File(mobile)); } catch { /* already gone */ }
  return bot5Summary(mobile, null);
}
/** Every sheet row for this WhatsApp number (matched on the last 10 digits), or null. */
function bot5Rows(mobile, senderNumber) {
  const store = bot5Load(mobile);
  const rows = store?.rows?.[key10(senderNumber)];
  return rows?.length ? { headers: store.headers || [], rows } : null;
}

module.exports = { setFromRows, summary, clear, lookupReply, bot5SetFromRows, bot5Summary, bot5Clear, bot5Rows };
