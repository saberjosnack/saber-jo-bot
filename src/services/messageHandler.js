const store = require("./store");
const botStore = require("./botStore");
const { generateReply } = require("./ai");
const { trace } = require("./trace");

// قيم افتراضية لو ما في إعدادات "سرعة الرد" محفوظة أصلاً (بوتات قديمة قبل ما ضفنا هاي الميزة)
const DEFAULT_TIMING = { debounceMs: 6000, baseDelayMs: 1200, maxDelayMs: 6000 };
const PER_CHAR_MS = 25; // مش قابل للتعديل من الداشبورد حالياً — تفصيل تقني بسيط

// بيقرا إعدادات "سرعة الرد" (settings.timing) الخاصة بهاد البوت من الداشبورد — بالثواني بالداشبورد، وبنحولها ميلي ثانية هون.
function getTimingSettings(botId) {
  try {
    const bot = botStore.getBot(botId);
    if (!bot) return DEFAULT_TIMING;
    const settings = store.read(`configs/${bot.configId}/settings.json`);
    const t = settings?.timing || {};
    return {
      debounceMs: Math.round((Number(t.debounceSec) || 6) * 1000),
      baseDelayMs: Math.round((Number(t.minDelaySec) || 1.2) * 1000),
      maxDelayMs: Math.round((Number(t.maxDelaySec) || 6) * 1000),
    };
  } catch (err) {
    return DEFAULT_TIMING;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// حماية من تعليق استدعاء الذكاء الاصطناعي إلى ما لا نهاية (مثلاً تعليق بالشبكة) —
// لو ما رد خلال هاي المدة منرمي خطأ عادي، نقدر نمسكه ونرد برسالة احتياطية بدل ما يضل الرد عالق للأبد بصمت.
const AI_TIMEOUT_MS = 25000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout بعد ${ms}ms بـ ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// تأخير "بشري" قبل إرسال الرد — يتناسب مع طول الرد (رد أطول = وقت "كتابة" أطول)، بحدود يتحكم فيها المالك من الداشبورد.
function computeHumanDelay(replyText, timing = DEFAULT_TIMING) {
  return Math.min(timing.maxDelayMs, timing.baseDelayMs + (replyText?.length || 0) * PER_CHAR_MS);
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
  trace(`handleIncomingMessage: بدأت botId=${botId} from=${from} textLen=${text?.length || 0} hasImage=${!!image}`);
  if (!from) return;

  const bot = botStore.getBot(botId);
  if (!bot) {
    trace(`handleIncomingMessage: ما لقيت بوت botId=${botId} — وقفت.`);
    console.error(`رسالة وصلت لبوت غير موجود: ${botId}`);
    return;
  }

  if (bot.enabled === false) {
    trace(`handleIncomingMessage: البوت ${botId} موقوف يدوياً — وقفت.`);
    return; // البوت موقوف يدوياً من الداشبورد (زر الإيقاف)
  }

  const settings = store.read(`configs/${bot.configId}/settings.json`);
  const timing = {
    debounceMs: Math.round((Number(settings.timing?.debounceSec) || 6) * 1000),
    baseDelayMs: Math.round((Number(settings.timing?.minDelaySec) || 1.2) * 1000),
    maxDelayMs: Math.round((Number(settings.timing?.maxDelaySec) || 6) * 1000),
  };
  // ملاحظة: بعض البوتات القديمة (متل "default") انعمل إلها الملف تلقائياً كمصفوفة "[]" بدل كائن "{}"
  // (bug قديم بـ store.ensureFile). لو صار هيك، أي كتابة عليه بعدين بتضيع بصمت لأن
  // JSON.stringify على مصفوفة بيتجاهل أي property نصية زايدة عليها. نحمي نفسنا هون بتحويلها كائن.
  const pausedRaw = store.read(`bots/${botId}/pausedConversations.json`);
  const paused = Array.isArray(pausedRaw) ? {} : pausedRaw;
  const { stopWords, resumeWords } = settings.humanTakeover;
  const normalized = (text || "").trim();

  if (stopWords.some((w) => normalized === w)) {
    trace(`handleIncomingMessage: كلمة إيقاف من ${from} — وقّفت المحادثة.`);
    paused[from] = { since: new Date().toISOString() };
    store.write(`bots/${botId}/pausedConversations.json`, paused);
    return;
  }

  if (resumeWords.some((w) => normalized === w)) {
    trace(`handleIncomingMessage: كلمة استئناف من ${from} — رجّعت المحادثة.`);
    delete paused[from];
    store.write(`bots/${botId}/pausedConversations.json`, paused);
    return;
  }

  if (paused[from]) {
    trace(`handleIncomingMessage: المحادثة مع ${from} موقوفة (تدخل بشري) — تجاهلت.`);
    return;
  }

  const conversationsRaw = store.read(`bots/${botId}/conversations.json`);
  const conversations = Array.isArray(conversationsRaw) ? {} : conversationsRaw;
  const history = conversations[from] || [];

  trace(`handleIncomingMessage: بدأت أستدعي generateReply لـ ${from} (historyLen=${history.length})...`);
  let reply;
  try {
    reply = await withTimeout(generateReply(history, text, image, bot.configId), AI_TIMEOUT_MS, "generateReply");
    trace(`handleIncomingMessage: رجع رد من generateReply لـ ${from} (replyLen=${reply?.length || 0}).`);
  } catch (err) {
    trace(`handleIncomingMessage: فشل generateReply لـ ${from}: ${err.message}\n${err.stack}`);
    reply = "معليش، صار عندي خلل بسيط 🙏 جرب ابعت رسالتك كمان مرة بعد شوي.";
  }

  trace(`handleIncomingMessage: بلشت التأخير البشري قبل الإرسال لـ ${from}...`);
  await sleep(computeHumanDelay(reply, timing));
  trace(`handleIncomingMessage: بلشت sendText لـ ${from}...`);
  try {
    await sendText(from, reply);
    trace(`handleIncomingMessage: نجح sendText لـ ${from}.`);
  } catch (err) {
    trace(`handleIncomingMessage: فشل sendText لـ ${from}: ${err.message}\n${err.stack}`);
    throw err;
  }

  history.push({ role: "user", content: text || "[صورة]" });
  history.push({ role: "assistant", content: reply });
  conversations[from] = history.slice(-20);
  store.write(`bots/${botId}/conversations.json`, conversations);
  trace(`handleIncomingMessage: خلصت وحفظت المحادثة مع ${from}.`);
}

// key: `${botId}::${from}` -> { parts, image, sendText, onTypingStart, timer }
const pendingBuffers = new Map();

function bufferKey(botId, from) {
  return `${botId}::${from}`;
}

async function flushBuffer(key) {
  trace(`flushBuffer: انطلق التايمر لـ key=${key}`);
  const buffer = pendingBuffers.get(key);
  if (!buffer) {
    trace(`flushBuffer: ما لقيت buffer لـ key=${key} (تم مسحه قبلي؟) — وقفت.`);
    return;
  }
  pendingBuffers.delete(key);

  const separatorIndex = key.indexOf("::");
  const botId = key.slice(0, separatorIndex);
  const from = key.slice(separatorIndex + 2);
  const combinedText = buffer.parts.join("\n").trim();
  trace(`flushBuffer: key=${key} partsCount=${buffer.parts.length} combinedTextLen=${combinedText.length} hasImage=${!!buffer.image} hasTypingFn=${!!buffer.onTypingStart}`);

  if (buffer.onTypingStart) {
    try {
      trace(`flushBuffer: بلشت onTypingStart لـ ${key}`);
      await buffer.onTypingStart();
      trace(`flushBuffer: خلص onTypingStart لـ ${key}`);
    } catch (err) {
      trace(`flushBuffer: فشل onTypingStart لـ ${key}: ${err.message}`);
      console.error("[messageHandler] فشل إظهار مؤشر الكتابة:", err.message);
    }
  }

  try {
    trace(`flushBuffer: بلشت handleIncomingMessage لـ ${key}`);
    await handleIncomingMessage(botId, from, combinedText, buffer.image, buffer.sendText);
    trace(`flushBuffer: خلص handleIncomingMessage لـ ${key} بنجاح.`);
  } catch (err) {
    trace(`flushBuffer: خطأ بمعالجة الرسائل المجمّعة لـ ${key}: ${err.message}\n${err.stack}`);
    console.error(`[messageHandler] خطأ بمعالجة الرسائل المجمّعة لـ ${key}:`, err);
  }
}

/**
 * الطريقة المفضّلة لتمرير رسالة واردة — بديل عن استدعاء handleIncomingMessage مباشرة.
 * بتجمع كل الرسائل يلي توصل من نفس الزبون خلال فترة قصيرة (مدة التجميع من إعدادات "سرعة الرد" بالداشبورد) وترد عليهم دفعة وحدة،
 * بدل ما ترد على كل رسالة/سطر لحاله. كل الـ webhooks لازم تستخدم هاي الدالة.
 *
 * @param {() => Promise<void>} [onTypingStart] - اختياري: بينفّذ لما نبلش نعالج (قبل توليد الرد) —
 *   يستخدم لإظهار مؤشر "يكتب الآن..." (مدعوم حالياً بماسنجر/انستجرام).
 */
function queueIncomingMessage(botId, from, text, image, sendText, onTypingStart) {
  if (!from) {
    trace(`queueIncomingMessage: تجاهلت — ما في from (botId=${botId}).`);
    return;
  }
  if (!text && !image) {
    trace(`queueIncomingMessage: تجاهلت — ما في نص ولا صورة (botId=${botId} from=${from}).`);
    return;
  }

  const key = bufferKey(botId, from);
  const existing = pendingBuffers.get(key);
  const { debounceMs } = getTimingSettings(botId);

  if (existing) {
    if (text) existing.parts.push(text);
    if (image) existing.image = image;
    existing.sendText = sendText;
    if (onTypingStart) existing.onTypingStart = onTypingStart;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushBuffer(key), debounceMs);
    trace(`queueIncomingMessage: أضفت لبفر موجود key=${key}، partsCount=${existing.parts.length}، أعدت ضبط التايمر (${debounceMs}ms).`);
    return;
  }

  const buffer = {
    parts: text ? [text] : [],
    image: image || null,
    sendText,
    onTypingStart,
    timer: null,
  };
  buffer.timer = setTimeout(() => flushBuffer(key), debounceMs);
  pendingBuffers.set(key, buffer);
  trace(`queueIncomingMessage: أنشأت بفر جديد key=${key}، ضبطت تايمر (${debounceMs}ms).`);
}

module.exports = { handleIncomingMessage, queueIncomingMessage };
