const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const QRCode = require("qrcode");
const store = require("../services/store");
const botStore = require("../services/botStore");
const metaAuth = require("../services/metaAuth");
const env = require("../config/env");
const { requireAuth, requireRole, requireBotAccess } = require("../middleware/auth");
const wa = require("../services/selfHostedWhatsapp");
const whatsapp = require("../services/whatsapp");
const { recordOrder } = require("../services/messageHandler");
const { recoverMissedOrder, looksLikeMissedOrderConfirmation } = require("../services/ai");
const posSync = require("../services/posSync");

const router = express.Router();
router.use(requireAuth);

// رفع صور الأصناف — بنخزنها بالذاكرة مؤقتاً لحد ما نكتبها لمجلد uploads يدوياً (فحص نوع/حجم الملف قبل الكتابة)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 ميغا كحد أقصى للصورة
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("نوع الملف لازم يكون صورة (jpg/png/webp)."), ok);
  },
});
router.use("/:id", requireBotAccess); // أي مسار فيه رقم بوت لازم يتأكد الموظف مسموحله فيه (المدير الكامل معفى دايماً)

// ---------- قائمة البوتات ----------
router.get("/", (req, res) => {
  res.json(botStore.listBots());
});

// ---------- إنشاء بوت جديد ----------
// body: { name: string, shareConfigFromBotId?: string }
// لو shareConfigFromBotId موجود، البوت الجديد بيستخدم نفس منيو وتعليمات هاد البوت بالضبط (إعدادات مشتركة حقيقية).
router.post("/", requireRole("owner"), (req, res) => {
  const { name, shareConfigFromBotId } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "اسم البوت مطلوب." });

  try {
    const bot = botStore.createBot(name.trim(), shareConfigFromBotId || null);
    wa.startBotConnection(bot.id).catch((err) => console.error("فشل بدء اتصال البوت الجديد:", err));
    res.status(201).json(bot);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- تفاصيل بوت واحد ----------
router.get("/:id", (req, res) => {
  const bot = botStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "البوت غير موجود." });
  res.json(bot);
});

// ---------- تعديل اسم البوت ----------
router.put("/:id", requireRole("owner"), (req, res) => {
  try {
    const updated = botStore.updateBot(req.params.id, { name: req.body.name });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- حذف بوت ----------
router.delete("/:id", requireRole("owner"), (req, res) => {
  botStore.deleteBot(req.params.id);
  res.json({ message: "تم حذف البوت." });
});

// ---------- رمز QR (يترجع كصورة base64 عشان الداشبورد يعرضه مباشرة) ----------
router.get("/:id/qr", async (req, res) => {
  const { status, qr } = wa.getQrStatus(req.params.id);

  if (status === "connected") return res.json({ status, qrImage: null });
  if (!qr) return res.json({ status: status || "connecting", qrImage: null });

  const qrImage = await QRCode.toDataURL(qr);
  res.json({ status, qrImage });
});

// ---------- إيقاف/تشغيل البوت (زر واحد بالداشبورد) ----------
router.post("/:id/stop", requireRole("owner", "orders"), (req, res) => {
  try {
    const updated = botStore.updateBot(req.params.id, { enabled: false });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/:id/start", requireRole("owner", "orders"), (req, res) => {
  try {
    const updated = botStore.updateBot(req.params.id, { enabled: true });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- تشغيل/إيقاف كل منصة (واتساب/ماسنجر/انستجرام) لحالها لهاد البوت ----------
// body: { channelEnabled: { whatsapp?: bool, messenger?: bool, instagram?: bool } }
router.put("/:id/channels", requireRole("owner", "orders"), (req, res) => {
  try {
    const bot = botStore.getBot(req.params.id);
    if (!bot) return res.status(404).json({ error: "البوت غير موجود." });
    const current = bot.channelEnabled || { whatsapp: true, messenger: true, instagram: true };
    const updated = botStore.updateBot(req.params.id, { channelEnabled: { ...current, ...req.body.channelEnabled } });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- إعدادات الربط بواتساب (المزود والمفاتيح) — بدل ما تتعدل يدوياً من Render ----------
router.get("/:id/connection", requireRole("owner"), (req, res) => {
  const bot = botStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "البوت غير موجود." });
  res.json({ waProvider: bot.waProvider, waCredentials: bot.waCredentials || {} });
});

// body: { waProvider: "wasender"|"green"|"ultramsg"|"cloud", waCredentials: {...} }
router.put("/:id/connection", requireRole("owner"), (req, res) => {
  try {
    const { waProvider, waCredentials } = req.body;
    const updated = botStore.updateBot(req.params.id, {
      waProvider: waProvider || null,
      waCredentials: waCredentials || {},
    });

    // لو المزود المختار "اتصال مباشر" ومش متصل حالياً، منبلش الاتصال فوراً — قبل هاد الإصلاح، تبديل بوت موجود
    // أصلاً لمزود "اتصال مباشر" (أو إعادة حفظ نفس الإعداد) ما كان يشغّل أي اتصال أبداً، فيضل واقف على "عم نجهز رمز QR..." للأبد.
    if (waProvider === "selfhosted") {
      const { status } = wa.getQrStatus(req.params.id);
      if (!["connected", "connecting", "waiting_for_scan"].includes(status)) {
        wa.startBotConnection(req.params.id).catch((err) =>
          console.error(`فشل بدء اتصال البوت ${req.params.id} بعد تغيير المزود لـ"اتصال مباشر":`, err.message)
        );
      }
    }

    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// زر "إعادة تشغيل الاتصال" بالداشبورد — لما الاتصال المباشر (QR) يعلق منقطع وما عم يرجع يتصل لحاله
router.post("/:id/whatsapp-restart", requireRole("owner", "orders"), async (req, res) => {
  try {
    const bot = botStore.getBot(req.params.id);
    if (!bot) return res.status(404).json({ error: "البوت غير موجود." });
    if (bot.waProvider !== "selfhosted") {
      return res.status(400).json({ error: "زر إعادة التشغيل هاد بس لبوتات الاتصال المباشر (QR)." });
    }
    await wa.restartBotConnection(bot.id);
    res.json({ message: "تم إعادة تشغيل الاتصال — استنى ثواني ويطلع رمز QR لو الجلسة القديمة انتهت." });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- ربط نظام الكاشير (POS) — مزامنة المنيو وأكواد الخصم من App-sjs ----------
// تشغيل/إيقاف المزامنة التلقائية (كل ساعة) لهاد البوت — التوفر الفعلي لربط الكاشير نفسه (رابط/مفتاح Supabase)
// معرّف على مستوى السيرفر كله (env)، مش لكل بوت، لأنو حالياً POS واحد بس مربوط.
router.put("/:id/pos-sync", requireRole("owner"), (req, res) => {
  try {
    const bot = botStore.getBot(req.params.id);
    if (!bot) return res.status(404).json({ error: "البوت غير موجود." });
    const updated = botStore.updateBot(req.params.id, {
      posSync: { ...bot.posSync, enabled: Boolean(req.body.enabled) },
    });
    res.json(updated.posSync);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// زر "تحديث الآن" بالداشبورد — يسحب المنيو وأكواد الخصم من الكاشير فوراً بدل ما ينتظر المزامنة التلقائية (كل ساعة)
router.post("/:id/pos-sync/run", requireRole("owner", "orders"), async (req, res) => {
  try {
    const bot = botStore.getBot(req.params.id);
    if (!bot) return res.status(404).json({ error: "البوت غير موجود." });
    if (!posSync.posConfigured()) {
      return res.status(400).json({ error: "ربط الكاشير مش مفعّل بالسيرفر بعد (POS_SUPABASE_URL/POS_SUPABASE_KEY)." });
    }
    const result = await posSync.syncBotFromPos(req.params.id);
    const updated = botStore.updateBot(req.params.id, {
      posSync: { ...bot.posSync, lastSyncAt: new Date().toISOString(), lastError: null },
    });
    res.json({ ...result, posSync: updated.posSync });
  } catch (err) {
    botStore.updateBot(req.params.id, {
      posSync: { ...botStore.getBot(req.params.id)?.posSync, lastSyncAt: new Date().toISOString(), lastError: err.message },
    });
    res.status(400).json({ error: err.message });
  }
});

// ---------- ربط ماسنجر/انستجرام (منصات ميتا) ----------
router.get("/:id/meta-connection", requireRole("owner"), (req, res) => {
  const bot = botStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "البوت غير موجود." });
  res.json(
    bot.metaChannels || {
      messenger: { enabled: false, pageId: "", pageAccessToken: "" },
      instagram: { enabled: false, igId: "", pageAccessToken: "" },
    }
  );
});

// body: { messenger?: {enabled, pageId, pageAccessToken}, instagram?: {enabled, igId, pageAccessToken} }
router.put("/:id/meta-connection", requireRole("owner"), (req, res) => {
  try {
    const bot = botStore.getBot(req.params.id);
    if (!bot) return res.status(404).json({ error: "البوت غير موجود." });

    const current = bot.metaChannels || {};
    const updated = botStore.updateBot(req.params.id, {
      metaChannels: {
        messenger: { ...current.messenger, ...req.body.messenger },
        instagram: { ...current.instagram, ...req.body.instagram },
      },
    });
    res.json(updated.metaChannels);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- تسجيل الدخول بفيسبوك (بديل عن لصق التوكنز يدوياً) ----------

// الخطوة 1: الداشبورد بيطلب رابط تسجيل الدخول، وبيوجه المتصفح كامل إلو (window.location)
router.get("/:id/facebook/login-url", requireRole("owner"), (req, res) => {
  try {
    res.json({ url: metaAuth.buildLoginUrl(req.params.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// الخطوة 2 (بعد ما فيسبوك يرجّع المستخدم عن طريق /api/meta/facebook-callback):
// الداشبورد بيسأل شو الصفحات يلي طلعت جاهزة يختار منها
router.get("/:id/facebook/pages", requireRole("owner"), (req, res) => {
  const raw = metaAuth.getPendingPages(req.params.id);
  console.log(`[meta-auth] الداشبورد طلب صفحات البوت ${req.params.id} — لقينا ${raw.length}.`);
  const pages = raw.map((p) => ({
    id: p.id,
    name: p.name,
    hasInstagram: !!p.instagram_business_account,
    instagramUsername: p.instagram_business_account?.username || null,
  }));
  res.json(pages);
});

// الخطوة 3: صاحب البوت بيختار صفحة معينة، ومنحفظ توكناتها تلقائياً (بدون ما يشوفها أو يلصقها)
// body: { pageId: string }
router.post("/:id/facebook/select-page", requireRole("owner"), async (req, res) => {
  try {
    const { pageId } = req.body;
    const page = metaAuth.consumeSelectedPage(req.params.id, pageId);
    if (!page) {
      return res.status(400).json({ error: "الصفحة مش موجودة أو انتهت صلاحية الجلسة — أعد تسجيل الدخول بفيسبوك من جديد." });
    }

    const updated = botStore.updateBot(req.params.id, {
      metaChannels: {
        messenger: { enabled: true, pageId: page.id, pageName: page.name, pageAccessToken: page.access_token },
        instagram: page.instagram_business_account
          ? {
              enabled: true,
              igId: page.instagram_business_account.id,
              igUsername: page.instagram_business_account.username || "",
              pageAccessToken: page.access_token,
            }
          : { enabled: false, igId: "", igUsername: "", pageAccessToken: "" },
      },
    });

    // خطوة ضرورية بس مش شرط تفشل الطلب لو ما نجحت — بدون هاي الخطوة الصفحة ما بترجع تستقبل رسائل عالويب هوك
    let webhookSubscribeWarning = null;
    try {
      await metaAuth.subscribePageToWebhook(page.id, page.access_token);
      console.log(`[meta-auth] تم اشتراك الصفحة ${page.name} (${page.id}) بويب هوك التطبيق بنجاح.`);
    } catch (err) {
      console.error(`[meta-auth] فشل اشتراك الصفحة ${page.name} بويب هوك التطبيق:`, err.message);
      webhookSubscribeWarning = "الصفحة انربطت، بس صار خطأ أثناء تفعيل استقبال الرسائل تلقائياً — جرب زر (إعادة تفعيل استقبال الرسائل) بعدين.";
    }

    res.json({ ...updated.metaChannels, webhookSubscribeWarning });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// زر احتياطي: يعيد الاشتراك بويب هوك ماسنجر لصفحة مربوطة أصلاً (لو صار خطأ بالمرة الأولى، أو فيسبوك ألغى الاشتراك لأي سبب)
router.post("/:id/facebook/resubscribe-webhook", requireRole("owner"), async (req, res) => {
  try {
    const bot = botStore.getBot(req.params.id);
    if (!bot?.metaChannels?.messenger?.enabled || !bot.metaChannels.messenger.pageAccessToken) {
      return res.status(400).json({ error: "ما في صفحة ماسنجر مربوطة بهاد البوت." });
    }
    await metaAuth.subscribePageToWebhook(bot.metaChannels.messenger.pageId, bot.metaChannels.messenger.pageAccessToken);
    res.json({ message: "تم تفعيل استقبال الرسائل من جديد ✅" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- منيو البوت (تبع الـ config الخاص فيه أو المشترك) ----------
router.get("/:id/menu", (req, res) => {
  const bot = botStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "البوت غير موجود." });
  res.json(store.read(`configs/${bot.configId}/menu.json`));
});

router.put("/:id/menu", requireRole("owner", "orders"), (req, res) => {
  const bot = botStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "البوت غير موجود." });
  store.write(`configs/${bot.configId}/menu.json`, req.body);
  res.json({ message: "تم تحديث المنيو." });
});

// ---------- صورة صنف بالمنيو (البوت بيستخدمها ليرسلها تلقائياً للزبون لو الإعداد مفعّل) ----------
// بنلف multer بدالة صغيرة عشان أي خطأ فيه (حجم/نوع الملف) يرجع JSON واضح للداشبورد بدل صفحة خطأ HTML عامة
function uploadSingleImage(req, res, next) {
  upload.single("image")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || "فشل رفع الصورة." });
    next();
  });
}

router.post("/:id/menu/:itemId/image", requireRole("owner", "orders"), uploadSingleImage, (req, res) => {
  const bot = botStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "البوت غير موجود." });
  if (!req.file) return res.status(400).json({ error: "ما في صورة مرفوعة." });

  const extByMime = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  const ext = extByMime[req.file.mimetype] || "jpg";
  const dir = path.join(__dirname, "..", "data", "uploads", "menu", bot.configId);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${req.params.itemId}.${ext}`;
  fs.writeFileSync(path.join(dir, filename), req.file.buffer);

  // ?v= عشان نكسر أي كاش قديم لو المالك بدّل الصورة بعدين لنفس الصنف
  const imageUrl = `${env.appBaseUrl}/uploads/menu/${bot.configId}/${filename}?v=${Date.now()}`;

  const menu = store.read(`configs/${bot.configId}/menu.json`);
  // مقارنة كنص دايماً — أصناف مضافة يدوياً معرّفها رقم (Date.now())، وأصناف مزامَنة من الكاشير معرّفها
  // نص (UUID)، فمقارنة Number() القديمة كانت رح تفشل بصمت (NaN) على أي صنف جاي من الكاشير.
  const updated = menu.map((i) => (String(i.id) === req.params.itemId ? { ...i, imageUrl } : i));
  store.write(`configs/${bot.configId}/menu.json`, updated);

  res.json({ imageUrl });
});

router.delete("/:id/menu/:itemId/image", requireRole("owner", "orders"), (req, res) => {
  const bot = botStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "البوت غير موجود." });

  const menu = store.read(`configs/${bot.configId}/menu.json`);
  const updated = menu.map((i) => (String(i.id) === req.params.itemId ? { ...i, imageUrl: null } : i));
  store.write(`configs/${bot.configId}/menu.json`, updated);

  res.json({ message: "تم حذف صورة الصنف." });
});

// ---------- إعدادات/برومبت البوت ----------
router.get("/:id/settings", (req, res) => {
  const bot = botStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "البوت غير موجود." });
  res.json(store.read(`configs/${bot.configId}/settings.json`));
});

router.put("/:id/settings", requireRole("owner"), (req, res) => {
  const bot = botStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "البوت غير موجود." });
  const current = store.read(`configs/${bot.configId}/settings.json`);
  const updated = { ...current, ...req.body };
  store.write(`configs/${bot.configId}/settings.json`, updated);
  res.json(updated);
});

// ---------- أسعار توصيل البوت ----------
router.get("/:id/delivery-fees", (req, res) => {
  const bot = botStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "البوت غير موجود." });
  res.json(store.read(`configs/${bot.configId}/deliveryFees.json`));
});

router.put("/:id/delivery-fees", requireRole("owner"), (req, res) => {
  const bot = botStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "البوت غير موجود." });
  store.write(`configs/${bot.configId}/deliveryFees.json`, req.body);
  res.json({ message: "تم التحديث." });
});

// ---------- فروع البوت (موقع + ساعات دوام كل فرع) — قائمة مفتوحة بدون سقف (فرع واحد أو أكتر بنفس الشكل) ----------
// تستخدم لتحديد أقرب فرع وحساب مسافة/رسم التوصيل تلقائياً لما الزبون يبعت موقعه المباشر (شوف deliveryCalc.js).
router.get("/:id/branches", (req, res) => {
  const bot = botStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "البوت غير موجود." });
  res.json(store.exists(`configs/${bot.configId}/branches.json`) ? store.read(`configs/${bot.configId}/branches.json`) : []);
});

// body: مصفوفة فروع كاملة [{id, name, lat, lng, address, mapLink, open24h, openTime, closeTime}, ...]
router.put("/:id/branches", requireRole("owner"), (req, res) => {
  const bot = botStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "البوت غير موجود." });

  const branches = Array.isArray(req.body) ? req.body : null;
  if (!branches) return res.status(400).json({ error: "لازم تبعت مصفوفة فروع." });

  for (const b of branches) {
    if (!b.name?.trim()) return res.status(400).json({ error: "كل فرع لازم يكون له اسم." });
    if (typeof b.lat !== "number" || typeof b.lng !== "number" || Number.isNaN(b.lat) || Number.isNaN(b.lng)) {
      return res.status(400).json({ error: `فرع "${b.name}" لازم يكون له إحداثيات (خط عرض/طول) صحيحة.` });
    }
  }

  store.write(`configs/${bot.configId}/branches.json`, branches);
  res.json({ message: "تم تحديث الفروع." });
});

// ---------- طلبات البوت ----------
router.get("/:id/orders", requireRole("owner", "orders", "viewer"), (req, res) => {
  res.json(store.read(`bots/${req.params.id}/orders.json`));
});

// إدخال طلب يدوياً — تستخدم لتصحيح طلبات "ضاعت" (اتأكدت للزبون بالمحادثة بس ما انسجلت فعلياً) بعد
// ما نتأكد يدوياً من تفاصيلها الصحيحة الوحيدة النهائية (تفادياً لتكرار نفس الطلب لو انأكد أكتر من مرة بنفس المحادثة).
// body: { from, itemsSummary, area, totalPrice?, customerName?, contactPhone?, notes?, channel? }
router.post("/:id/orders/manual", requireRole("owner"), async (req, res) => {
  const bot = botStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "البوت غير موجود." });

  const { from, itemsSummary, area, totalPrice, customerName, contactPhone, notes, channel } = req.body;
  if (!from || !itemsSummary || !area) {
    return res.status(400).json({ error: "لازم from و itemsSummary و area." });
  }

  try {
    await recordOrder(
      bot,
      from,
      channel || "manual",
      {
        itemsSummary,
        area,
        totalPrice: typeof totalPrice === "number" ? totalPrice : null,
        customerName: customerName || "",
        contactPhone: contactPhone || "",
        notes: notes || "",
      }
    );
    const orders = store.read(`bots/${bot.id}/orders.json`);
    res.json({ ok: true, order: orders[orders.length - 1] });
  } catch (err) {
    console.error("[orders/manual] خطأ:", err);
    res.status(500).json({ error: "فشل تسجيل الطلب اليدوي: " + err.message });
  }
});

// تحديث حالة طلب — مستخدم حالياً لزر "تم إرسال الطلب لشركة التوصيل" (بيحوّل الطلب لـ "مكتمل" ويطلعه من القائمة الحالية)
// body: { status: "new" | "completed" }
router.patch("/:id/orders/:orderId", requireRole("owner", "orders"), (req, res) => {
  const { status } = req.body;
  if (!["new", "completed"].includes(status)) {
    return res.status(400).json({ error: "حالة الطلب لازم تكون new أو completed." });
  }
  const orders = store.read(`bots/${req.params.id}/orders.json`);
  const idx = orders.findIndex((o) => o.id === req.params.orderId);
  if (idx === -1) return res.status(404).json({ error: "الطلب غير موجود." });

  orders[idx] = { ...orders[idx], status, completedAt: status === "completed" ? new Date().toISOString() : null };
  store.write(`bots/${req.params.id}/orders.json`, orders);
  res.json(orders[idx]);
});

// ---------- استرجاع الطلبات "الضايعة" (زبون اتأكدله الطلب بالمحادثة بس ما انسجل فعلياً بلوحة التحكم) ----------
// أداة تنظيف لمرة وحدة (مش ميزة دائمة) — بتفحص أرشيف المحادثات القديم لهاد البوت بس (معزول تماماً عن أي بوت تاني)
// وبتحاول تسترجع أي طلب "ضاع" بنفس آلية الاسترجاع المستخدمة تلقائياً هلأ لأي طلب جديد (شوف ai.js/messageHandler.js).
// افتراضياً بتشتغل "معاينة فقط" (dryRun) بدون ما تكتب أي شي — لازم ?apply=true صراحة عشان تسجل الطلبات فعلياً.
router.post("/:id/recover-missed-orders", requireRole("owner"), async (req, res) => {
  const bot = botStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "البوت غير موجود." });

  const apply = req.query.apply === "true";

  try {
    const conversationsRaw = store.read(`bots/${bot.id}/conversations.json`);
    const conversations = Array.isArray(conversationsRaw) ? {} : conversationsRaw;

    const ordersRaw = store.read(`bots/${bot.id}/orders.json`);
    const orders = Array.isArray(ordersRaw) ? ordersRaw : [];

    // كم طلب مسجل فعلياً لكل زبون (حسب رقم/معرّف التواصل) — عشان نقارنه بعدد مرات "التأكيد" بالمحادثة
    const recordedCountByFrom = {};
    for (const o of orders) {
      const key = o.phone || "";
      recordedCountByFrom[key] = (recordedCountByFrom[key] || 0) + 1;
    }

    const recovered = [];
    const needsManualReview = [];
    let scanned = 0;

    for (const [from, messages] of Object.entries(conversations)) {
      if (!Array.isArray(messages) || !messages.length) continue;
      scanned++;

      const confirmIndices = messages
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => m.role === "assistant" && looksLikeMissedOrderConfirmation(m.content))
        .map(({ i }) => i);

      if (!confirmIndices.length) continue;

      const recordedCount = recordedCountByFrom[from] || 0;
      const missingCount = confirmIndices.length - recordedCount;
      if (missingCount <= 0) continue; // كل التأكيدات إلها طلبات مسجلة أصلاً (على الأقل بالعدد)

      // منفترض إنو أقدم تأكيد (تأكيدات) هي يلي انسجلت فعلاً، والأحدث هي يلي "ضاعت" — نجرب نسترجع آخر missingCount منهم بس
      const targetIndices = confirmIndices.slice(-missingCount);

      for (const idx of targetIndices) {
        const assistantReply = messages[idx].content;
        // أقرب رسالة زبون قبل هاد التأكيد
        let userIdx = idx - 1;
        while (userIdx >= 0 && messages[userIdx].role !== "user") userIdx--;
        if (userIdx < 0) {
          needsManualReview.push({ from, reason: "ما لقيت رسالة الزبون قبل التأكيد", messageIndex: idx });
          continue;
        }
        const userMessage = messages[userIdx].content;
        const history = messages.slice(0, userIdx);

        try {
          const order = await recoverMissedOrder(bot.configId, history, userMessage, assistantReply);
          if (!order) {
            needsManualReview.push({ from, reason: "الذكاء الاصطناعي ما قدر يستخرج تفاصيل الطلب", messageIndex: idx });
            continue;
          }

          const channel = from.length <= 15 ? "whatsapp" : "messenger_or_instagram";
          const preview = {
            from,
            channel,
            itemsSummary: order.itemsSummary,
            area: order.area,
            totalPrice: order.totalPrice ?? null,
            customerName: order.customerName || "",
            assistantReplyPreview: (assistantReply || "").slice(0, 80),
          };

          if (apply) {
            await recordOrder(bot, from, channel, order);
            recovered.push({ ...preview, saved: true });
          } else {
            recovered.push({ ...preview, saved: false });
          }
        } catch (err) {
          needsManualReview.push({ from, reason: `فشل الاسترجاع: ${err.message}`, messageIndex: idx });
        }
      }
    }

    res.json({
      botId: bot.id,
      botName: bot.name,
      mode: apply ? "applied" : "dryRun",
      conversationsScanned: scanned,
      recoveredCount: recovered.length,
      recovered,
      needsManualReview,
    });
  } catch (err) {
    console.error("[recover-missed-orders] خطأ عام:", err);
    res.status(500).json({ error: "فشل فحص الطلبات الضايعة: " + err.message });
  }
});

// ---------- سجل المحادثات (تبويب "المحادثات" بالداشبورد) — عشان نتأكد شو استقبل/رد البوت فعلياً لكل زبون،
// ونكتشف بسرعة لو في محادثة ما انسجلها كطلب أو انقطعت بمنتصفها.
router.get("/:id/conversations", requireRole("owner", "orders", "viewer"), (req, res) => {
  const bot = botStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "البوت غير موجود." });

  const conversationsRaw = store.read(`bots/${req.params.id}/conversations.json`);
  const conversations = Array.isArray(conversationsRaw) ? {} : conversationsRaw;

  const customersRaw = store.exists(`bots/${req.params.id}/customers.json`) ? store.read(`bots/${req.params.id}/customers.json`) : {};
  const customers = Array.isArray(customersRaw) ? {} : customersRaw;

  const lastActivityRaw = store.exists(`bots/${req.params.id}/lastActivity.json`)
    ? store.read(`bots/${req.params.id}/lastActivity.json`)
    : {};
  const lastActivity = Array.isArray(lastActivityRaw) ? {} : lastActivityRaw;

  const pausedRaw = store.read(`bots/${req.params.id}/pausedConversations.json`);
  const paused = Array.isArray(pausedRaw) ? {} : pausedRaw;

  const list = Object.keys(conversations).map((from) => ({
    from,
    name: customers[from]?.name || "",
    phone: customers[from]?.phone || from,
    area: customers[from]?.area || "",
    paused: !!paused[from],
    lastMessageAt: lastActivity[from] || null,
    // hasOrdered: عرفناها بوجود سجل بملف الزبائن — هاد الملف بس بينكتب لما طلب يتأكد فعلياً (recordOrder)،
    // فوجوده معناه أكيد إن هاد الزبون طلب قبل هيك مرة وحدة عالأقل — مو مجرد محادثة بدون طلب.
    hasOrdered: Boolean(customers[from]),
    lastOrderAt: customers[from]?.lastOrderAt || null,
    lastItems: customers[from]?.lastItems || [],
    messages: conversations[from] || [],
  }));

  // الأحدث أولاً (يلي ما عندهم وقت مسجل بعد — من قبل ما ضفنا هاي الميزة — بيطلعوا آخر شي)
  list.sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));

  res.json(list);
});

// ---------- قائمة جروبات الواتساب — عشان المالك يختار جروب "وجهة الطلبات" من الداشبورد مباشرة ----------
router.get("/:id/whatsapp-groups", requireRole("owner"), async (req, res) => {
  const bot = botStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "البوت غير موجود." });
  try {
    // الاتصال المباشر (QR/Baileys) بيدعم جروبات مجاناً بدون أي وسيط خارجي؛ وإلا منستخدم API المزود المستضاف
    const groups = bot.waProvider === "selfhosted" ? await wa.getGroups(bot.id) : await whatsapp.getGroups(bot);
    res.json(groups);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
