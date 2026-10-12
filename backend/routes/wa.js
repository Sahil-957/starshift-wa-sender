const express = require("express");
const wa = require("../utils/waSessions");
const bot = require("../utils/waBot");
const botData = require("../utils/botData");
const { requireFeature } = require("./auth");

// Mounted behind requireAuth: every account drives only its own linked WhatsApp.
const router = express.Router();
const needChatbot = requireFeature("chatbot");
const needExtract = requireFeature("extract");

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

// ---- Chat Extract (export a chat, or all chats, to Excel; built on the client from these rows) ----
// Gated behind the "extract" add-on. /contacts and /groups above stay open - they feed the campaign picker.
router.get("/chats", needExtract, async (req, res) => {
  try {
    res.json({ chats: await wa.chatList(req.auth.mobile) });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});
// Ask WhatsApp for older messages of one chat; they arrive async and are recorded, then re-exported.
router.post("/chat-history", needExtract, async (req, res) => {
  try {
    res.json(await wa.fetchHistory(req.auth.mobile, { jid: req.body.jid, count: req.body.count }));
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message });
  }
});
router.get("/chat-export", needExtract, async (req, res) => {
  try {
    const rows = await wa.chatExport(req.auth.mobile, { jid: req.query.jid || "", range: req.query.range || "all" });
    res.json({ rows });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// All members (name + mobile) of one group, for exporting a group's contacts to Excel.
router.get("/group-members", needExtract, async (req, res) => {
  try {
    res.json(await wa.groupMembers(req.auth.mobile, req.query.jid));
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

// ---- Chatbot data-lookup sheet (loan details etc., keyed by mobile) ----
// The Chatbot page's own endpoints are gated behind the "chatbot" add-on. /bot/sync below stays open: it
// also carries the Unsubscribers list, which campaigns rely on even when the chatbot isn't used.
router.get("/bot/data", needChatbot, (req, res) => res.json(botData.summary(req.auth.mobile)));
router.post("/bot/data", needChatbot, (req, res) => {
  try {
    res.json(botData.setFromRows(req.auth.mobile, req.body.rows));
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || String(err) });
  }
});
router.delete("/bot/data", needChatbot, (req, res) => res.json(botData.clear(req.auth.mobile)));

// Current stored chatbot config + unsubscribers, and the built-in defaults, for the web app's Chatbot page.
router.get("/bot", needChatbot, (req, res) => res.json(bot.current(req.auth.mobile)));
router.get("/bot/defaults", needChatbot, (_req, res) => res.json(bot.defaults()));

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
