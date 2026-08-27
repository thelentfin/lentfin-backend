const express = require("express");
const router = express.Router();

const db = require("../db");
const authenticateAndAuthorize = require("../middleware/authMiddleware");

// ======================================================
// ADMIN AUTHENTICATION
// ======================================================



// ======================================================
// 1. ADD BANK
// POST /api/bank/add
// ======================================================

router.post("/add", authenticateAndAuthorize(), async (req, res) => {
  try {
    const { bank_name } = req.body;

    // ==================================================
    // VALIDATION
    // ==================================================

    if (!bank_name || !bank_name.trim()) {
      return res.status(400).json({
        status: false,
        message: "Bank name is required.",
      });
    }

    const bankName = bank_name.trim();

    // ==================================================
    // CHECK DUPLICATE BANK
    // ==================================================

    const [existingBank] = await db.promise().execute(
      `
      SELECT id
      FROM banks
      WHERE LOWER(bank_name) = LOWER(?)
      LIMIT 1
      `,
      [bankName],
    );

    if (existingBank.length > 0) {
      return res.status(409).json({
        status: false,
        message: "Bank already exists.",
      });
    }

    // ==================================================
    // INSERT BANK
    // ==================================================

    const [result] = await db.promise().execute(
      `
      INSERT INTO banks
      (bank_name, status)
      VALUES (?, 'Active')
      `,
      [bankName],
    );

    // ==================================================
    // GET CREATED BANK
    // ==================================================

    const [newBank] = await db.promise().execute(
      `
      SELECT
        id,
        bank_name,
        status,
        created_at,
        updated_at
      FROM banks
      WHERE id = ?
      `,
      [result.insertId],
    );
    // ==================================================
    // SOCKET.IO EVENT
    // ==================================================

   const io = req.app.get("io");

   if (io) {
     io.to("admin").emit("dashboardUpdated", {
       type: "bankAdded",
       bankId: result.insertId,
     });
   }
    return res.status(201).json({
      status: true,
      message: "Bank added successfully.",
      data: newBank[0],
    });
  } catch (error) {
    console.error("ADD BANK ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to add bank.",
      error: error.message,
    });
  }
});

// ======================================================
// 2. GET ALL BANKS
// GET /api/bank/list
// ======================================================

router.get(
  "/list",
  authenticateAndAuthorize("DSA", "admin", "Corporate DSA"),
  async (req, res) => {
    try {
      // ==================================================
      // GET ALL BANKS
      // ==================================================

      const [banks] = await db.promise().execute(
        `
      SELECT
        id,
        bank_name,
        status,
        created_at,
        updated_at
      FROM banks
      ORDER BY id DESC
      `,
      );

      // ==================================================
      // SUCCESS RESPONSE
      // ==================================================

      return res.status(200).json({
        status: true,
        message: "Banks fetched successfully.",
        count: banks.length,
        data: banks,
      });
    } catch (error) {
      console.error("GET BANKS ERROR:", error);

      return res.status(500).json({
        status: false,
        message: "Failed to fetch banks.",
        error: error.message,
      });
    }
  },
);

// ======================================================
// 3. GET SINGLE BANK
// GET /api/bank/:id
// ======================================================

// ======================================================
// 3. GET SINGLE BANK
// GET /api/bank/:id
// ======================================================

router.get("/:id", authenticateAndAuthorize(), async (req, res) => {
  try {
    const { id } = req.params;

    // ==================================================
    // VALIDATE ID
    // ==================================================

    if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
      return res.status(400).json({
        status: false,
        message: "Invalid bank ID.",
      });
    }

    // ==================================================
    // GET BANK
    // ==================================================

    const [banks] = await db.promise().execute(
      `
      SELECT
        id,
        bank_name,
        status,
        created_at,
        updated_at
      FROM banks
      WHERE id = ?
      LIMIT 1
      `,
      [id],
    );

    // ==================================================
    // CHECK BANK EXISTS
    // ==================================================

    if (banks.length === 0) {
      return res.status(404).json({
        status: false,
        message: "Bank not found.",
      });
    }

    // ==================================================
    // SUCCESS RESPONSE
    // ==================================================

    return res.status(200).json({
      status: true,
      message: "Bank fetched successfully.",
      data: banks[0],
    });

  } catch (error) {
    console.error("GET SINGLE BANK ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to fetch bank.",
      error: error.message,
    });
  }
});

// ======================================================
// 4. UPDATE BANK
// PUT /api/bank/:id
// ======================================================

router.put("/:id", authenticateAndAuthorize(), async (req, res) => {
  try {
    const { id } = req.params;
    const { bank_name, status } = req.body;

    // ==================================================
    // VALIDATE ID
    // ==================================================

    if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
      return res.status(400).json({
        status: false,
        message: "Invalid bank ID.",
      });
    }

    // ==================================================
    // VALIDATE BANK NAME
    // ==================================================

    if (!bank_name || !bank_name.trim()) {
      return res.status(400).json({
        status: false,
        message: "Bank name is required.",
      });
    }

    // ==================================================
    // VALIDATE STATUS
    // ==================================================

    if (status !== undefined && status !== "Active" && status !== "Inactive") {
      return res.status(400).json({
        status: false,
        message: "Status must be Active or Inactive.",
      });
    }

    const bankName = bank_name.trim();

    // ==================================================
    // CHECK BANK EXISTS
    // ==================================================

    const [existingBank] = await db.promise().execute(
      `
      SELECT id
      FROM banks
      WHERE id = ?
      LIMIT 1
      `,
      [id],
    );

    if (existingBank.length === 0) {
      return res.status(404).json({
        status: false,
        message: "Bank not found.",
      });
    }

    // ==================================================
    // CHECK DUPLICATE BANK NAME
    // ==================================================

    const [duplicateBank] = await db.promise().execute(
      `
      SELECT id
      FROM banks
      WHERE LOWER(bank_name) = LOWER(?)
      AND id != ?
      LIMIT 1
      `,
      [bankName, id],
    );

    if (duplicateBank.length > 0) {
      return res.status(409).json({
        status: false,
        message: "Another bank with this name already exists.",
      });
    }

    // ==================================================
    // UPDATE BANK
    // ==================================================

    await db.promise().execute(
      `
      UPDATE banks
      SET
        bank_name = ?,
        status = COALESCE(?, status)
      WHERE id = ?
      `,
      [bankName, status || null, id],
    );

    // ==================================================
    // GET UPDATED BANK
    // ==================================================

    const [updatedBank] = await db.promise().execute(
      `
      SELECT
        id,
        bank_name,
        status,
        created_at,
        updated_at
      FROM banks
      WHERE id = ?
      LIMIT 1
      `,
      [id],
    );
    // ==================================================
    // SOCKET.IO EVENT
    // ==================================================

    const io = req.app.get("io");

    io.to("admin").emit("dashboardUpdated", {
      type: "bankUpdated",
      bankId: Number(id),
    });
    // ==================================================
    // SUCCESS RESPONSE
    // ==================================================

    return res.status(200).json({
      status: true,
      message: "Bank updated successfully.",
      data: updatedBank[0],
    });
  } catch (error) {
    console.error("UPDATE BANK ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to update bank.",
      error: error.message,
    });
  }
});
// ======================================================
// 5. DELETE BANK
// DELETE /api/bank/:id
// ======================================================

router.delete("/:id", authenticateAndAuthorize(), async (req, res) => {
  try {
    const { id } = req.params;

    // ==================================================
    // VALIDATE ID
    // ==================================================

    if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
      return res.status(400).json({
        status: false,
        message: "Invalid bank ID.",
      });
    }

    // ==================================================
    // CHECK BANK EXISTS
    // ==================================================

    const [existingBank] = await db.promise().execute(
      `
      SELECT
        id,
        bank_name
      FROM banks
      WHERE id = ?
      LIMIT 1
      `,
      [id],
    );

    if (existingBank.length === 0) {
      return res.status(404).json({
        status: false,
        message: "Bank not found.",
      });
    }

    // ==================================================
    // DELETE BANK
    // ==================================================

    await db.promise().execute(
      `
      DELETE FROM banks
      WHERE id = ?
      `,
      [id],
    );
    // ==================================================
    // SOCKET.IO EVENT
    // ==================================================

    const io = req.app.get("io");

    io.to("admin").emit("dashboardUpdated", {
      type: "bankDeleted",
      bankId: Number(id),
    });
    // ==================================================
    // SUCCESS RESPONSE
    // ==================================================

    return res.status(200).json({
      status: true,
      message: "Bank deleted successfully.",
    });
  } catch (error) {
    console.error("DELETE BANK ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to delete bank.",
      error: error.message,
    });
  }
});
module.exports = router;
