/**
 * Saved compose drafts, one file per account (data/drafts/<mobile>.json).
 * A draft is the whole compose form the seller filled in (name, message, caption, footer,
 * pacing and schedule, plus any attachment inline) so it can be reloaded and reused later.
 * Recipients are not part of a draft - those have their own saved lists (utils/lists.js).
 * Capped at MAX_DRAFTS per account; saving over an existing name overwrites it.
 */
const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("./atomicWrite");

const DIR = path.join(__dirname, "..", "data", "drafts");
const MAX_DRAFTS = 5;

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

function save(mobile, drafts) {
  writeJsonAtomic(file(mobile), drafts);
}

function list(mobile) {
  return load(mobile);
}

function create(mobile, name, form) {
  const n = String(name || "").trim();
  if (!n) throw Object.assign(new Error("Give the draft a name."), { status: 400 });
  if (!form || typeof form !== "object") throw Object.assign(new Error("Nothing to save in this draft."), { status: 400 });

  const drafts = load(mobile);
  const existing = drafts.find((d) => d.name.toLowerCase() === n.toLowerCase());
  if (existing) {
    existing.form = form; // overwrite a draft of the same name
    existing.savedAt = Date.now();
  } else {
    if (drafts.length >= MAX_DRAFTS) {
      throw Object.assign(new Error(`You can save up to ${MAX_DRAFTS} drafts. Delete one first.`), { status: 400 });
    }
    drafts.unshift({ id: crypto.randomUUID(), name: n, savedAt: Date.now(), form });
  }
  save(mobile, drafts);
  return drafts;
}

function remove(mobile, id) {
  const drafts = load(mobile).filter((d) => d.id !== id);
  save(mobile, drafts);
  return drafts;
}

module.exports = { list, create, remove, MAX_DRAFTS };
