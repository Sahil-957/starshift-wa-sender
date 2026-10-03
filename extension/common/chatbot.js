/**
 * Chatbot keyword matching and the default Starshift menu. Loaded by the WhatsApp Web content
 * script (which sends the replies) and by the dashboard (which edits and tests the rules), so both
 * always agree on what a message matches.
 *
 * Assigned to globalThis rather than declared: background.js can inject the content scripts into a
 * tab a second time, and a redeclared const would throw.
 */
globalThis.SwasBot = (() => {
  const WELCOME_MESSAGE = `👋 नमस्कार!

Starshift WA Sender मध्ये आपले स्वागत आहे. 🚀

तुमच्या Business साठी WhatsApp Marketing अधिक सोपं आणि Smart करा.

कृपया खालील पर्यायांपैकी 1 ते 6 पैकी नंबर पाठवा 👇

🎁 1️⃣ Free Demo
🚀 2️⃣ Features
⚙️ 3️⃣ How It Works
💰 4️⃣ Pricing
📞 5️⃣ Contact Us
🛑 6️⃣ STOP`;

  const UNSUBSCRIBE_REPLY = `🛑 तुम्हाला पुढे promotional messages मिळणार नाहीत.

तुम्हाला पुन्हा माहिती हवी असल्यास "START" किंवा "HI" पाठवा.`;

  // What older versions saved as the STOP reply; treated as "never customised" so the new one shows.
  const LEGACY_UNSUBSCRIBE_REPLY = "You have been unsubscribed and won't receive further messages.";

  // Sent on a START keyword when the welcome message has been cleared.
  const RESUBSCRIBED_REPLY = "✅ Welcome back! तुम्हाला पुन्हा messages मिळतील.";

  const DEFAULT_RULES = [
    {
      id: "swas-menu-demo",
      keyword: "1, demo, free demo",
      match: "exact",
      enabled: true,
      reply: `🎯 Free Demo साठी धन्यवाद!

Starshift WA Sender चा Live Demo पाहण्यासाठी आमच्याशी संपर्क करा.

📲 +91 70280 80364

Starshift WA Sender
Simple • Powerful • Affordable`,
    },
    {
      id: "swas-menu-features",
      keyword: "2, features, feature",
      match: "contains",
      enabled: true,
      reply: `🚀 Starshift WA Sender – Features

✅ Bulk WhatsApp Messages
✅ Excel / CSV / Google Sheets
✅ {{name}} ने Personalized Messages
✅ Photo / PDF / Video / Voice
✅ Auto Scheduling
✅ Detailed Reports
🤖 Chatbot & Auto Replies
🛑 STOP / Unsubscribe Handling
🌐 मराठी, हिंदी, इंग्रजी सहित 15+ भाषा

👉 Free Demo साठी 1 पाठवा.`,
    },
    {
      id: "swas-menu-how",
      keyword: "3, how it works",
      match: "contains",
      enabled: true,
      reply: `⚙️ How It Works?

1️⃣ Chrome Extension Install करा
2️⃣ WhatsApp Web Login करा
3️⃣ Excel / Contacts Import करा
4️⃣ Message तयार करा
5️⃣ Photo / PDF / Voice जोडून द्या
6️⃣ Schedule किंवा Send करा
7️⃣ Reports मध्ये Result पाहा

सोपं, जलद आणि Smart WhatsApp Marketing! 🚀`,
    },
    {
      id: "swas-menu-pricing",
      keyword: "4, price, pricing",
      match: "contains",
      enabled: true,
      reply: `💰 Starshift WA Sender Plans

⭐ ₹1,999 – One-Time Payment
Lifetime वापरासाठी एकदाच पेमेंट

📅 ₹99 / Month
सतत वापरासाठी परवडणारा Plan

👉 Free Demo साठी 1 पाठवा.`,
    },
    {
      id: "swas-menu-contact",
      keyword: "5, contact, contact us",
      match: "contains",
      enabled: true,
      reply: `📞 Contact Us

Starshift WA Sender बद्दल अधिक माहिती, Demo किंवा खरेदीसाठी संपर्क करा.

📲 WhatsApp:
+91 70280 80364

Starshift WA Sender
Your Business Growth Partner 🚀`,
    },
  ];

  // Who the bot keeps answering, and how fast. A customer who got a real answer (welcome, a rule)
  // in the last 24 hours gets a reply to every message, whatever they send; no contact gets more
  // than a few replies a minute, so two auto-repliers can never answer each other forever.
  const LIMITS = { sessionMs: 24 * 60 * 60 * 1000, repliesPerMinute: 6 };

  const DEFAULT_SETTINGS = {
    enabled: false,
    autoUnsubscribe: true,
    welcomeKeywords: "hi, hello, hii, namaskar, नमस्कार",
    welcomeMessage: WELCOME_MESSAGE,
    fallbackEnabled: true,
    fallbackMessage: "❌ माफ करा, हा पर्याय उपलब्ध नाही.",
    stopKeywords: "6, stop, unsubscribe",
    startKeywords: "start, hi",
    unsubscribeReply: UNSUBSCRIBE_REPLY,
    // After this many minutes of silence, a returning customer's next message gets the welcome menu
    // again (a fresh conversation). 0 turns it off.
    rewelcomeMinutes: 0,
    // Ask the customer to pick a language first (1 Marathi / 2 English); replies then use that language.
    bilingual: false,
    languageMenu: `कृपया भाषा निवडा / Please choose your language 👇

1️⃣ मराठी
2️⃣ English`,
    welcomeMessageEn: `👋 Welcome to Starshift WA Sender! 🚀

Make WhatsApp marketing for your business simple and smart.

Please send a number from 1 to 6 👇

🎁 1️⃣ Free Demo
🚀 2️⃣ Features
⚙️ 3️⃣ How It Works
💰 4️⃣ Pricing
📞 5️⃣ Contact Us
🛑 6️⃣ STOP`,
    fallbackMessageEn: "❌ Sorry, that option isn't available.",
    unsubscribeReplyEn: `🛑 You won't receive promotional messages anymore.

Send "START" or "HI" to get updates again.`,
  };

  /**
   * Lower-case words separated by single spaces. Punctuation and emoji go, so "Hi!!" and "Hi 👋"
   * read as "hi"; a keycap "1️⃣" and a Devanagari "१" both read as "1".
   */
  function normalize(text) {
    return String(text ?? "")
      .replace(/[०-९]/g, (digit) => String(digit.charCodeAt(0) - 0x0966))
      .replace(/[️⃣‌‍]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
      .trim();
  }

  /** "price, pricing" (or an array) -> ["price", "pricing"]. */
  function keywordList(value) {
    const parts = Array.isArray(value) ? value : String(value ?? "").split(/[,\n]/);
    return parts.map(normalize).filter(Boolean);
  }

  /**
   * "contains" matches whole words, so "hi" never fires on "this" or "shipping". A number keyword
   * is a menu option and must be the whole message, so "I have 2 shops" is not option 2.
   */
  function keywordMatches(message, keyword, match) {
    if (match === "exact" || /^\d+$/.test(keyword)) return message === keyword;
    return ` ${message} `.includes(` ${keyword} `);
  }

  function resolveSettings(saved = {}) {
    const settings = { ...DEFAULT_SETTINGS, ...saved };
    if (!settings.unsubscribeReply || settings.unsubscribeReply === LEGACY_UNSUBSCRIBE_REPLY) {
      settings.unsubscribeReply = UNSUBSCRIBE_REPLY;
    }
    return settings;
  }

  /**
   * Everything matchMessage needs. Keywords from campaign unsubscribe footers are always honoured,
   * even with the chatbot off; everything else needs the chatbot on.
   */
  function buildConfig(savedSettings, rules, footerKeywords) {
    const settings = resolveSettings(savedSettings);
    const on = !!settings.enabled;
    const stopKeywords = keywordList(footerKeywords);
    if (on && settings.autoUnsubscribe) stopKeywords.push(...keywordList(settings.stopKeywords));
    return {
      enabled: on,
      rules: on ? (rules || []).filter((rule) => rule.enabled !== false && rule.reply) : [],
      stopKeywords,
      startKeywords: on ? keywordList(settings.startKeywords) : [],
      welcomeKeywords: on ? keywordList(settings.welcomeKeywords) : [],
      welcomeMessage: String(settings.welcomeMessage || "").trim(),
      fallbackEnabled: on && !!settings.fallbackEnabled,
      fallbackMessage: String(settings.fallbackMessage || "").trim(),
      unsubscribeReply: settings.unsubscribeReply,
      rewelcomeMs: on ? (Number(settings.rewelcomeMinutes) || 0) * 60000 : 0,
      bilingual: on && !!settings.bilingual,
      languageMenu: String(settings.languageMenu || "").trim(),
      welcomeMessageEn: String(settings.welcomeMessageEn || "").trim(),
      fallbackMessageEn: String(settings.fallbackMessageEn || "").trim(),
      unsubscribeReplyEn: settings.unsubscribeReplyEn || settings.unsubscribeReply,
    };
  }

  function isActive(config) {
    return config.enabled || config.stopKeywords.length > 0;
  }

  /**
   * What to do with an incoming message, or null to leave it alone. In order: STOP, START, the
   * keyword rules top to bottom, the welcome greeting, then - only for a customer already talking
   * to the bot (`inSession`) - the menu again for anything else, a sticker or photo included. An
   * unsubscribed contact only gets an answer to START.
   * Returns { type: "unsubscribe" | "start" | "rule" | "welcome" | "fallback", label, reply, rule? }.
   */
  function matchMessage(text, config, { unsubscribed = false, inSession = false, idleMs = null, lang = "" } = {}) {
    const message = normalize(text);
    // A returning customer who has been silent longer than rewelcomeMs is greeted fresh.
    const afterGap = config.rewelcomeMs > 0 && idleMs != null && idleMs >= config.rewelcomeMs;
    const bi = config.bilingual;
    // Pick the Marathi or English version, falling back to Marathi when an English one isn't set.
    const L = (mr, en) => (lang === "en" ? en || mr : mr);
    const welcome = L(config.welcomeMessage, config.welcomeMessageEn);
    const greeted = (m) => config.welcomeKeywords.some((keyword) => keywordMatches(m, keyword, "contains"));
    const fallback =
      inSession && !unsubscribed && config.fallbackEnabled && welcome
        ? {
            type: "fallback",
            label: "Wrong option - menu sent again",
            reply: [L(config.fallbackMessage, config.fallbackMessageEn), welcome].filter(Boolean).join("\n\n"),
          }
        : null;
    if (!message) return fallback;

    if (config.stopKeywords.includes(message)) {
      return unsubscribed ? null : { type: "unsubscribe", label: "STOP / Unsubscribe", reply: L(config.unsubscribeReply, config.unsubscribeReplyEn) };
    }

    // Bilingual: until a language is chosen, only 1/2 (language pick) and the language menu happen.
    if (bi && !lang) {
      if (message === "1") return { type: "welcome", setLang: "mr", label: "Language chosen: Marathi", reply: config.welcomeMessage };
      if (message === "2") return { type: "welcome", setLang: "en", label: "Language chosen: English", reply: config.welcomeMessageEn || config.welcomeMessage };
      if (unsubscribed) return null;
      if (config.languageMenu && (afterGap || inSession || greeted(message) || config.startKeywords.includes(message))) {
        return { type: "langmenu", label: "Language menu", reply: config.languageMenu };
      }
      return fallback;
    }

    if (config.startKeywords.includes(message)) {
      return {
        type: "start",
        label: unsubscribed ? "START - re-subscribes this contact" : "START / welcome menu",
        reply: welcome || RESUBSCRIBED_REPLY,
      };
    }
    if (unsubscribed) return null;

    for (const rule of config.rules) {
      if (keywordList(rule.keyword).some((keyword) => keywordMatches(message, keyword, rule.match))) {
        return { type: "rule", label: `Rule "${rule.keyword}"`, reply: L(rule.reply, rule.replyEn), rule };
      }
    }
    if (welcome && (afterGap || greeted(message))) {
      return { type: "welcome", label: afterGap ? "Welcome menu (after a gap)" : "Welcome menu", reply: welcome };
    }
    return fallback;
  }

  const NUMBER_LIKE = /^[\d\s+()-]+$/;

  /**
   * Whether an Unsubscribers entry (a number or a chat name) is this contact. Same rule as
   * isUnsubscribed in shared.js, per entry, so START can remove exactly the matching entries.
   */
  function isSameContact(entry, { name = "", number = "" }) {
    const value = String(entry ?? "").trim();
    if (!NUMBER_LIKE.test(value)) return value.toLowerCase() === String(name).trim().toLowerCase();
    const entryDigits = value.replace(/\D/g, "");
    const mobile = String(number || (NUMBER_LIKE.test(name) ? name : "")).replace(/\D/g, "");
    if (!mobile || entryDigits.length < 7) return false;
    const [shorter, longer] = mobile.length <= entryDigits.length ? [mobile, entryDigits] : [entryDigits, mobile];
    return shorter.length >= 10 ? longer.endsWith(shorter) : mobile === entryDigits;
  }

  return {
    LIMITS,
    DEFAULT_RULES,
    DEFAULT_SETTINGS,
    normalize,
    keywordList,
    resolveSettings,
    buildConfig,
    isActive,
    matchMessage,
    isSameContact,
  };
})();
