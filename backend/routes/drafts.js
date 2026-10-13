const express = require("express");
const drafts = require("../utils/drafts");

// Mounted behind requireAuth: every account sees and edits only its own saved drafts.
const router = express.Router();

router.get("/", (req, res) => res.json({ drafts: drafts.list(req.auth.mobile), max: drafts.MAX_DRAFTS }));

router.post("/", (req, res) => {
  try {
    res.json({ drafts: drafts.create(req.auth.mobile, req.body.name, req.body.form) });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || String(err) });
  }
});

router.delete("/:id", (req, res) => res.json({ drafts: drafts.remove(req.auth.mobile, req.params.id) }));

module.exports = router;
