const express = require("express");

const router = express.Router();

const db = require("../db");

// ======================================================
// MIDDLEWARE
// ======================================================

const authenticateAndAuthorize = require("../middleware/authMiddleware");

// ======================================================
// NOTIFICATION HELPER
// ======================================================

const { notifyAllAdmins } = require("../utils/notificationHelper");

// ======================================================
// VALIDATION
// ======================================================

const {
  validateLoanPayment,
  getPaymentPercentage,
  calculatePaymentAmount,
} = require("../validations/loanPaymentValidation");

// ======================================================
// DATABASE QUERY HELPER
// ======================================================

const query = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
};

// ======================================================
// POST - CREATE PHASE 6 PAYMENT
// ======================================================
//
// POST
// /api/loan-payment/add
//
// Body:
//
// {
//   "case_id": 1,
//   "payment_option": "SPOT_48_HOURS"
// }
//
// OR
//
// {
//   "case_id": 1,
//   "payment_option": "AFTER_5_DAYS"
// }
//
// ======================================================

router.post(
  "/add",

  // ====================================================
  // AUTHENTICATION
  // ====================================================

  authenticateAndAuthorize(),

  async (req, res) => {
    try {
      // ==================================================
      // STEP 1 - GET DSA ID
      // ==================================================

      const dsaId = req.user?.id;

      if (!dsaId) {
        return res.status(401).json({
          status: false,
          message: "DSA authentication information not found",
        });
      }

      // ==================================================
      // STEP 2 - VALIDATE REQUEST BODY
      // ==================================================

      const validationResult = validateLoanPayment({
        case_id: req.body.case_id,
        payment_option: req.body.payment_option,
      });

      if (!validationResult.success) {
        return res.status(400).json({
          status: false,
          message: "Validation failed",

          errors: validationResult.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        });
      }

      // ==================================================
      // STEP 3 - GET CLEAN DATA
      // ==================================================

      const {
        case_id: validatedCaseId,
        payment_option: validatedPaymentOption,
      } = validationResult.data;

      // ==================================================
      // STEP 4 - CHECK DSA
      // ==================================================

      const dsaResult = await query(
        `
        SELECT
          id,
          dsa_code,
          name,
          email,
          status
        FROM dsa_users
        WHERE id = ?
        LIMIT 1
        `,
        [dsaId],
      );

      if (dsaResult.length === 0) {
        return res.status(404).json({
          status: false,
          message: "DSA user not found",
        });
      }

      // ==================================================
      // STEP 5 - CHECK DSA ACTIVE
      // ==================================================

      if (String(dsaResult[0].status).toLowerCase() !== "active") {
        return res.status(403).json({
          status: false,
          message: "DSA account is inactive",
        });
      }

      // ==================================================
      // STEP 6 - CHECK LOAN CASE OWNERSHIP
      // ==================================================

      const caseResult = await query(
        `
        SELECT
          id,
          case_number,
          dsa_id,
          customer_name,
          sanction_amount,
          payout_percentage,
          status
        FROM loan_cases
        WHERE id = ?
          AND dsa_id = ?
        LIMIT 1
        `,
        [validatedCaseId, dsaId],
      );

      if (caseResult.length === 0) {
        return res.status(404).json({
          status: false,
          message: "Loan case not found for this DSA",
        });
      }

      const loanCase = caseResult[0];

      // ==================================================
      // STEP 7 - CHECK PHASE 4 EXISTS
      // ==================================================

      const phase4Result = await query(
        `
        SELECT
          id,
          case_id,
          disbursement_type,
          disbursement_amount,
          disbursement_date
        FROM loan_case_disbursements
        WHERE case_id = ?
        LIMIT 1
        `,
        [validatedCaseId],
      );

      if (phase4Result.length === 0) {
        return res.status(400).json({
          status: false,
          message: "Phase 4 disbursement details are required before Phase 6",
        });
      }

      // ==================================================
      // STEP 8 - CHECK EXISTING PHASE 6
      // ==================================================

      const existingPayment = await query(
        `
        SELECT
          id,
          case_id,
          payment_option,
          payment_percentage,
          loan_amount,
          payment_amount
        FROM loan_case_payments
        WHERE case_id = ?
        LIMIT 1
        `,
        [validatedCaseId],
      );

      if (existingPayment.length > 0) {
        return res.status(409).json({
          status: false,
          message: "Phase 6 payment details already exist for this case",
          data: existingPayment[0],
        });
      }

      // ==================================================
      // STEP 9 - GET FIXED PERCENTAGE
      // ==================================================

      const paymentPercentage = getPaymentPercentage(validatedPaymentOption);

      if (paymentPercentage === null) {
        return res.status(400).json({
          status: false,
          message: "Invalid payment option",
        });
      }

      // ==================================================
      // STEP 10 - GET DISBURSED LOAN AMOUNT
      // ==================================================

      const isPartDisbursement =
        String(phase4Result[0]?.disbursement_type || "").toUpperCase() === "PART";
      const disbursedAmount =
        isPartDisbursement && Number(phase4Result[0]?.disbursement_amount) > 0
          ? Number(phase4Result[0].disbursement_amount)
          : Number(loanCase.sanction_amount);

      if (!Number.isFinite(disbursedAmount) || disbursedAmount <= 0) {
        return res.status(400).json({
          status: false,
          message: "Invalid loan amount for this case",
        });
      }

      // ==================================================
      // STEP 11 - CALCULATE PAYMENT & CORPORATE INFLOW
      // ==================================================

      const paymentAmount = calculatePaymentAmount(
        disbursedAmount,
        paymentPercentage,
      );

      // Auto-populate Corporate Inflow Rate & Revenue from the selected partner slab
      const corporateRate =
        loanCase.payout_percentage !== null && loanCase.payout_percentage !== undefined
          ? Number(loanCase.payout_percentage)
          : null;

      const corporateAmount =
        corporateRate !== null
          ? Math.round(((disbursedAmount * corporateRate) / 100) * 100) / 100
          : null;

      const adminProfit =
        corporateAmount !== null
          ? Math.round((corporateAmount - paymentAmount) * 100) / 100
          : null;

      // ==================================================
      // STEP 12 - INSERT PHASE 6
      // ==================================================

      const insertResult = await query(
        `
        INSERT INTO loan_case_payments (
          case_id,
          payment_option,
          payment_percentage,
          loan_amount,
          payment_amount,
          corporate_rate,
          corporate_amount,
          admin_profit,
          corporate_received_amount,
          corporate_payment_status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0.00, 'PENDING')
        `,
        [
          validatedCaseId,
          validatedPaymentOption,
          paymentPercentage,
          disbursedAmount,
          paymentAmount,
          corporateRate,
          corporateAmount,
          adminProfit,
        ],
      );

      // ==================================================
      // STEP 13 - GET CREATED PAYMENT
      // ==================================================

      const paymentResult = await query(
        `
        SELECT
          lcp.id,
          lcp.case_id,
          lcp.payment_option,
          lcp.payment_percentage,
          lcp.loan_amount,
          lcp.payment_amount,
          lcp.created_at,
          lcp.updated_at,

          lc.case_number,
          lc.customer_name,
          lc.sanction_amount,

          dsa.id AS dsa_id,
          dsa.dsa_code,
          dsa.name AS dsa_name,
          dsa.email AS dsa_email

        FROM loan_case_payments lcp

        INNER JOIN loan_cases lc
          ON lcp.case_id = lc.id

        INNER JOIN dsa_users dsa
          ON lc.dsa_id = dsa.id

        WHERE lcp.id = ?
          AND lc.dsa_id = ?

        LIMIT 1
        `,
        [insertResult.insertId, dsaId],
      );

      // ==================================================
      // STEP 13.5 - MARK LOAN CASE AS SUBMITTED
      //
      // Phase 6 (Payment) is the FINAL step of the whole
      // multi-phase flow (Case -> SM/ASM -> Phase 4 ->
      // Phase 6). All earlier phases are just "next" steps
      // saved from the frontend. Once Phase 6 is added,
      // the case is considered fully submitted by the DSA.
      // ==================================================

      await query(
        `
        UPDATE loan_cases
        SET status = 'SUBMITTED'
        WHERE id = ?
        `,
        [validatedCaseId],
      );

      // ==================================================
      // STEP 13.6 - NOTIFY ADMIN (CORPORATE DSA)
      //
      // This is the ONLY notification point for the entire
      // case flow. Admin gets notified here once, after the
      // DSA has completed every phase and finally submitted
      // the case via Phase 6 payment.
      //
      // notifyAllAdmins() already swallows its own errors
      // internally, so this can never break the actual
      // payment save above.
      // ==================================================

      await notifyAllAdmins({
        notificationType: "DSA_CASE_SUBMITTED",
        title: "Loan Case Submitted",
        message: `${dsaResult[0].name} has submitted loan case ${loanCase.case_number} for customer ${loanCase.customer_name}. All phases completed.`,
        entityType: "LOAN_CASE",
        entityId: validatedCaseId,
      });
      // ==================================================
      // SOCKET.IO EVENT
      // ==================================================

      const io = req.app.get("io");

      // Admin Dashboard Refresh
      io.to("admin").emit("dashboardUpdated", {
        type: "paymentAdded",
        caseId: validatedCaseId,
        paymentId: insertResult.insertId,
      });

      // Particular DSA Dashboard Refresh
      io.to(`dsa_${dsaId}`).emit("dashboardUpdated", {
        type: "paymentAdded",
        caseId: validatedCaseId,
        paymentId: insertResult.insertId,
      });

      // Admin Notification Bell Refresh
      io.to("admin").emit("newNotification", {
        type: "DSA_CASE_SUBMITTED",
        caseId: validatedCaseId,
      });

      // ==================================================
      // STEP 14 - SUCCESS
      // ==================================================

      return res.status(201).json({
        status: true,

        message: "Phase 6 payment details created successfully",

        data: paymentResult.length > 0 ? paymentResult[0] : null,
      });
    } catch (error) {
      // ==================================================
      // ERROR
      // ==================================================

      console.error("CREATE PHASE 6 PAYMENT ERROR:", error);

      // Duplicate entry safety
      if (error.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          status: false,
          message: "Phase 6 payment details already exist for this case",
        });
      }

      return res.status(500).json({
        status: false,
        message: "Failed to create Phase 6 payment details",
        error: error.message,
      });
    }
  },
);

// ======================================================
// GET - ALL PHASE 6 PAYMENTS FOR LOGGED-IN DSA
// ======================================================
//
// GET
// /api/loan-payment/all
//
// DSA can see ONLY own cases.
//
// ======================================================

router.get(
  "/all",

  authenticateAndAuthorize(),

  async (req, res) => {
    try {
      // ==================================================
      // STEP 1 - GET DSA ID
      // ==================================================

      const dsaId = req.user?.id;

      if (!dsaId) {
        return res.status(401).json({
          status: false,
          message: "DSA authentication information not found",
        });
      }

      // ==================================================
      // STEP 2 - CHECK DSA
      // ==================================================

      const dsaResult = await query(
        `
        SELECT
          id,
          dsa_code,
          name,
          email,
          status
        FROM dsa_users
        WHERE id = ?
        LIMIT 1
        `,
        [dsaId],
      );

      if (dsaResult.length === 0) {
        return res.status(404).json({
          status: false,
          message: "DSA user not found",
        });
      }

      // ==================================================
      // STEP 3 - CHECK ACTIVE
      // ==================================================

      if (String(dsaResult[0].status).toLowerCase() !== "active") {
        return res.status(403).json({
          status: false,
          message: "DSA account is inactive",
        });
      }

      // ==================================================
      // STEP 4 - GET OWN PAYMENT DETAILS
      // ==================================================

      const paymentRows = await query(
        `
        SELECT

          /* ============================================
             PAYMENT DETAILS
             ============================================ */

          lcp.id,
          lcp.case_id,
          lcp.payment_option,
          lcp.payment_percentage,
          lcp.loan_amount,
          lcp.payment_amount,
          lcp.created_at,
          lcp.updated_at,

          /* ============================================
             LOAN CASE DETAILS
             ============================================ */

          lc.case_number,
          lc.customer_name,
          lc.sanction_amount,
          lc.status AS case_status,

          /* ============================================
             DSA DETAILS
             ============================================ */

          dsa.id AS dsa_id,
          dsa.dsa_code,
          dsa.name AS dsa_name,
          dsa.email AS dsa_email

        FROM loan_case_payments lcp

        INNER JOIN loan_cases lc
          ON lcp.case_id = lc.id
          AND lc.dsa_id = ?

        INNER JOIN dsa_users dsa
          ON lc.dsa_id = dsa.id

        ORDER BY lcp.id DESC
        `,
        [dsaId],
      );

      // ==================================================
      // STEP 5 - FORMAT DATA
      // ==================================================

      const payments = paymentRows.map((row) => {
        return {
          dsa: {
            id: row.dsa_id,
            dsa_code: row.dsa_code,
            name: row.dsa_name,
            email: row.dsa_email,
          },

          loan_case: {
            case_id: row.case_id,
            case_number: row.case_number,
            customer_name: row.customer_name,
            sanction_amount: row.sanction_amount,
            status: row.case_status,
          },

          payment: {
            id: row.id,
            payment_option: row.payment_option,
            payment_percentage: row.payment_percentage,
            loan_amount: row.loan_amount,
            payment_amount: row.payment_amount,
            created_at: row.created_at,
            updated_at: row.updated_at,
          },
        };
      });

      // ==================================================
      // STEP 6 - SUCCESS
      // ==================================================

      return res.status(200).json({
        status: true,

        message: "DSA Phase 6 payment details fetched successfully",

        total_payments: payments.length,

        data: payments,
      });
    } catch (error) {
      // ==================================================
      // ERROR
      // ==================================================

      console.error("GET DSA PHASE 6 PAYMENTS ERROR:", error);

      return res.status(500).json({
        status: false,
        message: "Failed to get DSA Phase 6 payment details",
        error: error.message,
      });
    }
  },
);

// ======================================================
// GET - ALL PHASE 6 PAYMENTS FOR ADMIN
// ======================================================
//
// GET
// /api/loan-payment/admin/all
//
// Admin can see ALL DSA payment details.
//
// ======================================================

router.get(
  "/admin/all",

  authenticateAndAuthorize(),

  async (req, res) => {
    try {
      // ==================================================
      // STEP 1 - CHECK AUTHENTICATION
      // ==================================================

      const user = req.user;

      if (!user) {
        return res.status(401).json({
          status: false,
          message: "Authentication information not found",
        });
      }

      // ==================================================
      // STEP 2 - CHECK ADMIN ROLE
      // ==================================================

      const userRole = String(
        user.role || user.user_role || user.user_type || "",
      ).toLowerCase();

      if (userRole !== "admin") {
        return res.status(403).json({
          status: false,
          message: "Only admin can access all DSA payment details",
        });
      }

      // ==================================================
      // STEP 3 - GET ALL PAYMENTS
      // ==================================================

      const paymentRows = await query(
        `
        SELECT

          /* ============================================
             PAYMENT DETAILS
             ============================================ */

          lcp.id,
          lcp.case_id,
          lcp.payment_option,
          lcp.payment_percentage,
          lcp.loan_amount,
          lcp.payment_amount,
          lcp.corporate_rate,
          lcp.corporate_amount,
          lcp.corporate_received_amount,
          lcp.admin_profit,
          lcp.corporate_payment_status,
          lcp.corporate_received_at,
          lcp.created_at,
          lcp.updated_at,

          /* ============================================
             LOAN CASE DETAILS
             ============================================ */

          lc.case_number,
          lc.customer_name,
          lc.sanction_amount,
          lc.payout_percentage AS slab_percentage,
          lc.status AS case_status,
          lc.dsa_id,
          lc.company_id,

          /* ============================================
             COMPANY DETAILS
             ============================================ */

          c.company_name,

          /* ============================================
             DSA DETAILS
             ============================================ */

          dsa.dsa_code,
          dsa.name AS dsa_name,
          dsa.email AS dsa_email,
          dsa.status AS dsa_status

        FROM loan_case_payments lcp

        INNER JOIN loan_cases lc
          ON lcp.case_id = lc.id

        LEFT JOIN companies c
          ON lc.company_id = c.id

        INNER JOIN dsa_users dsa
          ON lc.dsa_id = dsa.id

        ORDER BY lcp.id DESC
        `,
      );

      // ==================================================
      // STEP 4 - FORMAT DATA
      // ==================================================

      const payments = paymentRows.map((row) => {
        return {
          dsa: {
            id: row.dsa_id,
            dsa_code: row.dsa_code,
            name: row.dsa_name,
            email: row.dsa_email,
            status: row.dsa_status,
          },

          company: {
            id: row.company_id,
            company_name: row.company_name,
          },

          loan_case: {
            case_id: row.case_id,
            case_number: row.case_number,
            customer_name: row.customer_name,
            sanction_amount: row.sanction_amount,
            status: row.case_status,
          },

          payment: {
            id: row.id,
            payment_option: row.payment_option,
            payment_percentage: row.payment_percentage,
            loan_amount: row.loan_amount,
            payment_amount: row.payment_amount,
            corporate_rate: row.corporate_rate,
            corporate_amount: row.corporate_amount,
            corporate_received_amount: row.corporate_received_amount,
            admin_profit: row.admin_profit,
            corporate_payment_status: row.corporate_payment_status,
            corporate_received_at: row.corporate_received_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
          },
        };
      });

      // ==================================================
      // STEP 5 - SUCCESS
      // ==================================================

      return res.status(200).json({
        status: true,

        message: "All DSA Phase 6 payment details fetched successfully",

        total_payments: payments.length,

        data: payments,
      });
    } catch (error) {
      // ==================================================
      // ERROR
      // ==================================================

      console.error("ADMIN GET ALL PHASE 6 PAYMENTS ERROR:", error);

      return res.status(500).json({
        status: false,
        message: "Failed to get all DSA Phase 6 payment details",
        error: error.message,
      });
    }
  },
);

// ======================================================
// PUT - UPDATE CORPORATE RATE & SETTLEMENT STATUS (ADMIN)
// ======================================================
//
// PUT /api/loan-payment/admin/corporate-rate/:case_id
//
// Body:
// {
//   "corporate_rate": 1.25,
//   "corporate_payment_status": "PENDING" | "RECEIVED",
//   "corporate_received_at": "2026-09-28" (optional)
// }
// ======================================================

router.put(
  "/admin/corporate-rate/:case_id",
  authenticateAndAuthorize(),
  async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({
          status: false,
          message: "Authentication information not found",
        });
      }

      const userRole = String(
        user.role || user.user_role || user.user_type || "",
      ).toLowerCase();

      if (userRole !== "admin") {
        return res.status(403).json({
          status: false,
          message: "Only admin can set or update corporate rates",
        });
      }

      const { case_id } = req.params;
      const { corporate_rate, corporate_payment_status, corporate_received_at } = req.body;

      if (!case_id || !/^\d+$/.test(case_id)) {
        return res.status(400).json({
          status: false,
          message: "Valid case_id is required",
        });
      }

      const rateNum = Number(corporate_rate);
      if (corporate_rate !== undefined && corporate_rate !== null && corporate_rate !== "" && (isNaN(rateNum) || rateNum < 0 || rateNum > 100)) {
        return res.status(400).json({
          status: false,
          message: "Corporate rate must be a valid percentage between 0 and 100",
        });
      }

      // Check loan case
      const caseRows = await query(
        `SELECT id, case_number, customer_name, sanction_amount, company_id FROM loan_cases WHERE id = ? LIMIT 1`,
        [case_id]
      );

      if (caseRows.length === 0) {
        return res.status(404).json({
          status: false,
          message: "Loan case not found",
        });
      }

      const loanCase = caseRows[0];

      // Check if payment row exists
      const paymentRows = await query(
        `SELECT * FROM loan_case_payments WHERE case_id = ? LIMIT 1`,
        [case_id]
      );

      let loanAmount = paymentRows.length > 0
        ? Number(paymentRows[0].loan_amount)
        : Number(loanCase.sanction_amount || 0);

      let dsaPaymentAmount = paymentRows.length > 0
        ? Number(paymentRows[0].payment_amount || 0)
        : 0;

      let corpAmount = null;
      let profit = null;

      if (corporate_rate !== undefined && corporate_rate !== null && corporate_rate !== "") {
        corpAmount = Math.round(((loanAmount * rateNum) / 100) * 100) / 100;
        profit = Math.round((corpAmount - dsaPaymentAmount) * 100) / 100;
      }

      const statusVal = corporate_payment_status === "RECEIVED" ? "RECEIVED" : "PENDING";
      const receivedAtVal = statusVal === "RECEIVED"
        ? (corporate_received_at || new Date().toISOString().slice(0, 10))
        : null;

      if (paymentRows.length > 0) {
        // UPDATE existing payment
        await query(
          `UPDATE loan_case_payments
           SET corporate_rate = ?,
               corporate_amount = ?,
               admin_profit = ?,
               corporate_payment_status = ?,
               corporate_received_at = ?,
               updated_at = NOW()
           WHERE case_id = ?`,
          [
            corporate_rate !== undefined && corporate_rate !== "" ? rateNum : paymentRows[0].corporate_rate,
            corpAmount !== null ? corpAmount : paymentRows[0].corporate_amount,
            profit !== null ? profit : paymentRows[0].admin_profit,
            statusVal,
            receivedAtVal,
            case_id,
          ]
        );
      } else {
        // Create initial payment record if it doesn't exist yet
        await query(
          `INSERT INTO loan_case_payments (
             case_id,
             payment_option,
             payment_percentage,
             loan_amount,
             payment_amount,
             corporate_rate,
             corporate_amount,
             admin_profit,
             corporate_payment_status,
             corporate_received_at
           ) VALUES (?, 'SPOT_48_HOURS', 0.85, ?, ?, ?, ?, ?, ?, ?)`,
          [
            case_id,
            loanAmount,
            dsaPaymentAmount,
            rateNum,
            corpAmount,
            profit,
            statusVal,
            receivedAtVal,
          ]
        );
      }

      // Fetch fresh payment data
      const updatedPaymentRows = await query(
        `SELECT lcp.*, c.company_name, lc.case_number, lc.customer_name
         FROM loan_case_payments lcp
         INNER JOIN loan_cases lc ON lcp.case_id = lc.id
         LEFT JOIN companies c ON lc.company_id = c.id
         WHERE lcp.case_id = ? LIMIT 1`,
        [case_id]
      );

      // Socket.io refresh
      const io = req.app.get("io");
      if (io) {
        io.to("admin").emit("dashboardUpdated", {
          type: "corporateRateUpdated",
          caseId: Number(case_id),
        });
      }

      return res.status(200).json({
        status: true,
        message: "Corporate rate and settlement status updated successfully",
        data: updatedPaymentRows[0] || null,
      });
    } catch (error) {
      console.error("UPDATE CORPORATE RATE ERROR:", error);
      return res.status(500).json({
        status: false,
        message: "Failed to update corporate rate",
        error: error.message,
      });
    }
  }
);

// ======================================================
// EXPORT
// ======================================================

// =========================================================================
// 8. RECORD CORPORATE INFLOW TRANCHE & UPDATE RECOVERY
// POST /api/loan-payment/record-corporate-inflow
// =========================================================================
router.post(
  "/record-corporate-inflow",
  authenticateAndAuthorize("admin"),
  async (req, res) => {
    try {
      const {
        case_id,
        received_amount,
        corporate_received_at,
        corporate_rate,
        mode = "add", // "add" to add tranche, "set_total" to set total received
      } = req.body;

      if (!case_id) {
        return res.status(400).json({ status: false, message: "case_id is required" });
      }

      let paymentRows = await query(
        "SELECT * FROM loan_case_payments WHERE case_id = ? LIMIT 1",
        [case_id]
      );

      // If payment record does not exist yet, find loan case and auto-create
      if (paymentRows.length === 0) {
        const caseRows = await query(
          "SELECT * FROM loan_cases WHERE id = ? LIMIT 1",
          [case_id]
        );
        if (caseRows.length === 0) {
          return res.status(404).json({ status: false, message: "Loan case not found" });
        }
        const lc = caseRows[0];
        const disbRows = await query(
          "SELECT disbursement_amount FROM loan_case_disbursements WHERE case_id = ? LIMIT 1",
          [case_id]
        );
        const disbAmt = disbRows.length > 0 && Number(disbRows[0].disbursement_amount) > 0
          ? Number(disbRows[0].disbursement_amount)
          : Number(lc.sanction_amount || 0);

        const dsaRate = 0.90;
        const dsaPayout = Math.round(((disbAmt * dsaRate) / 100) * 100) / 100;
        const rate = corporate_rate !== undefined && corporate_rate !== null
          ? Number(corporate_rate)
          : (lc.payout_percentage ? Number(lc.payout_percentage) : null);
        const corpAmt = rate !== null ? Math.round(((disbAmt * rate) / 100) * 100) / 100 : null;
        const netRev = corpAmt !== null ? Math.round((corpAmt - dsaPayout) * 100) / 100 : null;

        await query(
          `INSERT INTO loan_case_payments (
            case_id, payment_option, payment_percentage, loan_amount, payment_amount,
            corporate_rate, corporate_amount, admin_profit, corporate_received_amount, corporate_payment_status
          ) VALUES (?, 'STANDARD 5 DAYS', ?, ?, ?, ?, ?, ?, 0.00, 'PENDING')`,
          [case_id, dsaRate, disbAmt, dsaPayout, rate, corpAmt, netRev]
        );

        paymentRows = await query(
          "SELECT * FROM loan_case_payments WHERE case_id = ? LIMIT 1",
          [case_id]
        );
      }

      const p = paymentRows[0];
      const incomingAmount = parseFloat(received_amount);
      if (isNaN(incomingAmount) || incomingAmount < 0) {
        return res.status(400).json({ status: false, message: "Valid received amount is required" });
      }

      // Check if corporate rate was updated
      let effectiveRate = p.corporate_rate !== null ? Number(p.corporate_rate) : null;
      if (corporate_rate !== undefined && corporate_rate !== null && !isNaN(Number(corporate_rate))) {
        effectiveRate = Number(corporate_rate);
      } else if (effectiveRate === null) {
        // Fallback to loan case payout_percentage
        const lcRows = await query("SELECT payout_percentage FROM loan_cases WHERE id = ? LIMIT 1", [case_id]);
        if (lcRows.length > 0 && lcRows[0].payout_percentage !== null) {
          effectiveRate = Number(lcRows[0].payout_percentage);
        }
      }

      let expectedTotal = p.corporate_amount !== null ? Number(p.corporate_amount) : 0;
      let adminProfit = p.admin_profit !== null ? Number(p.admin_profit) : 0;
      const loanAmount = Number(p.loan_amount || 0);
      const dsaPayout = Number(p.payment_amount || 0);

      if (effectiveRate !== null && loanAmount > 0 && (expectedTotal <= 0 || corporate_rate !== undefined)) {
        expectedTotal = Math.round(((loanAmount * effectiveRate) / 100) * 100) / 100;
        adminProfit = Math.round((expectedTotal - dsaPayout) * 100) / 100;
      }

      const currentReceived = parseFloat(p.corporate_received_amount || 0);
      const newTotalReceived = mode === "set_total"
        ? Math.round(incomingAmount * 100) / 100
        : Math.round((currentReceived + incomingAmount) * 100) / 100;

      let newStatus = "PENDING";
      if (newTotalReceived >= expectedTotal && expectedTotal > 0) {
        newStatus = "RECEIVED";
      } else if (newTotalReceived > 0) {
        newStatus = "PARTIAL";
      }

      const receivedDate = corporate_received_at || new Date().toISOString().slice(0, 10);

      await query(
        `UPDATE loan_case_payments
         SET corporate_rate = ?,
             corporate_amount = ?,
             admin_profit = ?,
             corporate_received_amount = ?,
             corporate_payment_status = ?,
             corporate_received_at = ?,
             updated_at = NOW()
         WHERE case_id = ?`,
        [effectiveRate, expectedTotal, adminProfit, newTotalReceived, newStatus, receivedDate, case_id]
      );

      const recoveryBalance = Math.max(0, Math.round((expectedTotal - newTotalReceived) * 100) / 100);

      return res.status(200).json({
        status: true,
        message: "Corporate inflow recorded successfully.",
        data: {
          corporate_rate: effectiveRate,
          corporate_amount: expectedTotal,
          corporate_received_amount: newTotalReceived,
          recovery_balance: recoveryBalance,
          corporate_payment_status: newStatus,
          corporate_received_at: receivedDate,
          admin_profit: adminProfit,
        },
      });
    } catch (err) {
      console.error("RECORD CORPORATE INFLOW ERROR:", err);
      return res.status(500).json({ status: false, message: err.message });
    }
  }
);

module.exports = router;
