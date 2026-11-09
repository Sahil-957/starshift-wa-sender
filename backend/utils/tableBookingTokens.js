const crypto = require("crypto");

const issued = new Map();

function issue(mobile, branchId, distanceMeters) {
  const token = crypto.randomBytes(12).toString("hex");
  issued.set(token, { mobile: String(mobile), branchId: String(branchId), distanceMeters: Math.round(distanceMeters), expiresAt: Date.now() + 5 * 60 * 1000 });
  return token;
}

function consume(token, mobile, branchId) {
  const key = String(token || "");
  const stored = issued.get(key);
  if (!stored) return null;
  issued.delete(key);
  if (stored.expiresAt <= Date.now() || stored.mobile !== String(mobile) || stored.branchId !== String(branchId)) return null;
  return { distanceMeters: stored.distanceMeters };
}

module.exports = { issue, consume };
