const express = require("express");
const lists = require("../utils/lists");

// Mounted behind requireAuth: every account sees only its own saved lists.
const router = express.Router();

router.get("/", (req, res) => res.json({ lists: lists.list(req.auth.mobile) }));

router.post("/", (req, res) => {
  try {
    res.json({ lists: lists.create(req.auth.mobile, req.body.name, req.body.recipients) });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || String(err) });
  }
});

router.delete("/:id", (req, res) => res.json({ lists: lists.remove(req.auth.mobile, req.params.id) }));

module.exports = router;
