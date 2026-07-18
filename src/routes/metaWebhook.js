const express = require("express");
const fs = require("fs");
const path = require("path");
const env = require("../config/env");
const botStore = require("../services/botStore");
const meta = require("../services/metaMessaging");
const { handleIncomingMessage } = require("../services/messageHandler");

const router = express.Router();

// سجل تتبع مؤقت وموثوق نكتب فيه كل خطوة، عشان صفحة اللوجز بالرندر كانت بترجع نتائج قديمة/مخزنة
// ومش عم تعكس الطلبات الحقيقية اللحظية. منقدر نشوفه مباشرة من الـ Shell بالسيرفر (cat).
const TRACE_FILE = path.join(__dirname, "..", "data", "webhook-trace.log");
function trace(msg) {
  try {
    fs.appendFileSync(TRACE_FILE, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
  } catch (e) {
    console.error("[meta-webhook] فشل الكتابة بملف التتبع:", e.message);
  }
}

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
          trace(`event: sender=${event.sender?.id} is_echo=${!!event.message?.is_echo} hasText=${!!event.message?.text}`);
          if (event.message?.is_echo) continue; // رسائلنا احنا يلي بعتناها، مش رسالة زبون
          const from = event.sender?.id;
          const text = event.message?.text;
          if (!from || !text) {
            trace("تجاهلت الحدث: ما في sender أو نص رسالة.");
            continue;
          }

          const sendFn = (to, replyText) =>
            channel === "messenger" ? meta.sendMessengerText(bot, to, replyText) : meta.sendInstagramText(bot, to, replyText);

          trace(`بلشت handleIncomingMessage لبوت=${bot.id} from=${from}`);
          await handleIncomingMessage(bot.id, from, text, null, sendFn);
          trace(`خلصت handleIncomingMessage بنجاح لبوت=${bot.id} from=${from}`);
          console.log(`[meta-webhook] تمت معالجة رسالة ${channel} للبوت "${bot.name}" بنجاح.`);
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
