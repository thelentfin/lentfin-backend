const express = require("express");
const router = express.Router();
const db = require("../db");

// ===========================
// ADD COMPANY
// ===========================

router.post("/add-company", (req, res) => {
  const { company_name, company_code, company_email, company_mobile, address } =
    req.body;

  if (!company_name) {
    return res.json({
      status: false,
      message: "Company Name Required",
    });
  }

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
            company_code,
            company_email,
            company_mobile,
            address
        )
        VALUES (?,?,?,?,?)
        `;

    db.query(
      insertQuery,
      [company_name, company_code, company_email, company_mobile, address],
      (err) => {
        if (err) {
          return res.status(500).json({
            status: false,
            message: "Insert Error",
          });
        }

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
    company_code,
    company_email,
    company_mobile,
    address,
    status,
  } = req.body;

  const query = `
    UPDATE companies
    SET

    company_name=?,

    company_code=?,

    company_email=?,

    company_mobile=?,

    address=?,

    status=?

    WHERE id=?
    `;

  db.query(
    query,
    [
      company_name,
      company_code,
      company_email,
      company_mobile,
      address,
      status,
      id,
    ],
    (err) => {
      if (err) {
        return res.status(500).json({
          status: false,
          message: "Update Error",
        });
      }

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

    return res.json({
      status: true,
      message: "Company Deleted",
    });
  });
});

module.exports = router;