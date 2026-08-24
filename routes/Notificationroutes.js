const express = require("express");
const router = express.Router();

const db = require("../db");
const authenticateAndAuthorize = require("../middleware/authMiddleware");

const requireAuth = authenticateAndAuthorize();

// ======================================================
// GET MY NOTIFICATIONS
//
// GET /api/notifications
//
// Works for ANY logged-in user (DSA or Admin/Corporate DSA).
// Returns:
// 1. Notifications specifically for this user
//    (recipient_user_id = logged-in user's own id)
// 2. BROADCAST notifications (recipient_user_id IS NULL)
//    -> these are inserted once for a signup request and
//       are meant to be visible to ALL admins, so every
//       admin's query must also include NULL rows.
// ======================================================

router.get("/", requireAuth, async (req, res) => {
  try {
    // ==================================================
    // LOGGED-IN USER ID
    // ==================================================

    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        status: false,
        message: "User authentication information not found.",
      });
    }

    console.log("NOTIFICATION USER ID:", userId);

    // ==================================================
    // GET NOTIFICATIONS
    // (own notifications + broadcast/NULL notifications)
    // ==================================================

    const [notifications] = await db.promise().execute(
      `
      SELECT
        id,
        notification_type,
        title,
        message,
        entity_type,
        entity_id,
        is_read,
        read_at,
        created_at
      FROM notifications
      WHERE recipient_user_id = ?
         OR recipient_user_id IS NULL
      ORDER BY created_at DESC, id DESC
      `,
      [userId],
    );

    return res.status(200).json({
      status: true,
      message: "Notifications fetched successfully.",
      count: notifications.length,
      data: notifications,
    });
  } catch (error) {
    console.error("GET NOTIFICATIONS ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to fetch notifications.",
      error: error.message,
    });
  }
});

// ======================================================
// GET UNREAD NOTIFICATION COUNT
//
// GET /api/notifications/unread-count
//
// Counts own notifications + broadcast (NULL) notifications
// ======================================================

router.get("/unread-count", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        status: false,
        message: "User authentication information not found.",
      });
    }

    console.log("UNREAD COUNT USER ID:", userId);

    // ==================================================
    // COUNT UNREAD
    // (own notifications + broadcast/NULL notifications)
    // ==================================================

    const [result] = await db.promise().execute(
      `
      SELECT COUNT(*) AS unread_count
      FROM notifications
      WHERE (recipient_user_id = ? OR recipient_user_id IS NULL)
        AND is_read = 0
      `,
      [userId],
    );

    return res.status(200).json({
      status: true,
      unread_count: Number(result[0].unread_count),
    });
  } catch (error) {
    console.error("GET UNREAD COUNT ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to fetch unread notification count.",
      error: error.message,
    });
  }
});

// ======================================================
// MARK ALL NOTIFICATIONS AS READ
//
// PUT /api/notifications/read-all
//
// Marks own notifications + broadcast (NULL) notifications
// as read. NOTE: since broadcast rows are shared across all
// admins, marking one as read here will mark it read for
// EVERY admin (single shared row).
// ======================================================

router.put("/read-all", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        status: false,
        message: "User authentication information not found.",
      });
    }

    // ==================================================
    // MARK ALL AS READ
    // (own notifications + broadcast/NULL notifications)
    // ==================================================

    const [result] = await db.promise().execute(
      `
      UPDATE notifications
      SET
        is_read = 1,
        read_at = NOW()
      WHERE (recipient_user_id = ? OR recipient_user_id IS NULL)
        AND is_read = 0
      `,
      [userId],
    );

    return res.status(200).json({
      status: true,
      message: "All notifications marked as read.",
      updated_count: result.affectedRows,
    });
  } catch (error) {
    console.error("MARK ALL NOTIFICATIONS READ ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to mark all notifications as read.",
      error: error.message,
    });
  }
});

// ======================================================
// MARK SINGLE NOTIFICATION AS READ
//
// PUT /api/notifications/:id/read
// ======================================================

router.put("/:id/read", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;

    const notificationId = Number(req.params.id);

    // ==================================================
    // VALIDATE USER
    // ==================================================

    if (!userId) {
      return res.status(401).json({
        status: false,
        message: "User authentication information not found.",
      });
    }

    // ==================================================
    // VALIDATE NOTIFICATION ID
    // ==================================================

    if (!Number.isInteger(notificationId) || notificationId <= 0) {
      return res.status(400).json({
        status: false,
        message: "Invalid notification ID.",
      });
    }

    // ==================================================
    // MARK SINGLE NOTIFICATION AS READ
    // (own notification OR broadcast/NULL notification)
    // ==================================================

    const [result] = await db.promise().execute(
      `
      UPDATE notifications
      SET
        is_read = 1,
        read_at = NOW()
      WHERE id = ?
        AND (recipient_user_id = ? OR recipient_user_id IS NULL)
      `,
      [notificationId, userId],
    );

    // ==================================================
    // CHECK NOTIFICATION
    // ==================================================

    if (result.affectedRows === 0) {
      return res.status(404).json({
        status: false,
        message: "Notification not found.",
      });
    }

    return res.status(200).json({
      status: true,
      message: "Notification marked as read.",
    });
  } catch (error) {
    console.error("MARK NOTIFICATION READ ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to mark notification as read.",
      error: error.message,
    });
  }
});

// ======================================================
// DELETE ALL READ NOTIFICATIONS
//
// DELETE /api/notifications/all
//
// Deletes ONLY READ notifications belonging to the
// currently logged-in user, PLUS read broadcast (NULL)
// notifications.
//
// Unread notifications (is_read = 0) will remain.
// ======================================================

router.delete("/all", requireAuth, async (req, res) => {
  try {
    // ==================================================
    // STEP 1 - GET LOGGED-IN USER ID
    // ==================================================

    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        status: false,
        message: "User authentication information not found.",
      });
    }

    // ==================================================
    // STEP 2 - DELETE ONLY READ NOTIFICATIONS
    // (own notifications + broadcast/NULL notifications)
    // ==================================================

    const [result] = await db.promise().execute(
      `
      DELETE FROM notifications
      WHERE (recipient_user_id = ? OR recipient_user_id IS NULL)
        AND is_read = 1
      `,
      [userId],
    );

    // ==================================================
    // STEP 3 - SUCCESS
    // ==================================================

    return res.status(200).json({
      status: true,
      message: "All read notifications deleted successfully.",
      deleted_count: result.affectedRows,
    });

  } catch (error) {
    console.error("DELETE ALL READ NOTIFICATIONS ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to delete all read notifications.",
      error: error.message,
    });
  }
});


// ======================================================
// DELETE SINGLE READ NOTIFICATION
//
// DELETE /api/notifications/:id
//
// Logged-in user can delete ONLY their own notification
// (or a broadcast/NULL notification) when that
// notification has already been read.
//
// Unread notification cannot be deleted.
// ======================================================

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    // ==================================================
    // STEP 1 - GET LOGGED-IN USER ID
    // ==================================================

    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        status: false,
        message: "User authentication information not found.",
      });
    }

    // ==================================================
    // STEP 2 - GET NOTIFICATION ID
    // ==================================================

    const notificationId = Number(req.params.id);

    // ==================================================
    // STEP 3 - VALIDATE NOTIFICATION ID
    // ==================================================

    if (!Number.isInteger(notificationId) || notificationId <= 0) {
      return res.status(400).json({
        status: false,
        message: "Invalid notification ID.",
      });
    }

    // ==================================================
    // STEP 4 - DELETE ONLY READ + (OWN OR BROADCAST)
    // ==================================================

    const [result] = await db.promise().execute(
      `
      DELETE FROM notifications
      WHERE id = ?
        AND (recipient_user_id = ? OR recipient_user_id IS NULL)
        AND is_read = 1
      `,
      [notificationId, userId],
    );

    // ==================================================
    // STEP 5 - CHECK RESULT
    // ==================================================

    if (result.affectedRows === 0) {
      return res.status(404).json({
        status: false,
        message:
          "Read notification not found or notification is still unread.",
      });
    }

    // ==================================================
    // STEP 6 - SUCCESS
    // ==================================================

    return res.status(200).json({
      status: true,
      message: "Read notification deleted successfully.",
      deleted_id: notificationId,
    });

  } catch (error) {
    console.error("DELETE SINGLE READ NOTIFICATION ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to delete read notification.",
      error: error.message,
    });
  }
});




module.exports = router;