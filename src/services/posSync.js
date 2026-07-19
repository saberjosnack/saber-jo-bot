const env = require("../config/env");
const store = require("./store");
const botStore = require("./botStore");

// بيانات ربط الكاشير (POS) — Supabase مشترك مع تطبيق الكاشير (App-sjs). بنقرأ بس (GET عن طريق REST مباشرة)،
// ما بنكتب ولا نعدّل أي شي بقاعدة بيانات الكاشير من هون إطلاقاً.
function posConfigured() {
  return Boolean(env.posSupabaseUrl && env.posSupabaseKey);
}

async function posGet(path) {
  if (!posConfigured()) throw new Error("ربط الكاشير (POS) مش مفعّل — لازم POS_SUPABASE_URL وPOS_SUPABASE_KEY بالسيرفر.");
  const url = `${env.posSupabaseUrl.replace(/\/$/, "")}/rest/v1/${path}`;
  const res = await fetch(url, {
    headers: {
      apikey: env.posSupabaseKey,
      Authorization: `Bearer ${env.posSupabaseKey}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`فشل الاتصال بالكاشير (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

// كل الأصناف (متاحة وغير متاحة — منعرض التوفر نفسه بالبوت، مش منخفي الصنف كامل لو صار غير متوفر مؤقتاً)
async function fetchPosMenuItems() {
  return posGet("menu_items?select=id,name_ar,category,price,is_available,item_type,image_url,sort_order&order=sort_order");
}

// أكواد الخصم الفعالة بس — الموقوفة ما إلها داعي نخزنها عند البوت
async function fetchPosActiveDiscountCodes() {
  return posGet("discount_codes?select=code,kind,value&is_active=eq.true");
}

// خصم VIP لزبون معيّن برقم هاتفه — استعلام حي وقت الحاجة (مش مزامنة جماعية) لأنو جدول الزبائن كبير ومتغيّر،
// وإحنا بس محتاجين نعرف عن زبون واحد بالضبط بكل محادثة.
async function fetchPosCustomerVip(phone) {
  if (!phone || !posConfigured()) return null;
  // البوت بيستقبل الرقم بصيغة دولية (مثلاً 962790807761)، بس الكاشير بيخزّن رقم الزبون بصيغة محلية
  // (0790807761 — شوف App-sjs: waPhone = phone.startsWith('0') ? '962'+phone.slice(1) : phone).
  // بدل ما نراهن على صيغة وحدة، منقارن بآخر 9 أرقام بس (الرقم المحلي الفعلي بدون كود الدولة/الصفر)
  // عن طريق ilike — بتطابق الرقم بغض النظر عن الصيغة المخزّنة فيه بالكاشير.
  const digits = phone.replace(/\D/g, "");
  const significant = digits.slice(-9);
  if (significant.length < 9) return null;
  try {
    const rows = await posGet(`customers?select=name,vip_discount_percent&phone=ilike.*${encodeURIComponent(significant)}&limit=1`);
    const row = rows?.[0];
    if (!row || !row.vip_discount_percent || row.vip_discount_percent <= 0) return null;
    return { percent: row.vip_discount_percent, name: row.name || null };
  } catch (err) {
    console.error("[posSync] فشل جلب خصم VIP من الكاشير:", err.message);
    return null; // فشل هالفحص لازم ما يوقف باقي المحادثة — الزبون ببساطة ما بياخذ خصم VIP هالمرة
  }
}

// بيدمج أصناف الكاشير مع منيو البوت الحالي — الكاشير هو مصدر الحقيقة لوجود الصنف وسعره وتوفره وصورته،
// بس منحافظ على "صنف مميز" (featured/featuredNote) يلي المالك حدده يدوياً من داشبورد البوت لنفس الصنف
// (مطابقة عن طريق posId الثابت، مش الاسم، عشان تغيير بسيط بالاسم ما يكسر الربط ولا يفقد صفة "مميز").
function mergeMenu(existingMenu, posItems) {
  const existingByPosId = new Map(existingMenu.filter((i) => i.posId).map((i) => [i.posId, i]));

  return posItems.map((p) => {
    const prev = existingByPosId.get(p.id);
    return {
      // id لازم يبقى ثابت ومطابق لمعرّف الكاشير — الداشبورد (تبويب المنيو، رفع صور الأصناف) بيعتمد على
      // حقل "id" بالضبط عشان يعرف/يعدّل الصنف (شوف routes/bots.js: /menu/:itemId/image).
      id: p.id,
      posId: p.id,
      name: p.name_ar || prev?.name || "",
      category: p.category || prev?.category || "",
      price: typeof p.price === "number" ? p.price : null,
      available: Boolean(p.is_available),
      // ما بنجيب صورة الكاشير (image_url) — هناك مخزّنة كـ base64 data-URL ضخم مش رابط حقيقي، وما بينشتغل
      // مع طريقة إرسال الصور الحالية بالبوت (واتساب/ماسنجر/انستجرام بتحتاج رابط http حقيقي). المالك برفع
      // صورة الصنف من داشبورد البوت نفسه (تبويب المنيو) زي ما هو معتاد، وهاي بتضل محفوظة عبر أي تحديث.
      imageUrl: prev?.imageUrl || "",
      featured: prev?.featured || false,
      featuredNote: prev?.featuredNote || "",
    };
  });
}

/**
 * بيسحب المنيو وأكواد الخصم من الكاشير لبوت معيّن، ويحفظهم بملفات الإعدادات تبع نفس البوت.
 * @param {string} botId
 * @returns {Promise<{itemsSynced:number, codesSynced:number}>}
 */
async function syncBotFromPos(botId) {
  const bot = botStore.getBot(botId);
  if (!bot) throw new Error("البوت غير موجود.");

  const [posItems, posCodes] = await Promise.all([fetchPosMenuItems(), fetchPosActiveDiscountCodes()]);

  const existingMenu = store.read(`configs/${bot.configId}/menu.json`);
  const mergedMenu = mergeMenu(Array.isArray(existingMenu) ? existingMenu : [], posItems || []);
  store.write(`configs/${bot.configId}/menu.json`, mergedMenu);
  store.write(`configs/${bot.configId}/discountCodes.json`, posCodes || []);

  return { itemsSynced: mergedMenu.length, codesSynced: (posCodes || []).length };
}

// بيشغّل المزامنة لكل بوت مفعّل عليه posSync.enabled — بيكمل حتى لو بوت واحد فشل (ما يوقف الباقي)،
// وبيسجل وقت/نتيجة آخر محاولة على البوت نفسه عشان الداشبورد يعرضها.
async function runScheduledPosSync() {
  const bots = botStore.listBots().filter((b) => b.posSync?.enabled);
  for (const bot of bots) {
    try {
      const result = await syncBotFromPos(bot.id);
      botStore.updateBot(bot.id, {
        posSync: { ...bot.posSync, lastSyncAt: new Date().toISOString(), lastError: null },
      });
      console.log(`[posSync] مزامنة ${bot.name}: ${result.itemsSynced} صنف، ${result.codesSynced} كود خصم.`);
    } catch (err) {
      botStore.updateBot(bot.id, {
        posSync: { ...bot.posSync, lastSyncAt: new Date().toISOString(), lastError: err.message },
      });
      console.error(`[posSync] فشلت مزامنة ${bot.name}:`, err.message);
    }
  }
}

module.exports = {
  posConfigured,
  fetchPosCustomerVip,
  syncBotFromPos,
  runScheduledPosSync,
};
