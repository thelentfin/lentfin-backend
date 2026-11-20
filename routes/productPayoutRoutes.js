const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticateAndAuthorize = require("../middleware/authMiddleware");
const { logAuditAction } = require("../utils/auditLogger");

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

      // Non-blocking Audit Log
      logAuditAction({
        req,
        actionType: "PRODUCT_CREATED",
        module: "Product Master",
        entityId: `PROD-${newProductId}`,
        entityName: trimmedName,
        summary: `Created new loan product: ${trimmedName}.`,
        newValue: productStatus,
      });

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

      const [existingProd] = await db.promise().query(
        "SELECT id, product_name, status FROM products WHERE id = ? LIMIT 1",
        [id]
      );
      if (existingProd.length === 0) {
        return res.status(404).json({ status: false, message: "Product not found." });
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

      // Non-blocking Audit Log
      logAuditAction({
        req,
        actionType: "PRODUCT_UPDATED",
        module: "Product Master",
        entityId: `PROD-${id}`,
        entityName: product_name ? String(product_name).trim() : existingProd[0]?.product_name,
        summary: status && status !== existingProd[0]?.status
          ? `Changed product '${existingProd[0]?.product_name}' status from ${existingProd[0]?.status} to ${status}.`
          : `Updated details for product '${existingProd[0]?.product_name}'.`,
        previousValue: existingProd[0]?.status,
        newValue: status || existingProd[0]?.status,
      });

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
  ["/admin/products/:productId/banks", "/products/:productId/banks"],
  authenticateAndAuthorize("admin", "DSA", "Corporate DSA", "dsa"),
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

      const [existingProd] = await db.promise().query(
        "SELECT id, product_name, status FROM products WHERE id = ? LIMIT 1",
        [id]
      );

      const [result] = await db.promise().query(
        "UPDATE products SET status = ? WHERE id = ?",
        [status, id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ status: false, message: "Product not found." });
      }

      // Non-blocking Audit Log
      logAuditAction({
        req,
        actionType: "PRODUCT_STATUS_UPDATED",
        module: "Product Master",
        entityId: `PROD-${id}`,
        entityName: existingProd[0]?.product_name || `Product #${id}`,
        summary: `Changed product '${existingProd[0]?.product_name || id}' status from ${existingProd[0]?.status || "—"} to ${status}.`,
        previousValue: existingProd[0]?.status || "—",
        newValue: status,
      });

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

      const [existingOpt] = await db.promise().query(
        `SELECT bppo.payout_percentage, bppo.status, bppo.option_label, b.bank_name, p.product_name
         FROM bank_product_payout_options bppo
         LEFT JOIN banks b ON bppo.bank_id = b.id
         LEFT JOIN products p ON bppo.product_id = p.id
         WHERE bppo.id = ? LIMIT 1`,
        [id]
      );

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

      // Non-blocking Audit Log
      if (existingOpt.length > 0) {
        const isRateChanged = payout_percentage !== undefined && Number(payout_percentage) !== Number(existingOpt[0]?.payout_percentage);
        logAuditAction({
          req,
          actionType: isRateChanged ? "BANK_RATE_UPDATED" : "PAYOUT_SLAB_UPDATED",
          module: "Bank Master",
          entityId: `OPT-${id}`,
          entityName: `${existingOpt[0]?.bank_name || "Bank"} - ${existingOpt[0]?.product_name || "Product"}`,
          summary: isRateChanged
            ? `Updated bank rate for ${existingOpt[0]?.bank_name} - ${existingOpt[0]?.product_name} (${existingOpt[0]?.option_label || "Standard"}) from ${existingOpt[0]?.payout_percentage}% to ${payout_percentage}%.`
            : `Updated payout option status to '${status || existingOpt[0]?.status}' for ${existingOpt[0]?.bank_name} - ${existingOpt[0]?.product_name}.`,
          details: remarks || `Option: ${option_label || existingOpt[0]?.option_label}`,
          previousValue: `${existingOpt[0]?.payout_percentage}% (${existingOpt[0]?.status})`,
          newValue: `${payout_percentage !== undefined ? payout_percentage : existingOpt[0]?.payout_percentage}% (${status || existingOpt[0]?.status})`,
        });
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

// =========================================================================
// 7A. GET ALL DSA CUSTOM PAYOUT RATES (Admin Settings - Bulk Initial Load)
// GET /api/admin/dsa-payout-rates
// =========================================================================
router.get(
  "/admin/dsa-payout-rates",
  authenticateAndAuthorize("admin"),
  async (req, res) => {
    try {
      try {
        const [rows] = await db.promise().query(
          "SELECT dsa_id, bank_id, product_id, payout_percentage FROM dsa_product_payout_rates"
        );

        const allRatesMap = {};
        for (const row of rows) {
          if (!allRatesMap[row.dsa_id]) {
            allRatesMap[row.dsa_id] = {};
          }
          if (!allRatesMap[row.dsa_id][row.bank_id]) {
            allRatesMap[row.dsa_id][row.bank_id] = {};
          }
          allRatesMap[row.dsa_id][row.bank_id][row.product_id] = parseFloat(row.payout_percentage) || 0;
        }

        return res.status(200).json({ status: true, data: allRatesMap });
      } catch (dbErr) {
        if (dbErr.code === "ER_NO_SUCH_TABLE") {
          return res.status(200).json({ status: true, data: {} });
        }
        throw dbErr;
      }
    } catch (error) {
      console.error("GET ALL DSA PAYOUT RATES ERROR:", error);
      return res.status(500).json({ status: false, message: "Failed to fetch all DSA payout rates.", error: error.message });
    }
  }
);

// =========================================================================
// 7. GET DSA CUSTOM PAYOUT RATES FOR A SPECIFIC USER (Admin Settings)
// GET /api/admin/dsa-payout-rates/:dsaId
// =========================================================================
router.get(
  "/admin/dsa-payout-rates/:dsaId",
  authenticateAndAuthorize("admin"),
  async (req, res) => {
    try {
      const { dsaId } = req.params;
      if (!dsaId || isNaN(Number(dsaId))) {
        return res.status(400).json({ status: false, message: "Valid DSA ID is required." });
      }

      try {
        const [rows] = await db.promise().query(
          "SELECT bank_id, product_id, payout_percentage FROM dsa_product_payout_rates WHERE dsa_id = ?",
          [Number(dsaId)]
        );

        const ratesMap = {};
        for (const row of rows) {
          if (!ratesMap[row.bank_id]) {
            ratesMap[row.bank_id] = {};
          }
          ratesMap[row.bank_id][row.product_id] = parseFloat(row.payout_percentage) || 0;
        }

        return res.status(200).json({ status: true, data: ratesMap });
      } catch (dbErr) {
        if (dbErr.code === "ER_NO_SUCH_TABLE") {
          return res.status(200).json({ status: true, data: {} });
        }
        throw dbErr;
      }
    } catch (error) {
      console.error("GET DSA PAYOUT RATES ERROR:", error);
      return res.status(500).json({ status: false, message: "Failed to fetch DSA payout rates.", error: error.message });
    }
  }
);

// =========================================================================
// 8. SAVE DSA CUSTOM PAYOUT RATES (Admin Settings)
// POST /api/admin/dsa-payout-rates
// Body: { dsa_id, bank_id, rates: { [product_id]: percentage } }
// =========================================================================
router.post(
  "/admin/dsa-payout-rates",
  authenticateAndAuthorize("admin"),
  async (req, res) => {
    try {
      const { dsa_id, bank_id, rates, dsa_code: incomingDsaCode } = req.body;
      if (!dsa_id || !bank_id || !rates || typeof rates !== "object") {
        return res.status(400).json({ status: false, message: "dsa_id, bank_id, and rates are required." });
      }

      // 1. Fetch DSA User details for audit log (lookup original dsa_code and parent DSA)
      let dsaCode = incomingDsaCode ? String(incomingDsaCode).trim() : null;
      let dsaPartnerName = "";
      let parentDsaId = null;
      try {
        let uRows = [];
        try {
          const [dRows] = await db.promise().query(
            "SELECT id, name, firm_name, dsa_code, referred_by_dsa_id FROM dsa_users WHERE id = ? LIMIT 1",
            [Number(dsa_id)]
          );
          uRows = dRows;
        } catch (dErr) {
          // If dsa_users is unavailable, fallback to users table
        }

        if (uRows.length === 0) {
          try {
            const [regRows] = await db.promise().query(
              "SELECT id, name, firm_name, dsa_code, referred_by_dsa_id FROM users WHERE id = ? LIMIT 1",
              [Number(dsa_id)]
            );
            uRows = regRows;
          } catch (rErr) {
            // silent catch
          }
        }

        if (uRows.length > 0) {
          if (!dsaCode && uRows[0].dsa_code) {
            dsaCode = uRows[0].dsa_code;
          }
          dsaPartnerName = uRows[0].name || uRows[0].firm_name || "";
          parentDsaId = uRows[0].referred_by_dsa_id ? Number(uRows[0].referred_by_dsa_id) : null;
        }
      } catch (uErr) {
        console.warn("Audit lookup user warning:", uErr.message);
      }

      // 1B. Enforce Validation: Sub-DSA rate must be strictly lesser than Master DSA rate
      if (parentDsaId && parentDsaId > 0) {
        try {
          const [masterRows] = await db.promise().query(
            "SELECT product_id, payout_percentage FROM dsa_product_payout_rates WHERE dsa_id = ? AND bank_id = ?",
            [parentDsaId, Number(bank_id)]
          );
          const masterRatesMap = {};
          for (const mr of masterRows) {
            masterRatesMap[mr.product_id] = parseFloat(mr.payout_percentage) || 0;
          }

          const productIds = Object.keys(rates);
          for (const prodId of productIds) {
            const subRate = parseFloat(rates[prodId]) || 0;
            if (subRate > 0) {
              const masterRate = masterRatesMap[prodId] !== undefined ? masterRatesMap[prodId] : 0;
              if (masterRate <= 0) {
                return res.status(400).json({
                  status: false,
                  message: `Cannot configure rate: Master DSA has no configured rate for product #${prodId} on this bank. Please configure Master DSA's rate first.`,
                });
              }
              if (subRate >= masterRate) {
                return res.status(400).json({
                  status: false,
                  message: `Invalid rate: Sub-DSA rate (${subRate}%) must be strictly lesser than Master DSA rate (${masterRate}%). It cannot be equal or higher.`,
                });
              }
            }
          }
        } catch (valErr) {
          console.error("Sub-DSA rate comparison error:", valErr);
        }
      }

      // Fallback format if no dsa_code exists
      if (!dsaCode) {
        dsaCode = `DSA-${String(dsa_id).padStart(5, "0")}`;
      }

      // 2. Fetch Bank details for audit log
      let bankName = `Bank #${bank_id}`;
      try {
        const [bRows] = await db.promise().query(
          "SELECT id, bank_name FROM banks WHERE id = ? LIMIT 1",
          [Number(bank_id)]
        );
        if (bRows.length > 0) {
          bankName = bRows[0].bank_name || `Bank #${bank_id}`;
        }
      } catch (bErr) {
        console.warn("Audit lookup bank warning:", bErr.message);
      }

      // 3. Fetch Master Products for friendly name mapping
      const productNameMap = {};
      try {
        const [pRows] = await db.promise().query("SELECT id, product_name FROM products");
        for (const p of pRows) {
          productNameMap[p.id] = p.product_name;
        }
      } catch (pErr) {
        console.warn("Audit lookup products warning:", pErr.message);
      }

      // 4. Fetch existing rates to track previous values
      const prevRatesMap = {};
      try {
        const [prevRows] = await db.promise().query(
          "SELECT product_id, payout_percentage FROM dsa_product_payout_rates WHERE dsa_id = ? AND bank_id = ?",
          [Number(dsa_id), Number(bank_id)]
        );
        for (const pr of prevRows) {
          prevRatesMap[pr.product_id] = parseFloat(pr.payout_percentage) || 0;
        }
      } catch (prErr) {
        console.warn("Audit lookup prev rates warning:", prErr.message);
      }

      // 5. Update / Insert custom rates
      const productIds = Object.keys(rates);
      const changesList = [];
      const prevList = [];
      const newList = [];

      for (const prodId of productIds) {
        const numRate = parseFloat(rates[prodId]) || 0;
        await db.promise().query(
          `INSERT INTO dsa_product_payout_rates (dsa_id, bank_id, product_id, payout_percentage)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE payout_percentage = VALUES(payout_percentage)`,
          [Number(dsa_id), Number(bank_id), Number(prodId), numRate]
        );

        const prodName = productNameMap[prodId] || `Product #${prodId}`;
        const prevVal = prevRatesMap[prodId] !== undefined ? `${prevRatesMap[prodId]}%` : "Not Configured";
        const newVal = `${numRate}%`;

        changesList.push(`${prodName}: ${numRate}%`);
        prevList.push(`${prodName}: ${prevVal}`);
        newList.push(`${prodName}: ${newVal}`);
      }

      // 6. Non-blocking Audit Log using original DSA Code
      logAuditAction({
        req,
        actionType: "DSA_PAYOUT_RATE_UPDATED",
        module: "Commission & Payments",
        entityId: dsaCode,
        entityName: `${dsaCode} • ${bankName}`,
        summary: `Configured payout rates for DSA partner '${dsaCode}' on ${bankName} (${changesList.length} products).`,
        details: `Rates: ${changesList.join(", ")}`,
        previousValue: prevList.join("; "),
        newValue: newList.join("; "),
      });

      return res.status(200).json({ status: true, message: "DSA payout rates saved successfully." });
    } catch (error) {
      console.error("SAVE DSA PAYOUT RATES ERROR:", error);
      return res.status(500).json({ status: false, message: "Failed to save DSA payout rates.", error: error.message });
    }
  }
);

// =========================================================================
// 9. GET SPECIFIC DSA PAYOUT RATE (For Customer Application & Verification)
// GET /api/dsa/payout-rate?bank_id=...&product_id=...&dsa_id=...
// =========================================================================
router.get(
  "/dsa/payout-rate",
  authenticateAndAuthorize(),
  async (req, res) => {
    try {
      const { bank_id, product_id } = req.query;
      const dsaId = req.query.dsa_id ? Number(req.query.dsa_id) : (req.user?.id || req.user?.dsa_id);

      if (!dsaId || !bank_id || !product_id) {
        return res.status(400).json({
          status: false,
          message: "dsa_id, bank_id, and product_id are required.",
          payout_percentage: 0,
          is_configured: false,
        });
      }

      try {
        const [rows] = await db.promise().query(
          "SELECT payout_percentage FROM dsa_product_payout_rates WHERE dsa_id = ? AND bank_id = ? AND product_id = ? LIMIT 1",
          [Number(dsaId), Number(bank_id), Number(product_id)]
        );

        if (rows.length > 0) {
          const rate = parseFloat(rows[0].payout_percentage) || 0;
          return res.status(200).json({
            status: true,
            payout_percentage: rate,
            is_configured: rate > 0,
          });
        }

        return res.status(200).json({
          status: true,
          payout_percentage: 0,
          is_configured: false,
        });
      } catch (dbErr) {
        if (dbErr.code === "ER_NO_SUCH_TABLE") {
          return res.status(200).json({ status: true, payout_percentage: 0, is_configured: false });
        }
        throw dbErr;
      }
    } catch (error) {
      console.error("GET DSA PAYOUT RATE ERROR:", error);
      return res.status(500).json({ status: false, message: "Failed to check DSA payout rate.", error: error.message });
    }
  }
);

module.exports = router;
