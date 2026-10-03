const crypto = require("crypto");
const userStore = require("./userStore");

/**
 * One-click activation links.
 *
 * Each customer carries a random `activationToken`. The link that wraps it is the customer's
 * credential: opening it hands the extension a login without them typing anything. It keeps
 * working while their plan runs - so a reinstall or a second PC needs no new link - and the
 * admin revokes it by generating a new one.
 */
function issue(mobile) {
  const token = crypto.randomBytes(24).toString("base64url");
  userStore.upsert(mobile, {
    activationToken: token,
    activationIssuedAt: new Date().toISOString(),
    activationUsedAt: null,
  });
  return token;
}

/** Where the customer's browser should go. Set PUBLIC_BASE_URL once the backend is on a real domain. */
function linkFor(token) {
  const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 5001}`).replace(/\/+$/, "");
  return `${base}/activate?t=${token}`;
}

function findUser(token) {
  const wanted = String(token || "").trim();
  if (!wanted) return null;
  return userStore.list().find((user) => user.activationToken && user.activationToken === wanted) || null;
}

module.exports = { issue, linkFor, findUser };
