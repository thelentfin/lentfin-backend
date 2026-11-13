const express = require("express");
const router = express.Router();
const db = require("../db");
const nodemailer = require("nodemailer");
const bcrypt = require("bcryptjs");

const authenticateAndAuthorize = require("../middleware/authMiddleware");

// ======================================================
// OTP STORAGE
// ======================================================

const dsaOtpStore = {};
const dsaVerifiedStore = {};

// ======================================================
// NODEMAILER
// ======================================================

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// ======================================================
// SEND OTP (LOGGED-IN DSA)
// POST /api/dsa-password/dsa-forgot-password
// ======================================================

router.post("/dsa-forgot-password", authenticateAndAuthorize(), (req, res) => {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({
      status: false,
      message: "Authentication information not found",
    });
  }

  const query = `
      SELECT id,email,name,status
      FROM dsa_users
      WHERE id=?
      LIMIT 1
    `;

  db.query(query, [userId], (err, result) => {
    if (err) {
      return res.status(500).json({
        status: false,
        message: "Database Error",
      });
    }

    if (result.length === 0) {
      return res.status(404).json({
        status: false,
        message: "DSA user not found",
      });
    }

    const dsa = result[0];

    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    dsaOtpStore[dsa.email] = {
      otp,
      expiresAt: Date.now() + 5 * 60 * 1000,
    };

    transporter.sendMail(
      {
        from: `"${process.env.APP_NAME}" <${process.env.EMAIL_USER}>`,
        to: dsa.email,
        subject: "DSA Password Reset OTP",
        html: `
            <div style="font-family:Arial;padding:20px;">
              <h2>Hello ${dsa.name}</h2>
              <p>Your password reset OTP is:</p>
              <h1 style="letter-spacing:6px;">${otp}</h1>
              <p>Valid for <b>5 minutes</b>.</p>
            </div>
          `,
      },
      (mailErr) => {
        if (mailErr) {
          delete dsaOtpStore[dsa.email];

          return res.status(500).json({
            status: false,
            message: "Failed to send OTP",
          });
        }

        return res.status(200).json({
          status: true,
          message: "OTP sent successfully to your registered email",
        });
      },
    );
  });
});

// ======================================================
// VERIFY OTP
// POST /api/dsa-password/dsa-verify-otp
// ======================================================

router.post("/dsa-verify-otp", authenticateAndAuthorize(), (req, res) => {
  const userId = req.user?.id;
  const otp = String(req.body.otp || "").trim();

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

  db.query(
    `
        SELECT email
        FROM dsa_users
        WHERE id=?
        LIMIT 1
      `,
    [userId],
    (err, result) => {
      if (err) {
        return res.status(500).json({
          status: false,
          message: "Database Error",
        });
      }

      if (result.length === 0) {
        return res.status(404).json({
          status: false,
          message: "DSA user not found",
        });
      }

      const email = result[0].email;
      const record = dsaOtpStore[email];

      if (!record) {
        return res.status(400).json({
          status: false,
          message: "OTP not found",
        });
      }

      if (Date.now() > record.expiresAt) {
        delete dsaOtpStore[email];

        return res.status(400).json({
          status: false,
          message: "OTP expired",
        });
      }

      if (record.otp !== otp) {
        return res.status(400).json({
          status: false,
          message: "Invalid OTP",
        });
      }

      delete dsaOtpStore[email];

      dsaVerifiedStore[email] = Date.now() + 10 * 60 * 1000;

      return res.status(200).json({
        status: true,
        message: "OTP verified successfully",
      });
    },
  );
});

// ======================================================
// RESET PASSWORD
// POST /api/dsa-password/dsa-reset-password
// ======================================================

router.post(
  "/dsa-reset-password",
  authenticateAndAuthorize(),
  async (req, res) => {
    try {
      const userId = req.user?.id;
      const { newPassword, confirmPassword } = req.body;

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

      if (newPassword !== confirmPassword) {
        return res.status(400).json({
          status: false,
          message: "Passwords do not match",
        });
      }

      db.query(
        `
          SELECT email
          FROM dsa_users
          WHERE id=?
          LIMIT 1
        `,
        [userId],
        async (err, result) => {
          if (err) {
            return res.status(500).json({
              status: false,
              message: "Database Error",
            });
          }

          if (result.length === 0) {
            return res.status(404).json({
              status: false,
              message: "DSA user not found",
            });
          }

          const email = result[0].email;

          const verifiedUntil = dsaVerifiedStore[email];

          if (!verifiedUntil || Date.now() > verifiedUntil) {
            delete dsaVerifiedStore[email];

            return res.status(400).json({
              status: false,
              message: "OTP verification expired",
            });
          }

          const hashedPassword = await bcrypt.hash(newPassword, 10);

          db.query(
            `
              UPDATE dsa_users
              SET password=?
              WHERE id=?
            `,
            [hashedPassword, userId],
            (updateErr) => {
              if (updateErr) {
                return res.status(500).json({
                  status: false,
                  message: "Database Error",
                });
              }

              delete dsaVerifiedStore[email];

              return res.status(200).json({
                status: true,
                message: "Password updated successfully",
              });
            },
          );
        },
      );
    } catch (error) {
      return res.status(500).json({
        status: false,
        message: "Internal Server Error",
      });
    }
  },
);

module.exports = router;
