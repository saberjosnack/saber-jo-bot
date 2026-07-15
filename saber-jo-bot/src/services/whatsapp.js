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
  return sendViaGreenApi(to, text);
}

async function sendImage(to, imageUrl, caption = "") {
  if (env.waProvider === "cloud") return sendImageViaCloudApi(to, imageUrl, caption);
  return sendImageViaGreenApi(to, imageUrl, caption);
}

module.exports = { sendText, sendImage };
