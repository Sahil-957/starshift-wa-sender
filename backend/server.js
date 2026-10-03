require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { router: authRoutes, requireAuth, requireAdmin } = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const waRoutes = require("./routes/wa");
const campaignRoutes = require("./routes/campaigns");
const listRoutes = require("./routes/lists");
const waSessions = require("./utils/waSessions");
const campaigns = require("./utils/campaigns");

if (!process.env.JWT_SECRET) {
  console.warn("WARNING: JWT_SECRET not set in .env - using an insecure default for dev only.");
  process.env.JWT_SECRET = "dev-only-insecure-secret";
}
if (!process.env.ADMIN_MOBILE || !process.env.ADMIN_PASSWORD) {
  console.warn("WARNING: ADMIN_MOBILE / ADMIN_PASSWORD not set in .env - nobody can open the admin panel.");
}

const app = express();
app.use(cors());
// Sends carry the attachment inline, so this route takes far bigger bodies than the rest.
app.use("/api/wa", express.json({ limit: "70mb" }), requireAuth, waRoutes);
// Creating a campaign posts the whole contact list plus any attachment, so this route takes a larger body.
app.use("/api/campaigns", express.json({ limit: "60mb" }), requireAuth, campaignRoutes);
app.use("/api/lists", express.json({ limit: "20mb" }), requireAuth, listRoutes);
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/admin", requireAdmin, adminRoutes);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Read by the activation page so it knows which extension to hand the code to.
app.get("/api/public-config", (_req, res) =>
  res.json({
    extensionId: process.env.EXTENSION_ID || "",
    supportMobile: process.env.SUPPORT_MOBILE || "917028080364",
  })
);

// ---------- Public pages ----------
const PUBLIC_DIR = path.join(__dirname, "public");

/** Pretty-prints a stored mobile (919876543210) the way a customer would read it. */
function supportLabel(mobile) {
  return /^\d{12}$/.test(mobile) ? `+${mobile.slice(0, 2)} ${mobile.slice(2, 7)} ${mobile.slice(7)}` : `+${mobile}`;
}

/**
 * The policy pages carry {{PLACEHOLDERS}} so the seller fills their business details in .env once,
 * instead of editing HTML. Anything left unset shows as a visible [square-bracket] reminder.
 */
function renderPage(file) {
  const mobile = process.env.SUPPORT_MOBILE || "917028080364";
  const values = {
    BUSINESS_NAME: process.env.BUSINESS_NAME || "[your registered business name]",
    SUPPORT_EMAIL: process.env.SUPPORT_EMAIL || "[your support email]",
    SUPPORT_MOBILE: mobile,
    SUPPORT_MOBILE_LABEL: supportLabel(mobile),
    JURISDICTION: process.env.JURISDICTION || "[your city]",
    POLICY_EFFECTIVE_DATE: process.env.POLICY_EFFECTIVE_DATE || "16 September 2026",
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 5001}`,
  };
  const html = fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8");
  return html.replace(/\{\{(\w+)\}\}/g, (whole, key) => values[key] ?? whole);
}

function sendPage(file) {
  return (_req, res) => res.type("html").send(renderPage(file));
}

app.get("/privacy", sendPage("privacy.html"));
app.get("/terms", sendPage("terms.html"));
app.get("/", (_req, res) => res.redirect("/app"));
app.get("/app", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "app.html")));

// The page a customer lands on when they open the activation link their seller sent them.
app.get("/activate", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "activate.html")));

// Stylesheets and anything else the pages above reference.
app.use(express.static(PUBLIC_DIR, { index: false }));


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Starshift WA Sender backend listening on http://localhost:${PORT}`));
waSessions.restoreAll();
campaigns.restoreAll();
