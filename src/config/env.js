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

  whatsappToken: process.env.WHATSAPP_TOKEN,
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN,

  orderDestinationMode: process.env.ORDER_DESTINATION_MODE || "dashboard",
  orderDestinationTarget: process.env.ORDER_DESTINATION_TARGET || "",

  smtpHost: process.env.SMTP_HOST,
  smtpPort: process.env.SMTP_PORT,
  smtpUser: process.env.SMTP_USER,
  smtpPass: process.env.SMTP_PASS,
  mailFrom: process.env.MAIL_FROM || "noreply@saberjo.com",
};
