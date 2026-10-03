/**
 * Saved recipient lists, one file per account (data/lists/<mobile>.json).
 * A list is { id, name, recipients: [{ source, name, mobile }] } - the same recipient shape a campaign uses.
 */
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "data", "lists");

function file(mobile) {
  return path.join(DIR, `${String(mobile).replace(/\D/g, "")}.json`);
}

function load(mobile) {
  try {
    return JSON.parse(fs.readFileSync(file(mobile), "utf8"));
  } catch {
    return [];
  }
}

function save(mobile, lists) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(mobile), JSON.stringify(lists));
}

function cleanRecipients(recipients) {
  return (recipients || [])
    .map((r) => ({
      source: ["contact", "group", "number"].includes(r.source) ? r.source : "number",
      name: String(r.name || "").trim(),
      mobile: String(r.mobile || "").replace(/\D/g, ""),
      custom1: r.custom1 || "",
      custom2: r.custom2 || "",
    }))
    .filter((r) => (r.source === "number" ? r.mobile.length >= 7 : !!r.name));
}

function list(mobile) {
  return load(mobile);
}

function create(mobile, name, recipients) {
  const clean = cleanRecipients(recipients);
  if (!String(name || "").trim()) throw Object.assign(new Error("Give the list a name."), { status: 400 });
  if (!clean.length) throw Object.assign(new Error("Add at least one recipient to the list."), { status: 400 });
  const lists = load(mobile);
  const existing = lists.find((l) => l.name.toLowerCase() === name.trim().toLowerCase());
  if (existing) {
    existing.recipients = clean; // overwrite a list of the same name
  } else {
    lists.unshift({ id: crypto.randomUUID(), name: name.trim(), recipients: clean });
  }
  save(mobile, lists);
  return lists;
}

function remove(mobile, id) {
  const lists = load(mobile).filter((l) => l.id !== id);
  save(mobile, lists);
  return lists;
}

module.exports = { list, create, remove };
