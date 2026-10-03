const express = require("express");
const wa = require("../utils/waSessions");
const bot = require("../utils/waBot");

// Mounted behind requireAuth: every account drives only its own linked WhatsApp.
const router = express.Router();

router.get("/status", (req, res) => res.json(wa.status(req.auth.mobile)));

// Saved contacts and groups from the server's own WhatsApp, for the Recipients picker.
router.get("/contacts", (req, res) => res.json({ contacts: wa.contacts(req.auth.mobile) }));
router.get("/groups", async (req, res) => {
  try {
    res.json({ groups: await wa.groups(req.auth.mobile) });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.post("/connect", async (req, res) => {
  try {
    res.json(await wa.connect(req.auth.mobile));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/logout", async (req, res) => {
  await wa.logout(req.auth.mobile);
  res.json({ state: "disconnected" });
});

router.post("/send", async (req, res) => {
  try {
    await wa.send(req.auth.mobile, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || String(err) });
  }
});

// Current stored chatbot config + unsubscribers, and the built-in defaults, for the web app's Chatbot page.
router.get("/bot", (req, res) => res.json(bot.current(req.auth.mobile)));
router.get("/bot/defaults", (_req, res) => res.json(bot.defaults()));

// The extension's chatbot settings and Unsubscribers in; the bot's STOP / START changes back out.
// `running` tells the extension the server is answering, so WhatsApp Web's own bot stands down.
router.post("/bot/sync", (req, res) => {
  try {
    const result = bot.sync(req.auth.mobile, req.body);
    res.json({ ...result, running: result.active && wa.status(req.auth.mobile).state === "open" });
  } catch (err) {
    res.status(400).json({ message: err.message || String(err) });
  }
});

module.exports = router;
