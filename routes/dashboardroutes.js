const express = require("express");
const router = express.Router();

const db = require("../db");
const authenticateAndAuthorize = require("../middleware/authMiddleware");

const requireAuth = authenticateAndAuthorize();

// ======================================================
// ADMIN / CORPORATE DSA DASHBOARD
// GET /api/dashboard/admin
// ======================================================

router.get("/admin", requireAuth, async (req, res) => {
  try {
    const role = req.user.role;

    if (role !== "admin" && role !== "Corporate DSA") {
      return res.status(403).json({
        status: false,
        message: "Access denied.",
      });
    }

    const [
      companyCount,
      bankCount,
      locationCount,
      dsaCount,
      notificationCount,
      pendingCount,
      verifiedCount,
      rejectedCount,
      loanSummary,

      companies,
      banks,
      locations,

      pendingSignup,
      verifiedSignup,
      rejectedSignup,

      dsaUsers,
      notifications,
      loanCases,
      payments,
      disbursements,
      smAsmDetails,
    ] = await Promise.all([

      // ==================================================
      // SUMMARY COUNTS
      // ==================================================

      db.promise().query("SELECT COUNT(*) AS total FROM companies"),

      db.promise().query("SELECT COUNT(*) AS total FROM banks"),

      db.promise().query("SELECT COUNT(*) AS total FROM locations"),

      db.promise().query("SELECT COUNT(*) AS total FROM dsa_users"),

      db.promise().query("SELECT COUNT(*) AS total FROM notifications"),

      db.promise().query(`
        SELECT COUNT(*) AS total
        FROM dsa_signup_requests
        WHERE status='PENDING'
      `),

      db.promise().query(`
        SELECT COUNT(*) AS total
        FROM dsa_signup_requests
        WHERE status='VERIFIED'
      `),

      db.promise().query(`
        SELECT COUNT(*) AS total
        FROM dsa_signup_requests
        WHERE status='REJECTED'
      `),

      db.promise().query(`
        SELECT
          COUNT(*) AS loanCases,
          SUM(status='ACCEPTED') AS accepted,
          SUM(status='REJECTED') AS rejected,
          SUM(status='SUBMITTED') AS submitted,
          SUM(status='DRAFT') AS draft
        FROM loan_cases
      `),

      // ==================================================
      // COMPANIES
      // ==================================================

      db.promise().query(`
        SELECT
          c.*,
          COUNT(DISTINCT l.id) AS total_locations,
          COUNT(DISTINCT d.id) AS total_dsas
        FROM companies c
        LEFT JOIN locations l
          ON c.id=l.company_id
        LEFT JOIN dsa_users d
          ON c.id=d.company_id
        GROUP BY c.id
        ORDER BY c.id DESC
      `),

      // ==================================================
      // BANKS
      // ==================================================

      db.promise().query(`
        SELECT
          b.*,
          COUNT(lc.id) AS total_cases
        FROM banks b
        LEFT JOIN loan_cases lc
          ON b.id=lc.bank_id
        GROUP BY b.id
        ORDER BY b.id DESC
      `),

      // ==================================================
      // LOCATIONS
      // ==================================================

      db.promise().query(`
        SELECT
          l.*,
          c.company_name
        FROM locations l
        LEFT JOIN companies c
          ON l.company_id=c.id
        ORDER BY l.id DESC
      `),

      // ==================================================
      // SIGNUP REQUESTS
      // ==================================================

      db.promise().query(`
        SELECT *
        FROM dsa_signup_requests
        WHERE status='PENDING'
        ORDER BY created_at DESC
      `),

      db.promise().query(`
        SELECT *
        FROM dsa_signup_requests
        WHERE status='VERIFIED'
        ORDER BY reviewed_at DESC
      `),

      db.promise().query(`
        SELECT *
        FROM dsa_signup_requests
        WHERE status='REJECTED'
        ORDER BY reviewed_at DESC
      `),

      // ==================================================
      // VERIFIED DSA USERS
      // ==================================================

      db.promise().query(`
        SELECT
          d.*,
          c.company_name,
          l.location_name
        FROM dsa_users d
        LEFT JOIN companies c
          ON d.company_id=c.id
        LEFT JOIN locations l
          ON d.location_id=l.id
        ORDER BY d.id DESC
      `),

      // ==================================================
      // NOTIFICATIONS
      // ==================================================

      db.promise().query(`
        SELECT
          n.*,
          d.name AS recipient_name
        FROM notifications n
        LEFT JOIN dsa_users d
          ON n.recipient_user_id=d.id
        ORDER BY n.created_at DESC
      `),

      // ==================================================
      // LOAN CASES
      // ==================================================

      db.promise().query(`
        SELECT

          lc.id,
          lc.case_number,
          lc.dsa_id,
          d.name AS dsa_name,

          lc.bank_id,
          b.bank_name,

          lc.customer_name,
          lc.mobile_number,

          lc.application_number,
          lc.loan_account_number,

          lc.sanction_amount,

          lc.status,
          lc.reviewed_by,
          lc.reviewed_at,

          lc.reject_reason,
          lc.remarks,

          lc.created_at,
          lc.updated_at,

          ld.disbursement_type,
          ld.disbursement_amount,
          ld.disbursement_date,
          ld.rate,
          ld.pf,
          ld.tenure,
          ld.insurance_amount,
          ld.cheque_handover_date,
          ld.pdd_cleared,

          sm.name AS sm_name,
          sm.mobile_number AS sm_mobile,
          sm.email AS sm_email,

          asm.name AS asm_name,
          asm.mobile_number AS asm_mobile,
          asm.email AS asm_email,

          COALESCE(pay.total_paid,0) AS total_paid,

          (lc.sanction_amount-COALESCE(pay.total_paid,0))
          AS remaining_amount

        FROM loan_cases lc

        LEFT JOIN dsa_users d
          ON lc.dsa_id=d.id

        LEFT JOIN banks b
          ON lc.bank_id=b.id

        LEFT JOIN loan_case_disbursements ld
          ON lc.id=ld.case_id

        LEFT JOIN loan_case_sm_asm_details sm
          ON lc.id=sm.case_id
          AND sm.role='SM'

        LEFT JOIN loan_case_sm_asm_details asm
          ON lc.id=asm.case_id
          AND asm.role='ASM'

        LEFT JOIN
        (
          SELECT
            case_id,
            SUM(payment_amount) AS total_paid
          FROM loan_case_payments
          GROUP BY case_id
        ) pay
          ON lc.id=pay.case_id

        ORDER BY lc.created_at DESC
      `),

      // ==================================================
      // PAYMENTS
      // ==================================================

      db.promise().query(`
        SELECT

          p.*,

          lc.case_number,
          lc.customer_name,
          lc.dsa_id,

          d.name AS dsa_name

        FROM loan_case_payments p

        LEFT JOIN loan_cases lc
          ON p.case_id=lc.id

        LEFT JOIN dsa_users d
          ON lc.dsa_id=d.id

        ORDER BY p.created_at DESC
      `),

      // ==================================================
      // DISBURSEMENTS
      // ==================================================

      db.promise().query(`
        SELECT

          ld.*,

          lc.case_number,
          lc.customer_name,
          lc.dsa_id,

          d.name AS dsa_name

        FROM loan_case_disbursements ld

        LEFT JOIN loan_cases lc
          ON ld.case_id=lc.id

        LEFT JOIN dsa_users d
          ON lc.dsa_id=d.id

        ORDER BY ld.created_at DESC
      `),

      // ==================================================
      // SM / ASM DETAILS
      // ==================================================

      db.promise().query(`
        SELECT

          s.*,

          lc.case_number,
          lc.customer_name

        FROM loan_case_sm_asm_details s

        LEFT JOIN loan_cases lc
          ON s.case_id=lc.id

        ORDER BY s.case_id DESC
      `),
    ]);

    // ==================================================
    // FINAL RESPONSE
    // ==================================================

    return res.status(200).json({
      status: true,

      data: {
        summary: {
          companies: companyCount[0][0].total,
          banks: bankCount[0][0].total,
          locations: locationCount[0][0].total,
          dsaUsers: dsaCount[0][0].total,
          notifications: notificationCount[0][0].total,

          signupRequests: {
            pending: pendingCount[0][0].total,
            verified: verifiedCount[0][0].total,
            rejected: rejectedCount[0][0].total,
          },

          loanCases: loanSummary[0][0].loanCases || 0,
          accepted: loanSummary[0][0].accepted || 0,
          rejected: loanSummary[0][0].rejected || 0,
          submitted: loanSummary[0][0].submitted || 0,
          draft: loanSummary[0][0].draft || 0,
        },

        companies: companies[0],
        banks: banks[0],
        locations: locations[0],

        signupRequests: {
          pending: pendingSignup[0],
          verified: verifiedSignup[0],
          rejected: rejectedSignup[0],
        },

        dsaUsers: dsaUsers[0],
        notifications: notifications[0],
        loanCases: loanCases[0],
        payments: payments[0],
        disbursements: disbursements[0],
        smAsmDetails: smAsmDetails[0],
      },
    });
  } catch (error) {
    console.error("ADMIN DASHBOARD ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to load dashboard.",
      error: error.message,
    });
  }
});



// ======================================================
// DSA DASHBOARD
// GET /api/dashboard/dsa
// ======================================================

router.get("/dsa", requireAuth, async (req, res) => {
  try {
    const role = req.user.role;

    if (role !== "DSA") {
      return res.status(403).json({
        status: false,
        message: "Access denied. Only DSA can access this dashboard.",
      });
    }

    const dsaId = req.user.id;

    const [
      dsaProfile,
      loanSummary,
      loanCases,
      payments,
      disbursements,
      notifications,
      smAsmDetails,
    ] = await Promise.all([

      // ==================================================
      // DSA PROFILE
      // ==================================================

      db.promise().query(
        `
        SELECT
          d.id,
          d.dsa_code,
          d.name,
          d.email,
          d.mobile,
          d.role,
          d.status,
          d.company_id,
          d.company_name,
          d.location_id,
          d.location,
          d.created_at,
          d.updated_at
        FROM dsa_users d
        WHERE d.id=?
        LIMIT 1
        `,
        [dsaId]
      ),

      // ==================================================
      // LOAN SUMMARY
      // ==================================================

      db.promise().query(
        `
        SELECT
          COUNT(*) AS loanCases,
          SUM(status='ACCEPTED') AS accepted,
          SUM(status='REJECTED') AS rejected,
          SUM(status='SUBMITTED') AS submitted,
          SUM(status='DRAFT') AS draft,
          COALESCE(SUM(sanction_amount),0) AS totalSanctionAmount
        FROM loan_cases
        WHERE dsa_id=?
        `,
        [dsaId]
      ),

      // ==================================================
      // ALL LOAN CASES
      // ==================================================

      db.promise().query(
        `
        SELECT

          lc.id,
          lc.case_number,
          lc.customer_name,
          lc.mobile_number,
          lc.application_number,
          lc.loan_account_number,
          lc.sanction_amount,
          lc.status,
          lc.reviewed_by,
          lc.reviewed_at,
          lc.reject_reason,
          lc.remarks,
          lc.created_at,
          lc.updated_at,

          b.bank_name,

          ld.disbursement_type,
          ld.disbursement_amount,
          ld.disbursement_date,
          ld.rate,
          ld.pf,
          ld.tenure,
          ld.insurance_amount,
          ld.cheque_handover_date,
          ld.pdd_cleared,

          sm.name AS sm_name,
          sm.mobile_number AS sm_mobile,
          sm.email AS sm_email,

          asm.name AS asm_name,
          asm.mobile_number AS asm_mobile,
          asm.email AS asm_email,

          COALESCE(pay.total_paid,0) AS total_paid,

          (lc.sanction_amount-COALESCE(pay.total_paid,0))
          AS remaining_amount

        FROM loan_cases lc

        LEFT JOIN banks b
        ON lc.bank_id=b.id

        LEFT JOIN loan_case_disbursements ld
        ON lc.id=ld.case_id

        LEFT JOIN loan_case_sm_asm_details sm
        ON lc.id=sm.case_id
        AND sm.role='SM'

        LEFT JOIN loan_case_sm_asm_details asm
        ON lc.id=asm.case_id
        AND asm.role='ASM'

        LEFT JOIN
        (
          SELECT
            case_id,
            SUM(payment_amount) AS total_paid
          FROM loan_case_payments
          GROUP BY case_id
        ) pay
        ON lc.id=pay.case_id

        WHERE lc.dsa_id=?

        ORDER BY lc.created_at DESC
        `,
        [dsaId]
      ),

      // ==================================================
      // ALL PAYMENTS
      // ==================================================

      db.promise().query(
        `
        SELECT

          p.*,

          lc.case_number,
          lc.customer_name

        FROM loan_case_payments p

        INNER JOIN loan_cases lc
        ON p.case_id=lc.id

        WHERE lc.dsa_id=?

        ORDER BY p.created_at DESC
        `,
        [dsaId]
      ),

      // ==================================================
      // ALL DISBURSEMENTS
      // ==================================================

      db.promise().query(
        `
        SELECT

          ld.*,

          lc.case_number,
          lc.customer_name

        FROM loan_case_disbursements ld

        INNER JOIN loan_cases lc
        ON ld.case_id=lc.id

        WHERE lc.dsa_id=?

        ORDER BY ld.created_at DESC
        `,
        [dsaId]
      ),

      // ==================================================
      // NOTIFICATIONS
      // ==================================================

      db.promise().query(
        `
        SELECT *

        FROM notifications

        WHERE recipient_user_id=?

        ORDER BY created_at DESC
        `,
        [dsaId]
      ),

      // ==================================================
      // SM / ASM DETAILS
      // ==================================================

      db.promise().query(
        `
        SELECT

          s.*,

          lc.case_number,
          lc.customer_name

        FROM loan_case_sm_asm_details s

        INNER JOIN loan_cases lc
        ON s.case_id=lc.id

        WHERE lc.dsa_id=?

        ORDER BY s.case_id DESC
        `,
        [dsaId]
      ),
    ]);

    // ==================================================
    // FINAL RESPONSE
    // ==================================================

    return res.status(200).json({
      status: true,

      data: {
        profile: dsaProfile[0][0] || null,

        summary: {
          loanCases: loanSummary[0][0].loanCases || 0,
          accepted: loanSummary[0][0].accepted || 0,
          rejected: loanSummary[0][0].rejected || 0,
          submitted: loanSummary[0][0].submitted || 0,
          draft: loanSummary[0][0].draft || 0,
          totalSanctionAmount:
            loanSummary[0][0].totalSanctionAmount || 0,
        },

        loanCases: loanCases[0],
        payments: payments[0],
        disbursements: disbursements[0],
        notifications: notifications[0],
        smAsmDetails: smAsmDetails[0],
      },
    });

  } catch (error) {
    console.error("DSA DASHBOARD ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to load dashboard.",
      error: error.message,
    });
  }
});



module.exports = router;
