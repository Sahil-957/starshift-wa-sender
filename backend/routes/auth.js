const express = require("express");
const jwt = require("jsonwebtoken");
const userStore = require("../utils/userStore");
const activation = require("../utils/activation");
const otpStore = require("../utils/otpStore");
const adminStore = require("../utils/adminStore");
const { sendOtp } = require("../utils/sms");
const { verifyPassword, matchesPlain, hashPassword } = require("../utils/password");

const router = express.Router();
const MOBILE_RE = /^\d{10,15}$/;
const PASSWORD_RE = /^\S{6,64}$/;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const failures = new Map(); // mobile -> { count, lockedUntil }

const INACTIVE_MESSAGE = "Your account is not active. Please contact the seller.";

function isAdmin(mobile) {
  return !!process.env.ADMIN_MOBILE && mobile === process.env.ADMIN_MOBILE;
}

/** The admin password reset by OTP (data/admin.json) wins over ADMIN_PASSWORD in .env. */
function adminPasswordOk(password) {
  const saved = adminStore.get().passwordHash;
  if (saved) return verifyPassword(password, saved);
  return !!process.env.ADMIN_PASSWORD && matchesPlain(password, process.env.ADMIN_PASSWORD);
}

function roleOf(mobile) {
  return isAdmin(mobile) ? "admin" : "customer";
}

function maxBotsOf(user) {
  const value = Number(user?.maxBots);
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : 3;
}

const ALL_BOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
/** The bot numbers (1-10) the admin ticked for this customer. Older accounts only have a count: Bots 1..count. */
function allowedBotsOf(user) {
  if (Array.isArray(user?.bots)) return ALL_BOTS.filter((n) => user.bots.map(Number).includes(n));
  return ALL_BOTS.slice(0, maxBotsOf(user));
}

// Premium add-ons the seller can switch on/off per customer. By default a flag that was never set counts
// as ON, so existing customers keep what they already use; the admin turns one OFF to gate it behind a
// higher plan. Opt-in add-ons are the reverse — OFF until the admin turns them on (a true pro extra).
const FEATURES = ["campaign", "sheet", "broadcast", "reports", "chatbot", "quick", "unsub", "extract", "chat", "api"];
const OPT_IN_FEATURES = new Set(); // (none) — every add-on defaults ON; admin turns one OFF to gate it
function featuresOf(user) {
  const out = {};
  for (const key of FEATURES) {
    if (!user) { out[key] = true; continue; } // admin (no user record) gets everything
    out[key] = OPT_IN_FEATURES.has(key) ? user?.features?.[key] === true : user?.features?.[key] !== false;
  }
  return out;
}

/** Blocks a route when the customer's plan doesn't include the named feature. Admin always passes. */
function requireFeature(name) {
  return (req, res, next) => {
    if (req.auth.role === "admin" || req.auth.features?.[name]) return next();
    res.status(403).json({ message: "This feature is not enabled on your plan. Please contact the seller." });
  };
}

/** Why a customer can't use the extension right now (inactive or plan ended), or null if they can. */
function accessProblem(user) {
  if (!user?.active) return INACTIVE_MESSAGE;
  if (user.expiresAt && Date.parse(user.expiresAt) <= Date.now()) {
    return `Your plan expired on ${new Date(user.expiresAt).toDateString()}. Please renew it with the seller.`;
  }
  return null;
}

/**
 * Verifies the Bearer token and sets req.auth = { mobile, role }. Customers are re-checked on every request,
 * so deactivating one or giving them a new password locks them out straight away.
 */
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: "Please log in again." });
  }

  const { mobile, iat } = payload;
  let expiresAt = null;
  const currentUser = isAdmin(mobile) ? null : userStore.get(mobile);
  if (!isAdmin(mobile)) {
    const user = currentUser;
    const problem = accessProblem(user);
    if (problem) return res.status(403).json({ message: problem });
    const changedAt = Math.floor(Date.parse(user.passwordChangedAt || 0) / 1000);
    if (changedAt > iat) return res.status(401).json({ message: "Your password was changed. Please log in again." });
    expiresAt = user.expiresAt || null;
  } else {
    const changedAt = Math.floor(Date.parse(adminStore.get().passwordChangedAt || 0) / 1000);
    if (changedAt > iat) return res.status(401).json({ message: "Your password was changed. Please log in again." });
  }
  const features = isAdmin(mobile) ? featuresOf(null) : featuresOf(currentUser);
  req.auth = { mobile, role: roleOf(mobile), expiresAt, features, maxBots: isAdmin(mobile) ? 5 : maxBotsOf(currentUser), bots: isAdmin(mobile) ? ALL_BOTS : allowedBotsOf(currentUser) };
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => (req.auth.role === "admin" ? next() : res.status(403).json({ message: "Admin only." })));
}

router.post("/login", (req, res) => {
  const mobile = String(req.body.mobile || "").trim();
  const password = String(req.body.password || "");
  if (!MOBILE_RE.test(mobile) || !password) {
    return res.status(400).json({ message: "Enter your mobile number and password." });
  }

  const record = failures.get(mobile);
  if (record?.lockedUntil > Date.now()) {
    return res.status(429).json({ message: "Too many wrong passwords. Try again in 15 minutes." });
  }

  const user = userStore.get(mobile);
  const passwordOk = isAdmin(mobile)
    ? adminPasswordOk(password)
    : verifyPassword(password, user?.passwordHash);

  if (!passwordOk) {
    const count = record && !record.lockedUntil ? record.count + 1 : 1;
    failures.set(mobile, { count, lockedUntil: count >= MAX_FAILURES ? Date.now() + LOCK_MS : 0 });
    return res.status(401).json({ message: "Wrong mobile number or password." });
  }
  failures.delete(mobile);

  if (!isAdmin(mobile)) {
    const problem = accessProblem(user);
    if (problem) return res.status(403).json({ message: problem });
    userStore.upsert(mobile, { lastLoginAt: new Date().toISOString() });
  }

  const token = jwt.sign({ mobile, role: roleOf(mobile) }, process.env.JWT_SECRET, { expiresIn: "30d" });
  res.json({
    token,
    mobile,
    role: roleOf(mobile),
    expiresAt: isAdmin(mobile) ? null : user.expiresAt || null,
    features: isAdmin(mobile) ? featuresOf(null) : featuresOf(user),
    maxBots: isAdmin(mobile) ? 5 : maxBotsOf(user),
    bots: isAdmin(mobile) ? ALL_BOTS : allowedBotsOf(user),
  });
});


/**
 * One-click activation: the customer opens the link their seller sent and the extension trades
 * its code for a login here, so nothing has to be typed. The code stays valid while the plan
 * runs - the admin revokes it by generating a new one.
 */
router.post("/activate", (req, res) => {
  const user = activation.findUser(req.body.token);
  if (!user) {
    return res.status(404).json({ message: "This activation link is not valid any more. Ask your seller for a new one." });
  }
  const problem = accessProblem(user);
  if (problem) return res.status(403).json({ message: problem });

  const now = new Date().toISOString();
  userStore.upsert(user.mobile, { activationUsedAt: now, lastLoginAt: now });
  const token = jwt.sign({ mobile: user.mobile, role: "customer" }, process.env.JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, mobile: user.mobile, role: "customer", expiresAt: user.expiresAt || null, name: user.name || "", features: featuresOf(user), maxBots: maxBotsOf(user), bots: allowedBotsOf(user) });
});

// Sends a one-time code to the customer's own number so they can set a new password themselves.
router.post("/forgot-password", async (req, res) => {
  const mobile = String(req.body.mobile || "").replace(/\D/g, "");
  if (!MOBILE_RE.test(mobile)) return res.status(400).json({ message: "Enter your mobile number with country code." });

  const user = userStore.get(mobile);
  // The answer is the same either way, so this form can't be used to find out who has an account.
  if (isAdmin(mobile) || (user && !accessProblem(user))) {
    try {
      await sendOtp(mobile, otpStore.issue(mobile));
    } catch (err) {
      console.error(`Could not send the reset OTP to ${mobile}:`, err.message);
    }
  }
  res.json({ ok: true, message: "If that number has an account, a code has been sent to it." });
});

router.post("/reset-password", (req, res) => {
  const mobile = String(req.body.mobile || "").replace(/\D/g, "");
  const otp = String(req.body.otp || "").trim();
  const password = String(req.body.password || "");
  if (!MOBILE_RE.test(mobile)) return res.status(400).json({ message: "Enter your mobile number with country code." });
  if (!PASSWORD_RE.test(password)) return res.status(400).json({ message: "Password must be 6-64 characters with no spaces." });

  if (isAdmin(mobile)) {
    const check = otpStore.verify(mobile, otp);
    if (!check.ok) return res.status(400).json({ message: check.message });
    adminStore.update({ passwordHash: hashPassword(password), passwordChangedAt: new Date().toISOString() });
    failures.delete(mobile);
    return res.json({ ok: true });
  }

  const user = userStore.get(mobile);
  if (!user) return res.status(404).json({ message: "No account for this number." });
  const problem = accessProblem(user);
  if (problem) return res.status(403).json({ message: problem });

  const check = otpStore.verify(mobile, otp);
  if (!check.ok) return res.status(400).json({ message: check.message });

  // passwordChangedAt also signs out every device still holding the old login.
  userStore.upsert(mobile, { passwordHash: hashPassword(password), passwordChangedAt: new Date().toISOString() });
  failures.delete(mobile);
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => res.json(req.auth));

module.exports = { router, requireAuth, requireAdmin, requireFeature, FEATURES };
