/**
 * Sends the seller a "failed recipients" list over WhatsApp after a bulk run (campaign, sheet batch or
 * broadcast). It goes to the account's own number from its own linked session, and only when something
 * actually failed - a run where everyone got the message sends nothing.
 */
const wa = require("./waSessions");

const MAX_LISTED = 200; // keep the WhatsApp message within a sane length

/** failures: [{ name?, mobile?, reason? }]. No-op when empty or the account isn't linked. */
async function sendFailureReport(mobile, { title, total, failures }) {
  if (!failures || !failures.length) return;
  if (wa.status(mobile).state !== "open") return; // can't message if not linked; skip quietly

  const shown = failures.slice(0, MAX_LISTED);
  const lines = shown.map((f, i) => {
    const who = [f.name, f.mobile].filter(Boolean).join(" · ") || "?";
    return `${i + 1}. ${who}${f.reason ? ` — ${f.reason}` : ""}`;
  });
  const more = failures.length > MAX_LISTED ? `\n…and ${failures.length - MAX_LISTED} more.` : "";
  const sent = Math.max((Number(total) || failures.length) - failures.length, 0);
  const text =
    `⚠️ *${title}*\n` +
    `Total ${total ?? failures.length} · Sent ${sent} · *Failed ${failures.length}*\n\n` +
    `*Failed list:*\n${lines.join("\n")}${more}`;

  try {
    await wa.sendText(mobile, mobile, text); // to the account's own WhatsApp ("message yourself")
  } catch (err) {
    console.warn(`[failure-report ${mobile}]`, err.message || err);
  }
}

module.exports = { sendFailureReport };
