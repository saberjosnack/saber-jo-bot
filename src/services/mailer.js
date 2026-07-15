const nodemailer = require("nodemailer");
const env = require("../config/env");

function getTransport() {
  if (!env.smtpHost) return null; // ما في إعدادات إيميل بعد — بيطبع بالـ console بدالها
  return nodemailer.createTransport({
    host: env.smtpHost,
    port: Number(env.smtpPort) || 587,
    auth: { user: env.smtpUser, pass: env.smtpPass },
  });
}

async function sendMail({ to, subject, html }) {
  const transport = getTransport();
  if (!transport) {
    console.log(`[mailer] SMTP غير مضبوط بعد. كان بده يرسل لـ ${to}:\n${subject}\n${html}`);
    return;
  }
  await transport.sendMail({ from: env.mailFrom, to, subject, html });
}

async function sendPasswordResetEmail(to, resetLink) {
  await sendMail({
    to,
    subject: "استرجاع كلمة المرور — Saber Jo Snack",
    html: `<p>اضغط الرابط لإعادة ضبط كلمة المرور (صالح لمدة ساعة):</p><p><a href="${resetLink}">${resetLink}</a></p>`,
  });
}

async function sendEmployeeInviteEmail(to, inviteLink, role) {
  await sendMail({
    to,
    subject: "دعوة للانضمام لداشبورد Saber Jo Snack",
    html: `<p>تمت إضافتك كموظف بدور "${role}". اضغط الرابط لتحط كلمة مرورك وتبدأ:</p><p><a href="${inviteLink}">${inviteLink}</a></p>`,
  });
}

module.exports = { sendPasswordResetEmail, sendEmployeeInviteEmail };
