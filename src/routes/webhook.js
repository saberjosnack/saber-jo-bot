const express = require("express");
const env = require("../config/env");
const { handleIncomingMessage } = require("../services/messageHandler");
const whatsapp = require("../services/whatsapp");

const router = express.Router();

// ---------- Meta: تأكيد الـ Webhook (مطلوب فقط لو WA_PROVIDER=cloud) ----------
router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === env.whatsappVerifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------- استقبال رسائل الزباين ----------
router.post("/", async (req, res) => {
  res.sendStatus(200); // نرد على المنصة فوراً، والمعالجة تصير بالخلفية

  try {
    const { from, text } = extractIncomingMessage(req.body);
    // ملاحظة: مزودي Green/UltraMsg/Cloud هون معدّين لبوت واحد بس ("default").
    // تعدد البوتات بالوقت الحالي مفعّل بالكامل بس مع WA_PROVIDER=selfhosted.
    await handleIncomingMessage("default", from, text, null, whatsapp.sendText);
  } catch (err) {
    console.error("خطأ بمعالجة رسالة واردة:", err);
  }
});

// يفصل بنية الرسالة حسب المزود (Green API أو Meta Cloud API) عن باقي منطق الويب هوك
function extractIncomingMessage(body) {
  if (env.waProvider === "cloud") {
    const entry = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    return {
      from: entry?.from,
      text: entry?.text?.body,
    };
  }

  if (env.waProvider === "ultramsg") {
    const data = body?.data;
    // نتجاهل رسائلنا يلي بعتناها إحنا (fromMe) عشان ما يرد البوت على نفسه
    if (!data || data.fromMe) return { from: null, text: null };
    return {
      from: data.from?.replace("@c.us", ""),
      text: data.body,
    };
  }

  if (env.waProvider === "wasender") {
    if (body?.event !== "messages.received") return { from: null, text: null };
    const msg = body?.data?.messages;
    if (!msg || msg.key?.fromMe) return { from: null, text: null };
    return {
      from: msg.key?.cleanedSenderPn || msg.key?.remoteJid?.replace(/@.*/, ""),
      text: msg.messageBody,
    };
  }

  // Green API
  const messageData = body?.messageData;
  return {
    from: body?.senderData?.chatId?.replace("@c.us", ""),
    text: messageData?.textMessageData?.textMessage,
  };
}

module.exports = router;
