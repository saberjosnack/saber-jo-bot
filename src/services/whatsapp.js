const env = require("../config/env");

// يرجع إعدادات اتصال البوت: من بيانات البوت نفسه (لو محددة بالداشبورد) وإلا من متغيرات البيئة كاحتياط
function resolveConfig(bot) {
  const creds = bot?.waCredentials || {};
  return {
    provider: bot?.waProvider || env.waProvider,
    greenApiInstanceId: creds.greenApiInstanceId || env.greenApiInstanceId,
    greenApiToken: creds.greenApiToken || env.greenApiToken,
    ultramsgInstanceId: creds.ultramsgInstanceId || env.ultramsgInstanceId,
    ultramsgToken: creds.ultramsgToken || env.ultramsgToken,
    wasenderApiKey: creds.wasenderApiKey || env.wasenderApiKey,
    whatsappToken: creds.whatsappToken || env.whatsappToken,
    whatsappPhoneNumberId: creds.whatsappPhoneNumberId || env.whatsappPhoneNumberId,
  };
}

async function sendViaGreenApi(cfg, to, text) {
  const url = `https://api.green-api.com/waInstance${cfg.greenApiInstanceId}/sendMessage/${cfg.greenApiToken}`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: `${to}@c.us`, message: text }),
  });
}

async function sendImageViaGreenApi(cfg, to, imageUrl, caption = "") {
  const url = `https://api.green-api.com/waInstance${cfg.greenApiInstanceId}/sendFileByUrl/${cfg.greenApiToken}`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: `${to}@c.us`, urlFile: imageUrl, fileName: "item.jpg", caption }),
  });
}

async function sendViaUltraMsg(cfg, to, text) {
  const url = `https://api.ultramsg.com/${cfg.ultramsgInstanceId}/messages/chat`;
  const form = new URLSearchParams({ token: cfg.ultramsgToken, to, body: text });
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
}

async function sendImageViaUltraMsg(cfg, to, imageUrl, caption = "") {
  const url = `https://api.ultramsg.com/${cfg.ultramsgInstanceId}/messages/image`;
  const form = new URLSearchParams({ token: cfg.ultramsgToken, to, image: imageUrl, caption });
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
}

async function sendViaWasender(cfg, to, text) {
  const res = await fetch("https://www.wasenderapi.com/api/send-message", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.wasenderApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to, text }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[wasender] فشل الإرسال (${res.status}):`, errBody);
  }
}

async function sendImageViaWasender(cfg, to, imageUrl, caption = "") {
  const res = await fetch("https://www.wasenderapi.com/api/send-message", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.wasenderApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to, imageUrl, text: caption }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[wasender] فشل إرسال الصورة (${res.status}):`, errBody);
  }
}

async function sendViaCloudApi(cfg, to, text) {
  const url = `https://graph.facebook.com/v20.0/${cfg.whatsappPhoneNumberId}/messages`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.whatsappToken}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
  });
}

async function sendImageViaCloudApi(cfg, to, imageUrl, caption = "") {
  const url = `https://graph.facebook.com/v20.0/${cfg.whatsappPhoneNumberId}/messages`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.whatsappToken}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "image", image: { link: imageUrl, caption } }),
  });
}

// يعلّم الرسالة كمقروءة ويظهر مؤشر "يكتب الآن..." — Cloud API بس
async function markReadWithTyping(bot, messageId) {
  const cfg = resolveConfig(bot);
  const url = `https://graph.facebook.com/v20.0/${cfg.whatsappPhoneNumberId}/messages`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.whatsappToken}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    }),
  });
}

// تحميل صورة أرسلها الزبون (Cloud API) — يرجع base64 + نوعها لتمريرها لموديل الرؤية
async function downloadIncomingImage(bot, mediaId) {
  const cfg = resolveConfig(bot);
  const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${cfg.whatsappToken}` },
  });
  const meta = await metaRes.json();

  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${cfg.whatsappToken}` } });
  const buffer = await fileRes.arrayBuffer();

  return { base64: Buffer.from(buffer).toString("base64"), mediaType: meta.mime_type || "image/jpeg" };
}

/**
 * @param {object|null} bot - كائن البوت (فيه waProvider و waCredentials)، أو null لاستخدام إعدادات .env الافتراضية
 */
async function sendText(bot, to, text) {
  const cfg = resolveConfig(bot);
  if (cfg.provider === "cloud") return sendViaCloudApi(cfg, to, text);
  if (cfg.provider === "ultramsg") return sendViaUltraMsg(cfg, to, text);
  if (cfg.provider === "wasender") return sendViaWasender(cfg, to, text);
  return sendViaGreenApi(cfg, to, text);
}

async function sendImage(bot, to, imageUrl, caption = "") {
  const cfg = resolveConfig(bot);
  if (cfg.provider === "cloud") return sendImageViaCloudApi(cfg, to, imageUrl, caption);
  if (cfg.provider === "ultramsg") return sendImageViaUltraMsg(cfg, to, imageUrl, caption);
  if (cfg.provider === "wasender") return sendImageViaWasender(cfg, to, imageUrl, caption);
  return sendImageViaGreenApi(cfg, to, imageUrl, caption);
}

module.exports = { sendText, sendImage, markReadWithTyping, downloadIncomingImage };
