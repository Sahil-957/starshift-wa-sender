const TTL_MS = (parseInt(process.env.OTP_TTL_MINUTES, 10) || 5) * 60 * 1000;

const otps = new Map(); // mobile -> { otp, expiresAt, attempts }

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function issue(mobile) {
  const otp = generateOtp();
  otps.set(mobile, { otp, expiresAt: Date.now() + TTL_MS, attempts: 0 });
  return otp;
}

function verify(mobile, otp) {
  const record = otps.get(mobile);
  if (!record) return { ok: false, message: "No OTP requested for this number." };
  if (Date.now() > record.expiresAt) {
    otps.delete(mobile);
    return { ok: false, message: "OTP expired, please request a new one." };
  }
  record.attempts += 1;
  if (record.attempts > 5) {
    otps.delete(mobile);
    return { ok: false, message: "Too many attempts, please request a new OTP." };
  }
  if (record.otp !== otp) {
    return { ok: false, message: "Incorrect OTP." };
  }
  otps.delete(mobile);
  return { ok: true };
}

module.exports = { issue, verify };
