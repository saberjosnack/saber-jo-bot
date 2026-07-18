const store = require("./store");
const botStore = require("./botStore");
const { generateReply } = require("./ai");

// كم ثانية ننتظر بعد آخر رسالة قبل ما نبلش نرد — عشان لو الزبون بعت كذا رسالة قصيرة ورا بعض
// (مثلاً كل كلمة بسطر لحالها) نجمعهم ونرد عليهم مرة وحدة، بدل ما نرد على كل جزء لحاله.
const DEBOUNCE_MS = 6000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// تأخير "بشري" قبل إرسال الرد — يتناسب مع طول الرد (رد أطول = وقت "كتابة" أطول)، بحدود معقولة.
function computeHumanDelay(replyText) {
  const base = 1200;
  const perChar = 25;
  const max = 6000;
  return Math.min(max, base + (replyText?.length || 0) * perChar);
}

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

  await sleep(computeHumanDelay(reply));
  await sendText(from, reply);

  history.push({ role: "user", content: text || "[صورة]" });
  history.push({ role: "assistant", content: reply });
  conversations[from] = history.slice(-20);
  store.write(`bots/${botId}/conversations.json`, conversations);
}

// key: `${botId}::${from}` -> { parts, image, sendText, onTypingStart, timer }
const pendingBuffers = new Map();

function bufferKey(botId, from) {
  return `${botId}::${from}`;
}

async function flushBuffer(key) {
  const buffer = pendingBuffers.get(key);
  if (!buffer) return;
  pendingBuffers.delete(key);

  const separatorIndex = key.indexOf("::");
  const botId = key.slice(0, separatorIndex);
  const from = key.slice(separatorIndex + 2);
  const combinedText = buffer.parts.join("\n").trim();

  if (buffer.onTypingStart) {
    try {
      await buffer.onTypingStart();
    } catch (err) {
      console.error("[messageHandler] فشل إظهار مؤشر الكتابة:", err.message);
    }
  }

  try {
    await handleIncomingMessage(botId, from, combinedText, buffer.image, buffer.sendText);
  } catch (err) {
    console.error(`[messageHandler] خطأ بمعالجة الرسائل المجمّعة لـ ${key}:`, err);
  }
}

/**
 * الطريقة المفضّلة لتمرير رسالة واردة — بديل عن استدعاء handleIncomingMessage مباشرة.
 * بتجمع كل الرسائل يلي توصل من نفس الزبون خلال فترة قصيرة (DEBOUNCE_MS) وترد عليهم دفعة وحدة،
 * بدل ما ترد على كل رسالة/سطر لحاله. كل الـ webhooks لازم تستخدم هاي الدالة.
 *
 * @param {() => Promise<void>} [onTypingStart] - اختياري: بينفّذ لما نبلش نعالج (قبل توليد الرد) —
 *   يستخدم لإظهار مؤشر "يكتب الآن..." (مدعوم حالياً بماسنجر/انستجرام).
 */
function queueIncomingMessage(botId, from, text, image, sendText, onTypingStart) {
  if (!from) return;
  if (!text && !image) return;

  const key = bufferKey(botId, from);
  const existing = pendingBuffers.get(key);

  if (existing) {
    if (text) existing.parts.push(text);
    if (image) existing.image = image;
    existing.sendText = sendText;
    if (onTypingStart) existing.onTypingStart = onTypingStart;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushBuffer(key), DEBOUNCE_MS);
    return;
  }

  const buffer = {
    parts: text ? [text] : [],
    image: image || null,
    sendText,
    onTypingStart,
    timer: null,
  };
  buffer.timer = setTimeout(() => flushBuffer(key), DEBOUNCE_MS);
  pendingBuffers.set(key, buffer);
}

module.exports = { handleIncomingMessage, queueIncomingMessage };
