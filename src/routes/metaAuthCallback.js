const express = require("express");
const env = require("../config/env");
const metaAuth = require("../services/metaAuth");

const router = express.Router();

// فيسبوك بيرجع المستخدم هون مباشرة (تنقل صفحة كامل، مش طلب API) بعد ما يوافق على الأذونات.
// ما بنقدر نتوقع Authorization header هون، فلازم نتعرف على البوت المطلوب عن طريق state بس.
router.get("/facebook-callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;
  console.log("[meta-auth] رجوع من فيسبوك:", { hasCode: !!code, hasState: !!state, error, error_description });

  if (error) {
    console.error("[meta-auth] فيسبوك رجّع خطأ:", error, error_description);
    return res.redirect(`${env.appBaseUrl}/dashboard/?metaError=${encodeURIComponent(error_description || error)}`);
  }
  if (!code || !state) {
    console.error("[meta-auth] الكود أو الـ state مفقودين بالرجوع من فيسبوك.");
    return res.redirect(`${env.appBaseUrl}/dashboard/?metaError=missing_code`);
  }

  let botId;
  try {
    botId = metaAuth.verifyState(state);
  } catch (err) {
    console.error("[meta-auth] فشل التحقق من state (ممكن تكون انتهت صلاحيته - 10 دقايق):", err.message);
    return res.redirect(`${env.appBaseUrl}/dashboard/?metaError=invalid_state`);
  }

  try {
    const pages = await metaAuth.exchangeCodeForPages(code);
    console.log(`[meta-auth] تم جلب ${pages.length} صفحة للبوت ${botId}:`, pages.map((p) => p.name));
    metaAuth.savePendingPages(botId, pages);
    return res.redirect(`${env.appBaseUrl}/dashboard/?metaConnected=${encodeURIComponent(botId)}`);
  } catch (err) {
    console.error("[meta-auth] فشل تبديل كود تسجيل الدخول:", err);
    return res.redirect(`${env.appBaseUrl}/dashboard/?metaError=exchange_failed`);
  }
});

module.exports = router;
