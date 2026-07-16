const env = require("../config/env");

async function sendViaGreenApi(to, text) {
  const url = `https://api.green-api.com/waInstance${env.greenApiInstanceId}/sendMessage/${env.greenApiToken}`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: `${to}@c.us`, message: text }),
  });
}

async function sendImageViaGreenApi(to, imageUrl, caption = "") {
  const url = `https://api.green-api.com/waInstance${env.greenApiInstanceId}/sendFileByUrl/${env.greenApiToken}`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: `${to}@c.us`, urlFile: imageUrl, fileName: "item.jpg", caption }),
  });
}

async function sendViaUltraMsg(to, text) {
  const url = `https://api.ultramsg.com/${env.ultramsgInstanceId}/messages/chat`;
  const form = new URLSearchParams({ token: env.ultramsgToken, to, body: text });
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
}

async function sendImageViaUltraMsg(to, imageUrl, caption = "") {
  const url = `https://api.ultramsg.com/${env.ultramsgInstanceId}/messages/image`;
  const form = new URLSearchParams({ token: env.ultramsgToken, to, image: imageUrl, caption });
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
}

async function sendViaWasender(to, text) {
  const res = await fetch("https://www.wasenderapi.com/api/send-message", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.wasenderApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to, text }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[wasender] فشل الإرسال (${res.status}):`, errBody);
  }
}

async function sendImageViaWasender(to, imageUrl, caption = "") {
  await fetch("https://www.wasenderapi.com/api/send-message", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.wasenderApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to, imageUrl, text: caption }),
  });
}

async function sendViaCloudApi(to, text) {
  const url = `https://graph.facebook.com/v20.0/${env.whatsappPhoneNumberId}/messages`;
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.whatsappToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
}

// يعلّم الرسالة كمقروءة ويظهر مؤشر "يكتب الآن..." — يخلي التفاعل طبيعي متل موظف حقيقي
async function markReadWithTyping(messageId) {
  const url = `https://graph.facebook.com/v20.0/${env.whatsappPhoneNumberId}/messages`;
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.whatsappToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    }),
  });
}

// تحميل صورة أرسلها الزبون (لازم Cloud API) — يرجع base64 + نوعها لتمريرها لموديل الرؤية
async function downloadIncomingImage(mediaId) {
  const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${env.whatsappToken}` },
  });
  const meta = await metaRes.json();

  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${env.whatsappToken}` },
  });
  const buffer = await fileRes.arrayBuffer();

  return {
    base64: Buffer.from(buffer).toString("base64"),
    mediaType: meta.mime_type || "image/jpeg",
  };
}

async function sendImageViaCloudApi(to, imageUrl, caption = "") {
  const url = `https://graph.facebook.com/v20.0/${env.whatsappPhoneNumberId}/messages`;
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.whatsappToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { link: imageUrl, caption },
    }),
  });
}

async function sendText(to, text) {
  if (env.waProvider === "cloud") return sendViaCloudApi(to, text);
  if (env.waProvider === "ultramsg") return sendViaUltraMsg(to, text);
  if (env.waProvider === "wasender") return sendViaWasender(to, text);
  return sendViaGreenApi(to, text);
}

async function sendImage(to, imageUrl, caption = "") {
  if (env.waProvider === "cloud") return sendImageViaCloudApi(to, imageUrl, caption);
  if (env.waProvider === "ultramsg") return sendImageViaUltraMsg(to, imageUrl, caption);
  if (env.waProvider === "wasender") return sendImageViaWasender(to, imageUrl, caption);
  return sendImageViaGreenApi(to, imageUrl, caption);
}

module.exports = { sendText, sendImage, markReadWithTyping, downloadIncomingImage };
