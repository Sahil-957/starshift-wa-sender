/** Quick-reply chatbot controls: one tap sends the selected reply immediately. */
const {
  generateWAMessageFromContent,
  generateMessageIDV2,
  isJidGroup,
} = require("@whiskeysockets/baileys");

const OPTIONS = {
  en: [
    ["1", "🎁 Free Demo"],
    ["2", "🚀 Features"],
    ["3", "⚙️ How it works"],
    ["4", "💰 Pricing"],
    ["5", "🔎 Contact"],
    ["6", "🛑 Stop messages"],
  ],
  mr: [
    ["1", "🎁 मोफत डेमो"],
    ["2", "🚀 वैशिष्ट्ये"],
    ["3", "⚙️ कसे वापरावे"],
    ["4", "💰 किंमत व योजना"],
    ["5", "🔎 संपर्क"],
    ["6", "🛑 संदेश बंद"],
  ],
};

function quickReply(displayText, id) {
  return {
    name: "quick_reply",
    buttonParamsJson: JSON.stringify({ display_text: displayText, id }),
  };
}

function buttonsFor({ language, lang, page, optionLabels }) {
  if (language) {
    return [quickReply("मराठी", "swas_lang_1"), quickReply("English", "swas_lang_2")];
  }
  const options = OPTIONS[lang === "en" ? "en" : "mr"].map(([id, fallback], index) => [id, optionLabels?.[index] || fallback]);
  const choice = (index) => quickReply(options[index][1], `swas_menu_${options[index][0]}`);
  if (page === 1) return [choice(0), choice(1), quickReply(lang === "en" ? "More options" : "पुढील पर्याय", "swas_page_2")];
  if (page === 2) return [choice(2), choice(3), quickReply(lang === "en" ? "More options" : "पुढील पर्याय", "swas_page_3")];
  return [choice(4), choice(5), quickReply(lang === "en" ? "Back" : "मागे", "swas_page_2")];
}

async function sendMenu(sock, jid, text, { language = false, lang = "mr", page = 1, optionLabels = [] } = {}) {
  const userJid = sock.authState?.creds?.me?.id || sock.user?.id;
  const messageId = generateMessageIDV2(userJid);
  const message = generateWAMessageFromContent(
    jid,
    {
      interactiveMessage: {
        body: { text: String(text || "Choose an option / पर्याय निवडा") },
        nativeFlowMessage: {
          messageVersion: 1,
          buttons: buttonsFor({ language, lang, page, optionLabels }),
        },
      },
    },
    { logger: sock.logger, userJid, messageId },
  );
  await sock.relayMessage(jid, message.message, { messageId: message.key.id, additionalNodes: BUTTON_NODES });
  return message;
}

// Only the "biz" native_flow node. Since 2026-11-16 WhatsApp silently drops button messages that also
// carry the old <bot biz_bot="1"> node (no error ack, not even shown on the sender's own phone).
const BUTTON_NODES = [{
  tag: "biz",
  attrs: {},
  content: [{ tag: "interactive", attrs: { type: "native_flow", v: "1" }, content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }] }],
}];

/**
 * urlButton: one link button or an array of them (e.g. Location + Website). callButton: a real Call button.
 * Reply buttons and link/call buttons in one message fail to load on WhatsApp Web, so when both are
 * present the text goes with its reply buttons first, then the link/call buttons in a second message.
 */
async function sendChoices(sock, jid, text, choices = [], urlButton = null, callButton = null, { together = false } = {}) {
  const urlButtons = (Array.isArray(urlButton) ? urlButton : [urlButton]).filter((button) => button?.url);
  const call = callButton?.phoneNumber ? callButton : null;
  const replyChoices = choices.filter((choice) => choice?.id);
  if (!together && replyChoices.length && (urlButtons.length || call)) {
    const first = await sendChoices(sock, jid, text, replyChoices, null, null);
    const label = [call, ...urlButtons].map((button) => String(button.title || "").trim()).filter(Boolean).join("  |  ");
    await sendChoices(sock, jid, label || "Contact", [], urlButtons, call);
    return first;
  }
  const userJid = sock.authState?.creds?.me?.id || sock.user?.id;
  const messageId = generateMessageIDV2(userJid);
  const interactiveMessage = {
      body: { text: String(text || "Choose an option") },
      nativeFlowMessage: {
        messageVersion: 1,
        buttons: [
          ...replyChoices.slice(0, 3).map(({ id, title }) => quickReply(title, id)),
          ...(call ? [{
            name: "cta_call",
            buttonParamsJson: JSON.stringify({ display_text: call.title || "Call", phone_number: call.phoneNumber }),
          }] : []),
          ...urlButtons.map((button) => ({
            name: "cta_url",
            buttonParamsJson: JSON.stringify({ display_text: button.title || "Click here", url: button.url }),
          })),
        ],
      },
  };
  const message = generateWAMessageFromContent(jid, { interactiveMessage }, { logger: sock.logger, userJid, messageId });
  await sock.relayMessage(jid, message.message, { messageId: message.key.id, additionalNodes: BUTTON_NODES });
  console.log(`[buttons] sent ${message.key.id} to ${jid} (${replyChoices.length} reply${call ? " + call" : ""}${urlButtons.length ? ` + ${urlButtons.length} link` : ""})`);
  return message;
}

module.exports = { sendMenu, sendChoices };
