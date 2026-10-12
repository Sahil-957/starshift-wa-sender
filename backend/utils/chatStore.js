/**
 * Records every message that flows through an account's WhatsApp (Baileys) to a per-account log, so the
 * dashboard's Chat Extract can later hand the user an Excel of any one chat (a number or a group) over a
 * chosen date range. Baileys keeps no message history of its own, so this is the only store there is:
 * chats fill in from the moment recording starts, plus whatever WhatsApp back-syncs when the account links.
 *
 * One line of JSON per message in data/chats/<mobile>.jsonl. We dedupe on the WhatsApp message id at read
 * time, so the same message arriving from both the live upsert and the history sync is only exported once.
 */
const fs = require("fs");
const path = require("path");
const { normalizeMessageContent, isJidGroup, isJidBroadcast, isJidNewsletter } = require("@whiskeysockets/baileys");

const CHATS_DIR = path.join(__dirname, "..", "data", "chats");

function chatFile(mobile) {
  return path.join(CHATS_DIR, `${String(mobile).replace(/\D/g, "")}.jsonl`);
}

/** Digits of the phone in a jid like "919876543210@s.whatsapp.net" / "...:3@..."; "" for @lid or group jids. */
function phoneFromJid(jid) {
  return /^(\d{7,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid || "")?.[1] || "";
}

/** The readable text of a message, across the shapes WhatsApp uses; "" when there's nothing to show. */
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

/** A short label for an attachment with no caption, so the row isn't blank. "" for a plain text message. */
function mediaLabel(msg) {
  const content = normalizeMessageContent(msg.message) || {};
  if (content.imageMessage) return "[image]";
  if (content.videoMessage) return content.videoMessage.gifPlayback ? "[gif]" : "[video]";
  if (content.audioMessage) return content.audioMessage.ptt ? "[voice note]" : "[audio]";
  if (content.stickerMessage) return "[sticker]";
  if (content.documentMessage) return `[document: ${content.documentMessage.fileName || "file"}]`;
  if (content.contactMessage || content.contactsArrayMessage) return "[contact]";
  if (content.locationMessage) return "[location]";
  return "";
}

/** Reactions, edits, deletes, poll updates and receipts arrive as messages too; only real chat lines count. */
function isRealMessage(msg) {
  const content = normalizeMessageContent(msg.message);
  if (!content) return false;
  return !content.protocolMessage && !content.reactionMessage && !content.pollUpdateMessage;
}

/** Turns one Baileys message into the flat record we store, or null if it's not worth keeping. */
function toRecord(msg) {
  const chatJid = msg.key?.remoteJid;
  if (!chatJid || isJidBroadcast(chatJid) || isJidNewsletter(chatJid)) return null;
  if (!isRealMessage(msg)) return null;

  const group = isJidGroup(chatJid);
  const text = messageText(msg) || mediaLabel(msg);
  if (!text) return null;

  const fromMe = !!msg.key?.fromMe;
  // Who sent it: in a group it's the participant; in a 1:1 it's the chat itself (or me, when I sent it).
  const senderJid = fromMe ? "" : group ? (msg.key.participantAlt || msg.key.participant || "") : chatJid;
  const senderNumber = fromMe ? "" : phoneFromJid(senderJid) || phoneFromJid(msg.key.senderPn);

  return {
    id: msg.key?.id || "",
    t: (Number(msg.messageTimestamp) || 0) * 1000, // ms since epoch
    chatJid,
    group,
    chatNumber: group ? "" : phoneFromJid(chatJid),
    fromMe,
    senderNumber,
    senderName: fromMe ? "" : msg.pushName || "",
    text,
  };
}

/** Appends one line of JSON; a message with no timestamp or no id is skipped (we can't date or dedupe it). */
function append(mobile, rec) {
  if (!rec || !rec.t || !rec.id) return;
  try {
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    fs.appendFileSync(chatFile(mobile), JSON.stringify(rec) + "\n");
  } catch {
    /* disk full or folder removed mid-write - a dropped line is better than a crashed socket */
  }
}

/** Store a batch of raw Baileys messages (from the live upsert or the history sync). */
function record(mobile, messages) {
  for (const msg of messages || []) {
    try {
      append(mobile, toRecord(msg));
    } catch {
      /* one malformed message never stops the rest */
    }
  }
}

/** Every stored record for an account, newest first, deduped on message id. */
function readAll(mobile) {
  let raw = "";
  try {
    raw = fs.readFileSync(chatFile(mobile), "utf8");
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    out.push(rec);
  }
  return out.sort((a, b) => b.t - a.t);
}

/** The chats we have at least one message for: [{ jid, group, number, count, lastAt }] - for the picker. */
function chats(mobile) {
  const byJid = new Map();
  for (const rec of readAll(mobile)) {
    const c = byJid.get(rec.chatJid) || { jid: rec.chatJid, group: rec.group, number: rec.chatNumber, count: 0, lastAt: 0 };
    c.count += 1;
    c.lastAt = Math.max(c.lastAt, rec.t);
    byJid.set(rec.chatJid, c);
  }
  return [...byJid.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** The oldest stored message for a chat, as the anchor for an on-demand history fetch; null if none. */
function oldestRecord(mobile, jid) {
  const mine = readAll(mobile).filter((r) => r.chatJid === jid && r.id);
  return mine.length ? mine[mine.length - 1] : null; // readAll is newest-first
}

const RANGE_DAYS = { today: 0, "7days": 7, "15days": 15, "1month": 30, "2months": 60, all: null };

/** Start-of-window timestamp (ms) for a named range; 0 means "no lower bound" (all). */
function cutoff(range) {
  if (range === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const days = RANGE_DAYS[range];
  if (days == null) return 0; // "all" or unknown
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

/**
 * Messages for an export, oldest first (reads naturally top-to-bottom in Excel).
 * jid "" / "all" means every chat; range is one of RANGE_DAYS.
 */
function messages(mobile, { jid = "", range = "all" } = {}) {
  const from = cutoff(range);
  return readAll(mobile)
    .filter((rec) => rec.t >= from && (!jid || jid === "all" || rec.chatJid === jid))
    .sort((a, b) => a.t - b.t);
}

module.exports = { record, chats, messages, oldestRecord, RANGE_DAYS };
