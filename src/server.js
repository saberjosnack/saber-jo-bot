const express = require("express");
const cors = require("cors");
const env = require("./config/env");

const webhookRoutes = require("./routes/webhook");
const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const botsRoutes = require("./routes/bots");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send("Saber Jo Snack bot API شغال ✅"));

app.use("/webhook", webhookRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/bots", botsRoutes);

if (env.waProvider === "selfhosted") {
  const wa = require("./services/selfHostedWhatsapp");
  wa.startAllActiveBots().catch((err) => console.error("فشل بدء اتصالات البوتات:", err));
}

app.listen(env.port, () => {
  console.log(`Saber Jo Snack API شغال على المنفذ ${env.port}`);
});
