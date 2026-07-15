const express = require("express");
const { v4: uuid } = require("uuid");
const store = require("../services/store");
const { requireAuth, requireRole } = require("../middleware/auth");
const { sendEmployeeInviteEmail } = require("../services/mailer");

const router = express.Router();
router.use(requireAuth); // كل مسارات الداشبورد لازم تسجيل دخول

// ---------- المنيو (مدير كامل + موظف طلبات) ----------
router.get("/menu", (req, res) => res.json(store.read("menu.json")));

router.put("/menu/:id", requireRole("owner", "orders"), (req, res) => {
  const menu = store.read("menu.json");
  const idx = menu.findIndex((i) => i.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: "الصنف مش موجود." });

  menu[idx] = { ...menu[idx], ...req.body };
  store.write("menu.json", menu);
  res.json(menu[idx]);
});

router.post("/menu", requireRole("owner"), (req, res) => {
  const menu = store.read("menu.json");
  const newItem = { id: Date.now(), salesCount: 0, featured: false, featuredNote: "", ...req.body };
  menu.push(newItem);
  store.write("menu.json", menu);
  res.status(201).json(newItem);
});

// ---------- أسعار التوصيل (مدير كامل بس) ----------
router.get("/delivery-fees", (req, res) => res.json(store.read("deliveryFees.json")));

router.put("/delivery-fees", requireRole("owner"), (req, res) => {
  store.write("deliveryFees.json", req.body);
  res.json({ message: "تم التحديث." });
});

// ---------- الإعدادات / البرومبت (مدير كامل بس) ----------
router.get("/settings", (req, res) => res.json(store.read("settings.json")));

router.put("/settings", requireRole("owner"), (req, res) => {
  const current = store.read("settings.json");
  const updated = { ...current, ...req.body };
  store.write("settings.json", updated);
  res.json(updated);
});

// ---------- الموظفين (مدير كامل بس) ----------
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
    resetTokenExpires: Date.now() + 7 * 24 * 60 * 60 * 1000, // أسبوع
  };
  employees.push(newEmployee);
  store.write("employees.json", employees);

  const inviteLink = `${req.protocol}://${req.get("host")}/reset-password?token=${inviteToken}`;
  await sendEmployeeInviteEmail(email, inviteLink, role);

  res.status(201).json({ id: newEmployee.id, name, email, role, status: "pending" });
});

router.delete("/employees/:id", requireRole("owner"), (req, res) => {
  const employees = store.read("employees.json").filter((e) => e.id !== Number(req.params.id));
  store.write("employees.json", employees);
  res.json({ message: "تم حذف صلاحية الموظف." });
});

// ---------- الطلبات (مدير كامل + موظف طلبات) ----------
router.get("/orders", requireRole("owner", "orders", "viewer"), (req, res) => {
  res.json(store.read("orders.json"));
});

router.put("/orders/:id/status", requireRole("owner", "orders"), (req, res) => {
  const orders = store.read("orders.json");
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "الطلب مش موجود." });
  order.status = req.body.status;
  store.write("orders.json", orders);
  res.json(order);
});

// ---------- المحادثات الموقوفة يدوياً ----------
router.get("/paused-conversations", requireRole("owner", "orders"), (req, res) => {
  res.json(store.read("pausedConversations.json"));
});

router.delete("/paused-conversations/:phone", requireRole("owner", "orders"), (req, res) => {
  const paused = store.read("pausedConversations.json");
  delete paused[req.params.phone];
  store.write("pausedConversations.json", paused);
  res.json({ message: "رجع البوت يرد عهاي المحادثة." });
});

module.exports = router;
