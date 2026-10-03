/**
 * Pluggable OTP delivery. By default it just logs the OTP to the console
 * so you can develop without an SMS account. Swap in a real provider
 * (Twilio, MSG91, 2Factor, etc.) before going to production.
 */
async function sendOtp(mobile, otp) {
  const provider = process.env.SMS_PROVIDER;

  if (!provider) {
    console.log(`[DEV] Starshift WA Sender code for +${mobile}: ${otp} (set SMS_PROVIDER in .env to send it for real)`);
    return;
  }

  // Example Twilio integration (npm install twilio, then uncomment):
  //
  // if (provider === "twilio") {
  //   const twilio = require("twilio")(process.env.SMS_API_KEY, process.env.SMS_API_SECRET);
  //   await twilio.messages.create({
  //     from: process.env.TWILIO_FROM_NUMBER,
  //     to: `+${mobile}`,
  //     body: `Your Starshift WA Sender code is ${otp}`,
  //   });
  //   return;
  // }

  throw new Error(`Unknown SMS_PROVIDER "${provider}" - implement it in backend/utils/sms.js`);
}

module.exports = { sendOtp };
