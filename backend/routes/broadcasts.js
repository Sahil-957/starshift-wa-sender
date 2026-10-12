const express = require("express");
const broadcasts = require("../utils/broadcasts");

// Mounted behind requireAuth: every account sees and runs only its own broadcasts.
const router = express.Router();

router.get("/", (req, res) => res.json({ broadcasts: broadcasts.list(req.auth.mobile) }));

router.post("/", (req, res) => {
  try {
    res.json({ broadcast: broadcasts.create(req.auth.mobile, req.body) });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || String(err) });
  }
});

router.patch("/:id", (req, res) => {
  const b = broadcasts.edit(req.auth.mobile, req.params.id, req.body);
  if (!b) return res.status(404).json({ message: "Not found." });
  res.json({ broadcast: b });
});

// Replace the current file (only the latest is kept; the old one is deleted).
router.post("/:id/file", (req, res) => {
  try {
    const b = broadcasts.setFile(req.auth.mobile, req.params.id, req.body.file);
    if (!b) return res.status(404).json({ message: "Not found." });
    res.json({ broadcast: b });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || String(err) });
  }
});

router.post("/:id/run-now", async (req, res) => {
  try {
    const result = await broadcasts.runNow(req.auth.mobile, req.params.id);
    if (!result) return res.status(404).json({ message: "Not found." });
    res.json(result);
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || String(err) });
  }
});

router.delete("/:id", (req, res) => {
  if (!broadcasts.remove(req.auth.mobile, req.params.id)) return res.status(404).json({ message: "Not found." });
  res.json({ ok: true });
});

module.exports = router;
