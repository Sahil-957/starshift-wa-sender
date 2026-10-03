/**
 * Server-side campaign engine (Phase 1: text campaigns with a time-gap).
 *
 * The extension's background service worker (extension/background/background.js) used to run this
 * loop in the customer's browser. Here it runs on the server instead, so a campaign keeps sending
 * even when the customer's browser is closed. One account's campaigns are saved to
 * data/campaigns/<mobile>.json and resumed after a server restart (restoreAll).
 *
 * Phase 1 scope: individual numbers, fixed gap between sends, Send Now or Schedule for later,
 * pause / resume / cancel. Attachments, groups/contacts-by-name, batch pauses and repeat are Phase 2.
 */
const fs = require("fs");
const path = require("path");
const wa = require("./waSessions");
const userStore = require("./userStore");
const { personalize, withFooter } = require("./messaging");
const { writeJsonAtomic } = require("./atomicWrite");

const DIR = path.join(__dirname, "..", "data", "campaigns");
const MEDIA_DIR = path.join(DIR, "media");
const MIN_GAP_SECONDS = 1;
// When the account's WhatsApp isn't linked/open yet, wait and re-check instead of failing the campaign.
const WAIT_FOR_WA_MS = 30 * 1000;

const timers = new Map(); // "<mobile>:<id>" -> Timeout
const locks = new Set(); // "<mobile>:<id>" currently mid-send

function key(mobile, id) {
  return `${mobile}:${id}`;
}

function file(mobile) {
  return path.join(DIR, `${String(mobile).replace(/\D/g, "")}.json`);
}

function loadAll(mobile) {
  try {
    return JSON.parse(fs.readFileSync(file(mobile), "utf8"));
  } catch {
    return [];
  }
}

function saveAll(mobile, campaigns) {
  writeJsonAtomic(file(mobile), campaigns);
}

// The attachment's base64 data URL is large, so it lives in its own file and is loaded only when sending -
// keeping the per-account campaigns JSON small and quick to rewrite after every message.
function mediaFile(mobile, id) {
  return path.join(MEDIA_DIR, `${String(mobile).replace(/\D/g, "")}-${id}.json`);
}

function saveMedia(mobile, id, media) {
  writeJsonAtomic(mediaFile(mobile, id), media);
}

function loadMedia(mobile, id) {
  try {
    return JSON.parse(fs.readFileSync(mediaFile(mobile, id), "utf8"));
  } catch {
    return null;
  }
}

function find(mobile, id) {
  return loadAll(mobile).find((c) => c.id === id) || null;
}

/** Applies a change to one campaign and saves; returns the updated campaign or null. */
function update(mobile, id, mutator) {
  const campaigns = loadAll(mobile);
  const idx = campaigns.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  mutator(campaigns[idx]);
  saveAll(mobile, campaigns);
  return campaigns[idx];
}

/** Why this account can't send right now (inactive or plan ended), or null if it can. Admin is always fine. */
function accessProblem(mobile) {
  if (mobile === process.env.ADMIN_MOBILE) return null;
  const user = userStore.get(mobile);
  if (!user?.active) return "Your account is not active. Please contact the seller.";
  if (user.expiresAt && Date.parse(user.expiresAt) <= Date.now()) {
    return `Your plan expired on ${new Date(user.expiresAt).toDateString()}. Please renew it with the seller.`;
  }
  return null;
}

function clearTimer(mobile, id) {
  const k = key(mobile, id);
  if (timers.has(k)) {
    clearTimeout(timers.get(k));
    timers.delete(k);
  }
}

function armTimer(mobile, id, delayMs) {
  clearTimer(mobile, id);
  timers.set(
    key(mobile, id),
    setTimeout(() => {
      timers.delete(key(mobile, id));
      advance(mobile, id).catch((err) => console.warn(`[campaign ${mobile}/${id}]`, err.message || err));
    }, Math.max(delayMs, 0))
  );
}

/** Sends the next pending message, records the result, and queues the one after it. */
async function advance(mobile, id) {
  const k = key(mobile, id);
  if (locks.has(k)) return;
  locks.add(k);
  try {
    let campaign = find(mobile, id);
    if (!campaign || !["scheduled", "running"].includes(campaign.status)) return;

    // Honour a schedule that is still in the future.
    if (campaign.scheduleAt && campaign.scheduleAt > Date.now()) {
      armTimer(mobile, id, campaign.scheduleAt - Date.now());
      return;
    }

    // Every message needs an active account; a deactivated / expired customer's campaign stops here.
    const problem = accessProblem(mobile);
    if (problem) {
      update(mobile, id, (c) => {
        c.status = "cancelled";
        c.cancelReason = problem;
      });
      return;
    }

    const nextIdx = campaign.contacts.findIndex((c) => c.status === "pending");
    if (nextIdx === -1) {
      markCompleted(mobile, id);
      return;
    }

    // The account's WhatsApp must be linked and open. If not, wait and re-check rather than fail.
    if (wa.status(mobile).state !== "open") {
      update(mobile, id, (c) => {
        c.status = "running";
        c.waitingReason = "Waiting for WhatsApp to be linked (Server WhatsApp).";
        c.nextSendAt = Date.now() + WAIT_FOR_WA_MS;
      });
      armTimer(mobile, id, WAIT_FOR_WA_MS);
      return;
    }

    update(mobile, id, (c) => {
      c.status = "running";
      c.waitingReason = null;
    });

    const contact = campaign.contacts[nextIdx];
    const message = withFooter(personalize(campaign.messageTemplate, contact), campaign.footer);
    // The attachment (if any) is the same for every recipient; its caption is the campaign caption
    // (or the message when no separate caption was given), personalized per recipient.
    const media = campaign.attachment ? loadMedia(mobile, id) : null;
    const caption = withFooter(personalize(campaign.caption || campaign.messageTemplate, contact), campaign.footer);
    const attachment = media ? { ...media, caption } : null;

    const target =
      contact.source === "group" ? { type: "group", name: contact.name }
      : contact.source === "contact" ? { type: "contact", name: contact.name }
      : { type: "number", phone: contact.mobile };

    let result;
    try {
      await wa.send(mobile, { target, message, attachment });
      result = { success: true };
    } catch (err) {
      // A drop mid-send (WhatsApp reconnecting) shouldn't burn the recipient: keep them pending and retry.
      if (wa.status(mobile).state !== "open") {
        update(mobile, id, (c) => {
          c.status = "running";
          c.waitingReason = "WhatsApp reconnecting — will retry shortly.";
          c.nextSendAt = Date.now() + WAIT_FOR_WA_MS;
        });
        armTimer(mobile, id, WAIT_FOR_WA_MS);
        return;
      }
      result = { success: false, reason: err.message || String(err) };
    }

    update(mobile, id, (c) => {
      const target = c.contacts[nextIdx];
      target.status = result.success ? "sent" : "failed";
      target.failReason = result.success ? undefined : result.reason;
      target.sentAt = Date.now();
      if (result.success) c.sentCount = (c.sentCount || 0) + 1;
      else c.failedCount = (c.failedCount || 0) + 1;
    });

    // A pause/cancel landing during that send stops the queue here.
    campaign = find(mobile, id);
    if (!campaign || !["scheduled", "running"].includes(campaign.status)) return;

    if (campaign.contacts.some((c) => c.status === "pending")) {
      const delaySeconds = nextDelaySeconds(campaign);
      update(mobile, id, (c) => (c.nextSendAt = Date.now() + delaySeconds * 1000));
      armTimer(mobile, id, delaySeconds * 1000);
    } else {
      markCompleted(mobile, id);
    }
  } finally {
    locks.delete(k);
  }
}

/** Seconds before the next message: fixed or random gap, or the longer pause after a full batch. */
function nextDelaySeconds(campaign) {
  const pacing = campaign.pacing || { mode: "fixed", gapSeconds: campaign.gapSeconds };
  const gap =
    pacing.mode === "random" && pacing.maxGap > pacing.minGap
      ? pacing.minGap + Math.random() * (pacing.maxGap - pacing.minGap)
      : pacing.gapSeconds || campaign.gapSeconds || 15;
  const attempted = campaign.contacts.filter((c) => c.status === "sent" || c.status === "failed").length;
  const batchDone = pacing.batchEnabled && pacing.batchSize > 0 && attempted > 0 && attempted % pacing.batchSize === 0;
  return Math.max(batchDone ? pacing.batchPauseSeconds : gap, MIN_GAP_SECONDS);
}

// ---------- Repeating campaigns ----------
function daysInMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

/** The next daily / weekly / monthly slot after `fromMs` that is still in the future (0 if not repeating). */
function nextOccurrence(fromMs, mode, anchorDay = new Date(fromMs).getDate()) {
  const date = new Date(fromMs);
  do {
    if (mode === "daily") date.setDate(date.getDate() + 1);
    else if (mode === "weekly") date.setDate(date.getDate() + 7);
    else if (mode === "monthly") {
      date.setDate(1); // step months from the 1st, or the 31st would skip a month
      date.setMonth(date.getMonth() + 1);
      date.setDate(Math.min(anchorDay, daysInMonth(date)));
    } else return 0;
  } while (date.getTime() <= Date.now());
  return date.getTime();
}

/** Marks a campaign completed and, if it repeats, queues the next run as a fresh copy (kept in history). */
function markCompleted(mobile, id) {
  update(mobile, id, (c) => {
    c.status = "completed";
    c.nextSendAt = null;
  });
  const campaign = find(mobile, id);
  const mode = campaign?.repeat?.mode;
  if (!campaign || !mode || mode === "none") return;

  const base = campaign.scheduleAt || campaign.createdAt || Date.now();
  const anchorDay = campaign.repeat.anchorDay || new Date(base).getDate();
  const nextAt = nextOccurrence(base, mode, anchorDay);
  if (!nextAt || (campaign.repeat.until && nextAt > campaign.repeat.until)) return;

  const newId = crypto.randomUUID();
  if (campaign.attachment) {
    const media = loadMedia(mobile, id);
    if (media) saveMedia(mobile, newId, media);
  }
  const next = {
    ...campaign,
    id: newId,
    seriesId: campaign.seriesId || campaign.id,
    repeat: { ...campaign.repeat, anchorDay },
    runNumber: (campaign.runNumber || 1) + 1,
    scheduleAt: nextAt,
    status: "scheduled",
    createdAt: Date.now(),
    nextSendAt: nextAt,
    sentCount: 0,
    failedCount: 0,
    contacts: campaign.contacts.map(({ status, failReason, sentAt, ...c }) => ({ ...c, status: "pending" })),
  };
  saveAll(mobile, [next, ...loadAll(mobile)]);
  armTimer(mobile, newId, nextAt - Date.now());
}

// ---------- Public API ----------

function list(mobile) {
  return loadAll(mobile).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function get(mobile, id) {
  return find(mobile, id);
}

/**
 * Creates a campaign and starts (or schedules) it.
 * input: { name, messageTemplate, footer?, gapSeconds, scheduleAt?, contacts: [{ name, mobile, custom1?, custom2?, fields? }] }
 */
function create(mobile, input = {}) {
  const contacts = (input.contacts || [])
    .map((c) => ({
      source: ["contact", "group", "number"].includes(c.source) ? c.source : "number",
      name: String(c.name || "").trim(),
      mobile: String(c.mobile || "").replace(/\D/g, ""),
      custom1: c.custom1 || "",
      custom2: c.custom2 || "",
      fields: c.fields || {},
      status: "pending",
    }))
    .filter((c) => (c.source === "number" ? c.mobile.length >= 7 : !!c.name));

  if (!contacts.length) throw Object.assign(new Error("No valid recipients in the list."), { status: 400 });

  // attachment: { dataUrl, name, mimeType }. With a file attached, the message may be empty (it becomes the caption).
  const att = input.attachment;
  const hasAttachment = !!(att && att.dataUrl);
  if (!String(input.messageTemplate || "").trim() && !input.footer?.enabled && !hasAttachment) {
    throw Object.assign(new Error("Write a message or attach a file to send."), { status: 400 });
  }

  const id = crypto.randomUUID();
  if (hasAttachment) saveMedia(mobile, id, { dataUrl: att.dataUrl, name: att.name || "file", mimeType: att.mimeType || "application/octet-stream" });

  const scheduleAt = Number(input.scheduleAt) > Date.now() ? Number(input.scheduleAt) : null;
  const repeatMode = ["daily", "weekly", "monthly"].includes(input.repeat?.mode) ? input.repeat.mode : "none";
  const repeatBase = scheduleAt || Date.now();

  // pacing: { mode: "fixed"|"random", gapSeconds, minGap, maxGap, batchEnabled, batchSize, batchPauseSeconds }
  const p = input.pacing || {};
  const pacing =
    p.mode === "random"
      ? {
          mode: "random",
          minGap: Math.max(Number(p.minGap) || 20, MIN_GAP_SECONDS),
          maxGap: Math.max(Number(p.maxGap) || 60, Number(p.minGap) || 20),
          batchEnabled: !!p.batchEnabled,
          batchSize: Math.max(Number(p.batchSize) || 25, 1),
          batchPauseSeconds: Math.max(Number(p.batchPauseSeconds) || 180, 1),
        }
      : {
          mode: "fixed",
          gapSeconds: Math.max(Number(p.gapSeconds || input.gapSeconds) || 15, MIN_GAP_SECONDS),
          batchEnabled: !!p.batchEnabled,
          batchSize: Math.max(Number(p.batchSize) || 25, 1),
          batchPauseSeconds: Math.max(Number(p.batchPauseSeconds) || 180, 1),
        };

  const campaign = {
    id,
    name: String(input.name || "Campaign").trim() || "Campaign",
    messageTemplate: String(input.messageTemplate || ""),
    caption: String(input.caption || ""),
    footer: input.footer || { enabled: false, text: "" },
    attachment: hasAttachment ? { name: att.name || "file", mimeType: att.mimeType || "application/octet-stream" } : null,
    repeat: { mode: repeatMode, anchorDay: new Date(repeatBase).getDate(), until: Number(input.repeat?.until) || null },
    pacing,
    gapSeconds: pacing.mode === "random" ? pacing.minGap : pacing.gapSeconds,
    scheduleAt,
    status: scheduleAt ? "scheduled" : "running",
    contacts,
    sentCount: 0,
    failedCount: 0,
    createdAt: Date.now(),
    nextSendAt: scheduleAt || Date.now(),
  };

  saveAll(mobile, [campaign, ...loadAll(mobile)]);
  armTimer(mobile, campaign.id, scheduleAt ? scheduleAt - Date.now() : 0);
  return campaign;
}

function pause(mobile, id) {
  clearTimer(mobile, id);
  return update(mobile, id, (c) => {
    if (["completed", "cancelled"].includes(c.status)) return;
    c.status = "paused";
    c.nextSendAt = null;
  });
}

function resume(mobile, id) {
  const campaign = update(mobile, id, (c) => {
    if (c.status !== "paused") return;
    c.status = c.scheduleAt && c.scheduleAt > Date.now() ? "scheduled" : "running";
  });
  if (campaign && ["scheduled", "running"].includes(campaign.status)) {
    armTimer(mobile, id, campaign.scheduleAt && campaign.scheduleAt > Date.now() ? campaign.scheduleAt - Date.now() : 0);
  }
  return campaign;
}

/** Drops any schedule and starts sending now. */
function startNow(mobile, id) {
  const campaign = update(mobile, id, (c) => {
    if (["completed", "cancelled"].includes(c.status)) return;
    c.scheduleAt = null;
    c.status = "running";
  });
  if (campaign && campaign.status === "running") armTimer(mobile, id, 0);
  return campaign;
}

function cancel(mobile, id) {
  clearTimer(mobile, id);
  return update(mobile, id, (c) => {
    c.status = "cancelled";
    c.nextSendAt = null;
  });
}

/** Re-arms every campaign that was mid-flight or scheduled when the server last stopped. */
function restoreAll() {
  if (!fs.existsSync(DIR)) return;
  for (const name of fs.readdirSync(DIR)) {
    const mobile = name.replace(/\.json$/, "");
    for (const c of loadAll(mobile)) {
      if (!["scheduled", "running"].includes(c.status)) continue;
      const delay = c.scheduleAt && c.scheduleAt > Date.now() ? c.scheduleAt - Date.now() : 0;
      armTimer(mobile, c.id, delay);
    }
  }
}

module.exports = { list, get, create, pause, resume, startNow, cancel, restoreAll };
