const express = require("express");
const env = require("../config/env");
const store = require("../services/store");
const { generateReply } = require("../services/ai");
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
    if (!from || !text) return;

    const settings = store.read("settings.json");
    const paused = store.read("pausedConversations.json");
    const { stopWords, resumeWords } = settings.humanTakeover;

    const normalized = text.trim();

    // كلمة إيقاف يدوية — تُكتب من جوا نفس محادثة الزبون من طرف الموظف
    if (stopWords.some((w) => normalized === w)) {
      paused[from] = { since: new Date().toISOString() };
      store.write("pausedConversations.json", paused);
      return;
    }

    // كلمة استئناف
    if (resumeWords.some((w) => normalized === w)) {
      delete paused[from];
      store.write("pausedConversations.json", paused);
      return;
    }

    // البوت ساكت لهاي المحادثة لحد ما ترجعه
    if (paused[from]) return;

    const conversations = store.read("conversations.json");
    const history = conversations[from] || [];

    const reply = await generateReply(history, text);

    await whatsapp.sendText(from, reply);

    history.push({ role: "user", content: text });
    history.push({ role: "assistant", content: reply });
    conversations[from] = history.slice(-20); // نحتفظ بآخر 20 رسالة بس لتوفير التوكينز
    store.write("conversations.json", conversations);

    // TODO: لما البوت يستنتج إنو الطلب تأكد، خزنه بـ orders.json
    // وإذا settings.orderDestination.mode === "whatsapp" ابعت نسخة عبر whatsapp.sendText
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

  // Green API
  const messageData = body?.messageData;
  return {
    from: body?.senderData?.chatId?.replace("@c.us", ""),
    text: messageData?.textMessageData?.textMessage,
  };
}

module.exports = router;
