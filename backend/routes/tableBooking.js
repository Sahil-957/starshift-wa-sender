const express = require("express");
const bot = require("../utils/waBot");
const wa = require("../utils/waSessions");
const tableBookingTokens = require("../utils/tableBookingTokens");
const router = express.Router();
const recentSubmissions = new Map();

function rateLimitLocation(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recent = (recentSubmissions.get(key) || []).filter((time) => now - time < 2 * 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ message: "Too many location checks. Please wait a few minutes and try again." });
  recent.push(now); recentSubmissions.set(key, recent); next();
}

router.get("/branch", (req, res) => {
  const mobile = String(req.query.mobile || "").replace(/\D/g, "");
  if (mobile.length < 7 || mobile.length > 15) return res.status(400).json({ message: "Invalid shop account." });
  const settings = bot.current(mobile).settings || {};
  if (!settings.bot4Enabled) return res.status(404).json({ message: "This branch booking link is unavailable." });
  const branches = bot.hotelBranches(mobile);
  let branch = branches.find((entry) => String(entry.id) === String(req.query.branch));
  if (!branch && !req.query.branch) {
    const lat = Number(req.query.lat), lon = Number(req.query.lon);
    if (Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180) {
      const radians = (value) => value * Math.PI / 180;
      const distance = (entry) => {
        const branchLat = Number(entry.latitude), branchLon = Number(entry.longitude);
        if (!Number.isFinite(branchLat) || !Number.isFinite(branchLon)) return Infinity;
        const dLat = radians(lat - branchLat), dLon = radians(lon - branchLon);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(branchLat)) * Math.cos(radians(lat)) * Math.sin(dLon / 2) ** 2;
        return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };
      const nearest = branches.map((entry) => ({ entry, distance: distance(entry) })).sort((a, b) => a.distance - b.distance)[0];
      if (nearest && nearest.distance <= 50) branch = nearest.entry;
    }
  }
  if (!branch) return res.status(404).json({ message: "This branch booking link is unavailable." });
  res.json({ shop: settings.bot4Name || "Sainath Khanawal", branch: { id: branch.id, name: branch.name, openTime: branch.openTime || "10:00", closeTime: branch.closeTime || "23:00" }, welcome: bot.hotelWelcomeTemplate(settings), whatsappNumber: String(wa.status(mobile).me || "").replace(/\D/g, "") });
});

router.post("/location-check", rateLimitLocation, (req, res) => {
  const mobile = String(req.body?.mobile || "").replace(/\D/g, "");
  if (mobile.length < 7 || mobile.length > 15) return res.status(400).json({ message: "Invalid shop account." });
  const settings = bot.current(mobile).settings || {};
  if (!settings.bot4Enabled) return res.status(404).json({ message: "This branch booking link is unavailable." });
  const branch = bot.hotelBranches(mobile).find((entry) => String(entry.id) === String(req.body?.branchId));
  if (!branch) return res.status(404).json({ message: "This branch booking link is unavailable." });
  const lat = Number(req.body?.latitude), lon = Number(req.body?.longitude);
  const shopLat = Number(branch.latitude), shopLon = Number(branch.longitude);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180
    || !Number.isFinite(shopLat) || Math.abs(shopLat) > 90 || !Number.isFinite(shopLon) || Math.abs(shopLon) > 180) {
    return res.status(400).json({ message: "Could not verify this branch location. Please scan its QR again." });
  }
  const radians = (value) => value * Math.PI / 180;
  const dLat = radians(lat - shopLat), dLon = radians(lon - shopLon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(shopLat)) * Math.cos(radians(lat)) * Math.sin(dLon / 2) ** 2;
  const distanceMeters = Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  if (distanceMeters > 50) return res.status(403).json({ message: `You are about ${distanceMeters} metres away. Table booking is available within 50 metres of ${branch.name}.` });
  const token = tableBookingTokens.issue(mobile, branch.id, distanceMeters);
  res.json({ token, distanceMeters, branch: branch.name, whatsappNumber: String(wa.status(mobile).me || "").replace(/\D/g, "") });
});

router.post("/book", async (req, res) => {
  const mobile = String(req.body?.mobile || "").replace(/\D/g, "");
  if (mobile.length < 7 || mobile.length > 15) return res.status(400).json({ message: "Invalid shop account." });
  try {
    const { booking, branch, welcome } = bot.createHotelBooking(mobile, req.body || {});
    let alertSent = false;
    try {
      await wa.sendText(mobile, branch.notifyNumber, `New table booking · ${booking.branchName}\nQueue: ${booking.queueNo}\nCustomer: ${booking.name}\nMobile: ${booking.number}\nMembers: ${booking.members}\nDistance: ${booking.distanceMeters} m\nTime: ${booking.time}`);
      alertSent = true;
    } catch (error) { console.warn(`[table booking ${mobile}] owner alert failed:`, error.message || error); }
    res.json({ booking, welcome, alertSent });
  } catch (error) { res.status(error.status || 400).json({ message: error.message || "Could not create booking." }); }
});

module.exports = router;
