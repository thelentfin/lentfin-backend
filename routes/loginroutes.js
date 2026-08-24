const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  // Check Admin Credentials

  const adminQuery = "SELECT * FROM users WHERE email = ?";

 db.query(adminQuery, [email], async (err, adminResult) => {
    if (err) {
      return res.status(500).json({
        status: false,
        message: "Database Error",
      });
    }
if (adminResult.length > 0) {
  const admin = adminResult[0];

  // Compare hashed password
  let passwordMatch = false;

// If password is bcrypt hash
if (admin.password.startsWith("$2")) {
  passwordMatch = await bcrypt.compare(password, admin.password);
} else {
  // Support old plain-text passwords
  passwordMatch = String(admin.password) === String(password);
}

if (passwordMatch) {
    const token = jwt.sign(
      {
        id: admin.id,
        role: admin.role,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7h",
      }
    );

    return res.json({
      status: true,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      token,
      message: "Admin Login Success",
    });
  }
}

    // CHECK DSA TABLE

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

        // Bcrypt password comparison for DSA
        const passwordMatch = await bcrypt.compare(password, dsa.password);

        if (passwordMatch) {
          const token = jwt.sign(
            {
              id: dsa.id,
              role: dsa.role,
            },
            process.env.JWT_SECRET,
            {
              expiresIn: "7h",
            },
          );

          return res.json({
            status: true,
            role: dsa.role,
            token: token,
            message: "DSA Login Success",
          });
        }
      }

      // INVALID

      return res.json({
        status: false,
        message: "Invalid Credentials",
      });
    });
  });
});

router.post("/add", (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    // CHECK EMAIL EXISTS

    const checkQuery = "SELECT * FROM users WHERE email = ?";

   db.query(checkQuery, [email], async (err, result) => {
     if (err) {
       console.log(err);

       return res.status(500).json({
         status: false,
         message: "Database Error",
       });
     }

     // EMAIL ALREADY EXISTS

     if (result.length > 0) {
       return res.json({
         status: false,
         message: "Email Already Exists",
       });
     }

     // INSERT QUERY (Plain-text password)

     const insertQuery = `
                INSERT INTO users
                (name, email, password, role)
                VALUES (?, ?, ?, ?)
            `;

     const hashedPassword = await bcrypt.hash(password, 10);

     db.query(
       insertQuery,
       [name, email, hashedPassword, role],
       (err, insertResult) => {
         if (err) {
           console.log(err);

           return res.status(500).json({
             status: false,
             message: "Insert Error",
           });
         }

         return res.json({
           status: true,
           message: "Registration Successful",
         });
       },
     );
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
