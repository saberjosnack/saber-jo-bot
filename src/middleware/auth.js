const jwt = require("jsonwebtoken");
const env = require("../config/env");
const store = require("../services/store");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "لازم تسجل دخول." });

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    return res.status(401).json({ error: "جلسة الدخول منتهية، سجل دخول من جديد." });
  }

  // منجيب دور/صلاحيات الموظف الحاليّة من الملف بدل ما نعتمد بس على القيم المخزّنة جوا التوكن وقت تسجيل
  // الدخول (والتوكن صالح لمدة 7 أيام) — وإلا لو المالك حذف موظف أو غيّر دوره، التوكن القديم بضل شغال
  // بنفس الصلاحيات القديمة لحد ما ينتهي لحاله بعد أسبوع، حتى لو ظاهر بالداشبورد إنو انحذف/تغيّر فوراً.
  const employees = store.read("employees.json");
  const current = employees.find((e) => e.id === payload.id);
  if (!current) {
    return res.status(401).json({ error: "حسابك انحذف أو ما عاد موجود — سجل دخول من جديد." });
  }

  req.employee = { id: current.id, email: current.email, role: current.role, assignedBotIds: current.assignedBotIds || [] };
  next();
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.employee || !allowedRoles.includes(req.employee.role)) {
      return res.status(403).json({ error: "ما عندك صلاحية لهاد الإجراء." });
    }
    next();
  };
}

function requireBotAccess(req, res, next) {
  const botId = req.params.id || req.params.botId;
  if (req.employee?.role === "owner") return next(); // المدير الكامل يشوف كل شي دايماً
  const assigned = req.employee?.assignedBotIds || [];
  if (!assigned.includes(botId)) {
    return res.status(403).json({ error: "ما عندك صلاحية على هاد البوت." });
  }
  next();
}

module.exports = { requireAuth, requireRole, requireBotAccess };
