const express = require("express");
const router = express.Router();

const db = require("../db");

// ======================================================
// AUTHENTICATION MIDDLEWARE
// ======================================================

const authenticateAndAuthorize = require("../middleware/authMiddleware");

// ======================================================
// GET ALL USERS
// ADMIN ONLY
// ======================================================

router.get(
  "/all",
  authenticateAndAuthorize(),

  (req, res) => {
    // ==================================================
    // STEP 1 - GET LOGGED-IN USER ID FROM JWT
    // ==================================================

    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        status: false,
        message: "Authentication information not found",
      });
    }

    // ==================================================
    // STEP 2 - CHECK LOGGED-IN USER
    // ==================================================

    const adminQuery = `
      SELECT
        id,
        name,
        email,
        role,
        status
      FROM users
      WHERE id = ?
      LIMIT 1
    `;

    db.query(adminQuery, [userId], (err, adminResult) => {
      // ==================================================
      // DATABASE ERROR
      // ==================================================

      if (err) {
        console.error("CHECK ADMIN ERROR:", err);

        return res.status(500).json({
          status: false,
          message: "Database Error",
        });
      }

      // ==================================================
      // USER NOT FOUND
      // ==================================================

      if (adminResult.length === 0) {
        return res.status(404).json({
          status: false,
          message: "User not found",
        });
      }

      const admin = adminResult[0];

      // ==================================================
      // STEP 3 - CHECK ADMIN ROLE
      // ==================================================

      if (String(admin.role).toLowerCase() !== "admin") {
        return res.status(403).json({
          status: false,
          message: "Access denied. Admin only.",
        });
      }

      // ==================================================
      // STEP 4 - CHECK ADMIN STATUS
      // ==================================================

      if (String(admin.status).toLowerCase() !== "active") {
        return res.status(403).json({
          status: false,
          message: "Admin account is inactive",
        });
      }

      // ==================================================
      // STEP 5 - GET ALL USERS
      // ==================================================

      const userQuery = `
          SELECT
            id,
            name,
            email,
            role,
            status,
            created_at,
            updated_at
          FROM users
          ORDER BY id DESC
        `;

      db.query(userQuery, (err, users) => {
        // ==================================================
        // DATABASE ERROR
        // ==================================================

        if (err) {
          console.error("GET ALL USERS ERROR:", err);

          return res.status(500).json({
            status: false,
            message: "Database Error",
          });
        }

        // ==================================================
        // SUCCESS
        // ==================================================

        return res.status(200).json({
          status: true,
          message: "Users fetched successfully",

          total_users: users.length,

          data: users,
        });
      });
    });
  },
);

// ======================================================
// EXPORT
// ======================================================

module.exports = router;
