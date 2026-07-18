const store = require("./store");
const botStore = require("./botStore");
const { generateReply } = require("./ai");

/**
 * منطق معالجة أي رسالة واردة لأي بوت، بغض النظر عن مصدرها
 * (Green API, UltraMsg, Meta Cloud API, أو الاتصال المباشر self-hosted).
 *
 * @param {string} botId - أي بوت استقبل الرسالة
 * @param {string} from - رقم الزبون
 * @param {string} text - نص الرسالة (ممكن يكون فاضي لو الرسالة صورة بس)
 * @param {{base64:string, mediaType:string}|null} image - صورة أرسلها الزبون (اختياري)
 * @param {(to:string, text:string) => Promise<void>} sendText - دالة الإرسال الخاصة بهاد البوت
 */
async function handleIncomingMessage(botId, from, text, image, sendText) {
  if (!from) return;

  const bot = botStore.getBot(botId);
  if (!bot) {
    console.error(`رسالة وصلت لبوت غير موجود: ${botId}`);
    return;
  }

  if (bot.enabled === false) return; // البوت موقوف يدوياً من الداشبورد (زر الإيقاف)

  const settings = store.read(`configs/${bot.configId}/settings.json`);
  // ملاحظة: بعض البوتات القديمة (متل "default") انعمل إلها الملف تلقائياً كمصفوفة "[]" بدل كائن "{}"
  // (bug قديم بـ store.ensureFile). لو صار هيك، أي كتابة عليه بعدين بتضيع بصمت لأن
  // JSON.stringify على مصفوفة بيتجاهل أي property نصية زايدة عليها. نحمي نفسنا هون بتحويلها كائن.
  const pausedRaw = store.read(`bots/${botId}/pausedConversations.json`);
  const paused = Array.isArray(pausedRaw) ? {} : pausedRaw;
  const { stopWords, resumeWords } = settings.humanTakeover;
  const normalized = (text || "").trim();

  if (stopWords.some((w) => normalized === w)) {
    paused[from] = { since: new Date().toISOString() };
    store.write(`bots/${botId}/pausedConversations.json`, paused);
    return;
  }

  if (resumeWords.some((w) => normalized === w)) {
    delete paused[from];
    store.write(`bots/${botId}/pausedConversations.json`, paused);
    return;
  }

  if (paused[from]) return;

  const conversationsRaw = store.read(`bots/${botId}/conversations.json`);
  const conversations = Array.isArray(conversationsRaw) ? {} : conversationsRaw;
  const history = conversations[from] || [];

  const reply = await generateReply(history, text, image, bot.configId);

  await sendText(from, reply);

  history.push({ role: "user", content: text || "[صورة]" });
  history.push({ role: "assistant", content: reply });
  conversations[from] = history.slice(-20);
  store.write(`bots/${botId}/conversations.json`, conversations);
}

module.exports = { handleIncomingMessage };
