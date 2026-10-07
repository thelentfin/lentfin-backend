const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticateAndAuthorize = require("../middleware/authMiddleware");

// =========================================================================
// 1. GET ACTIVE PRODUCTS & OPTIONS FOR A BANK (For Customer Application)
// GET /api/banks/:bankId/products
// =========================================================================
router.get(
  "/banks/:bankId/products",
  authenticateAndAuthorize("DSA", "admin", "Corporate DSA"),
  async (req, res) => {
    try {
      const { bankId } = req.params;

      if (!bankId || isNaN(Number(bankId))) {
        return res.status(400).json({
          status: false,
          message: "Valid bank ID is required.",
        });
      }

      // Check if bank exists and is active
      const [bankRows] = await db.promise().query(
        "SELECT id, bank_name, status FROM banks WHERE id = ? LIMIT 1",
        [bankId]
      );

      if (bankRows.length === 0) {
        return res.status(404).json({
          status: false,
          message: "Bank not found.",
        });
      }

      if (String(bankRows[0].status).toLowerCase() !== "active") {
        return res.status(400).json({
          status: false,
          message: "Selected bank is inactive.",
        });
      }

      // Fetch only active options for active products belonging to this bank
      const [rows] = await db.promise().query(
        `
        SELECT 
          p.id AS product_id,
          p.product_name,
          o.id AS option_id,
          o.option_label,
          o.payout_percentage,
          o.remarks
        FROM bank_product_payout_options o
        INNER JOIN products p ON o.product_id = p.id
        WHERE o.bank_id = ?
          AND o.status = 'Active'
          AND p.status = 'Active'
        ORDER BY p.id ASC, o.id ASC
        `,
        [bankId]
      );

      // Group options by product
      const productMap = new Map();

      for (const row of rows) {
        if (!productMap.has(row.product_id)) {
          productMap.set(row.product_id, {
            product_id: row.product_id,
            product_name: row.product_name,
            options: [],
          });
        }

        productMap.get(row.product_id).options.push({
          id: row.option_id,
          option_label: row.option_label,
          payout_percentage: parseFloat(row.payout_percentage) || 0,
          remarks: row.remarks,
        });
      }

      return res.status(200).json({
        status: true,
        message: "Active products fetched successfully.",
        bank_id: Number(bankId),
        bank_name: bankRows[0].bank_name,
        count: productMap.size,
        data: Array.from(productMap.values()),
      });
    } catch (error) {
      console.error("GET BANK PRODUCTS ERROR:", error);
      return res.status(500).json({
        status: false,
        message: "Failed to fetch bank products.",
        error: error.message,
      });
    }
  }
);

// =========================================================================
// 2. GET ALL MASTER PRODUCTS (Admin Settings)
// GET /api/admin/products
// =========================================================================
router.get(
  "/admin/products",
  authenticateAndAuthorize("admin"),
  async (req, res) => {
    try {
      const [products] = await db.promise().query(
        `SELECT id, product_name, status, created_at, updated_at FROM products ORDER BY id ASC`
      );

      return res.status(200).json({
        status: true,
        message: "Master products fetched successfully.",
        count: products.length,
        data: products,
      });
    } catch (error) {
      console.error("GET ADMIN PRODUCTS ERROR:", error);
      return res.status(500).json({
        status: false,
        message: "Failed to fetch master products.",
        error: error.message,
      });
    }
  }
);

// =========================================================================
// 3. TOGGLE MASTER PRODUCT STATUS (Admin Settings)
// PATCH /api/admin/products/:id/status
// =========================================================================
router.patch(
  "/admin/products/:id/status",
  authenticateAndAuthorize("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      if (!id || isNaN(Number(id))) {
        return res.status(400).json({ status: false, message: "Valid product ID is required." });
      }

      if (!status || !["Active", "Inactive"].includes(status)) {
        return res.status(400).json({
          status: false,
          message: "Valid status ('Active' or 'Inactive') is required.",
        });
      }

      const [result] = await db.promise().query(
        "UPDATE products SET status = ? WHERE id = ?",
        [status, id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ status: false, message: "Product not found." });
      }

      return res.status(200).json({
        status: true,
        message: `Product status updated to '${status}'.`,
      });
    } catch (error) {
      console.error("UPDATE PRODUCT STATUS ERROR:", error);
      return res.status(500).json({
        status: false,
        message: "Failed to update product status.",
        error: error.message,
      });
    }
  }
);

// =========================================================================
// 4. GET ALL PAYOUT CONFIGURATIONS FOR A BANK (Admin Settings)
// GET /api/admin/banks/:bankId/payouts
// =========================================================================
router.get(
  "/admin/banks/:bankId/payouts",
  authenticateAndAuthorize("admin"),
  async (req, res) => {
    try {
      const { bankId } = req.params;

      if (!bankId || isNaN(Number(bankId))) {
        return res.status(400).json({ status: false, message: "Valid bank ID is required." });
      }

      const [bank] = await db.promise().query(
        "SELECT id, bank_name, status FROM banks WHERE id = ? LIMIT 1",
        [bankId]
      );

      if (bank.length === 0) {
        return res.status(404).json({ status: false, message: "Bank not found." });
      }

      // Fetch all options for this bank including products
      const [rows] = await db.promise().query(
        `
        SELECT 
          p.id AS product_id,
          p.product_name,
          p.status AS product_master_status,
          o.id AS option_id,
          o.option_label,
          o.payout_percentage,
          o.status AS option_status,
          o.remarks,
          o.updated_at
        FROM products p
        LEFT JOIN bank_product_payout_options o 
          ON p.id = o.product_id AND o.bank_id = ?
        ORDER BY p.id ASC, o.id ASC
        `,
        [bankId]
      );

      // Group by product
      const productMap = new Map();

      for (const row of rows) {
        if (!productMap.has(row.product_id)) {
          productMap.set(row.product_id, {
            product_id: row.product_id,
            product_name: row.product_name,
            master_status: row.product_master_status,
            options: [],
          });
        }

        if (row.option_id) {
          productMap.get(row.product_id).options.push({
            id: row.option_id,
            option_label: row.option_label,
            payout_percentage: parseFloat(row.payout_percentage) || 0,
            status: row.option_status,
            remarks: row.remarks,
            updated_at: row.updated_at,
          });
        }
      }

      return res.status(200).json({
        status: true,
        bank: bank[0],
        products: Array.from(productMap.values()),
      });
    } catch (error) {
      console.error("GET ADMIN BANK PAYOUTS ERROR:", error);
      return res.status(500).json({
        status: false,
        message: "Failed to fetch bank payout options.",
        error: error.message,
      });
    }
  }
);

// =========================================================================
// 5. UPDATE A SPECIFIC PAYOUT OPTION (Admin Settings)
// PATCH /api/admin/payout-options/:id
// =========================================================================
router.patch(
  "/admin/payout-options/:id",
  authenticateAndAuthorize("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { payout_percentage, status, option_label, remarks } = req.body;

      if (!id || isNaN(Number(id))) {
        return res.status(400).json({ status: false, message: "Valid option ID is required." });
      }

      const updates = [];
      const values = [];

      if (status !== undefined) {
        if (!["Active", "Inactive"].includes(status)) {
          return res.status(400).json({
            status: false,
            message: "Status must be 'Active' or 'Inactive'.",
          });
        }
        updates.push("status = ?");
        values.push(status);
      }

      if (payout_percentage !== undefined) {
        const num = parseFloat(payout_percentage);
        if (isNaN(num) || num < 0) {
          return res.status(400).json({
            status: false,
            message: "Payout percentage must be a non-negative number.",
          });
        }
        updates.push("payout_percentage = ?");
        values.push(num);
      }

      if (option_label !== undefined && String(option_label).trim()) {
        updates.push("option_label = ?");
        values.push(String(option_label).trim());
      }

      if (remarks !== undefined) {
        updates.push("remarks = ?");
        values.push(remarks ? String(remarks).trim() : null);
      }

      if (updates.length === 0) {
        return res.status(400).json({ status: false, message: "No valid fields to update." });
      }

      values.push(id);

      const [result] = await db.promise().query(
        `UPDATE bank_product_payout_options SET ${updates.join(", ")} WHERE id = ?`,
        values
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ status: false, message: "Payout option not found." });
      }

      return res.status(200).json({
        status: true,
        message: "Payout option updated successfully.",
      });
    } catch (error) {
      console.error("UPDATE PAYOUT OPTION ERROR:", error);
      return res.status(500).json({
        status: false,
        message: "Failed to update payout option.",
        error: error.message,
      });
    }
  }
);

// =========================================================================
// 6. ADD A NEW PAYOUT OPTION (Admin Settings)
// POST /api/admin/payout-options/add
// =========================================================================
router.post(
  "/admin/payout-options/add",
  authenticateAndAuthorize("admin"),
  async (req, res) => {
    try {
      const { bank_id, product_id, option_label, payout_percentage, status, remarks } = req.body;

      if (!bank_id || !product_id) {
        return res.status(400).json({
          status: false,
          message: "bank_id and product_id are required.",
        });
      }

      const rate = parseFloat(payout_percentage) || 0.0;
      const label = option_label && String(option_label).trim() ? String(option_label).trim() : "Standard";
      const optStatus = status && ["Active", "Inactive"].includes(status) ? status : "Active";

      const [result] = await db.promise().query(
        `
        INSERT INTO bank_product_payout_options
          (bank_id, product_id, option_label, payout_percentage, status, remarks)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          payout_percentage = VALUES(payout_percentage),
          status = VALUES(status),
          remarks = VALUES(remarks)
        `,
        [bank_id, product_id, label, rate, optStatus, remarks || null]
      );

      return res.status(201).json({
        status: true,
        message: "Payout option created successfully.",
        id: result.insertId,
      });
    } catch (error) {
      console.error("ADD PAYOUT OPTION ERROR:", error);
      return res.status(500).json({
        status: false,
        message: "Failed to add payout option.",
        error: error.message,
      });
    }
  }
);

module.exports = router;
