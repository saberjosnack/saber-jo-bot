const express = require("express");
const cors = require("cors");
const path = require("path");
const env = require("./config/env");

const webhookRoutes = require("./routes/webhook");
const metaWebhookRoutes = require("./routes/metaWebhook");
const metaAuthCallbackRoutes = require("./routes/metaAuthCallback");
const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const botsRoutes = require("./routes/bots");
const qrPageRoutes = require("./routes/qrPage");

const app = express();

app.use(cors());
// بنحتفظ بالـ body الخام عشان نقدر نتحقق من توقيع ميتا (X-Hub-Signature-256) بويب هوك ماسنجر/انستجرام
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get("/", (req, res) => res.send("Saber Jo Snack bot API شغال ✅"));

// لازم ميتا (facebook) تنسجل قبل واتساب، وإلا مسار "/webhook/:botId" تبع واتساب بياخذها غلط (botId="facebook")
app.use("/webhook/facebook", metaWebhookRoutes);
app.use("/webhook", webhookRoutes);
// رجوع فيسبوك بعد "تسجيل الدخول" (OAuth) — لازم يكون بدون تسجيل دخول للداشبورد لأنو فيسبوك بيوجه المتصفح مباشرة
app.use("/api/meta", metaAuthCallbackRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/bots", botsRoutes);
app.use("/qr", qrPageRoutes);

// الداشبورد الحقيقي — صفحة واحدة، متصلة بالـ API فوق مباشرة
app.use("/dashboard", express.static(path.join(__dirname, "..", "public", "dashboard")));

// صور الأصناف المرفوعة من الداشبورد — لازم تكون بعنوان عام (URL) عشان واتساب/ماسنجر/انستجرام تقدر تجيبها
app.use("/uploads", express.static(path.join(__dirname, "data", "uploads")));

// بنشغل اتصالات الواتساب المباشرة (Baileys) دايماً بغض النظر عن WA_PROVIDER الافتراضي بالسيرفر،
// لأنو هلأ صار كل بوت يقدر يفعّل "الربط المباشر (QR)" لحاله من الداشبورد بغض النظر عن الإعداد العام.
// لو ما عملنا هيك، أي بوت مفعّل عليه الربط المباشر بيضل رمز QR تبعه "عم نجهز..." للأبد بعد أي
// إعادة تشغيل للسيرفر (زي بعد كل نشر جديد)، لأنو الاتصال (بالذاكرة) ما بيرجع يبلش من نفسه.
const wa = require("./services/selfHostedWhatsapp");
wa.startAllActiveBots().catch((err) => console.error("فشل بدء اتصالات البوتات:", err));

app.listen(env.port, () => {
  console.log(`Saber Jo Snack API شغال على المنفذ ${env.port}`);
  console.log(`WA_PROVIDER الحالي: ${env.waProvider}`);
});
