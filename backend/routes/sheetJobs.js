const express = require("express");
const sheetJobs = require("../utils/sheetJobs");

// Mounted behind requireAuth: every account sees and runs only its own scheduled sheets.
const router = express.Router();

router.get("/", (req, res) => res.json({ batches: sheetJobs.list(req.auth.mobile) }));

router.post("/", async (req, res) => {
  try {
    res.json({ batch: await sheetJobs.create(req.auth.mobile, req.body) });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || String(err) });
  }
});

router.get("/:id", (req, res) => {
  const batch = sheetJobs.get(req.auth.mobile, req.params.id);
  if (!batch) return res.status(404).json({ message: "Not found." });
  res.json({ batch });
});

router.post("/:id/resync", async (req, res) => {
  try {
    const batch = await sheetJobs.resync(req.auth.mobile, req.params.id);
    if (!batch) return res.status(404).json({ message: "Not found." });
    res.json({ batch: sheetJobs.get(req.auth.mobile, req.params.id) });
  } catch (err) {
    res.status(400).json({ message: err.message || String(err) });
  }
});

router.post("/:id/cancel", (req, res) => {
  const batch = sheetJobs.cancel(req.auth.mobile, req.params.id);
  if (!batch) return res.status(404).json({ message: "Not found." });
  res.json({ batch });
});

router.delete("/:id", (req, res) => {
  if (!sheetJobs.remove(req.auth.mobile, req.params.id)) return res.status(404).json({ message: "Not found." });
  res.json({ ok: true });
});

module.exports = router;
