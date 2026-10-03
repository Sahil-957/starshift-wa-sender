const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("./atomicWrite");

const FILE = path.join(__dirname, "..", "data", "users.json");

// users.json: { "<mobile with country code>": { mobile, name, active, passwordHash, passwordChangedAt, createdAt, lastLoginAt } }
function load() {
  if (!fs.existsSync(FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(users) {
  writeJsonAtomic(FILE, users, { pretty: true });
}

function get(mobile) {
  return load()[mobile] || null;
}

function list() {
  return Object.values(load()).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

/** Creates or updates a customer and returns the saved record. New customers start inactive. */
function upsert(mobile, changes) {
  const users = load();
  users[mobile] = { mobile, active: false, createdAt: new Date().toISOString(), ...users[mobile], ...changes };
  save(users);
  return users[mobile];
}

function remove(mobile) {
  const users = load();
  if (!users[mobile]) return false;
  delete users[mobile];
  save(users);
  return true;
}

module.exports = { get, list, upsert, remove };
