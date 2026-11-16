const express = require("express");
const wa = require("../utils/waSessions");
const bot = require("../utils/waBot");
const botData = require("../utils/botData");
const QRCode = require("qrcode");
const { requireFeature } = require("./auth");

// Mounted behind requireAuth: every account drives only its own linked WhatsApp.
const router = express.Router();
const needChatbot = requireFeature("chatbot");
const needExtract = requireFeature("extract");
const needChat = requireFeature("chat");

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
router.get("/groups/invite-link", async (req, res) => {
  try {
    res.json({ url: await wa.groupInviteLink(req.auth.mobile, req.query.jid) });
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

// ---- Live Chat (two-way chat from the dashboard) ----
// Gated behind the "chat" pro add-on. Reads from the same recorded-message store as Chat Extract, and
// sends through the same linked WhatsApp as campaigns; outgoing messages are recorded on their own upsert.
router.get("/chat/threads", needChat, async (req, res) => {
  try {
    res.json({ chats: await wa.chatList(req.auth.mobile) });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});
router.get("/chat/thread", needChat, async (req, res) => {
  try {
    const rows = await wa.chatExport(req.auth.mobile, { jid: req.query.jid || "", range: req.query.range || "all" });
    res.json({ rows });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});
router.post("/chat/send", needChat, async (req, res) => {
  try {
    const jid = await wa.send(req.auth.mobile, req.body);
    res.json({ success: true, jid });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || String(err) });
  }
});

router.post("/connect", async (req, res) => {
  try {
    res.json(await wa.connect(req.auth.mobile, { pairingPhone: req.body.phone }));
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
router.get("/bot/bot5-data", needChatbot, (req, res) => res.json(botData.bot5Summary(req.auth.mobile)));
router.post("/bot/bot5-data", needChatbot, (req, res) => {
  try { res.json(botData.bot5SetFromRows(req.auth.mobile, req.body.rows)); }
  catch (err) { res.status(err.status || 400).json({ message: err.message || String(err) }); }
});
router.delete("/bot/bot5-data", needChatbot, (req, res) => res.json(botData.bot5Clear(req.auth.mobile)));

// Current stored chatbot config + unsubscribers, and the built-in defaults, for the web app's Chatbot page.
router.get("/bot", needChatbot, (req, res) => res.json(bot.current(req.auth.mobile)));
router.get("/bot/bookings", needChatbot, (req, res) => res.json({ bookings: bot.appointments(req.auth.mobile) }));
router.get("/bot/leads", needChatbot, (req, res) => res.json({ leads: bot.interestedLeads(req.auth.mobile) }));
router.get("/bot/hotel-bookings", needChatbot, (req, res) => res.json({ bookings: bot.hotelBookings(req.auth.mobile) }));
router.post("/bot/booking-qr", needChatbot, async (req, res) => {
  const url = String(req.body?.url || "");
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ message: "Invalid booking link." }); }
  const base = new URL(process.env.PUBLIC_BASE_URL || "https://api.starshift.in");
  const allowedOrigins = new Set([base.origin, "https://api.starshift.in"]);
  const qrMobile = String(parsed.searchParams.get("mobile") || "").replace(/\D/g, "");
  const branchId = parsed.searchParams.get("branch") || "";
  const isBranchTableGate = parsed.protocol === "https:" && allowedOrigins.has(parsed.origin) && parsed.pathname === "/table-booking.html"
    && qrMobile === String(req.auth.mobile || "").replace(/\D/g, "")
    && !!branchId && bot.hotelBranches(req.auth.mobile).some((branch) => String(branch.id) === branchId);
  const isLegacyTableGate = parsed.protocol === "https:" && allowedOrigins.has(parsed.origin) && parsed.pathname === "/table-booking.html"
    && /^\d{10,15}$/.test(qrMobile)
    && Number.isFinite(Number(parsed.searchParams.get("lat"))) && Math.abs(Number(parsed.searchParams.get("lat"))) <= 90
    && Number.isFinite(Number(parsed.searchParams.get("lon"))) && Math.abs(Number(parsed.searchParams.get("lon"))) <= 180;
  const isTableGate = isBranchTableGate || isLegacyTableGate;
  const waPhone = /^\/(\d{7,15})$/.exec(parsed.pathname)?.[1] || "";
  const linkedWhatsApp = String(wa.status(req.auth.mobile).me || "").replace(/\D/g, "");
  const branchMessage = /^table\s+([a-z0-9_-]+)$/i.exec(parsed.searchParams.get("text") || "");
  const isBranchWhatsAppLink = parsed.protocol === "https:" && parsed.hostname === "wa.me" && waPhone === linkedWhatsApp
    && !!branchMessage && bot.hotelBranches(req.auth.mobile).some((branch) => String(branch.id) === branchMessage[1]);
  const isSalonLink = /^https:\/\/wa\.me\/\d+\?text=book$/i.test(url);
  const isOwnWhatsAppLink = (parsed.protocol === "https:" && parsed.hostname === "wa.me" && !!linkedWhatsApp && waPhone === linkedWhatsApp)
    || (parsed.protocol === "https:" && allowedOrigins.has(parsed.origin) && parsed.pathname === "/wa-open.html" && !!linkedWhatsApp
      && String(parsed.searchParams.get("phone") || "").replace(/\D/g, "") === linkedWhatsApp);
  if (!isTableGate && !isSalonLink && !isBranchWhatsAppLink && !isOwnWhatsAppLink) return res.status(400).json({ message: "Invalid booking link." });
  try {
    res.json({ dataUrl: await QRCode.toDataURL(url, { width: 240, margin: 1 }) });
  } catch (err) {
    res.status(400).json({ message: err.message || "Could not generate QR code." });
  }
});
// Block WhatsApp calls (auto-reject + chat-only reply). Open to every account, not just the chatbot add-on.
router.get("/calls", (req, res) => res.json(bot.callSettings(req.auth.mobile)));
router.post("/calls", (req, res) => res.json(bot.setCallSettings(req.auth.mobile, req.body || {})));

router.get("/bot/defaults", needChatbot, (_req, res) => res.json(bot.defaults()));

// The extension's chatbot settings and Unsubscribers in; the bot's STOP / START changes back out.
// `running` tells the extension the server is answering, so WhatsApp Web's own bot stands down.
router.post("/bot/sync", async (req, res) => {
  try {
    const result = bot.sync(req.auth.mobile, req.body);
    const response = { ...result, running: result.active && wa.status(req.auth.mobile).state === "open" };
    const shopName = String(req.body?.config?.settings?.bot2SalonName || "").trim();
    if (req.body?.applyShopNameToProfile && shopName) {
      try {
        response.shopProfileNameUpdated = await wa.updateProfileName(req.auth.mobile, shopName);
        response.shopProfileNamePending = !response.shopProfileNameUpdated;
      } catch (error) {
        response.shopProfileNameError = error.message || "WhatsApp could not update the profile name.";
      }
    }
    res.json(response);
  } catch (err) {
    res.status(400).json({ message: err.message || String(err) });
  }
});

module.exports = router;
