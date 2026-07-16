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

function read(file) {
  const p = ensureFile(file);

  console.log("========== STORE READ ==========");
  console.log("PATH:", p);

  const content = fs.readFileSync(p, "utf8");

  console.log("CONTENT:");
  console.log(content);

  return JSON.parse(content);
}

function write(file, data) {
  const p = ensureFile(file);

  console.log("========== STORE WRITE ==========");
  console.log("PATH:", p);
  console.log("DATA:");
  console.log(JSON.stringify(data, null, 2));

  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

function exists(file) {
  const p = path.join(DATA_DIR, file);

  console.log("========== STORE EXISTS ==========");
  console.log("PATH:", p);
  console.log("EXISTS:", fs.existsSync(p));

  return fs.existsSync(p);
}

module.exports = {
  read,
  write,
  exists,
};
