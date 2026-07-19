const express = require("express");
const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");
const store = require("../services/store");
const { requireAuth, requireRole } = require("../middleware/auth");
const { sendEmployeeInviteEmail } = require("../services/mailer");

const router = express.Router();
router.use(requireAuth);

const VALID_ROLES = ["owner", "orders", "viewer"];

// بيتأكد إنو التعديل (حذف موظف أو تغيير دوره لغير "مدير كامل") ما رح يسيب الحساب بلا ولا مدير كامل واحد —
// وإلا محدا يقدر يدير الموظفين أو يشوف كل شي بعدها، وما في طريقة ترجع الوضع من غير وصول مباشر لقاعدة البيانات.
function wouldRemoveLastOwner(employees, employeeId, newRole) {
  const otherOwners = employees.filter((e) => e.id !== employeeId && e.role === "owner");
  return otherOwners.length === 0 && newRole !== "owner";
}

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
  const id = Number(req.params.id);
  const employees = store.read("employees.json");
  if (wouldRemoveLastOwner(employees, id, "__deleted__")) {
    return res.status(400).json({ error: "ما تقدر تحذف هاد الموظف — لازم يضل مدير كامل واحد ع الأقل بالحساب." });
  }
  store.write("employees.json", employees.filter((e) => e.id !== id));
  res.json({ message: "تم حذف صلاحية الموظف." });
});

// تعديل دور/صلاحية موظف موجود (بعد الدعوة) — قبل هاد الإضافة، الدور كان يتحدد وقت الدعوة بس وما في طريقة تتغيّر بعدها
// من الداشبورد إطلاقاً؛ الموظف كان لازم يتحذف وينضاف من جديد بدور مختلف (وبيخسر كلمة مروره وحالة "نشط" بلا داعي).
router.put("/employees/:id/role", requireRole("owner"), (req, res) => {
  const { role } = req.body;
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: "دور غير معروف." });
  }

  const id = Number(req.params.id);
  const employees = store.read("employees.json");
  const employee = employees.find((e) => e.id === id);
  if (!employee) return res.status(404).json({ error: "الموظف غير موجود." });

  if (wouldRemoveLastOwner(employees, id, role)) {
    return res.status(400).json({ error: "ما تقدر تغيّر دور هاد الموظف — لازم يضل مدير كامل واحد ع الأقل بالحساب." });
  }

  employee.role = role;
  if (role === "owner") employee.assignedBotIds = []; // المدير الكامل أصلاً بيشوف كل شي، ما في داعي لقائمة بوتات محددة
  store.write("employees.json", employees);
  res.json({ message: "تم تحديث دور الموظف." });
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
