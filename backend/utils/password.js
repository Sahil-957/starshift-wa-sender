const crypto = require("crypto");

// No 0/O or 1/l/I, so a password read out over the phone isn't mistyped.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function generatePassword(length = 10) {
  return Array.from({ length }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
}

/** Stored as "salt:hash" so the plain password never touches disk. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const expected = Buffer.from(hash, "hex");
  return crypto.timingSafeEqual(expected, crypto.scryptSync(String(password), salt, expected.length));
}

/** Constant-time check of the admin password kept in .env. */
function matchesPlain(password, expected) {
  const digest = (value) => crypto.createHash("sha256").update(String(value)).digest();
  return crypto.timingSafeEqual(digest(password), digest(expected));
}

module.exports = { generatePassword, hashPassword, verifyPassword, matchesPlain };
