const express = require("express");
const env = require("../config/env");
const botStore = require("../services/botStore");
const meta = require("../services/metaMessaging");
const { handleIncomingMessage } = require("../services/messageHandler");

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
  // لازم نتحقق من التوقيع قبل ما نرد 200، عشان ما نعالج رسايل مزوّرة (حماية من إساءة الاستخدام)
  const signature = req.headers["x-hub-signature-256"];
  if (!meta.verifySignature(req.rawBody || Buffer.from(JSON.stringify(req.body)), signature)) {
    console.error("[meta-webhook] توقيع غير صحيح — تجاهلت الطلب.");
    return res.sendStatus(403);
  }

  res.sendStatus(200); // نرد فوراً، والمعالجة تصير بالخلفية (ميتا بيعيد المحاولة لو تأخرنا)

  const body = req.body;
  const channel = body.object === "instagram" ? "instagram" : body.object === "page" ? "messenger" : null;
  if (!channel) return;

  for (const entry of body.entry || []) {
    const pageOrIgId = entry.id;
    const bot = channel === "messenger" ? botStore.findBotByMetaPageId(pageOrIgId) : botStore.findBotByMetaIgId(pageOrIgId);

    if (!bot) {
      console.error(`[meta-webhook] رسالة ${channel} وصلت لصفحة/حساب مش مربوط بأي بوت: ${pageOrIgId}`);
      continue;
    }

    for (const event of entry.messaging || []) {
      try {
        if (event.message?.is_echo) continue; // رسائلنا احنا يلي بعتناها، مش رسالة زبون
        const from = event.sender?.id;
        const text = event.message?.text;
        if (!from || !text) continue;

        const sendFn = (to, replyText) =>
          channel === "messenger" ? meta.sendMessengerText(bot, to, replyText) : meta.sendInstagramText(bot, to, replyText);

        await handleIncomingMessage(bot.id, from, text, null, sendFn);
        console.log(`[meta-webhook] تمت معالجة رسالة ${channel} للبوت "${bot.name}" بنجاح.`);
      } catch (err) {
        console.error(`خطأ بمعالجة رسالة ${channel} واردة:`, err);
      }
    }
  }
});

module.exports = router;
