/**
 * The logged-in customer's own account settings. Mounted behind requireAuth (JWT), so each account only
 * ever sees and rotates its own API key. The key itself is used by the public /api/v1 routes.
 */
const express = require("express");
const crypto = require("crypto");
const userStore = require("../utils/userStore");

const router = express.Router();

function newKey() {
  return "sk_live_" + crypto.randomBytes(24).toString("hex");
}

router.get("/apikey", (req, res) => {
  const user = userStore.get(req.auth.mobile);
  res.json({ apiKey: user?.apiKey || null });
});

// Creates the first key, or replaces the current one (the old key stops working immediately).
router.post("/apikey/rotate", (req, res) => {
  const apiKey = newKey();
  userStore.upsert(req.auth.mobile, { apiKey });
  res.json({ apiKey });
});

router.delete("/apikey", (req, res) => {
  userStore.upsert(req.auth.mobile, { apiKey: null });
  res.json({ ok: true });
});

module.exports = router;
