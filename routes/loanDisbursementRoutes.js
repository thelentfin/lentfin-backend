const express = require("express");
const router = express.Router();

const db = require("../db");
const multer = require("multer");

// ======================================================
// MIDDLEWARE
// ======================================================

const authenticateAndAuthorize = require("../middleware/authMiddleware");
const { logAuditAction } = require("../utils/auditLogger");

// ======================================================
// CLOUDINARY
// ======================================================

const uploadToCloudinary = require("../utils/cloudinaryUpload");
const deleteFromCloudinary = require("../utils/cloudinaryDelete");

// ======================================================
// VALIDATION
// ======================================================

const {
  validateLoanDisbursement,
  validatePddDocument,
} = require("../validations/loanDisbursementValidation");

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
// MULTER MEMORY STORAGE
// ======================================================

const storage = multer.memoryStorage();

// ======================================================
// PDD UPLOAD CONFIGURATION
// ======================================================

const upload = multer({
  storage,

  limits: {
    fileSize: 5 * 1024 * 1024,
  },

  fileFilter: (req, file, cb) => {
    const allowedTypes = ["application/pdf", "image/jpeg", "image/png"];

    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error("Only PDF, JPG, JPEG and PNG files are allowed"));
    }

    cb(null, true);
  },
});

// ======================================================
// PDD SINGLE FILE
// ======================================================

const pddDocumentUpload = upload.single("pdd_document");

// ======================================================
// POST - CREATE PHASE 4 DISBURSEMENT
// ======================================================
//
// POST /api/loan-disbursement/add
//
// Content-Type:
// multipart/form-data
//
// File field:
// pdd_document
// ======================================================

router.post(
  "/add",

  // ====================================================
  // STEP 1 - AUTHENTICATION
  // ====================================================

  authenticateAndAuthorize(),

  // ====================================================
  // STEP 2 - MULTER
  // ====================================================

  (req, res, next) => {
    pddDocumentUpload(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            status: false,
            message: "PDD document must not exceed 5 MB",
          });
        }

        if (err.code === "LIMIT_UNEXPECTED_FILE") {
          return res.status(400).json({
            status: false,
            message: "Invalid file field. Use pdd_document",
          });
        }

        return res.status(400).json({
          status: false,
          message: err.message,
        });
      }

      if (err) {
        return res.status(400).json({
          status: false,
          message: err.message,
        });
      }

      next();
    });
  },

  // ====================================================
  // STEP 3 - CONTROLLER
  // ====================================================

  async (req, res) => {
    let uploadedCloudinaryFile = null;
    let createdDisbursementId = null;

    try {
      // ==================================================
      // STEP 4 - REQUEST BODY
      // ==================================================

      const {
        case_id,
        disbursement_type,
        disbursement_amount,
        disbursement_date,
        rate,
        pf,
        tenure,
        insurance_amount,
        cheque_handover_date,
        pdd_cleared,
      } = req.body;

      // ==================================================
      // STEP 5 - VALIDATE BODY
      // ==================================================

      const validationResult = validateLoanDisbursement({
        case_id,
        disbursement_type,
        disbursement_amount,
        disbursement_date,
        rate,
        pf,
        tenure,
        insurance_amount,
        cheque_handover_date,
        pdd_cleared,
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
      // STEP 6 - CLEAN VALIDATED DATA
      // ==================================================

      const {
        case_id: validatedCaseId,
        disbursement_type: validatedDisbursementType,
        disbursement_amount: validatedDisbursementAmount,
        disbursement_date: validatedDisbursementDate,
        rate: validatedRate,
        pf: validatedPf,
        tenure: validatedTenure,
        insurance_amount: validatedInsuranceAmount,
        cheque_handover_date: validatedChequeHandoverDate,
        pdd_cleared: validatedPddCleared,
      } = validationResult.data;

      // ==================================================
      // STEP 7 - GET DSA ID FROM JWT
      // ==================================================

      const dsaId = req.user?.id;

      if (!dsaId) {
        return res.status(401).json({
          status: false,
          message: "DSA authentication information not found",
        });
      }

      // ==================================================
      // STEP 8 - CHECK DSA
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

      if (String(dsaResult[0].status).toLowerCase() !== "active") {
        return res.status(403).json({
          status: false,
          message: "DSA account is inactive",
        });
      }

      // ==================================================
      // STEP 9 - CHECK LOAN CASE OWNERSHIP
      // ==================================================

      const caseResult = await query(
        `
          SELECT
            lc.id,
            lc.case_number,
            lc.dsa_id,
            lc.sanction_amount,
            lc.status
          FROM loan_cases lc
          WHERE lc.id = ?
          AND lc.dsa_id = ?
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
      // STEP 10 - CHECK CASE STATUS
      // ==================================================

      if (String(loanCase.status).toUpperCase() === "SUBMITTED") {
        return res.status(400).json({
          status: false,
          message: "Phase 4 cannot be modified after final submission",
        });
      }

      // ==================================================
      // STEP 11 - CHECK EXISTING PHASE 4
      // ==================================================

      const existingDisbursement = await query(
        `
          SELECT
            id
          FROM loan_case_disbursements
          WHERE case_id = ?
          LIMIT 1
        `,
        [validatedCaseId],
      );

      if (existingDisbursement.length > 0) {
        return res.status(409).json({
          status: false,
          message: "Phase 4 disbursement details already exist for this case",
        });
      }

      // ==================================================
      // STEP 12 - SANCTION AMOUNT CHECK
      // ==================================================

      const sanctionAmount = Number(loanCase.sanction_amount);

      const disbursementAmount = Number(validatedDisbursementAmount);

      if (disbursementAmount > sanctionAmount) {
        return res.status(400).json({
          status: false,
          message: "Disbursement amount cannot exceed sanction amount",
        });
      }

      // ==================================================
      // STEP 13 - PART / FULL CHECK
      // ==================================================

      if (
        validatedDisbursementType === "FULL" &&
        disbursementAmount !== sanctionAmount
      ) {
        return res.status(400).json({
          status: false,
          message:
            "For FULL disbursement, disbursement amount must equal sanction amount",
        });
      }

      if (
        validatedDisbursementType === "PART" &&
        disbursementAmount >= sanctionAmount
      ) {
        return res.status(400).json({
          status: false,
          message:
            "For PART disbursement, amount must be less than sanction amount",
        });
      }

      // ==================================================
      // STEP 14 - PDD LOGIC (Upload is optional)
      // ==================================================

      if (req.file) {
        const pddValidation = validatePddDocument(req.file);

        if (!pddValidation.success) {
          return res.status(400).json({
            status: false,
            message: pddValidation.message,
          });
        }
      }

      // ==================================================
      // STEP 16 - INSERT PHASE 4
      // ==================================================

      const insertResult = await query(
        `
          INSERT INTO loan_case_disbursements (
            case_id,
            disbursement_type,
            disbursement_amount,
            disbursement_date,
            rate,
            pf,
            tenure,
            insurance_amount,
            cheque_handover_date,
            pdd_cleared
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          validatedCaseId,
          validatedDisbursementType,
          validatedDisbursementAmount,
          validatedDisbursementDate,
          validatedRate,
          validatedPf,
          validatedTenure,
          validatedInsuranceAmount,
          validatedChequeHandoverDate ? validatedChequeHandoverDate : null,
          validatedPddCleared,
        ],
      );

      createdDisbursementId = insertResult.insertId;

      // ==================================================
      // STEP 17 - PDD CLOUDINARY UPLOAD
      // ==================================================

      let documentResult = null;

      if (validatedPddCleared === "YES" && req.file) {
        const cloudinaryResult = await uploadToCloudinary(
          req.file,
          `lentfin/loan_cases/${loanCase.case_number}/phase4`,
        );

        // ----------------------------------------------
        // SAVE CLOUDINARY DATA FOR CLEANUP
        // ----------------------------------------------

        uploadedCloudinaryFile = {
          public_id: cloudinaryResult.public_id,
          resource_type: cloudinaryResult.resource_type,
        };

        // ----------------------------------------------
        // FILE FORMAT
        // ----------------------------------------------

        const fileFormat =
          cloudinaryResult.format ||
          (req.file.originalname
            ? req.file.originalname.split(".").pop().toLowerCase()
            : null) ||
          "pdf";

        // ----------------------------------------------
        // INSERT DOCUMENT
        // ----------------------------------------------

        const documentInsertResult = await query(
          `
            INSERT INTO loan_case_disbursement_documents (
              disbursement_id,
              document_type,
              original_name,
              cloudinary_public_id,
              cloudinary_url,
              secure_url,
              resource_type,
              file_format,
              file_size
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            createdDisbursementId,
            "PDD",
            req.file.originalname,
            cloudinaryResult.public_id,
            cloudinaryResult.url,
            cloudinaryResult.secure_url,
            cloudinaryResult.resource_type,
            fileFormat,
            req.file.size,
          ],
        );

        // ----------------------------------------------
        // GET DOCUMENT
        // ----------------------------------------------

        const documentRows = await query(
          `
            SELECT
              id,
              disbursement_id,
              document_type,
              original_name,
              cloudinary_public_id,
              cloudinary_url,
              secure_url,
              resource_type,
              file_format,
              file_size,
              created_at
            FROM loan_case_disbursement_documents
            WHERE id = ?
            LIMIT 1
          `,
          [documentInsertResult.insertId],
        );

        documentResult = documentRows.length > 0 ? documentRows[0] : null;
      }

      // ==================================================
      // STEP 18 - GET CREATED DATA
      // ==================================================

      const disbursementResult = await query(
        `
          SELECT
            lcd.id,
            lcd.case_id,
            lc.case_number,
            lc.customer_name,
            lc.sanction_amount,

            lcd.disbursement_type,
            lcd.disbursement_amount,
            lcd.disbursement_date,
            lcd.rate,
            lcd.pf,
            lcd.tenure,
            lcd.insurance_amount,
            lcd.cheque_handover_date,
            lcd.pdd_cleared,

            lcd.created_at,
            lcd.updated_at

          FROM loan_case_disbursements lcd

          INNER JOIN loan_cases lc
            ON lcd.case_id = lc.id

          WHERE lcd.id = ?
          AND lc.dsa_id = ?

          LIMIT 1
        `,
        [createdDisbursementId, dsaId],
      );
      // ==================================================
      // SOCKET.IO EVENT
      // ==================================================

      const io = req.app.get("io");

      // Admin Dashboard Refresh
      io.to("admin").emit("dashboardUpdated", {
        type: "disbursementAdded",
        caseId: validatedCaseId,
        disbursementId: createdDisbursementId,
      });

      // Particular DSA Dashboard Refresh
      io.to(`dsa_${dsaId}`).emit("dashboardUpdated", {
        type: "disbursementAdded",
        caseId: validatedCaseId,
        disbursementId: createdDisbursementId,
      });

      // Non-blocking Audit Log
      logAuditAction({
        req,
        actionType: "CASE_DISBURSED",
        module: "Customer Applications",
        entityId: `CASE-${validatedCaseId}`,
        entityName: `Case #${validatedCaseId}`,
        summary: `Recorded loan disbursement of ₹${validatedDisbursementAmount} for Case #${validatedCaseId}.`,
        details: `Disbursed Date: ${validatedDisbursementDate} • Rate: ${validatedRate}% • Tenure: ${validatedTenure}M • Type: ${validatedDisbursementType}`,
        newValue: `₹${validatedDisbursementAmount}`,
      });

      // ==================================================
      // STEP 19 - SUCCESS
      // ==================================================

      return res.status(201).json({
        status: true,

        message: "Phase 4 disbursement details created successfully",

        data: {
          disbursement:
            disbursementResult.length > 0 ? disbursementResult[0] : null,

          document: documentResult,
        },
      });
    } catch (error) {
      console.error("CREATE PHASE 4 DISBURSEMENT ERROR:", error);

      // ==================================================
      // CLOUDINARY CLEANUP
      // ==================================================

      if (uploadedCloudinaryFile && uploadedCloudinaryFile.public_id) {
        try {
          await deleteFromCloudinary(
            uploadedCloudinaryFile.public_id,
            uploadedCloudinaryFile.resource_type,
          );
        } catch (deleteError) {
          console.error("PDD CLOUDINARY CLEANUP ERROR:", deleteError);
        }
      }

      // ==================================================
      // DATABASE CLEANUP
      // ==================================================

      if (createdDisbursementId) {
        try {
          await query(
            `
              DELETE FROM loan_case_disbursements
              WHERE id = ?
            `,
            [createdDisbursementId],
          );
        } catch (cleanupError) {
          console.error("PHASE 4 DATABASE CLEANUP ERROR:", cleanupError);
        }
      }

      return res.status(500).json({
        status: false,
        message: "Failed to create Phase 4 disbursement details",
        error: error.message,
      });
    }
  },
);
// ======================================================
// GET ALL PHASE 4 / LOAN CASE DETAILS
// ======================================================
//
// GET /api/loan-disbursement/all
//
// Returns:
// - All loan cases of logged-in DSA
// - Loan case details
// - Phase 4 disbursement details
// - PDD document details
// ======================================================

router.get(
  "/all",

  // ====================================================
  // AUTHENTICATION
  // ====================================================

  authenticateAndAuthorize(),

  async (req, res) => {
    try {
      // ==================================================
      // STEP 1 - GET DSA ID FROM JWT
      // ==================================================

      const dsaId = req.user?.id;

      if (!dsaId) {
        return res.status(401).json({
          status: false,
          message: "DSA authentication information not found",
        });
      }

      // ==================================================
      // STEP 2 - CHECK DSA EXISTS + ACTIVE
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

      if (String(dsaResult[0].status).toLowerCase() !== "active") {
        return res.status(403).json({
          status: false,
          message: "DSA account is inactive",
        });
      }

      // ==================================================
      // STEP 3 - GET ONLY PHASE 4 DETAILS + DOCUMENT
      // ==================================================
      //
      // loan_cases is used ONLY for DSA ownership check.
      //
      // No loan case/customer/bank details are returned.
      // ==================================================

      const disbursementRows = await query(
        `
          SELECT

            /* ============================================
               PHASE 4 DISBURSEMENT DETAILS
               ============================================ */

            lcd.id,
            lcd.case_id,
            lcd.disbursement_type,
            lcd.disbursement_amount,
            lcd.disbursement_date,
            lcd.rate,
            lcd.pf,
            lcd.tenure,
            lcd.insurance_amount,
            lcd.cheque_handover_date,
            lcd.pdd_cleared,
            lcd.created_at,
            lcd.updated_at,

            /* ============================================
               PDD DOCUMENT DETAILS
               ============================================ */

            lcdd.id AS document_id,
            lcdd.disbursement_id AS document_disbursement_id,
            lcdd.document_type,
            lcdd.original_name,
            lcdd.cloudinary_public_id,
            lcdd.cloudinary_url,
            lcdd.secure_url,
            lcdd.resource_type,
            lcdd.file_format,
            lcdd.file_size,
            lcdd.created_at AS document_created_at,
            lcdd.updated_at AS document_updated_at

          FROM loan_case_disbursements lcd

          /* ============================================
             OWNERSHIP CHECK (MASTER DSA OR SUB-DSA)
             ============================================ */

          INNER JOIN loan_cases lc
            ON lcd.case_id = lc.id
            AND (lc.dsa_id = ? OR lc.sub_dsa_id = ?)

          /* ============================================
             GET LATEST PDD DOCUMENT
             ============================================ */

          LEFT JOIN loan_case_disbursement_documents lcdd
            ON lcd.id = lcdd.disbursement_id
            AND lcdd.id = (
              SELECT MAX(d2.id)
              FROM loan_case_disbursement_documents d2
              WHERE d2.disbursement_id = lcd.id
            )

          ORDER BY lcd.id DESC
        `,
        [dsaId, dsaId],
      );

      // ==================================================
      // STEP 4 - FORMAT PHASE 4 DATA
      // ==================================================

      const disbursements = disbursementRows.map((row) => {
        return {
          // ============================================
          // PHASE 4
          // ============================================

          disbursement: {
            id: row.id,
            case_id: row.case_id,
            disbursement_type: row.disbursement_type,
            disbursement_amount: row.disbursement_amount,
            disbursement_date: row.disbursement_date,
            rate: row.rate,
            pf: row.pf,
            tenure: row.tenure,
            insurance_amount: row.insurance_amount,
            cheque_handover_date: row.cheque_handover_date,
            pdd_cleared: row.pdd_cleared,
            created_at: row.created_at,
            updated_at: row.updated_at,
          },

          // ============================================
          // PDD DOCUMENT
          // ============================================

          document: row.document_id
            ? {
                id: row.document_id,

                disbursement_id: row.document_disbursement_id,

                document_type: row.document_type,

                original_name: row.original_name,

                cloudinary_public_id: row.cloudinary_public_id,

                cloudinary_url: row.cloudinary_url,

                secure_url: row.secure_url,

                resource_type: row.resource_type,

                file_format: row.file_format,

                file_size: row.file_size,

                created_at: row.document_created_at,

                updated_at: row.document_updated_at,
              }
            : null,
        };
      });

      // ==================================================
      // STEP 5 - SUCCESS RESPONSE
      // ==================================================

      return res.status(200).json({
        status: true,

        message: "All Phase 4 disbursement details fetched successfully",

        total_disbursements: disbursements.length,

        data: disbursements,
      });
    } catch (error) {
      // ==================================================
      // ERROR
      // ==================================================

      console.error("GET ALL PHASE 4 DISBURSEMENTS ERROR:", error);

      return res.status(500).json({
        status: false,
        message: "Failed to get Phase 4 disbursement details",
        error: error.message,
      });
    }
  },
);

// ======================================================
// GET ALL PHASE 4 DISBURSEMENTS - ADMIN
// ======================================================
//
// GET /api/loan-disbursement/admin/all
//
// Admin can view Phase 4 disbursement details
// added by ALL DSAs.
//
// ======================================================

router.get(
  "/admin/all",

  // ====================================================
  // STEP 1 - AUTHENTICATION
  // ====================================================

  authenticateAndAuthorize(),

  async (req, res) => {
    try {
      // ==================================================
      // STEP 2 - CHECK ADMIN ROLE
      // ==================================================

      const user = req.user;

      if (!user) {
        return res.status(401).json({
          status: false,
          message: "Authentication information not found",
        });
      }

      // ==================================================
      // ADMIN ROLE CHECK
      // ==================================================

      const userRole = String(
        user.role || user.user_role || user.user_type || ""
      ).toLowerCase();

      if (userRole !== "admin") {
        return res.status(403).json({
          status: false,
          message: "Only admin can access all DSA disbursement details",
        });
      }

      // ==================================================
      // STEP 3 - GET ALL PHASE 4 DETAILS
      // ==================================================

      const disbursementRows = await query(
        `
        SELECT

          /* ============================================
             PHASE 4 DISBURSEMENT
             ============================================ */

          lcd.id,
          lcd.case_id,

          lcd.disbursement_type,
          lcd.disbursement_amount,
          lcd.disbursement_date,
          lcd.rate,
          lcd.pf,
          lcd.tenure,
          lcd.insurance_amount,
          lcd.cheque_handover_date,
          lcd.pdd_cleared,

          lcd.created_at,
          lcd.updated_at,


          /* ============================================
             LOAN CASE DETAILS
             ============================================ */

          lc.case_number,
          lc.customer_name,
          lc.sanction_amount,
          lc.status AS case_status,
          lc.dsa_id,
          lc.company_id,
          c.company_name,
          lc.product_id,
          prod.product_name,
          lc.payout_option_id,
          bpo.option_label,
          lc.payout_percentage,
          lc.calculated_commission,
          b.bank_name,


          /* ============================================
             PAYMENT / SETTLEMENT & CORPORATE INFLOW
             ============================================ */
          lcp.id AS payment_id,
          lcp.payment_amount,
          lcp.corporate_rate,
          lcp.corporate_amount,
          lcp.corporate_received_amount,
          lcp.admin_profit,
          lcp.corporate_payment_status,
          lcp.corporate_received_at,
          lcp.sub_dsa_id,
          lcp.sub_dsa_percentage,
          lcp.sub_dsa_amount,
          lcp.dsa_override_percentage,
          lcp.dsa_override_amount,
          lcp.sub_dsa_payout_status,


          /* ============================================
             DSA DETAILS
             ============================================ */

          dsa.dsa_code,
          dsa.name AS dsa_name,
          dsa.email AS dsa_email,
          dsa.mobile AS dsa_mobile,
          dsa.status AS dsa_status,
          dsa.account_holder_name AS dsa_account_holder_name,
          dsa.account_number AS dsa_account_number,
          dsa.ifsc_code AS dsa_ifsc_code,
          dsa.bank_name AS dsa_bank_name,
          dsa.pan_number AS dsa_pan_number,

          /* ============================================
             SUB-DSA / REFERRAL PARTNER DETAILS
             ============================================ */
          sub_dsa.id AS referral_sub_dsa_id,
          sub_dsa.dsa_code AS sub_dsa_code,
          sub_dsa.name AS sub_dsa_name,
          sub_dsa.mobile AS sub_dsa_mobile,
          sub_dsa.email AS sub_dsa_email,
          sub_dsa.account_holder_name AS sub_dsa_account_holder_name,
          sub_dsa.account_number AS sub_dsa_account_number,
          sub_dsa.ifsc_code AS sub_dsa_ifsc_code,
          sub_dsa.bank_name AS sub_dsa_bank_name,
          sub_dsa.pan_number AS sub_dsa_pan_number,


          /* ============================================
             PDD DOCUMENT DETAILS
             ============================================ */

          lcdd.id AS document_id,
          lcdd.disbursement_id AS document_disbursement_id,
          lcdd.document_type,
          lcdd.original_name,
          lcdd.cloudinary_public_id,
          lcdd.cloudinary_url,
          lcdd.secure_url,
          lcdd.resource_type,
          lcdd.file_format,
          lcdd.file_size,
          lcdd.created_at AS document_created_at,
          lcdd.updated_at AS document_updated_at


        FROM loan_case_disbursements lcd


        /* ============================================
           LOAN CASE
           ============================================ */

        INNER JOIN loan_cases lc
          ON lcd.case_id = lc.id

        /* ============================================
           BANK NAME
           ============================================ */  

        INNER JOIN banks b
          ON lc.bank_id = b.id

        /* ============================================
           CORPORATE COMPANY
           ============================================ */
        LEFT JOIN companies c
          ON lc.company_id = c.id

        /* ============================================
           PRODUCT & OPTION
           ============================================ */
        LEFT JOIN products prod
          ON lc.product_id = prod.id

        LEFT JOIN bank_product_payout_options bpo
          ON lc.payout_option_id = bpo.id

        /* ============================================
           DSA
           ============================================ */

        INNER JOIN dsa_users dsa
          ON lc.dsa_id = dsa.id

        /* ============================================
           SUB-DSA (REFERRAL PARTNER)
           ============================================ */

        LEFT JOIN dsa_users sub_dsa
          ON lc.sub_dsa_id = sub_dsa.id

        /* ============================================
           PAYMENT / SETTLEMENT
           ============================================ */
        LEFT JOIN loan_case_payments lcp
          ON lc.id = lcp.case_id

        /* ============================================
           LATEST PDD DOCUMENT
           ============================================ */

        LEFT JOIN loan_case_disbursement_documents lcdd
          ON lcd.id = lcdd.disbursement_id

          AND lcdd.id = (
            SELECT MAX(d2.id)
            FROM loan_case_disbursement_documents d2
            WHERE d2.disbursement_id = lcd.id
          )


        /* ============================================
           ORDER
           ============================================ */

        ORDER BY lcd.id DESC
        `
      );

      // ==================================================
      // STEP 4 - FORMAT RESPONSE
      // ==================================================

      const disbursements = disbursementRows.map((row) => {
        return {
          // ============================================
          // DSA DETAILS
          // ============================================

          dsa: {
            id: row.dsa_id,
            dsa_code: row.dsa_code,
            name: row.dsa_name,
            email: row.dsa_email,
            mobile: row.dsa_mobile,
            status: row.dsa_status,
            account_holder_name: row.dsa_account_holder_name || null,
            account_number: row.dsa_account_number || null,
            ifsc_code: row.dsa_ifsc_code || null,
            bank_name: row.dsa_bank_name || null,
            pan_number: row.dsa_pan_number || null,
          },

          // ============================================
          // LOAN CASE DETAILS
          // ============================================

          loan_case: {
            case_id: row.case_id,
            case_number: row.case_number,
            customer_name: row.customer_name,
            sanction_amount: row.sanction_amount,
            status: row.case_status,
            bank: row.bank_name || null,
            company_id: row.company_id || null,
            company_name: row.company_name || null,
            product_id: row.product_id || null,
            product_name: row.product_name || null,
            payout_option_id: row.payout_option_id || null,
            option_label: row.option_label || null,
            payout_percentage: row.payout_percentage !== null ? Number(row.payout_percentage) : null,
            calculated_commission: row.calculated_commission !== null ? Number(row.calculated_commission) : null,
          },
          company_id: row.company_id || null,
          company_name: row.company_name || null,

          // ============================================
          // PHASE 4 DISBURSEMENT
          // ============================================

          disbursement: {
            id: row.id,
            case_id: row.case_id,
            disbursement_type: row.disbursement_type,
            disbursement_amount: row.disbursement_amount,
            disbursement_date: row.disbursement_date,
            rate: row.rate,
            pf: row.pf,
            tenure: row.tenure,
            insurance_amount: row.insurance_amount,
            cheque_handover_date: row.cheque_handover_date,
            pdd_cleared: row.pdd_cleared,
            created_at: row.created_at,
            updated_at: row.updated_at,
          },

          // ============================================
          // SUB-DSA (REFERRAL PARTNER) DETAILS
          // ============================================
          sub_dsa: row.referral_sub_dsa_id
            ? {
                id: row.referral_sub_dsa_id,
                dsa_code: row.sub_dsa_code,
                name: row.sub_dsa_name,
                mobile: row.sub_dsa_mobile,
                email: row.sub_dsa_email,
                account_holder_name: row.sub_dsa_account_holder_name || null,
                account_number: row.sub_dsa_account_number || null,
                ifsc_code: row.sub_dsa_ifsc_code || null,
                bank_name: row.sub_dsa_bank_name || null,
                pan_number: row.sub_dsa_pan_number || null,
              }
            : null,

          // ============================================
          // PAYMENT / SETTLEMENT & CORPORATE INFLOW
          // ============================================
          payment: {
            id: row.payment_id || null,
            payment_amount: row.payment_amount !== null ? Number(row.payment_amount) : null,
            corporate_rate: row.corporate_rate !== null ? Number(row.corporate_rate) : null,
            corporate_amount: row.corporate_amount !== null ? Number(row.corporate_amount) : null,
            corporate_received_amount: row.corporate_received_amount !== null ? Number(row.corporate_received_amount) : 0,
            admin_profit: row.admin_profit !== null ? Number(row.admin_profit) : null,
            corporate_payment_status: row.corporate_payment_status || "PENDING",
            corporate_received_at: row.corporate_received_at || null,
            dsa_payment_status: row.payment_amount ? "PAID" : "PENDING",
            sub_dsa_id: row.sub_dsa_id || null,
            sub_dsa_percentage: row.sub_dsa_percentage !== null ? Number(row.sub_dsa_percentage) : null,
            sub_dsa_amount: row.sub_dsa_amount !== null ? Number(row.sub_dsa_amount) : null,
            dsa_override_percentage: row.dsa_override_percentage !== null ? Number(row.dsa_override_percentage) : null,
            dsa_override_amount: row.dsa_override_amount !== null ? Number(row.dsa_override_amount) : null,
            sub_dsa_payout_status: row.sub_dsa_payout_status || "PENDING",
          },

          // ============================================
          // PDD DOCUMENT
          // ============================================

          document: row.document_id
            ? {
                id: row.document_id,
                disbursement_id: row.document_disbursement_id,
                document_type: row.document_type,
                original_name: row.original_name,
                cloudinary_public_id: row.cloudinary_public_id,
                cloudinary_url: row.cloudinary_url,
                secure_url: row.secure_url,
                resource_type: row.resource_type,
                file_format: row.file_format,
                file_size: row.file_size,
                created_at: row.document_created_at,
                updated_at: row.document_updated_at,
              }
            : null,
        };
      });

      // ==================================================
      // STEP 5 - SUCCESS RESPONSE
      // ==================================================

      return res.status(200).json({
        status: true,
        message:
          "All DSA Phase 4 disbursement details fetched successfully",

        total_disbursements: disbursements.length,

        data: disbursements,
      });
    } catch (error) {
      // ==================================================
      // ERROR
      // ==================================================

      console.error(
        "ADMIN GET ALL PHASE 4 DISBURSEMENTS ERROR:",
        error
      );

      return res.status(500).json({
        status: false,
        message:
          "Failed to get all DSA Phase 4 disbursement details",
        error: error.message,
      });
    }
  }
);

// ======================================================
// TRANCHE DISBURSEMENT: GET TRANCHES FOR CASE
// GET /api/loan-disbursement/:caseId/tranches
// ======================================================

router.get(
  "/:caseId/tranches",
  authenticateAndAuthorize(),
  async (req, res) => {
    try {
      const caseId = parseInt(req.params.caseId, 10);
      if (!caseId) {
        return res.status(400).json({ status: false, message: "Valid case ID is required" });
      }

      // Check case and phase 4 disbursement
      const caseRows = await query(
        `SELECT lc.id, lc.sanction_amount, lc.status,
                lcd.disbursement_amount, lcd.disbursement_type, lcd.disbursement_date
         FROM loan_cases lc
         LEFT JOIN loan_case_disbursements lcd ON lcd.case_id = lc.id
         WHERE lc.id = ?
         LIMIT 1`,
        [caseId]
      );

      if (caseRows.length === 0) {
        return res.status(404).json({ status: false, message: "Loan case not found" });
      }

      const caseInfo = caseRows[0];
      const sanctionAmount = Number(caseInfo.sanction_amount || 0);
      const totalDisbursed = Number(caseInfo.disbursement_amount || 0);
      const pendingBalance = Math.max(0, Math.round((sanctionAmount - totalDisbursed) * 100) / 100);

      // Fetch recorded tranches
      const tranches = await query(
        `SELECT id, case_id, tranche_number, amount, disbursement_date, cheque_reference, remarks, created_at
         FROM loan_case_disbursement_tranches
         WHERE case_id = ?
         ORDER BY tranche_number ASC`,
        [caseId]
      );

      // If no separate tranches recorded yet, but initial phase 4 exists, provide initial tranche
      let displayTranches = tranches;
      if (tranches.length === 0 && totalDisbursed > 0) {
        displayTranches = [
          {
            id: 0,
            case_id: caseId,
            tranche_number: 1,
            amount: totalDisbursed,
            disbursement_date: caseInfo.disbursement_date,
            cheque_reference: null,
            remarks: "Initial Phase 4 Disbursal",
            created_at: caseInfo.disbursement_date,
          },
        ];
      }

      return res.status(200).json({
        status: true,
        data: {
          case_id: caseId,
          sanction_amount: sanctionAmount,
          total_disbursed_amount: totalDisbursed,
          pending_balance: pendingBalance,
          disbursement_type: caseInfo.disbursement_type || "PART",
          is_fully_disbursed: totalDisbursed >= sanctionAmount && sanctionAmount > 0,
          tranches: displayTranches,
        },
      });
    } catch (error) {
      console.error("GET TRANCHES ERROR:", error);
      return res.status(500).json({
        status: false,
        message: "Failed to fetch tranches",
        error: error.message,
      });
    }
  }
);

// ======================================================
// TRANCHE DISBURSEMENT: ADD SUBSEQUENT TRANCHE
// POST /api/loan-disbursement/tranche/add
// ======================================================

router.post(
  "/tranche/add",
  authenticateAndAuthorize(),
  async (req, res) => {
    try {
      const { case_id, tranche_amount, disbursement_date, cheque_reference, remarks } = req.body;

      const caseId = parseInt(case_id, 10);
      const incomingAmount = parseFloat(tranche_amount);

      if (!caseId || isNaN(incomingAmount) || incomingAmount <= 0) {
        return res.status(400).json({
          status: false,
          message: "Valid case_id and positive tranche_amount are required",
        });
      }

      // 1. Fetch case and current disbursement details
      const caseRows = await query(
        `SELECT lc.id, lc.sanction_amount, lc.status AS case_status,
                lcd.id AS disbursement_id, lcd.disbursement_amount, lcd.disbursement_type, lcd.disbursement_date
         FROM loan_cases lc
         LEFT JOIN loan_case_disbursements lcd ON lcd.case_id = lc.id
         WHERE lc.id = ?
         LIMIT 1`,
        [caseId]
      );

      if (caseRows.length === 0) {
        return res.status(404).json({ status: false, message: "Loan case not found" });
      }

      const caseInfo = caseRows[0];
      if (!caseInfo.disbursement_id) {
        return res.status(400).json({
          status: false,
          message: "Initial Phase 4 disbursement must be recorded before adding subsequent tranches",
        });
      }

      const sanctionAmount = Number(caseInfo.sanction_amount || 0);
      const currentDisbursed = Number(caseInfo.disbursement_amount || 0);
      const pendingBalance = Math.max(0, Math.round((sanctionAmount - currentDisbursed) * 100) / 100);

      if (incomingAmount > pendingBalance) {
        return res.status(400).json({
          status: false,
          message: `Tranche amount (₹${incomingAmount}) cannot exceed the pending undisbursed balance of ₹${pendingBalance}`,
        });
      }

      const effectiveDate = disbursement_date || new Date().toISOString().slice(0, 10);

      // 2. Check existing tranches in loan_case_disbursement_tranches
      const existingTranches = await query(
        `SELECT id, tranche_number FROM loan_case_disbursement_tranches WHERE case_id = ? ORDER BY tranche_number ASC`,
        [caseId]
      );

      let nextTrancheNum = existingTranches.length + 1;

      // If no tranches logged yet, synthesize Tranche 1 using the initial Phase 4 disbursement
      if (existingTranches.length === 0 && currentDisbursed > 0) {
        await query(
          `INSERT INTO loan_case_disbursement_tranches 
             (case_id, tranche_number, amount, disbursement_date, remarks)
           VALUES (?, 1, ?, ?, 'Initial Phase 4 Disbursal')`,
          [caseId, currentDisbursed, caseInfo.disbursement_date || effectiveDate]
        );
        nextTrancheNum = 2;
      }

      // 3. Insert new tranche
      await query(
        `INSERT INTO loan_case_disbursement_tranches
           (case_id, tranche_number, amount, disbursement_date, cheque_reference, remarks)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [caseId, nextTrancheNum, incomingAmount, effectiveDate, cheque_reference || null, remarks || null]
      );

      // 4. Update cumulative disbursement amount on loan_case_disbursements
      const newTotalDisbursed = Math.round((currentDisbursed + incomingAmount) * 100) / 100;
      const isNowFullyDisbursed = newTotalDisbursed >= sanctionAmount && sanctionAmount > 0;
      const newDisbType = isNowFullyDisbursed ? "FULL" : "PART";

      await query(
        `UPDATE loan_case_disbursements
         SET disbursement_amount = ?,
             disbursement_type = ?,
             updated_at = NOW()
         WHERE case_id = ?`,
        [newTotalDisbursed, newDisbType, caseId]
      );

      // 5. If fully disbursed, update case status to DISBURSED
      if (isNowFullyDisbursed) {
        await query(
          `UPDATE loan_cases
           SET status = 'DISBURSED',
               updated_at = NOW()
           WHERE id = ?`,
          [caseId]
        );
      }

      // Non-blocking Audit Log
      logAuditAction({
        req,
        actionType: "CASE_DISBURSED",
        module: "Customer Applications",
        entityId: `CASE-${caseId}`,
        entityName: `Case #${caseId}`,
        summary: isNowFullyDisbursed
          ? `Recorded final disbursement tranche of ₹${incomingAmount}. Case #${caseId} is now FULLY DISBURSED.`
          : `Recorded disbursement tranche of ₹${incomingAmount} for Case #${caseId}.`,
        details: `Total Disbursed: ₹${newTotalDisbursed} / ₹${sanctionAmount} • Tranche #${nextTrancheNum}`,
        previousValue: `₹${currentDisbursed}`,
        newValue: `₹${newTotalDisbursed}`,
      });

      return res.status(200).json({
        status: true,
        message: isNowFullyDisbursed
          ? "Tranche recorded! Case is now FULLY DISBURSED."
          : `Tranche #${nextTrancheNum} recorded successfully.`,
        data: {
          case_id: caseId,
          tranche_number: nextTrancheNum,
          tranche_amount: incomingAmount,
          total_disbursed_amount: newTotalDisbursed,
          sanction_amount: sanctionAmount,
          pending_balance: Math.max(0, Math.round((sanctionAmount - newTotalDisbursed) * 100) / 100),
          disbursement_type: newDisbType,
          is_fully_disbursed: isNowFullyDisbursed,
        },
      });
    } catch (error) {
      console.error("ADD TRANCHE ERROR:", error);
      return res.status(500).json({
        status: false,
        message: "Failed to add disbursement tranche",
        error: error.message,
      });
    }
  }
);

module.exports = router;

