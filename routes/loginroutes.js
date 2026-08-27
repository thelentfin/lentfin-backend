const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

const JWT_SECRET = process.env.JWT_SECRET;

// ======================================================
// TOKEN VERIFY MIDDLEWARE
// ======================================================

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      status: false,
      message: "Token required",
    });
  }

  const token = authHeader.split(" ")[1];

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).json({
        status: false,
        message: "Token expired or invalid",
      });
    }

    req.user = decoded;
    next();
  });
};

// ======================================================
// LOGIN
// ======================================================

router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const adminQuery = "SELECT * FROM users WHERE email = ?";

  db.query(adminQuery, [email], async (err, adminResult) => {
    if (err) {
      return res.status(500).json({
        status: false,
        message: "Database Error",
      });
    }

    // ================= ADMIN LOGIN =================

    if (adminResult.length > 0) {
      const admin = adminResult[0];

      // Account Status Check
      if (admin.status === "Inactive") {
        return res.status(403).json({
          status: false,
          message: "Your account is inactive.",
        });
      }

      let passwordMatch = false;

      // Support bcrypt + old plain text passwords
      if (admin.password.startsWith("$2")) {
        passwordMatch = await bcrypt.compare(password, admin.password);
      } else {
        passwordMatch = String(admin.password) === String(password);
      }

      if (passwordMatch) {
        const token = jwt.sign(
          {
            id: admin.id,
            role: admin.role,
            username: (admin.name || "").split(" ")[0],
          },
          JWT_SECRET,
          {
            expiresIn: "5h",
          },
        );

        return res.status(200).json({
          status: true,
          id: admin.id,
          name: admin.name,
          username: (admin.name || "").split(" ")[0],
          email: admin.email,
          role: admin.role,
          token,
          message: "Admin Login Success",
        });
      }
    }

    // ================= DSA LOGIN =================

    const dsaQuery = "SELECT * FROM dsa_users WHERE email = ?";

    db.query(dsaQuery, [email], async (err, dsaResult) => {
      if (err) {
        return res.status(500).json({
          status: false,
          message: "Database Error",
        });
      }

      if (dsaResult.length > 0) {
        const dsa = dsaResult[0];

        // DSA Status Check (only if status column exists)
        if (dsa.status && dsa.status === "Inactive") {
          return res.status(403).json({
            status: false,
            message: "Your account is inactive.",
          });
        }

        const passwordMatch = await bcrypt.compare(password, dsa.password);

        if (passwordMatch) {
          const token = jwt.sign(
            {
              id: dsa.id,
              role: dsa.role,
              username: (dsa.name || "").split(" ")[0],
            },
            JWT_SECRET,
            {
              expiresIn: "5h",
            },
          );

          return res.status(200).json({
            status: true,
            id: dsa.id,
            username: (dsa.name || "").split(" ")[0],
            role: dsa.role,
            token,
            message: "DSA Login Success",
          });
        }
      }

      // Invalid Credentials

      return res.status(401).json({
        status: false,
        message: "Invalid Credentials",
      });
    });
  });
});

// ======================================================
// ADD USER
// ======================================================

router.post("/add", (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    const checkQuery = "SELECT * FROM users WHERE email = ?";

    db.query(checkQuery, [email], async (err, result) => {
      if (err) {
        console.log(err);

        return res.status(500).json({
          status: false,
          message: "Database Error",
        });
      }

      if (result.length > 0) {
        return res.status(409).json({
          status: false,
          message: "Email Already Exists",
        });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const insertQuery = `
        INSERT INTO users
        (name, email, password, role)
        VALUES (?, ?, ?, ?)
      `;

      db.query(insertQuery, [name, email, hashedPassword, role], (err) => {
        if (err) {
          console.log(err);

          return res.status(500).json({
            status: false,
            message: "Insert Error",
          });
        }

        return res.status(201).json({
          status: true,
          message: "Registration Successful",
        });
      });
    });
  } catch (error) {
    console.log(error);

    return res.status(500).json({
      status: false,
      message: "Server Error",
    });
  }
});

module.exports = router;
module.exports.verifyToken = verifyToken;
