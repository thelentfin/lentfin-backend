const express = require("express");
const router = express.Router();
const db = require("../db");
const nodemailer = require("nodemailer");
const bcrypt = require("bcryptjs");

// ======================================================
// OTP STORAGE
// ======================================================

const otpStore = {};
const verifiedStore = {};
// email -> expiry timestamp
// OTP verified successfully, password reset allowed

// ======================================================
// NODEMAILER CONFIGURATION
// ======================================================

const transporter = nodemailer.createTransport({
  service: "gmail",

  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// ======================================================
// FORGOT PASSWORD
// ======================================================

router.post("/forgot-password", (req, res) => {
  const email = req.body.email?.trim().toLowerCase();

  // ==================================================
  // VALIDATION
  // ==================================================

  if (!email) {
    return res.status(400).json({
      status: false,
      message: "Email is required",
    });
  }

  // ==================================================
  // CHECK USERS TABLE
  // ==================================================

  const checkUserQuery = `
        SELECT id, email
        FROM users
        WHERE email = ?
        LIMIT 1
    `;

  db.query(checkUserQuery, [email], (err, userResult) => {
    if (err) {
      console.error("Users table error:", err);

      return res.status(500).json({
        status: false,
        message: "Database Error",
      });
    }

    // ==================================================
    // USER FOUND
    // ==================================================

    if (userResult.length > 0) {
      return sendOtpEmail(email, res);
    }

    // ==================================================
    // CHECK DSA_USERS TABLE
    // ==================================================

    const checkDsaQuery = `
            SELECT id, email
            FROM dsa_users
            WHERE email = ?
            LIMIT 1
        `;

    db.query(checkDsaQuery, [email], (err, dsaResult) => {
      if (err) {
        console.error("DSA users table error:", err);

        return res.status(500).json({
          status: false,
          message: "Database Error",
        });
      }

      // ==================================================
      // DSA USER FOUND
      // ==================================================

      if (dsaResult.length > 0) {
        return sendOtpEmail(email, res);
      }

      // ==================================================
      // EMAIL NOT FOUND
      // ==================================================

      return res.status(404).json({
        status: false,
        message: "Email not registered",
      });
    });
  });
});

// ======================================================
// SEND OTP EMAIL
// ======================================================

function sendOtpEmail(email, res) {
  // ==================================================
  // GENERATE 4 DIGIT OTP
  // ==================================================

  const otp = Math.floor(1000 + Math.random() * 9000).toString();

  // ==================================================
  // STORE OTP
  // OTP VALID FOR 5 MINUTES
  // ==================================================

  otpStore[email] = {
    otp: otp,
    expiresAt: Date.now() + 5 * 60 * 1000,
  };

  // ==================================================
  // EMAIL
  // ==================================================

  const mailOptions = {
    from: `"${process.env.APP_NAME}" <${process.env.EMAIL_USER}>`,

    to: email,

    subject: "Your Password Reset OTP",

    // ==================================================
    // NEW LINE ADDED — plain text version (fixes spam issue)
    // ==================================================
    text: `Your OTP is ${otp}. This OTP is valid for 5 minutes. If you did not request this, please ignore this email.`,

    html: `
            <div
                style="
                    font-family: Arial, sans-serif;
                    padding: 20px;
                    max-width: 500px;
                    margin: auto;
                "
            >

                <h2>Password Reset OTP</h2>

                <p>
                    Use the OTP below to reset your password.
                </p>

                <p>
                    This OTP is valid for
                    <strong>5 minutes</strong>.
                </p>

                <h1
                    style="
                        letter-spacing: 6px;
                        font-size: 32px;
                    "
                >
                    ${otp}
                </h1>

                <p>
                    If you did not request a password reset,
                    please ignore this email.
                </p>

            </div>
        `,
  };

  // ==================================================
  // SEND EMAIL
  // ==================================================

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error("OTP email error:", error);

      // Remove OTP if email sending failed
      delete otpStore[email];

      return res.status(500).json({
        status: false,
        message: "Failed to send OTP email",
      });
    }

    console.log("OTP email sent:", info.messageId);

    return res.status(200).json({
      status: true,
      message: "OTP sent successfully to your email",
    });
  });
}

// ======================================================
// VERIFY OTP
// ======================================================

router.post("/verify-otp", (req, res) => {
  const email = req.body.email?.trim().toLowerCase();
  const otp = String(req.body.otp || "").trim();

  // ==================================================
  // VALIDATION
  // ==================================================

  if (!email || !otp) {
    return res.status(400).json({
      status: false,
      message: "Email and OTP are required",
    });
  }

  // ==================================================
  // GET STORED OTP
  // ==================================================

  const record = otpStore[email];

  // ==================================================
  // OTP NOT FOUND
  // ==================================================

  if (!record) {
    return res.status(400).json({
      status: false,
      message: "OTP not found. Please request a new OTP.",
    });
  }

  // ==================================================
  // CHECK OTP EXPIRY
  // ==================================================

  if (Date.now() > record.expiresAt) {
    delete otpStore[email];

    return res.status(400).json({
      status: false,
      message: "OTP expired. Please request a new OTP.",
    });
  }

  // ==================================================
  // CHECK OTP
  // ==================================================

  if (String(record.otp) !== otp) {
    return res.status(400).json({
      status: false,
      message: "Invalid OTP. Please try again.",
    });
  }

  // ==================================================
  // OTP VERIFIED
  // Remove OTP so it cannot be reused
  // ==================================================

  delete otpStore[email];

  // ==================================================
  // ALLOW PASSWORD RESET FOR 10 MINUTES
  // ==================================================

  verifiedStore[email] = Date.now() + 10 * 60 * 1000;

  // ==================================================
  // RESPONSE
  // ==================================================

  return res.status(200).json({
    status: true,
    message: "OTP verified successfully",
  });
});

// ======================================================
// RESET PASSWORD
// ======================================================

router.post("/reset-password", async (req, res) => {
  try {
    const email = req.body.email?.trim().toLowerCase();

    const newPassword = req.body.newPassword;

    const confirmPassword = req.body.confirmPassword;

    // ==================================================
    // VALIDATION
    // ==================================================

    if (!email || !newPassword || !confirmPassword) {
      return res.status(400).json({
        status: false,
        message: "All fields are required",
      });
    }

    // ==================================================
    // PASSWORD MATCH
    // ==================================================

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        status: false,
        message: "Passwords do not match",
      });
    }

    // ==================================================
    // OTP VERIFICATION CHECK
    // ==================================================

    const verifiedUntil = verifiedStore[email];

    if (!verifiedUntil || Date.now() > verifiedUntil) {
      delete verifiedStore[email];

      return res.status(400).json({
        status: false,
        message: "OTP verification expired. Please start again.",
      });
    }

    // ==================================================
    // PASSWORD BCRYPT HASH
    // ==================================================

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    console.log("Password hashed successfully for:", email);

    // ==================================================
    // CHECK USERS TABLE FIRST
    // ==================================================

    const checkUserQuery = `
            SELECT id
            FROM users
            WHERE email = ?
            LIMIT 1
        `;

    db.query(checkUserQuery, [email], (err, userResult) => {
      if (err) {
        console.error("Check users error:", err);

        return res.status(500).json({
          status: false,
          message: "Database Error",
        });
      }

      // ==================================================
      // USER FOUND
      // ==================================================

      if (userResult.length > 0) {
        const updateUserQuery = `
                        UPDATE users
                        SET password = ?
                        WHERE email = ?
                    `;

        return db.query(
          updateUserQuery,
          [hashedPassword, email],
          (err, result) => {
            if (err) {
              console.error("Update users password error:", err);

              return res.status(500).json({
                status: false,
                message: "Database Error",
              });
            }

            // ==================================================
            // PASSWORD UPDATED
            // ==================================================

            delete verifiedStore[email];

            return res.status(200).json({
              status: true,
              message: "Password updated successfully",
            });
          },
        );
      }

      // ==================================================
      // USER NOT FOUND
      // CHECK DSA_USERS
      // ==================================================

      const checkDsaQuery = `
                    SELECT id
                    FROM dsa_users
                    WHERE email = ?
                    LIMIT 1
                `;

      db.query(checkDsaQuery, [email], (err, dsaResult) => {
        if (err) {
          console.error("Check dsa_users error:", err);

          return res.status(500).json({
            status: false,
            message: "Database Error",
          });
        }

        // ==================================================
        // DSA USER NOT FOUND
        // ==================================================

        if (dsaResult.length === 0) {
          delete verifiedStore[email];

          return res.status(404).json({
            status: false,
            message: "Email not registered",
          });
        }

        // ==================================================
        // UPDATE DSA USER PASSWORD
        // ==================================================

        const updateDsaQuery = `
                            UPDATE dsa_users
                            SET password = ?
                            WHERE email = ?
                        `;

        db.query(updateDsaQuery, [hashedPassword, email], (err, result) => {
          if (err) {
            console.error("Update dsa_users password error:", err);

            return res.status(500).json({
              status: false,
              message: "Database Error",
            });
          }

          // ==================================================
          // PASSWORD UPDATED
          // ==================================================

          delete verifiedStore[email];

          return res.status(200).json({
            status: true,
            message: "Password updated successfully",
          });
        });
      });
    });
  } catch (error) {
    console.error("Reset password error:", error);

    return res.status(500).json({
      status: false,
      message: "Internal Server Error",
    });
  }
});

// ======================================================
// EXPORT ROUTER
// ======================================================

module.exports = router;