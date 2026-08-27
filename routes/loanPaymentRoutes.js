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
      // STEP 10 - GET LOAN AMOUNT
      // ==================================================

      const loanAmount = Number(loanCase.sanction_amount);

      if (!Number.isFinite(loanAmount) || loanAmount <= 0) {
        return res.status(400).json({
          status: false,
          message: "Invalid sanction amount for this loan case",
        });
      }

      // ==================================================
      // STEP 11 - CALCULATE PAYMENT
      // ==================================================

      const paymentAmount = calculatePaymentAmount(
        loanAmount,
        paymentPercentage,
      );

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
          payment_amount
        )
        VALUES (?, ?, ?, ?, ?)
        `,
        [
          validatedCaseId,
          validatedPaymentOption,
          paymentPercentage,
          loanAmount,
          paymentAmount,
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
          lcp.created_at,
          lcp.updated_at,

          /* ============================================
             LOAN CASE DETAILS
             ============================================ */

          lc.case_number,
          lc.customer_name,
          lc.sanction_amount,
          lc.status AS case_status,
          lc.dsa_id,

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
// EXPORT
// ======================================================

module.exports = router;
