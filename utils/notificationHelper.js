const db = require("../db");

// ======================================================
// DATABASE QUERY HELPER
// ======================================================

const query = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
};

// ======================================================
// NOTIFY ALL ACTIVE ADMINS
//
// Creates one notification row per active admin.
// Used by:
//   - DSA signup request  (notification_type: NEW_DSA_SIGNUP)
//   - Loan case final submit (notification_type: DSA_CASE_SUBMITTED)
//
// Any future admin-facing event can reuse this without
// duplicating the "fetch active admins + insert loop" logic.
// ======================================================

const notifyAllAdmins = async ({
  notificationType,
  title,
  message,
  entityType,
  entityId,
}) => {
  try {
    const admins = await query(
      `
      SELECT
        id,
        name,
        email,
        role
      FROM users
      WHERE LOWER(TRIM(role)) = 'admin'
        AND LOWER(TRIM(status)) = 'active'
      `,
    );

    for (const admin of admins) {
      await query(
        `
        INSERT INTO notifications (
          recipient_user_id,
          notification_type,
          title,
          message,
          entity_type,
          entity_id,
          is_read
        )
        VALUES (?, ?, ?, ?, ?, ?, 0)
        `,
        [admin.id, notificationType, title, message, entityType, entityId],
      );
    }

    console.log(
      `Notification (${notificationType}) created for ${admins.length} admin(s).`,
    );

    return { success: true, count: admins.length };
  } catch (error) {
    // Notification failure should NEVER fail the parent request
    // (signup / submit). We just log it here.
    console.error("NOTIFY ADMINS ERROR:", error);
    return { success: false, error: error.message };
  }
};

module.exports = { notifyAllAdmins, query };
