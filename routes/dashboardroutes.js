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
          d.dsa_code,
          lc.sub_dsa_id,
          sub_dsa.name AS sub_dsa_name,
          sub_dsa.dsa_code AS sub_dsa_code,

          lc.company_id,
          c.company_name,

          lc.bank_id,
          b.bank_name,

          lc.customer_name,
          lc.mobile_number,

          lc.application_number,
          lc.loan_account_number,

          lc.sanction_amount,
          lc.is_car_loan,
          lc.product_id,
          prod.product_name,
          lc.payout_option_id,
          bpo.option_label,
          lc.payout_percentage,
          lc.calculated_commission,

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
          AS remaining_amount,

          cld.banker_name,
          cld.banker_mobile,
          cld.car_photos,
          cld.invoice_copy_url,
          cld.insurance_copy_url,
          cld.payment_advice_url

        FROM loan_cases lc

        LEFT JOIN dsa_users d
          ON lc.dsa_id=d.id

        LEFT JOIN dsa_users sub_dsa
          ON lc.sub_dsa_id=sub_dsa.id

        LEFT JOIN companies c
          ON lc.company_id=c.id

        LEFT JOIN banks b
          ON lc.bank_id=b.id

        LEFT JOIN products prod
          ON lc.product_id=prod.id

        LEFT JOIN bank_product_payout_options bpo
          ON lc.payout_option_id=bpo.id

        LEFT JOIN loan_case_disbursements ld
          ON lc.id=ld.case_id

        LEFT JOIN car_loan_details cld
          ON lc.id=cld.case_id

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
          lc.company_id,
          c.company_name,

          d.name AS dsa_name

        FROM loan_case_payments p

        LEFT JOIN loan_cases lc
          ON p.case_id=lc.id

        LEFT JOIN companies c
          ON lc.company_id=c.id

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
    // COMMISSION & FINANCIAL AGGREGATIONS (ADMIN SIDE)
    // ==================================================

    const paymentsMap = {};
    (payments[0] || []).forEach((p) => {
      if (p && p.case_id) paymentsMap[p.case_id] = p;
    });

    let totalSanctioned = 0;
    let totalDisbursed = 0;
    let earnedCommission = 0;
    let pendingCommission = 0;
    const dsaStats = {};
    const bankStats = {};
    const productStats = {};

    const enrichedLoanCases = (loanCases[0] || []).map((lc) => {
      const p = paymentsMap[lc.id];
      const sanctionAmt = Number(lc.sanction_amount || 0);
      const disbAmt = Number(lc.disbursement_amount || 0);

      totalSanctioned += sanctionAmt;
      totalDisbursed += disbAmt;

      const baseAmount = disbAmt > 0 ? disbAmt : sanctionAmt;
      const paymentOption = String(p?.payment_option || lc.payment_option || "");
      const paymentPct =
        p?.payment_percentage !== undefined && p?.payment_percentage !== null
          ? Number(p.payment_percentage)
          : (paymentOption.includes("48") || paymentOption.includes("SPOT") ? 0.85 : 0.90);

      let comm = 0;
      if (p?.payment_amount && Number(p.payment_amount) > 0) {
        comm = Number(p.payment_amount);
      } else if (baseAmount > 0) {
        comm = Math.round((baseAmount * paymentPct) / 100);
      }

      const status = String(lc.status || "").toUpperCase().trim();
      const isAccepted = ["ACCEPTED", "APPROVED", "VERIFIED"].includes(status);
      const isPending = ["SUBMITTED", "PENDING", "UNDER_REVIEW", "UNDER REVIEW"].includes(status);

      if (isAccepted) {
        earnedCommission += comm;
      } else if (isPending) {
        pendingCommission += comm;
      }

      // Group by Bank Partner for Bank Distribution Breakdown
      const bankName = (lc.bank_name || "Direct / Unassigned").trim();
      if (!bankStats[bankName]) {
        bankStats[bankName] = {
          name: bankName,
          count: 0,
          volume: 0,
          disbursed_volume: 0,
          sanctioned_volume: 0,
        };
      }
      bankStats[bankName].count += 1;
      bankStats[bankName].volume += baseAmount;
      bankStats[bankName].disbursed_volume += disbAmt;
      bankStats[bankName].sanctioned_volume += sanctionAmt;

      // Group by Loan Product for Product Mix Breakdown
      const productName = (lc.product_name || "Uncategorized").trim();
      if (!productStats[productName]) {
        productStats[productName] = {
          name: productName,
          count: 0,
          volume: 0,
        };
      }
      productStats[productName].count += 1;
      productStats[productName].volume += baseAmount;

      // Group by DSA for Top 5 DSA Performance (only registered DSA partners)
      const cleanDsaName = (lc.dsa_name || "").trim();
      if (cleanDsaName && cleanDsaName.toLowerCase() !== "direct / unassigned" && lc.dsa_id) {
        if (!dsaStats[cleanDsaName]) {
          dsaStats[cleanDsaName] = {
            name: cleanDsaName,
            dsa_id: lc.dsa_id,
            count: 0,
            volume: 0,
            commission: 0,
            accepted_count: 0,
          };
        }
        dsaStats[cleanDsaName].count += 1;
        dsaStats[cleanDsaName].volume += sanctionAmt;
        if (isAccepted) {
          dsaStats[cleanDsaName].commission += comm;
          dsaStats[cleanDsaName].accepted_count += 1;
        }
      }

      // Corporate Inflow & Admin Net Profit Spread Calculation
      const effectiveRate =
        p?.corporate_rate !== null && p?.corporate_rate !== undefined && p?.corporate_rate !== ""
          ? Number(p.corporate_rate)
          : lc.payout_percentage !== null && lc.payout_percentage !== undefined && lc.payout_percentage !== ""
          ? Number(lc.payout_percentage)
          : lc.slab_percentage !== null && lc.slab_percentage !== undefined && lc.slab_percentage !== ""
          ? Number(lc.slab_percentage)
          : null;

      const corporateRate = effectiveRate !== null && !isNaN(effectiveRate) ? effectiveRate : null;

      let corporateInflowAmount = 0;
      if (p?.corporate_amount !== null && p?.corporate_amount !== undefined && Number(p.corporate_amount) > 0) {
        corporateInflowAmount = Number(p.corporate_amount);
      } else if (corporateRate !== null && baseAmount > 0) {
        corporateInflowAmount = Math.round(((baseAmount * corporateRate) / 100) * 100) / 100;
      }

      let netProfitSpread = 0;
      if (corporateRate !== null) {
        netProfitSpread = Math.max(0, Math.round((corporateInflowAmount - comm) * 100) / 100);
      }

      return {
        ...lc,
        payment_amount: p?.payment_amount || comm,
        payment_option: p?.payment_option || (paymentPct === 0.85 ? "Spot 48h (0.85%)" : "After 5 Days (0.90%)"),
        payment_percentage: paymentPct,
        commission_rate: paymentPct,
        commission_amount: comm,
        corporate_rate: corporateRate,
        corporateInflowAmount,
        netProfitSpread,
      };
    });

    const topDsaPerformance = Object.values(dsaStats)
      .sort((a, b) => b.count - a.count || b.volume - a.volume)
      .slice(0, 5)
      .map((d) => ({
        ...d,
        approval_rate: d.count > 0 ? Math.round((d.accepted_count / d.count) * 100) : 0,
      }));

    const totalBankVol = Object.values(bankStats).reduce((acc, b) => acc + b.volume, 0) || 1;
    const bankDistribution = Object.values(bankStats)
      .sort((a, b) => b.volume - a.volume || b.count - a.count)
      .map((b) => ({
        ...b,
        share_pct: Math.round((b.volume / totalBankVol) * 100),
      }));

    const totalProdVol = Object.values(productStats).reduce((acc, p) => acc + p.volume, 0) || 1;
    const productDistribution = Object.values(productStats)
      .sort((a, b) => b.volume - a.volume || b.count - a.count)
      .map((p) => ({
        ...p,
        share_pct: Math.round((p.volume / totalProdVol) * 100),
      }));

    // ==================================================
    // CORPORATE INFLOW & PLATFORM SPREAD AGGREGATIONS
    // ==================================================

    let totalBankInflow = 0;
    let totalCorporateReceived = 0;
    let totalRecoveryPending = 0;
    let totalDsaOutflow = 0;
    let paidDsaOutflow = 0;
    let pendingDsaOutflow = 0;
    let totalAdminProfit = 0;

    (loanCases[0] || []).forEach((lc) => {
      const p = paymentsMap[lc.id];
      const sanctionAmt = Number(lc.sanction_amount || 0);
      const disbAmt = Number(lc.disbursement_amount || 0);
      const baseAmount = disbAmt > 0 ? disbAmt : sanctionAmt;

      const paymentOption = String(p?.payment_option || lc.payment_option || "");
      const dsaCommissionRate =
        p?.payment_percentage !== undefined && p?.payment_percentage !== null
          ? Number(p.payment_percentage)
          : (paymentOption.includes("48") || paymentOption.includes("SPOT") ? 0.85 : 0.90);

      let dsaCommissionAmount = 0;
      if (p?.payment_amount && Number(p.payment_amount) > 0) {
        dsaCommissionAmount = Number(p.payment_amount);
      } else if (baseAmount > 0) {
        dsaCommissionAmount = Math.round((baseAmount * dsaCommissionRate) / 100);
      }

      const effectiveRate =
        p?.corporate_rate !== null && p?.corporate_rate !== undefined && p?.corporate_rate !== ""
          ? Number(p.corporate_rate)
          : lc.payout_percentage !== null && lc.payout_percentage !== undefined && lc.payout_percentage !== ""
          ? Number(lc.payout_percentage)
          : lc.slab_percentage !== null && lc.slab_percentage !== undefined && lc.slab_percentage !== ""
          ? Number(lc.slab_percentage)
          : null;

      const corporateRate = effectiveRate !== null && !isNaN(effectiveRate) ? effectiveRate : null;

      let corporateInflowAmount = 0;
      if (p?.corporate_amount !== null && p?.corporate_amount !== undefined && Number(p.corporate_amount) > 0) {
        corporateInflowAmount = Number(p.corporate_amount);
      } else if (corporateRate !== null && baseAmount > 0) {
        corporateInflowAmount = Math.round(((baseAmount * corporateRate) / 100) * 100) / 100;
      }

      let netProfitSpread = 0;
      if (corporateRate !== null) {
        netProfitSpread = Math.max(0, Math.round((corporateInflowAmount - dsaCommissionAmount) * 100) / 100);
      }

      const corporateReceivedAmount = Number(p?.corporate_received_amount || 0);
      const recoveryBalance = Math.max(0, Math.round((corporateInflowAmount - corporateReceivedAmount) * 100) / 100);

      const status = String(lc.status || "").toUpperCase().trim();
      const isAccepted = ["ACCEPTED", "APPROVED", "VERIFIED"].includes(status);

      totalBankInflow += corporateInflowAmount;
      totalCorporateReceived += corporateReceivedAmount;
      totalRecoveryPending += recoveryBalance;
      totalDsaOutflow += dsaCommissionAmount;
      totalAdminProfit += netProfitSpread;

      if (isAccepted) {
        paidDsaOutflow += dsaCommissionAmount;
      } else {
        pendingDsaOutflow += dsaCommissionAmount;
      }
    });

    const averageMargin = totalDisbursed > 0 && totalAdminProfit > 0 ? (totalAdminProfit / totalDisbursed) * 100 : 0;

    const financialMetrics = {
      corporateInflow: {
        total: totalBankInflow,
        received: totalCorporateReceived,
        pending: totalRecoveryPending,
      },
      dsaPayouts: {
        total: totalDsaOutflow,
        paid: paidDsaOutflow,
        pending: pendingDsaOutflow,
      },
      netPlatformSpread: {
        totalProfit: totalAdminProfit,
        averageMargin: Math.round(averageMargin * 100) / 100,
      },
      portfolioDisbursed: {
        totalDisbursed: totalDisbursed,
        totalSanctioned: totalSanctioned,
        totalCases: (loanCases[0] || []).length,
      },
    };

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

          // Commission & Financial Aggregations
          totalSanctionedAmount: totalSanctioned,
          totalDisbursedAmount: totalDisbursed,
          totalCommission: earnedCommission,
          earnedCommission: earnedCommission,
          pendingCommission: pendingCommission,
          topDsaPerformance: topDsaPerformance,
          financialMetrics: financialMetrics,
          bankDistribution: bankDistribution,
          productDistribution: productDistribution,
        },

        financialMetrics: financialMetrics,
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
        loanCases: enrichedLoanCases,
        topDsaPerformance: topDsaPerformance,
        bankDistribution: bankDistribution,
        productDistribution: productDistribution,
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

    // 1. Fetch DSA Profile first to determine if user is a Referral Agent (Sub-DSA)
    const [profileRows] = await db.promise().query(
      `
      SELECT
        d.id,
        d.dsa_code,
        d.referral_code,
        d.referred_by_dsa_id,
        d.firm_name,
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
    );

    const userProfile = profileRows[0] || {};
    const isSubDsa = userProfile.referred_by_dsa_id !== null && userProfile.referred_by_dsa_id !== undefined;
    userProfile.is_sub_dsa = isSubDsa;

    const [
      loanSummary,
      loanCases,
      payments,
      disbursements,
      notifications,
      smAsmDetails,
    ] = await Promise.all([

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
        WHERE ${isSubDsa ? "sub_dsa_id=?" : "dsa_id=?"}
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

        WHERE ${isSubDsa ? "lc.sub_dsa_id=?" : "lc.dsa_id=?"}

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

        WHERE ${isSubDsa ? "lc.sub_dsa_id=?" : "lc.dsa_id=?"}

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

        WHERE ${isSubDsa ? "lc.sub_dsa_id=?" : "lc.dsa_id=?"}

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

        WHERE ${isSubDsa ? "lc.sub_dsa_id=?" : "lc.dsa_id=?"}

        ORDER BY s.case_id DESC
        `,
        [dsaId]
      ),
    ]);

    // ==================================================
    // COMMISSION & FINANCIAL AGGREGATIONS (DSA SIDE)
    // ==================================================

    const paymentsMap = {};
    (payments[0] || []).forEach((p) => {
      if (p && p.case_id) paymentsMap[p.case_id] = p;
    });

    let totalSanctioned = 0;
    let totalDisbursed = 0;
    let earnedCommission = 0;
    let pendingCommission = 0;

    const enrichedLoanCases = (loanCases[0] || []).map((lc) => {
      const p = paymentsMap[lc.id];
      const sanctionAmt = Number(lc.sanction_amount || 0);
      const disbAmt = Number(lc.disbursement_amount || 0);

      totalSanctioned += sanctionAmt;
      totalDisbursed += disbAmt;

      const baseAmount = disbAmt > 0 ? disbAmt : sanctionAmt;
      const paymentOption = String(p?.payment_option || lc.payment_option || "");

      // Check if this case was introduced by a Sub-DSA
      const hasSubDsa = !isSubDsa && Boolean(lc.sub_dsa_id || p?.sub_dsa_id);

      // Base platform slab rate and gross amount
      const basePlatformPct =
        p?.payment_percentage !== undefined && p?.payment_percentage !== null
          ? Number(p.payment_percentage)
          : (paymentOption.includes("48") || paymentOption.includes("SPOT") ? 0.85 : 0.90);

      const grossAmt =
        p?.payment_amount && Number(p.payment_amount) > 0
          ? Number(p.payment_amount)
          : (baseAmount > 0 ? Math.round((baseAmount * basePlatformPct) / 100) : 0);

      // Sub-DSA rate and amount if present
      const subDsaPct =
        p?.sub_dsa_percentage !== null && p?.sub_dsa_percentage !== undefined
          ? Number(p.sub_dsa_percentage)
          : null;

      const subDsaAmt =
        p?.sub_dsa_amount !== null && p?.sub_dsa_amount !== undefined
          ? Number(p.sub_dsa_amount)
          : (baseAmount > 0 && subDsaPct !== null ? Math.round(((baseAmount * subDsaPct) / 100) * 100) / 100 : null);

      // Master DSA override rate and amount
      const overridePct =
        p?.dsa_override_percentage !== null && p?.dsa_override_percentage !== undefined
          ? Number(p.dsa_override_percentage)
          : (subDsaPct !== null ? Math.round((basePlatformPct - subDsaPct) * 100) / 100 : null);

      const overrideAmt =
        p?.dsa_override_amount !== null && p?.dsa_override_amount !== undefined
          ? Number(p.dsa_override_amount)
          : (subDsaAmt !== null ? Math.round((grossAmt - subDsaAmt) * 100) / 100 : null);

      let comm = 0;
      let effectiveRate = basePlatformPct;

      if (isSubDsa) {
        // Sub-DSA gets their agreed referral share
        effectiveRate = subDsaPct;
        comm = subDsaAmt !== null ? subDsaAmt : (baseAmount > 0 && subDsaPct !== null ? Math.round(((baseAmount * subDsaPct) / 100) * 100) / 100 : 0);
      } else if (hasSubDsa) {
        // Master DSA for Sub-DSA case: earns their net override margin
        effectiveRate = overridePct !== null ? overridePct : basePlatformPct;
        comm = overrideAmt !== null ? overrideAmt : grossAmt;
      } else {
        // Direct DSA case: Master DSA earns full direct commission
        effectiveRate = basePlatformPct;
        comm = grossAmt;
      }

      const status = String(lc.status || "").toUpperCase().trim();
      const isAccepted = ["ACCEPTED", "APPROVED", "VERIFIED"].includes(status);
      const isPending = ["SUBMITTED", "PENDING", "UNDER_REVIEW", "UNDER REVIEW"].includes(status);

      if (isAccepted) {
        earnedCommission += comm;
      } else if (isPending) {
        pendingCommission += comm;
      }

      const defaultPlanLabel = isSubDsa
        ? (paymentOption.includes("48") || paymentOption.includes("SPOT") ? "Spot 48h Settlement" : "Standard 5-Days Settlement")
        : (basePlatformPct === 0.85 ? "Spot 48h (0.85%)" : "After 5 Days (0.90%)");

      const finalPaymentOption = isSubDsa
        ? (paymentOption.includes("48") || paymentOption.includes("SPOT") ? "Spot 48h Settlement" : "Standard 5-Days Settlement")
        : (p?.payment_option || defaultPlanLabel);

      return {
        ...lc,
        has_sub_dsa: hasSubDsa,
        gross_payment_amount: grossAmt,
        gross_payment_percentage: basePlatformPct,
        sub_dsa_id: lc.sub_dsa_id || p?.sub_dsa_id || null,
        sub_dsa_percentage: subDsaPct,
        sub_dsa_amount: subDsaAmt,
        dsa_override_percentage: overridePct,
        dsa_override_amount: overrideAmt,
        payment_amount: comm,
        payment_option: finalPaymentOption,
        payment_percentage: effectiveRate,
        commission_rate: effectiveRate,
        commission_amount: comm,
      };
    });

    // ==================================================
    // AGGREGATIONS: PAYOUT SETTLEMENT & BANK PERFORMANCE
    // ==================================================

    const payoutSettlement = {
      spot48h: {
        rate: isSubDsa ? "Partner Rate" : "0.85%",
        casesCount: 0,
        disbursedAmount: 0,
        commissionEarned: 0,
      },
      standard5Days: {
        rate: isSubDsa ? "Partner Rate" : "0.90%",
        casesCount: 0,
        disbursedAmount: 0,
        commissionEarned: 0,
      },
    };

    const bankMap = {};

    enrichedLoanCases.forEach((lc) => {
      const isSpot =
        String(lc.payment_option || "").includes("48") ||
        String(lc.payment_option || "").toUpperCase().includes("SPOT") ||
        Number(lc.payment_percentage) === 0.85;
      const targetSettlement = isSpot
        ? payoutSettlement.spot48h
        : payoutSettlement.standard5Days;
      targetSettlement.casesCount += 1;
      targetSettlement.disbursedAmount += Number(lc.disbursement_amount || 0);
      targetSettlement.commissionEarned += Number(lc.commission_amount || 0);

      const bankName = lc.bank_name || "Other Partner Banks";
      if (!bankMap[bankName]) {
        bankMap[bankName] = {
          bank_name: bankName,
          totalCases: 0,
          approvedCases: 0,
          totalSanction: 0,
          totalDisbursed: 0,
        };
      }
      bankMap[bankName].totalCases += 1;
      bankMap[bankName].totalSanction += Number(lc.sanction_amount || 0);
      bankMap[bankName].totalDisbursed += Number(lc.disbursement_amount || 0);

      const status = String(lc.status || "").toUpperCase().trim();
      if (["ACCEPTED", "APPROVED", "VERIFIED"].includes(status)) {
        bankMap[bankName].approvedCases += 1;
      }
    });

    const bankPerformance = Object.values(bankMap)
      .map((b) => ({
        ...b,
        approvalRate:
          b.totalCases > 0
            ? Number(((b.approvedCases / b.totalCases) * 100).toFixed(1))
            : 0,
      }))
      .sort((a, b) => b.totalSanction - a.totalSanction);

    // ==================================================
    // FINAL RESPONSE
    // ==================================================

    // For Sub-DSA: sanitize payments array so no master DSA override or admin corporate earnings are leaked
    const sanitizedPayments = isSubDsa
      ? (payments[0] || []).map((p) => {
          const isSpot =
            String(p.payment_option || "").includes("48") ||
            String(p.payment_option || "").toUpperCase().includes("SPOT");
          return {
            id: p.id,
            case_id: p.case_id,
            case_number: p.case_number,
            customer_name: p.customer_name,
            loan_amount: p.loan_amount,
            payment_option: isSpot ? "Spot 48h Settlement" : "Standard 5-Days Settlement",
            payment_percentage:
              p.sub_dsa_percentage !== null && p.sub_dsa_percentage !== undefined
                ? Number(p.sub_dsa_percentage)
                : null,
            payment_amount:
              p.sub_dsa_amount !== null && p.sub_dsa_amount !== undefined
                ? Number(p.sub_dsa_amount)
                : null,
            sub_dsa_id: p.sub_dsa_id,
            sub_dsa_percentage: p.sub_dsa_percentage,
            sub_dsa_amount: p.sub_dsa_amount,
            sub_dsa_payout_status: p.sub_dsa_payout_status,
            created_at: p.created_at,
            updated_at: p.updated_at,
          };
        })
      : payments[0];

    return res.status(200).json({
      status: true,

      data: {
        profile: userProfile || null,

        summary: {
          loanCases: loanSummary[0][0].loanCases || 0,
          accepted: loanSummary[0][0].accepted || 0,
          rejected: loanSummary[0][0].rejected || 0,
          submitted: loanSummary[0][0].submitted || 0,
          draft: loanSummary[0][0].draft || 0,
          totalSanctionAmount:
            loanSummary[0][0].totalSanctionAmount || totalSanctioned || 0,
          totalDisbursedAmount: totalDisbursed,
          earnedCommission: earnedCommission,
          pendingCommission: pendingCommission,
          totalCommission: earnedCommission,
        },

        payoutSettlement,
        bankPerformance,

        loanCases: enrichedLoanCases,
        payments: sanitizedPayments,
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
