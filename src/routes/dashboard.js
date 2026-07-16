const express = require("express");
const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");
const store = require("../services/store");
const { requireAuth, requireRole } = require("../middleware/auth");
const { sendEmployeeInviteEmail } = require("../services/mailer");

const router = express.Router();
router.use(requireAuth);

// ---------- الموظفين وصلاحياتهم (على مستوى الحساب كله، مو بوت معين) ----------
router.get("/employees", requireRole("owner"), (req, res) => {
  const employees = store.read("employees.json").map(({ passwordHash, resetToken, ...safe }) => safe);
  res.json(employees);
});

// body: { name, email, role, assignedBotIds: string[] }
// assignedBotIds بتنحسب بس لو role مش "owner" (المدير الكامل أصلاً بيشوف كل شي)
router.post("/employees", requireRole("owner"), async (req, res) => {
  const { name, email, role, assignedBotIds } = req.body;
  const employees = store.read("employees.json");

  if (employees.some((e) => e.email === email)) {
    return res.status(409).json({ error: "في موظف مسجل بنفس الإيميل." });
  }

  const inviteToken = uuid();
  const newEmployee = {
    id: Date.now(),
    name,
    email,
    role,
    assignedBotIds: role === "owner" ? [] : (assignedBotIds || []),
    status: "pending",
    passwordHash: null,
    resetToken: inviteToken,
    resetTokenExpires: Date.now() + 7 * 24 * 60 * 60 * 1000,
  };
  employees.push(newEmployee);
  store.write("employees.json", employees);

  const inviteLink = `${req.protocol}://${req.get("host")}/dashboard?token=${inviteToken}`;
  await sendEmployeeInviteEmail(email, inviteLink, role);

  res.status(201).json({ id: newEmployee.id, name, email, role, status: "pending", inviteLink });
});

router.delete("/employees/:id", requireRole("owner"), (req, res) => {
  const employees = store.read("employees.json").filter((e) => e.id !== Number(req.params.id));
  store.write("employees.json", employees);
  res.json({ message: "تم حذف صلاحية الموظف." });
});

// المالك بيحط كلمة مرور مباشرة للموظف بدل ما يستنى رابط الدعوة
router.post("/employees/:id/set-password", requireRole("owner"), async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "كلمة المرور لازم تكون 6 أحرف على الأقل." });
  }
  const employees = store.read("employees.json");
  const employee = employees.find((e) => e.id === Number(req.params.id));
  if (!employee) return res.status(404).json({ error: "الموظف غير موجود." });

  employee.passwordHash = await bcrypt.hash(newPassword, 10);
  employee.status = "active";
  employee.resetToken = null;
  store.write("employees.json", employees);
  res.json({ message: "تم تعيين كلمة المرور." });
});

// تعديل البوتات المسموحة لموظف
router.put("/employees/:id/bots", requireRole("owner"), (req, res) => {
  const { assignedBotIds } = req.body;
  const employees = store.read("employees.json");
  const employee = employees.find((e) => e.id === Number(req.params.id));
  if (!employee) return res.status(404).json({ error: "الموظف غير موجود." });

  employee.assignedBotIds = assignedBotIds || [];
  store.write("employees.json", employees);
  res.json({ message: "تم تحديث صلاحيات البوتات." });
});

// ---------- المحادثات الموقوفة يدوياً (كل بوت لحاله) ----------
router.get("/bots/:botId/paused-conversations", requireRole("owner", "orders"), (req, res) => {
  res.json(store.read(`bots/${req.params.botId}/pausedConversations.json`));
});

router.delete("/bots/:botId/paused-conversations/:phone", requireRole("owner", "orders"), (req, res) => {
  const key = `bots/${req.params.botId}/pausedConversations.json`;
  const paused = store.read(key);
  delete paused[req.params.phone];
  store.write(key, paused);
  res.json({ message: "رجع البوت يرد عهاي المحادثة." });
});

module.exports = router;
