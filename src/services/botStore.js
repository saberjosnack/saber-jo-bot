const { v4: uuid } = require("uuid");
const store = require("./store");

function listBots() {
  ensureDefaultBotExists();
  return store.read("bots.json");
}

function getBot(botId) {
  return listBots().find((b) => b.id === botId) || null;
}

// بيلاقي أي بوت مربوط بصفحة فيسبوك معينة (ماسنجر) عن طريق Page ID
function findBotByMetaPageId(pageId) {
  return listBots().find((b) => b.metaChannels?.messenger?.enabled && b.metaChannels.messenger.pageId === pageId) || null;
}

// بيلاقي أي بوت مربوط بحساب انستجرام بزنس معين عن طريق IG ID
function findBotByMetaIgId(igId) {
  return listBots().find((b) => b.metaChannels?.instagram?.enabled && b.metaChannels.instagram.igId === igId) || null;
}

function saveBots(bots) {
  store.write("bots.json", bots);
}

/**
 * ينشئ بوت جديد.
 * @param {string} name - اسم البوت
 * @param {string|null} shareConfigFromBotId - لو محدد، البوت الجديد بيستخدم نفس منيو/تعليمات هاد البوت (إعدادات مشتركة).
 *                                              لو null، بينعمل له قالب إعدادات مستقل (نسخة عن الافتراضي يبلش منها ويعدل عليها).
 */
function createBot(name, shareConfigFromBotId = null) {
  const bots = listBots();
  const id = uuid();

  let configId;

  if (shareConfigFromBotId) {
    const sourceBot = bots.find((b) => b.id === shareConfigFromBotId);
    if (!sourceBot) throw new Error("البوت المطلوب مشاركة إعداداته غير موجود.");
    configId = sourceBot.configId; // مشاركة فعلية — نفس ملفات المنيو والتعليمات بالضبط
  } else {
    configId = uuid();
    // ننسخ قالب افتراضي عشان البوت الجديد يبلش بمنيو وتعليمات فاضية منظمة، مو من الصفر
    store.write(`configs/${configId}/settings.json`, defaultSettingsTemplate(name));
    store.write(`configs/${configId}/menu.json`, []);
    store.write(`configs/${configId}/deliveryFees.json`, []);
  }

  store.write(`bots/${id}/conversations.json`, {});
  store.write(`bots/${id}/pausedConversations.json`, {});
  store.write(`bots/${id}/orders.json`, []);
  store.write(`bots/${id}/customers.json`, {});

  const newBot = {
    id,
    name,
    configId,
    status: "pending_connection", // لسا ما انربط بواتساب
    enabled: true, // زر التشغيل/الإيقاف — true يعني البوت يرد عادي
    waProvider: null, // null = يستخدم القيمة الافتراضية من إعدادات السيرفر (.env)
    waCredentials: {},
    metaChannels: {
      messenger: { enabled: false, pageId: "", pageAccessToken: "" },
      instagram: { enabled: false, igId: "", pageAccessToken: "" },
    },
    createdAt: new Date().toISOString(),
  };

  bots.push(newBot);
  saveBots(bots);
  return newBot;
}

function updateBot(botId, patch) {
  const bots = listBots();
  const idx = bots.findIndex((b) => b.id === botId);
  if (idx === -1) throw new Error("البوت غير موجود.");
  bots[idx] = { ...bots[idx], ...patch };
  saveBots(bots);
  return bots[idx];
}

function deleteBot(botId) {
  const bots = listBots();
  const filtered = bots.filter((b) => b.id !== botId);
  saveBots(filtered);
  // ملاحظة: ما بنحذف ملفات الـ config تلقائياً لأنو ممكن بوت تاني يشاركها
}

function defaultSettingsTemplate(employeeName) {
  return {
    identity: {
      employeeName,
      // اسم الشركة/المطعم وعنوانه ونوع نشاطه — لازم يتعبّى صح لكل بوت جديد، وإلا البوت رح يعرف حاله بمعلومات مطعم Saber Jo Snack افتراضياً
      businessName: "",
      businessAddress: "",
      businessType: "توصيل واستلام بس، بدون تناول بالمكان",
      open24h: false,
      openTime: "15:00",
      closeTime: "23:59",
      salesPower: "mid",
    },
    style: { tones: ["ودود"], emojiLevel: "low", responseLength: 400 },
    voice: { enabled: false, dialect: "الأردن", gender: "أنثى", voiceName: "رنا" },
    sendImagesAutomatically: true,
    // إعدادات سرعة الرد — قابلة للتحكم من الداشبورد (كل القيم بالثواني)
    timing: {
      debounceSec: 6, // كم ثانية ننتظر بعد آخر رسالة قبل ما نجمّع ونرد
      minDelaySec: 1.2, // أقل مدة "تفكير/كتابة" قبل الإرسال
      maxDelaySec: 6, // أقصى مدة قبل الإرسال (حتى لو الرد طويل)
    },
    guardrails: {
      "no-prices": true,
      "no-competitors": true,
      neutral: true,
      "no-medical": true,
      "no-fake-promise": true,
      privacy: true,
      "no-repeat": true,
      "no-links": true,
      "stay-on-topic": true,
      "no-inappropriate": true,
    },
    customRules: [],
    humanTakeover: { stopWords: ["وقف"], resumeWords: ["كمل"] },
    orderDestination: { mode: "dashboard", target: "" },
    prompt: `إنت "${employeeName}" — موظف بشري بيرد على واتساب. احكي طبيعي وودود، واسأل سؤال وحدة بكل مرة.`,
  };
}

// شبكة أمان: لو ملف بوتات ضاع أو انصفّر لأي سبب (مشكلة قرص، ديبلوي...)، البوت الأساسي بيرجع يتولد لحاله
function ensureDefaultBotExists() {
  const bots = store.read("bots.json");
  if (bots.some((b) => b.id === "default")) return;

  if (!store.exists("configs/default/settings.json")) return; // ما في قالب افتراضي أصلاً، ما نقدر نعمل شي

  bots.push({
    id: "default",
    name: "سابر (البوت الأساسي)",
    configId: "default",
    status: "active",
    enabled: true,
    waProvider: null, // بياخذ القيمة من .env تلقائياً
    waCredentials: {},
    metaChannels: {
      messenger: { enabled: false, pageId: "", pageAccessToken: "" },
      instagram: { enabled: false, igId: "", pageAccessToken: "" },
    },
    createdAt: new Date().toISOString(),
  });
  store.write("bots.json", bots);
  console.log("تم إعادة إنشاء البوت الأساسي تلقائياً (شبكة أمان).");
}

module.exports = { listBots, getBot, createBot, updateBot, deleteBot, findBotByMetaPageId, findBotByMetaIgId };
