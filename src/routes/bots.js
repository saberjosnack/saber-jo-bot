const express = require("express");
const QRCode = require("qrcode");
const store = require("../services/store");
const botStore = require("../services/botStore");
const metaAuth = require("../services/metaAuth");
const { requireAuth, requireRole, requireBotAccess } = require("../middleware/auth");
const wa = require("../services/selfHostedWhatsapp");

const router = express.Router();
router.use(requireAuth);
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
    res.json(updated);
  } catch (err) {
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
router.post("/:id/facebook/select-page", requireRole("owner"), (req, res) => {
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
    res.json(updated.metaChannels);
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

// ---------- طلبات البوت ----------
router.get("/:id/orders", requireRole("owner", "orders", "viewer"), (req, res) => {
  res.json(store.read(`bots/${req.params.id}/orders.json`));
});

module.exports = router;
