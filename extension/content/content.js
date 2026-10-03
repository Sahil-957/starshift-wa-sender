/**
 * WhatsApp Web automation content script.
 *
 * WhatsApp Web's DOM/selectors change periodically since it has no public
 * automation API. Each lookup below tries a small list of fallback
 * selectors. If sending starts failing, open DevTools on web.whatsapp.com,
 * inspect the relevant element (search box, message box, attach button,
 * send button) and update the arrays in SELECTORS.
 *
 * Guarded against double-injection: background.js falls back to
 * chrome.scripting.executeScript when a tab was already open before this
 * extension loaded (so the manifest-declared content script never ran in
 * it). Without this guard, that fallback running alongside a
 * manifest-registered copy would redeclare top-level consts and register
 * duplicate message listeners.
 */
if (!window.__waBulkSenderInjected) {
window.__waBulkSenderInjected = true;

const SELECTORS = {
  chatList: ["#pane-side", "#side"],
  qrCanvas: ['canvas[aria-label*="Scan"]', "[data-testid=\"qrcode\"]"],
  messageBox: [
    '#main footer div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][data-tab="10"]',
    '#main footer div[contenteditable="true"]',
    'footer div[contenteditable="true"][role="textbox"]',
  ],
  // Matches both the chat footer's Send button and the attachment preview's; see sendButtons().
  sendButton: [
    'button[aria-label="Send"]',
    'div[role="button"][aria-label="Send"]',
    'span[data-icon="send"]',
    'span[data-icon="wds-ic-send-filled"]',
    '[data-icon="send-light"]',
  ],
  // Newer WhatsApp Web builds use a plain <input> for search instead of a contenteditable div.
  searchBox: [
    '#side input[data-tab="3"]',
    'input[data-tab="3"]',
    'div[contenteditable="true"][data-tab="3"]',
    '#side input[type="text"]',
    'input[aria-label*="Search"]',
    'div[aria-label="Search input textbox"]',
    '#side div[contenteditable="true"]',
  ],
  searchButton: ['button[aria-label*="Search"]', 'span[data-icon="search"]', '[data-icon="search-refreshed"]'],
  chatListItem: [
    '#pane-side div[role="listitem"]',
    '#side div[role="listitem"]',
    '#pane-side div[role="row"]',
    '#pane-side [data-testid="cell-frame-container"]',
  ],
  attachButton: [
    '#main footer button[aria-label="Attach"]',
    '#main footer [title="Attach"]',
    '#main footer span[data-icon="plus-rounded"]',
    '#main footer span[data-icon="plus"]',
    '#main footer span[data-icon="clip"]',
    'button[aria-label="Attach"]',
    'div[title="Attach"]',
  ],
  invalidNumberToast: ['div[data-animate-modal-popup="true"]', ".app-modal-content"],
  chatTitle: ['span[title]', 'span[dir="auto"]'],
  groupIcon: ['span[data-icon="default-group"]'],
  lastMessagePreview: ['span[dir="ltr"]'],
  unreadBadge: ['span[aria-label*="unread message"]', '[data-testid="icon-unread-count"]'],
  chatHeader: ["#main header"],
  // The round arrow WhatsApp shows whenever a chat is not scrolled to its latest message.
  scrollToBottom: [
    '#main button[aria-label="Scroll to bottom"]',
    '#main [role="button"][aria-label="Scroll to bottom"]',
    '#main span[data-icon="down"]',
    '#main span[data-icon="ic-chevron-down"]',
  ],
  // The right-hand panel that contact info and group info open in.
  infoDrawer: [
    'div[data-testid="chat-info-drawer"]',
    'section[data-testid="group-info-drawer"]',
    '#app div[role="complementary"]',
    "#app .app-wrapper-secondary",
  ],
  drawerListItem: ['div[role="listitem"]', '[data-testid="cell-frame-container"]'],
  closeDrawer: ['button[aria-label="Close"]', 'span[data-icon="x"]', '[data-icon="x-viewer"]'],
};

/**
 * Chrome throttles a hidden tab's timers to roughly one wake-up a minute, which would stretch a
 * send into hours. While hidden, the wait is timed by the service worker instead - its timers are
 * never throttled - and the page's own timer stays as the fallback if the worker is not there.
 */
function sleep(ms) {
  const local = new Promise((resolve) => setTimeout(resolve, ms));
  if (!document.hidden || ms < 50) return local;
  const started = Date.now();
  const viaWorker = new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "SLEEP", ms }, () => {
      // On an error - or any reply too early to be the timer - leave the wait to the local one.
      if (chrome.runtime.lastError || Date.now() - started < ms - 50) return;
      resolve();
    });
  });
  return Promise.race([viaWorker, local]);
}

// Campaign sends and the chatbot both drive this tab's UI; never let them overlap.
let sendBusy = false;
let botBusy = false;
let currentStep = "idle"; // what the current send is doing; reported back if the background times out

/**
 * A hidden tab defers layout, and WhatsApp's lists only fill in rows once they have laid out.
 * Reading a layout property forces that flush, and re-firing scroll wakes the virtualised list.
 */
function nudgeRendering(scroller) {
  if (!scroller) return;
  void scroller.scrollHeight;
  void scroller.getBoundingClientRect().height;
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
}

async function waitUntil(check, timeout) {
  const start = Date.now();
  while (!check() && Date.now() - start < timeout) await sleep(200);
}

/** One-line snapshot of the key WhatsApp Web elements, for failure reasons. */
function pageStatus() {
  const found = (selectors) => (queryFirst(selectors) ? "yes" : "no");
  const openChat = document.querySelector("#main header span[title]")?.getAttribute("title");
  return [
    `tab visible: ${document.hidden ? "no" : "yes"}`,
    `chat list: ${found(SELECTORS.chatList)}`,
    `search box: ${found(SELECTORS.searchBox)}`,
    `open chat: ${openChat || "none"}`,
    `message box: ${found(SELECTORS.messageBox)}`,
  ].join(", ");
}

/** Letters and digits only, so "DUMBO 🐫" and "DUMBO" (emoji rendered as <img>) compare equal. */
function plainText(value) {
  return String(value || "").replace(/[^\p{L}\p{N}\p{M}]+/gu, "").toLowerCase();
}

function queryFirst(selectors, root = document) {
  for (const sel of selectors) {
    const found = root.querySelector(sel);
    if (found) return found;
  }
  return null;
}

async function waitForNode(find, { timeout = 20000, interval = 300, label = "an element", probe } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const node = find();
    if (node) return node;
    await sleep(interval);
  }
  // The probe lists what is actually on the page, so the report's Reason column is enough to fix a selector.
  throw new Error(`Could not find ${label} on WhatsApp Web.${probe ? ` Page has: ${probe()}` : ""}`);
}

async function waitFor(selectors, { root = document, ...options } = {}) {
  return waitForNode(() => queryFirst(selectors, root), { label: selectors[0], ...options });
}

/** Compact list of matching elements and their key attributes, for failure reasons. */
function describeNodes(selector, attrs) {
  const nodes = Array.from(document.querySelectorAll(selector)).slice(0, 6);
  if (!nodes.length) return "none";
  return nodes
    .map((node) => {
      const details = attrs
        .filter((attr) => node.hasAttribute(attr))
        .map((attr) => `${attr}="${node.getAttribute(attr).slice(0, 40)}"`);
      return `<${[node.tagName.toLowerCase(), ...details].join(" ")}>`;
    })
    .join(" ");
}

/** Chat rows may listen for pointer, mouse or click events, so fire the whole sequence. */
function realClick(node) {
  const init = { bubbles: true, cancelable: true, view: window };
  node.dispatchEvent(new PointerEvent("pointerdown", init));
  node.dispatchEvent(new MouseEvent("mousedown", init));
  node.dispatchEvent(new PointerEvent("pointerup", init));
  node.dispatchEvent(new MouseEvent("mouseup", init));
  node.dispatchEvent(new MouseEvent("click", init));
}

function pressEnter(node) {
  node.focus();
  for (const type of ["keydown", "keyup"]) {
    node.dispatchEvent(
      new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true })
    );
  }
}

async function waitForWhatsAppReady() {
  const start = Date.now();
  while (Date.now() - start < 30000) {
    if (queryFirst(SELECTORS.qrCanvas)) {
      throw new Error("WhatsApp Web is not logged in - please scan the QR code once in this Chrome profile.");
    }
    if (queryFirst(SELECTORS.chatList)) return true;
    await sleep(400);
  }
  throw new Error("WhatsApp Web did not finish loading.");
}

function setContentEditableText(editable, text) {
  editable.focus();
  // execCommand is deprecated but remains the only reliable way to make
  // WhatsApp Web's React-controlled contenteditable boxes register text.
  document.execCommand("selectAll", false, undefined);
  document.execCommand("insertText", false, text);
  // A plain <input> (newer search box) may ignore insertText; set the value the way React expects.
  if (editable instanceof HTMLInputElement && editable.value !== text) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(editable, text);
    editable.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/** Current text of a rich-text editor, textarea or input. */
function editorText(editable) {
  return editable instanceof HTMLTextAreaElement || editable instanceof HTMLInputElement
    ? editable.value
    : editable.textContent;
}

function editorHasText(editable, text) {
  const start = plainText(text).slice(0, 20);
  return !start || plainText(editorText(editable)).includes(start);
}

/**
 * Types into WhatsApp's rich-text editors (message box, attachment caption). A synthetic paste keeps
 * line breaks, emoji and *formatting* intact; insertText is the fallback. Throws if nothing landed,
 * so a message or attachment is never sent without its text.
 */
async function typeIntoEditor(editable, text, label) {
  editable.focus();
  if (editorText(editable)) {
    document.execCommand("selectAll", false, undefined);
    document.execCommand("delete", false, undefined);
  }
  const data = new DataTransfer();
  data.setData("text/plain", text);
  editable.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  await sleep(400);

  if (!editorHasText(editable, text)) {
    document.execCommand("insertText", false, text);
    await sleep(400);
  }
  if (!editorHasText(editable, text)) throw new Error(`Could not type the ${label} into WhatsApp Web.`);
}

async function setMessageText(text) {
  if (!text) return;
  const box = await waitFor(SELECTORS.messageBox, { label: "the message box" });
  await typeIntoEditor(box, text, "message");
  await sleep(300);
}

function sendButtons() {
  const nodes = SELECTORS.sendButton.flatMap((sel) => Array.from(document.querySelectorAll(sel)));
  return [...new Set(nodes.map((node) => node.closest('button, [role="button"]') || node))];
}

function isInComposer(node) {
  return !!node.closest("#main footer");
}

function sendProbe() {
  return describeNodes('#main footer [data-icon], [aria-label="Send"]', ["data-icon", "aria-label"]);
}

/** Sends the text typed in the chat footer, then checks the box actually emptied. */
async function clickSend() {
  const btn = await waitForNode(() => sendButtons().find(isInComposer), { timeout: 5000 }).catch(() => null);
  if (btn) btn.click();
  else pressEnter(await waitFor(SELECTORS.messageBox, { label: "the message box" }));
  await sleep(1200);

  if (queryFirst(SELECTORS.messageBox)?.textContent.trim()) {
    throw new Error(`Message was typed but not sent. Page has: ${sendProbe()}`);
  }
}

async function waitForChatOpen() {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    // textContent, not innerText: innerText lays out the whole page on every poll, and a page
    // Chrome is not drawing can hand it back empty or not at all.
    const invalid = (document.body.textContent || "").includes("Phone number shared via url is invalid");
    if (invalid) throw new Error("This mobile number is not on WhatsApp / invalid number.");
    if (queryFirst(SELECTORS.messageBox)) return true;
    await sleep(300);
  }
  throw new Error("Chat did not open in time (invalid number or slow network).");
}

function headerShowsName(name) {
  const header = document.querySelector("#main header");
  if (!header) return false;
  const wanted = plainText(name);
  return Array.from(header.querySelectorAll("span")).some((span) => {
    const text = span.getAttribute("title") || span.textContent;
    return wanted ? plainText(text) === wanted : text.trim() === name.trim();
  });
}

/** Waits until the conversation header shows this chat's name, so a message never lands in another chat. */
async function waitForChatHeader(name) {
  await waitForNode(() => (headerShowsName(name) ? true : null), {
    timeout: 10000,
    label: `the open chat "${name}"`,
    probe: () => `open chat header "${(document.querySelector("#main header")?.textContent || "none").slice(0, 80)}"`,
  });
}

/**
 * Finds the title element of this chat in the chat list / search results. The title (not the row) is
 * what gets clicked: events bubble up to the row's click handler, never down into it.
 * Exact title match first; otherwise a letters-and-digits match, but only if it points at a single chat,
 * so a similarly named chat never gets the message.
 */
function findChatByName(name) {
  const candidates = [
    ...Array.from(document.querySelectorAll(SELECTORS.chatListItem.join(","))).map((row) => ({
      node: queryFirst(SELECTORS.chatTitle, row) || row,
      title: rowTitle(row),
    })),
    ...Array.from(document.querySelectorAll("span[title]"))
      .filter((span) => !span.closest("#main"))
      .map((node) => ({ node, title: node.getAttribute("title") })),
  ];
  const exact = candidates.find((c) => c.title.trim().toLowerCase() === name.trim().toLowerCase());
  if (exact) return exact.node;

  const wanted = plainText(name);
  const loose = candidates.filter((c) => wanted && plainText(c.title) === wanted);
  return new Set(loose.map((c) => c.title.trim())).size === 1 ? loose[0].node : null;
}

/** Opens a chat (individual or group) by its display name via the search box. */
async function openChatByName(name) {
  currentStep = "looking for the chat search box";
  let box = queryFirst(SELECTORS.searchBox);
  if (!box) {
    queryFirst(SELECTORS.searchButton)?.click();
    await sleep(500);
    box = await waitFor(SELECTORS.searchBox, {
      timeout: 15000,
      label: "the chat search box",
      probe: () => describeNodes('input, [contenteditable="true"]', ["aria-label", "data-tab", "type", "role"]),
    });
  }

  // Emoji often don't match in WhatsApp's search, so search by the words only.
  const searchText = name.replace(/[^\p{L}\p{N}\p{M}\s.'&-]+/gu, " ").replace(/\s+/g, " ").trim() || name;
  currentStep = `searching for "${searchText}"`;
  setContentEditableText(box, searchText);
  await sleep(1500);

  currentStep = `looking for "${name}" in search results`;
  const chat = await waitForNode(() => findChatByName(name), {
    timeout: 10000,
    label: `a chat named "${name}" in search results`,
    probe: () => describeNodes("#side span[title], #pane-side span[title]", ["title"]),
  });

  currentStep = `waiting for "${name}" to open`;
  realClick(chat);
  await sleep(1000);
  await waitForChatHeader(name);
  await waitForChatOpen();
  await clearSearch();
}

function rowTitle(row) {
  const titleEl = queryFirst(SELECTORS.chatTitle, row);
  return (titleEl?.getAttribute("title") || titleEl?.textContent || "").trim();
}

/** Text of a message or preview. WhatsApp draws emoji as <img alt="😀">, so their alt text is kept. */
function bubbleText(node) {
  if (!node) return "";
  let text = "";
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current.nodeType === Node.TEXT_NODE) text += current.nodeValue;
    else if (current.tagName === "IMG") text += current.getAttribute("alt") || "";
    else if (current.tagName === "BR") text += "\n";
  }
  return text.trim();
}

/** Last-message preview shown under the chat name in the chat list. */
function rowPreview(row) {
  const preview = bubbleText(queryFirst(SELECTORS.lastMessagePreview, row));
  if (preview) return preview;
  const name = rowTitle(row);
  const titled = Array.from(row.querySelectorAll("span[title]"))
    .map((span) => span.getAttribute("title").trim())
    .filter((title) => title && title !== name);
  return titled.pop() || "";
}

/**
 * Guesses group vs individual since WhatsApp Web exposes no explicit
 * "is group" flag. Heuristics: default group avatar icon, or a
 * "Sender: message" preview prefix (only groups show a third-party sender
 * name in the preview).
 */
function isGroupRow(row) {
  // A group's WhatsApp id ends in @g.us, an individual's in @c.us. When the row carries either, it
  // settles the question outright; the icon and preview heuristics below are only the fallback.
  for (const element of [row, ...row.querySelectorAll("*")].slice(0, 80)) {
    for (const attr of element.attributes) {
      if (attr.value.includes("@g.us")) return true;
      if (attr.value.includes("@c.us")) return false;
    }
  }
  if (queryFirst(SELECTORS.groupIcon, row)) return true;
  const prefixMatch = rowPreview(row).match(/^([^:]{1,24}):\s/);
  return !!prefixMatch && prefixMatch[1].trim() !== "You";
}

/** Empties the chat search box, so the chat list shows every chat again instead of the last search. */
async function clearSearch() {
  const box = queryFirst(SELECTORS.searchBox);
  const text = box instanceof HTMLInputElement ? box.value : box?.textContent;
  if (!text) return;
  box.focus();
  document.execCommand("selectAll", false, undefined);
  document.execCommand("delete", false, undefined);
  if (box instanceof HTMLInputElement && box.value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(box, "");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }
  await sleep(800);
}

/** The element that actually scrolls the chat list (#pane-side itself, or a child in some builds). */
function chatListScroller() {
  const pane = document.querySelector("#pane-side");
  if (!pane || pane.scrollHeight > pane.clientHeight + 10) return pane;
  return Array.from(pane.querySelectorAll("div")).find((div) => div.scrollHeight > div.clientHeight + 10) || pane;
}

// ---------- Phone-number extraction (Excel export) ----------
// WhatsApp ids look like 919876543210@c.us; they turn up in data-id and similar attributes.
const WA_JID_RE = /(\d{7,15})@(?:c\.us|s\.whatsapp\.net|lid)/;

/** Digs a phone number out of any WhatsApp id hiding in this node's - or a child's - attributes. */
function jidNumberFrom(node, maxNodes = 400) {
  if (!node) return null;
  const nodes = [node, ...node.querySelectorAll("*")].slice(0, maxNodes);
  for (const element of nodes) {
    for (const attr of element.attributes) {
      const match = attr.value.match(WA_JID_RE);
      if (match) return match[1];
    }
  }
  return null;
}

/** A title that is itself a number - how WhatsApp shows anyone who is not in your address book. */
function numberFromTitle(title) {
  const digits = String(title || "").replace(/[^\d+]/g, "");
  return /^\+?\d{7,15}$/.test(digits) ? digits.replace(/^\+/, "") : null;
}

/** The number of whoever's chat is currently open, from a message bubble's id or the header. */
function numberFromOpenChat() {
  for (const node of document.querySelectorAll("#main [data-id]")) {
    const match = (node.getAttribute("data-id") || "").match(WA_JID_RE);
    if (match) return match[1];
  }
  return jidNumberFrom(document.querySelector("#main header"));
}

function findInfoDrawer() {
  return queryFirst(SELECTORS.infoDrawer);
}

/** Opens the right-hand info panel for the chat that is already open. */
async function openInfoDrawer() {
  const existing = findInfoDrawer();
  if (existing) return existing;
  const header = await waitFor(SELECTORS.chatHeader, { label: "the chat header", timeout: 8000 });
  realClick(header);
  return waitForNode(findInfoDrawer, { timeout: 8000, label: "the chat info panel" });
}

async function closeInfoDrawer() {
  const drawer = findInfoDrawer();
  const close = drawer && queryFirst(SELECTORS.closeDrawer, drawer);
  if (!close) return;
  realClick(close.closest('button, [role="button"]') || close);
  await sleep(400);
}

/**
 * Last resort for a saved contact whose chat has no messages: the info panel prints the number as
 * plain text. Only that panel is searched, so a number quoted inside a message is never mistaken
 * for the contact's own.
 */
async function numberFromInfoDrawer() {
  const drawer = await openInfoDrawer().catch(() => null);
  if (!drawer) return null;
  await sleep(600);
  const fromAttrs = jidNumberFrom(drawer);
  if (fromAttrs) return fromAttrs;
  const match = (drawer.innerText || "").match(/\+\d[\d\s\-()]{7,20}/);
  return match ? match[0].replace(/\D/g, "") : null;
}

// Set by a CANCEL_EXTRACT message; the long loops below check it between chats so a run can be
// stopped without leaving the page half-way through opening one.
let extractCancelled = false;

// Which chat of how many is being read; set by extractChatMessages so the scroll can report from
// inside without having to be handed the counters.
let readingChat = { index: 0, total: 0 };

// A long chat can outlive the connection carrying the final answer, so rows are handed over as
// they are found. The dashboard keeps them, and can write the spreadsheet from them even if the
// run never reports back. Images are left out - they are far too big to send over and over.
let streamedCount = 0;

function streamRows(rows) {
  if (rows.length <= streamedCount) return;
  const batch = rows.slice(streamedCount).map(({ image, ...row }) => row);
  streamedCount = rows.length;
  chrome.runtime.sendMessage({ type: "EXTRACT_ROWS", rows: batch }, () => void chrome.runtime.lastError);
}

/** Keeps the dashboard's status line moving while one long chat is being scrolled back. */
function reportReadingProgress(name, found, checkingTop = false) {
  const tail = checkingTop ? " - checking for anything older, almost done" : " so far";
  reportProgress(readingChat.index, readingChat.total, `${name} - ${found} message(s)${tail}`);
}

/** Tells the dashboard how far a long extraction has got. */
function reportProgress(done, total, label) {
  chrome.runtime.sendMessage({ type: "EXTRACT_PROGRESS", done, total, label }, () => void chrome.runtime.lastError);
}

/**
 * Fills in the numbers the chat list did not give away, by opening those chats one at a time.
 * Slow by nature - each one is a search, a click and a wait - so the caller passes only the names
 * it still needs.
 */
async function resolveChatNumbers(names) {
  extractCancelled = false;
  const resolved = [];
  for (let i = 0; i < names.length; i++) {
    if (extractCancelled) break;
    const name = names[i];
    reportProgress(i, names.length, name);
    try {
      await openChatByName(name);
      await sleep(500);
      resolved.push({ name, number: numberFromOpenChat() || (await numberFromInfoDrawer()), note: "" });
      await closeInfoDrawer();
    } catch (err) {
      resolved.push({ name, number: null, note: err.message || String(err) });
    }
  }
  reportProgress(names.length, names.length, "");
  return resolved;
}

/** The scrollable element inside the info drawer, where a long member list lives. */
function drawerScroller(drawer) {
  if (drawer.scrollHeight > drawer.clientHeight + 10) return drawer;
  return Array.from(drawer.querySelectorAll("div")).find((div) => div.scrollHeight > div.clientHeight + 10) || drawer;
}

/**
 * Everyone in a group, from the group info panel's member list. A member saved in your address
 * book shows as a name; WhatsApp prints the number only for the others, so `number` can be blank
 * even though the row was found.
 */
async function extractGroupMembers(groupName) {
  await waitForWhatsAppReady();
  currentStep = `opening group "${groupName}"`;
  await openChatByName(groupName);

  currentStep = "opening group info";
  const drawer = await openInfoDrawer();
  await sleep(1000);

  // Groups past a handful of members collapse the list behind a "View all" button.
  const viewAll = Array.from(drawer.querySelectorAll('div[role="button"], button')).find((node) =>
    /view all|see all|\d+\s+(members|participants)/i.test((node.textContent || "").trim())
  );
  if (viewAll) {
    realClick(viewAll);
    await sleep(1200);
  }

  extractCancelled = false;
  currentStep = "reading the member list";
  const panel = findInfoDrawer() || drawer;
  const scroller = drawerScroller(panel);
  const members = new Map(); // name -> { name, number }

  const collect = () => {
    for (const row of panel.querySelectorAll(SELECTORS.drawerListItem.join(","))) {
      const name = rowTitle(row);
      if (!name || members.has(name)) continue;
      members.set(name, { name, number: jidNumberFrom(row, 80) || numberFromTitle(name) });
    }
  };

  collect();
  for (let step = 0; step < 200 && !extractCancelled; step++) {
    const before = scroller.scrollTop;
    scroller.scrollBy(0, Math.max(scroller.clientHeight * 0.8, 300));
    nudgeRendering(scroller);
    await sleep(350);
    collect();
    if (scroller.scrollTop === before) break;
  }

  await closeInfoDrawer();
  currentStep = "idle";
  if (!members.size) {
    throw new Error(`No members were listed for "${groupName}". Open its group info panel once by hand, then try again.`);
  }
  return Array.from(members.values());
}


// ---------- Reading a chat's messages ----------
/**
 * WhatsApp stamps every text bubble with data-pre-plain-text, e.g. "[11:03 AM, 16/09/2026] Sakshi: ".
 * That one attribute carries the time, the date and the sender, so it is what the export reads.
 * Date order differs by locale, so all three common orders are handled.
 */
/**
 * Which number a date puts first cannot be told from "8/9/2026" alone - it is 8 September in one
 * country and 9 August in another, and WhatsApp follows the browser's locale. Guessing per date is
 * how 8/10/2026 became 8 October, a date that had not happened yet. Instead the whole chat is
 * scanned first: any date with a number above 12 in it can only be read one way, and that settles
 * the order for every ambiguous date alongside it.
 */
let dayFirstHint = null;

/** Splits "[11:03 AM, 16/09/2026] Sakshi: " into parts, without deciding the date order yet. */
function splitPrePlainText(value) {
  const match = String(value || "").match(/^\[([^\]]+)\]\s*([^:]*):/);
  if (!match) return null;
  const parts = match[1].split(",").map((part) => part.trim());
  const datePart = parts.find((part) => /\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}/.test(part));
  const timePart = parts.find((part) => /\d{1,2}:\d{2}/.test(part));
  return datePart ? { datePart, timePart, sender: match[2].trim() } : null;
}

/** Records a date that can only be read one way, if this chat has thrown one up yet. */
function noteDateOrder(value) {
  if (dayFirstHint !== null) return;
  const parts = splitPrePlainText(value);
  if (!parts) return;
  const nums = parts.datePart.split(/[/.-]/).map(Number);
  if (nums[0] > 31) return; // 2026-09-16: year first, nothing ambiguous about it
  if (nums[0] > 12) dayFirstHint = true;
  else if (nums[1] > 12) dayFirstHint = false;
}

/** What this machine puts first - the same choice WhatsApp Web makes when it prints a date. */
function localeDayFirst() {
  return /^31/.test(new Date(2026, 0, 31).toLocaleDateString());
}

function parsePrePlainText(value) {
  const parts = splitPrePlainText(value);
  if (!parts) return null;

  const nums = parts.datePart.split(/[/.-]/).map(Number);
  let [day, month, year] = nums;
  if (nums[0] > 31) {
    [year, month, day] = nums; // 2026-09-16
  } else if (nums[0] > 12) {
    [day, month, year] = nums; // only a day can be above 12
  } else if (nums[1] > 12) {
    [month, day, year] = nums;
  } else if (!(dayFirstHint ?? localeDayFirst())) {
    [month, day, year] = nums; // ambiguous: go with what the rest of the chat showed
  }
  if (year < 100) year += 2000;

  let hours = 0;
  let minutes = 0;
  const time = parts.timePart && parts.timePart.match(/(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/i);
  if (time) {
    hours = Number(time[1]);
    minutes = Number(time[2]);
    const meridiem = (time[3] || "").toLowerCase().replace(/\./g, "");
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  }
  const at = new Date(year, month - 1, day, hours, minutes);
  return Number.isNaN(at.getTime()) ? null : { at, sender: parts.sender };
}

/** The pane that scrolls inside an open chat - scrolling it up is what loads older messages. */
function messageScroller() {
  const main = document.querySelector("#main");
  if (!main) return null;
  return (
    Array.from(main.querySelectorAll("div")).find(
      (div) => div.clientHeight > 200 && div.scrollHeight > div.clientHeight + 40
    ) || null
  );
}

function messageNodes() {
  return Array.from(document.querySelectorAll("#main [data-pre-plain-text]"));
}

/**
 * innerText is what the user sees - line breaks and all - but it is built from the rendered layout,
 * and a tab Chrome is not drawing can hand back an empty string. textContent needs no layout, so it
 * stands in whenever innerText comes up empty.
 */
function readableText(node) {
  if (!node) return "";
  return (node.innerText || node.textContent || "").trim();
}

/**
 * Every message bubble in the open chat, in the order they appear. The id lives on whichever
 * element WhatsApp happens to hang it on, and sometimes on a child of that one too, so the tag is
 * not assumed and only the outermost element per id is kept.
 */
function messageRows() {
  const seen = new Set();
  const rows = [];
  for (const node of document.querySelectorAll("#main [data-id]")) {
    const id = node.getAttribute("data-id") || "";
    if (!/^(true|false)_/.test(id) || seen.has(id)) continue;
    seen.add(id);
    rows.push(node);
  }
  return rows;
}

/** The stamp attribute, whether it sits on this element or inside it. */
function stampOf(row) {
  const node = row.matches("[data-pre-plain-text]") ? row : row.querySelector("[data-pre-plain-text]");
  return node ? node.getAttribute("data-pre-plain-text") : null;
}

/**
 * When a bubble carries no stamp of its own - which is the case for a photo with no caption - the
 * nearest stamped bubble above it dates it. Messages sitting next to each other are from the same
 * day in all but the rare case that straddles midnight.
 */
const pad2 = (value) => String(value).padStart(2, "0");

/** 2026-09-16 - sorts correctly as text, and reads the same in every country. */
function isoDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 14:05 - 24-hour, so there is no am/pm to sort around. */
function clockTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** The little time WhatsApp prints in the corner of a bubble, e.g. "11:03 am". Time, no date. */
function bubbleTime(row) {
  // The last match, not the first: a wrapper's text runs a short message into the time - "3" and
  // "1:07 PM" read "31:07 PM" - while the time's own element comes after it.
  let found = null;
  for (const node of row.querySelectorAll("span, div")) {
    const text = (node.textContent || "").trim();
    const match = text.match(/^(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?$/i);
    if (!match) continue;
    let hours = Number(match[1]);
    const minutes = Number(match[2]);
    const meridiem = (match[3] || "").toLowerCase().replace(/\./g, "");
    if (minutes > 59 || hours > (meridiem ? 12 : 23)) continue;
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    found = { hours, minutes };
  }
  return found;
}

/**
 * The stamp a bubble will be dated by, kept as the raw text. Turning it into a date waits until the
 * whole chat has been read, because only then is it certain which way round the chat writes its
 * dates - read too early, 9/5/2026 is taken as 9 May when the chat later shows it means 5 September.
 */
function rowStamp(row, rows, index) {
  const own = stampOf(row);
  if (splitPrePlainText(own)) return { raw: own, approximate: false, clock: null };

  // No stamp of its own - a photo with no caption, or a build that has dropped the attribute.
  // The nearest stamped bubble above gives the day; this bubble's printed time refines the clock.
  for (let i = index - 1; i >= 0; i--) {
    const near = stampOf(rows[i]);
    if (splitPrePlainText(near)) return { raw: near, approximate: true, clock: bubbleTime(row) };
  }
  return null;
}

/** Dates a collected row from its raw stamp, now that the chat's date order is known. */
function resolveRowDate(row) {
  const meta = row.stamp && parsePrePlainText(row.stamp.raw);
  if (!meta) return;
  const at = new Date(meta.at);
  if (row.stamp.approximate && row.stamp.clock) at.setHours(row.stamp.clock.hours, row.stamp.clock.minutes, 0, 0);
  row.at = at.getTime();
  // Fixed formats, not the machine's locale: 8/9/2026 could be August or September, and a
  // spreadsheet sorts such text as text.
  row.date = isoDate(at);
  row.time = clockTime(at);
  row.sender = row.stamp.approximate ? "" : meta.sender;
  row.approximate = row.stamp.approximate;
}

/** A stamp whose date can be read only one way, whatever order the chat turns out to use. */
function unambiguousStamp(raw) {
  const parts = splitPrePlainText(raw);
  if (!parts) return false;
  const nums = parts.datePart.split(/[/.-]/).map(Number);
  return nums[0] > 12 || nums[1] > 12;
}

/**
 * The picture WhatsApp has already drawn in a bubble, as a data URL. Only the preview it renders in
 * the conversation is available - the full-size original lives behind the media viewer - so this is
 * a thumbnail, not the original file.
 */
function bubbleImage(row) {
  const img = row.querySelector('img[src^="blob:"], img[src^="data:image"]');
  if (!img || !img.complete) return null;
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(img, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return null; // a cross-origin image would taint the canvas; nothing to be done about it
  }
}

/** When the oldest message on screen was sent; used to know when to stop scrolling up. */
function oldestLoadedTime() {
  for (const node of messageNodes()) {
    const raw = node.getAttribute("data-pre-plain-text");
    // Until the chat has shown which way round it writes dates, only a date that cannot be misread
    // is trusted - stopping early on a misread one would cut the export short.
    if (dayFirstHint === null && !unambiguousStamp(raw)) continue;
    const meta = parsePrePlainText(raw);
    if (meta) return meta.at.getTime();
  }
  return null;
}

/** Outgoing messages carry a "true_" id; the message-out class is the fallback. */
function isOutgoing(node) {
  const withId = node.closest("[data-id]");
  const id = withId?.getAttribute("data-id") || "";
  if (id.startsWith("true_")) return true;
  if (id.startsWith("false_")) return false;
  return !!node.closest(".message-out");
}

// How many messages the last chat gave up in total, before the date window narrowed them. The DOM
// no longer holds them all by the time the caller asks, so the count is recorded here instead.
let lastChatSeen = 0;

/**
 * Waits for WhatsApp to fetch the next batch of older messages. It goes to the server for them, so
 * a fixed pause is a guess: this polls instead, reading whatever has appeared as it appears, and
 * keeps nudging the pane back to the top because inserted rows push it down again.
 */
async function waitForOlderMessages(scroller, before, sweep, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs && !extractCancelled) {
    await sleep(400);
    sweep();
    if (scroller.scrollHeight > before) return true;
    // Still waiting: stay pinned to the top, which is what tells WhatsApp to fetch more.
    if (scroller.scrollTop !== 0) scroller.scrollTop = 0;
    nudgeRendering(scroller);
  }
  return false;
}

// However long a chat is, one chat gets this long before the reader moves on with what it has.
const CHAT_TIME_LIMIT_MS = 15 * 60 * 1000;

const scrollStride = (scroller) => Math.max(scroller.clientHeight * 0.8, 200);

/**
 * Brings the pane down to the chat's latest message, reading on the way. A single jump is not
 * enough: WhatsApp keeps its own anchor and can put the pane straight back where an earlier run
 * left it - at the very first message of the chat - which is how an export stopped in mid-August.
 * Walking down a screen at a time cannot be undone that way, and reads everything it passes.
 */
async function walkToNewest(scroller, sweep, deadline) {
  const arrow = queryFirst(SELECTORS.scrollToBottom);
  if (arrow) {
    realClick(arrow.closest('button, [role="button"]') || arrow);
    await sleep(800);
    sweep();
  }
  let still = 0;
  while (!extractCancelled && Date.now() < deadline) {
    const before = scroller.scrollTop;
    scroller.scrollTop = before + scrollStride(scroller);
    nudgeRendering(scroller);
    await sleep(300);
    sweep();
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
    // Three checks at the bottom leaves time for anything newer to load in below.
    if (atBottom || scroller.scrollTop <= before) {
      if (++still >= 3) return;
    } else {
      still = 0;
    }
  }
}

async function readOpenChatMessages(chatName, since, until, withImages) {
  lastChatSeen = 0;
  dayFirstHint = null; // each chat settles its own, from its own dates
  const deadline = Date.now() + CHAT_TIME_LIMIT_MS;
  const scroller = messageScroller();
  // WhatsApp only keeps the messages near the viewport in the page: scrolling throws the others
  // away. So every bubble is collected at every scroll step and kept in this map, keyed by its
  // WhatsApp id so the overlap between steps does not duplicate anything.
  const collected = new Map();

  const sweep = () => {
    const bubbles = messageRows().length ? messageRows() : messageNodes();
    for (const bubble of bubbles) noteDateOrder(stampOf(bubble));
    for (let i = 0; i < bubbles.length; i++) {
      const bubble = bubbles[i];
      const text = readableText(bubble.querySelector("span.selectable-text"));
      const image = withImages ? bubbleImage(bubble) : null;
      if (!text && !image) continue; // system notices, deleted messages, call logs

      const stamp = rowStamp(bubble, bubbles, i);
      const key = bubble.getAttribute?.("data-id") || `${stamp?.raw || ""}|${text}`;
      if (collected.has(key)) continue;

      collected.set(key, {
        stamp,
        at: null,
        chat: chatName,
        date: "",
        time: "",
        approximate: false,
        direction: isOutgoing(bubble) ? "Sent" : "Received",
        sender: "",
        text,
        image,
      });
    }
  };

  /** The rows so far, dated under what the chat has shown about its date order up to now. */
  const snapshot = () => {
    const rows = Array.from(collected.values());
    rows.forEach(resolveRowDate);
    return rows.map(({ stamp, ...row }) => row);
  };

  sweep();
  if (scroller) await walkToNewest(scroller, sweep, deadline);

  // Then up to the start of the chat, one screen at a time, so every message passes through view.
  let idle = 0;
  for (let step = 0; scroller && !extractCancelled; step++) {
    if (Date.now() > deadline) break;
    const oldest = oldestLoadedTime();
    if (since && oldest && oldest < since) break;

    if (scroller.scrollTop > 0) {
      scroller.scrollTop = Math.max(0, scroller.scrollTop - scrollStride(scroller));
      nudgeRendering(scroller);
      await sleep(350);
      sweep();
      idle = 0;
      if (step % 10 === 0) {
        reportReadingProgress(chatName, collected.size);
        streamRows(snapshot());
      }
      continue;
    }

    // At the top of what is loaded: wait for WhatsApp to fetch the next older batch. Two rounds
    // with nothing new is the start of the chat - one is just a slow reply from the server.
    const before = scroller.scrollHeight;
    if (await waitForOlderMessages(scroller, before, sweep)) {
      idle = 0;
      // If WhatsApp kept our place, the new batch is already above us. If it left us at the very
      // top, move down to where the old top now sits, so the batch is walked through, not skipped.
      const added = scroller.scrollHeight - before;
      if (scroller.scrollTop < scrollStride(scroller)) scroller.scrollTop = added;
      await sleep(350);
      sweep();
    } else if (++idle >= 2) {
      break;
    }
    reportReadingProgress(chatName, collected.size, idle > 0);
    streamRows(snapshot());
  }

  // Every stamp in the chat has now been seen, so the date order is as settled as it will get.
  // Streamed in collection order - the order earlier batches were sliced from - before sorting.
  const all = snapshot();
  streamRows(all);
  all.sort((a, b) => (a.at || Infinity) - (b.at || Infinity));
  lastChatSeen = all.length;

  const inWindow = all.filter((row) => {
    if (!row.at) return !since && !until;
    if (since && row.at < since) return false;
    if (until && row.at > until) return false;
    return true;
  });
  if (inWindow.length || all.some((row) => row.at)) return inWindow;

  // Not one bubble could be dated - this build gives no readable timestamps. Dropping the lot over
  // a window that cannot be checked would be worse than handing back everything and saying so.
  all.forEach((row) => (row.undated = true));
  return all;
}

/**
 * Opens each chat in turn and reads the messages inside the date window.
 *
 * `stats` is what tells an empty result apart from a broken one: `bubbles` counts the message
 * elements WhatsApp actually put on the page, so zero bubbles means the page never drew the chat
 * (the usual reason being a hidden tab), while plenty of bubbles and no rows means the date window
 * simply excluded them.
 */
async function extractChatMessages(names, since, until, withImages) {
  extractCancelled = false;
  streamedCount = 0;
  await waitForWhatsAppReady();
  const messages = [];
  const stats = { opened: 0, bubbles: 0, images: 0, hidden: document.hidden, failures: [] };

  for (let i = 0; i < names.length; i++) {
    if (extractCancelled) break;
    const name = names[i];
    reportProgress(i, names.length, name);
    try {
      currentStep = `reading messages in "${name}"`;
      readingChat = { index: i, total: names.length };
      streamedCount = 0; // each chat streams its own rows from the start
      await openChatByName(name);
      await sleep(800);
      stats.opened += 1;
      const rows = await readOpenChatMessages(name, since, until, withImages);
      stats.bubbles += lastChatSeen;
      stats.images += rows.filter((r) => r.image).length;
      if (rows.some((r) => r.undated)) stats.undated = true;
      messages.push(...rows);
    } catch (err) {
      stats.failures.push(`${name}: ${err.message || err}`);
    }
  }

  currentStep = "idle";
  reportProgress(names.length, names.length, "");
  return { messages, stats };
}

/** Scrolls through the whole chat list, collecting every chat's name, type and number. */
async function scrapeChats() {
  await waitForWhatsAppReady();
  await clearSearch();

  const chats = new Map(); // name -> { name, type, number }
  const collect = () => {
    for (const row of document.querySelectorAll(SELECTORS.chatListItem.join(","))) {
      const name = rowTitle(row);
      if (!name || chats.has(name)) continue;
      const type = isGroupRow(row) ? "group" : "individual";
      // The numbers that cost nothing: the row's own WhatsApp id, or a title that is already a number.
      const number = type === "group" ? null : jidNumberFrom(row, 80) || numberFromTitle(name);
      chats.set(name, { name, type, number });
    }
  };

  const scroller = chatListScroller();
  if (scroller) {
    scroller.scrollTo(0, 0);
    await sleep(500);
    // WhatsApp only renders the rows near the viewport, so collect at every scroll step.
    for (let step = 0; step < 300; step++) {
      collect();
      const before = scroller.scrollTop;
      scroller.scrollBy(0, Math.max(scroller.clientHeight * 0.8, 300));
      nudgeRendering(scroller);
      await sleep(350);
      if (scroller.scrollTop === before) break;
    }
    scroller.scrollTo(0, 0);
  }
  collect();

  return Array.from(chats.values());
}

function pickFileInput(mimeType) {
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  if (!inputs.length) return null;
  const isImageOrVideo = mimeType.startsWith("image/") || mimeType.startsWith("video/");
  const match = inputs.find((i) => {
    const accept = i.getAttribute("accept") || "";
    return isImageOrVideo ? accept.includes("image") || accept.includes("video") : !accept.includes("image");
  });
  return match || inputs[0];
}

function dataUrlToFile(dataUrl, filename, mimeType) {
  const byteString = atob(dataUrl.split(",")[1]);
  const bytes = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
  return new File([bytes], filename, { type: mimeType });
}

function isComposerBox(node, composer) {
  return node === composer || node.getAttribute("data-tab") === "10";
}

async function clearEditor(editable) {
  editable.focus();
  document.execCommand("selectAll", false, undefined);
  document.execCommand("delete", false, undefined);
  await sleep(300);
}

/** A visible text box in the attachment preview that isn't the chat's message box or the search box. */
function findCaptionBox(composer) {
  const boxes = Array.from(document.querySelectorAll('[contenteditable]:not([contenteditable="false"]), textarea')).filter(
    (node) => !isComposerBox(node, composer) && !node.closest("#side") && node.getClientRects().length > 0
  );
  const labelled = boxes.find((node) =>
    /caption/i.test(["aria-label", "aria-placeholder", "placeholder"].map((attr) => node.getAttribute(attr) || "").join(" "))
  );
  return labelled || boxes[0] || null;
}

/** Pastes the file into the message box, the way a person adds an image to text they've already typed. */
async function openPreviewByPaste(composer, file, findPreviewSend) {
  const data = new DataTransfer();
  data.items.add(file);
  composer.focus();
  composer.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  return waitForNode(findPreviewSend, { timeout: 8000 }).then(
    () => true,
    () => false
  );
}

async function openPreviewByAttachMenu(mimeType, file) {
  const attachBtn = await waitFor(SELECTORS.attachButton, {
    label: "the Attach (+) button",
    probe: () => describeNodes("#main footer [data-icon], #main footer button", ["data-icon", "aria-label", "title"]),
  });
  (attachBtn.closest('button, [role="button"]') || attachBtn).click();
  await sleep(800);

  const input = pickFileInput(mimeType);
  if (!input) throw new Error("Could not find WhatsApp's file input - UI may have changed.");

  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Sends a file with its caption underneath, as one message. The caption is typed into the message box first,
 * then an image/video is pasted in (WhatsApp carries typed text into the preview as the caption); other files,
 * or builds that ignore the paste, go through the Attach menu. A caption box in the preview is filled too.
 * Returns { captionSeparate, previewBoxes } if the caption stayed behind and had to go as its own message.
 */
async function attachFileWithCaption(attachment, caption) {
  const composer = await waitFor(SELECTORS.messageBox, { label: "the message box" });
  if (caption) {
    currentStep = "typing the caption";
    await typeIntoEditor(composer, caption, "caption");
  }

  const file = dataUrlToFile(attachment.dataUrl, attachment.name, attachment.mimeType);
  // The attachment preview has its own Send button outside the chat footer.
  const findPreviewSend = () => sendButtons().find((btn) => !isInComposer(btn));

  currentStep = "attaching the file";
  const isMedia = /^(image|video)\//.test(attachment.mimeType);
  const pasted = isMedia && (await openPreviewByPaste(composer, file, findPreviewSend));
  if (!pasted) await openPreviewByAttachMenu(attachment.mimeType, file);

  currentStep = "waiting for the attachment preview";
  await waitForNode(findPreviewSend, { label: "the attachment preview Send button", probe: sendProbe });

  const captionBox = caption
    ? await waitForNode(() => findCaptionBox(composer), { timeout: 3000 }).catch(() => null)
    : null;
  if (captionBox && !editorHasText(captionBox, caption)) await typeIntoEditor(captionBox, caption, "caption");
  // Kept for the report if the caption still can't be attached, so the right box can be targeted next time.
  const previewBoxes = describeNodes("[contenteditable], textarea", ["aria-label", "aria-placeholder", "placeholder", "data-tab"]);
  await sleep(500);

  currentStep = "sending the attachment";
  (await waitForNode(findPreviewSend, { timeout: 5000, label: "the attachment preview Send button" })).click();
  await sleep(2500);

  // Never leave the caption behind as a draft: drop it if the preview had its own caption box,
  // otherwise send it straight after the file.
  const leftover = caption ? queryFirst(SELECTORS.messageBox) : null;
  if (leftover?.textContent.trim() && editorHasText(leftover, caption)) {
    if (captionBox) {
      await clearEditor(leftover);
    } else {
      currentStep = "sending the caption as a message";
      await clickSend();
      return { captionSeparate: true, previewBoxes };
    }
  }
  return {};
}

async function handleSendToContact({ targetType, name, message, attachment }) {
  sendBusy = true;
  try {
    currentStep = "waiting for the chatbot to finish";
    await waitUntil(() => !botBusy, 15000);
    currentStep = "waiting for WhatsApp Web to load";
    await waitForWhatsAppReady();

    if (targetType === "number") {
      // Background already navigated the tab to the phone-URL chat.
      currentStep = "waiting for the chat to open";
      await waitForChatOpen();
    } else {
      // 'contact' or 'group' - both opened the same way, by display name.
      await openChatByName(name);
    }

    if (attachment) {
      const { captionSeparate, previewBoxes } = await attachFileWithCaption(attachment, attachment.caption || message);
      if (captionSeparate) {
        return { success: true, note: `Caption was sent as a separate message. Preview text boxes: ${previewBoxes}` };
      }
    } else {
      currentStep = "typing the message";
      await setMessageText(message);
      currentStep = "clicking Send";
      await clickSend();
    }

    return { success: true };
  } finally {
    sendBusy = false;
    currentStep = "idle";
  }
}

// ---------- Quick replies (floating button on WhatsApp Web) ----------
function placeCaretAtEnd(editable) {
  editable.focus();
  const range = document.createRange();
  range.selectNodeContents(editable);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

async function renderQuickReplyPanel(panel) {
  const { quickReplies = [] } = await chrome.storage.local.get("quickReplies");
  panel.replaceChildren();

  const head = document.createElement("div");
  head.className = "wabs-head";
  head.textContent = "Quick replies";
  panel.append(head);

  if (!quickReplies.length) {
    const note = document.createElement("div");
    note.className = "wabs-note";
    note.textContent = "No quick replies yet - add them in the Starshift WA Sender dashboard.";
    panel.append(note);
    return;
  }

  for (const reply of quickReplies) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "wabs-item";
    const title = document.createElement("span");
    title.textContent = reply.title;
    const text = document.createElement("small");
    text.textContent = reply.text;
    item.append(title, text);
    // One click types the reply and sends it - that is the whole point of a quick reply.
    item.addEventListener("click", async () => {
      const box = queryFirst(SELECTORS.messageBox);
      if (!box) {
        text.textContent = "Open a chat first.";
        return;
      }
      if (sendBusy) {
        text.textContent = "A campaign is sending right now - try again in a moment.";
        return;
      }
      if (item.disabled) return;

      placeCaretAtEnd(box);
      document.execCommand("insertText", false, reply.text);

      // botBusy holds the campaign runner off until this send is through.
      botBusy = true;
      item.disabled = true;
      const label = title.textContent;
      title.textContent = "Sending...";
      try {
        await sleep(250); // let WhatsApp's editor register the text before the Send button is looked up
        await clickSend();
        panel.hidden = true;
      } catch (err) {
        text.textContent = err.message || String(err);
      } finally {
        title.textContent = label;
        item.disabled = false;
        botBusy = false;
      }
    });
    panel.append(item);
  }
}

function mountQuickReplies() {
  // A previous copy may still be on the page if the extension was reloaded; its handlers are dead.
  ["wabs-style", "wabs-qr-btn", "wabs-qr-panel"].forEach((id) => document.getElementById(id)?.remove());

  const style = document.createElement("style");
  style.id = "wabs-style";
  style.textContent = `
    #wabs-qr-btn { position: fixed; right: 20px; bottom: 90px; z-index: 9999; width: 44px; height: 44px; border: none;
      border-radius: 50%; background: #25d366; color: #fff; font-size: 20px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
    #wabs-qr-panel { position: fixed; right: 20px; bottom: 142px; z-index: 9999; width: 280px; max-height: 360px; overflow-y: auto;
      background: #fff; color: #111; border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,.25); font: 13px/1.4 "Segoe UI", Roboto, Arial, sans-serif; }
    #wabs-qr-panel[hidden] { display: none; }
    #wabs-qr-panel .wabs-head { padding: 10px 12px; font-weight: 600; border-bottom: 1px solid #eee; }
    #wabs-qr-panel .wabs-note { padding: 10px 12px; color: #667; }
    #wabs-qr-panel .wabs-item { display: block; width: 100%; padding: 8px 12px; border: none; border-bottom: 1px solid #f2f2f2;
      background: #fff; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    #wabs-qr-panel .wabs-item:hover { background: #f0f7f4; }
    #wabs-qr-panel .wabs-item small { display: block; color: #667; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `;

  const button = document.createElement("button");
  button.id = "wabs-qr-btn";
  button.type = "button";
  button.title = "Quick replies (Starshift WA Sender)";
  button.textContent = "⚡";

  const panel = document.createElement("div");
  panel.id = "wabs-qr-panel";
  panel.hidden = true;

  button.addEventListener("click", async () => {
    if (!panel.hidden) {
      panel.hidden = true;
      return;
    }
    await renderQuickReplyPanel(panel);
    panel.hidden = false;
  });

  document.head.append(style);
  document.body.append(button, panel);
}

// ---------- Chatbot auto-replies ----------
// What a message matches, and the default Starshift menu, live in common/chatbot.js (SwasBot),
// which the dashboard's Test Reply uses too.
const BOT_INTERVAL_MS = 3000;
const BOT_ROW_RETRY_MS = 2 * 60 * 1000; // an unread chat the bot opened is not reopened for this long
const BOT_HANDLED_MAX = 300; // incoming message ids remembered across page loads
const BOT_MAX_NEW_AT_ONCE = 5; // more "new" bubbles than this in one tick is history loading, not messages
// While the server WhatsApp is answering (see syncServerBot in background.js, every 10 minutes), this
// tab's bot stands down. The server's word is trusted this long, so a server that goes quiet hands the
// replies back here.
const BOT_SERVER_FRESH_MS = 25 * 60 * 1000;

const botRowsTried = new Map(); // "chat|preview" -> when the bot last opened that unread chat
const botRecentReplies = new Map(); // "chat|reply" -> when it was last sent
const botReplyTimes = new Map(); // chat title -> when its recent replies went out
// Normalized chat title -> when the bot last gave that chat a real answer. For SwasBot.LIMITS.sessionMs
// after that, whatever the customer sends gets a reply (the menu again when nothing else matches).
const botSessions = new Map();
let botMode = ""; // "server" or "web" - logged when it changes

function inBotSession(title) {
  return Date.now() - (botSessions.get(SwasBot.normalize(title)) || 0) < SwasBot.LIMITS.sessionMs;
}

function noteBotAnswer(title, action) {
  const key = SwasBot.normalize(title);
  if (action.type === "unsubscribe") botSessions.delete(key);
  else if (action.type !== "fallback") botSessions.set(key, Date.now());
  const times = botReplyTimes.get(title) || [];
  botReplyTimes.set(title, [...times, Date.now()]);
}

/** At most SwasBot.LIMITS.repliesPerMinute replies to one chat a minute - two auto-repliers never loop forever. */
function botWithinRate(title) {
  const recent = (botReplyTimes.get(title) || []).filter((at) => Date.now() - at < 60 * 1000);
  botReplyTimes.set(title, recent);
  return recent.length < SwasBot.LIMITS.repliesPerMinute;
}
let botHandledIds = null; // incoming message data-ids already dealt with; loaded on the first tick
// The chat open on the right and every message id seen in it; only ids that turn up later are new.
let openChatSeen = { title: "", known: new Set() };

function botLog(...args) {
  console.log("[Starshift WA Sender] chatbot:", ...args);
}

// The line under the name ("online", "typing...", "last seen ...") comes and goes by the second;
// taking it for the chat's name would make the open chat look like a different one each tick.
const HEADER_STATUS = /^(online|typing|recording|last seen|click here|tap here|ऑनलाइन|टाइप करत)/i;

/** Name of the chat open on the right, or "" when none is. */
function openChatTitle() {
  const header = document.querySelector("#main header");
  if (!header) return "";
  const spans = Array.from(header.querySelectorAll("span"));
  const preferred = spans.filter((span) => span.matches('[dir="auto"], [title]'));
  for (const list of [preferred, spans]) {
    for (const span of list) {
      const text = (span.getAttribute("title") || span.textContent || "").trim();
      if (text && text.length < 100 && !HEADER_STATUS.test(text)) return text;
    }
  }
  return "";
}

const BOT_TICK_ICONS = [
  '[data-icon*="msg-check"]',
  '[data-icon*="dblcheck"]',
  '[data-icon*="msg-time"]',
  '[aria-label=" Read "]',
  '[aria-label=" Delivered "]',
  '[aria-label=" Sent "]',
  '[aria-label=" Pending "]',
].join(", ");

/**
 * Every message in the open chat, one element each, however this WhatsApp build marks them. Older
 * builds put the direction in data-id ("false_..." incoming, "true_..." outgoing); newer ones give a
 * bare hash, so their message rows are used and bubbleIncoming works the direction out.
 */
function openChatBubbles() {
  const main = document.querySelector("#main");
  if (!main) return [];
  const prefixed = Array.from(main.querySelectorAll("[data-id]")).filter((node) =>
    /^(true|false)_/.test(node.getAttribute("data-id"))
  );
  if (prefixed.length) return prefixed;
  const rows = Array.from(main.querySelectorAll('[role="row"]')).filter(
    (row) => row.matches("[data-id]") || row.querySelector("[data-id], [data-pre-plain-text]")
  );
  if (rows.length) return rows;
  const byClass = Array.from(main.querySelectorAll(".message-in, .message-out"));
  if (byClass.length) return byClass;
  return Array.from(main.querySelectorAll("[data-pre-plain-text]"));
}

/** The first element matching selector: the node itself, then inside it, then around it. */
function nearest(node, selector) {
  return node.matches(selector) ? node : node.querySelector(selector) || node.closest(selector);
}

function bubbleDataId(node) {
  return nearest(node, "[data-id]")?.getAttribute("data-id") || "";
}

/** Who sent it, from the "[1:07 PM, 9/29/2026] PAPPA: " stamp on text messages. */
function bubbleSender(node) {
  const stamp = nearest(node, "[data-pre-plain-text]")?.getAttribute("data-pre-plain-text");
  return splitPrePlainText(stamp)?.sender || "";
}

/** Customers' messages sit on the left of the chat, ours on the right; null when it cannot be told. */
function bubbleOnLeft(node) {
  const row = node.closest('[role="row"]') || node;
  const rowBox = row.getBoundingClientRect();
  if (!rowBox.width) return null;
  for (const selector of ["[data-pre-plain-text]", "span.selectable-text", "[data-id]", "img"]) {
    const inner = row.querySelector(selector);
    const box = inner?.getBoundingClientRect();
    if (!box?.width || box.width > rowBox.width - 40) continue;
    const leftGap = box.left - rowBox.left;
    const rightGap = rowBox.right - box.right;
    if (Math.abs(leftGap - rightGap) >= 30) return leftGap < rightGap;
  }
  return null;
}

/** true for a customer's message, false for one of ours, null when this build gives no way to tell. */
function bubbleIncoming(node, chatName = openChatTitle()) {
  const dataId = bubbleDataId(node);
  if (dataId.startsWith("false_")) return true;
  if (dataId.startsWith("true_")) return false;
  const marked = nearest(node, ".message-in, .message-out");
  if (marked) return marked.classList.contains("message-in");
  const row = node.closest('[role="row"]') || node;
  if (row.querySelector(BOT_TICK_ICONS)) return false; // only our own messages carry delivery ticks
  const sender = bubbleSender(node);
  if (sender && chatName && plainText(sender) === plainText(chatName)) return true;
  return bubbleOnLeft(node);
}

function bubbleInfo(node, chatName = openChatTitle()) {
  const dataId = bubbleDataId(node);
  const stampEl = nearest(node, "[data-pre-plain-text]");
  // The stamped element holds the message's own text; a quoted message sits elsewhere in the row.
  const textEl =
    stampEl?.querySelector("span.selectable-text") ||
    node.querySelector("span.selectable-text") ||
    stampEl ||
    node.querySelector(".copyable-text");
  const text = bubbleText(textEl);
  const stamp = stampEl?.getAttribute("data-pre-plain-text") || "";
  return {
    node,
    id: dataId || `${stamp}|${text}`,
    incoming: bubbleIncoming(node, chatName),
    chatId: dataId.split("_")[1] || "",
    text,
  };
}

/** Group chats are never answered. Newer builds do not say so in the message ids, so look around. */
function openChatIsGroup(title) {
  if (document.querySelector('#main [data-id*="@g.us"]')) return true;
  const row = findChatByName(title)?.closest(SELECTORS.chatListItem.join(","));
  if (row && isGroupRow(row)) return true;
  // A group's header lists its members: "Asha, Ravi, You".
  const header = document.querySelector("#main header");
  return Array.from(header?.querySelectorAll("span") || []).some((span) =>
    /(^|,\s*)You(,|$)/.test((span.getAttribute("title") || span.textContent || "").trim())
  );
}

function openChatIds() {
  const chatName = openChatTitle();
  return openChatBubbles().map((node) => bubbleInfo(node, chatName).id);
}

/** The newest message in the open chat: the lowest one on screen, whatever order the page keeps them in. */
function lastMessageInOpenChat() {
  const bubbles = openChatBubbles();
  if (!bubbles.length) return null;
  let newest = bubbles[bubbles.length - 1];
  let lowest = newest.getBoundingClientRect().bottom;
  for (const node of bubbles) {
    const bottom = node.getBoundingClientRect().bottom;
    if (bottom > lowest) {
      newest = node;
      lowest = bottom;
    }
  }
  return bubbleInfo(newest, openChatTitle());
}

/** What the open chat looks like to the bot, for the console when it cannot read a message. */
function messageProbe() {
  const count = (selector) => document.querySelectorAll(selector).length;
  const lastIds = Array.from(document.querySelectorAll("#main [data-id]"))
    .slice(-2)
    .map((node) => node.getAttribute("data-id").slice(0, 32));
  return [
    `title "${openChatTitle()}"`,
    `data-id ${count("#main [data-id]")} (last: ${lastIds.join(", ") || "none"})`,
    `message-in ${count("#main .message-in")}`,
    `message-out ${count("#main .message-out")}`,
    `rows ${count('#main [role="row"]')}`,
    `stamps ${count("#main [data-pre-plain-text]")}`,
  ].join(", ");
}

function scrollParent(node) {
  for (let element = node?.parentElement; element && element.id !== "main"; element = element.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 10) {
      return element;
    }
  }
  return null;
}

/** Only while the open chat is scrolled to its newest message is its lowest bubble really the latest. */
function openChatAtNewest(bubble) {
  const scroller = scrollParent(bubble);
  if (!scroller) return true;
  // A column-reverse list keeps scrollTop at 0 at the bottom and goes negative going up.
  if (getComputedStyle(scroller).flexDirection === "column-reverse") return Math.abs(scroller.scrollTop) < 150;
  return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 150;
}

/** A bubble whose printed time is within 15 minutes of now; one with no readable time passes. */
function arrivedRecently(bubble) {
  const time = bubbleTime(bubble);
  if (!time) return true;
  const now = new Date();
  const diff = Math.abs(now.getHours() * 60 + now.getMinutes() - (time.hours * 60 + time.minutes));
  return Math.min(diff, 1440 - diff) <= 15;
}

/** The bot's own reply read back as a customer's would make it answer itself forever. */
function isOwnRecentReply(title, text) {
  const said = SwasBot.normalize(text).slice(0, 60);
  if (!said) return false;
  const since = Date.now() - 10 * 60 * 1000;
  for (const [key, at] of botRecentReplies) {
    if (at > since && key.startsWith(`${title}|`) && SwasBot.normalize(key.slice(title.length + 1)).slice(0, 60) === said) {
      return true;
    }
  }
  return false;
}

function phoneFromChat(chatId, title) {
  const fromId = chatId.match(/^(\d{7,15})@c\.us$/);
  if (fromId) return fromId[1];
  if (/^\+?[\d\s()-]{8,}$/.test(title)) return title.replace(/\D/g, "");
  return null;
}

async function addUnsubscriber(entry) {
  const { unsubscribers = [] } = await chrome.storage.local.get("unsubscribers");
  if (unsubscribers.some((existing) => existing.toLowerCase() === entry.toLowerCase())) return;
  await chrome.storage.local.set({ unsubscribers: [...unsubscribers, entry] });
  botLog(`added "${entry}" to Unsubscribers`);
}

/** START from an unsubscribed contact: every Unsubscribers entry that is them comes off the list. */
async function removeUnsubscriber(contact) {
  const { unsubscribers = [] } = await chrome.storage.local.get("unsubscribers");
  const kept = unsubscribers.filter((entry) => !SwasBot.isSameContact(entry, contact));
  if (kept.length === unsubscribers.length) return;
  await chrome.storage.local.set({ unsubscribers: kept });
  botLog(`removed "${contact.number || contact.name}" from Unsubscribers (sent START)`);
}

async function rememberHandled(id) {
  botHandledIds.add(id);
  const ids = Array.from(botHandledIds).slice(-BOT_HANDLED_MAX);
  botHandledIds = new Set(ids);
  await chrome.storage.local.set({ botHandledIds: ids });
}

/**
 * Answers the newest message in the open chat when it is an incoming one-to-one message nobody has
 * dealt with yet. `preview` is passed when the chat came from the unread list: the unread badge has
 * already shown the newest message is the customer's, so if this WhatsApp build's bubbles cannot be
 * read, the chat-list preview stands in for it. Returns a short note for the console.
 */
async function answerOpenChat(config, unsubscribers, preview = null) {
  const title = openChatTitle();
  if (!title) return `no chat title found. Page has: ${messageProbe()}`;
  let last = lastMessageInOpenChat();
  // Ours at the bottom means someone - the server bot, or a person - has already answered.
  if (last?.incoming === false) return `"${title}": newest message is ours - already answered`;
  if (last?.incoming !== true) {
    if (preview === null) return `"${title}": newest message is not an incoming one`;
    botLog(`"${title}": newest bubble not readable, going by the chat-list preview. Page has: ${messageProbe()}`);
    last = { id: "", incoming: true, chatId: last?.chatId || "", text: preview };
  }
  if (/@(g\.us|broadcast|newsletter)$/.test(last.chatId) || openChatIsGroup(title)) {
    return `"${title}": group, broadcast or channel - ignored`;
  }
  if (last.id && botHandledIds.has(last.id)) return `"${title}": already answered`;
  if (isOwnRecentReply(title, last.text)) return `"${title}": that is the bot's own reply - ignored`;

  const contact = { name: title, number: phoneFromChat(last.chatId, title) };
  const unsubscribed = unsubscribers.some((entry) => SwasBot.isSameContact(entry, contact));
  const action = SwasBot.matchMessage(last.text, config, { unsubscribed, inSession: inBotSession(title) });
  // Recorded before anything is sent: a send that fails half-way must never turn into repeat replies.
  if (last.id) await rememberHandled(last.id);
  if (!action) return `"${title}": no rule matched "${last.text}"${unsubscribed ? " (unsubscribed)" : ""}`;

  if (action.type === "unsubscribe") await addUnsubscriber(contact.number || contact.name);
  if (action.type === "start" && unsubscribed) await removeUnsubscriber(contact);

  if (!botWithinRate(title)) return `"${title}": ${action.label} - too many replies this minute, skipped`;
  if (queryFirst(SELECTORS.messageBox)?.textContent.trim()) {
    return `"${title}": ${action.label} - a reply is being typed by hand, left to you`;
  }
  if (sendBusy || openChatTitle() !== title) return `"${title}": ${action.label} - chat changed before replying`;

  await setMessageText(action.reply);
  await clickSend();
  botRecentReplies.set(`${title}|${action.reply}`, Date.now());
  noteBotAnswer(title, action);
  return `"${title}": replied (${action.label})`;
}

/**
 * A message arriving in the chat that is already open never gets an unread badge, so the open chat
 * is watched on its own. Whatever was in it when it opened is history; only ids that turn up later
 * count as new, so a chat opened by hand never has its old messages answered.
 */
async function watchOpenChat(config, unsubscribers) {
  const title = openChatTitle();
  const ids = title ? openChatIds() : [];
  if (title !== openChatSeen.title || !openChatSeen.known.size) {
    openChatSeen = { title, known: new Set(ids) };
    return;
  }
  const fresh = ids.filter((id) => !openChatSeen.known.has(id));
  fresh.forEach((id) => openChatSeen.known.add(id));
  if (!fresh.length || fresh.length > BOT_MAX_NEW_AT_ONCE) return;

  const last = lastMessageInOpenChat();
  if (!last?.incoming || !fresh.includes(last.id) || !openChatAtNewest(last.node) || !arrivedRecently(last.node)) return;
  botLog(await answerOpenChat(config, unsubscribers));
}

/** Opens an unread chat from the chat list and answers its newest message. */
async function answerFromList(row, name, preview, config, unsubscribers) {
  realClick(queryFirst(SELECTORS.chatTitle, row) || row);
  await sleep(1000);
  await waitForChatHeader(name);
  await waitForChatOpen();
  await waitUntil(() => lastMessageInOpenChat()?.incoming === true, 3000);
  // The customer's next message lands in this now-open chat with no unread badge, so watchOpenChat
  // takes it from here. Its baseline is taken before replying: a quick answer to the reply must be new.
  openChatSeen = { title: openChatTitle(), known: new Set(openChatIds()) };
  return answerOpenChat(config, unsubscribers, preview);
}

// What the bot works from, read once and then kept current by storage.onChanged, so a tick every
// few seconds does not re-read the whole campaign history each time.
const BOT_STORAGE_KEYS = ["botSettings", "botRules", "unsubscribeKeywords", "unsubscribers", "campaigns", "serverBot"];
let botData = null;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !botData) return;
  for (const key of BOT_STORAGE_KEYS) if (key in changes) botData[key] = changes[key].newValue;
});

async function botTick() {
  if (sendBusy || botBusy) return;
  if (!botData) {
    botData = await chrome.storage.local.get([...BOT_STORAGE_KEYS, "botHandledIds"]);
    botHandledIds = new Set(botData.botHandledIds || []);
  }
  const { botSettings, botRules, unsubscribeKeywords, unsubscribers = [], campaigns = [], serverBot } = botData;
  const config = SwasBot.buildConfig(botSettings, botRules, unsubscribeKeywords);
  if (!SwasBot.isActive(config)) return;

  const mode = serverBot?.running && Date.now() - serverBot.checkedAt < BOT_SERVER_FRESH_MS ? "server" : "web";
  if (mode !== botMode) {
    botMode = mode;
    botLog(mode === "server" ? "the server WhatsApp is answering - this tab stays quiet" : "answering from this WhatsApp Web tab");
  }
  if (mode === "server") return;
  if (campaigns.some((c) => c.status === "running")) return;
  if (!queryFirst(SELECTORS.chatList)) return;

  botBusy = true;
  try {
    await watchOpenChat(config, unsubscribers);

    for (const row of document.querySelectorAll(SELECTORS.chatListItem.join(","))) {
      if (!queryFirst(SELECTORS.unreadBadge, row) || isGroupRow(row)) continue;
      const name = rowTitle(row);
      const preview = rowPreview(row);
      const key = `${name}|${preview}`;
      if (!name || Date.now() - (botRowsTried.get(key) || 0) < BOT_ROW_RETRY_MS) continue;
      // Chats that match no rule - or that only an unsubscribed contact's START would - stay unread.
      const contact = { name, number: numberFromTitle(name) };
      const unsubscribed = unsubscribers.some((entry) => SwasBot.isSameContact(entry, contact));
      if (!SwasBot.matchMessage(preview, config, { unsubscribed, inSession: inBotSession(name) })) continue;

      botRowsTried.set(key, Date.now());
      botLog(await answerFromList(row, name, preview, config, unsubscribers));
      return; // one chat per tick
    }
  } finally {
    botBusy = false;
  }
}

function startChatbot() {
  if (!globalThis.SwasBot) {
    console.warn("[Starshift WA Sender] chatbot: common/chatbot.js is not loaded - auto-replies are off in this tab.");
    return;
  }
  botLog("watching for incoming messages");
  (async () => {
    for (;;) {
      // Not setInterval: Chrome runs a hidden tab's own timers about once a minute, which made replies
      // wait a minute. sleep() borrows the service worker's timer while the tab is hidden.
      await sleep(BOT_INTERVAL_MS);
      // After an extension reload this copy is orphaned; the freshly injected one takes over.
      if (!chrome.runtime?.id) return;
      try {
        await botTick();
      } catch (err) {
        if (/Extension context invalidated/.test(err.message)) return;
        console.warn("[Starshift WA Sender] chatbot:", err.message);
      }
    }
  })();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SEND_TO_CONTACT") {
    handleSendToContact(msg.payload)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, reason: err.message || String(err) }));
    return true; // keep the message channel open for the async response
  }
  if (msg.type === "STATUS") {
    sendResponse({ step: currentStep, page: pageStatus() });
    return false;
  }
  if (msg.type === "OPEN_CHAT") {
    if (sendBusy) {
      sendResponse({ success: false, reason: "A campaign is sending right now - try again in a moment." });
      return false;
    }
    openChatByName(msg.name)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, reason: err.message || String(err) }));
    return true;
  }
  if (msg.type === "CANCEL_EXTRACT") {
    extractCancelled = true;
    sendResponse({ success: true });
    return false;
  }
  if (msg.type === "RESOLVE_NUMBERS") {
    resolveChatNumbers(msg.names || [])
      .then((resolved) => sendResponse({ success: true, resolved, cancelled: extractCancelled }))
      .catch((err) => sendResponse({ success: false, reason: err.message || String(err) }));
    return true;
  }
  if (msg.type === "CHAT_MESSAGES") {
    extractChatMessages(msg.names || [], msg.since || null, msg.until || null, !!msg.withImages)
      .then(({ messages, stats }) => sendResponse({ success: true, messages, stats, cancelled: extractCancelled }))
      .catch((err) => sendResponse({ success: false, reason: err.message || String(err) }));
    return true;
  }
  if (msg.type === "GROUP_MEMBERS") {
    extractGroupMembers(msg.name)
      .then((members) => sendResponse({ success: true, members }))
      .catch((err) => sendResponse({ success: false, reason: err.message || String(err) }));
    return true;
  }
  if (msg.type === "SYNC_CHATS") {
    scrapeChats()
      .then((chats) => sendResponse({ success: true, chats }))
      .catch((err) => sendResponse({ success: false, reason: err.message || String(err) }));
    return true;
  }
  return false;
});

mountQuickReplies();
startChatbot();

} // window.__waBulkSenderInjected guard
