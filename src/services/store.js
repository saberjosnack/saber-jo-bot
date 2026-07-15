// تخزين مبدئي بملفات JSON. كل القراءة والكتابة تمر من هون بس،
// فلما ننتقل لقاعدة بيانات حقيقية (Postgres) منغيّر هاد الملف بس
// وباقي المشروع ما بيتأثر.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");

function read(file) {
  const p = path.join(DATA_DIR, file);
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function write(file, data) {
  const p = path.join(DATA_DIR, file);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

module.exports = { read, write };
