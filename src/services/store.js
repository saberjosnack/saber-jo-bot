const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");

function ensureFile(file) {
  const p = path.join(DATA_DIR, file);

  fs.mkdirSync(path.dirname(p), { recursive: true });

  if (!fs.existsSync(p)) {
    console.log("Creating missing file:", p);
    fs.writeFileSync(p, "[]", "utf8");
  }

  return p;
}

// ملاحظة أداء: كنا نطبع محتوى الملف كامل بالـ console.log على كل read/write — مع تعدد الزبائن بنفس الوقت
// (كل رسالة بتعمل كذا read/write: إعدادات، منيو، محادثة، زبائن، طلبات...) هاد كان عبء حقيقي وبيبطئ
// الرد لما يكون في أكتر من عميل بنفس الوقت (كتابة كونسول كبيرة بتحجز حلقة الأحداث). خليناها سطر وحدة مختصر.
function read(file) {
  const p = ensureFile(file);
  const content = fs.readFileSync(p, "utf8");
  return JSON.parse(content);
}

function write(file, data) {
  const p = ensureFile(file);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

function exists(file) {
  const p = path.join(DATA_DIR, file);
  return fs.existsSync(p);
}

module.exports = {
  read,
  write,
  exists,
};
