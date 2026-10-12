/**
 * Public HTTP API (/api/v1) for integrations - send messages, start campaigns, check status and pull
 * Chat-Extract data from any code, website or tool, authenticated by a per-account API key instead of a
 * login. Each account's key drives only its own linked WhatsApp. Generate the key in the dashboard (API tab).
 *
 *   Header:  x-api-key: sk_live_...
 *   Example: POST /api/v1/send  { "to": "919876543210", "message": "Hi {{name}}", "name": "Ramesh" }
 */
const express = require("express");
const userStore = require("../utils/userStore");
const wa = require("../utils/waSessions");
const campaigns = require("../utils/campaigns");
const { personalize } = require("../utils/messaging");

const router = express.Router();
const FEATURES = ["chatbot", "extract"];
const MAX_MEDIA_BYTES = 45 * 1024 * 1024;

/** Authenticates by x-api-key and sets req.auth like the JWT path does. */
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.api_key || "";
  const user = userStore.findByApiKey(String(key));
  if (!user) return res.status(401).json({ message: "Invalid or missing API key. Send it in the x-api-key header." });
  if (!user.active) return res.status(403).json({ message: "This account is not active." });
  if (user.expiresAt && Date.parse(user.expiresAt) <= Date.now()) return res.status(403).json({ message: "This account's plan has expired." });
  const features = {};
  for (const f of FEATURES) features[f] = user.features?.[f] !== false;
  req.auth = { mobile: user.mobile, role: "customer", features };
  next();
}

const needExtract = (req, res, next) =>
  req.auth.features.extract ? next() : res.status(403).json({ message: "The Chat Extract add-on is not enabled on this account." });

router.use(requireApiKey);

/** Downloads a public file URL into an attachment the sender understands. */
async function downloadMedia(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw Object.assign(new Error(`Could not download mediaUrl (${r.status}).`), { status: 400 });
  const type = (r.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_MEDIA_BYTES) throw Object.assign(new Error("Attachment is larger than 45 MB."), { status: 400 });
  const name = (() => {
    try {
      const b = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
      return b && b.includes(".") ? b : "file";
    } catch {
      return "file";
    }
  })();
  return { dataUrl: `data:${type};base64,${buf.toString("base64")}`, name, mimeType: type };
}

// ---- Account / connection ----
router.get("/status", (req, res) => res.json(wa.status(req.auth.mobile)));

// ---- Send one message ----
// body: { to, message?, name?, custom1?, custom2?, mediaUrl? }  (message/caption supports {{name}} etc.)
router.post("/send", async (req, res) => {
  try {
    const to = String(req.body.to || req.body.mobile || req.body.number || "").replace(/\D/g, "");
    if (to.length < 7) return res.status(400).json({ message: "'to' must be a mobile number with country code." });
    const text = personalize(String(req.body.message || req.body.text || ""), req.body);
    let attachment = null;
    if (req.body.mediaUrl) attachment = { ...(await downloadMedia(String(req.body.mediaUrl))), caption: text || undefined };
    else if (!text) return res.status(400).json({ message: "Provide a 'message' or a 'mediaUrl'." });
    await wa.send(req.auth.mobile, { target: { type: "number", phone: to }, message: text, attachment });
    res.json({ success: true, to });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || String(err) });
  }
});

// ---- Start a bulk campaign ----
// body: { name?, message, gapSeconds?, recipients: [{ mobile, name?, custom1?, custom2? }] }
router.post("/campaign", (req, res) => {
  try {
    const raw = req.body.recipients || req.body.contacts || [];
    const contacts = (Array.isArray(raw) ? raw : []).map((r) =>
      typeof r === "string"
        ? { source: "number", mobile: r.replace(/\D/g, "") }
        : { source: "number", mobile: String(r.mobile || r.number || r.to || "").replace(/\D/g, ""), name: r.name || "", custom1: r.custom1 || "", custom2: r.custom2 || "" }
    );
    const campaign = campaigns.create(req.auth.mobile, {
      name: req.body.name || "API campaign",
      messageTemplate: String(req.body.message || req.body.text || ""),
      gapSeconds: req.body.gapSeconds,
      contacts,
    });
    res.json({ id: campaign.id, status: campaign.status, total: campaign.contacts.length });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || String(err) });
  }
});

// ---- Campaign status / report ----
router.get("/campaign/:id", (req, res) => {
  const c = campaigns.get(req.auth.mobile, req.params.id);
  if (!c) return res.status(404).json({ message: "Campaign not found." });
  res.json({
    id: c.id,
    name: c.name,
    status: c.status,
    total: c.contacts.length,
    sent: c.sentCount || 0,
    failed: c.failedCount || 0,
    pending: c.contacts.filter((x) => x.status === "pending").length,
    failedList: c.contacts.filter((x) => x.status === "failed").map((x) => ({ name: x.name, mobile: x.mobile, reason: x.failReason })),
  });
});

// ---- Chat Extract data (needs the extract add-on) ----
router.get("/chats", needExtract, async (req, res) => {
  try {
    res.json({ chats: await wa.chatList(req.auth.mobile) });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});
router.get("/chat-export", needExtract, async (req, res) => {
  try {
    res.json({ rows: await wa.chatExport(req.auth.mobile, { jid: req.query.jid || "", range: req.query.range || "all" }) });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});
router.get("/group-members", needExtract, async (req, res) => {
  try {
    res.json(await wa.groupMembers(req.auth.mobile, req.query.jid));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;
