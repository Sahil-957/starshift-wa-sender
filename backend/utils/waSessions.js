/**
 * One WhatsApp connection per account, run here on the server (Baileys - no browser), so campaigns send
 * files and captions without WhatsApp Web being open, visible or even running. Each account links its own
 * WhatsApp once by scanning a QR code; the login is kept in data/wa-sessions/<mobile> and reused after
 * a restart.
 */
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const waBot = require("./waBot");
const chatStore = require("./chatStore");
const { writeJsonAtomic } = require("./atomicWrite");

const SESSIONS_DIR = path.join(__dirname, "..", "data", "wa-sessions");
const logger = pino({ level: "silent" });
const sessions = new Map(); // mobile -> { sock, state, qr, me, groups }

function authDir(mobile) {
  return path.join(SESSIONS_DIR, mobile);
}

function contactsFile(mobile) {
  return path.join(authDir(mobile), "contacts.json");
}

function loadContacts(mobile) {
  try {
    return JSON.parse(fs.readFileSync(contactsFile(mobile), "utf8"));
  } catch {
    return {};
  }
}

function saveContacts(mobile, contacts) {
  try {
    writeJsonAtomic(contactsFile(mobile), contacts);
  } catch {
    /* session folder removed by an unlink in the meantime */
  }
}

// Best display name per jid, in original case (the label->jid map above is lowercased for matching).
function namesFile(mobile) {
  return path.join(authDir(mobile), "names.json");
}
function loadNames(mobile) {
  try {
    return JSON.parse(fs.readFileSync(namesFile(mobile), "utf8"));
  } catch {
    return {};
  }
}
function saveNames(mobile, names) {
  try {
    writeJsonAtomic(namesFile(mobile), names);
  } catch {
    /* session folder removed */
  }
}
const looksNumeric = (s) => /^\+?[\d\s()-]+$/.test(s);

/** Reads WhatsApp's saved @lid -> phone map for a group sender; "" if there's no mapping on disk. */
function lidPhoneFromFile(mobile, lidJid) {
  const lid = /^(\d+)@lid$/.exec(lidJid || "")?.[1];
  if (!lid) return "";
  try {
    return String(JSON.parse(fs.readFileSync(path.join(authDir(mobile), `lid-mapping-${lid}_reverse.json`), "utf8"))).replace(/\D/g, "");
  } catch {
    return "";
  }
}

function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

function status(mobile) {
  const s = sessions.get(mobile);
  if (!s) return { state: "disconnected" };
  return {
    state: s.state,
    qr: s.state === "qr" ? s.qr : undefined,
    pairingCode: s.state === "pairing" ? s.pairingCode : undefined,
    me: s.me,
  };
}

/** opts.pairingPhone: link by entering a code on the phone instead of scanning the QR (that number's code). */
async function connect(mobile, opts = {}) {
  const existing = sessions.get(mobile);
  if (existing && existing.state !== "disconnected") return status(mobile);

  const session = existing || { state: "connecting" };
  session.state = "connecting";
  session.usePairing = !!opts.pairingPhone;
  session.pairingCode = null;
  sessions.set(mobile, session);

  const { state: auth, saveCreds } = await useMultiFileAuthState(authDir(mobile));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const sock = makeWASocket({ auth, version, logger, browser: ["Starshift WA Sender", "Chrome", "1.0"] });
  session.sock = sock;
  session.groups = null;

  sock.ev.on("creds.update", saveCreds);
  // Saved contacts' names arrive with the history sync and later updates; kept so a campaign can pick a
  // contact by the name WhatsApp Web shows.
  session.contacts = session.contacts || loadContacts(mobile);
  session.names = session.names || loadNames(mobile);
  const remember = (list) => {
    let changed = false;
    let namesChanged = false;
    for (const c of list || []) {
      if (!c.id || c.id.endsWith("@g.us")) continue;
      for (const label of [c.name, c.notify, c.verifiedName]) {
        const key = (label || "").trim().toLowerCase();
        if (key && session.contacts[key] !== c.id) {
          session.contacts[key] = c.id;
          changed = true;
        }
      }
      // The address-book name (name/verifiedName) over the phone-number notify, in original case.
      const best = [c.name, c.verifiedName, c.notify].map((x) => (x || "").trim()).find((x) => x && !looksNumeric(x));
      if (best && session.names[c.id] !== best) {
        session.names[c.id] = best;
        namesChanged = true;
      }
    }
    if (changed) saveContacts(mobile, session.contacts);
    if (namesChanged) saveNames(mobile, session.names);
  };
  sock.ev.on("messages.upsert", (event) => {
    if (session.sock !== sock) return; // a superseded socket stays quiet
    chatStore.record(mobile, event.messages); // keep a copy for Chat Extract
    waBot.onMessages(mobile, sock, event);
  });
  sock.ev.on("contacts.upsert", remember);
  sock.ev.on("contacts.update", remember);
  sock.ev.on("messaging-history.set", ({ contacts, messages }) => {
    remember(contacts);
    if (session.sock === sock) chatStore.record(mobile, messages); // back-fill from WhatsApp's history sync
  });
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (sessions.get(mobile) !== session || session.sock !== sock) return; // superseded
    if (qr && !session.usePairing) {
      session.state = "qr";
      session.qr = await QRCode.toDataURL(qr);
    }
    if (connection === "open") {
      session.state = "open";
      session.qr = null;
      session.me = (sock.user?.id || "").split(":")[0].split("@")[0];
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.warn(`[wa ${mobile}] connection closed - code ${code} (${lastDisconnect?.error?.message || "?"})`);
      if (code === DisconnectReason.loggedOut) {
        // Unlinked from the phone: forget the login so the next connect shows a fresh QR.
        fs.rmSync(authDir(mobile), { recursive: true, force: true });
        session.state = "disconnected";
        session.me = null;
      } else {
        // Network drop, restart request after pairing, etc. - reconnect with the saved login.
        session.state = "disconnected";
        setTimeout(() => connect(mobile).catch(() => {}), 3000);
      }
    }
  });

  // Phone-number linking: ask WhatsApp for an 8-character code the user types into their phone, instead of
  // scanning the QR. Only for a fresh link (an already-registered login just reconnects).
  if (opts.pairingPhone && !auth.creds?.registered) {
    const phone = String(opts.pairingPhone).replace(/\D/g, "");
    try {
      await new Promise((r) => setTimeout(r, 1500)); // let the socket open its connection first
      if (session.sock === sock && !auth.creds?.registered) {
        session.pairingCode = await sock.requestPairingCode(phone);
        session.state = "pairing";
      }
    } catch (err) {
      console.warn(`[wa ${mobile}] pairing code request failed:`, err.message || err);
      session.usePairing = false; // fall back to the QR, which is still being offered
    }
  }
  return status(mobile);
}

async function logout(mobile) {
  const s = sessions.get(mobile);
  sessions.delete(mobile);
  if (s?.sock) await s.sock.logout().catch(() => s.sock.end(undefined));
  fs.rmSync(authDir(mobile), { recursive: true, force: true });
}

function openSocket(mobile) {
  const s = sessions.get(mobile);
  if (!s || s.state !== "open") {
    throw new Error("Server WhatsApp is not connected. Link it from the dashboard (Server WhatsApp) first.");
  }
  return s;
}

async function groupJidByName(session, name) {
  if (!session.groups) session.groups = await session.sock.groupFetchAllParticipating();
  const wanted = name.trim().toLowerCase();
  const match = Object.values(session.groups).find((g) => (g.subject || "").trim().toLowerCase() === wanted);
  if (!match) {
    session.groups = null; // maybe joined since the list was read; re-read next time
    throw new Error(`Group "${name}" not found in the linked WhatsApp.`);
  }
  return match.id;
}

function contactJidByName(session, name) {
  const jid = session.contacts?.[name.trim().toLowerCase()];
  if (!jid) throw notFound(`Contact "${name}" is not known to the server WhatsApp yet.`);
  return jid;
}

async function numberJid(session, phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) throw new Error("No mobile number for this contact.");
  const [found] = await session.sock.onWhatsApp(digits);
  if (!found?.exists) throw new Error(`${digits} is not on WhatsApp.`);
  return found.jid;
}

function mediaContent({ dataUrl, name, mimeType }, caption) {
  const buffer = Buffer.from(String(dataUrl).split(",")[1] || "", "base64");
  const mimetype = mimeType || "application/octet-stream";
  if (mimetype.startsWith("image/") && mimetype !== "image/gif") return { image: buffer, mimetype, caption };
  if (mimetype.startsWith("video/") || mimetype === "image/gif") {
    return { video: buffer, mimetype, caption, gifPlayback: mimetype === "image/gif" };
  }
  return { document: buffer, mimetype, fileName: name || "file", caption };
}

/** target: { type: "number" | "group" | "contact", phone?, name? }. Sends the file with its caption as one message. */
async function send(mobile, { target, message, attachment }) {
  const session = openSocket(mobile);
  const jid =
    target.type === "group"
      ? await groupJidByName(session, target.name)
      : target.type === "contact"
        ? contactJidByName(session, target.name)
        : await numberJid(session, target.phone);

  if (attachment?.dataUrl) {
    // Same rule as the WhatsApp Web path: the caption, or the message when there is no caption.
    await session.sock.sendMessage(jid, mediaContent(attachment, attachment.caption || message || undefined));
  } else {
    await session.sock.sendMessage(jid, { text: message });
  }
}

/** Sends a plain text message from one linked account to a phone number (used for WhatsApp OTP delivery). */
async function sendText(fromMobile, toNumber, text) {
  const session = openSocket(fromMobile); // throws a clear error if that account isn't linked
  const jid = await numberJid(session, toNumber); // also checks the number is on WhatsApp
  await session.sock.sendMessage(jid, { text });
}

/** Saved contacts the server's WhatsApp knows, as [{ name, number }] - for the dashboard's Contact picker. */
function contacts(mobile) {
  const s = sessions.get(mobile);
  const names = s?.names || loadNames(mobile); // jid -> best original-case name
  const map = s?.contacts || loadContacts(mobile); // lowercased label -> jid
  const byJid = {};
  for (const [label, jid] of Object.entries(map)) {
    if (jid.endsWith("@g.us")) continue;
    (byJid[jid] ||= []).push(label);
  }
  // Every jid that has a name (even if not in the label map) should appear too.
  for (const jid of Object.keys(names)) byJid[jid] ||= [];
  return Object.keys(byJid)
    .map((jid) => ({
      name: names[jid] || byJid[jid].filter((n) => !looksNumeric(n)).sort((a, b) => b.length - a.length)[0] || "",
      number: jid.split("@")[0],
    }))
    .sort((a, b) => (b.name ? 1 : 0) - (a.name ? 1 : 0) || (a.name || a.number).localeCompare(b.name || b.number));
}

/** The groups this account's WhatsApp is in, as [{ name, jid }] - for the Group and Chat Extract pickers. */
async function groups(mobile) {
  const s = sessions.get(mobile);
  if (!s || s.state !== "open") throw new Error("Server WhatsApp is not connected. Link it first.");
  const all = await s.sock.groupFetchAllParticipating();
  return Object.values(all)
    .map((g) => ({ name: g.subject || "", jid: g.id }))
    .filter((g) => g.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** All members of one group as [{ name, number, role }] - for exporting a group's contacts to Excel. */
async function groupMembers(mobile, groupJid) {
  const session = openSocket(mobile);
  if (!groupJid || !groupJid.endsWith("@g.us")) throw new Error("Pick a group to export its members.");
  const meta = await session.sock.groupMetadata(groupJid);
  const names = session.names || loadNames(mobile);
  const rows = [];
  for (const p of meta.participants || []) {
    const id = p.id || "";
    // A member id is a @lid or a @s.whatsapp.net jid; resolve a number from whichever form it takes.
    let number = /@s\.whatsapp\.net$/.test(id) ? id.split("@")[0] : lidPhoneFromFile(mobile, id);
    if (!number && p.jid && /@s\.whatsapp\.net$/.test(p.jid)) number = p.jid.split("@")[0];
    if (!number && p.phoneNumber) number = String(p.phoneNumber).replace(/\D/g, "");
    const name = names[id] || (p.jid && names[p.jid]) || (number ? names[`${number}@s.whatsapp.net`] : "") || "";
    rows.push({ name, number, role: p.admin === "superadmin" ? "Owner" : p.admin ? "Admin" : "Member" });
  }
  rows.sort((a, b) => (a.name || a.number).localeCompare(b.name || b.number));
  return { subject: meta.subject || "", members: rows };
}

// ---------- Chat Extract ----------
// chatStore keeps the raw messages (jids, numbers, text); the display name of each chat is resolved here,
// where the contact names and group subjects live.

/** { names: jid->contact name, groups: jid->group subject }. Group subjects need a live connection. */
async function chatNames(mobile) {
  const s = sessions.get(mobile);
  const names = s?.names || loadNames(mobile);
  const groups = {};
  if (s && s.state === "open") {
    try {
      const all = s.groups || (s.groups = await s.sock.groupFetchAllParticipating());
      for (const g of Object.values(all)) groups[g.id] = g.subject || "";
    } catch {
      /* offline or throttled - fall back to the group jid */
    }
  }
  return { names, groups };
}

function displayChat(jid, group, number, { names, groups }) {
  if (group) return groups[jid] || "Group";
  return names[jid] || number || (jid || "").split("@")[0];
}

/** The chats we have messages for, with a readable name and a count - for the Chat Extract picker. */
async function chatList(mobile) {
  const resolve = await chatNames(mobile);
  return chatStore.chats(mobile).map((c) => ({
    jid: c.jid,
    group: c.group,
    number: c.number,
    count: c.count,
    name: displayChat(c.jid, c.group, c.number, resolve),
  }));
}

const DIGITS_JID = /^(\d{7,15})(?::\d+)?@(?:s\.whatsapp\.net|lid)$/;

/** Flat export rows (oldest first) for one chat or all chats over a date range. opts: { jid, range }. */
async function chatExport(mobile, opts) {
  const resolve = await chatNames(mobile);
  const s = sessions.get(mobile);
  const lidToPhone = new Map(); // @lid jid -> phone, resolved once per export

  /** The phone for a group sender, resolving an @lid id to its number. opts.jid senders are @lid in groups. */
  async function senderPhone(r) {
    if (r.senderNumber) return r.senderNumber;
    const sj = r.senderJid || "";
    const direct = DIGITS_JID.exec(sj.endsWith("@s.whatsapp.net") ? sj : "")?.[1];
    if (direct) return direct;
    if (!sj.endsWith("@lid")) return "";
    if (!lidToPhone.has(sj)) {
      // WhatsApp saves the @lid -> phone map to disk (lid-mapping-<lid>_reverse.json); read that first, as
      // it works even when the socket is offline. Fall back to the live mapping API if the file is missing.
      let phone = lidPhoneFromFile(mobile, sj);
      if (!phone && s?.sock?.signalRepository?.lidMapping?.getPNForLID) {
        const pn = await s.sock.signalRepository.lidMapping.getPNForLID(sj).catch(() => "");
        phone = /^(\d{7,15})/.exec((pn || "").split("@")[0])?.[1] || "";
      }
      lidToPhone.set(sj, phone);
    }
    return lidToPhone.get(sj);
  }

  const rows = chatStore.messages(mobile, opts);
  const out = [];
  for (const r of rows) {
    if (r.fromMe) {
      out.push({ at: r.t, chat: displayChat(r.chatJid, r.group, r.chatNumber, resolve), type: r.group ? "Group" : "Direct", direction: "Sent", name: "", number: "", text: r.text });
      continue;
    }
    const number = r.group ? await senderPhone(r) : r.chatNumber || (await senderPhone(r));
    const name =
      r.senderName ||
      resolve.names[r.senderJid] ||
      (number ? resolve.names[`${number}@s.whatsapp.net`] : "") ||
      (r.group ? "" : displayChat(r.chatJid, r.group, r.chatNumber, resolve));
    out.push({
      at: r.t,
      chat: displayChat(r.chatJid, r.group, r.chatNumber, resolve),
      type: r.group ? "Group" : "Direct",
      direction: "Received",
      name,
      number,
      text: r.text,
    });
  }
  return out;
}

/**
 * Asks WhatsApp for older messages of one chat (Baileys on-demand history sync). The messages don't come
 * back here - WhatsApp delivers them a few seconds later on the messaging-history.set event, where they're
 * recorded like any other. Needs at least one already-stored message in that chat to anchor the request.
 */
async function fetchHistory(mobile, { jid, count = 50 } = {}) {
  const session = openSocket(mobile);
  if (!jid || jid === "all") throw new Error("Pick one chat (a group or a contact) to load older messages for.");
  const anchor = chatStore.oldestRecord(mobile, jid);
  if (!anchor) {
    throw notFound(
      "No message is stored for this chat yet, so there's nothing to load older from. " +
        "Get one message into it first (send or receive one), or Unlink and re-link the WhatsApp once to back-fill every chat's history at once."
    );
  }
  const key = { remoteJid: anchor.chatJid, id: anchor.id, fromMe: !!anchor.fromMe };
  await session.sock.fetchMessageHistory(Math.min(Math.max(Number(count) || 50, 1), 50), key, anchor.t);
  return { requested: true, from: anchor.t };
}

// On restart every linked account has to reconnect. Firing all of them at once (100+ Baileys
// handshakes in the same tick) spikes CPU and gets the connections throttled by WhatsApp, so they
// are brought up a few at a time with a gap between batches. The server is usable immediately;
// the later accounts just come online over the next minute or two.
const RESTORE_BATCH = 5;
const RESTORE_GAP_MS = 4000;

/** Reconnects every account that was linked before the server restarted, in small staggered batches. */
function restoreAll() {
  if (!fs.existsSync(SESSIONS_DIR)) return;
  const pending = fs
    .readdirSync(SESSIONS_DIR)
    .filter((mobile) => fs.existsSync(path.join(authDir(mobile), "creds.json")));

  const startBatch = () => {
    for (const mobile of pending.splice(0, RESTORE_BATCH)) connect(mobile).catch(() => {});
    if (pending.length) setTimeout(startBatch, RESTORE_GAP_MS);
  };
  startBatch();
}

module.exports = { connect, status, logout, send, sendText, contacts, groups, groupMembers, chatList, chatExport, fetchHistory, restoreAll };
