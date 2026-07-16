const express = require("express");
const QRCode = require("qrcode");
const store = require("../services/store");
const botStore = require("../services/botStore");
const { requireAuth, requireRole } = require("../middleware/auth");
const wa = require("../services/selfHostedWhatsapp");

const router = express.Router();
router.use(requireAuth);

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
