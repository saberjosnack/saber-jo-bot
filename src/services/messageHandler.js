const store = require("./store");
const botStore = require("./botStore");
const { generateReply, recoverMissedOrder, looksLikeMissedOrderConfirmation } = require("./ai");
const whatsapp = require("./whatsapp");
const { trace } = require("./trace");
const deliveryCalc = require("./deliveryCalc");

// مهلة قصوى لحساب توصيل الموقع المباشر (OSRM + Nominatim) — لو تأخرت الشبكة، ما بدنا نعلّق كل الرد
// عليها، منكمل بمعلومات ناقصة (بدون عنوان/رسم) بدل ما نوقف الرد بالكامل.
const LOCATION_CALC_TIMEOUT_MS = 9000;

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

// بينظف نص أمر التحكم اليدوي (وقف/كمل) قبل المقارنة — مشكلة كانت موجودة: المقارنة كانت "===" حرفية
// صارمة، فأي شي زايد بسيط (علامة ترقيم "وقف!"، أو محرف اتجاه خفي (RTL/LTR mark) بعض لوحات المفاتيح
// بتضيفه تلقائياً مع النص العربي، أو حتى مسافة زايدة) كان يخلي المطابقة تفشل بصمت والبوت يكمل يرد عادي
// وكأنو الزبون ما كتب شي مميز أصلاً.
// محارف تباعد/اتجاه غير مرئية (zero-width space/joiner، RTL/LTR marks، BOM) — بعض لوحات المفاتيح
// (خصوصاً بالموبايل) بتضيفها تلقائياً حوالين نص عربي بدون ما المستخدم يحس، وهاد كان يخلي مقارنة
// "===" الصارمة القديمة لكلمة الإيقاف/الاستئناف تفشل بصمت. مبنية من أكواد المحارف مباشرة (بدون نسخ/لصق
// محارف غير مرئية بالكود) عشان نضمن صحتها 100%.
const INVISIBLE_CHAR_CODES = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0xfeff];
const INVISIBLE_CHARS_RE = new RegExp(`[${INVISIBLE_CHAR_CODES.map((c) => `\\u${c.toString(16).padStart(4, "0")}`).join("")}]`, "g");

function normalizeCommandText(text) {
  return (text || "")
    .normalize("NFC")
    .replace(INVISIBLE_CHARS_RE, "")
    .trim()
    .replace(/[!.؟?,،]+$/g, "") // علامات ترقيم بآخر الرسالة (مثلاً "وقف!" أو "كمل؟")
    .trim();
}

function getHumanTakeoverWords(botId) {
  try {
    const bot = botStore.getBot(botId);
    if (!bot) return { stopWords: [], resumeWords: [] };
    const settings = store.read(`configs/${bot.configId}/settings.json`);
    const humanTakeover = settings?.humanTakeover || {};
    return {
      stopWords: (humanTakeover.stopWords || []).map(normalizeCommandText).filter(Boolean),
      resumeWords: (humanTakeover.resumeWords || []).map(normalizeCommandText).filter(Boolean),
    };
  } catch (err) {
    return { stopWords: [], resumeWords: [] };
  }
}

// بيتحقق هل رسالة خام (مش مجمّعة مع غيرها) هي بالضبط كلمة إيقاف أو استئناف — لازم نتحقق منها على
// كل رسالة توصل لحالها (قبل التجميع بالبفر)، مش بعد ما تنضم مع رسائل تانية، وإلا أمر زي "وقف" ممكن
// يوصل بنفس ثانية رسالة تانية من الزبون وينضموا مع بعض بالتجميع، فتصير المقارنة "وقف\nنص تاني" ولا تطابق
// كلمة الإيقاف حرفياً — يعني الأمر يفشل بصمت رغم إنو الزبون كتبه صح.
function checkTakeoverCommand(botId, rawText) {
  const normalized = normalizeCommandText(rawText);
  if (!normalized) return null;
  const { stopWords, resumeWords } = getHumanTakeoverWords(botId);
  if (stopWords.includes(normalized)) return "stop";
  if (resumeWords.includes(normalized)) return "resume";
  return null;
}

// بينفذ أمر الإيقاف/الاستئناف فوراً (بدون ما ينتظر تجميع الرسائل ولا الذكاء الاصطناعي)، وبيرد على الزبون
// برسالة تأكيد قصيرة — قبل هيك ما كان في أي رد أبداً لما الأمر ينفذ، فما كان في طريقة يتأكد فيها الزبون
// (أو صاحب البوت وهو يجرب الميزة) إنو الأمر فعلاً اشتغل، خصوصاً إنو الرد العادي أصلاً بياخذ ثواني.
async function applyTakeoverCommand(botId, from, action, sendText) {
  const pausedRaw = store.read(`bots/${botId}/pausedConversations.json`);
  const paused = Array.isArray(pausedRaw) ? {} : pausedRaw;

  if (action === "stop") {
    const alreadyPaused = Boolean(paused[from]);
    paused[from] = { since: new Date().toISOString() };
    store.write(`bots/${botId}/pausedConversations.json`, paused);
    trace(`applyTakeoverCommand: أوقفت الرد التلقائي لـ ${from} (بوت=${botId}).`);
    if (!alreadyPaused && sendText) {
      try {
        await sendText(from, "تمام ✅ وقفت الرد التلقائي على هالمحادثة — ما رح أرد عليك لحد ما تكتب كلمة الاستئناف.");
      } catch (err) {
        console.error("[messageHandler] فشل إرسال تأكيد الإيقاف:", err.message);
      }
    }
  } else {
    const wasPaused = Boolean(paused[from]);
    delete paused[from];
    store.write(`bots/${botId}/pausedConversations.json`, paused);
    trace(`applyTakeoverCommand: رجّعت الرد التلقائي لـ ${from} (بوت=${botId}).`);
    if (wasPaused && sendText) {
      try {
        await sendText(from, "تمام ✅ رجع الرد التلقائي.");
      } catch (err) {
        console.error("[messageHandler] فشل إرسال تأكيد الاستئناف:", err.message);
      }
    }
  }
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

// أقصى عدد صور من الزبون بنجمّعها بنفس دفعة التجميع الواحدة قبل ما نستدعي الذكاء الاصطناعي — لو الزبون
// بعت أكتر من هيك بنفس النافذة الزمنية، منكتفي بأول عدد منهم (حماية بسيطة من تضخم حجم الطلب/التكلفة).
const MAX_INCOMING_IMAGES_PER_BATCH = 4;

function normalizeSpaces(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

// بيحول أسماء أصناف قرر الموديل بوعي إنه يرسل صورهم (عن طريق أداة send_photo، شوف ai.js) لأصناف فعلية
// من المنيو — "متوفرة" وعندها صورة محفوظة بس. مطابقة بسيطة بالاسم (مش ذكاء اصطناعي) لأنو اسم الصنف يلي
// رجع من الأداة ممكن يكون الاسم التجاري المختصر ("رويال سليم") مش الاسم الكامل المسجل بالمنيو بالضبط.
// ملاحظة: هاد بديل عن الطريقة القديمة (فحص كل نص الرد بحثاً عن أي اسم صنف مذكور) يلي كانت ترسل صور
// لمجرد ذكر اسم الصنف بسياق عادي — هلأ الإرسال قرار واعي من الموديل نفسه (طلب صريح أو إغراء زبون متردد).
function resolveRequestedPhotos(menu, requestedNames) {
  if (!Array.isArray(requestedNames) || !requestedNames.length) return [];
  const results = [];
  for (const rawName of requestedNames) {
    const needle = normalizeSpaces(rawName);
    if (!needle) continue;
    const match = menu.find((item) => {
      if (!item.available || !item.imageUrl || !item.name || results.includes(item)) return false;
      const fullName = normalizeSpaces(item.name);
      if (fullName === needle || fullName.includes(needle) || needle.includes(fullName)) return true;
      const words = fullName.split(" ").filter(Boolean);
      if (words.length >= 2) {
        const shortKey = words.slice(0, 2).join(" ");
        if (shortKey.length >= 4 && (needle.includes(shortKey) || shortKey.includes(needle))) return true;
      }
      return false;
    });
    if (match) results.push(match);
  }
  return results;
}

// بيرجع آخر موقع مباشر بعته الزبون (لو بعت واحد قبل هيك بنفس المحادثة) — عشان لو بعت موقعه برسالة
// وأكد الطلب برسالة تانية بعدها (بدون ما يعيد يبعت الموقع)، البوت لسا يعرف رسم التوصيل المحسوب الصحيح.
function getStoredLocation(botId, from) {
  try {
    const raw = store.exists(`bots/${botId}/customerLocations.json`) ? store.read(`bots/${botId}/customerLocations.json`) : {};
    const locations = Array.isArray(raw) ? {} : raw;
    return locations[from] || null;
  } catch (err) {
    console.error("[messageHandler] فشل قراءة موقع الزبون المحفوظ:", err.message);
    return null;
  }
}

function saveStoredLocation(botId, from, locationContext) {
  try {
    const raw = store.exists(`bots/${botId}/customerLocations.json`) ? store.read(`bots/${botId}/customerLocations.json`) : {};
    const locations = Array.isArray(raw) ? {} : raw;
    locations[from] = { ...locationContext, updatedAt: new Date().toISOString() };
    store.write(`bots/${botId}/customerLocations.json`, locations);
  } catch (err) {
    console.error("[messageHandler] فشل حفظ موقع الزبون:", err.message);
  }
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

// خصم VIP (حي من الكاشير برقم هاتف الزبون) + كود خصم عام (لو الزبون كتب كلمة مطابقة لكود مزامَن من الكاشير) —
// منجهزهم قبل ما نستدعي الذكاء الاصطناعي، وما منحطهم أبداً بالبرومبت الثابت (المخزّن مؤقتاً) عشان:
// 1) ما ننكشف قائمة الأكواد كاملة للموديل (وبالتالي ما يقدر "يسردها" لأي زبون يسأل)، وبس يعرف نتيجة الكود يلي الزبون كتبه فعلاً.
// 2) خصم VIP خاص بزبون واحد بالذات، فمعناه ما إله مكان بمحتوى مشترك بين كل الزبائن أصلاً.
async function getDiscountContext(botId, configId, from, text) {
  const posSync = require("./posSync"); // require جوا الدالة لتفادي دورة استدعاء بين الملفين
  const result = { vip: null, code: null };

  if (posSync.posConfigured()) {
    try {
      result.vip = await withTimeout(posSync.fetchPosCustomerVip(from), 5000, "fetchPosCustomerVip");
    } catch (err) {
      trace(`getDiscountContext: فشل فحص خصم VIP لـ ${from}: ${err.message}`);
    }
  }

  try {
    const codes = store.exists(`configs/${configId}/discountCodes.json`) ? store.read(`configs/${configId}/discountCodes.json`) : [];
    if (Array.isArray(codes) && codes.length && text) {
      const words = text.match(/[A-Za-z0-9_-]{3,20}/g) || [];
      const upperWords = new Set(words.map((w) => w.toUpperCase()));
      result.code = codes.find((c) => upperWords.has(String(c.code).toUpperCase())) || null;
    }
  } catch (err) {
    trace(`getDiscountContext: فشل فحص كود الخصم: ${err.message}`);
  }

  return result.vip || result.code ? result : null;
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
// locationContext (اختياري): لو الزبون بعت موقعه المباشر (بهاي الرسالة أو رسالة قبلها بنفس المحادثة)،
// منرفق الرقم/المسافة/الإحداثيات المحسوبة فعلياً بالكود مع الطلب — دقيق دايماً بغض النظر شو كتب الذكاء الاصطناعي بالملخص.
async function recordOrder(bot, from, channel, order, locationContext = null) {
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
      subtotal: typeof order.subtotal === "number" ? order.subtotal : null,
      deliveryFee: typeof order.deliveryFee === "number" ? order.deliveryFee : null,
      fulfillment: order.fulfillment || "",
      area: order.area || "",
      branch: order.branch || "",
      contactMethod: order.contactMethod || "",
      notes: order.notes || "",
      status: "new",
      channel,
      ...(locationContext
        ? {
            deliveryLocation: {
              lat: locationContext.lat,
              lng: locationContext.lng,
              address: locationContext.address || null,
              branch: locationContext.branch?.name || null,
              distanceKm: locationContext.distanceKm ?? null,
              deliveryFee: locationContext.fee ?? null,
              estimated: Boolean(locationContext.estimated),
            },
          }
        : {}),
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
        record.fulfillment === "pickup"
          ? `الاستلام: من الفرع${record.branch ? ` (${record.branch})` : ""}`
          : `المنطقة: ${record.area || "-"}`,
        record.subtotal !== null ? `مجموع الأصناف: ${record.subtotal} د.أ` : null,
        record.deliveryFee !== null && record.fulfillment !== "pickup" ? `رسم التوصيل: ${record.deliveryFee} د.أ` : null,
        record.total !== null ? `المجموع: ${record.total} د.أ` : null,
        record.name !== "زبون" ? `الاسم: ${record.name}` : null,
        `رقم التواصل: ${record.phone}`,
        record.contactMethod ? `طريقة التواصل: ${record.contactMethod}` : null,
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
 * @param {Array<{base64:string, mediaType:string}>} images - كل الصور يلي بعتها الزبون بنفس دفعة التجميع (ممكن تكون فاضية)
 * @param {(to:string, text:string) => Promise<void>} sendText - دالة الإرسال الخاصة بهاد البوت
 * @param {(to:string, imageUrl:string) => Promise<void>} [sendImage] - اختياري: دالة إرسال صورة (لإرسال صور الأصناف تلقائياً)
 * @param {string} [channel] - "whatsapp" | "messenger" | "instagram" — لتسجيله مع الطلب بس
 * @param {{lat:number, lng:number}|null} [location] - موقع مباشر بعته الزبون (Live/Pin Location) بهاي الرسالة (اختياري)
 */
async function handleIncomingMessage(botId, from, text, images, sendText, sendImage, channel = "whatsapp", location = null) {
  const imageList = Array.isArray(images) ? images.filter(Boolean) : images ? [images] : [];
  trace(`handleIncomingMessage: بدأت botId=${botId} from=${from} textLen=${text?.length || 0} imagesCount=${imageList.length} hasLocation=${!!location}`);
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
  // ملاحظة: كلمات الإيقاف/الاستئناف نفسها بتتفحص وتتنفذ فوراً بـ queueIncomingMessage (قبل ما توصل هون
  // أصلاً) — شوف checkTakeoverCommand/applyTakeoverCommand فوق. هون بس منتأكد المحادثة مش موقوفة حالياً.
  const pausedRaw = store.read(`bots/${botId}/pausedConversations.json`);
  const paused = Array.isArray(pausedRaw) ? {} : pausedRaw;

  if (paused[from]) {
    trace(`handleIncomingMessage: المحادثة مع ${from} موقوفة (تدخل بشري) — تجاهلت.`);
    return;
  }

  const conversationsRaw = store.read(`bots/${botId}/conversations.json`);
  const conversations = Array.isArray(conversationsRaw) ? {} : conversationsRaw;
  const history = conversations[from] || [];

  const customerProfile = getCustomerProfile(botId, from);
  const discountContext = await getDiscountContext(botId, bot.configId, from, text);

  // لو الزبون بعت موقعه المباشر بهاي الرسالة، بنحسب أقرب فرع/مسافة الطريق الفعلية/رسم التوصيل ونحفظه —
  // وإلا (زبون بعت الموقع برسالة سابقة وهلأ عم يأكد الطلب بس) بنستخدم آخر موقع محفوظ لنفس المحادثة.
  let locationContext = null;
  if (location && typeof location.lat === "number" && typeof location.lng === "number") {
    try {
      locationContext = await withTimeout(
        deliveryCalc.computeLocationDelivery(bot.configId, location.lat, location.lng),
        LOCATION_CALC_TIMEOUT_MS,
        "computeLocationDelivery"
      );
      saveStoredLocation(botId, from, locationContext);
      trace(
        `handleIncomingMessage: حسبت توصيل الموقع المباشر لـ ${from} (فرع=${locationContext.branch?.name || "-"}, مسافة=${locationContext.distanceKm ?? "-"}كم, رسم=${locationContext.fee ?? "-"}).`
      );
    } catch (err) {
      trace(`handleIncomingMessage: فشل حساب توصيل الموقع المباشر لـ ${from}: ${err.message}`);
      console.error("[messageHandler] فشل حساب توصيل الموقع المباشر:", err.message);
    }
  } else {
    locationContext = getStoredLocation(botId, from);
  }

  // لو الزبون بعت موقع بدون أي نص مرافق، منحط نص بديل واضح عشان المحادثة المحفوظة وطلب استرجاع الطلب
  // الفائت (recoverMissedOrder) يفهموا إنو صار حدث فعلي هالرسالة (مش رسالة فاضية).
  const effectiveUserMessage = text || (location ? "📍 [بعت موقعه المباشر]" : "");

  trace(`handleIncomingMessage: بدأت أستدعي generateReply لـ ${from} (historyLen=${history.length}, زبون سابق=${customerProfile ? "نعم" : "لا"}, خصم=${discountContext ? "نعم" : "لا"}, موقع=${locationContext ? "نعم" : "لا"})...`);
  let reply, order, requestedPhotos = [];
  try {
    const result = await withTimeout(
      generateReply(history, effectiveUserMessage, imageList, bot.configId, customerProfile, discountContext, locationContext),
      AI_TIMEOUT_MS,
      "generateReply"
    );
    reply = result.reply;
    order = result.order;
    requestedPhotos = result.requestedPhotos || [];
    trace(`handleIncomingMessage: رجع رد من generateReply لـ ${from} (replyLen=${reply?.length || 0}، order=${order ? "نعم" : "لا"}، صور مطلوبة=${requestedPhotos.length}).`);
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
      const mentioned = resolveRequestedPhotos(menu, requestedPhotos).slice(0, MAX_AUTO_IMAGES_PER_REPLY);
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
      order = await recoverMissedOrder(bot.configId, history, effectiveUserMessage, reply);
      trace(`handleIncomingMessage: محاولة استرجاع الطلب الفائت لـ ${from} ${order ? "نجحت ✅" : "رجعت بدون طلب"}.`);
    } catch (err) {
      trace(`handleIncomingMessage: فشلت محاولة استرجاع الطلب الفائت لـ ${from}: ${err.message}`);
      console.error("[messageHandler] فشل استرجاع طلب فائت:", err.message);
    }
  }

  if (order) {
    trace(`handleIncomingMessage: طلب مؤكد من ${from} — بلشت recordOrder...`);
    await recordOrder(bot, from, channel, order, locationContext);
  }

  history.push({ role: "user", content: effectiveUserMessage || (imageList.length > 1 ? "[صور]" : "[صورة]") });
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

// key: `${botId}::${from}` -> { parts, images, sendText, onTypingStart, timer }
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
  trace(`flushBuffer: key=${key} partsCount=${buffer.parts.length} combinedTextLen=${combinedText.length} imagesCount=${buffer.images.length} hasTypingFn=${!!buffer.onTypingStart}`);

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
    await handleIncomingMessage(botId, from, combinedText, buffer.images, buffer.sendText, buffer.sendImage, buffer.channel, buffer.location);
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
 * @param {{lat:number, lng:number}|null} [location] - موقع مباشر (Live/Pin Location) بعته الزبون بهاي الرسالة (اختياري)
 */
function queueIncomingMessage(botId, from, text, image, sendText, onTypingStart, sendImage, channel = "whatsapp", location = null) {
  if (!from) {
    trace(`queueIncomingMessage: تجاهلت — ما في from (botId=${botId}).`);
    return;
  }
  if (!text && !image && !location) {
    trace(`queueIncomingMessage: تجاهلت — ما في نص ولا صورة ولا موقع (botId=${botId} from=${from}).`);
    return;
  }

  const key = bufferKey(botId, from);

  // أمر إيقاف/استئناف — بيتفحص فوراً على الرسالة الخام (قبل ما تنضم لأي بفر تجميع منتظر)، عشان:
  // (1) لو في رسالة تانية عالقة بنفس نافذة التجميع، ما تنضم مع "وقف"/"كمل" وتخلي المطابقة تفشل،
  // (2) الرد يوصل فوراً (تأكيد قصير) بدل ما ينتظر مدة التجميع الكاملة زي رد عادي.
  if (text) {
    const bot = botStore.getBot(botId);
    // لو البوت موقوف كامل يدوياً، أو القناة هاي بالذات موقوفة، ما لازم نرد ولا حتى بتأكيد إيقاف/استئناف —
    // بنسيب الرسالة تكمل بالمسار العادي (بتنرمى بصمت جوا handleIncomingMessage زي أي رسالة تانية).
    const botActive = bot && bot.enabled !== false && !(bot.channelEnabled && bot.channelEnabled[channel] === false);
    const takeoverAction = botActive ? checkTakeoverCommand(botId, text) : null;
    if (takeoverAction) {
      const existingBuffer = pendingBuffers.get(key);
      if (existingBuffer) {
        clearTimeout(existingBuffer.timer);
        pendingBuffers.delete(key);
        trace(`queueIncomingMessage: أمر تحكم يدوي (${takeoverAction}) من ${from} — ألغيت بفر معلق كان بالانتظار.`);
      }
      applyTakeoverCommand(botId, from, takeoverAction, sendText).catch((err) => {
        trace(`queueIncomingMessage: خطأ بتنفيذ أمر التحكم اليدوي (${takeoverAction}) لـ ${from}: ${err.message}`);
        console.error("[messageHandler] خطأ بتنفيذ أمر التحكم اليدوي:", err.message);
      });
      return;
    }
  }

  const existing = pendingBuffers.get(key);
  const { debounceMs } = getTimingSettings(botId);

  if (existing) {
    if (text) existing.parts.push(text);
    // بعد التصحيح: منجمع كل صورة توصل بنفس نافذة التجميع بمصفوفة (مش نكتب فوق الصورة السابقة) — قبل هيك
    // كان `existing.image = image` بيمحي أي صورة سابقة وصلت بنفس الدفعة، فلو الزبون بعت صورتين ورا بعض
    // بسرعة، الذكاء الاصطناعي كان يشوف الثانية بس ويتجاهل الأولى بصمت (وممكن يرد عليها بشكل ناقص أو غلط).
    if (image && existing.images.length < MAX_INCOMING_IMAGES_PER_BATCH) existing.images.push(image);
    if (location) existing.location = location;
    existing.sendText = sendText;
    if (onTypingStart) existing.onTypingStart = onTypingStart;
    if (sendImage) existing.sendImage = sendImage;
    if (channel) existing.channel = channel;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushBuffer(key), debounceMs);
    trace(`queueIncomingMessage: أضفت لبفر موجود key=${key}، partsCount=${existing.parts.length}، imagesCount=${existing.images.length}، أعدت ضبط التايمر (${debounceMs}ms).`);
    return;
  }

  const buffer = {
    parts: text ? [text] : [],
    images: image ? [image] : [],
    location: location || null,
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

module.exports = { handleIncomingMessage, queueIncomingMessage, recordOrder };
