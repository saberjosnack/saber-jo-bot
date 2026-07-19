const store = require("./store");
const botStore = require("./botStore");
const { generateReply, recoverMissedOrder, looksLikeMissedOrderConfirmation } = require("./ai");
const whatsapp = require("./whatsapp");
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

// أقصى عدد صور نبعتها تلقائياً على نفس الرد الواحد — حماية من إغراق الزبون بصور لو ذكر كذا صنف
const MAX_AUTO_IMAGES_PER_REPLY = 2;

// بيدوّر على أصناف "متوفرة" وعندها صورة محفوظة، واسمها مذكور حرفياً برسالة الزبون أو برد البوت.
// مطابقة بسيطة بالنص (مش ذكاء اصطناعي) — كافية لأنو البوت أصلاً متعلّم يذكر اسم الصنف الحرفي من المنيو.
function findMentionedItemsWithImages(menu, userText, replyText) {
  const haystack = `${userText || ""} ${replyText || ""}`;
  if (!haystack.trim()) return [];
  return menu.filter((item) => item.available && item.imageUrl && item.name && haystack.includes(item.name));
}

// بيرجع بيانات الزبون المحفوظة من طلب سابق (لو موجودة) — عشان البوت يتعرف على الزبون الراجع
// بدل ما يسأله من الصفر عن اسمه ورقمه وعنوانه كل مرة.
function getCustomerProfile(botId, from) {
  try {
    const raw = store.read(`bots/${botId}/customers.json`);
    const customers = Array.isArray(raw) ? {} : raw;
    return customers[from] || null;
  } catch (err) {
    console.error("[messageHandler] فشل قراءة بيانات الزبون:", err.message);
    return null;
  }
}

// بيحفظ/يحدّث بيانات الزبون بعد كل طلب مؤكد (الاسم، رقم التواصل، آخر عنوان) — مخزنة لكل بوت لحاله.
function upsertCustomerProfile(botId, from, order, items) {
  try {
    const raw = store.read(`bots/${botId}/customers.json`);
    const customers = Array.isArray(raw) ? {} : raw;
    const existing = customers[from] || {};
    customers[from] = {
      name: order.customerName || existing.name || "",
      phone: order.contactPhone || existing.phone || from,
      area: order.area || existing.area || "",
      lastItems: items.length ? items : existing.lastItems || [],
      lastOrderAt: new Date().toISOString(),
    };
    store.write(`bots/${botId}/customers.json`, customers);
  } catch (err) {
    console.error("[messageHandler] فشل حفظ بيانات الزبون:", err.message);
  }
}

// بيبعت رسالة نصية لجروب واتساب — عن طريق مزود مستضاف (Wasender/UltraMsg/...) أو الاتصال المباشر (QR/Baileys)
// حسب أي وحدة البوت فعلاً مربوط فيها. الاتصال المباشر بيدعم جروبات مجاناً بدون أي وسيط خارجي.
// ملاحظة: require لـ selfHostedWhatsapp هون جوا الدالة (مش فوق بالملف) عشان نتفادى دورة استدعاء
// دائرية بين الملفين (selfHostedWhatsapp.js أصلاً بيستدعي messageHandler.js فوق بالملف).
async function sendToWhatsappGroup(bot, target, text) {
  if (bot.waProvider === "selfhosted") {
    const selfHostedWhatsapp = require("./selfHostedWhatsapp");
    return selfHostedWhatsapp.sendText(bot.id, target, text);
  }
  return whatsapp.sendText(bot, target, text);
}

// بيسجل الطلب بلوحة التحكم، وإذا كان مفعّل بإعدادات "وجهة الطلبات"، بيبعت ملخصه لجروب واتساب مخصص للموظفين.
// هاد الجروب (رقمه/معرّفه) مش موجود إطلاقاً بأي مكان يشوفه الموديل أو الزبون — هون بس بالكود، منفصل تماماً عن المحادثة.
async function recordOrder(bot, from, channel, order) {
  try {
    const ordersRaw = store.read(`bots/${bot.id}/orders.json`);
    const orders = Array.isArray(ordersRaw) ? ordersRaw : [];

    const items = (order.itemsSummary || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const record = {
      id: `ORD-${Date.now()}`,
      createdAt: new Date().toISOString(),
      name: order.customerName || "زبون",
      phone: order.contactPhone || from,
      items,
      total: typeof order.totalPrice === "number" ? order.totalPrice : null,
      area: order.area || "",
      notes: order.notes || "",
      status: "new",
      channel,
    };

    orders.push(record);
    store.write(`bots/${bot.id}/orders.json`, orders);
    trace(`recordOrder: سجّلت طلب جديد ${record.id} لبوت=${bot.id} from=${from} channel=${channel}`);

    upsertCustomerProfile(bot.id, from, order, items);
    trace(`recordOrder: حدّثت بيانات الزبون ${from} (اسم/رقم/عنوان) لبوت=${bot.id}`);

    const settings = store.read(`configs/${bot.configId}/settings.json`);
    const dest = settings.orderDestination || {};
    if (dest.mode === "whatsapp_group" && dest.target) {
      const summaryLines = [
        "🧾 طلب جديد",
        `الأصناف: ${items.length ? items.join("، ") : order.itemsSummary || "-"}`,
        `المنطقة: ${record.area || "-"}`,
        record.total !== null ? `المجموع: ${record.total} د.أ` : null,
        record.name !== "زبون" ? `الاسم: ${record.name}` : null,
        `رقم التواصل: ${record.phone}`,
        record.notes ? `ملاحظات: ${record.notes}` : null,
      ].filter(Boolean);

      try {
        await sendToWhatsappGroup(bot, dest.target, summaryLines.join("\n"));
        trace(`recordOrder: بعت الطلب ${record.id} لجروب الواتساب (${dest.targetName || dest.target}).`);
      } catch (err) {
        trace(`recordOrder: فشل إرسال الطلب ${record.id} لجروب الواتساب: ${err.message}`);
        console.error("[messageHandler] فشل إرسال الطلب لجروب الواتساب:", err.message);
      }
    }
  } catch (err) {
    trace(`recordOrder: خطأ عام بتسجيل الطلب: ${err.message}`);
    console.error("[messageHandler] فشل تسجيل الطلب:", err.message);
  }
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
 * @param {(to:string, imageUrl:string) => Promise<void>} [sendImage] - اختياري: دالة إرسال صورة (لإرسال صور الأصناف تلقائياً)
 * @param {string} [channel] - "whatsapp" | "messenger" | "instagram" — لتسجيله مع الطلب بس
 */
async function handleIncomingMessage(botId, from, text, image, sendText, sendImage, channel = "whatsapp") {
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
    return; // البوت موقوف يدوياً من الداشبورد (زر الإيقاف العام)
  }

  // تشغيل/إيقاف كل منصة لحالها — لو القناة هاي محددة "موقوفة" صراحة (false)، منتجاهل الرسالة بدون ما نوقف باقي المنصات.
  // ملاحظة: بوتات قديمة ما عندها channelEnabled أصلاً — بنعتبرها "شغالة" افتراضياً (undefined !== false).
  if (bot.channelEnabled && bot.channelEnabled[channel] === false) {
    trace(`handleIncomingMessage: قناة ${channel} موقوفة يدوياً لبوت ${botId} — وقفت.`);
    return;
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

  const customerProfile = getCustomerProfile(botId, from);
  trace(`handleIncomingMessage: بدأت أستدعي generateReply لـ ${from} (historyLen=${history.length}, زبون سابق=${customerProfile ? "نعم" : "لا"})...`);
  let reply, order;
  try {
    const result = await withTimeout(
      generateReply(history, text, image, bot.configId, customerProfile),
      AI_TIMEOUT_MS,
      "generateReply"
    );
    reply = result.reply;
    order = result.order;
    trace(`handleIncomingMessage: رجع رد من generateReply لـ ${from} (replyLen=${reply?.length || 0}، order=${order ? "نعم" : "لا"}).`);
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

  if (settings.sendImagesAutomatically && sendImage) {
    try {
      const menu = store.read(`configs/${bot.configId}/menu.json`);
      const mentioned = findMentionedItemsWithImages(menu, text, reply).slice(0, MAX_AUTO_IMAGES_PER_REPLY);
      for (const item of mentioned) {
        trace(`handleIncomingMessage: بلشت إرسال صورة الصنف "${item.name}" لـ ${from}...`);
        await sendImage(from, item.imageUrl);
        trace(`handleIncomingMessage: نجح إرسال صورة الصنف "${item.name}" لـ ${from}.`);
      }
    } catch (err) {
      trace(`handleIncomingMessage: فشل إرسال صورة صنف لـ ${from}: ${err.message}`);
      console.error("[messageHandler] فشل إرسال صورة صنف تلقائياً:", err.message);
    }
  }

  // شبكة أمان: لو رد البوت للزبون بيبدو إنه أكد تسجيل طلب ("تم تسجيله بنجاح" وشبهها) بس بدون ما ينادي
  // فعلياً على أداة record_order بنفس الرد — هاد معناه الزبون اتطمن إنو طلبه انسجل بس فعلياً ضاع بصمت.
  // منحاول نسترجعه بمكالمة تصحيحية سريعة (tool_choice إجباري) قبل ما نستسلم ونخسر الطلب نهائياً.
  if (!order && looksLikeMissedOrderConfirmation(reply)) {
    trace(`handleIncomingMessage: الرد لـ ${from} بيبدو إنه أكد طلب بدون استدعاء الأداة — رح أحاول أسترجعه...`);
    try {
      order = await recoverMissedOrder(bot.configId, history, text, reply);
      trace(`handleIncomingMessage: محاولة استرجاع الطلب الفائت لـ ${from} ${order ? "نجحت ✅" : "رجعت بدون طلب"}.`);
    } catch (err) {
      trace(`handleIncomingMessage: فشلت محاولة استرجاع الطلب الفائت لـ ${from}: ${err.message}`);
      console.error("[messageHandler] فشل استرجاع طلب فائت:", err.message);
    }
  }

  if (order) {
    trace(`handleIncomingMessage: طلب مؤكد من ${from} — بلشت recordOrder...`);
    await recordOrder(bot, from, channel, order);
  }

  history.push({ role: "user", content: text || "[صورة]" });
  history.push({ role: "assistant", content: reply });
  conversations[from] = history.slice(-20);
  store.write(`bots/${botId}/conversations.json`, conversations);

  // بنسجل وقت آخر رسالة لكل زبون بملف منفصل خفيف — بنستخدمه بس لترتيب تبويب "المحادثات" بالداشبورد
  // من الأحدث للأقدم (conversations.json نفسه ما بيحافظ على ترتيب التحديث، بس ترتيب أول اتصال).
  try {
    const lastActivityRaw = store.read(`bots/${botId}/lastActivity.json`);
    const lastActivity = Array.isArray(lastActivityRaw) ? {} : lastActivityRaw;
    lastActivity[from] = new Date().toISOString();
    store.write(`bots/${botId}/lastActivity.json`, lastActivity);
  } catch (err) {
    console.error("[messageHandler] فشل تحديث وقت آخر نشاط:", err.message);
  }

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
    await handleIncomingMessage(botId, from, combinedText, buffer.image, buffer.sendText, buffer.sendImage, buffer.channel);
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
 * @param {(to:string, imageUrl:string) => Promise<void>} [sendImage] - اختياري: دالة إرسال صورة (لصور الأصناف التلقائية)
 * @param {string} [channel] - "whatsapp" | "messenger" | "instagram" — لتسجيله مع أي طلب ينسجل بهاي المحادثة
 */
function queueIncomingMessage(botId, from, text, image, sendText, onTypingStart, sendImage, channel = "whatsapp") {
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
    if (sendImage) existing.sendImage = sendImage;
    if (channel) existing.channel = channel;
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
    sendImage,
    channel,
    timer: null,
  };
  buffer.timer = setTimeout(() => flushBuffer(key), debounceMs);
  pendingBuffers.set(key, buffer);
  trace(`queueIncomingMessage: أنشأت بفر جديد key=${key}، ضبطت تايمر (${debounceMs}ms).`);
}

module.exports = { handleIncomingMessage, queueIncomingMessage };
