const express = require("express");

// Mounted behind requireAuth. Fetches a published Google Sheet as CSV server-side (avoids browser CORS).
const router = express.Router();

router.post("/sheets", async (req, res) => {
  try {
    const url = String(req.body.url || "");
    const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!m) throw new Error("That doesn't look like a Google Sheets link.");
    const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1] || "0";
    const csvUrl = `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
    const r = await fetch(csvUrl, { redirect: "follow" });
    const csv = await r.text();
    if (!r.ok || csv.trim().startsWith("<")) {
      throw new Error("Couldn't read the sheet. Share it: Anyone with the link → Viewer, then try again.");
    }
    res.json({ csv });
  } catch (err) {
    res.status(400).json({ message: err.message || String(err) });
  }
});

module.exports = router;
