function read(file) {
  const p = path.join(DATA_DIR, file);

  console.log("READ FILE:", p);

  const content = fs.readFileSync(p, "utf8");

  console.log("FILE CONTENT:");
  console.log(content);

  return JSON.parse(content);
}
