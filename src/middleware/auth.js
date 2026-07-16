const jwt = require("jsonwebtoken");
const env = require("../config/env");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "لازم تسجل دخول." });

  try {
    req.employee = jwt.verify(token, env.jwtSecret);
    next();
  } catch {
    return res.status(401).json({ error: "جلسة الدخول منتهية، سجل دخول من جديد." });
  }
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
