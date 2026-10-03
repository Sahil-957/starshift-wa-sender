importScripts(
  "../common/shared.js", // personalize, withFooter, isUnsubscribed
  "../common/config.js",
  "../common/auth.js" // checkLicense
);

const START_PREFIX = "campaign-start-";
const TICK_PREFIX = "campaign-tick-";
// Longer than the sum of content.js's own step timeouts, so its specific error wins over a generic timeout.
const SEND_TIMEOUT_MS = 150000;
// Reading numbers means opening one chat after another; a big address book takes a while.
const EXTRACT_TIMEOUT_MS = 45 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getCampaigns() {
  const { campaigns = [] } = await chrome.storage.local.get("campaigns");
  return campaigns;
}

async function saveCampaigns(campaigns) {
  await chrome.storage.local.set({ campaigns });
}

async function updateCampaign(id, mutator) {
  const campaigns = await getCampaigns();
  const idx = campaigns.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  mutator(campaigns[idx]);
  await saveCampaigns(campaigns);
  return campaigns[idx];
}

function notify(title, message) {
  chrome.notifications?.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title,
    message,
  });
}

// ---------- WhatsApp tab helpers ----------
/**
 * The tab sends are driven from. `visible: false` (campaigns, including scheduled ones) never
 * steals focus: an existing WhatsApp tab is used where it is, and a new one opens in its own
 * minimized window, so nothing pops up over what the user is doing.
 */
async function findOrCreateWhatsAppTab({ visible = true } = {}) {
  const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  if (tabs.length) {
    const preferred = tabs.find((t) => t.active) || tabs[0];
    if (visible) {
      await keepTabAlive(preferred.id);
      return preferred.id;
    }

    // Not focusing the tab is not enough: if it is the one the user is looking at, every chat we
    // open happens in plain sight. WhatsApp Web runs in only one tab at a time, so a second tab is
    // not an option - instead the existing one moves into a minimised window of its own.
    const offscreen = [];
    for (const tab of tabs) if (!(await isOnScreen(tab))) offscreen.push(tab);
    const target = offscreen[0] || preferred;
    if (!offscreen.length) await moveTabOutOfSight(target.id);
    await keepTabAlive(target.id);
    return target.id;
  }

  let tabId;
  if (visible) {
    tabId = (await chrome.tabs.create({ url: "https://web.whatsapp.com/", active: false })).id;
  } else {
    // `focused` must be left out: Chrome rejects it together with state "minimized".
    const win = await chrome.windows.create({ url: "https://web.whatsapp.com/", state: "minimized" });
    tabId = win.tabs[0].id;
  }
  await keepTabAlive(tabId);
  await waitForTabComplete(tabId, 30000);
  await sleep(6000); // let WhatsApp's SPA render the chat list
  return tabId;
}

/** Whether the user can actually see this tab right now. */
async function isOnScreen(tab) {
  if (!tab.active) return false;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  return !!win && win.state !== "minimized";
}

/** Pulls a tab into a minimised window of its own, so work on it happens off-screen. */
async function moveTabOutOfSight(tabId) {
  try {
    await chrome.windows.create({ tabId, state: "minimized" });
  } catch {
    // Some Chrome builds refuse "minimized" at creation time; minimise straight after instead.
    const win = await chrome.windows.create({ tabId, focused: false });
    await chrome.windows.update(win.id, { state: "minimized" });
  }
  await sleep(600); // the tab re-attaches to the new window before it can be messaged again
}

/** Chrome discards hidden tabs under memory pressure, which would kill a running campaign. */
async function keepTabAlive(tabId) {
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch {
    /* tab closed in the meantime; the caller's next call reports it */
  }
}

/**
 * Chrome stops drawing a minimized or background tab, and WhatsApp only builds the attachment
 * preview (and its Send button) once the page is drawn - plain text doesn't need it. So for a file,
 * the WhatsApp window is brought to the front for the few seconds the send takes (a window left
 * behind others counts as hidden too) and put back afterwards. Returns the function that puts it back.
 */
async function showTabForAttachment(tabId) {
  let tab = await chrome.tabs.get(tabId);
  if (await isOnScreen(tab)) return async () => {};

  // Showing the window must not show whatever else the user has open in it.
  const siblings = await chrome.tabs.query({ windowId: tab.windowId });
  if (siblings.length > 1) {
    await moveTabOutOfSight(tabId);
    tab = await chrome.tabs.get(tabId);
  }
  const before = (await chrome.windows.get(tab.windowId)).state;
  await chrome.windows.update(tab.windowId, { state: "normal", focused: true });
  await chrome.tabs.update(tabId, { active: true });
  await sleep(1500); // let the page start drawing again

  return async () => {
    try {
      await chrome.windows.update(tab.windowId, { state: before });
    } catch {
      /* window closed in the meantime */
    }
  };
}

// ---------- Server WhatsApp ----------
/**
 * When the account has linked WhatsApp on the server (dashboard -> Server WhatsApp), campaign messages go
 * out from there: nothing opens in the browser, and it works minimized or locked. A saved contact with no
 * number read yet is looked up by name on the server; only if it isn't known there does it fall back to
 * WhatsApp Web (sendViaServer returns null).
 */
async function serverWhatsAppReady() {
  try {
    return (await apiFetch("/wa/status")).state === "open";
  } catch {
    return false;
  }
}

function serverTarget(contact) {
  if (contact.source === "group") return { type: "group", name: contact.name };
  if (contact.mobile) return { type: "number", phone: contact.mobile };
  return { type: "contact", name: contact.name };
}

async function sendViaServer(contact, message, attachment, caption, footer) {
  const target = serverTarget(contact);
  try {
    await apiFetch("/wa/send", {
      method: "POST",
      body: { target, message, attachment: attachment ? { ...attachment, caption: caption && withFooter(caption, footer) } : null },
    });
  } catch (err) {
    if (target.type === "contact" && err.status === 404) return null;
    throw err;
  }
  return { success: true };
}

/** Brings the WhatsApp tab to the front, restoring its window if it was the minimized worker one. */
async function focusTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { state: "normal", focused: true });
  await chrome.tabs.update(tabId, { active: true });
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(false);
      }
    }, timeoutMs);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        settled = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label || "WhatsApp Web did not respond in time.")), timeoutMs)),
  ]);
}

/** When a send times out, asks the tab which step it was stuck on so the report shows a useful reason. */
async function describeFailure(tabId, err) {
  const reason = err.message || String(err);
  if (!tabId || !/did not respond in time/.test(reason)) return reason;
  try {
    const status = await withTimeout(chrome.tabs.sendMessage(tabId, { type: "STATUS" }), 3000);
    return `${reason} Stuck at: ${status.step}. ${status.page}`;
  } catch {
    return `${reason} The WhatsApp Web tab is not responding - refresh it and try again.`;
  }
}

/**
 * Sends a message to the content script, and if none is listening yet
 * (e.g. the WhatsApp Web tab was already open before this extension was
 * loaded/reloaded, so it never got the content script injected), injects
 * it on the fly and retries once.
 */
async function sendToContentScript(tabId, message, timeoutMs = 40000) {
  let reply;
  try {
    reply = await withTimeout(chrome.tabs.sendMessage(tabId, message), timeoutMs);
  } catch (err) {
    if (!/Receiving end does not exist|Could not establish connection/.test(err.message || "")) throw err;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["common/chatbot.js", "content/content.js"] });
    await sleep(500);
    reply = await withTimeout(chrome.tabs.sendMessage(tabId, message), timeoutMs);
  }

  // A tab opened before this version of the extension was loaded still runs the old content script.
  // It ignores messages it has never heard of and answers nothing, which used to surface as
  // "unknown error". Re-injecting cannot fix it - the old copy guards against a second one - so the
  // only cure is a reload of that tab.
  if (reply === undefined) {
    throw new Error(
      `The WhatsApp Web tab is running an older copy of the extension, so it ignored "${message.type}". ` +
        "Reload that tab (press F5 on web.whatsapp.com) and try again."
    );
  }
  return reply;
}

// ---------- Core campaign runner ----------
/** Seconds to wait before the next message: fixed or random gap, or the longer pause after a full batch. */
function nextDelaySeconds(campaign) {
  const pacing = campaign.pacing || { mode: "fixed", gapSeconds: campaign.gapSeconds };
  const gap =
    pacing.mode === "random" ? pacing.minGap + Math.random() * (pacing.maxGap - pacing.minGap) : pacing.gapSeconds;
  const attempted = campaign.contacts.filter((c) => c.status === "sent" || c.status === "failed").length;
  const batchDone = pacing.batchEnabled && attempted > 0 && attempted % pacing.batchSize === 0;
  return Math.max(batchDone ? pacing.batchPauseSeconds : gap, 1);
}

const runningLocks = new Set();

async function advanceCampaign(campaignId) {
  if (runningLocks.has(campaignId)) return;
  runningLocks.add(campaignId);
  try {
    let campaign = (await getCampaigns()).find((c) => c.id === campaignId);
    if (!campaign || ["completed", "cancelled", "paused"].includes(campaign.status)) return;

    // Skip anyone who unsubscribed after the campaign was created.
    const { unsubscribers = [] } = await chrome.storage.local.get("unsubscribers");
    if (campaign.contacts.some((c) => c.status === "pending" && isUnsubscribed(c, unsubscribers))) {
      campaign = await updateCampaign(campaignId, (c) => {
        c.contacts.forEach((target) => {
          if (target.status !== "pending" || !isUnsubscribed(target, unsubscribers)) return;
          target.status = "skipped";
          target.failReason = "Unsubscribed";
          c.skippedCount = (c.skippedCount || 0) + 1;
        });
      });
      if (!campaign) return;
    }

    // Every message needs an active account: a deactivated or logged-out customer's campaigns stop here.
    const license = await checkLicense();
    if (!license.ok) {
      await updateCampaign(campaignId, (c) => {
        c.status = "cancelled";
        c.cancelReason = license.reason;
      });
      notify("Campaign stopped", license.reason);
      return;
    }

    const nextIdx = campaign.contacts.findIndex((c) => c.status === "pending");
    if (nextIdx === -1) {
      await updateCampaign(campaignId, (c) => (c.status = "completed"));
      notify("Campaign completed", `"${campaign.name}" finished sending.`);
      await scheduleNextRun(campaignId);
      return;
    }

    const viaServer = await serverWhatsAppReady();

    // A locked screen draws nothing, so a file can't go out through WhatsApp Web (see
    // showTabForAttachment); rather than fail it, wait and try again each minute - it goes as soon as
    // the laptop is unlocked. The server WhatsApp doesn't need the screen.
    if (!viaServer && campaign.attachment && (await chrome.idle.queryState(60)) === "locked") {
      await updateCampaign(campaignId, (c) => (c.nextSendAt = Date.now() + 60000));
      chrome.alarms.create(`${TICK_PREFIX}${campaignId}`, { delayInMinutes: 1 });
      return;
    }

    await updateCampaign(campaignId, (c) => (c.status = "running"));

    const contact = campaign.contacts[nextIdx];
    const message = withFooter(personalize(campaign.messageTemplate, contact), campaign.unsubscribeFooter);
    const caption = personalize(campaign.attachment?.caption, contact);

    let result;
    let tabId;
    let hideAgain = null;
    try {
      if (viaServer) {
        result = await sendViaServer(contact, message, campaign.attachment, caption, campaign.unsubscribeFooter);
      }
      if (!result) {
        tabId = await findOrCreateWhatsAppTab({ visible: false });
        if (campaign.attachment) hideAgain = await showTabForAttachment(tabId);

        if (contact.source === "number") {
          const url = `https://web.whatsapp.com/send?phone=${contact.mobile}&text=${encodeURIComponent(" ")}`;
          await chrome.tabs.update(tabId, { url });
          await waitForTabComplete(tabId, 30000);
          await sleep(5000);
        }

        result = await sendToContentScript(tabId, {
          type: "SEND_TO_CONTACT",
          payload: {
            targetType: contact.source, // 'number' -> phone-URL already navigated; 'contact'/'group' -> open by name
            name: contact.name,
            message,
            attachment: campaign.attachment
              ? { ...campaign.attachment, caption: caption && withFooter(caption, campaign.unsubscribeFooter) }
              : null,
          },
        }, SEND_TIMEOUT_MS);
      }
    } catch (err) {
      result = { success: false, reason: await describeFailure(tabId, err) };
    } finally {
      if (hideAgain) await hideAgain();
    }

    await updateCampaign(campaignId, (c) => {
      const target = c.contacts[nextIdx];
      target.status = result?.success ? "sent" : "failed";
      target.failReason = result?.success ? undefined : result?.reason;
      target.note = result?.note;
      target.sentAt = Date.now();
      if (result?.success) c.sentCount = (c.sentCount || 0) + 1;
      else c.failedCount = (c.failedCount || 0) + 1;
    });

    campaign = (await getCampaigns()).find((c) => c.id === campaignId);
    // A pause during the message that just went out lands here: stop, and queue nothing.
    if (!campaign || campaign.status === "cancelled" || campaign.status === "paused") return;
    const stillPending = campaign.contacts.some((c) => c.status === "pending");

    if (stillPending) {
      const delaySeconds = nextDelaySeconds(campaign);
      await updateCampaign(campaignId, (c) => (c.nextSendAt = Date.now() + delaySeconds * 1000));
      chrome.alarms.create(`${TICK_PREFIX}${campaignId}`, { delayInMinutes: delaySeconds / 60 });
    } else {
      await updateCampaign(campaignId, (c) => (c.status = "completed"));
      notify("Campaign completed", `"${campaign.name}" finished sending.`);
      await scheduleNextRun(campaignId);
    }
  } finally {
    runningLocks.delete(campaignId);
  }
}

// ---------- Repeating campaigns ----------
/** The next daily / weekly / monthly slot after `fromMs` that is still in the future. */
function daysInMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

/**
 * `anchorDay` is the day of the month the series was first set for. It is carried on the campaign
 * rather than re-read from the last run, so a monthly series on the 31st goes
 * 31 Jan -> 28 Feb -> 31 Mar instead of sticking at the 28th once February has clamped it.
 */
function nextOccurrence(fromMs, mode, anchorDay = new Date(fromMs).getDate()) {
  const date = new Date(fromMs);
  do {
    if (mode === "daily") date.setDate(date.getDate() + 1);
    else if (mode === "weekly") date.setDate(date.getDate() + 7);
    else if (mode === "monthly") {
      date.setDate(1); // step months from the 1st, or the 31st would skip a month entirely
      date.setMonth(date.getMonth() + 1);
      date.setDate(Math.min(anchorDay, daysInMonth(date)));
    } else return 0;
  } while (date.getTime() <= Date.now());
  return date.getTime();
}

/**
 * Queues the next run of a repeating campaign as a fresh copy, so the one that just finished stays
 * in Reports as its own record. Cancelling the queued copy ends the series.
 */
async function scheduleNextRun(campaignId) {
  const campaign = (await getCampaigns()).find((c) => c.id === campaignId);
  const mode = campaign?.repeat?.mode;
  if (!campaign || !mode || mode === "none") return;

  const base = campaign.scheduleAt || campaign.createdAt || Date.now();
  const anchorDay = campaign.repeat.anchorDay || new Date(base).getDate();
  const nextAt = nextOccurrence(base, mode, anchorDay);
  if (!nextAt) return;
  if (campaign.repeat.until && nextAt > campaign.repeat.until) {
    notify("Repeat finished", `"${campaign.name}" has reached the end of its repeat period.`);
    return;
  }

  const next = {
    ...campaign,
    id: crypto.randomUUID(),
    seriesId: campaign.seriesId || campaign.id,
    repeat: { ...campaign.repeat, anchorDay },
    runNumber: (campaign.runNumber || 1) + 1,
    scheduleAt: nextAt,
    status: "scheduled",
    createdAt: Date.now(),
    nextSendAt: null,
    cancelReason: undefined,
    sentCount: 0,
    failedCount: 0,
    skippedCount: 0,
    contacts: campaign.contacts.map(({ status, failReason, note, sentAt, ...contact }) => ({
      ...contact,
      status: "pending",
    })),
  };

  await saveCampaigns([next, ...(await getCampaigns())]);
  chrome.alarms.create(`${START_PREFIX}${next.id}`, { when: nextAt });
  notify("Next run scheduled", `"${next.name}" runs again on ${new Date(nextAt).toLocaleString()}.`);
}

async function scheduleOrRunCampaign(campaignId) {
  const campaign = (await getCampaigns()).find((c) => c.id === campaignId);
  if (!campaign) return;
  if (campaign.scheduleAt && campaign.scheduleAt > Date.now()) {
    chrome.alarms.create(`${START_PREFIX}${campaignId}`, { when: campaign.scheduleAt });
  } else {
    advanceCampaign(campaignId);
  }
}

/** Stops the queue where it is. Nothing is lost - the contacts still pending stay pending. */
async function pauseCampaign(campaignId) {
  chrome.alarms.clear(`${START_PREFIX}${campaignId}`);
  chrome.alarms.clear(`${TICK_PREFIX}${campaignId}`);
  await updateCampaign(campaignId, (c) => {
    if (c.status === "completed" || c.status === "cancelled") return;
    c.status = "paused";
    c.nextSendAt = null;
  });
}

async function resumeCampaign(campaignId) {
  const campaign = await updateCampaign(campaignId, (c) => {
    if (c.status !== "paused") return;
    c.status = c.scheduleAt && c.scheduleAt > Date.now() ? "scheduled" : "running";
  });
  if (!campaign) return;
  scheduleOrRunCampaign(campaignId);
}

/** Jumps the queue: drops the scheduled time and starts sending now. */
async function startCampaignNow(campaignId) {
  const campaign = await updateCampaign(campaignId, (c) => {
    if (c.status === "completed" || c.status === "cancelled") return;
    c.scheduleAt = null;
    c.status = "running";
  });
  if (!campaign || campaign.status !== "running") return;
  chrome.alarms.clear(`${START_PREFIX}${campaignId}`);
  chrome.alarms.clear(`${TICK_PREFIX}${campaignId}`);
  advanceCampaign(campaignId);
}

async function cancelCampaign(campaignId) {
  chrome.alarms.clear(`${START_PREFIX}${campaignId}`);
  chrome.alarms.clear(`${TICK_PREFIX}${campaignId}`);
  await updateCampaign(campaignId, (c) => (c.status = "cancelled"));
}

// ---------- Activation ----------
/** Trades an activation code for a login and stores it, so the customer types nothing. */
async function activateWithToken(token) {
  try {
    const data = await apiFetch("/auth/activate", { method: "POST", body: { token: String(token || "").trim() } });
    await chrome.storage.local.set({
      authToken: data.token,
      authMobile: data.mobile,
      authRole: data.role,
      authExpiresAt: data.expiresAt || null,
      licenseCheckedAt: Date.now(),
    });
    notify("Starshift WA Sender activated", `Logged in as +${data.mobile}. Open it from the Chrome toolbar to start.`);
    return { success: true, mobile: data.mobile };
  } catch (err) {
    return { success: false, reason: err.message || String(err) };
  }
}

// The activation page the customer's link opens talks to the extension through this. Only the
// origins listed under externally_connectable in the manifest can reach it.
chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "PING") {
    sendResponse({ ok: true, app: "Starshift WA Sender" });
    return false;
  }
  if (msg?.type === "ACTIVATE") {
    activateWithToken(msg.token).then(sendResponse);
    return true; // async sendResponse
  }
  return false;
});

// Jobs that drive the WhatsApp tab, and how long each is allowed to take.
const TAB_TASKS = {
  SYNC_CHATS: SEND_TIMEOUT_MS,
  RESOLVE_NUMBERS: EXTRACT_TIMEOUT_MS,
  GROUP_MEMBERS: EXTRACT_TIMEOUT_MS,
  CHAT_MESSAGES: EXTRACT_TIMEOUT_MS,
};

// ---------- Event wiring ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "CAMPAIGN_CREATED") {
    scheduleOrRunCampaign(msg.campaignId);
    return false;
  }
  if (msg.type === "ACTIVATE") {
    activateWithToken(msg.token).then(sendResponse);
    return true; // async sendResponse
  }
  if (msg.type === "CAMPAIGN_CANCEL") {
    cancelCampaign(msg.campaignId).then(() => sendResponse({ success: true }));
    return true; // async sendResponse
  }
  if (msg.type === "CAMPAIGN_PAUSE") {
    pauseCampaign(msg.campaignId).then(() => sendResponse({ success: true }));
    return true; // async sendResponse
  }
  if (msg.type === "CAMPAIGN_RESUME") {
    resumeCampaign(msg.campaignId).then(() => sendResponse({ success: true }));
    return true; // async sendResponse
  }
  if (msg.type === "CAMPAIGN_START_NOW") {
    startCampaignNow(msg.campaignId).then(() => sendResponse({ success: true }));
    return true; // async sendResponse
  }
  if (msg.type === "SLEEP") {
    // A hidden tab's own timers are throttled to about one wake-up a minute, which stalls every
    // step of a send. The service worker's timers are not throttled, so the tab borrows them.
    setTimeout(() => sendResponse({ ok: true }), Math.min(Math.max(msg.ms, 0), 60000));
    return true; // async sendResponse
  }
  if (msg.type === "CANCEL_EXTRACT") {
    // Goes out to every WhatsApp tab: whichever one is mid-extraction stops after its current chat.
    (async () => {
      const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
      await Promise.all(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, msg).catch(() => {})));
      sendResponse({ success: true });
    })();
    return true; // async sendResponse
  }
  if (msg.type === "OPEN_CHAT") {
    // Opening a chat is something the user asked to look at, so this one does come to the front.
    (async () => {
      try {
        const tabId = await findOrCreateWhatsAppTab({ visible: true });
        await focusTab(tabId);
        if (msg.number) {
          // A number opens its chat straight from the URL, saved contact or not.
          await chrome.tabs.update(tabId, { url: `https://web.whatsapp.com/send?phone=${msg.number}` });
          await waitForTabComplete(tabId, 30000);
          sendResponse({ success: true });
          return;
        }
        sendResponse(await sendToContentScript(tabId, { type: "OPEN_CHAT", name: msg.name }, 60000));
      } catch (err) {
        sendResponse({ success: false, reason: err.message || String(err) });
      }
    })();
    return true; // async sendResponse
  }
  if (TAB_TASKS[msg.type]) {
    (async () => {
      try {
        // Out of sight by default - the tab is never brought forward. `visible: true` is the escape
        // hatch for a WhatsApp build that only fills its lists while the tab is actually on screen.
        const tabId = await findOrCreateWhatsAppTab({ visible: false });
        if (msg.visible === true) await focusTab(tabId);
        sendResponse(await sendToContentScript(tabId, msg, TAB_TASKS[msg.type]));
      } catch (err) {
        sendResponse({ success: false, reason: err.message || String(err) });
      }
    })();
    return true; // async sendResponse
  }
  return false;
});

// ---------- Chatbot on the server ----------
// With the server WhatsApp linked, the chatbot runs there and answers the moment a message arrives,
// with nothing typed into WhatsApp Web. The server gets the chatbot settings, rules and Unsubscribers
// from here and hands back whoever it unsubscribed (STOP) or re-subscribed (START). `serverBot.running`
// tells the WhatsApp Web tab to stand down; when the server cannot be reached it turns false and the
// tab answers again.
// Requests are kept few - a free ngrok tunnel allows 20,000 a month for everyone together: an account
// with the chatbot off only syncs when its chatbot settings or login change, and one with it on also
// every BOT_SYNC_MINUTES.
const BOT_SYNC_ALARM = "bot-sync";
const BOT_SYNC_MINUTES = 10;
const BOT_SYNC_KEYS = ["botSettings", "botRules", "unsubscribeKeywords", "unsubscribers", "authToken"];
// A change to these always reaches the server, so switching the chatbot off is never missed.
const BOT_SYNC_ALWAYS_KEYS = ["botSettings", "authToken"];
let botSyncQueue = Promise.resolve();
let botSyncTimer = null;
let botSyncForce = false;

/** Same shape the server records: { op: "add" | "remove", entries }. */
function applyUnsubscriberChange(list, { op, entries }) {
  if (op === "remove") return list.filter((entry) => !entries.includes(entry));
  const known = new Set(list.map((entry) => entry.toLowerCase()));
  return [...list, ...entries.filter((entry) => !known.has(entry.toLowerCase()))];
}

async function syncServerBot({ force = false } = {}) {
  const data = await chrome.storage.local.get([...BOT_SYNC_KEYS, "botSyncSeq"]);
  if (!data.authToken) {
    await chrome.storage.local.set({ serverBot: { running: false, checkedAt: Date.now() } });
    return;
  }
  if (!force && !data.botSettings?.enabled) return; // chatbot off: nothing for the server to do
  try {
    const result = await apiFetch("/wa/bot/sync", {
      method: "POST",
      body: {
        config: {
          settings: data.botSettings || {},
          rules: data.botRules || [],
          footerKeywords: data.unsubscribeKeywords || [],
        },
        unsubscribers: data.unsubscribers || [],
        since: data.botSyncSeq || 0,
      },
    });
    const update = { botSyncSeq: result.seq || 0, serverBot: { running: !!result.running, checkedAt: Date.now() } };
    if (result.changes?.length) {
      // Re-read: the list may have changed while the request was out.
      const { unsubscribers = [] } = await chrome.storage.local.get("unsubscribers");
      update.unsubscribers = result.changes.reduce(applyUnsubscriberChange, unsubscribers);
    }
    await chrome.storage.local.set(update);
  } catch (err) {
    await chrome.storage.local.set({ serverBot: { running: false, checkedAt: Date.now(), error: err.message } });
  }
}

/** Syncs are run one after another; a burst of settings changes becomes one sync. */
function queueBotSync(delayMs = 0, force = false) {
  botSyncForce ||= force;
  clearTimeout(botSyncTimer);
  botSyncTimer = setTimeout(() => {
    const options = { force: botSyncForce };
    botSyncForce = false;
    botSyncQueue = botSyncQueue.then(() => syncServerBot(options));
  }, delayMs);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !BOT_SYNC_KEYS.some((key) => key in changes)) return;
  queueBotSync(1500, BOT_SYNC_ALWAYS_KEYS.some((key) => key in changes));
});

// Picks up STOP / START from the server and tells the tab whether the server still answers.
chrome.alarms.get(BOT_SYNC_ALARM, (alarm) => {
  if (alarm?.periodInMinutes !== BOT_SYNC_MINUTES) {
    chrome.alarms.create(BOT_SYNC_ALARM, { periodInMinutes: BOT_SYNC_MINUTES });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(START_PREFIX)) {
    advanceCampaign(alarm.name.slice(START_PREFIX.length));
  } else if (alarm.name.startsWith(TICK_PREFIX)) {
    advanceCampaign(alarm.name.slice(TICK_PREFIX.length));
  } else if (alarm.name === BOT_SYNC_ALARM) {
    queueBotSync();
  }
});

// Resume in-flight / due campaigns after browser or service-worker restart.
async function resumeAll() {
  const campaigns = await getCampaigns();
  for (const c of campaigns) {
    // A paused campaign stays paused across a browser restart until it is resumed by hand.
    if (["completed", "cancelled", "paused"].includes(c.status)) continue;
    if (c.scheduleAt && c.scheduleAt > Date.now()) {
      chrome.alarms.create(`${START_PREFIX}${c.id}`, { when: c.scheduleAt });
    } else {
      advanceCampaign(c.id);
    }
  }
}

chrome.runtime.onStartup.addListener(resumeAll);
chrome.runtime.onInstalled.addListener(resumeAll);
chrome.runtime.onStartup.addListener(() => queueBotSync(0, true));
chrome.runtime.onInstalled.addListener(() => queueBotSync(0, true));
