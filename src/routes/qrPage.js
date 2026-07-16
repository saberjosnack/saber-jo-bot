const express = require("express");
const QRCode = require("qrcode");
const wa = require("../services/selfHostedWhatsapp");
const botStore = require("../services/botStore");

const router = express.Router();

router.get("/:botId", async (req, res) => {
  const bot = botStore.getBot(req.params.botId);
  if (!bot) return res.status(404).send("<p style='font-family:sans-serif'>البوت غير موجود.</p>");

  const { status, qr } = wa.getQrStatus(req.params.botId);

  if (status === "connected") {
    return res.send(`<h2 style="font-family:sans-serif">بوت "${bot.name}" متصل بواتساب ✅ تقدر تسكر هاي الصفحة.</h2>`);
  }

  if (!qr) {
    return res.send(
      `<meta http-equiv="refresh" content="3"><p style="font-family:sans-serif">عم نجهز رمز QR لبوت "${bot.name}"، ثانية...</p>`
    );
  }

  const qrImage = await QRCode.toDataURL(qr);
  res.send(`
    <html dir="rtl">
      <body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>امسح الرمز من واتساب — بوت "${bot.name}"</h2>
        <img src="${qrImage}" style="width:280px;height:280px" />
        <p>واتساب ← الأجهزة المرتبطة ← ربط جهاز</p>
        <meta http-equiv="refresh" content="8">
      </body>
    </html>
  `);
});

module.exports = router;
