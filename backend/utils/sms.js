/**
 * OTP delivery for the password-reset flow. By default the code is sent over WhatsApp from the seller's
 * own linked account (free, no SMS account needed) - a natural fit for this app. Set SMS_PROVIDER to a real
 * SMS gateway instead if you'd rather text it. With neither available it falls back to logging the code.
 *
 *   SMS_PROVIDER   whatsapp (default) | twilio | (empty = log only in dev)
 *   OTP_WA_MOBILE  the linked account that sends the WhatsApp OTP (defaults to ADMIN_MOBILE / SUPPORT_MOBILE)
 */
async function sendOtp(mobile, otp) {
  const provider = (process.env.SMS_PROVIDER || "whatsapp").toLowerCase();
  const minutes = process.env.OTP_TTL_MINUTES || 5;
  const body = `Starshift WA Sender password reset code: ${otp}\nIt is valid for ${minutes} minutes. Do not share this code with anyone.`;

  if (provider === "whatsapp") {
    const wa = require("./waSessions"); // required lazily to avoid a load-time cycle
    const sender = String(process.env.OTP_WA_MOBILE || process.env.ADMIN_MOBILE || process.env.SUPPORT_MOBILE || "").replace(/\D/g, "");
    if (!sender) throw new Error("Set OTP_WA_MOBILE (or ADMIN_MOBILE) to the linked WhatsApp that sends reset codes.");
    await wa.sendText(sender, mobile, body);
    return;
  }

  // Example Twilio integration (npm install twilio, then uncomment):
  //
  // if (provider === "twilio") {
  //   const twilio = require("twilio")(process.env.SMS_API_KEY, process.env.SMS_API_SECRET);
  //   await twilio.messages.create({ from: process.env.TWILIO_FROM_NUMBER, to: `+${mobile}`, body });
  //   return;
  // }

  if (!process.env.SMS_PROVIDER) {
    console.log(`[DEV] Password reset code for +${mobile}: ${otp} (set SMS_PROVIDER=whatsapp to deliver it)`);
    return;
  }
  throw new Error(`Unknown SMS_PROVIDER "${process.env.SMS_PROVIDER}" - implement it in backend/utils/sms.js`);
}

module.exports = { sendOtp };
