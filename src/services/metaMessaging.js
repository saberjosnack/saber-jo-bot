const crypto = require("crypto");
const env = require("../config/env");

// كل الإرسال (ماسنجر وانستجرام) بيمر من نفس Graph API endpoint باستخدام Page Access Token
// المرجع: https://developers.facebook.com/docs/messenger-platform/reference/send-api
async function sendGraphMessage(pageAccessToken, recipientId, text) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
      messaging_type: "RESPONSE",
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[meta] فشل إرسال رسالة (${res.status}):`, errBody);
  }
  return res;
}

async function sendMessengerText(bot, recipientId, text) {
  const token = bot?.metaChannels?.messenger?.pageAccessToken;
  if (!token) {
    console.error(`[meta] ما في Page Access Token مسجل لبوت "${bot?.name}" (ماسنجر) — ما قدرت أرسل الرد.`);
    return;
  }
  return sendGraphMessage(token, recipientId, text);
}

async function sendInstagramText(bot, recipientId, text) {
  const token = bot?.metaChannels?.instagram?.pageAccessToken;
  if (!token) {
    console.error(`[meta] ما في Access Token مسجل لبوت "${bot?.name}" (انستجرام) — ما قدرت أرسل الرد.`);
    return;
  }
  return sendGraphMessage(token, recipientId, text);
}

// بيتحقق إن الطلب فعلاً جاي من ميتا (مو مزوّر) عن طريق توقيع HMAC السري
// https://developers.facebook.com/docs/messenger-platform/webhooks#security
function verifySignature(rawBody, signatureHeader) {
  if (!env.metaAppSecret) {
    console.warn("[meta] META_APP_SECRET مش محدد — ما بنقدر نتحقق من توقيع الرسايل الواردة (غير آمن على المدى الطويل).");
    return true; // ما منعطل الاستقبال، بس منحذر بالسجل
  }
  if (!signatureHeader) return false;

  const expected = "sha256=" + crypto.createHmac("sha256", env.metaAppSecret).update(rawBody).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false; // اختلاف بالطول يعني توقيع غلط
  }
}

module.exports = { sendMessengerText, sendInstagramText, verifySignature };
