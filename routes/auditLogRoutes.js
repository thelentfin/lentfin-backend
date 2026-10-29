const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticateAndAuthorize = require("../middleware/authMiddleware");

// GET /api/audit-logs
// Fetch filtered, paginated audit activity logs (Admin only)
router.get("/", authenticateAndAuthorize("admin"), async (req, res) => {
  try {
    const {
      search,
      module: selectedModule,
      role: selectedRole,
      dateFilter,
      fromDate,
      toDate,
      page = 1,
      limit = 50,
    } = req.query;

    let whereClauses = ["1=1"];
    let params = [];

    // 1. Search Query
    if (search && search.trim()) {
      const q = `%${search.trim()}%`;
      whereClauses.push(
        "(summary LIKE ? OR details LIKE ? OR actor_name LIKE ? OR entity_name LIKE ? OR entity_id LIKE ? OR action_type LIKE ?)"
      );
      params.push(q, q, q, q, q, q);
    }

    // 2. Module Filter
    if (selectedModule && selectedModule !== "ALL") {
      whereClauses.push("module = ?");
      params.push(selectedModule);
    }

    // 3. Role Filter
    if (selectedRole && selectedRole !== "ALL") {
      whereClauses.push("actor_role = ?");
      params.push(selectedRole);
    }

    // 4. Date Filter
    if (dateFilter === "TODAY") {
      whereClauses.push("DATE(created_at) = CURDATE()");
    } else if (dateFilter === "LAST_7_DAYS") {
      whereClauses.push("created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)");
    } else if (fromDate && toDate) {
      whereClauses.push("DATE(created_at) BETWEEN ? AND ?");
      params.push(fromDate, toDate);
    } else if (fromDate) {
      whereClauses.push("DATE(created_at) >= ?");
      params.push(fromDate);
    } else if (toDate) {
      whereClauses.push("DATE(created_at) <= ?");
      params.push(toDate);
    }

    const whereSql = whereClauses.join(" AND ");

    // Total Count query
    const countSql = `SELECT COUNT(*) AS total FROM audit_logs WHERE ${whereSql}`;
    db.query(countSql, params, (err, countResult) => {
      if (err) {
        console.error("Audit log count query error:", err);
        return res.status(500).json({ status: false, message: "Error counting audit logs" });
      }

      const totalCount = countResult[0]?.total || 0;
      const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);
      const dataSql = `
        SELECT id, actor_id, actor_name, actor_role, action_type, module,
               entity_id, entity_name, summary, details, previous_value, new_value,
               ip_address, created_at
        FROM audit_logs
        WHERE ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `;

      const dataParams = [...params, parseInt(limit, 10), parseInt(offset, 10)];

      db.query(dataSql, dataParams, (err2, rows) => {
        if (err2) {
          console.error("Audit log list query error:", err2);
          return res.status(500).json({ status: false, message: "Error fetching audit logs" });
        }

        return res.status(200).json({
          status: true,
          data: rows,
          totalCount,
          page: parseInt(page, 10),
          limit: parseInt(limit, 10),
        });
      });
    });
  } catch (err) {
    console.error("GET /api/audit-logs error:", err);
    return res.status(500).json({ status: false, message: "Internal server error" });
  }
});

module.exports = router;
