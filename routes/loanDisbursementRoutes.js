const express = require("express");
const router = express.Router();

const db = require("../db");
const multer = require("multer");

// ======================================================
// MIDDLEWARE
// ======================================================

const authenticateAndAuthorize = require("../middleware/authMiddleware");

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
      // STEP 14 - PDD LOGIC
      // ==================================================

      if (validatedPddCleared === "YES") {
        const pddValidation = validatePddDocument(req.file);

        if (!pddValidation.success) {
          return res.status(400).json({
            status: false,
            message: pddValidation.message,
          });
        }
      }

      // ==================================================
      // STEP 15 - PDD MUST NOT EXIST WHEN NO
      // ==================================================

      if (validatedPddCleared === "NO" && req.file) {
        return res.status(400).json({
          status: false,
          message: "PDD document must not be uploaded when PDD is NO",
        });
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

      // ==================================================
      // STEP 19 - SUCCESS
      // ==================================================

      return res.status(201).json({
        status: true,

        message:
          validatedPddCleared === "YES"
            ? "Phase 4 disbursement details and PDD document created successfully"
            : "Phase 4 disbursement details created successfully",

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
             OWNERSHIP CHECK ONLY
             ============================================ */

          INNER JOIN loan_cases lc
            ON lcd.case_id = lc.id
            AND lc.dsa_id = ?

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
        [dsaId],
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


          /* ============================================
             DSA DETAILS
             ============================================ */

          dsa.dsa_code,
          dsa.name AS dsa_name,
          dsa.email AS dsa_email,
          dsa.status AS dsa_status,


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
           DSA
           ============================================ */

        INNER JOIN dsa_users dsa
          ON lc.dsa_id = dsa.id


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
            status: row.dsa_status,
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
          },

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

module.exports = router;
