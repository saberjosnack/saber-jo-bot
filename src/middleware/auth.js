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

module.exports = { requireAuth, requireRole };
