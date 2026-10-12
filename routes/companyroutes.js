const express = require("express");
const router = express.Router();
const db = require("../db");

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

  const checkQuery = "SELECT * FROM companies WHERE company_name = ?";

  db.query(checkQuery, [company_name], (err, result) => {
    if (err) {
      return res.status(500).json({
        status: false,
        message: "Database Error",
      });
    }

    if (result.length > 0) {
      return res.json({
        status: false,
        message: "Company Already Exists",
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
    standard_payment_days
)
VALUES (?,?,?,?,?,?)
`;

    db.query(
      insertQuery,
      [company_name, company_email, company_mobile, spotPct, fiveDaysPct, standardDays],
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

  const query = `
    UPDATE companies
    SET
      company_name = COALESCE(?, company_name),
      company_email = COALESCE(?, company_email),
      company_mobile = COALESCE(?, company_mobile),
      status = COALESCE(?, status),
      spot_payment_percentage = COALESCE(?, spot_payment_percentage),
      five_days_payment_percentage = COALESCE(?, five_days_payment_percentage),
      standard_payment_days = COALESCE(?, standard_payment_days)
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

      // ==================================================
      // SOCKET.IO EVENT
      // ==================================================

      const io = req.app.get("io");

      io.to("admin").emit("dashboardUpdated", {
        type: "companyUpdated",
        companyId: Number(id),
      });

      return res.json({
        status: true,
        message: "Company Updated",
      });
    },
  );
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

    return res.json({
      status: true,
      message: "Company Deleted",
    });
  });
});

module.exports = router;