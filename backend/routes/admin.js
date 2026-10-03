const express = require("express");
const userStore = require("../utils/userStore");
const activation = require("../utils/activation");
const { generatePassword, hashPassword } = require("../utils/password");

// Mounted behind requireAdmin in server.js.
const router = express.Router();
const MOBILE_RE = /^\d{10,15}$/;
const PASSWORD_RE = /^\S{6,64}$/;
const PLAN_MONTHS = [1, 3, 6, 12];

// The token itself never leaves as a bare value - only wrapped in the link the admin shares.
const publicUser = ({ passwordHash, activationToken, ...user }) => ({
  ...user,
  hasPassword: !!passwordHash,
  activationLink: activationToken ? activation.linkFor(activationToken) : null,
});

/** The same day `months` later; month ends clamp (31 Jan + 1 month = end of Feb, not 3 Mar). */
function addMonths(from, months) {
  const date = new Date(from);
  const day = date.getDate();
  date.setMonth(date.getMonth() + months);
  if (date.getDate() < day) date.setDate(0);
  return date;
}

function planMonths(value) {
  const months = Number(value);
  return PLAN_MONTHS.includes(months) ? months : null;
}

/** A new password - the admin's own, or a generated one when left blank. Returns { error } or { password, changes }. */
function passwordChanges(requested) {
  const custom = String(requested ?? "");
  if (custom && !PASSWORD_RE.test(custom)) return { error: "Password must be 6-64 characters with no spaces." };
  const password = custom || generatePassword();
  return { password, changes: { passwordHash: hashPassword(password), passwordChangedAt: new Date().toISOString() } };
}

router.get("/users", (_req, res) => {
  // The admin number may be in users.json from the old OTP login; it's not a customer.
  const customers = userStore.list().filter((user) => user.mobile !== process.env.ADMIN_MOBILE);
  res.json({ users: customers.map(publicUser) });
});

// Adds an active customer on a 1/3/6/12-month plan. The password is only ever returned in this response.
router.post("/users", (req, res) => {
  const mobile = String(req.body.mobile || "").replace(/\D/g, "");
  const name = String(req.body.name || "").trim();
  const months = planMonths(req.body.months);
  if (!MOBILE_RE.test(mobile)) {
    return res.status(400).json({ message: "Enter the mobile number with country code, e.g. 919876543210." });
  }
  if (!months) return res.status(400).json({ message: "Choose a validity of 1, 3, 6 or 12 months." });
  if (mobile === process.env.ADMIN_MOBILE) return res.status(400).json({ message: "That is the admin number." });
  if (userStore.get(mobile)) {
    return res.status(409).json({ message: "This customer already exists - use Reset password or Renew on their row." });
  }

  const { error, password, changes } = passwordChanges(req.body.password);
  if (error) return res.status(400).json({ message: error });
  userStore.upsert(mobile, {
    ...changes,
    name,
    active: true,
    planMonths: months,
    expiresAt: addMonths(Date.now(), months).toISOString(),
  });
  // The activation link is what the customer actually gets sent; the password is their backup.
  activation.issue(mobile);
  res.json({ user: publicUser(userStore.get(mobile)), password });
});

router.patch("/users/:mobile", (req, res) => {
  const user = userStore.get(req.params.mobile);
  if (!user) return res.status(404).json({ message: "Customer not found." });
  const changes = {};
  if (typeof req.body.active === "boolean") changes.active = req.body.active;
  if (typeof req.body.name === "string") changes.name = req.body.name.trim();
  res.json({ user: publicUser(userStore.upsert(user.mobile, changes)) });
});

// Extends the plan from its current end date (or from today if it has already ended) and re-activates the account.
router.post("/users/:mobile/renew", (req, res) => {
  const user = userStore.get(req.params.mobile);
  if (!user) return res.status(404).json({ message: "Customer not found." });
  const months = planMonths(req.body.months);
  if (!months) return res.status(400).json({ message: "Choose 1, 3, 6 or 12 months." });

  const from = Math.max(Date.now(), Date.parse(user.expiresAt) || 0);
  const changes = { active: true, planMonths: months, expiresAt: addMonths(from, months).toISOString() };
  res.json({ user: publicUser(userStore.upsert(user.mobile, changes)) });
});

// Resets the password (admin's choice or generated); the old one stops working and existing logins are signed out.
router.post("/users/:mobile/password", (req, res) => {
  const user = userStore.get(req.params.mobile);
  if (!user) return res.status(404).json({ message: "Customer not found." });
  const { error, password, changes } = passwordChanges(req.body.password);
  if (error) return res.status(400).json({ message: error });
  userStore.upsert(user.mobile, changes);
  res.json({ password });
});

// A fresh activation link for a customer. The previous one stops working straight away.
router.post("/users/:mobile/activation", (req, res) => {
  const user = userStore.get(req.params.mobile);
  if (!user) return res.status(404).json({ message: "Customer not found." });
  const link = activation.linkFor(activation.issue(user.mobile));
  res.json({ activationLink: link });
});

router.delete("/users/:mobile", (req, res) => {
  if (!userStore.remove(req.params.mobile)) return res.status(404).json({ message: "Customer not found." });
  res.json({ ok: true });
});

module.exports = router;
