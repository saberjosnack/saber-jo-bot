const express = require("express");
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

router.post("/employees", requireRole("owner"), async (req, res) => {
  const { name, email, role } = req.body;
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
    status: "pending",
    passwordHash: null,
    resetToken: inviteToken,
    resetTokenExpires: Date.now() + 7 * 24 * 60 * 60 * 1000,
  };
  employees.push(newEmployee);
  store.write("employees.json", employees);

  const inviteLink = `${req.protocol}://${req.get("host")}/dashboard?token=${inviteToken}`;
  await sendEmployeeInviteEmail(email, inviteLink, role);

  // بما إنو الإيميل مش مربوط فعلياً لسا، منرجع الرابط بالرد عشان المالك يقدر يبعته يدوياً (واتساب مثلاً)
  res.status(201).json({ id: newEmployee.id, name, email, role, status: "pending", inviteLink });
});

router.delete("/employees/:id", requireRole("owner"), (req, res) => {
  const employees = store.read("employees.json").filter((e) => e.id !== Number(req.params.id));
  store.write("employees.json", employees);
  res.json({ message: "تم حذف صلاحية الموظف." });
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
