require("dotenv").config();

module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me",

  aiApiKey: process.env.ANTHROPIC_API_KEY,
  aiModel: process.env.AI_MODEL || "claude-haiku-4-5-20251001",

  waProvider: process.env.WA_PROVIDER || "green",
  greenApiInstanceId: process.env.GREEN_API_INSTANCE_ID,
  greenApiToken: process.env.GREEN_API_TOKEN,

  ultramsgInstanceId: process.env.ULTRAMSG_INSTANCE_ID,
  ultramsgToken: process.env.ULTRAMSG_TOKEN,

  wasenderApiKey: process.env.WASENDER_API_KEY,
  wasenderWebhookSecret: process.env.WASENDER_WEBHOOK_SECRET,

  whatsappToken: process.env.WHATSAPP_TOKEN,
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN,

  // ---------- ميتا (ماسنجر + انستجرام) ----------
  // نفس رمز التحقق يلي بتحطه بصفحة Webhooks بإعدادات تطبيق ميتا
  metaVerifyToken: process.env.META_VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN,
  // App Secret من إعدادات التطبيق الأساسية بميتا — لازم يكون موجود عشان نتحقق إن الرسايل الواردة فعلاً من ميتا
  metaAppSecret: process.env.META_APP_SECRET,
  // App ID (مش سري، بس لازم نعرفه عشان نبني رابط "تسجيل الدخول بفيسبوك")
  metaAppId: process.env.META_APP_ID,
  // رابط السيرفر المنشور فعلياً (بدون / بالآخر) — لازم يطابق بالضبط الـ Redirect URI المسجل بإعدادات فيسبوك Login
  appBaseUrl: (process.env.APP_BASE_URL || "https://saber-jo-bot.onrender.com").replace(/\/$/, ""),

  orderDestinationMode: process.env.ORDER_DESTINATION_MODE || "dashboard",
  orderDestinationTarget: process.env.ORDER_DESTINATION_TARGET || "",

  smtpHost: process.env.SMTP_HOST,
  smtpPort: process.env.SMTP_PORT,
  smtpUser: process.env.SMTP_USER,
  smtpPass: process.env.SMTP_PASS,
  mailFrom: process.env.MAIL_FROM || "noreply@saberjo.com",
};
