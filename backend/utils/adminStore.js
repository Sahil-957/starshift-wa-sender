const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("./atomicWrite");

// admin.json: { passwordHash, passwordChangedAt } - set when the admin resets their password by WhatsApp OTP.
// While it holds a hash, that hash replaces ADMIN_PASSWORD from .env.
const FILE = path.join(__dirname, "..", "data", "admin.json");

function get() {
  if (!fs.existsSync(FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function update(changes) {
  const next = { ...get(), ...changes };
  writeJsonAtomic(FILE, next, { pretty: true });
  return next;
}

module.exports = { get, update };
