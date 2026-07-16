const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const env = require("../config/env");
const store = require("../services/store");
const { sendPasswordResetEmail } = require("../services/mailer");

const router = express.Router();

// ---------- تسجيل الدخول ----------
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const employees = store.read("employees.json");

  console.log("===== LOGIN DEBUG =====");
  console.log("Email entered:", email);
  console.log("Employees file:", JSON.stringify(employees, null, 2));

  const employee = employees.find((e) => e.email === email);

  console.log("Employee found:", employee);

  if (!employee || !employee.passwordHash) {
    return res.status(401).json({ error: "الإيميل أو كلمة المرور غلط." });
  }

  const valid = await bcrypt.compare(password, employee.passwordHash);

  console.log("Password valid:", valid);

  if (!valid) {
    return res.status(401).json({ error: "الإيميل أو كلمة المرور غلط." });
  }

  const token = jwt.sign(
    {
      id: employee.id,
      email: employee.email,
      role: employee.role,
    },
    env.jwtSecret,
    { expiresIn: "7d" }
  );

  res.json({
    token,
    employee: {
      id: employee.id,
      name: employee.name,
      role: employee.role,
    },
  });
});

// ---------- نسيت كلمة المرور ----------
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  const employees = store.read("employees.json");
  const employee = employees.find((e) => e.email === email);

  if (employee) {
    employee.resetToken = uuid();
    employee.resetTokenExpires = Date.now() + 60 * 60 * 1000;

    store.write("employees.json", employees);

    const resetLink = `${req.protocol}://${req.get("host")}/reset-password?token=${employee.resetToken}`;

    await sendPasswordResetEmail(employee.email, resetLink);
  }

  res.json({
    message: "إذا الإيميل مسجل عندنا، رح توصلك رسالة فيها رابط الاسترجاع.",
  });
});

// ---------- تعيين كلمة مرور جديدة ----------
router.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;

  const employees = store.read("employees.json");
  const employee = employees.find((e) => e.resetToken === token);

  if (!employee || employee.resetTokenExpires < Date.now()) {
    return res.status(400).json({
      error: "الرابط منتهي أو غير صالح، اطلب رابط جديد.",
    });
  }

  employee.passwordHash = await bcrypt.hash(newPassword, 10);
  employee.resetToken = null;
  employee.resetTokenExpires = null;
  employee.status = "active";

  store.write("employees.json", employees);

  res.json({
    message: "تم تغيير كلمة المرور، فوت سجل دخول.",
  });
});

module.exports = router;
