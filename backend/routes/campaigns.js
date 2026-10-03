const express = require("express");
const campaigns = require("../utils/campaigns");

// Mounted behind requireAuth: every account sees and runs only its own campaigns.
const router = express.Router();

router.get("/", (req, res) => res.json({ campaigns: campaigns.list(req.auth.mobile) }));

router.post("/", (req, res) => {
  try {
    res.json({ campaign: campaigns.create(req.auth.mobile, req.body) });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || String(err) });
  }
});

router.get("/:id", (req, res) => {
  const campaign = campaigns.get(req.auth.mobile, req.params.id);
  if (!campaign) return res.status(404).json({ message: "Campaign not found." });
  res.json({ campaign });
});

// action = pause | resume | start-now | cancel
const ACTIONS = { pause: "pause", resume: "resume", "start-now": "startNow", cancel: "cancel" };
router.post("/:id/:action", (req, res) => {
  const fn = ACTIONS[req.params.action];
  if (!fn) return res.status(400).json({ message: "Unknown action." });
  const campaign = campaigns[fn](req.auth.mobile, req.params.id);
  if (!campaign) return res.status(404).json({ message: "Campaign not found." });
  res.json({ campaign });
});

module.exports = router;
