const express = require("express");
const router = express.Router();
const db = require("../db");
const nodemailer = require("nodemailer");
const bcrypt = require("bcryptjs");

// ======================================================
// AUTHENTICATION MIDDLEWARE
// ======================================================

const authenticateAndAuthorize = require("../middleware/authMiddleware");

// ======================================================
// OTP STORAGE (ADMIN ONLY)
// ======================================================

const adminOtpStore = {};
const adminVerifiedStore = {};
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
// ADMIN FORGOT PASSWORD
// LOGGED-IN ADMIN ONLY (FROM PROFILE)
// ======================================================

router.post(
  "/admin-forgot-password",
  authenticateAndAuthorize(),

  (req, res) => {
    // ==================================================
    // STEP 1 - GET LOGGED-IN ADMIN ID FROM JWT
    // ==================================================

    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        status: false,
        message: "Authentication information not found",
      });
    }

    // ==================================================
    // STEP 2 - CHECK LOGGED-IN USER IS ADMIN
    // ==================================================

    const checkAdminQuery = `
        SELECT id, email, role, status
        FROM users
        WHERE id = ?
        LIMIT 1
    `;

    db.query(checkAdminQuery, [userId], (err, userResult) => {
      if (err) {
        console.error("Admin check error:", err);

        return res.status(500).json({
          status: false,
          message: "Database Error",
        });
      }

      // ==================================================
      // ADMIN NOT FOUND
      // ==================================================

      if (userResult.length === 0) {
        return res.status(404).json({
          status: false,
          message: "User not found",
        });
      }

      const admin = userResult[0];

      // ==================================================
      // CHECK ROLE IS ADMIN
      // ==================================================

      if (String(admin.role).toLowerCase() !== "admin") {
        return res.status(403).json({
          status: false,
          message: "Access denied. Admin only.",
        });
      }

      // ==================================================
      // CHECK ADMIN STATUS
      // ==================================================

      if (String(admin.status).toLowerCase() !== "active") {
        return res.status(403).json({
          status: false,
          message: "Admin account is inactive",
        });
      }

      // ==================================================
      // ADMIN VERIFIED - SEND OTP TO OWN EMAIL
      // ==================================================

      return sendAdminOtpEmail(admin.email, res);
    });
  },
);

// ======================================================
// SEND OTP EMAIL (ADMIN)
// ======================================================

function sendAdminOtpEmail(email, res) {
  // ==================================================
  // GENERATE 4 DIGIT OTP
  // ==================================================

  const otp = Math.floor(1000 + Math.random() * 9000).toString();

  // ==================================================
  // STORE OTP
  // OTP VALID FOR 5 MINUTES
  // ==================================================

  adminOtpStore[email] = {
    otp: otp,
    expiresAt: Date.now() + 5 * 60 * 1000,
  };

  // ==================================================
  // EMAIL
  // ==================================================

  const mailOptions = {
    from: `"${process.env.APP_NAME}" <${process.env.EMAIL_USER}>`,

    to: email,

    subject: "Your Admin Password Reset OTP",

    html: `
            <div
                style="
                    font-family: Arial, sans-serif;
                    padding: 20px;
                    max-width: 500px;
                    margin: auto;
                "
            >

                <h2>Admin Password Reset OTP</h2>

                <p>
                    Use the OTP below to reset your admin account password.
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
      console.error("Admin OTP email error:", error);

      // Remove OTP if email sending failed
      delete adminOtpStore[email];

      return res.status(500).json({
        status: false,
        message: "Failed to send OTP email",
      });
    }

    console.log("Admin OTP email sent:", info.messageId);

    return res.status(200).json({
      status: true,
      message: "OTP sent successfully to your registered email",
    });
  });
}

// ======================================================
// VERIFY OTP (ADMIN)
// LOGGED-IN ADMIN ONLY (FROM PROFILE)
// ======================================================

router.post(
  "/admin-verify-otp",
  authenticateAndAuthorize(),

  (req, res) => {
    const userId = req.user?.id;

    const otp = String(req.body.otp || "").trim();

    // ==================================================
    // VALIDATION
    // ==================================================

    if (!userId) {
      return res.status(401).json({
        status: false,
        message: "Authentication information not found",
      });
    }

    if (!otp) {
      return res.status(400).json({
        status: false,
        message: "OTP is required",
      });
    }

    // ==================================================
    // GET LOGGED-IN ADMIN EMAIL
    // ==================================================

    const getAdminQuery = `
      SELECT id, email
      FROM users
      WHERE id = ?
      LIMIT 1
    `;

    db.query(getAdminQuery, [userId], (err, userResult) => {
      if (err) {
        console.error("Admin lookup error:", err);

        return res.status(500).json({
          status: false,
          message: "Database Error",
        });
      }

      if (userResult.length === 0) {
        return res.status(404).json({
          status: false,
          message: "User not found",
        });
      }

      const email = userResult[0].email;

      // ==================================================
      // GET STORED OTP
      // ==================================================

      const record = adminOtpStore[email];

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
        delete adminOtpStore[email];

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

      delete adminOtpStore[email];

      // ==================================================
      // ALLOW PASSWORD RESET FOR 10 MINUTES
      // ==================================================

      adminVerifiedStore[email] = Date.now() + 10 * 60 * 1000;

      // ==================================================
      // RESPONSE
      // ==================================================

      return res.status(200).json({
        status: true,
        message: "OTP verified successfully",
      });
    });
  },
);

// ======================================================
// RESET PASSWORD (ADMIN)
// LOGGED-IN ADMIN ONLY (FROM PROFILE)
// ======================================================

router.post(
  "/admin-reset-password",
  authenticateAndAuthorize(),

  async (req, res) => {
    try {
      const userId = req.user?.id;

      const newPassword = req.body.newPassword;

      const confirmPassword = req.body.confirmPassword;

      // ==================================================
      // VALIDATION
      // ==================================================

      if (!userId) {
        return res.status(401).json({
          status: false,
          message: "Authentication information not found",
        });
      }

      if (!newPassword || !confirmPassword) {
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
      // GET LOGGED-IN ADMIN RECORD
      // ==================================================

      const checkAdminQuery = `
            SELECT id, email, role
            FROM users
            WHERE id = ?
            LIMIT 1
        `;

      db.query(checkAdminQuery, [userId], async (err, userResult) => {
        if (err) {
          console.error("Check admin error:", err);

          return res.status(500).json({
            status: false,
            message: "Database Error",
          });
        }

        if (userResult.length === 0) {
          return res.status(404).json({
            status: false,
            message: "User not found",
          });
        }

        const admin = userResult[0];

        if (String(admin.role).toLowerCase() !== "admin") {
          return res.status(403).json({
            status: false,
            message: "Access denied. Admin only.",
          });
        }

        const email = admin.email;

        // ==================================================
        // OTP VERIFICATION CHECK
        // ==================================================

        const verifiedUntil = adminVerifiedStore[email];

        if (!verifiedUntil || Date.now() > verifiedUntil) {
          delete adminVerifiedStore[email];

          return res.status(400).json({
            status: false,
            message: "OTP verification expired. Please start again.",
          });
        }

        // ==================================================
        // PASSWORD BCRYPT HASH
        // ==================================================

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        console.log("Admin password hashed successfully for:", email);

        // ==================================================
        // UPDATE ADMIN PASSWORD
        // ==================================================

        const updateAdminQuery = `
                UPDATE users
                SET password = ?
                WHERE id = ?
            `;

        db.query(updateAdminQuery, [hashedPassword, userId], (err, result) => {
          if (err) {
            console.error("Update admin password error:", err);

            return res.status(500).json({
              status: false,
              message: "Database Error",
            });
          }

          // ==================================================
          // PASSWORD UPDATED
          // ==================================================

          delete adminVerifiedStore[email];

          return res.status(200).json({
            status: true,
            message: "Password updated successfully",
          });
        });
      });
    } catch (error) {
      console.error("Admin reset password error:", error);

      return res.status(500).json({
        status: false,
        message: "Internal Server Error",
      });
    }
  },
);

// ======================================================
// EXPORT ROUTER
// ======================================================

module.exports = router;
