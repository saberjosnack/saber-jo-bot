const express = require("express");
const env = require("../config/env");
const botStore = require("../services/botStore");
const { handleIncomingMessage } = require("../services/messageHandler");
const whatsapp = require("../services/whatsapp");

const router = express.Router();

// ---------- Meta: تأكيد الـ Webhook (مطلوب فقط لو WA_PROVIDER=cloud) ----------
router.get(["/", "/:botId"], (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === env.whatsappVerifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------- استقبال رسائل الزباين ----------
// المسار "/" بيروح تلقائياً لبوت "default" (توافق مع الإعداد الحالي).
// المسار "/:botId" لأي بوت تاني، لو بدك كل بوت يربط رقمه الخاص بـ webhook مستقل.
router.post(["/", "/:botId"], async (req, res) => {
  res.sendStatus(200); // نرد على المنصة فوراً، والمعالجة تصير بالخلفية

  const botId = req.params.botId || "default";
  const bot = botStore.getBot(botId);

  if (!bot) {
    console.error(`[webhook] رسالة وصلت لبوت غير موجود: ${botId}`);
    return;
  }

  const provider = bot.waProvider || env.waProvider;
  console.log(`[webhook] رسالة وصلت للبوت "${bot.name}"، المزود:`, provider);

  try {
    const { from, text } = extractIncomingMessage(req.body, provider);

    if (!from || !text) return;

    await handleIncomingMessage(bot.id, from, text, null, (to, t) => whatsapp.sendText(bot, to, t));
    console.log(`[webhook] تمت معالجة رسالة البوت "${bot.name}" بنجاح.`);
  } catch (err) {
    console.error("خطأ بمعالجة رسالة واردة:", err);
  }
});

// يفصل بنية الرسالة حسب المزود عن باقي منطق الويب هوك
function extractIncomingMessage(body, provider) {
  if (provider === "cloud") {
    const entry = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    return { from: entry?.from, text: entry?.text?.body };
  }

  if (provider === "ultramsg") {
    const data = body?.data;
    if (!data || data.fromMe) return { from: null, text: null };
    return { from: data.from?.replace("@c.us", ""), text: data.body };
  }

  if (provider === "wasender") {
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
