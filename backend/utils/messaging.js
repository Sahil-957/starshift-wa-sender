/**
 * Message helpers for the server-side campaign engine. Mirrors the {{placeholder}} rules the
 * extension uses (extension/common/shared.js) so the web app's live preview and the server's
 * actual send stay identical.
 */

/** Turns a column header into a placeholder key: "Order Number" -> "order_number". */
function fieldKey(header) {
  return String(header).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Fills {{placeholders}} from the recipient. Any column works; unknown keys become empty. */
function personalize(template, recipient = {}) {
  const values = {
    ...(recipient.fields || {}),
    name: recipient.name || "",
    custom1: recipient.custom1 || "",
    custom2: recipient.custom2 || "",
  };
  return (template || "").replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => values[fieldKey(key)] ?? "");
}

/** Appends the unsubscribe footer, when enabled, below the message. */
function withFooter(text, footer) {
  if (!footer?.enabled || !footer.text) return text;
  return text ? `${text}\n\n${footer.text}` : footer.text;
}

module.exports = { fieldKey, personalize, withFooter };
