const fs = require("fs");
const path = require("path");

// سجل تتبع مشترك — أي جزء بالكود يقدر يكتب فيه ونشوفه مباشرة عن طريق الـ Shell،
// بدل الاعتماد على صفحة اللوجز بالرندر يلي بترجع أحياناً نتائج قديمة/مخزنة.
const TRACE_FILE = path.join(__dirname, "..", "data", "webhook-trace.log");

function trace(msg) {
  try {
    fs.appendFileSync(TRACE_FILE, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
  } catch (e) {
    console.error("[trace] فشل الكتابة بملف التتبع:", e.message);
  }
}

module.exports = { trace };
