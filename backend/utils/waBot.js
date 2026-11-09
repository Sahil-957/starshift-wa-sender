/**
 * Chatbot auto-replies on the server's own WhatsApp connection (Baileys): a reply goes out the moment a
 * message arrives, with nothing typed into WhatsApp Web. The extension pushes its chatbot settings, rules
 * and Unsubscribers list here (POST /api/wa/bot/sync); the matching is the very same code the extension
 * uses (extension/common/chatbot.js), so the server answers exactly what the dashboard's Test Reply shows.
 *
 * STOP and START change the Unsubscribers list. The server keeps each change numbered in `changes` until
 * the extension confirms it has applied it (the `since` it sends on its next sync), so none is lost if a
 * sync fails on the way.
 */
const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("./atomicWrite");
const { normalizeMessageContent, isJidGroup, isJidBroadcast, isJidNewsletter } = require("@whiskeysockets/baileys");

const botData = require("./botData");
const userStore = require("./userStore");
const { sendMenu, sendChoices } = require("./waInteractive");
const XLSX = require(path.join(__dirname, "..", "public", "xlsx.full.min.js"));
const tableBookingTokens = require("./tableBookingTokens");
function readHiddenTableToken(text) {
  const match = /\u2063([\u200b\u200c]+)\u2063/.exec(String(text || ""));
  if (!match || match[1].length % 8) return null;
  let bytes = "";
  for (let i = 0; i < match[1].length; i += 8) { let byte = 0; for (let bit = 0; bit < 8; bit++) byte = (byte << 1) | (match[1][i + bit] === "\u200c" ? 1 : 0); bytes += String.fromCharCode(byte); }
  try { return decodeURIComponent(Array.from(bytes, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join("")); } catch { return null; }
}

/** The seller can switch the chatbot add-on off per customer; an unset flag counts as on. */
function chatbotEnabled(mobile) {
  return userStore.get(mobile)?.features?.chatbot !== false;
}

require(path.join(__dirname, "..", "..", "extension", "common", "chatbot.js")); // defines globalThis.SwasBot
const { SwasBot } = globalThis;

/** The data-lookup action for this message, or null when lookup isn't triggered. */
function lookupAction(mobile, settings, text, senderNumber) {
  if (!settings?.lookupEnabled) return null;
  const keywords = String(settings.lookupKeywords || "1").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (!keywords.includes(String(text).trim().toLowerCase())) return null;
  const reply = botData.lookupReply(mobile, senderNumber);
  if (reply) return { type: "lookup", label: "Data lookup", reply };
  const notReg = String(settings.notRegisteredMessage || "").trim();
  return notReg ? { type: "lookup-miss", label: "Not registered", reply: notReg } : null;
}

const BOTS_DIR = path.join(__dirname, "..", "data", "bots");
const MAX_AGE_MS = 10 * 60 * 1000; // a backlog delivered after a restart is not answered
const MAX_HANDLED = 1000;

// mobile -> { config, unsubscribers, changes, seq, sessions } - saved to data/bots/<mobile>.json.
// sessions: chat jid -> when the bot last gave that chat a real answer (kept across restarts).
const bots = new Map();
// mobile -> { handled: Set of message ids, sent: chat jid -> recent reply times } - memory only.
const runtimes = new Map();

function botFile(mobile) {
  return path.join(BOTS_DIR, `${String(mobile).replace(/\D/g, "")}.json`);
}

function load(mobile) {
  if (!bots.has(mobile)) {
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(botFile(mobile), "utf8"));
    } catch {
      /* first sync for this account */
    }
    bots.set(mobile, { config: null, unsubscribers: [], changes: [], seq: 0, sessions: {}, langs: {}, ...saved });
  }
  return bots.get(mobile);
}

function save(mobile) {
  writeJsonAtomic(botFile(mobile), bots.get(mobile));
}

function runtime(mobile) {
  if (!runtimes.has(mobile)) runtimes.set(mobile, { handled: new Set(), sent: new Map() });
  return runtimes.get(mobile);
}

function buildConfig(bot) {
  const { settings, rules, footerKeywords } = bot.config || {};
  const bot2Selected = !!settings?.bot2SalonEnabled;
  const bot3Selected = !!settings?.bot3Enabled;
  // Ask each chat to choose Marathi or English before showing the main menu.
  return SwasBot.buildConfig({ ...settings, enabled: !!settings?.enabled, bilingual: true }, rules, footerKeywords);
}

function salonMarathiText(value) {
  return String(value || "")
    .replace(/Welcome! Choose an option below\./g, "\\u0938\\u094d\\u0935\\u093e\\u0917\\u0924 \\u0906\\u0939\\u0947! \\u0916\\u093e\\u0932\\u0940\\u0932 \\u092a\\u0930\\u094d\\u092f\\u093e\\u092f \\u0928\\u093f\\u0935\\u0921\\u093e.")
    .replace(/Thank you for choosing us\./g, "\\u0906\\u092e\\u091a\\u0940 \\u0928\\u093f\\u0935\\u0921 \\u0915\\u0947\\u0932\\u094d\\u092f\\u093e\\u092c\\u0926\\u094d\\u0926\\u0932 \\u0927\\u0928\\u094d\\u092f\\u0935\\u093e\\u0926.")
    .replace(/Please choose a service to book your appointment\./g, "\\u092c\\u0941\\u0915\\u093f\\u0902\\u0917\\u0938\\u093e\\u0920\\u0940 \\u0938\\u0947\\u0935\\u093e \\u0928\\u093f\\u0935\\u0921\\u093e.")
    .replace(/Choose an appointment date/g, "\\u0905\\u092a\\u0949\\u0907\\u0902\\u091f\\u092e\\u0947\\u0902\\u091f\\u091a\\u0940 \\u0924\\u093e\\u0930\\u0940\\u0916 \\u0928\\u093f\\u0935\\u0921\\u093e")
    .replace(/Choose an appointment time/g, "\\u0905\\u092a\\u0949\\u0907\\u0902\\u091f\\u092e\\u0947\\u0902\\u091f\\u091a\\u0940 \\u0935\\u0947\\u0933 \\u0928\\u093f\\u0935\\u0921\\u093e")
    .replace(/Available worker slots/g, "\\u0909\\u092a\\u0932\\u092c\\u094d\\u0927 \\u0938\\u0947\\u0935\\u093e \\u0935\\u0947\\u0933\\u093e")
    .replace(/Service:/g, "\\u0938\\u0947\\u0935\\u093e:")
    .replace(/More services/g, "\\u0906\\u0923\\u0916\\u0940 \\u0938\\u0947\\u0935\\u093e")
    .replace(/More dates/g, "\\u0906\\u0923\\u0916\\u0940 \\u0924\\u093e\\u0930\\u0916\\u093e")
    .replace(/More times/g, "\\u0906\\u0923\\u0916\\u0940 \\u0935\\u0947\\u0933\\u093e")
    .replace(/Next date/g, "\\u092a\\u0941\\u0922\\u091a\\u0940 \\u0924\\u093e\\u0930\\u0940\\u0916")
    .replace(/Book Appointment/g, "\\u0905\\u092a\\u0949\\u0907\\u0902\\u091f\\u092e\\u0947\\u0902\\u091f \\u092c\\u0941\\u0915 \\u0915\\u0930\\u093e")
    .replace(/My appointments/g, "\\u092e\\u093e\\u091d\\u094d\\u092f\\u093e \\u0905\\u092a\\u0949\\u0907\\u0902\\u091f\\u092e\\u0947\\u0902\\u091f\\u094d\\u0938").replace(/\\u([0-9a-f]{4})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function shouldAskLanguageOnEntry(bot, jid, botId, text, config) {
  if (botId !== "1") return false; // link / QR entries (Bots 2-5) go straight to the bot's options
  if (botId === "4") return !bot.hotelBookingFlows?.[jid];
  if (botId === "2") {
    const value = String(text || "").trim();
    const normalized = SwasBot.normalize(value);
    const internalSalonAction = /^(?:b2|legacy)/i.test(value)
      || /book\s+appointment|appointment\s+book/i.test(normalized)
      || normalized.includes("\u0905\u092a\u0949\u0907\u0902\u091f\u092e\u0947\u0902\u091f")
      || normalized.includes("\u092c\u0941\u0915 \u0915\u0930\u093e");
    return !bot.bookingFlows?.[jid] && !internalSalonAction;
  }
  if (botId === "3") return !bot.interestFlows?.[jid];
  if (botId === "5") return true;
  if (botId !== "1") return false;
  // A saved language is only a fallback. Ask again at every new Bot 1 entry,
  // while keeping numbered menu picks and pagination inside the current flow.
  const value = String(text || "").trim();
  return !/^\d$/.test(value) && !/^__menu_page_[123]$/.test(value) && !/^legacy/i.test(value);
}

function intendedBotId(mobile, bot, jid, text, config, chatbotOn, contact) {
  if (!chatbotOn) return "";
  const settings = bot.config?.settings || {};
  const allowed = accountBots(mobile);
  const normalized = SwasBot.normalize(text);
  const visible = String(text || "").replace(/\u2063[\u200b\u200c]+\u2063/g, "").trim();
  if (allowed.has(4) && (bot.hotelBookingFlows?.[jid] || (settings.bot4Enabled && /^table\s+book\s+.+$/i.test(visible)))) return "4";
  if (allowed.has(2) && bot.bookingFlows?.[jid]) return "2";
  if (allowed.has(3) && (bot.interestFlows?.[jid] || text === "b3interested" || normalized === SwasBot.normalize(settings.bot3InterestedLabel || "Interested") || SwasBot.keywordList(settings.bot3Keywords).includes(normalized))) return settings.bot3Enabled ? "3" : "";
  const salonName = SwasBot.normalize(settings.bot2SalonName || "");
  const salonStart = [salonName, salonName.split(/\s+/)[0], "book", "b2book", "b2startmenu", "new booking", "click here to book", "click here to book again", "b2myappointments", "status", "my booking", "my bookings", "my appointment", "my appointments", "appointment status", "booking status", "manage appointment"].filter(Boolean).includes(normalized)
    || ((normalized.includes("cancel")) && (normalized.includes("appointment") || normalized.includes("booking")));
  if (allowed.has(2) && settings.bot2SalonEnabled) {
    if (salonStart) return "2";
    const probe = { ...bot, bookingFlows: structuredClone(bot.bookingFlows || {}), bookings: structuredClone(bot.bookings || []) };
    if (salonReply(probe, jid, text, contact, settings, mobile) !== null) return "2";
  }
  if (allowed.has(6) && settings.bot6Enabled && bot6Keywords(settings).includes(normalized)) return "6";
  if (allowed.has(5) && settings.bot5Enabled && (text === "b5continue" || SwasBot.keywordList(settings.bot5Keywords || "my details").includes(normalized))) return "5";
  if (allowed.has(4) && settings.bot4Enabled && SwasBot.keywordList(settings.bot4Keywords).includes(normalized)) return "4";
  const last = bot.sessions?.[jid] || 0;
  const action = SwasBot.matchMessage(text, config, { inSession: !!last, idleMs: last ? Date.now() - last : null, lang: bot.langs?.[jid] || "" });
  return action ? "1" : "";
}

/**
 * Config with the chatbot forced off: only the campaign footer STOP keyword stays live, plus a plain
 * "start" so an opted-out contact can re-subscribe (the compliance counterpart of STOP). No welcome,
 * rules or fallback — those are the chatbot add-on. "start" only (not "hi"), so a casual hello to a
 * bulk-only account isn't answered.
 */
function footerOnlyConfig(bot) {
  const { settings, rules, footerKeywords } = bot.config || {};
  const config = SwasBot.buildConfig({ ...settings, enabled: false }, rules, footerKeywords);
  config.startKeywords = SwasBot.keywordList("start");
  return config;
}

/** change: { op: "add" | "remove", entries: [...] } - the same shape the extension applies. */
function applyChange(list, { op, entries }) {
  if (op === "remove") return list.filter((entry) => !entries.includes(entry));
  const known = new Set(list.map((entry) => entry.toLowerCase()));
  return [...list, ...entries.filter((entry) => !known.has(entry.toLowerCase()))];
}

function record(mobile, bot, change) {
  if (!change.entries.length) return;
  bot.seq += 1;
  bot.changes.push({ ...change, seq: bot.seq });
  bot.unsubscribers = applyChange(bot.unsubscribers, change);
  save(mobile);
}

/**
 * Takes the extension's settings and Unsubscribers list and hands back the list changes it has not
 * applied yet. The server's list is the extension's with those pending changes on top.
 */
function sync(mobile, { config, unsubscribers, since = 0 } = {}) {
  const bot = load(mobile);
  if (config) {
    const previousSettings = bot.config?.settings || {};
    const settings = { ...(config.settings || {}) };
    const allowedBots = accountBots(mobile);
    if (!allowedBots.has(1)) settings.enabled = false;
    if (!allowedBots.has(2)) settings.bot2SalonEnabled = false;
    if (!allowedBots.has(3)) settings.bot3Enabled = false;
    if (!allowedBots.has(4)) settings.bot4Enabled = false;
    if (!allowedBots.has(5)) settings.bot5Enabled = false;
    if (!allowedBots.has(6)) settings.bot6Enabled = false;
    // Bot 1, Bot 2 and Bot 3 have independent switches; preserve every selected bot.
    settings.bot2SummaryIntervalMinutes = Math.min(1440, Math.max(0, Math.floor(Number(settings.bot2SummaryIntervalMinutes) || 0)));
    const destinationChanged = String(previousSettings.bot2NotifyNumber || "") !== String(settings.bot2NotifyNumber || "");
    const intervalChanged = Number(previousSettings.bot2SummaryIntervalMinutes || 20) !== settings.bot2SummaryIntervalMinutes;
    if (settings.bot2SalonEnabled && settings.bot2SummaryIntervalMinutes > 0 && (!previousSettings.bot2SalonEnabled || destinationChanged || intervalChanged || !bot.bot2SummaryNextAt)) {
      bot.bot2SummaryNextAt = Date.now() + summaryIntervalMs(settings);
    }
    if (!settings.bot2SummaryIntervalMinutes) bot.bot2SummaryNextAt = null;
    bot.config = { ...config, settings };
  }
  // A seq ahead of ours means the server's file was reset; start the extension over from nothing.
  const after = Number(since) > bot.seq ? 0 : Number(since) || 0;
  bot.changes = bot.changes.filter((change) => change.seq > after);
  if (Array.isArray(unsubscribers)) {
    bot.unsubscribers = bot.changes.reduce(applyChange, unsubscribers.map(String));
  }
  save(mobile);
  return { changes: bot.changes, seq: bot.seq, active: buildConfig(bot).enabled || !!bot.config?.settings?.bot2SalonEnabled || !!bot.config?.settings?.bot3Enabled || !!bot.config?.settings?.bot4Enabled || !!bot.config?.settings?.bot5Enabled || !!bot.config?.settings?.bot6Enabled };
}

function messageText(msg, bot, jid) {
  const content = normalizeMessageContent(msg.message) || {};
  if (content.locationMessage || content.liveLocationMessage) return "b4location";
  const menuButtonReply = (value) => {
    const id = String(value || "").trim();
    if (/^swas_lang_[12]$/.test(id)) return id.slice(-1);
    if (/^swas_menu_[1-6]$/.test(id)) return bot?.bookingFlows?.[jid] ? `legacy${id.slice(-1)}` : id.slice(-1);
    if (/^swas_page_[123]$/.test(id)) return bot?.bookingFlows?.[jid] ? "legacyoption" : `__menu_page_${id.slice(-1)}`;
    if (/^swas_more_[23]$/.test(id)) return bot?.bookingFlows?.[jid] ? "legacyoption" : `__menu_page_${id.slice(-1)}`;
    return "";
  };
  const salonSelection = (value) => {
    const id = String(value || "").trim();
    const indexed = /^swas_b2_(service|date|time)_(\d+)$/.exec(id);
    if (indexed) return `b2${indexed[1]}${indexed[2]}`;
    const cancel = /^swas_b2_cancel_booking_(.+)$/.exec(id);
    if (cancel) return `b2cancelbooking:${cancel[1]}`;
    return ({
      swas_b2_open_menu: "b2startmenu",
      swas_b2_start: "b2book",
      swas_b2_my_appointments: "b2myappointments",
      swas_b2_rebook_menu: "b2startmenu",
      swas_b2_manage_more: "b2managemore",
      swas_b2_cancel_confirm: "b2cancelconfirm",
      swas_b2_cancel_keep: "b2cancelkeep",
      swas_b2_services_more: "b2servicesmore",
      swas_b2_dates_more: "b2datesmore",
      swas_b2_times_more: "b2timesmore",
      swas_b2_next_date: "b2nextdate",
      swas_b2_confirm: "b2confirm",
      swas_b2_cancel: "b2cancel",
      swas_b3_interested: "b3interested",
      swas_b5_continue: "b5continue",
      swas_b4_start: "b4start",
      swas_b4_confirm: "b4confirm",
    })[id] || "";
  };
  const menuReply = (value) => {
    const normalized = SwasBot.normalize(value);
    const choices = new Map([
      ["free demo", "1"], ["मोफत डेमो", "1"],
      ["features", "2"], ["features benefits", "2"], ["वैशिष्ट्ये", "2"],
      ["how it works", "3"], ["कसे वापरावे", "3"],
      ["pricing", "4"], ["pricing plans", "4"], ["किंमत व योजना", "4"],
      ["contact", "5"], ["संपर्क", "5"],
      ["stop messages", "6"], ["संदेश बंद", "6"],
      ["more options", `__menu_page_${(bot?.menuPages?.[jid] || 1) === 1 ? 2 : 3}`],
      ["पुढील पर्याय", `__menu_page_${(bot?.menuPages?.[jid] || 1) === 1 ? 2 : 3}`],
      ["back", "__menu_page_2"], ["मागे", "__menu_page_2"],
    ]);
    const mapped = choices.get(normalized) || "";
    return mapped && bot?.bookingFlows?.[jid] ? `legacy${mapped.replace(/\W/g, "")}` : mapped;
  };
  const nativeReply = content.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (nativeReply?.paramsJson) {
    try {
      const selected = JSON.parse(nativeReply.paramsJson);
      const mappedMenuReply = menuButtonReply(selected.id);
      if (mappedMenuReply) return mappedMenuReply;
      if (selected.id === "swas_b4_start") return "b4start";
      if (selected.id === "swas_b4_confirm") return "b4confirm";
      const salonChoice = /^swas_b2_(service|date|time)_(\d+)$/.exec(String(selected.id || ""));
      if (salonChoice) return `b2${salonChoice[1]}${salonChoice[2]}`;
      const cancelBooking = /^swas_b2_cancel_booking_(.+)$/.exec(String(selected.id || ""));
      if (cancelBooking) return `b2cancelbooking:${cancelBooking[1]}`;
      if (selected.id === "swas_b2_manage_more") return "b2managemore";
      if (selected.id === "swas_b2_cancel_confirm") return "b2cancelconfirm";
      if (selected.id === "swas_b2_cancel_keep") return "b2cancelkeep";
      if (selected.id === "swas_b2_my_appointments") return "b2myappointments";
      if (selected.id === "swas_b2_rebook_menu") return "b2startmenu";
      const salonAction = { swas_b2_services_more: "b2servicesmore", swas_b2_dates_more: "b2datesmore", swas_b2_times_more: "b2timesmore", swas_b2_confirm: "b2confirm", swas_b2_cancel: "b2cancel" }[selected.id];
      if (salonAction) return salonAction;
      if (selected.id === "swas_b2_start") return "b2book";
      if (/^\d$/.test(String(selected.id || ""))) return bot?.bookingFlows?.[jid] ? `legacy${selected.id}` : String(selected.id);
      if (/^swas_lang_[12]$/.test(String(selected.id || ""))) return String(selected.id).slice(-1);
      if (/^swas_menu_[1-6]$/.test(String(selected.id || ""))) return bot?.bookingFlows?.[jid] ? `legacy${String(selected.id).slice(-1)}` : String(selected.id).slice(-1);
      if (/^swas_page_[123]$/.test(String(selected.id || ""))) return bot?.bookingFlows?.[jid] ? "legacyoption" : `__menu_page_${String(selected.id).slice(-1)}`;
      if (/^swas_more_[23]$/.test(String(selected.id || ""))) return bot?.bookingFlows?.[jid] ? "legacyoption" : `__menu_page_${String(selected.id).slice(-1)}`;
      const labelReply = menuReply(selected.display_text || selected.title || selected.id || "");
      if (labelReply) return labelReply;
      if (selected.row_id && /^\d$/.test(String(selected.row_id))) return String(selected.row_id);
    } catch {
      /* use the other message fields if WhatsApp sent malformed button data */
    }
  }
  const buttonIdReply = menuButtonReply(content.buttonsResponseMessage?.selectedButtonId || content.templateButtonReplyMessage?.selectedId);
  if (buttonIdReply) return buttonIdReply;
  const listSelection = content.listResponseMessage?.singleSelectReply?.selectedRowId;
  const mappedListMenuReply = menuButtonReply(listSelection);
  if (mappedListMenuReply) return mappedListMenuReply;
  const mappedSalonListSelection = salonSelection(listSelection);
  if (mappedSalonListSelection) return mappedSalonListSelection;
  if (/^\d$/.test(String(listSelection || ""))) return String(listSelection);
  if (/^swas_menu_[1-6]$/.test(String(listSelection || ""))) return String(listSelection).slice(-1);
  const text = (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedButtonId ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    ""
  );
  return menuButtonReply(text) || salonSelection(text) || menuReply(text) || text;
}

/** Reads numbered menu labels from the welcome text edited in Chatbot settings. */
/**
 * Bot 1's welcome heading. Accounts saved before "Bot 1 name" existed keep the old Starshift heading;
 * new accounts start blank and get a plain "Welcome!" until they name the bot.
 */
function welcomeTitle(settings = {}, lang = "mr") {
  const name = settings?.bot1Name === undefined ? "Starshift WA Sender" : String(settings.bot1Name || "").trim();
  if (lang === "en") return name ? `Welcome to ${name}!` : "Welcome!";
  return name ? `${name} मध्ये स्वागत आहे!` : "स्वागत आहे!";
}

// ---- Incoming WhatsApp calls: optionally reject them and point the caller to chat ----
const DEFAULT_CALL_MESSAGE = "🙏 क्षमस्व, आम्ही WhatsApp calls घेत नाही. कृपया तुमचा प्रश्न इथे message करा, आम्ही लवकरच reply करू.";

function callSettings(mobile) {
  const saved = load(mobile).callSettings || {};
  return { reject: !!saved.reject, message: saved.message ?? DEFAULT_CALL_MESSAGE };
}

function setCallSettings(mobile, input = {}) {
  load(mobile).callSettings = { reject: !!input.reject, message: String(input.message ?? "").slice(0, 1000) };
  save(mobile);
  return callSettings(mobile);
}

function menuLabelsFromText(value) {
  const labels = [];
  for (const line of String(value || "").split(/\r?\n/)) {
    const match = /^\s*[^\d]*([1-6])(?:\uFE0F?\u20E3)?\s*(.+?)\s*$/u.exec(line);
    if (!match) continue;
    const label = match[2].replace(/^[*_\s]+|[*_\s]+$/g, "").trim();
    if (label) labels[Number(match[1]) - 1] = label;
  }
  return labels;
}

function settingsNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? digits : "";
}

/** The bot numbers this account may use: the admin's ticks (1-10), or Bots 1..count for older accounts. */
function accountBots(mobile) {
  if (mobile === process.env.ADMIN_MOBILE) return new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const user = userStore.get(mobile);
  if (Array.isArray(user?.bots)) return new Set(user.bots.map(Number));
  const count = Number(user?.maxBots);
  const limit = Number.isInteger(count) && count >= 1 && count <= 5 ? count : 3;
  return new Set(Array.from({ length: limit }, (_, i) => i + 1));
}

/** Bot 6's link / QR text: its keywords, or its name when no keyword is set. */
function bot6Keywords(settings = {}) {
  return SwasBot.keywordList(settings.bot6Keywords || settings.bot6Name || "");
}

function hotelBookingNow() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  const hour = Number(get("hour")), minute = Number(get("minute"));
  const dateKey = `${get("year")}-${get("month")}-${get("day")}`;
  return { dateKey, date: `${get("day")}-${get("month")}-${get("year")}`, time: `${get("hour")}:${get("minute")}`, minuteOfDay: hour * 60 + minute };
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const rad = (value) => value * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function displayTime(date) {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(date);
}

function isHotelOpen(settings, now = hotelBookingNow()) {
  const toMinutes = (value) => {
    const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const open = toMinutes(settings.bot4OpenTime), close = toMinutes(settings.bot4CloseTime);
  if (open === null || close === null) return false;
  return open <= close ? now.minuteOfDay >= open && now.minuteOfDay < close : now.minuteOfDay >= open || now.minuteOfDay < close;
}

function hotelQueueWaitMinutes(branch, bookings, members, waitMinutes, now = Date.now()) {
  const tableCount = Math.floor(Number(branch.tableCount) || 0);
  const seatingCapacity = Math.floor(Number(branch.seatingCapacity) || 0);
  if (tableCount < 1 || seatingCapacity < 1) return bookings.filter((entry) => ["Pending", "Confirmed"].includes(entry.status)).length * Math.max(1, Number(waitMinutes) || 15);
  const cycleMs = Math.max(1, Number(waitMinutes) || 15) * 60000;
  const schedule = [];
  const arrivalOf = (entry) => {
    const created = Number(entry.createdAt);
    if (Number.isFinite(created) && created > 0) return created;
    const time = /^(\d{2}:\d{2})/.exec(String(entry.time || ""))?.[1];
    const date = String(entry.dateKey || entry.date || "");
    const parsed = time && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T${time}:00+05:30`) : NaN;
    return Number.isFinite(parsed) ? parsed : now;
  };
  const findSlot = (arrival, partySize) => {
    const party = Math.max(1, Math.min(seatingCapacity, Math.floor(Number(partySize) || 1)));
    let candidate = arrival;
    for (let attempt = 0; attempt <= schedule.length + 1; attempt++) {
      const end = candidate + cycleMs;
      const overlapping = schedule.filter((slot) => slot.start < end && slot.end > candidate);
      const points = [candidate, ...overlapping.flatMap((slot) => [slot.start, slot.end]).filter((point) => point > candidate && point < end)];
      let conflictAt = null;
      for (const point of points) {
        const active = schedule.filter((slot) => slot.start <= point && slot.end > point);
        if (active.length >= tableCount || active.reduce((total, slot) => total + slot.members, 0) + party > seatingCapacity) { conflictAt = point; break; }
      }
      if (conflictAt === null) return candidate;
      const blockers = schedule.filter((slot) => slot.start <= conflictAt && slot.end > conflictAt);
      const next = Math.min(...blockers.map((slot) => slot.end).filter((time) => time > candidate));
      candidate = Number.isFinite(next) ? next : candidate + cycleMs;
    }
    return candidate;
  };
  const queue = bookings.filter((entry) => ["Pending", "Confirmed"].includes(entry.status))
    .sort((a, b) => arrivalOf(a) - arrivalOf(b) || (Number(a.queueNo) || 0) - (Number(b.queueNo) || 0));
  for (const entry of queue) {
    const start = findSlot(arrivalOf(entry), entry.members);
    schedule.push({ start, end: start + cycleMs, members: Math.max(1, Math.min(seatingCapacity, Math.floor(Number(entry.members) || 1))) });
  }
  const start = findSlot(now, members);
  return Math.max(0, Math.ceil((start - now) / 60000));
}

function isBranchHotelOpen(branch, now = hotelBookingNow()) {
  const toMinutes = (value) => {
    const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const open = toMinutes(branch?.openTime), close = toMinutes(branch?.closeTime);
  if (open === null || close === null) return false;
  return open <= close ? now.minuteOfDay >= open && now.minuteOfDay < close : now.minuteOfDay >= open || now.minuteOfDay < close;
}

function summaryIntervalMs(settings = {}) {
  const minutes = Math.floor(Number(settings.bot2SummaryIntervalMinutes) || 0);
  return minutes > 0 ? Math.min(1440, minutes) * 60 * 1000 : 0;
}

function salonDateKey(value) {
  const raw = String(value || "").trim();
  const nowParts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const today = `${nowParts.find((p) => p.type === "year").value}-${nowParts.find((p) => p.type === "month").value}-${nowParts.find((p) => p.type === "day").value}`;
  if (/^(today|aaj|आज)$/i.test(raw)) return today;
  if (/^(tomorrow|udya|उद्या)$/i.test(raw)) return new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  let year, month, day, m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw))) [, year, month, day] = m;
  else if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw))) [, day, month, year] = m; // Indian day/month/year
  else if ((m = /^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i.exec(raw))) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    month = months.findIndex((name) => name === m[2].slice(0, 3).toLowerCase()) + 1;
    [, day, , year] = m;
  } else return null;
  year = Number(year); month = Number(month); day = Number(day);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const key = date.toISOString().slice(0, 10);
  return key >= today ? key : null;
}

function salonTime(value) {
  const raw = String(value || "").trim().toLowerCase();
  let m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(raw);
  let minutes;
  if (m) {
    let hour = Number(m[1]) % 12;
    if (m[3] === "pm") hour += 12;
    minutes = hour * 60 + Number(m[2] || 0);
  } else if ((m = /^(\d{1,2}):(\d{2})$/.exec(raw)) && Number(m[1]) < 24 && Number(m[2]) < 60) {
    minutes = Number(m[1]) * 60 + Number(m[2]);
  } else return null;
  return { minutes, label: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}` };
}

function salonDayAllowed(dateKey, hours) {
  const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const day = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  const text = String(hours || "").toLowerCase();
  const token = /(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)/g;
  const matches = [...text.matchAll(token)].map((m) => names.findIndex((n) => n === m[1].slice(0, 3)));
  if (matches.length >= 2 && /-|–|—|\bto\b/.test(text)) {
    const start = matches[0], end = matches[1];
    for (let current = start; ; current = (current + 1) % 7) {
      if (current === day) return true;
      if (current === end) break;
    }
    return false;
  }
  return true;
}

function salonDateChoices(hours, startDate, count = 7) {
  const nowParts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const today = `${nowParts.find((p) => p.type === "year").value}-${nowParts.find((p) => p.type === "month").value}-${nowParts.find((p) => p.type === "day").value}`;
  const nowMinutes = Number(nowParts.find((p) => p.type === "hour").value) * 60 + Number(nowParts.find((p) => p.type === "minute").value);
  const hoursMatch = [...String(hours || "").toLowerCase().matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/g)].slice(0, 2);
  const closingMinutes = hoursMatch.length >= 2
    ? ((Number(hoursMatch[1][1]) % 12) + (hoursMatch[1][3] === "pm" ? 12 : 0)) * 60 + Number(hoursMatch[1][2] || 0)
    : null;
  const afterClosing = closingMinutes !== null && nowMinutes >= closingMinutes;
  const earliestDate = afterClosing
    ? new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
    : today;
  const firstDate = /^\d{4}-\d{2}-\d{2}$/.test(String(startDate || "")) && startDate > earliestDate ? startDate : earliestDate;
  const choices = [];
  for (let offset = 0; offset <= 45 && choices.length < count; offset++) {
    const key = new Date(Date.parse(`${firstDate}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
    if (salonDayAllowed(key, hours)) choices.push(key);
  }
  return choices;
}

function salonWorkerCount(settings, dateKey) {
  const overrides = Array.isArray(settings.bot2WorkerSchedule) ? settings.bot2WorkerSchedule : [];
  const match = overrides.find((entry) => entry?.date === dateKey);
  const count = Number(match?.workers ?? settings.bot2DefaultWorkers ?? 1);
  return Math.min(10, Math.max(1, Number.isFinite(count) ? Math.floor(count) : 1));
}

function salonBreakInterval(settings = {}) {
  const parse = (value) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const from = parse(settings.bot2BreakFrom), to = parse(settings.bot2BreakTo);
  return from !== null && to !== null && from < to ? { from, to } : null;
}

function salonTimeChoices(hours, bot, dateKey, settings = {}) {
  const matches = [...String(hours || "").toLowerCase().matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/g)].slice(0, 2);
  if (matches.length < 2) return [];
  const toMinutes = (m) => ((Number(m[1]) % 12) + (m[3] === "pm" ? 12 : 0)) * 60 + Number(m[2] || 0);
  const [opens, closes] = matches.map(toMinutes);
  const nowParts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const today = `${nowParts.find((p) => p.type === "year").value}-${nowParts.find((p) => p.type === "month").value}-${nowParts.find((p) => p.type === "day").value}`;
  const nowMinutes = Number(nowParts.find((p) => p.type === "hour").value) * 60 + Number(nowParts.find((p) => p.type === "minute").value);
  const count = salonWorkerCount(settings, dateKey);
  const breakInterval = salonBreakInterval(settings);
  const taken = new Set((bot.bookings || [])
    .filter((b) => b.status === "confirmed" && (b.dateKey || salonDateKey(b.date)) === dateKey)
    .map((b) => `${b.timeKey || salonTime(b.time)?.label}|${b.worker || "Worker 1"}`));
  const choices = [];
  for (let minutes = opens; minutes <= closes; minutes += 30) {
    const hour = Math.floor(minutes / 60);
    const key = `${String(hour).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const label = `${hour % 12 || 12}:${String(minutes % 60).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
    const past = dateKey === today && minutes <= nowMinutes;
    // Do not offer elapsed slots for appointments scheduled today.
    if (!past && !(breakInterval && minutes >= breakInterval.from && minutes < breakInterval.to)) {
      for (let worker = 1; worker <= count; worker++) {
        const workerName = `Worker ${worker}`;
        if (!taken.has(`${key}|${workerName}`)) {
          choices.push({ key, timeLabel: label, worker: workerName, label: `${label} · ${workerName}`, booked: false, past: false });
        }
      }
    }
  }
  return choices;
}

function salonDateLabel(key) {
  const [year, month, day] = key.split("-");
  return `${day} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(month) - 1]} ${year}`;
}

function salonServiceButtonLabel(service) {
  const match = /^(.+?)\s*[-–:]\s*(?:₹\s*|rs\.?\s*)?(\d+(?:\.\d+)?)$/i.exec(service);
  return (match ? `${match[1].trim()} ₹${match[2]}` : service).slice(0, 20);
}

function salonMessageTemplate(value, booking, salonName) {
  const fields = {
    name: booking.name || "",
    salon: salonName || "our salon",
    service: booking.service || "",
    date: booking.date || "",
    time: booking.time || "",
  };
  return String(value || "").replace(/\{\{\s*(name|salon|service|date|time)\s*\}\}/gi, (_match, key) => fields[key.toLowerCase()]);
}

function salonChoicePage(values, page, kind, labelFor, details = "") {
  const pageSize = 2;
  const start = page * pageSize;
  const slice = values.slice(start, start + pageSize);
  const choices = slice.map((value, index) => ({ id: `swas_b2_${kind}_${start + index}`, title: salonForwardTitle(labelFor(value)) }));
  if (start + pageSize < values.length) {
    const more = kind === "service" ? "services" : kind === "date" ? "dates" : "times";
    choices.push({ id: `swas_b2_${more}_more`, title: salonForwardTitle(more === "services" ? "More services" : more === "dates" ? "More dates" : "More times") });
  }
  const salonName = String(details || "").replace(/^[^\p{L}\p{N}]*/u, "").trim() || "our salon";
  const heading = kind === "service"
    ? `💈 *Welcome to ${salonName}!*\nThank you for choosing us.\n\nPlease choose a service to book your appointment.`
    : kind === "date" ? "📅 *Choose an appointment date*" : "⏰ *Choose an appointment time*\n🟢 Available worker slots";
  const prompt = `${heading}${kind !== "service" && details ? `\n${details}` : ""}`;
  return { reply: prompt, choices };
}

function salonTimeChoicePage(flow, settings) {
  const page = salonChoicePage(flow.timeChoices || [], flow.timePage || 0, "time", salonTimeChoiceLabel, `${flow.service} · ${flow.date}`);
  const lastPage = (flow.timePage || 0) * 2 + 2 >= (flow.timeChoices || []).length;
  if (lastPage) {
    page.choices.push({ id: "swas_b2_next_date", title: salonForwardTitle("Next date") });
  }
  return page;
}

function salonForwardTitle(title) {
  return `→ ${String(title || "")}`.slice(0, 20);
}

function salonTimeChoiceLabel(slot) {
  const customerLabel = slot.timeLabel || slot.label;
  return slot.booked ? `🔴 Booked ${customerLabel}` : slot.past ? `🔴 Past ${customerLabel}` : `🟢 ${customerLabel}`;
}

function salonTimeAllowed(timeMinutes, hours, settings = {}) {
  const text = String(hours || "").toLowerCase();
  const matches = [...text.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/g)].slice(0, 2);
  if (matches.length < 2) return true;
  const asMinutes = (m) => ((Number(m[1]) % 12) + (m[3] === "pm" ? 12 : 0)) * 60 + Number(m[2] || 0);
  const [opens, closes] = matches.map(asMinutes);
  const breakInterval = salonBreakInterval(settings);
  return timeMinutes >= opens && timeMinutes <= closes && !(breakInterval && timeMinutes >= breakInterval.from && timeMinutes < breakInterval.to);
}

function salonCustomerBookings(bot, number) {
  const customerNumber = String(number || "").replace(/\D/g, "");
  if (!customerNumber) return [];
  return (bot.bookings || []).filter((booking) => String(booking.number || "").replace(/\D/g, "") === customerNumber);
}

function salonBookingTime(booking) {
  const parsed = salonTime(booking.timeKey || booking.time);
  if (!parsed) return String(booking.time || "Time unavailable");
  const hour = Math.floor(parsed.minutes / 60);
  return `${hour % 12 || 12}:${String(parsed.minutes % 60).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

function salonBookingDate(booking) {
  const key = booking.dateKey || salonDateKey(booking.date);
  return key ? salonDateLabel(key) : String(booking.date || "Date unavailable");
}

const summaryInFlight = new Set();
const dailyReportInFlight = new Set();

function salonNowParts() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  return {
    date: `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}-${parts.find((part) => part.type === "day").value}`,
    minutes: Number(parts.find((part) => part.type === "hour").value) * 60 + Number(parts.find((part) => part.type === "minute").value),
  };
}

function summaryChunks(bot, settings, now, lastSentAt) {
  const { date: today, minutes: currentMinutes } = salonNowParts();
  const bookings = (bot.bookings || []).filter((booking) => {
    const key = booking.dateKey || salonDateKey(booking.date);
    if (booking.status === "cancelled") return Number(booking.cancelledAt || 0) > lastSentAt;
    if (booking.status !== "confirmed" || !key || key < today) return false;
    if (key > today) return true;
    const time = salonTime(booking.timeKey || booking.time);
    return !time || time.minutes >= currentMinutes;
  });
  if (!bookings.length) return [];
  const lines = bookings.map((booking) => {
    const cancelled = booking.status === "cancelled";
    return `${cancelled ? "❌ Cancelled" : "✅ Booked"}: ${salonBookingDate(booking)} · ${salonBookingTime(booking)} · ${booking.service || "Service"} · ${booking.name || "Customer"} · ${booking.number || "No number"} · ${booking.worker || "Worker 1"}`;
  });
  const header = `📋 ${settings.bot2SalonName || "Salon"} — booking update\n${new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date(now))}\n\n`;
  const chunks = [];
  let body = header;
  for (const line of lines) {
    if (body.length + line.length + 1 > 3200 && body !== header) {
      chunks.push(body);
      body = `${header}(continued)\n`;
    }
    body += `${line}\n`;
  }
  if (body !== header) chunks.push(body.trimEnd());
  return chunks;
}

async function sendBookingSummaries() {
  let files = [];
  try { files = fs.readdirSync(BOTS_DIR).filter((file) => /^\d+\.json$/.test(file)); } catch { return; }
  for (const file of files) {
    const mobile = file.slice(0, -5);
    if (summaryInFlight.has(mobile)) continue;
    const bot = load(mobile);
    const settings = bot.config?.settings || {};
    const ownerNumber = settingsNumber(settings.bot2NotifyNumber);
    if (!settings.bot2SalonEnabled || !ownerNumber || summaryIntervalMs(settings) <= 0) continue;
    const now = Date.now();
    if (!bot.bot2SummaryNextAt) {
      bot.bot2SummaryNextAt = now + summaryIntervalMs(settings);
      save(mobile);
      continue;
    }
    if (now < bot.bot2SummaryNextAt) continue;
    summaryInFlight.add(mobile);
    try {
      const chunks = summaryChunks(bot, settings, now, Number(bot.bot2SummaryLastSentAt || 0));
      if (chunks.length) {
        const wa = require("./waSessions");
        for (const chunk of chunks) await wa.sendText(mobile, ownerNumber, chunk);
      }
      bot.bot2SummaryLastSentAt = now;
      bot.bot2SummaryNextAt = now + summaryIntervalMs(settings);
      save(mobile);
    } catch (error) {
      console.warn(`[bot ${mobile}] booking summary failed:`, error.message || error);
    } finally {
      summaryInFlight.delete(mobile);
    }
  }
}

setInterval(() => { sendBookingSummaries().catch((error) => console.warn("Booking summary scheduler failed:", error.message || error)); }, 60 * 1000).unref();

function dailyBookingReport(bot, dateKey) {
  const headers = ["Date", "Time", "Customer", "Mobile", "Service", "Worker", "Status", "Booked at"];
  const bookings = (bot.bookings || [])
    .filter((booking) => (booking.dateKey || salonDateKey(booking.date)) === dateKey)
    .sort((a, b) => String(a.timeKey || a.time || "").localeCompare(String(b.timeKey || b.time || "")));
  const rows = bookings.map((booking) => [
    salonBookingDate(booking),
    salonBookingTime(booking),
    booking.name || "",
    booking.number || "",
    booking.service || "",
    booking.worker || "Worker 1",
    booking.status === "cancelled" ? "Cancelled" : "Booked",
    booking.createdAt ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "medium" }).format(new Date(booking.createdAt)) : "",
  ]);
  const workbook = XLSX.utils.book_new();
  const booked = [headers, ...rows.filter((row) => row[6] !== "Cancelled")];
  const cancelled = [headers, ...rows.filter((row) => row[6] === "Cancelled")];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(booked), "Booked");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(cancelled), "Cancelled");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const salon = String(bot.config?.settings?.bot2SalonName || "salon")
    .normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "salon";
  return {
    buffer,
    fileName: `${salon}-appointments-${dateKey}.xlsx`,
    bookings: rows.length,
    booked: rows.filter((row) => row[6] !== "Cancelled").length,
    cancelled: rows.filter((row) => row[6] === "Cancelled").length,
  };
}

async function sendDailyBookingReports() {
  let files = [];
  try { files = fs.readdirSync(BOTS_DIR).filter((file) => /^\d+\.json$/.test(file)); } catch { return; }
  const now = salonNowParts();
  if (now.minutes < (23 * 60 + 59)) return;
  for (const file of files) {
    const mobile = file.slice(0, -5);
    if (dailyReportInFlight.has(mobile)) continue;
    const bot = load(mobile);
    const settings = bot.config?.settings || {};
    const ownerNumber = settingsNumber(settings.bot2NotifyNumber);
    if (!settings.bot2SalonEnabled || !ownerNumber || bot.bot2DailyReportLastSentDate === now.date) continue;
    dailyReportInFlight.add(mobile);
    try {
      const report = dailyBookingReport(bot, now.date);
      const wa = require("./waSessions");
      const caption = `${settings.bot2SalonName || "Salon"} — ${salonDateLabel(now.date)} report\n${report.booked} booked · ${report.cancelled} cancelled`;
      await wa.sendDocument(mobile, ownerNumber, report.buffer, report.fileName, caption);
      bot.bot2DailyReportLastSentDate = now.date;
      save(mobile);
      console.log(`[bot ${mobile}] sent daily appointment report for ${now.date} to owner`);
    } catch (error) {
      console.warn(`[bot ${mobile}] daily appointment report failed:`, error.message || error);
    } finally {
      dailyReportInFlight.delete(mobile);
    }
  }
}

setInterval(() => { sendDailyBookingReports().catch((error) => console.warn("Daily booking report scheduler failed:", error.message || error)); }, 15 * 1000).unref();

function interestedLeadsReport(bot, dateKey) {
  const rows = (bot.interestedLeads || []).filter((lead) => {
    const createdDate = lead.createdAt ? salonNowPartsForDate(lead.createdAt) : "";
    const [day, month, year] = String(lead.date || "").split("-");
    return createdDate === dateKey || `${year}-${String(month || "").padStart(2, "0")}-${String(day || "").padStart(2, "0")}` === dateKey;
  }).map((lead) => [lead.name || "", lead.number || "", lead.city || "", lead.date || "", lead.time || "", lead.status || (lead.duplicate ? "Duplicate" : "New")]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Name", "Mobile", "City", "Date", "Time", "Status"], ...rows]), "Enquiries");
  const company = String(bot.config?.settings?.bot3CompanyName || "Interested leads").normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "interested-leads";
  return { buffer: XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }), fileName: `${company}-enquiries-${dateKey}.xlsx`, count: rows.length };
}

function salonNowPartsForDate(timestamp) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
}

async function sendDailyInterestedLeadReports() {
  let files = [];
  try { files = fs.readdirSync(BOTS_DIR).filter((file) => /^\d+\.json$/.test(file)); } catch { return; }
  const now = salonNowParts();
  for (const file of files) {
    const mobile = file.slice(0, -5);
    const bot = load(mobile);
    const settings = bot.config?.settings || {};
    if (!settings.bot3Enabled || !accountBots(mobile).has(3)) continue;
    const sendAt = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(settings.bot3ReportTime || "")) ? String(settings.bot3ReportTime).split(":").map(Number).reduce((h, m) => h * 60 + m) : -1;
    if (sendAt < 0 || dailyReportInFlight.has(`leads:${mobile}`)) continue;
    const waRecipient = settingsNumber(settings.bot3NotifyNumber);
    const emailRecipient = String(settings.bot3ReportEmail || "").trim();
    if (!waRecipient && !emailRecipient) continue;
    const waDone = !waRecipient || bot.bot3ReportLastSentDate === now.date;
    const emailDone = !emailRecipient || bot.bot3EmailReportLastSentDate === now.date;
    const finalDue = now.minutes >= sendAt && (!waDone || !emailDone);
    const beforeFinal = now.minutes < sendAt;
    const intervalMinutes = Math.min(1440, Math.max(1, Math.floor(Number(settings.bot3ReportIntervalMinutes) || 60)));
    const report = interestedLeadsReport(bot, now.date);
    const waLastAt = Number(bot.bot3PeriodicReportWaAt) || 0;
    const emailLastAt = Number(bot.bot3PeriodicReportEmailAt) || 0;
    const firstLeadTodayAt = (bot.interestedLeads || []).reduce((first, lead) => lead.createdAt && salonNowPartsForDate(lead.createdAt) === now.date ? Math.min(first, Number(lead.createdAt)) : first, Infinity);
    const waIntervalBase = waLastAt && salonNowPartsForDate(waLastAt) === now.date ? waLastAt : firstLeadTodayAt;
    const emailIntervalBase = emailLastAt && salonNowPartsForDate(emailLastAt) === now.date ? emailLastAt : firstLeadTodayAt;
    const periodicWaDue = beforeFinal && !!waRecipient && report.count > 0 && Number.isFinite(waIntervalBase) && Date.now() - waIntervalBase >= intervalMinutes * 60000;
    const periodicEmailDue = beforeFinal && !!emailRecipient && report.count > 0 && Number.isFinite(emailIntervalBase) && Date.now() - emailIntervalBase >= intervalMinutes * 60000;
    if (!finalDue && !periodicWaDue && !periodicEmailDue) continue;
    dailyReportInFlight.add(`leads:${mobile}`);
    try {
      if (finalDue ? !waDone : periodicWaDue) {
        await require("./waSessions").sendDocument(mobile, waRecipient, report.buffer, report.fileName, `${settings.bot3CompanyName || "Customer enquiries"} - ${now.date} - ${report.count} enquiry/enquiries${finalDue ? " - FINAL DAILY REPORT" : " - Updated report"}`);
        if (finalDue) bot.bot3ReportLastSentDate = now.date;
        else bot.bot3PeriodicReportWaAt = Date.now();
        save(mobile);
      }
      if (finalDue ? !emailDone : periodicEmailDue) {
        if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
          if (bot.bot3EmailSetupNoticeDate !== now.date) {
            console.warn(`[bot ${mobile}] lead email report configured but server SMTP is missing (SMTP_HOST, SMTP_USER, SMTP_PASS).`);
            bot.bot3EmailSetupNoticeDate = now.date;
          }
          // Mark it handled so the 15-second scheduler doesn't retry an email it cannot send.
          if (finalDue) bot.bot3EmailReportLastSentDate = now.date;
          else bot.bot3PeriodicReportEmailAt = Date.now();
          save(mobile);
        } else {
          const nodemailer = require("nodemailer");
          const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT) || 587, secure: process.env.SMTP_SECURE === "true", auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
          await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: emailRecipient, subject: `${settings.bot3CompanyName || "Customer enquiries"} - ${now.date}${finalDue ? " - FINAL DAILY REPORT" : " - Updated report"}`, text: `Attached are ${report.count} customer enquiries received on ${now.date}.`, attachments: [{ filename: report.fileName, content: report.buffer, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }] });
          if (finalDue) bot.bot3EmailReportLastSentDate = now.date;
          else bot.bot3PeriodicReportEmailAt = Date.now();
          save(mobile);
        }
      }
      console.log(`[bot ${mobile}] sent ${finalDue ? "final daily" : "periodic"} interested-lead report for ${now.date}`);
    } catch (error) {
      console.warn(`[bot ${mobile}] interested-lead report failed:`, error.message || error);
    } finally {
      dailyReportInFlight.delete(`leads:${mobile}`);
    }
  }
}

setInterval(() => { sendDailyInterestedLeadReports().catch((error) => console.warn("Daily interested-lead report scheduler failed:", error.message || error)); }, 15 * 1000).unref();

async function notifyInterestedLead(mobile, settings, lead) {
  const recipient = settingsNumber(settings.bot3NotifyNumber);
  if (!recipient) return;
  const text = `${settings.bot3CompanyName || "New enquiry"}\n${lead.status || "New"} enquiry\nName: ${lead.name || "WhatsApp user"}\nMobile: ${lead.number || ""}\nCity: ${lead.city || ""}\nDate: ${lead.date || ""} ${lead.time || ""}`;
  try { await require("./waSessions").sendText(mobile, recipient, text); }
  catch (error) { console.warn(`[bot ${mobile}] interested-lead notification failed:`, error.message || error); }
}

function salonBookingStatusMessage(bookings, page = 0) {
  const active = bookings.filter((booking) => booking.status === "confirmed");
  const start = page * 2;
  const pageBookings = active.slice(start, start + 2);
  const details = active.map((booking) => `• ${booking.service} — ${salonBookingDate(booking)}, ${salonBookingTime(booking)} — Confirmed`).join("\n");
  const choices = pageBookings.map((booking) => ({ id: `swas_b2_cancel_booking_${booking.id}`, title: salonForwardTitle(`Cancel ${salonBookingTime(booking)}`) }));
  if (start + 2 < active.length) choices.push({ id: "swas_b2_manage_more", title: salonForwardTitle("More appointments") });
  const result = { reply: `📋 *Your appointments*\n${details || "There are no active appointments."}${active.length ? "\n\nTap an appointment below if you want to cancel it." : ""}` };
  if (choices.length) result.choices = choices;
  return result;
}

/** WhatsApp salon booking flow. Accepts services as one per line or comma-separated. */
function salonReply(bot, jid, text, contact, settings, ownerNumber = "") {
  if (!settings?.bot2SalonEnabled) return null;
  const input = SwasBot.normalize(text);
  if (SwasBot.keywordList(settings.stopKeywords).includes(input) || SwasBot.keywordList(settings.startKeywords).includes(input)) return null;
  const flow = (bot.bookingFlows || (bot.bookingFlows = {}))[jid];
  if (["cancel", "cancel booking", "b2cancel", "swas b2 cancel", "रद्द", "रद्द करा"].includes(input) && flow) {
    delete bot.bookingFlows[jid];
    return "Booking cancelled. To start again, tap *Book* or send BOOK.";
  }
  const asksToCancel = input.includes("cancel") || input.includes("रद्द");
  const manageIntent = ["b2myappointments", "status", "my booking", "my bookings", "my appointment", "my appointments", "appointment status", "booking status", "manage appointment", "माझी booking", "माझे booking", "माझी appointment"].includes(input)
    || (asksToCancel && (input.includes("appointment") || input.includes("booking")));
  if (manageIntent) {
    const bookings = salonCustomerBookings(bot, contact.number);
    if (!bookings.length) return "There are no appointments linked to this WhatsApp number yet. Send hi to see available services.";
    const active = bookings.filter((booking) => booking.status === "confirmed");
    if (asksToCancel && !active.length) return "You have no confirmed appointments to cancel.";
    if (asksToCancel && active.length) {
      bot.bookingFlows[jid] = { step: "manage", managePage: 0 };
      return salonBookingStatusMessage(bookings, 0);
    }
    const message = salonBookingStatusMessage(bookings, 0);
    bot.bookingFlows[jid] = { step: "manage", managePage: 0 };
    return message;
  }
  const salonName = SwasBot.normalize(settings.bot2SalonName || "");
  const salonWakeWord = salonName.split(/\s+/)[0] || "";
  if ([salonName, salonWakeWord, "book", "b2startmenu", "new booking", "click here to book", "click here to book again"].filter(Boolean).includes(input)) {
    delete bot.bookingFlows[jid];
    const choices = [
      { id: "swas_b2_start", title: salonForwardTitle("Book Appointment") },
      { id: "swas_b2_my_appointments", title: salonForwardTitle("My appointments") },
    ];
    return { reply: String(settings.bot2StartMessage || "").trim() ? String(settings.bot2StartMessage).replace(/\{\{\s*(salon|shop)\s*\}\}/gi, settings.bot2SalonName || "Salon") : `💈 *${settings.bot2SalonName || "Salon"}*\nWelcome! Choose an option below.`, choices };
  }
  const wantsBooking = flow?.step !== "confirm" && (/((^| )(book|booking)( |$))/.test(input) || input === "b2book" || input.includes("\u0905\u092a\u0949\u0907\u0902\u091f\u092e\u0947\u0902\u091f") || input.includes("\u092c\u0941\u0915\u093f\u0902\u0917") || input.includes("\u092c\u0941\u0915 \u0915\u0930\u093e"));
  if (wantsBooking) {
    const services = String(settings.bot2SalonServices || "").split(/\r?\n|;|,\s*(?=[\p{L}])/u).map((s) => s.trim()).filter(Boolean);
    if (!services.length) return "सलूनची सेवा यादी अजून जोडलेली नाही. कृपया थेट सलूनशी संपर्क करा.";
    bot.bookingFlows[jid] = { step: "service", services, name: "", number: contact.number, servicePage: 0 };
    return salonChoicePage(services, 0, "service", salonServiceButtonLabel, `💈 ${settings.bot2SalonName || "Salon"}`);
  }
  if (!flow) return null;
  if (flow.step === "manage") {
    const bookings = salonCustomerBookings(bot, contact.number);
    if (input === "b2managemore" || input === "more appointments") {
      flow.managePage = (flow.managePage || 0) + 1;
      if (flow.managePage * 2 >= bookings.filter((booking) => booking.status === "confirmed").length) flow.managePage = 0;
      return salonBookingStatusMessage(bookings, flow.managePage);
    }
    const cancelMatch = /^b2cancelbooking:(.+)$/.exec(String(text));
    const rawCancel = String(text).match(/cancel\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
    const normalizedCancel = input.match(/^cancel\s+(\d{1,2})(?:\s+(\d{2}))?\s*(am|pm)$/i);
    const cancelTimeText = rawCancel?.[1] || (normalizedCancel ? `${normalizedCancel[1]}:${normalizedCancel[2] || "00"} ${normalizedCancel[3]}` : "");
    const visibleCancel = cancelTimeText ? salonTime(cancelTimeText)?.label : "";
    if (cancelMatch || visibleCancel) {
      const selectedTime = visibleCancel || "";
      const visiblePage = bookings.filter((item) => item.status === "confirmed").slice((flow.managePage || 0) * 2, (flow.managePage || 0) * 2 + 2);
      const booking = bookings.find((item) => item.id === cancelMatch?.[1] && item.status === "confirmed")
        || visiblePage.find((item) => salonTime(item.timeKey || item.time)?.label === selectedTime);
      if (!booking) return { reply: "I couldn't match that time. Please choose one of the Cancel time buttons again:", choices: salonBookingStatusMessage(bookings, flow.managePage || 0).choices || [] };
      flow.step = "cancelConfirm";
      flow.cancelBookingId = booking.id;
      return { reply: `Cancel this appointment?\n${booking.service}\n${salonBookingDate(booking)} at ${salonBookingTime(booking)}`, choices: [{ id: "swas_b2_cancel_confirm", title: salonForwardTitle("Yes, cancel") }, { id: "swas_b2_cancel_keep", title: "Keep appointment" }] };
    }
    return null;
  }
  if (flow.step === "cancelConfirm") {
    const booking = salonCustomerBookings(bot, contact.number).find((item) => item.id === flow.cancelBookingId && item.status === "confirmed");
    if (input === "b2cancelkeep" || input === "keep appointment") {
      delete bot.bookingFlows[jid];
      return "Your appointment is still confirmed.";
    }
    if (input !== "b2cancelconfirm" && input !== "confirm cancellation" && input !== "yes cancel") return null;
    if (!booking) { delete bot.bookingFlows[jid]; return "This appointment is no longer confirmed."; }
    booking.status = "cancelled";
    booking.cancelledAt = Date.now();
    delete bot.bookingFlows[jid];
    return { reply: `🙏 तुमची appointment cancel झाली आहे.\n\n✂️ सेवा: ${booking.service}\n📅 तारीख: ${salonBookingDate(booking)}\n⏰ वेळ: ${salonBookingTime(booking)}\n\nआम्हाला आधी कळवल्याबद्दल धन्यवाद! 💈 लवकरच पुन्हा भेट द्या.\n\nपुन्हा appointment book करण्यासाठी खालील बटणावर क्लिक करा.`, choices: [{ id: "swas_b2_rebook_menu", title: salonForwardTitle("Click here to book") }], persist: true };
  }
  if (flow.step === "service") {
    if (["b2servicesmore", "more services", "swas b2 services more"].includes(input)) {
      flow.servicePage = ((flow.servicePage || 0) + 1) % Math.max(1, Math.ceil(flow.services.length / 2));
      return salonChoicePage(flow.services, flow.servicePage, "service", salonServiceButtonLabel, `💈 ${settings.bot2SalonName || "Salon"}`);
    }
    const buttonChoice = /^b2service(\d+)$/.exec(input) || /^swas b2 service (\d+)$/.exec(input);
    const labelChoice = flow.services.findIndex((service) => [service, salonServiceButtonLabel(service)].some((label) => SwasBot.normalize(label) === input));
    const index = buttonChoice ? Number(buttonChoice[1]) : labelChoice >= 0 ? labelChoice : Number(input) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= flow.services.length) return null;
    flow.service = flow.services[index]; flow.step = "date";
    flow.dateChoices = salonDateChoices(settings.bot2SalonHours, settings.bot2StartDate, 45);
    flow.datePage = 0;
    return salonChoicePage(flow.dateChoices, flow.datePage, "date", salonDateLabel, `Service: ${flow.service}`);
  }
  if (flow.step === "date") {
    if (["b2datesmore", "more dates", "swas b2 dates more"].includes(input)) {
      flow.datePage = ((flow.datePage || 0) + 1) % Math.max(1, Math.ceil((flow.dateChoices || []).length / 2));
      return salonChoicePage(flow.dateChoices || [], flow.datePage, "date", salonDateLabel);
    }
    const buttonChoice = /^b2date(\d+)$/.exec(input) || /^swas b2 date (\d+)$/.exec(input);
    const choice = buttonChoice ? Number(buttonChoice[1]) : -1;
    // WhatsApp may return the visible button label (for example, "→ 05 Nov 2026")
    // instead of its native button id. Parse the date portion so a tapped date advances to times.
    const visibleDateText = String(text).match(/(\d{1,2}\s+[a-z]+\s+\d{4})/i)?.[1] || "";
    const dateKey = choice >= 0 && choice < (flow.dateChoices || []).length ? flow.dateChoices[choice] : salonDateKey(visibleDateText || text);
    if (!dateKey) return null;
    if (settings.bot2StartDate && dateKey < settings.bot2StartDate) return null;
    if (!salonDayAllowed(dateKey, settings.bot2SalonHours)) return null;
    flow.date = buttonChoice || visibleDateText ? salonDateLabel(dateKey) : String(text).trim(); flow.dateKey = dateKey; flow.step = "time";
    flow.timeChoices = salonTimeChoices(settings.bot2SalonHours, bot, dateKey, settings);
    if (!flow.timeChoices.length) {
      // Today's slots can all be in the past (or fully booked). Offer future
      // dates that still have a free slot instead of asking the customer to type a time.
      flow.step = "date";
      flow.dateChoices = salonDateChoices(settings.bot2SalonHours, settings.bot2StartDate, 14)
        .filter((availableDate) => salonTimeChoices(settings.bot2SalonHours, bot, availableDate, settings).length > 0)
        .slice(0, 7);
      flow.datePage = 0;
      if (flow.dateChoices.length) {
        return salonChoicePage(flow.dateChoices, flow.datePage, "date", salonDateLabel, `No more times are available on ${flow.date}. Please choose another date.`);
      }
      return "There are no available appointment times on upcoming dates. Please contact the salon.";
    }
    if (flow.timeChoices.length) {
      flow.timePage = 0;
      return salonTimeChoicePage(flow, settings);
    }
    return `कोणती वेळ हवी आहे? 10:30 AM अशा स्वरूपात पाठवा. सलूनची वेळ: ${settings.bot2SalonHours || "कृपया संपर्क करा"}.`;
  }
  if (flow.step === "time") {
    if (["b2nextdate", "next date", "next available date"].includes(input)) {
      const fromDate = flow.dateKey || salonNowParts().date;
      const firstDate = new Date(Date.parse(`${fromDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      const upcomingDates = salonDateChoices(settings.bot2SalonHours, firstDate, 45);
      const nextDate = upcomingDates.find((dateKey) => salonTimeChoices(settings.bot2SalonHours, bot, dateKey, settings).length > 0);
      if (!nextDate) return "There are no more available appointment dates. Please contact the salon.";
      flow.dateKey = nextDate;
      flow.date = salonDateLabel(nextDate);
      flow.timeChoices = salonTimeChoices(settings.bot2SalonHours, bot, nextDate, settings);
      flow.timePage = 0;
      return salonTimeChoicePage(flow, settings);
    }
    if (["b2timesmore", "more times", "swas b2 times more"].includes(input)) {
      flow.timePage = ((flow.timePage || 0) + 1) % Math.max(1, Math.ceil((flow.timeChoices || []).length / 2));
      return salonTimeChoicePage(flow, settings);
    }
    const buttonChoice = /^b2time(\d+)$/.exec(input) || /^swas b2 time (\d+)$/.exec(input);
    const choice = buttonChoice ? Number(buttonChoice[1]) : -1;
    const visibleTimeText = String(text).match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i)?.[1];
    const visibleTime = salonTime(visibleTimeText || "");
    const workerMatch = String(text).match(/\bworker\s*(\d+)\b/i);
    const requestedWorker = workerMatch ? `Worker ${Number(workerMatch[1])}` : "";
    const selectedSlot = choice >= 0 && choice < (flow.timeChoices || []).length
      ? flow.timeChoices[choice]
      : visibleTime ? (flow.timeChoices || []).find((slot) => slot.key === visibleTime.label && (!requestedWorker || slot.worker === requestedWorker)) : null;
    if (selectedSlot?.booked || selectedSlot?.past) {
      const page = salonTimeChoicePage(flow, settings);
      return { reply: selectedSlot.booked ? "🔴 हा वेळ आधीच booked आहे. कृपया 🟢 available वेळ निवडा." : "🔴 ही वेळ निघून गेली आहे. कृपया 🟢 पुढची available वेळ निवडा.", choices: page.choices };
    }
    // Use the canonical slot key for a tapped option. WhatsApp may return a
    // button label with emoji or spacing changed by the client.
    const time = selectedSlot ? salonTime(selectedSlot.key) : visibleTime || salonTime(text);
    if (!time) return null;
    if (!salonTimeAllowed(time.minutes, settings.bot2SalonHours, settings) || ((flow.timeChoices || []).length && !selectedSlot)) return null;
    const worker = selectedSlot?.worker || "Worker 1";
    const taken = (bot.bookings || []).some((b) => b.status === "confirmed" && (b.dateKey || salonDateKey(b.date)) === flow.dateKey && (b.timeKey || salonTime(b.time)?.label) === time.label && (b.worker || "Worker 1") === worker);
    if (taken) {
      const page = salonChoicePage(salonTimeChoices(settings.bot2SalonHours, bot, flow.dateKey, settings), 0, "time", salonTimeChoiceLabel);
      return { reply: "हा slot नुकताच book झाला. दुसरा available slot निवडा:", choices: page.choices };
    }
    flow.time = selectedSlot?.timeLabel || String(text).trim(); flow.timeKey = time.label; flow.worker = worker;
    const profileName = String(contact.name || "").trim().replace(/\s+/g, " ");
    flow.customerName = profileName.length >= 2 && !/^[+\d\s().-]+$/.test(profileName) ? profileName : "";
    const customerMobile = String(contact.number || flow.number || "").replace(/\D/g, "") || String(jid || "").split("@")[0];
    if (!flow.customerName) {
      flow.step = "name";
      return "Please type your name to complete the booking.";
    }
    flow.step = "confirm";
    return { reply: `Review your appointment\n\n${settings.bot2SalonName || "Shop"}\nService: ${flow.service}\nDate: ${flow.date}\nTime: ${flow.time}\nName: ${flow.customerName}\nMobile: ${customerMobile}\n\nPlease confirm your booking.`, choices: [{ id: "swas_b2_confirm", title: salonForwardTitle("Confirm Booking") }, { id: "swas_b2_cancel", title: "Cancel" }] };
  }
  if (flow.step === "name") {
    const enteredName = String(text || "").trim().replace(/\s+/g, " ");
    if (enteredName.length < 2 || enteredName.length > 80 || /^[+\d\s().-]+$/.test(enteredName)) return "Please type your name using letters, for example Rahul Patil.";
    flow.customerName = enteredName;
    flow.step = "confirm";
    const customerMobile = String(contact.number || flow.number || "").replace(/\D/g, "") || String(jid || "").split("@")[0];
    return { reply: `Review your appointment\n\n${settings.bot2SalonName || "Shop"}\nService: ${flow.service}\nDate: ${flow.date}\nTime: ${flow.time}\nName: ${flow.customerName}\nMobile: ${customerMobile}\n\nPlease confirm your booking.`, choices: [{ id: "swas_b2_confirm", title: salonForwardTitle("Confirm Booking") }, { id: "swas_b2_cancel", title: "Cancel" }] };
  }
  if (flow.step === "confirm") {
    if (!["yes", "confirm", "confirm booking", "b2confirm", "swas b2 confirm", "हो", "होय"].includes(input)) return null;
    const worker = flow.worker || "Worker 1";
    const slotTaken = (bot.bookings || []).some((b) => b.status === "confirmed" && (b.dateKey || salonDateKey(b.date)) === flow.dateKey && (b.timeKey || salonTime(b.time)?.label) === flow.timeKey && (b.worker || "Worker 1") === worker);
    if (slotTaken) {
      flow.step = "time";
      flow.time = "";
      flow.timeKey = "";
      flow.timeChoices = salonTimeChoices(settings.bot2SalonHours, bot, flow.dateKey, settings);
      flow.timePage = 0;
      return salonTimeChoicePage(flow, settings);
    }
    const booking = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: flow.customerName, number: contact.number || flow.number || "", service: flow.service, date: flow.date, dateKey: flow.dateKey, time: flow.time, timeKey: flow.timeKey, worker, createdAt: Date.now(), status: "confirmed" };
    (bot.bookings || (bot.bookings = [])).push(booking);
    delete bot.bookingFlows[jid];
    const salonName = settings.bot2SalonName || "our salon";
    const thankYou = salonMessageTemplate(settings.bot2ThankYouMessage || "Thank you, {{name}}! 🙏", booking, salonName);
    const welcome = salonMessageTemplate(settings.bot2WelcomeMessage || "Welcome to {{salon}} — we look forward to seeing you.", booking, salonName);
    return { reply: `✅ *Appointment Confirmed!*\n\n${thankYou}\n${welcome}\n\n✂️ ${booking.service}\n📅 ${booking.date}\n⏰ ${booking.time}`, choices: [{ id: "swas_b2_rebook_menu", title: salonForwardTitle("New booking") }], urlButton: /^https:\/\//i.test(String(settings.bot2GoogleMapsUrl || "").trim()) ? { title: "📍 Location", url: String(settings.bot2GoogleMapsUrl).trim() } : null, callButton: String(ownerNumber || "").replace(/\D/g, "") ? { title: "📞 Contact", phoneNumber: `+${String(ownerNumber).replace(/\D/g, "")}` } : null, booking };
  }
  delete bot.bookingFlows[jid];
  return null;
}

/** Reactions, edits, deletes and receipts arrive as messages too; only something the customer sent counts. */
function isRealMessage(msg) {
  const content = normalizeMessageContent(msg.message);
  if (!content) return false;
  return !content.protocolMessage && !content.reactionMessage && !content.pollUpdateMessage;
}

/** The sender's phone number. Newer WhatsApp addresses chats by a private id (@lid) and gives the number alongside. */
async function phoneOf(sock, key) {
  const fromJid = (jid) => /^(\d{7,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid || "")?.[1];
  for (const jid of [key.remoteJid, key.remoteJidAlt, key.senderPn]) {
    const phone = fromJid(jid);
    if (phone) return phone;
  }
  try {
    return fromJid(await sock.signalRepository?.lidMapping?.getPNForLID?.(key.remoteJid)) || "";
  } catch {
    return "";
  }
}

/** At most LIMITS.repliesPerMinute replies to one chat a minute - two auto-repliers never loop forever. */
function withinRate(rt, jid, limit = SwasBot.LIMITS.repliesPerMinute) {
  const recent = (rt.sent.get(jid) || []).filter((at) => Date.now() - at < 60 * 1000);
  rt.sent.set(jid, recent);
  return recent.length < limit;
}

async function answer(mobile, sock, bot, config, msg, { chatbotOn = true } = {}) {
  const jid = msg.key?.remoteJid;
  if (!jid || msg.key.fromMe || isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) return;
  if (!isRealMessage(msg)) return;
  const sentAt = Number(msg.messageTimestamp) * 1000;
  if (sentAt && Date.now() - sentAt > MAX_AGE_MS) return;

  const rt = runtime(mobile);
  if (rt.handled.has(msg.key.id)) return;
  rt.handled.add(msg.key.id);
  if (rt.handled.size > MAX_HANDLED) rt.handled.delete(rt.handled.values().next().value);

  let text = messageText(msg, bot, jid);
  // Some WhatsApp clients send the Continue button tap as its plain label instead of its id.
  if (bot.config?.settings?.bot5Enabled && SwasBot.normalize(text) === "continue") text = "b5continue";
  const contact = { name: msg.pushName || "", number: await phoneOf(sock, msg.key) };
  const who = contact.number || contact.name || jid;
  const unsubscribed = bot.unsubscribers.some((entry) => SwasBot.isSameContact(entry, contact));
  const normalizedLanguageReply = SwasBot.normalize(text);
  const currentBotId = intendedBotId(mobile, bot, jid, text, config, chatbotOn, contact);
  const marathiWord = "\u092e\u0930\u093e\u0920\u0940";
  const languageChoice = ["1", "marathi", marathiWord].includes(normalizedLanguageReply) ? "mr"
    : ["2", "english", "\u0907\u0902\u0917\u094d\u0930\u091c\u0940"].includes(normalizedLanguageReply) ? "en" : "";
  const sendLanguagePrompt = async () => {
    if (!withinRate(rt, jid, 20)) return;
    rt.sent.get(jid).push(Date.now());
    await sendChoices(sock, jid, "\u092d\u093e\u0937\u093e \u0928\u093f\u0935\u0921\u093e / Please choose your language:", [
      { id: "swas_lang_1", title: marathiWord }, { id: "swas_lang_2", title: "English" },
    ]);
  };
  // A message meant for Bots 2-5 (link / QR / keyword) cancels a leftover language question,
  // so an old pending message is never replayed in place of the new one.
  if (bot.languagePrompt?.[jid] && !languageChoice && currentBotId && currentBotId !== "1") {
    delete bot.languagePrompt[jid];
    delete bot.pendingLanguageMessages?.[jid];
    save(mobile);
  }
  if (bot.languagePrompt?.[jid]) {
    if (!languageChoice) { await sendLanguagePrompt(); return; }
    const pending = bot.pendingLanguageMessages?.[jid];
    const pendingText = typeof pending === "string" ? pending : pending?.text;
    const pendingBotId = typeof pending === "object" ? pending.botId : currentBotId || "1";
    if (pendingBotId === "1") { bot.langs ||= {}; bot.langs[jid] = languageChoice; }
    else { bot.botLanguages ||= {}; bot.botLanguages[jid] ||= {}; bot.botLanguages[jid][pendingBotId] = languageChoice; }
    delete bot.languagePrompt[jid];
    delete bot.pendingLanguageMessages?.[jid];
    save(mobile);
    if (pendingText) {
      bot.languageResume ||= {};
      bot.languageResume[jid] = pendingBotId;
      save(mobile);
      const replay = { ...msg, key: { ...msg.key, id: `${msg.key.id}-language-resume` }, message: { conversation: pendingText }, messageTimestamp: Math.floor(Date.now() / 1000) };
      await answer(mobile, sock, bot, config, replay, { chatbotOn });
      return;
    }
    text = languageChoice === "mr" ? "1" : "2";
  } else {
    const isLanguageResume = bot.languageResume?.[jid] === currentBotId;
    if (bot.languageResume?.[jid]) delete bot.languageResume[jid];
    const isStop = (config.stopKeywords || []).includes(normalizedLanguageReply);
    const isStart = normalizedLanguageReply === "start";
    if (currentBotId && !isLanguageResume && shouldAskLanguageOnEntry(bot, jid, currentBotId, text, config) && !isStop && (!unsubscribed || isStart) && text.trim()) {
      bot.pendingLanguageMessages ||= {};
      bot.pendingLanguageMessages[jid] = { text, botId: currentBotId };
      bot.languagePrompt ||= {};
      bot.languagePrompt[jid] = true;
      save(mobile);
      await sendLanguagePrompt();
      return;
    }
  }
  const last = bot.sessions[jid] || 0;
  const inSession = Date.now() - last < SwasBot.LIMITS.sessionMs;
  const idleMs = last ? Date.now() - last : null; // time since the bot last answered this chat
  const lang = currentBotId === "1" ? ((bot.langs || (bot.langs = {}))[jid] || "") : (bot.botLanguages?.[jid]?.[currentBotId] || bot.langs?.[jid] || "");
  const normalizedText = SwasBot.normalize(text);
  const isGreeting = SwasBot.keywordList(bot.config?.settings?.welcomeKeywords)
    .some((keyword) => normalizedText === SwasBot.normalize(keyword));
  const choosingLanguage = Boolean(bot.languagePrompt?.[jid]);
  const bot3Settings = bot.config?.settings || {};
  const allowedBots = accountBots(mobile);
  const bot2Selected = allowedBots.has(2) && !!bot3Settings.bot2SalonEnabled;
  const bot3Selected = allowedBots.has(3) && !!bot3Settings.bot3Enabled;
  const bot4Selected = allowedBots.has(4) && !!bot3Settings.bot4Enabled;
  const bot5Selected = allowedBots.has(5) && !!bot3Settings.bot5Enabled;
  const bot6Selected = allowedBots.has(6) && !!bot3Settings.bot6Enabled;
  const finalMapUrl = String(bot3Settings.bot2GoogleMapsUrl || "").trim();
  const finalPhone = String(sock.user?.id || sock.authState?.creds?.me?.id || "").split(/[:@]/)[0].replace(/\D/g, "") || String(mobile || "").replace(/\D/g, "");
  const finalUrlButton = /^https:\/\//i.test(finalMapUrl) ? { title: "\u{1F4CD} Location", url: finalMapUrl } : null;
  const finalCallButton = finalPhone ? { title: "\u{1F4DE} Contact", phoneNumber: `+${finalPhone}` } : null;
  const leadFlows = bot.interestFlows || (bot.interestFlows = {});
  const leadFlow = leadFlows[jid];
  const hotelFlows = bot.hotelBookingFlows || (bot.hotelBookingFlows = {});
  const hotelFlow = hotelFlows[jid];
  const hotelBranchesForAccount = hotelBranches(mobile);
  const hiddenTableValue = readHiddenTableToken(text);
  const visibleHotelText = String(text || "").replace(/\u2063[\u200b\u200c]+\u2063/g, "").trim();
  const hotelBranchCode = /^table\s+book\s+(.+)$/i.exec(visibleHotelText);
  const hotelStartText = !!hotelBranchCode;
  const hotelRequestedBranchName = hotelBranchCode?.[1]?.trim() || "";
  const hotelBranch = hotelBranchesForAccount.find((entry) => SwasBot.normalize(entry.name) === SwasBot.normalize(hotelRequestedBranchName)) || null;
  const hotelToken = hiddenTableValue || "";
  const hotelBookTap = false;
  const hotelConfirmTap = false;
  const hotelOwnMessage = bot4Selected && (!!hotelFlow || hotelStartText);
  const interestedLabel = SwasBot.normalize(bot3Settings.bot3InterestedLabel || "Interested");
  const interestedTap = text === "b3interested" || normalizedText === interestedLabel || normalizedText === "interested";
  let salonAction = chatbotOn && !unsubscribed && !interestedTap && !hotelOwnMessage && bot2Selected ? salonReply(bot, jid, text, contact, bot3Settings, mobile) : null;
  if (lang === "mr" && salonAction) {
    if (typeof salonAction === "string") salonAction = salonMarathiText(salonAction);
    else salonAction = { ...salonAction, reply: salonMarathiText(salonAction.reply), choices: (salonAction.choices || []).map((choice) => ({ ...choice, title: salonMarathiText(choice.title) })), followUp: salonAction.followUp ? { ...salonAction.followUp, reply: salonMarathiText(salonAction.followUp.reply), choices: (salonAction.followUp.choices || []).map((choice) => ({ ...choice, title: salonMarathiText(choice.title) })) } : salonAction.followUp };
  }
  let bot3FlowReply = null;
  let bot3RepeatInterested = false;
  let bot4FlowReply = null;
  let bot4Choices = null;
  let bot4UrlButton = null;
  let bot4CallButton = null;
  let bot4RepeatConfirmation = false;
  if (chatbotOn && !unsubscribed && bot4Selected && hotelStartText) {
    const verified = hotelBranch && tableBookingTokens.consume(hotelToken, mobile, hotelBranch.id);
    if (!verified) bot4FlowReply = lang === "mr" ? "\u0932\u094b\u0915\u0947\u0936\u0928 \u091a\u0947\u0915 \u0915\u093e\u0932\u092c\u093e\u0939\u094d\u092f \u091d\u093e\u0932\u093e. \u0915\u0943\u092a\u092f\u093e \u0936\u093e\u0916\u0947\u091a\u093e QR \u092a\u0941\u0928\u094d\u0939\u093e \u0938\u094d\u0915\u0945\u0928 \u0915\u0930\u093e." : "This location check has expired or is invalid. Please scan the branch QR again while at the branch.";
    else if (!isBranchHotelOpen(hotelBranch)) bot4FlowReply = lang === "mr" ? [bot3Settings.bot4Name, hotelBranch.name].filter(Boolean).join(", ") + " \u092f\u0947\u0925\u0947 \u0938\u0927\u094d\u092f\u093e \u092c\u0941\u0915\u093f\u0902\u0917 \u092c\u0902\u0926 \u0906\u0939\u0947. \u0915\u0943\u092a\u092f\u093e \u0938\u0941\u0930\u0942 \u0905\u0938\u0924\u093e\u0928\u093e \u092a\u0941\u0928\u094d\u0939\u093e \u092a\u094d\u0930\u092f\u0924\u094d\u0928 \u0915\u0930\u093e." : "Bookings for " + hotelBranch.name + " are closed. Please try again during opening hours.";
    else {
      hotelFlows[jid] = { step: "members", branchId: hotelBranch.id, name: contact.name || "WhatsApp customer", number: contact.number || "", distanceMeters: verified.distanceMeters, startedAt: Date.now() };
      bot4FlowReply = lang === "mr" ? [bot3Settings.bot4Name, hotelBranch.name].filter(Boolean).join(", ") + " \u092f\u0947\u0925\u0947 \u0906\u092a\u0932\u0947 \u0938\u094d\u0935\u093e\u0917\u0924 \u0906\u0939\u0947! \u0924\u0941\u092e\u091a\u094d\u092f\u093e \u092a\u093e\u0930\u094d\u091f\u0940\u092e\u0927\u094d\u092f\u0947 \u0915\u093f\u0924\u0940 \u0938\u0926\u0938\u094d\u092f \u0906\u0939\u0947\u0924? \u0967 \u0924\u0947 \u096b\u0966 \u092e\u0927\u0940\u0932 \u0938\u0902\u0916\u094d\u092f\u093e \u092a\u093e\u0920\u0935\u093e." : "Welcome to " + [bot3Settings.bot4Name, hotelBranch.name].filter(Boolean).join(", ") + "! How many members are in your party? Reply with a number from 1 to 50.";
      save(mobile);
    }
  } else if (chatbotOn && !unsubscribed && bot4Selected && hotelFlow?.step === "members") {
    const members = Number(String(text || "").replace(/[\u0966-\u096f]/g, (digit) => String(digit.charCodeAt(0) - 0x0966)).trim());
    if (Date.now() - Number(hotelFlow.startedAt || 0) > 5 * 60 * 1000) {
      delete hotelFlows[jid];
      bot4FlowReply = lang === "mr" ? "\u092c\u0941\u0915\u093f\u0902\u0917\u091a\u0940 \u0935\u0947\u0933 \u0938\u0902\u092a\u0932\u0940. \u0915\u0943\u092a\u092f\u093e \u0936\u093e\u0916\u0947\u091a\u093e QR \u092a\u0941\u0928\u094d\u0939\u093e \u0938\u094d\u0915\u0945\u0928 \u0915\u0930\u093e." : "This booking session expired. Please scan the branch QR again.";
      save(mobile);
    } else if (!Number.isInteger(members) || members < 1 || members > 50) bot4FlowReply = lang === "mr" ? "\u0915\u0943\u092a\u092f\u093e \u0938\u0926\u0938\u094d\u092f\u0938\u0902\u0916\u094d\u092f\u093e \u0967 \u0924\u0947 \u096b\u0966 \u092e\u0927\u0940\u0932 \u092a\u0942\u0930\u094d\u0923 \u0906\u0915\u0921\u094d\u092f\u093e\u0924 \u092a\u093e\u0920\u0935\u093e." : "Please enter the number of members as a whole number from 1 to 50.";
    else {
      const branch = hotelBranchesForAccount.find((entry) => String(entry.id) === String(hotelFlow.branchId));
      if (!branch || !isBranchHotelOpen(branch)) {
        delete hotelFlows[jid];
        bot4FlowReply = lang === "mr" ? "\u0939\u0940 \u0936\u093e\u0916\u093e \u0938\u0927\u094d\u092f\u093e \u092c\u0902\u0926 \u0906\u0939\u0947. \u0915\u0943\u092a\u092f\u093e \u0938\u0941\u0930\u0942 \u0905\u0938\u0924\u093e\u0928\u093e \u0924\u093f\u091a\u093e QR \u092a\u0941\u0928\u094d\u0939\u093e \u0938\u094d\u0915\u0945\u0928 \u0915\u0930\u093e." : "This branch is currently closed. Please scan its QR again during opening hours.";
        save(mobile);
      } else {
        const now = hotelBookingNow();
        const bookings = bot.hotelBookings || (bot.hotelBookings = []);
        const todays = bookings.filter((entry) => entry.dateKey === now.dateKey && (entry.branchId === branch.id || (branch.id === "main" && !entry.branchId)) && ["Pending", "Confirmed"].includes(entry.status));
        const queueNo = todays.reduce((max, entry) => Math.max(max, Number(entry.queueNo) || 0), 0) + 1;
        const waitCycleMinutes = Math.min(240, Math.max(1, Number(branch.waitMinutes) || Number(bot3Settings.bot4WaitMinutes) || 15));
        const seatingCapacity = Math.floor(Number(branch.seatingCapacity) || 0);
        if (seatingCapacity > 0 && members > seatingCapacity) {
          delete hotelFlows[jid];
          bot4FlowReply = lang === "mr" ? "\u092f\u093e \u0936\u093e\u0916\u0947\u091a\u0940 \u090f\u0915\u0942\u0923 \u0906\u0938\u0928 \u0915\u094d\u0937\u092e\u0924\u093e " + seatingCapacity + " \u0938\u0926\u0938\u094d\u092f\u093e\u0902\u091a\u0940 \u0906\u0939\u0947. \u092e\u094b\u0920\u094d\u092f\u093e \u0917\u091f\u093e\u0938\u093e\u0920\u0940 \u0936\u093e\u0916\u0947\u0936\u0940 \u0938\u0902\u092a\u0930\u094d\u0915 \u0915\u0930\u093e." : "This branch seats " + seatingCapacity + " people total. Please contact the branch for a larger group.";
          save(mobile);
        } else {
        const waitMinutes = hotelQueueWaitMinutes(branch, todays, members, waitCycleMinutes);
        const bookingAt = Date.now() + waitMinutes * 60000;
        const booking = { id: `${now.dateKey}-${branch.id}-${queueNo}-${Date.now()}`, jid, branchId: branch.id, branchName: branch.name, name: hotelFlow.name || contact.name || "WhatsApp customer", number: contact.number || hotelFlow.number || "", members, queueNo, dateKey: now.dateKey, date: now.date, time: displayTime(new Date(bookingAt)), distanceMeters: Number(hotelFlow.distanceMeters), estimatedWaitMinutes: waitMinutes, status: "Confirmed", createdAt: Date.now(), confirmedAt: Date.now() };
        bookings.push(booking);
        delete hotelFlows[jid];
        bot4FlowReply = hotelConfirmationMessage(bot3Settings, booking, lang);
        const branchLatitude = Number(branch.latitude), branchLongitude = Number(branch.longitude);
        if (Number.isFinite(branchLatitude) && Math.abs(branchLatitude) <= 90 && Number.isFinite(branchLongitude) && Math.abs(branchLongitude) <= 180) {
          bot4UrlButton = {
            title: lang === "mr" ? "\u0936\u093e\u0916\u0947\u091a\u0947 \u0920\u093f\u0915\u093e\u0923" : "Branch location",
            url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${branchLatitude},${branchLongitude}`)}`,
          };
        }
        const branchPhone = settingsNumber(branch.notifyNumber || bot3Settings.bot4NotifyNumber);
        if (!bot4UrlButton) bot4UrlButton = finalUrlButton;
        bot4CallButton = finalCallButton;
        if (branchPhone) bot4CallButton = { title: lang === "mr" ? "\u0938\u0902\u092a\u0930\u094d\u0915" : "Contact", phoneNumber: `+${branchPhone}` };
        save(mobile);
        const ownerNumber = settingsNumber(branch.notifyNumber || bot3Settings.bot4NotifyNumber);
        if (ownerNumber) {
          const ownerMessage = `New table booking - ${[bot3Settings.bot4Name, branch.name].filter(Boolean).join(", ")}\nName: ${booking.name}\nMobile: ${booking.number}\nMembers: ${members}\nQueue number: ${booking.queueNo}\nEstimated wait: ${booking.estimatedWaitMinutes} minutes`;
          try { await require("./waSessions").sendText(mobile, ownerNumber, ownerMessage); }
          catch (error) { console.warn(`[bot ${mobile}] ${branch.name} owner booking alert failed:`, error.message || error); }
        }
        }
      }
    }
  } else if (chatbotOn && !unsubscribed && bot4Selected && hotelFlow?.step === "location") {
    delete hotelFlows[jid];
    bot4FlowReply = lang === "mr" ? "\u0932\u094b\u0915\u0947\u0936\u0928 \u091a\u0947\u0915 QR \u0938\u094d\u0915\u0945\u0928 \u0915\u0947\u0932\u094d\u092f\u093e\u0935\u0930 \u0906\u092a\u094b\u0906\u092a \u0939\u094b\u0924\u094b. \u092c\u0941\u0915\u093f\u0902\u0917\u0938\u093e\u0920\u0940 \u0936\u093e\u0916\u0947\u0924 \u0905\u0938\u0924\u093e\u0928\u093e QR \u092a\u0941\u0928\u094d\u0939\u093e \u0938\u094d\u0915\u0945\u0928 \u0915\u0930\u093e." : "Location is checked automatically when you scan the branch QR. Please scan it at the branch again to book.";
    save(mobile);
  }
  if (chatbotOn && !unsubscribed && bot3Selected && !hotelOwnMessage && leadFlow?.step === "city" && interestedTap) {
    bot3FlowReply = bot3Settings.bot3CityQuestion || "कृपया तुमच्या शहराचे नाव सांगा.";
  } else if (chatbotOn && !unsubscribed && bot3Selected && !hotelOwnMessage && leadFlow?.step === "city") {
    const city = String(text || "").trim().replace(/\s+/g, " ");
    if (city.length < 2 || city.length > 100) {
      bot3FlowReply = bot3Settings.bot3CityQuestion || "कृपया तुमच्या शहराचे नाव सांगा.";
    } else {
      const now = Date.now();
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
      const part = (type) => parts.find((item) => item.type === type)?.value || "";
      const lead = {
        name: leadFlow.name || "WhatsApp user",
        number: contact.number || leadFlow.number || "",
        city,
        date: `${part("day")}-${part("month")}-${part("year")}`,
        time: `${part("hour")}:${part("minute")}`,
        createdAt: now,
        status: "New",
      };
      (bot.interestedLeads || (bot.interestedLeads = [])).push(lead);
      delete leadFlows[jid];
      save(mobile);
      await notifyInterestedLead(mobile, bot3Settings, lead);
      bot3RepeatInterested = true;
      bot3FlowReply = [bot3Settings.bot3FinalThankYou, bot3Settings.bot3FinalWelcome].map((value) => String(value || "").trim()).filter(Boolean).join("\n");
      bot3FlowReply = (bot3FlowReply ? bot3FlowReply + "\n\n" : "") + String(bot3Settings.bot3ThankYou || "धन्यवाद! आमचे प्रतिनिधी 24 तासांच्या आत तुमच्याशी संपर्क करतील.")
        .replace(/\{\{\s*name\s*\}\}/gi, lead.name)
        .replace(/\{\{\s*number\s*\}\}/gi, lead.number)
        .replace(/\{\{\s*city\s*\}\}/gi, lead.city)
        .replace(/\{\{\s*shop\s*\}\}/gi, bot3Settings.bot3CompanyName || "");
    }
  } else if (chatbotOn && !unsubscribed && bot3Selected && !hotelOwnMessage && interestedTap) {
    const now = Date.now();
    const number = String(contact.number || "").replace(/\D/g, "");
    const previousLead = number && [...(bot.interestedLeads || [])].reverse().find((lead) =>
      !lead.duplicate && String(lead.number || "").replace(/\D/g, "") === number && now - Number(lead.createdAt || 0) < 24 * 60 * 60 * 1000
    );
    if (previousLead) {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
      const part = (type) => parts.find((item) => item.type === type)?.value || "";
      const duplicateLead = {
        ...previousLead,
        date: `${part("day")}-${part("month")}-${part("year")}`,
        time: `${part("hour")}:${part("minute")}`,
        createdAt: now,
        status: "Duplicate",
        duplicate: true,
        duplicateOf: previousLead.createdAt,
      };
      (bot.interestedLeads || (bot.interestedLeads = [])).push(duplicateLead);
      save(mobile);
      await notifyInterestedLead(mobile, bot3Settings, duplicateLead);
      bot3RepeatInterested = true;
      bot3FlowReply = String(bot3Settings.bot3DuplicateReply || "तुम्ही आधीच Interested नोंदवले आहे. {{shop}} कंपनीचे प्रतिनिधी 24 तासांत तुम्हाला कॉल करतील. धन्यवाद.")
        .replace(/\{\{\s*name\s*\}\}/gi, previousLead.name || "")
        .replace(/\{\{\s*number\s*\}\}/gi, previousLead.number || "")
        .replace(/\{\{\s*city\s*\}\}/gi, previousLead.city || "")
        .replace(/\{\{\s*shop\s*\}\}/gi, bot3Settings.bot3CompanyName || "");
    } else {
      leadFlows[jid] = { step: "city", name: String(contact.name || "").trim() || "WhatsApp user", number: contact.number || "", startedAt: now };
      save(mobile);
      bot3FlowReply = bot3Settings.bot3CityQuestion || "कृपया तुमच्या शहराचे नाव सांगा.";
    }
  }
  const bot3Keywords = SwasBot.keywordList(bot3Settings.bot3Keywords);
  const bot3Reply = !hotelOwnMessage && !salonAction && !bot3FlowReply && !leadFlow && chatbotOn && !unsubscribed && bot3Selected && bot3Settings.bot3Reply && bot3Keywords.includes(SwasBot.normalize(text))
    ? bot3Settings.bot3Reply : null;
  const keywordBotReply = (number) => {
    const keywords = SwasBot.keywordList(bot3Settings[`bot${number}Keywords`]);
    return chatbotOn && !unsubscribed && bot3Settings[`bot${number}Enabled`] && bot3Settings[`bot${number}Reply`] && keywords.includes(SwasBot.normalize(text))
      ? String(bot3Settings[`bot${number}Reply`]).replace(/\{\{\s*name\s*\}\}/gi, contact.name || "").replace(/\{\{\s*number\s*\}\}/gi, contact.number || "").replace(/\{\{\s*shop\s*\}\}/gi, bot3Settings[`bot${number}Name`] || "") : null;
  };
  const bot4Reply = bot4Selected && !hotelOwnMessage ? keywordBotReply(4) : null;
  let bot5Reply = null;
  let bot5Choices = [];
  const bot5Trigger = bot5Selected && !hotelOwnMessage && chatbotOn && !unsubscribed
    && (text === "b5continue" || SwasBot.keywordList(bot3Settings.bot5Keywords || "my details").includes(SwasBot.normalize(text)));
  if (bot5Trigger) {
    const found = botData.bot5Rows(mobile, contact.number);
    const fill = (value) => String(value || "").replace(/\{\{\s*name\s*\}\}/gi, contact.name || "").replace(/\{\{\s*number\s*\}\}/gi, contact.number || "").replace(/\{\{\s*shop\s*\}\}/gi, bot3Settings.bot5Name || "");
    if (!found) {
      bot5Reply = fill(bot3Settings.bot5NotFound || "Your WhatsApp number is not registered with us. Please contact us.");
    } else if (text !== "b5continue") {
      bot5Reply = fill(bot3Settings.bot5Reply || "Welcome {{name}}! Tap Continue to see your details.");
      bot5Choices = [{ id: "swas_b5_continue", title: "Continue" }];
    } else {
      const wanted = String(bot3Settings.bot5Columns || "").split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
      const byName = new Map(found.headers.map((header) => [SwasBot.normalize(header), header]));
      const columns = wanted.length ? wanted.map((name) => byName.get(SwasBot.normalize(name))).filter(Boolean) : found.headers;
      const blocks = found.rows.map((row, index) => {
        const lines = columns.filter((header) => String(row[header] ?? "").trim() !== "").map((header) => `*${header}:* ${row[header]}`);
        return (found.rows.length > 1 ? `*${index + 1}.*\n` : "") + (lines.join("\n") || "-");
      });
      const intro = fill(bot3Settings.bot5DetailsTitle || "Your details:");
      bot5Reply = [intro, blocks.join("\n\n")].filter(Boolean).join("\n\n");
    }
  }
  // Bot 6: a simple website bot - the link / QR text gets the welcome message with a website button.
  let bot6Reply = null;
  if (bot6Selected && !bot5Reply && !hotelOwnMessage && chatbotOn && !unsubscribed && bot6Keywords(bot3Settings).includes(SwasBot.normalize(text))) {
    const shop = String(bot3Settings.bot6Name || "").trim();
    bot6Reply = String(bot3Settings.bot6Welcome || (shop ? `Welcome to ${shop}!` : "Welcome!"))
      .replace(/\{\{\s*name\s*\}\}/gi, contact.name || "")
      .replace(/\{\{\s*shop\s*\}\}/gi, shop);
  }
  // Data lookup (e.g. "1" -> this customer's own loan details) takes priority over the normal rules,
  // but it's part of the chatbot add-on — skip it when the add-on is gated off (footer STOP only).
  const pageRequest = /^__menu_page_([123])$/.exec(text);
  const action = salonAction || bot3Reply || bot3FlowReply || bot4FlowReply || bot4Reply || bot5Reply || bot6Reply ? null : pageRequest
    ? { type: "menupage", page: Number(pageRequest[1]), label: "Menu page" }
    : (chatbotOn ? lookupAction(mobile, bot.config?.settings, text, contact.number) : null)
      || SwasBot.matchMessage(text, config, {
      unsubscribed,
      inSession,
      idleMs,
      lang: choosingLanguage ? "" : lang,
    });
  if (!action && !salonAction && !bot3Reply && !bot3FlowReply && !bot4FlowReply && !bot4Reply && !bot5Reply && !bot6Reply) {
    console.log(`[bot ${mobile}] ${who}: "${text}" - no reply${unsubscribed ? " (unsubscribed)" : ""}`);
    return;
  }

  if (action?.type === "unsubscribe") {
    record(mobile, bot, { op: "add", entries: [contact.number || contact.name].filter(Boolean) });
  }
  if (action?.type === "start" && unsubscribed) {
    record(mobile, bot, { op: "remove", entries: bot.unsubscribers.filter((entry) => SwasBot.isSameContact(entry, contact)) });
  }
  // Menu pagination is an explicit user click; always answer it, even when the
  // regular chatbot reply limit has been reached for this chat.
  if (action && !pageRequest && !withinRate(rt, jid)) {
    console.log(`[bot ${mobile}] ${who}: ${action.label} - too many replies this minute, skipped`);
    return;
  }

  if (action && !pageRequest) rt.sent.get(jid).push(Date.now());
  const showMenu = chatbotOn && action && ["langmenu", "menupage", "welcome", "start", "fallback", "rule", "lookup", "lookup-miss"].includes(action.type);
  if (showMenu) {
    const languageMenu = action.type === "langmenu";
    const body = languageMenu
      ? "कृपया भाषा निवडा / Please choose your language."
      : action.type === "menupage"
        ? (lang === "en" ? "Choose an option:" : "पर्याय निवडा:")
      : ["welcome", "start", "fallback"].includes(action.type)
        ? (action.setLang === "en"
          ? `${welcomeTitle(bot.config?.settings, "en")}\n\nTap Choose option below.`
          : `${welcomeTitle(bot.config?.settings, "mr")}\n\nखालील पर्याय निवडा.`)
        : `${action.reply}\n\n${lang === "en" ? "Tap Choose option below." : "खालील पर्याय निवडा."}`;
    const menuLang = action.setLang || lang;
    const menuText = menuLang === "en" ? bot.config?.settings?.welcomeMessageEn : bot.config?.settings?.welcomeMessage;
    await sendMenu(sock, jid, body, {
      language: languageMenu,
      lang: menuLang,
      page: action.page || 1,
      optionLabels: menuLabelsFromText(menuText),
    });
    if (!languageMenu) (bot.menuPages || (bot.menuPages = {}))[jid] = action.page || 1;
  } else if (action) {
    await sock.sendMessage(jid, { text: action.reply });
  }
  // Bot 2 is additive: Bot 1 above keeps its original rules, replies, and rate limit.
  if (salonAction) {
    const bot2Jid = `${jid}:bot2`;
    if (withinRate(rt, bot2Jid, 20)) {
      rt.sent.get(bot2Jid).push(Date.now());
      if (salonAction.booking || salonAction.persist) save(mobile);
      if (salonAction.choices || salonAction.urlButton) await sendChoices(sock, jid, salonAction.reply, salonAction.choices || [], salonAction.urlButton, salonAction.callButton ? finalCallButton || salonAction.callButton : null);
      else await sock.sendMessage(jid, { text: typeof salonAction === "string" ? salonAction : salonAction.reply });
      if (salonAction.followUp?.choices?.length) await sendChoices(sock, jid, salonAction.followUp.reply, salonAction.followUp.choices);
      const cancelledBooking = salonAction.persist ? (bot.bookings || []).find((entry) => entry.status === "cancelled" && String(entry.number || "").replace(/\D/g, "") === String(contact.number || "").replace(/\D/g, "") && Date.now() - Number(entry.cancelledAt || 0) < 10000) : null;
      const notificationBooking = salonAction.booking || cancelledBooking;
      if (notificationBooking && settingsNumber(bot.config?.settings?.bot2NotifyNumber)) {
        const notifyNumber = settingsNumber(bot.config.settings.bot2NotifyNumber);
        if (notifyNumber !== String(notificationBooking.number || "").replace(/\D/g, "")) {
          const notifyJid = `${notifyNumber}@s.whatsapp.net`;
          const isCancellation = !!cancelledBooking;
          const ownerMessage = `${isCancellation ? "❌ Appointment cancelled" : "✅ New appointment booked"}\nSalon: ${bot.config?.settings?.bot2SalonName || "Salon"}\nService: ${notificationBooking.service}\nDate: ${salonBookingDate(notificationBooking)}\nTime: ${salonBookingTime(notificationBooking)}\nCustomer: ${notificationBooking.name || "Customer"}\nMobile: ${notificationBooking.number || "WhatsApp"}\nWorker: ${notificationBooking.worker || "Worker 1"}`;
          try { await sock.sendMessage(notifyJid, { text: ownerMessage }); }
          catch (error) { console.warn(`[bot ${mobile}] owner ${isCancellation ? "cancellation" : "booking"} alert failed:`, error.message || error); }
        }
      }
    }
  }
  if (bot3Reply || bot3FlowReply) {
    const bot3Jid = `${jid}:bot3`;
    if (withinRate(rt, bot3Jid)) {
      rt.sent.get(bot3Jid).push(Date.now());
      if (bot3Reply) await sendChoices(sock, jid, bot3Reply, [{ id: "swas_b3_interested", title: bot3Settings.bot3InterestedLabel || "Interested" }]);
      else if (bot3RepeatInterested) await sendChoices(sock, jid, bot3FlowReply, [{ id: "swas_b3_interested", title: bot3Settings.bot3InterestedLabel || "Interested" }], finalUrlButton, finalCallButton);
      else await sock.sendMessage(jid, { text: bot3FlowReply });
    }
  }
  if (bot4FlowReply) {
    const bot4Jid = `${jid}:bot4`;
    if (withinRate(rt, bot4Jid, 20)) {
      rt.sent.get(bot4Jid).push(Date.now());
      if (bot4Choices?.length || bot4UrlButton || bot4CallButton) await sendChoices(sock, jid, bot4FlowReply, bot4Choices || [], bot4UrlButton, bot4CallButton);
      else await sock.sendMessage(jid, { text: bot4FlowReply });
    }
  }
  if (bot5Reply) {
    const bot5Jid = `${jid}:bot5`;
    if (withinRate(rt, bot5Jid, 20)) {
      rt.sent.get(bot5Jid).push(Date.now());
      if (bot5Reply.length > 1000) {
        // Interactive messages have a short body limit - send long details as text, buttons after.
        await sock.sendMessage(jid, { text: bot5Reply });
        if (finalUrlButton || finalCallButton) await sendChoices(sock, jid, "\u{1F4CD} / \u{1F4DE}", [], finalUrlButton, finalCallButton);
      } else if (bot5Choices.length || finalUrlButton || finalCallButton) await sendChoices(sock, jid, bot5Reply, bot5Choices, finalUrlButton, finalCallButton);
      else await sock.sendMessage(jid, { text: bot5Reply });
    }
  }
  if (bot6Reply) {
    const bot6Jid = `${jid}:bot6`;
    if (withinRate(rt, bot6Jid, 20)) {
      rt.sent.get(bot6Jid).push(Date.now());
      const website = String(bot3Settings.bot6Website || "").trim();
      const button = /^https?:\/\//i.test(website) ? { title: String(bot3Settings.bot6ButtonText || "").trim() || "\u{1F310} Visit website", url: website } : null;
      if (button) await sendChoices(sock, jid, bot6Reply, [], button, null);
      else await sock.sendMessage(jid, { text: bot6Reply });
    }
  }
  for (const [number, reply] of [[4, bot4Reply]]) {
    if (!reply) continue;
    const botJid = `${jid}:bot${number}`;
    if (withinRate(rt, botJid)) {
      rt.sent.get(botJid).push(Date.now());
      if (finalUrlButton || finalCallButton) await sendChoices(sock, jid, reply, [], finalUrlButton, finalCallButton);
      else await sock.sendMessage(jid, { text: reply });
    }
  }

  if (action?.setLang) bot.langs[jid] = action.setLang; // remember the customer's chosen language
  if (action?.type === "langmenu") {
    (bot.languagePrompt || (bot.languagePrompt = {}))[jid] = true;
  } else if (action?.setLang) {
    delete bot.languagePrompt?.[jid];
  }
  if (action?.type === "unsubscribe") delete bot.sessions[jid];
  else if (action?.type !== "fallback") bot.sessions[jid] = Date.now();
  // Sessions older than a day are no use to anyone; drop them as the file is written.
  for (const [chat, at] of Object.entries(bot.sessions)) {
    if (Date.now() - at > SwasBot.LIMITS.sessionMs) delete bot.sessions[chat];
  }
  save(mobile);
  console.log(`[bot ${mobile}] ${who}: "${text}" -> ${action?.label || (bot6Reply ? "Bot 6 website" : bot5Reply ? "Bot 5 lookup" : bot4FlowReply ? "Bot 4 table booking" : "Bot 2 salon booking")}`);
}

/** Baileys' messages.upsert handler for one account's socket. */
async function onMessages(mobile, sock, { messages, type }) {
  if (type !== "notify") return; // "append" is history being filled in, not new messages
  const bot = load(mobile);
  if (!bot.config) return;

  // The chatbot add-on may be gated off for this customer — but campaign footer STOP handling is a
  // compliance feature (keeps us from messaging people who opted out), not the chatbot, so it stays
  // live either way. With the add-on off we force the chatbot-off config, so only the footer STOP/START
  // keywords act — no rule, welcome, fallback or data-lookup reply goes out.
  const addonOn = chatbotEnabled(mobile);
  const config = addonOn ? buildConfig(bot) : footerOnlyConfig(bot);

  // Nothing to do unless the chatbot is on, or there are campaign footer STOP keywords to honour.
  // Sending is server-side now, so we can't rely on the extension's WhatsApp Web tab to catch a STOP.
  const allowedBots = accountBots(mobile);
  const extraBotActive = allowedBots.has(4) && bot.config?.settings?.bot4Enabled || allowedBots.has(5) && bot.config?.settings?.bot5Enabled || allowedBots.has(6) && bot.config?.settings?.bot6Enabled;
  if (!SwasBot.isActive(config) && !(addonOn && (bot.config?.settings?.bot2SalonEnabled || bot.config?.settings?.bot3Enabled || extraBotActive))) return;
  for (const msg of messages || []) {
    try {
      await answer(mobile, sock, bot, config, msg, { chatbotOn: addonOn });
    } catch (err) {
      console.warn(`[bot ${mobile}] reply failed:`, err.message || err);
    }
  }
}

/**
 * Has this contact asked to stop (replied STOP / 6 / unsubscribe)? Checked before every campaign send
 * so a STOP that lands mid-campaign halts the rest for that number, even with the chatbot add-on off —
 * the footer keywords are honoured regardless, and the Unsubscribers list is kept either way.
 */
function isUnsubscribed(mobile, { name = "", number = "" } = {}) {
  if (!name && !number) return false;
  const list = load(mobile).unsubscribers || [];
  return list.some((entry) => SwasBot.isSameContact(entry, { name, number }));
}

/** The stored chatbot config + unsubscribers for an account, so the web app can load and edit what's live. */
function current(mobile) {
  const bot = load(mobile);
  return {
    settings: bot.config?.settings || null,
    rules: bot.config?.rules || null,
    footerKeywords: bot.config?.footerKeywords || [],
    unsubscribers: bot.unsubscribers || [],
    seq: bot.seq || 0,
  };
}

function appointments(mobile) {
  const bot = load(mobile);
  return (bot.bookings || []).map(({ id, name, number, service, date, dateKey, time, timeKey, worker, createdAt, status }) => ({
    id, name, number, service, date, dateKey, time, timeKey, worker: worker || "Worker 1", createdAt, status,
  }));
}

function interestedLeads(mobile) {
  const bot = load(mobile);
  return (bot.interestedLeads || []).map(({ name, number, city, date, time, createdAt, status, duplicate, duplicateOf }) => ({ name, number, city, date, time, createdAt, status, duplicate, duplicateOf }));
}

function hotelWelcomeTemplate(settings = {}) {
  const template = String(settings.bot4Welcome || "Welcome to {{shop}}, {{branch}}! Your queue number is {{queue}}.");
  return /\{\{\s*branch\s*\}\}/i.test(template) ? template : template.replace(/\{\{\s*shop\s*\}\}/i, "{{shop}}, {{branch}}");
}

function hotelConfirmationMessage(settings = {}, booking = {}, lang = "en") {
  const shop = settings.bot4Name || "";
  const custom = String(settings.bot4ConfirmMessage || "").trim();
  if (custom) {
    const values = { name: booking.name || "Guest", shop, branch: booking.branchName || "Branch", members: booking.members, queue: booking.queueNo, wait: booking.estimatedWaitMinutes, time: booking.time };
    return custom.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (key.toLowerCase() in values ? String(values[key.toLowerCase()] ?? "") : match));
  }
  const fillHotel = (text) => String(text || "").trim().replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
    const values = { name: booking.name || "Guest", shop, branch: booking.branchName || "Branch", members: booking.members, queue: booking.queueNo, wait: booking.estimatedWaitMinutes, time: booking.time };
    return key.toLowerCase() in values ? String(values[key.toLowerCase()] ?? "") : match;
  });
  const hotelHead = [fillHotel(settings.bot4ThankYouMessage), fillHotel(settings.bot4WelcomeMessage)].filter(Boolean).join("\n");
  if (hotelHead) {
    const parts = hotelConfirmationMessage({ ...settings, bot4ThankYouMessage: "", bot4WelcomeMessage: "", bot4ConfirmMessage: "" }, booking, lang).split("\n\n");
    parts[1] = hotelHead;
    return parts.join("\n\n");
  }
  if (lang === "mr") return `\u2705 *\u091f\u0947\u092c\u0932 \u092c\u0941\u0915\u093f\u0902\u0917 \u0928\u093f\u0936\u094d\u091a\u093f\u0924 \u091d\u093e\u0932\u0947!*\n\n\u0927\u0928\u094d\u092f\u0935\u093e\u0926, ${booking.name || "Guest"}! \u{1F64F}\n*${shop} - ${booking.branchName || "Branch"}* \u092f\u0947\u0925\u0947 \u0906\u092a\u0932\u0947 \u0938\u094d\u0935\u093e\u0917\u0924 \u0906\u0939\u0947.\n\n\u{1F465} \u0938\u0926\u0938\u094d\u092f: ${booking.members}\n\u{1F3AB} \u0930\u093e\u0902\u0917 \u0915\u094d\u0930\u092e\u093e\u0902\u0915: ${booking.queueNo}\n\u23F3 \u0905\u0902\u0926\u093e\u091c\u0947 \u092a\u094d\u0930\u0924\u0940\u0915\u094d\u0937\u093e: ${booking.estimatedWaitMinutes} \u092e\u093f\u0928\u093f\u091f\u0947\n\u{1F552} \u0905\u092a\u0947\u0915\u094d\u0937\u093f\u0924 \u0935\u0947\u0933: ${booking.time}\n\n\u0906\u092e\u094d\u0939\u0940 \u0906\u092a\u0932\u0940 \u0938\u0947\u0935\u093e \u0915\u0930\u0923\u094d\u092f\u093e\u0938 \u0909\u0924\u094d\u0938\u0941\u0915 \u0906\u0939\u094b\u0924!`;
  return `\u2705 *Table Booking Confirmed!*\n\nThank you, ${booking.name || "Guest"}! \u{1F64F}\nWelcome to *${shop} - ${booking.branchName || "Branch"}*.\n\n\u{1F465} Members: ${booking.members}\n\u{1F3AB} Queue number: ${booking.queueNo}\n\u23F3 Estimated wait: ${booking.estimatedWaitMinutes} minutes\n\u{1F552} Expected time: ${booking.time}\n\nWe look forward to serving you!`;
}

function hotelBranches(mobile) {
  const settings = load(mobile).config?.settings || {};
  if (Array.isArray(settings.bot4Branches) && settings.bot4Branches.length) return settings.bot4Branches;
  if (settings.bot4Name && String(settings.bot4Latitude ?? "").trim() !== "" && String(settings.bot4Longitude ?? "").trim() !== "") return [{
    id: "main", name: settings.bot4Name, openTime: settings.bot4OpenTime || "10:00", closeTime: settings.bot4CloseTime || "23:00",
    waitMinutes: settings.bot4WaitMinutes || 15, latitude: settings.bot4Latitude, longitude: settings.bot4Longitude, notifyNumber: settings.bot4NotifyNumber || "",
  }];
  return [];
}


function createHotelBooking(mobile, input) {
  const bot = load(mobile);
  if (!bot.config?.settings?.bot4Enabled) throw Object.assign(new Error("Table bookings are currently unavailable."), { status: 403 });
  const branch = hotelBranches(mobile).find((entry) => String(entry.id) === String(input.branchId));
  if (!branch) throw Object.assign(new Error("This branch is unavailable. Please scan its current QR code."), { status: 404 });
  const notifyNumber = String(branch.notifyNumber || "").replace(/\D/g, "");
  if (notifyNumber.length < 7 || notifyNumber.length > 15) throw Object.assign(new Error(`Add a valid booking alert number for ${branch.name}.`), { status: 400 });
  const name = String(input.name || "").trim().slice(0, 80);
  const number = String(input.number || "").replace(/\D/g, "");
  const members = Math.max(1, Math.min(30, Math.floor(Number(input.members) || 0)));
  const lat = Number(input.latitude), lon = Number(input.longitude);
  const branchLat = Number(branch.latitude), branchLon = Number(branch.longitude);
  if (!name || number.length < 7 || number.length > 15 || !members) throw Object.assign(new Error("Enter a valid name, mobile number and party size."), { status: 400 });
  if (String(branch.latitude ?? "").trim() === "" || String(branch.longitude ?? "").trim() === "" || !Number.isFinite(branchLat) || Math.abs(branchLat) > 90 || !Number.isFinite(branchLon) || Math.abs(branchLon) > 180) throw Object.assign(new Error("This branch has no valid saved map coordinates."), { status: 400 });
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) throw Object.assign(new Error("Share your current location to continue."), { status: 400 });
  const radians = (value) => value * Math.PI / 180;
  const dLat = radians(lat - branchLat), dLon = radians(lon - branchLon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(branchLat)) * Math.cos(radians(lat)) * Math.sin(dLon / 2) ** 2;
  const distanceMeters = Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  if (distanceMeters > 50) throw Object.assign(new Error(`You are ${distanceMeters} metres away. Booking is available within 50 metres of ${branch.name}.`), { status: 400 });
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type)?.value || "00";
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  const minuteNow = Number(part("hour")) * 60 + Number(part("minute"));
  const asMinutes = (text) => { const [hour, minute] = String(text || "").split(":").map(Number); return hour * 60 + minute; };
  const opens = asMinutes(branch.openTime || "10:00"), closes = asMinutes(branch.closeTime || "23:00");
  const isOpen = closes < opens ? minuteNow >= opens || minuteNow <= closes : minuteNow >= opens && minuteNow <= closes;
  if (!isOpen) throw Object.assign(new Error(`Bookings for ${branch.name} are accepted from ${branch.openTime || "10:00"} to ${branch.closeTime || "23:00"}.`), { status: 400 });
  bot.hotelBookings ||= [];
  const todays = bot.hotelBookings.filter((entry) => entry.branchId === branch.id && entry.dateKey === date && ["Pending", "Confirmed"].includes(entry.status));
  const queueNo = todays.reduce((max, entry) => Math.max(max, Number(entry.queueNo) || 0), 0) + 1;
  const seatingCapacity = Math.floor(Number(branch.seatingCapacity) || 0);
  if (seatingCapacity > 0 && members > seatingCapacity) throw Object.assign(new Error(`This branch has total seating for ${seatingCapacity} members.`), { status: 400 });
  const waitMinutes = hotelQueueWaitMinutes(branch, todays, members, branch.waitMinutes);
  const booking = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, branchId: branch.id, branchName: branch.name, date, dateKey: date, time: displayTime(new Date(Date.now() + waitMinutes * 60000)), queueNo, name, number, members, distanceMeters, estimatedWaitMinutes: waitMinutes, status: "Confirmed", createdAt: Date.now() };
  bot.hotelBookings.push(booking);
  save(mobile);
  const settings = bot.config?.settings || {};
  return { booking, branch, welcome: hotelConfirmationMessage(settings, booking, "en") };
}


function hotelBookings(mobile) {
  const bot = load(mobile);
  return (bot.hotelBookings || []).map(({ id, name, number, members, queueNo, dateKey, date, time, distanceMeters, status, createdAt, confirmedAt, branchId, branchName, estimatedWaitMinutes }) => ({
    id, name, number, members, queueNo, dateKey, date, time, distanceMeters, status, createdAt, confirmedAt, branchId, branchName, estimatedWaitMinutes,
  }));
}

/** The built-in default settings and rules (the Marathi starter menu), for a first-time setup. */
function defaults() {
  return { settings: SwasBot.DEFAULT_SETTINGS, rules: SwasBot.DEFAULT_RULES };
}

module.exports = { callSettings, setCallSettings, sync, onMessages, current, appointments, interestedLeads, hotelBranches, hotelWelcomeTemplate, createHotelBooking, hotelBookings, defaults, isUnsubscribed };
