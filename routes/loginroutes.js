const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const {
  checkLoginCooldown,
  recordFailedLogin,
  clearFailedLogin,
} = require("../middleware/rateLimiter");

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

router.post("/login", checkLoginCooldown, async (req, res) => {
  try {
    // ==================================================
    // 1. GET LOGIN DATA
    // ==================================================

    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    // ==================================================
    // 2. BASIC VALIDATION
    // ==================================================

    if (!email || !password) {
      return res.status(400).json({
        status: false,
        message: "Email and password are required",
      });
    }

    // ==================================================
    // 3. CHECK ADMIN / CORPORATE USER
    // ==================================================

    const adminQuery = `
      SELECT *
      FROM users
      WHERE LOWER(TRIM(email)) = ?
      LIMIT 1
    `;

    const adminResult = await new Promise((resolve, reject) => {
      db.query(
        adminQuery,
        [email],
        (err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        },
      );
    });

    // ==================================================
    // ADMIN LOGIN
    // ==================================================

    if (adminResult.length > 0) {
      const admin = adminResult[0];

      // ----------------------------------------------
      // CHECK STATUS
      // ----------------------------------------------

      if (admin.status === "Inactive") {
        return res.status(403).json({
          status: false,
          message: "Your account is inactive.",
        });
      }

      // ----------------------------------------------
      // PASSWORD CHECK
      // ----------------------------------------------

      let passwordMatch = false;

      if (
        admin.password &&
        (
          admin.password.startsWith("$2a$") ||
          admin.password.startsWith("$2b$") ||
          admin.password.startsWith("$2y$")
        )
      ) {
        passwordMatch = await bcrypt.compare(
          password,
          admin.password,
        );
      } else {
        // Backward compatibility for old plain-text users
        passwordMatch =
          String(admin.password) === String(password);
      }

      // ----------------------------------------------
      // INVALID ADMIN PASSWORD
      // ----------------------------------------------

      if (!passwordMatch) {
        recordFailedLogin(req);

        return res.status(401).json({
          status: false,
          message: "Invalid Credentials",
        });
      }

      // ----------------------------------------------
      // LOGIN SUCCESS
      // ----------------------------------------------

      clearFailedLogin(req);

      const token = jwt.sign(
        {
          id: admin.id,
          role: admin.role,
          username: (admin.name || "")
            .split(" ")[0],
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
        username: (admin.name || "")
          .split(" ")[0],
        email: admin.email,
        role: admin.role,
        token,
        message: "Admin Login Success",
      });
    }

    // ==================================================
    // 4. CHECK DSA USER
    // ==================================================

    const dsaQuery = `
      SELECT *
      FROM dsa_users
      WHERE LOWER(TRIM(email)) = ?
      LIMIT 1
    `;

    const dsaResult = await new Promise((resolve, reject) => {
      db.query(
        dsaQuery,
        [email],
        (err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        },
      );
    });

    // ==================================================
    // DSA NOT FOUND
    // ==================================================

    if (dsaResult.length === 0) {
      recordFailedLogin(req);

      return res.status(401).json({
        status: false,
        message: "Invalid Credentials",
      });
    }

    const dsa = dsaResult[0];

    // ==================================================
    // 5. CHECK DSA STATUS
    // ==================================================

    if (
      dsa.status &&
      String(dsa.status).toLowerCase() === "inactive"
    ) {
      return res.status(403).json({
        status: false,
        message: "Your account is inactive.",
      });
    }

    // ==================================================
    // 6. CHECK PASSWORD HASH EXISTS
    // ==================================================

    if (!dsa.password) {
      console.error(
        "DSA PASSWORD HASH IS EMPTY",
        {
          dsa_id: dsa.id,
          email: dsa.email,
        },
      );

      recordFailedLogin(req);

      return res.status(401).json({
        status: false,
        message: "Invalid Credentials",
      });
    }

    // ==================================================
    // 7. CHECK BCRYPT HASH FORMAT
    // ==================================================

    const isBcryptHash =
      dsa.password.startsWith("$2a$") ||
      dsa.password.startsWith("$2b$") ||
      dsa.password.startsWith("$2y$");

    if (!isBcryptHash) {
      console.error(
        "DSA PASSWORD IS NOT A VALID BCRYPT HASH",
        {
          dsa_id: dsa.id,
          email: dsa.email,
          hashLength: dsa.password.length,
          hashPrefix: dsa.password.substring(0, 4),
        },
      );

      recordFailedLogin(req);

      return res.status(401).json({
        status: false,
        message: "Invalid Credentials",
      });
    }

    // ==================================================
    // 8. COMPARE PASSWORD
    // ==================================================

    const passwordMatch = await bcrypt.compare(
      password,
      dsa.password,
    );

    console.log("DSA LOGIN DEBUG:", {
      dsa_id: dsa.id,
      email: dsa.email,
      hashLength: dsa.password.length,
      passwordMatch,
    });

    // ==================================================
    // INVALID PASSWORD
    // ==================================================

    if (!passwordMatch) {
      recordFailedLogin(req);

      return res.status(401).json({
        status: false,
        message: "Invalid Credentials",
      });
    }

    // ==================================================
    // 9. PASSWORD CORRECT
    // ==================================================

    clearFailedLogin(req);

    // ==================================================
    // 10. CREATE JWT
    // ==================================================

    const token = jwt.sign(
      {
        id: dsa.id,
        role: dsa.role,
        username: (dsa.name || "")
          .split(" ")[0],
      },
      JWT_SECRET,
      {
        expiresIn: "5h",
      },
    );

    // ==================================================
    // 11. LOGIN SUCCESS
    // ==================================================

    return res.status(200).json({
      status: true,
      id: dsa.id,
      name: dsa.name,
      username: (dsa.name || "")
        .split(" ")[0],
      email: dsa.email,
      role: dsa.role,
      token,
      must_change_password:
        Number(dsa.must_change_password) === 1,
      message: "DSA Login Success",
    });

  } catch (error) {
    console.error(
      "LOGIN ERROR:",
      error,
    );

    return res.status(500).json({
      status: false,
      message: "Database Error",
      error: error.message,
    });
  }
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
