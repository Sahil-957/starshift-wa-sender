/**
 * Helpers shared by the dashboard page (<script> tag) and the background
 * service worker (importScripts).
 */

/** Turns a column header into a placeholder key: "Order Number" -> "order_number". */
function fieldKey(header) {
  return String(header).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/** Fills {{placeholders}} from the recipient. Any Excel/Sheet column works; unknown keys become empty. */
function personalize(template, recipient) {
  const values = {
    ...(recipient.fields || {}),
    name: recipient.name || "",
    custom1: recipient.custom1 || "",
    custom2: recipient.custom2 || "",
  };
  return (template || "").replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => values[fieldKey(key)] ?? "");
}

/** Appends the campaign's unsubscribe footer, when enabled, below the message. */
function withFooter(text, footer) {
  if (!footer?.enabled || !footer.text) return text;
  return text ? `${text}\n\n${footer.text}` : footer.text;
}

const NUMBER_LIKE = /^[\d\s+()-]+$/;

/**
 * Unsubscriber entries are phone numbers (with or without country code) or
 * chat/group names, typed on the Unsubscribers page or added by the chatbot.
 */
function isUnsubscribed(recipient, unsubscribers) {
  const name = (recipient.name || "").trim();
  const mobile = digitsOnly(recipient.mobile) || (NUMBER_LIKE.test(name) ? digitsOnly(name) : "");
  return (unsubscribers || []).some((entry) => {
    if (!NUMBER_LIKE.test(entry)) return entry.trim().toLowerCase() === name.toLowerCase();
    const entryDigits = digitsOnly(entry);
    if (!mobile || entryDigits.length < 7) return false;
    const [shorter, longer] = mobile.length <= entryDigits.length ? [mobile, entryDigits] : [entryDigits, mobile];
    // Match "8873520027" against "918873520027", but never on short fragments.
    return shorter.length >= 10 ? longer.endsWith(shorter) : mobile === entryDigits;
  });
}
