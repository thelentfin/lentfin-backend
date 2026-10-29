const db = require("../db");

/**
 * Log an operational action into audit_logs table.
 * Guaranteed NON-BLOCKING: will never throw error or disrupt existing API execution.
 */
async function logAuditAction({
  req = null,
  actorId = null,
  actorName = null,
  actorRole = null,
  actionType,
  module = "System",
  entityId = null,
  entityName = null,
  summary,
  details = null,
  previousValue = null,
  newValue = null,
  ipAddress = null,
}) {
  try {
    const finalActorId = actorId || req?.user?.id || null;
    const finalActorName = actorName || req?.user?.name || req?.user?.username || req?.user?.email || "Admin";
    const finalActorRole = actorRole || req?.user?.role || req?.user?.user_role || "admin";
    const finalIp = ipAddress || req?.ip || req?.headers?.["x-forwarded-for"] || "127.0.0.1";

    const prevStr = previousValue !== null && typeof previousValue === "object" ? JSON.stringify(previousValue) : previousValue;
    const newStr = newValue !== null && typeof newValue === "object" ? JSON.stringify(newValue) : newValue;

    const sql = `
      INSERT INTO audit_logs 
      (actor_id, actor_name, actor_role, action_type, module, entity_id, entity_name, summary, details, previous_value, new_value, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(
      sql,
      [
        finalActorId,
        finalActorName,
        finalActorRole,
        actionType,
        module,
        entityId ? String(entityId) : null,
        entityName ? String(entityName) : null,
        summary,
        details,
        prevStr,
        newStr,
        finalIp,
      ],
      (err) => {
        if (err) {
          console.error("Non-blocking audit log insert error:", err.message);
        }
      }
    );
  } catch (err) {
    // Non-blocking: Audit logging must never interfere with existing operations
    console.error("Non-blocking audit log exception:", err.message);
  }
}

module.exports = { logAuditAction };
