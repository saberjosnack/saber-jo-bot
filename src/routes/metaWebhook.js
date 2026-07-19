const express = require("express");
const env = require("../config/env");
const botStore = require("../services/botStore");
const meta = require("../services/metaMessaging");
const { queueIncomingMessage } = require("../services/messageHandler");
const { transcribeAudio } = require("../services/speechToText");
const { trace } = require("../services/trace");

const router = express.Router();

// ---------- تأكيد الـ Webhook من ميتا (خطوة لمرة وحدة وقت الربط) ----------
router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === env.metaVerifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------- استقبال رسائل ماسنجر وانستجرام ----------
router.post("/", async (req, res) => {
  trace(`POST استُقبل. object=${req.body?.object} entries=${req.body?.entry?.length ?? 0}`);

  // لازم نتحقق من التوقيع قبل ما نرد 200، عشان ما نعالج رسايل مزوّرة (حماية من إساءة الاستخدام)
  const signature = req.headers["x-hub-signature-256"];
  if (!meta.verifySignature(req.rawBody || Buffer.from(JSON.stringify(req.body)), signature)) {
    trace("توقيع غير صحيح — رفضت الطلب (403).");
    console.error("[meta-webhook] توقيع غير صحيح — تجاهلت الطلب.");
    return res.sendStatus(403);
  }

  trace("التوقيع سليم. رديت 200 وبلشت المعالجة بالخلفية.");
  res.sendStatus(200); // نرد فوراً، والمعالجة تصير بالخلفية (ميتا بيعيد المحاولة لو تأخرنا)

  try {
    const body = req.body;
    const channel = body.object === "instagram" ? "instagram" : body.object === "page" ? "messenger" : null;
    if (!channel) {
      trace(`object غير معروف: ${body.object} — تجاهلت الطلب.`);
      return;
    }

    for (const entry of body.entry || []) {
      const pageOrIgId = entry.id;
      trace(`entry.id=${pageOrIgId} channel=${channel} messaging_count=${entry.messaging?.length ?? 0}`);
      const bot = channel === "messenger" ? botStore.findBotByMetaPageId(pageOrIgId) : botStore.findBotByMetaIgId(pageOrIgId);

      if (!bot) {
        trace(`ما لقيت بوت مربوط بـ ${pageOrIgId} (channel=${channel}).`);
        console.error(`[meta-webhook] رسالة ${channel} وصلت لصفحة/حساب مش مربوط بأي بوت: ${pageOrIgId}`);
        continue;
      }
      trace(`لقيت البوت: ${bot.name} (id=${bot.id}).`);

      for (const event of entry.messaging || []) {
        try {
          const attachments = event.message?.attachments || [];
          trace(
            `event: sender=${event.sender?.id} is_echo=${!!event.message?.is_echo} hasText=${!!event.message
              ?.text} attachments=${attachments.map((a) => a.type).join(",")}`
          );
          if (event.message?.is_echo) continue; // رسائلنا احنا يلي بعتناها، مش رسالة زبون
          const from = event.sender?.id;
          if (!from) {
            trace("تجاهلت الحدث: ما في sender.");
            continue;
          }

          const sendFn = (to, replyText) =>
            channel === "messenger" ? meta.sendMessengerText(bot, to, replyText) : meta.sendInstagramText(bot, to, replyText);

          let text = event.message?.text || "";
          let image = null;

          const imageAttachment = attachments.find((a) => a.type === "image");
          const audioAttachment = attachments.find((a) => a.type === "audio");
          // موقع مباشر عن طريق ماسنجر — https://developers.facebook.com/docs/messenger-platform/webhooks#location
          // الصيغة: attachment.type === "location"، payload.coordinates = {lat, long} (مش "lng").
          const locationAttachment = attachments.find((a) => a.type === "location");
          const location = locationAttachment?.payload?.coordinates
            ? { lat: locationAttachment.payload.coordinates.lat, lng: locationAttachment.payload.coordinates.long }
            : null;
          if (location) trace(`لقيت موقع مباشر بـ${channel} من ${from}: ${location.lat},${location.lng}`);

          if (imageAttachment?.payload?.url) {
            try {
              const { buffer, contentType } = await meta.downloadMetaAttachment(imageAttachment.payload.url);
              image = { base64: buffer.toString("base64"), mediaType: contentType };
              trace(`حمّلت صورة من ${channel} (${contentType}, ${buffer.length} bytes).`);
            } catch (err) {
              trace(`فشل تحميل الصورة: ${err.message}`);
            }
          }

          if (audioAttachment?.payload?.url) {
            try {
              const { buffer } = await meta.downloadMetaAttachment(audioAttachment.payload.url);
              const transcribed = await transcribeAudio(buffer, "voice.mp4");
              if (transcribed) {
                text = text ? `${text}\n${transcribed}` : transcribed;
                trace(`حولت رسالة صوتية لنص: "${transcribed.slice(0, 80)}"`);
              } else {
                trace("ما قدرت أحوّل الرسالة الصوتية لنص (بدون مفتاح OpenAI أو فشل التحويل).");
                await sendFn(from, "سمعت إنك بعتلي رسالة صوتية، بس ما قدرت أسمعها منيح 🙏 ممكن تكتبلي طلبك؟");
                continue;
              }
            } catch (err) {
              trace(`فشل تحميل/تحويل الرسالة الصوتية: ${err.message}`);
              continue;
            }
          }

          if (!text && !image && !location) {
            trace("تجاهلت الحدث: ما في نص ولا صورة ولا صوت ولا موقع مدعوم.");
            continue;
          }

          // مؤشر "يكتب الآن..." مدعوم بماسنجر بس حالياً
          const onTypingStart = channel === "messenger" ? () => meta.sendMessengerTypingOn(bot, from) : undefined;
          const sendImageFn = (to, imageUrl) =>
            channel === "messenger" ? meta.sendMessengerImage(bot, to, imageUrl) : meta.sendInstagramImage(bot, to, imageUrl);

          trace(`أضفت الرسالة لطابور التجميع لبوت=${bot.id} from=${from}`);
          queueIncomingMessage(bot.id, from, text, image, sendFn, onTypingStart, sendImageFn, channel, location);
        } catch (err) {
          trace(`خطأ بمعالجة الحدث: ${err.message}\n${err.stack}`);
          console.error(`خطأ بمعالجة رسالة ${channel} واردة:`, err);
        }
      }
    }
  } catch (outerErr) {
    trace(`خطأ عام خارج اللوب: ${outerErr.message}\n${outerErr.stack}`);
    console.error("[meta-webhook] خطأ عام بمعالجة الطلب:", outerErr);
  }
});

module.exports = router;
