const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");

function ensureFile(file) {
  const p = path.join(DATA_DIR, file);

  fs.mkdirSync(path.dirname(p), { recursive: true });

  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, "[]", "utf8");
  }

  return p;
}

function read(file) {
  const p = ensureFile(file);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function write(file, data) {
  const p = ensureFile(file);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

function exists(file) {
  return fs.existsSync(path.join(DATA_DIR, file));
}

module.exports = { read, write, exists };
