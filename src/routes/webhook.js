const express = require("express");
const env = require("../config/env");
const botStore = require("../services/botStore");
const { queueIncomingMessage } = require("../services/messageHandler");
const whatsapp = require("../services/whatsapp");
const { transcribeAudio } = require("../services/speechToText");

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
    const parsed = extractIncomingMessage(req.body, provider);
    if (!parsed.from) return;

    let text = parsed.text || "";
    let image = null;

    // تحميل الوسائط (صورة/صوت) مدعوم حالياً بس عن طريق Cloud API الرسمي — باقي المزودين نص بس.
    if (provider === "cloud" && parsed.mediaId) {
      if (parsed.mediaKind === "image") {
        try {
          image = await whatsapp.downloadIncomingImage(bot, parsed.mediaId);
        } catch (err) {
          console.error("[webhook] فشل تحميل الصورة:", err.message);
        }
      } else if (parsed.mediaKind === "audio") {
        try {
          const { buffer } = await whatsapp.downloadIncomingMedia(bot, parsed.mediaId);
          const transcribed = await transcribeAudio(buffer, "voice.ogg");
          if (transcribed) {
            text = text ? `${text}\n${transcribed}` : transcribed;
          } else {
            await whatsapp.sendText(bot, parsed.from, "سمعت إنك بعتلي رسالة صوتية، بس ما قدرت أسمعها منيح 🙏 ممكن تكتبلي طلبك؟");
            return;
          }
        } catch (err) {
          console.error("[webhook] فشل تحميل/تحويل الرسالة الصوتية:", err.message);
          return;
        }
      }
    }

    if (!text && !image) return;

    // مؤشر "يكتب الآن..." مدعوم بس عن طريق Cloud API الرسمي (لازم معرف الرسالة الواردة)
    const onTypingStart =
      provider === "cloud" && parsed.messageId ? () => whatsapp.markReadWithTyping(bot, parsed.messageId) : undefined;

    queueIncomingMessage(bot.id, parsed.from, text, image, (to, t) => whatsapp.sendText(bot, to, t), onTypingStart);
    console.log(`[webhook] أضفت رسالة البوت "${bot.name}" لطابور التجميع.`);
  } catch (err) {
    console.error("خطأ بمعالجة رسالة واردة:", err);
  }
});

// يفصل بنية الرسالة حسب المزود عن باقي منطق الويب هوك
function extractIncomingMessage(body, provider) {
  if (provider === "cloud") {
    const entry = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!entry) return { from: null, text: null };

    if (entry.type === "image" && entry.image?.id) {
      return { from: entry.from, text: entry.image.caption || "", mediaId: entry.image.id, mediaKind: "image", messageId: entry.id };
    }
    if (entry.type === "audio" && entry.audio?.id) {
      return { from: entry.from, text: "", mediaId: entry.audio.id, mediaKind: "audio", messageId: entry.id };
    }
    return { from: entry.from, text: entry.text?.body, messageId: entry.id };
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
