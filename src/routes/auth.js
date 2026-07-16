router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const employees = store.read("employees.json");

  console.log("===== LOGIN DEBUG =====");
  console.log("Email entered:", email);
  console.log("Employees file:", JSON.stringify(employees, null, 2));

  const employee = employees.find((e) => e.email === email);

  console.log("Employee found:", employee);

  if (!employee || !employee.passwordHash) {
    return res.status(401).json({ error: "الإيميل أو كلمة المرور غلط." });
  }

  const valid = await bcrypt.compare(password, employee.passwordHash);

  console.log("Password valid:", valid);

  if (!valid) {
    return res.status(401).json({ error: "الإيميل أو كلمة المرور غلط." });
  }

  const token = jwt.sign(
    { id: employee.id, email: employee.email, role: employee.role },
    env.jwtSecret,
    { expiresIn: "7d" }
  );

  res.json({
    token,
    employee: {
      id: employee.id,
      name: employee.name,
      role: employee.role
    }
  });
});
