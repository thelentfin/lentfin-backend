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
// 2A. CREATE NEW MASTER PRODUCT (Admin Settings)
// POST /api/admin/products
// =========================================================================
router.post(
  "/admin/products",
  authenticateAndAuthorize("admin"),
  async (req, res) => {
    try {
      const { product_name, status = "Active", auto_link_banks = true } = req.body;

      if (!product_name || !String(product_name).trim()) {
        return res.status(400).json({
          status: false,
          message: "Product name is required.",
        });
      }

      const trimmedName = String(product_name).trim();
      const productStatus = ["Active", "Inactive"].includes(status) ? status : "Active";

      // Check duplicate product
      const [existing] = await db.promise().query(
        "SELECT id FROM products WHERE LOWER(product_name) = LOWER(?) LIMIT 1",
        [trimmedName]
      );

      if (existing.length > 0) {
        return res.status(409).json({
          status: false,
          message: `Product '${trimmedName}' already exists.`,
        });
      }

      // Insert product
      const [result] = await db.promise().query(
        "INSERT INTO products (product_name, status) VALUES (?, ?)",
        [trimmedName, productStatus]
      );

      const newProductId = result.insertId;

      // Auto-link active banks if requested
      let linkedBanksCount = 0;
      if (auto_link_banks) {
        try {
          const [activeBanks] = await db.promise().query(
            "SELECT id FROM banks WHERE status = 'Active'"
          );

          if (activeBanks.length > 0) {
            const rows = activeBanks.map((b) => [
              b.id,
              newProductId,
              "Standard",
              0.00,
              "Inactive",
              "Auto-linked on product creation",
            ]);

            await db.promise().query(
              `INSERT IGNORE INTO bank_product_payout_options
               (bank_id, product_id, option_label, payout_percentage, status, remarks)
               VALUES ?`,
              [rows]
            );
            linkedBanksCount = activeBanks.length;
          }
        } catch (linkErr) {
          console.warn("Auto-linking banks warning:", linkErr.message);
        }
      }

      return res.status(201).json({
        status: true,
        message: `Product '${trimmedName}' created successfully.`,
        data: {
          id: newProductId,
          product_name: trimmedName,
          status: productStatus,
          linked_banks_count: linkedBanksCount,
        },
      });
    } catch (error) {
      console.error("CREATE MASTER PRODUCT ERROR:", error);
      return res.status(500).json({
        status: false,
        message: "Failed to create product.",
        error: error.message,
      });
    }
  }
);

// =========================================================================
// 2B. UPDATE MASTER PRODUCT (Admin Settings)
// PUT /api/admin/products/:id
// =========================================================================
router.put(
  "/admin/products/:id",
  authenticateAndAuthorize("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { product_name, status } = req.body;

      if (!id || isNaN(Number(id))) {
        return res.status(400).json({ status: false, message: "Valid product ID is required." });
      }

      const updates = [];
      const values = [];

      if (product_name !== undefined && String(product_name).trim()) {
        const trimmedName = String(product_name).trim();
        // Check duplicate if name is changing
        const [duplicate] = await db.promise().query(
          "SELECT id FROM products WHERE LOWER(product_name) = LOWER(?) AND id != ? LIMIT 1",
          [trimmedName, id]
        );
        if (duplicate.length > 0) {
          return res.status(409).json({
            status: false,
            message: `Another product named '${trimmedName}' already exists.`,
          });
        }
        updates.push("product_name = ?");
        values.push(trimmedName);
      }

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

      if (updates.length === 0) {
        return res.status(400).json({ status: false, message: "No valid fields provided to update." });
      }

      values.push(id);
      const [result] = await db.promise().query(
        `UPDATE products SET ${updates.join(", ")} WHERE id = ?`,
        values
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ status: false, message: "Product not found." });
      }

      return res.status(200).json({
        status: true,
        message: "Product updated successfully.",
      });
    } catch (error) {
      console.error("UPDATE MASTER PRODUCT ERROR:", error);
      return res.status(500).json({
        status: false,
        message: "Failed to update product.",
        error: error.message,
      });
    }
  }
);

// =========================================================================
// 2B-2. DELETE MASTER PRODUCT (Admin Settings)
// DELETE /api/admin/products/:id
// =========================================================================
router.delete(
  "/admin/products/:id",
  authenticateAndAuthorize("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!id || isNaN(Number(id))) {
        return res.status(400).json({ status: false, message: "Valid product ID is required." });
      }

      // Check if product is in use by any loan cases
      const [caseRows] = await db.promise().query(
        "SELECT COUNT(*) AS count FROM loan_cases WHERE product_id = ?",
        [id]
      );

      if (caseRows[0]?.count > 0) {
        return res.status(400).json({
          status: false,
          message: `Cannot delete product because it is linked to ${caseRows[0].count} active loan case(s). Please deactivate it instead.`,
        });
      }

      // Delete associated payout options first
      await db.promise().query(
        "DELETE FROM bank_product_payout_options WHERE product_id = ?",
        [id]
      );

      // Delete product
      const [result] = await db.promise().query(
        "DELETE FROM products WHERE id = ?",
        [id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ status: false, message: "Product not found." });
      }

      return res.status(200).json({
        status: true,
        message: "Loan product deleted successfully.",
      });
    } catch (error) {
      console.error("DELETE MASTER PRODUCT ERROR:", error);
      return res.status(500).json({
        status: false,
        message: "Failed to delete product.",
        error: error.message,
      });
    }
  }
);

// =========================================================================
// 2C. GET PRODUCT-WISE BANK RATES (Product-Centric Comparison)
// GET /api/admin/products/:productId/banks
// =========================================================================
router.get(
  "/admin/products/:productId/banks",
  authenticateAndAuthorize("admin"),
  async (req, res) => {
    try {
      const { productId } = req.params;

      if (!productId || isNaN(Number(productId))) {
        return res.status(400).json({ status: false, message: "Valid product ID is required." });
      }

      const [productRows] = await db.promise().query(
        "SELECT id, product_name, status, created_at, updated_at FROM products WHERE id = ? LIMIT 1",
        [productId]
      );

      if (productRows.length === 0) {
        return res.status(404).json({ status: false, message: "Product not found." });
      }

      const product = productRows[0];

      // Fetch all banks and their options for this product
      const [rows] = await db.promise().query(
        `
        SELECT
          b.id AS bank_id,
          b.bank_name,
          b.status AS bank_status,
          o.id AS option_id,
          o.option_label,
          o.payout_percentage,
          o.status AS option_status,
          o.remarks,
          o.updated_at
        FROM banks b
        LEFT JOIN bank_product_payout_options o
          ON b.id = o.bank_id AND o.product_id = ?
        ORDER BY b.bank_name ASC, o.id ASC
        `,
        [productId]
      );

      // Group options by bank
      const bankMap = new Map();

      for (const row of rows) {
        if (!bankMap.has(row.bank_id)) {
          bankMap.set(row.bank_id, {
            bank_id: row.bank_id,
            bank_name: row.bank_name,
            bank_status: row.bank_status,
            options: [],
            highest_rate: 0,
            has_active_option: false,
          });
        }

        if (row.option_id) {
          const rate = parseFloat(row.payout_percentage) || 0;
          const isOptActive = row.option_status === "Active";

          const bankObj = bankMap.get(row.bank_id);
          bankObj.options.push({
            id: row.option_id,
            option_label: row.option_label,
            payout_percentage: rate,
            status: row.option_status,
            remarks: row.remarks,
            updated_at: row.updated_at,
          });

          if (rate > bankObj.highest_rate) {
            bankObj.highest_rate = rate;
          }
          if (isOptActive) {
            bankObj.has_active_option = true;
          }
        }
      }

      const bankList = Array.from(bankMap.values());

      return res.status(200).json({
        status: true,
        product,
        total_banks: bankList.length,
        active_banks: bankList.filter((b) => b.has_active_option).length,
        data: bankList,
      });
    } catch (error) {
      console.error("GET PRODUCT BANK RATES ERROR:", error);
      return res.status(500).json({
        status: false,
        message: "Failed to fetch bank rates for product.",
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
