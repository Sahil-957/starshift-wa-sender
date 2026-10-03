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
const { normalizeMessageContent, isJidGroup, isJidBroadcast, isJidNewsletter } = require("@whiskeysockets/baileys");

require(path.join(__dirname, "..", "..", "extension", "common", "chatbot.js")); // defines globalThis.SwasBot
const { SwasBot } = globalThis;

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
    bots.set(mobile, { config: null, unsubscribers: [], changes: [], seq: 0, sessions: {}, ...saved });
  }
  return bots.get(mobile);
}

function save(mobile) {
  fs.mkdirSync(BOTS_DIR, { recursive: true });
  fs.writeFileSync(botFile(mobile), JSON.stringify(bots.get(mobile)));
}

function runtime(mobile) {
  if (!runtimes.has(mobile)) runtimes.set(mobile, { handled: new Set(), sent: new Map() });
  return runtimes.get(mobile);
}

function buildConfig(bot) {
  const { settings, rules, footerKeywords } = bot.config || {};
  return SwasBot.buildConfig(settings, rules, footerKeywords);
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
  if (config) bot.config = config;
  // A seq ahead of ours means the server's file was reset; start the extension over from nothing.
  const after = Number(since) > bot.seq ? 0 : Number(since) || 0;
  bot.changes = bot.changes.filter((change) => change.seq > after);
  if (Array.isArray(unsubscribers)) {
    bot.unsubscribers = bot.changes.reduce(applyChange, unsubscribers.map(String));
  }
  save(mobile);
  return { changes: bot.changes, seq: bot.seq, active: buildConfig(bot).enabled };
}

function messageText(msg) {
  const content = normalizeMessageContent(msg.message) || {};
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    ""
  );
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
function withinRate(rt, jid) {
  const recent = (rt.sent.get(jid) || []).filter((at) => Date.now() - at < 60 * 1000);
  rt.sent.set(jid, recent);
  return recent.length < SwasBot.LIMITS.repliesPerMinute;
}

async function answer(mobile, sock, bot, config, msg) {
  const jid = msg.key?.remoteJid;
  if (!jid || msg.key.fromMe || isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) return;
  if (!isRealMessage(msg)) return;
  const sentAt = Number(msg.messageTimestamp) * 1000;
  if (sentAt && Date.now() - sentAt > MAX_AGE_MS) return;

  const rt = runtime(mobile);
  if (rt.handled.has(msg.key.id)) return;
  rt.handled.add(msg.key.id);
  if (rt.handled.size > MAX_HANDLED) rt.handled.delete(rt.handled.values().next().value);

  const text = messageText(msg);
  const contact = { name: msg.pushName || "", number: await phoneOf(sock, msg.key) };
  const who = contact.number || contact.name || jid;
  const unsubscribed = bot.unsubscribers.some((entry) => SwasBot.isSameContact(entry, contact));
  const inSession = Date.now() - (bot.sessions[jid] || 0) < SwasBot.LIMITS.sessionMs;
  const action = SwasBot.matchMessage(text, config, { unsubscribed, inSession });
  if (!action) {
    console.log(`[bot ${mobile}] ${who}: "${text}" - no reply${unsubscribed ? " (unsubscribed)" : ""}`);
    return;
  }

  if (action.type === "unsubscribe") {
    record(mobile, bot, { op: "add", entries: [contact.number || contact.name].filter(Boolean) });
  }
  if (action.type === "start" && unsubscribed) {
    record(mobile, bot, { op: "remove", entries: bot.unsubscribers.filter((entry) => SwasBot.isSameContact(entry, contact)) });
  }
  if (!withinRate(rt, jid)) {
    console.log(`[bot ${mobile}] ${who}: ${action.label} - too many replies this minute, skipped`);
    return;
  }

  rt.sent.get(jid).push(Date.now());
  await sock.sendMessage(jid, { text: action.reply });

  if (action.type === "unsubscribe") delete bot.sessions[jid];
  else if (action.type !== "fallback") bot.sessions[jid] = Date.now();
  // Sessions older than a day are no use to anyone; drop them as the file is written.
  for (const [chat, at] of Object.entries(bot.sessions)) {
    if (Date.now() - at > SwasBot.LIMITS.sessionMs) delete bot.sessions[chat];
  }
  save(mobile);
  console.log(`[bot ${mobile}] ${who}: "${text}" -> ${action.label}`);
}

/** Baileys' messages.upsert handler for one account's socket. */
async function onMessages(mobile, sock, { messages, type }) {
  if (type !== "notify") return; // "append" is history being filled in, not new messages
  const bot = load(mobile);
  if (!bot.config) return;
  const config = buildConfig(bot);
  // Only with the chatbot on. With it off, the extension only syncs when its settings change, so a
  // footer-only STOP stays with the WhatsApp Web tab and is never answered twice.
  if (!config.enabled) return;
  for (const msg of messages || []) {
    try {
      await answer(mobile, sock, bot, config, msg);
    } catch (err) {
      console.warn(`[bot ${mobile}] reply failed:`, err.message || err);
    }
  }
}

module.exports = { sync, onMessages };
