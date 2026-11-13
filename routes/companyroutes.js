const express = require("express");
const router = express.Router();
const db = require("../db");
const { logAuditAction } = require("../utils/auditLogger");

// ===========================
// ADD COMPANY
// ===========================

router.post("/add-company", (req, res) => {
  const {
    company_name,
    company_email,
    company_mobile,
    spot_payment_percentage,
    five_days_payment_percentage,
    standard_payment_days,
    badge_color,
  } = req.body;

  if (!company_name) {
    return res.json({
      status: false,
      message: "Company Name Required",
    });
  }

  const spotPct =
    spot_payment_percentage !== undefined &&
    spot_payment_percentage !== "" &&
    !isNaN(Number(spot_payment_percentage))
      ? Number(spot_payment_percentage)
      : 0.85;

  const fiveDaysPct =
    five_days_payment_percentage !== undefined &&
    five_days_payment_percentage !== "" &&
    !isNaN(Number(five_days_payment_percentage))
      ? Number(five_days_payment_percentage)
      : 0.90;

  const standardDays =
    standard_payment_days !== undefined &&
    standard_payment_days !== "" &&
    !isNaN(Number(standard_payment_days))
      ? parseInt(standard_payment_days, 10)
      : 5;

  const selectedColor =
    badge_color && String(badge_color).trim().length > 0
      ? String(badge_color).trim()
      : "#7C3AED";

  const checkQuery =
    "SELECT id, company_name, badge_color FROM companies WHERE LOWER(company_name) = LOWER(?) OR (badge_color IS NOT NULL AND LOWER(badge_color) = LOWER(?))";

  db.query(checkQuery, [String(company_name).trim(), selectedColor], (err, result) => {
    if (err) {
      return res.status(500).json({
        status: false,
        message: "Database Error",
      });
    }

    if (result.length > 0) {
      const nameMatch = result.find(
        (r) => String(r.company_name).trim().toLowerCase() === String(company_name).trim().toLowerCase()
      );
      if (nameMatch) {
        return res.json({
          status: false,
          message: "Company Already Exists",
        });
      }
      return res.json({
        status: false,
        message: "This color is already assigned to another company. Please select a different color.",
      });
    }

    const insertQuery = `
INSERT INTO companies
(
    company_name,
    company_email,
    company_mobile,
    spot_payment_percentage,
    five_days_payment_percentage,
    standard_payment_days,
    badge_color
)
VALUES (?,?,?,?,?,?,?)
`;

    db.query(
      insertQuery,
      [company_name, company_email, company_mobile, spotPct, fiveDaysPct, standardDays, selectedColor],
      (err, result) => {
        if (err) {
          console.error("COMPANY INSERT ERROR:", err);

          return res.status(500).json({
            status: false,
            message: "Insert Error",
            error: err.message,
          });
        }
        
        // ==================================================
        // SOCKET.IO EVENT
        // ==================================================

        const io = req.app.get("io");

        io.to("admin").emit("dashboardUpdated", {
          type: "companyAdded",
          companyId: result.insertId,
        });

        // Non-blocking Audit Log
        logAuditAction({
          req,
          actionType: "COMPANY_ADDED",
          module: "Settings",
          entityId: `CORP-${result.insertId}`,
          entityName: company_name,
          summary: `Added new corporate partner: ${company_name}.`,
          details: `Spot: ${spotPct}% • 5-Days: ${fiveDaysPct}% • Standard: ${standardDays} Days`,
          newValue: company_name,
        });

        return res.json({
          status: true,
          message: "Company Added Successfully",
        });
      },
    );
  });
});

// ===========================
// COMPANY LIST
// ===========================

router.get("/company-list", (req, res) => {
  const query = `
    SELECT *
    FROM companies
    ORDER BY id DESC
    `;

  db.query(query, (err, result) => {
    if (err) {
      return res.status(500).json({
        status: false,
        message: "Database Error",
      });
    }

    return res.json({
      status: true,
      data: result,
    });
  });
});

// ===========================
// COMPANY DETAILS
// ===========================

router.get("/company/:id", (req, res) => {
  const id = req.params.id;

  db.query("SELECT * FROM companies WHERE id=?", [id], (err, result) => {
    if (err) {
      return res.status(500).json({
        status: false,
      });
    }

    return res.json({
      status: true,
      data: result[0],
    });
  });
});

// ===========================
// UPDATE COMPANY
// ===========================

router.put("/update-company/:id", (req, res) => {
  const id = req.params.id;

  const {
    company_name,
    company_email,
    company_mobile,
    status,
    spot_payment_percentage,
    five_days_payment_percentage,
    standard_payment_days,
    badge_color,
  } = req.body;

  const spotPct =
    spot_payment_percentage !== undefined &&
    spot_payment_percentage !== "" &&
    !isNaN(Number(spot_payment_percentage))
      ? Number(spot_payment_percentage)
      : null;

  const fiveDaysPct =
    five_days_payment_percentage !== undefined &&
    five_days_payment_percentage !== "" &&
    !isNaN(Number(five_days_payment_percentage))
      ? Number(five_days_payment_percentage)
      : null;

  const standardDays =
    standard_payment_days !== undefined &&
    standard_payment_days !== "" &&
    !isNaN(Number(standard_payment_days))
      ? parseInt(standard_payment_days, 10)
      : null;

  const checkColor = badge_color ? String(badge_color).trim() : null;

  const performUpdate = () => {
    const query = `
      UPDATE companies
      SET
        company_name = COALESCE(?, company_name),
        company_email = COALESCE(?, company_email),
        company_mobile = COALESCE(?, company_mobile),
        status = COALESCE(?, status),
        spot_payment_percentage = COALESCE(?, spot_payment_percentage),
        five_days_payment_percentage = COALESCE(?, five_days_payment_percentage),
        standard_payment_days = COALESCE(?, standard_payment_days),
        badge_color = COALESCE(?, badge_color)
      WHERE id = ?
    `;

    db.query(
      query,
      [
        company_name !== undefined ? company_name : null,
        company_email !== undefined ? company_email : null,
        company_mobile !== undefined ? company_mobile : null,
        status !== undefined ? status : null,
        spotPct,
        fiveDaysPct,
        standardDays,
        checkColor,
        id,
      ],
      (err) => {
        if (err) {
          console.error("COMPANY UPDATE ERROR:", err);
          return res.status(500).json({
            status: false,
            message: "Update Error",
          });
        }

        const io = req.app.get("io");
        io.to("admin").emit("dashboardUpdated", {
          type: "companyUpdated",
          companyId: Number(id),
        });

        logAuditAction({
          req,
          actionType: "COMPANY_UPDATED",
          module: "Settings",
          entityId: `CORP-${id}`,
          entityName: company_name || `Company #${id}`,
          summary: `Updated company details for ${company_name || `Company #${id}`}.`,
          details: `Color: ${checkColor || "Unchanged"}`,
          newValue: company_name,
        });

        return res.json({
          status: true,
          message: "Company Updated Successfully",
        });
      }
    );
  };

  if (checkColor) {
    db.query(
      "SELECT id, company_name FROM companies WHERE id != ? AND badge_color IS NOT NULL AND LOWER(badge_color) = LOWER(?)",
      [id, checkColor],
      (err, colorResult) => {
        if (!err && colorResult && colorResult.length > 0) {
          return res.json({
            status: false,
            message: `This color is already assigned to ${colorResult[0].company_name}. Please choose a different color.`,
          });
        }
        performUpdate();
      }
    );
    return;
  }

  performUpdate();
});

// ===========================
// DELETE COMPANY
// ===========================

router.delete("/delete-company/:id", (req, res) => {
  const id = req.params.id;

  db.query("DELETE FROM companies WHERE id=?", [id], (err) => {
    if (err) {
      return res.status(500).json({
        status: false,
        message: "Delete Error",
      });
    }

    // ==================================================
    // SOCKET.IO EVENT
    // ==================================================

    const io = req.app.get("io");

    io.to("admin").emit("dashboardUpdated", {
      type: "companyDeleted",
      companyId: Number(id),
    });

    // Non-blocking Audit Log
    logAuditAction({
      req,
      actionType: "COMPANY_DELETED",
      module: "Settings",
      entityId: `CORP-${id}`,
      summary: `Removed corporate partner #${id}.`,
    });

    return res.json({
      status: true,
      message: "Company Deleted",
    });
  });
});

module.exports = router;