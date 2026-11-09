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
  const additionalNodes = [{
    tag: "biz",
    attrs: {},
    content: [{ tag: "interactive", attrs: { type: "native_flow", v: "1" }, content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }] }],
  }];
  if (!isJidGroup(jid)) additionalNodes.push({ tag: "bot", attrs: { biz_bot: "1" } });
  await sock.relayMessage(jid, message.message, { messageId: message.key.id, additionalNodes });
  return message;
}

async function sendChoices(sock, jid, text, choices = [], urlButton = null, callButton = null) {
  const userJid = sock.authState?.creds?.me?.id || sock.user?.id;
  const messageId = generateMessageIDV2(userJid);
  const message = generateWAMessageFromContent(jid, {
    interactiveMessage: {
      body: { text: String(text || "Choose an option") },
      nativeFlowMessage: {
        messageVersion: 1,
        buttons: [
          ...choices.slice(0, Math.max(0, 3 - (urlButton ? 1 : 0) - (callButton ? 1 : 0))).map(({ id, title }) => quickReply(title, id)),
          ...(callButton?.phoneNumber ? [{
            name: "cta_call",
            buttonParamsJson: JSON.stringify({ display_text: callButton.title || "Call", phone_number: callButton.phoneNumber }),
          }] : []),
          ...(urlButton?.url ? [{
            name: "cta_url",
            buttonParamsJson: JSON.stringify({ display_text: urlButton.title || "Click here", url: urlButton.url }),
          }] : []),
        ],
      },
    },
  }, { logger: sock.logger, userJid, messageId });
  const additionalNodes = [{
    tag: "biz", attrs: {},
    content: [{ tag: "interactive", attrs: { type: "native_flow", v: "1" }, content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }] }],
  }];
  if (!isJidGroup(jid)) additionalNodes.push({ tag: "bot", attrs: { biz_bot: "1" } });
  await sock.relayMessage(jid, message.message, { messageId: message.key.id, additionalNodes });
  return message;
}

module.exports = { sendMenu, sendChoices };
