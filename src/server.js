const express = require("express");
const cors = require("cors");
const path = require("path");
const env = require("./config/env");

const webhookRoutes = require("./routes/webhook");
const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const botsRoutes = require("./routes/bots");
const qrPageRoutes = require("./routes/qrPage");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send("Saber Jo Snack bot API شغال ✅"));

app.use("/webhook", webhookRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/bots", botsRoutes);
app.use("/qr", qrPageRoutes);

// الداشبورد الحقيقي — صفحة واحدة، متصلة بالـ API فوق مباشرة
app.use("/dashboard", express.static(path.join(__dirname, "..", "public", "dashboard")));

if (env.waProvider === "selfhosted") {
  const wa = require("./services/selfHostedWhatsapp");
  wa.startAllActiveBots().catch((err) => console.error("فشل بدء اتصالات البوتات:", err));
}

app.listen(env.port, () => {
  console.log(`Saber Jo Snack API شغال على المنفذ ${env.port}`);
  console.log(`WA_PROVIDER الحالي: ${env.waProvider}`);
});
