const express = require("express");
const router = express.Router();
const db = require("../db");

// =====================================
// ADD LOCATION
// =====================================

router.post("/add-location", (req, res) => {
  const {
    company_id,

    location_name,
  } = req.body;

  if (!company_id || !location_name) {
    return res.json({
      status: false,

      message: "All Fields Required",
    });
  }

  const checkQuery = `
        SELECT *
        FROM locations
        WHERE company_id=?
        AND location_name=?
    `;

  db.query(
    checkQuery,

    [company_id, location_name],

    (err, result) => {
      if (err) {
        return res.status(500).json({
          status: false,

          message: "Database Error",
        });
      }

      if (result.length > 0) {
        return res.json({
          status: false,

          message: "Location Already Exists",
        });
      }

      const insertQuery = `
                INSERT INTO locations
                (

                    company_id,

                    location_name

                )

                VALUES (?,?)
            `;

    db.query(insertQuery, [company_id, location_name], (err, result) => {
      if (err) {
        return res.status(500).json({
          status: false,
          message: "Insert Error",
        });
      }

      // ==================================================
      // SOCKET.IO EVENT
      // ==================================================

      const io = req.app.get("io");

      io.to("admin").emit("dashboardUpdated", {
        type: "locationAdded",
        locationId: result.insertId,
        companyId: Number(company_id),
      });

      return res.json({
        status: true,
        message: "Location Added Successfully",
      });
    });
    },
  );
});

// // =====================================
// LOCATION LIST
// =====================================

router.get("/location-list", (req, res) => {
  const query = `

    SELECT

        locations.*,

        companies.company_name

    FROM locations

    INNER JOIN companies

    ON companies.id = locations.company_id

    ORDER BY locations.id DESC

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

// =====================================
// SINGLE LOCATION
// =====================================

router.get("/location/:id", (req, res) => {
  const id = req.params.id;

  db.query(
    "SELECT * FROM locations WHERE id=?",

    [id],

    (err, result) => {
      if (err) {
        return res.status(500).json({
          status: false,
        });
      }

      return res.json({
        status: true,

        data: result[0],
      });
    },
  );
});

// =====================================
// UPDATE LOCATION
// =====================================

router.put("/update-location/:id", (req, res) => {
  const id = req.params.id;

  const {
    company_id,

    location_name,

    status,
  } = req.body;

  const query = `

    UPDATE locations

    SET

    company_id=?,

    location_name=?,

    status=?

    WHERE id=?

    `;

 db.query(query, [company_id, location_name, status, id], (err) => {
   if (err) {
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
     type: "locationUpdated",
     locationId: Number(id),
     companyId: Number(company_id),
   });

   return res.json({
     status: true,
     message: "Location Updated",
   });
 });
});

// =====================================
// DELETE LOCATION
// =====================================

router.delete("/delete-location/:id", (req, res) => {
  const id = req.params.id;

  db.query("DELETE FROM locations WHERE id=?", [id], (err) => {
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
      type: "locationDeleted",
      locationId: Number(id),
    });

    return res.json({
      status: true,
      message: "Location Deleted",
    });
  });
});

module.exports = router;