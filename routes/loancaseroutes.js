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
  validateLoanCase,
  validateSanctionLetter,
} = require("../validations/loanValidation");

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
// SANCTION LETTER UPLOAD
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
// SINGLE FILE
//
// Postman / Frontend field name:
//
// sanction_letter
// ======================================================

const sanctionLetterUpload = upload.single("sanction_letter");

// ======================================================
// GENERATE CASE NUMBER
// ======================================================

const generateCaseNumber = (id) => {
  return `CASE-${String(id).padStart(6, "0")}`;
};

// ======================================================
// POST
// CREATE LOAN CASE
//
// POST /api/loan-case/add
//
// Content-Type:
// multipart/form-data
// ======================================================

router.post(
  "/add",

  // ====================================================
  // STEP 1
  // AUTHENTICATION + DSA ROLE
  // ====================================================

  authenticateAndAuthorize(),

  // ====================================================
  // STEP 2
  // MULTER
  // ====================================================

  (req, res, next) => {
    sanctionLetterUpload(req, res, (err) => {
      // ------------------------------------------------
      // MULTER ERROR
      // ------------------------------------------------

      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            status: false,
            message: "Sanction letter must not exceed 5 MB",
          });
        }

        if (err.code === "LIMIT_UNEXPECTED_FILE") {
          return res.status(400).json({
            status: false,
            message: "Invalid file field. Use sanction_letter",
          });
        }

        return res.status(400).json({
          status: false,
          message: err.message,
        });
      }

      // ------------------------------------------------
      // CUSTOM FILE ERROR
      // ------------------------------------------------

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
  // STEP 3
  // CONTROLLER
  // ====================================================

  async (req, res) => {
    let uploadedCloudinaryFile = null;
    let createdCaseId = null;

    try {
      // ==================================================
      // STEP 4
      // GET REQUEST BODY
      // ==================================================

      const {
        bank_id,
        customer_name,
        mobile_number,
        application_number,
        loan_account_number,
        sanction_amount,
        remarks,
      } = req.body;

      // ==================================================
      // STEP 5
      // VALIDATE SANCTION LETTER
      // ==================================================

      const fileValidation = validateSanctionLetter(req.file);

      if (!fileValidation.success) {
        return res.status(400).json({
          status: false,
          message: fileValidation.message,
        });
      }

      // ==================================================
      // STEP 6
      // VALIDATE REQUEST BODY
      // ==================================================

      const validationResult = validateLoanCase({
        bank_id,
        customer_name,
        mobile_number,
        application_number,
        loan_account_number,
        sanction_amount,
        remarks,
      });

      // ==================================================
      // VALIDATION FAILED
      // ==================================================

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
      // GET CLEAN / VALIDATED DATA
      // ==================================================

      const validatedData = validationResult.data;

      const {
        bank_id: validatedBankId,
        customer_name: validatedCustomerName,
        mobile_number: validatedMobileNumber,
        application_number: validatedApplicationNumber,
        loan_account_number: validatedLoanAccountNumber,
        sanction_amount: validatedSanctionAmount,
        remarks: validatedRemarks,
      } = validatedData;

      // ==================================================
      // STEP 7
      // GET DSA ID FROM JWT
      // ==================================================

      const dsaId = req.user.id;

      if (!dsaId) {
        return res.status(401).json({
          status: false,
          message: "DSA authentication information not found",
        });
      }

      // ==================================================
      // STEP 8
      // CHECK DSA EXISTS
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
      // STEP 9
      // CHECK DSA ACTIVE
      // ==================================================

      if (String(dsaResult[0].status).toLowerCase() !== "active") {
        return res.status(403).json({
          status: false,
          message: "DSA account is inactive",
        });
      }

      // ==================================================
      // STEP 10
      // CHECK BANK EXISTS
      // ==================================================

      const bankResult = await query(
        `
          SELECT
            id,
            bank_name,
            status
          FROM banks
          WHERE id = ?
          LIMIT 1
        `,
        [validatedBankId],
      );

      if (bankResult.length === 0) {
        return res.status(404).json({
          status: false,
          message: "Bank not found",
        });
      }

      // ==================================================
      // STEP 11
      // CHECK BANK ACTIVE
      // ==================================================

      if (String(bankResult[0].status).toLowerCase() !== "active") {
        return res.status(400).json({
          status: false,
          message: "Selected bank is inactive",
        });
      }

      // ==================================================
      // STEP 12
      // APPLICATION NUMBER DUPLICATE
      // ==================================================

      if (
        validatedApplicationNumber &&
        validatedApplicationNumber.trim() !== ""
      ) {
        const applicationResult = await query(
          `
              SELECT id
              FROM loan_cases
              WHERE application_number = ?
              LIMIT 1
            `,
          [validatedApplicationNumber.trim()],
        );

        if (applicationResult.length > 0) {
          return res.status(409).json({
            status: false,
            message: "Application number already exists",
          });
        }
      }

      // ==================================================
      // STEP 13
      // LOAN ACCOUNT NUMBER DUPLICATE
      // ==================================================

      if (
        validatedLoanAccountNumber &&
        validatedLoanAccountNumber.trim() !== ""
      ) {
        const loanAccountResult = await query(
          `
              SELECT id
              FROM loan_cases
              WHERE loan_account_number = ?
              LIMIT 1
            `,
          [validatedLoanAccountNumber.trim()],
        );

        if (loanAccountResult.length > 0) {
          return res.status(409).json({
            status: false,
            message: "Loan account number already exists",
          });
        }
      }

      // ==================================================
      // STEP 14
      // CREATE TEMPORARY CASE NUMBER
      // ==================================================

      const temporaryCaseNumber = `TEMP-${Date.now()}-${Math.floor(
        Math.random() * 100000,
      )}`;

      // ==================================================
      // STEP 15
      // INSERT LOAN CASE
      // ==================================================

      const insertResult = await query(
        `
          INSERT INTO loan_cases (
            case_number,
            dsa_id,
            bank_id,
            customer_name,
            mobile_number,
            application_number,
            loan_account_number,
            sanction_amount,
            status,
            remarks
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          temporaryCaseNumber,

          dsaId,

          validatedBankId,

          validatedCustomerName,

          validatedMobileNumber,

          validatedApplicationNumber ? validatedApplicationNumber : null,

          validatedLoanAccountNumber ? validatedLoanAccountNumber : null,

          validatedSanctionAmount,

          "DRAFT",

          validatedRemarks ? validatedRemarks : null,
        ],
      );

      // ==================================================
      // STEP 16
      // GET INSERTED CASE ID
      // ==================================================

      createdCaseId = insertResult.insertId;

      // ==================================================
      // STEP 17
      // GENERATE FINAL CASE NUMBER
      // ==================================================

      const caseNumber = generateCaseNumber(createdCaseId);

      // ==================================================
      // STEP 18
      // UPDATE FINAL CASE NUMBER
      // ==================================================

      await query(
        `
          UPDATE loan_cases
          SET case_number = ?
          WHERE id = ?
        `,
        [caseNumber, createdCaseId],
      );

      // ==================================================
      // STEP 19
      // UPLOAD SANCTION LETTER TO CLOUDINARY
      // ==================================================

      const cloudinaryResult = await uploadToCloudinary(
        req.file,
        `lentfin/loan_cases/${caseNumber}`,
      );

      // ==================================================
      // STEP 20
      // SAVE CLOUDINARY INFO FOR CLEANUP
      // ==================================================

      uploadedCloudinaryFile = {
        public_id: cloudinaryResult.public_id,

        resource_type: cloudinaryResult.resource_type,
      };

      // ==================================================
      // STEP 21
      // GET FILE FORMAT
      // ==================================================

      const fileFormat =
        cloudinaryResult.format ||
        (req.file.originalname
          ? req.file.originalname.split(".").pop().toLowerCase()
          : null) ||
        "pdf";

      // ==================================================
      // STEP 22
      // INSERT DOCUMENT
      // ==================================================

      await query(
        `
          INSERT INTO loan_case_documents (
            case_id,
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
          createdCaseId,

          "SANCTION_LETTER",

          req.file.originalname,

          cloudinaryResult.public_id,

          cloudinaryResult.url,

          cloudinaryResult.secure_url,

          cloudinaryResult.resource_type,

          fileFormat,

          req.file.size,
        ],
      );

      // ==================================================
      // STEP 23
      // GET CREATED CASE
      // ==================================================

      const createdCaseResult = await query(
        `
            SELECT
              lc.id,
              lc.case_number,

              lc.dsa_id,

              lc.bank_id,
              b.bank_name,

              lc.customer_name,
              lc.mobile_number,

              lc.application_number,
              lc.loan_account_number,

              lc.sanction_amount,

              lc.status,
              lc.remarks,

              lc.created_at,
              lc.updated_at

            FROM loan_cases lc

            INNER JOIN banks b
              ON lc.bank_id = b.id

            WHERE lc.id = ?

            LIMIT 1
          `,
        [createdCaseId],
      );

      // ==================================================
      // STEP 24
      // GET DOCUMENT
      // ==================================================

      const documentResult = await query(
        `
            SELECT
              id,
              case_id,
              document_type,
              original_name,
              cloudinary_public_id,
              cloudinary_url,
              secure_url,
              resource_type,
              file_format,
              file_size,
              created_at

            FROM loan_case_documents

            WHERE case_id = ?

            ORDER BY id DESC

            LIMIT 1
          `,
        [createdCaseId],
      );

      // ==================================================
      // STEP 25
      // SUCCESS
      // ==================================================

      return res.status(201).json({
        status: true,

        message: "Loan case and sanction letter created successfully",

        data: {
          case: createdCaseResult[0],

          document: documentResult.length > 0 ? documentResult[0] : null,
        },
      });
    } catch (error) {
      // ==================================================
      // STEP 26
      // ERROR LOG
      // ==================================================

      console.error("CREATE LOAN CASE ERROR:", error);

      // ==================================================
      // STEP 27
      // CLOUDINARY CLEANUP
      // ==================================================

      if (uploadedCloudinaryFile && uploadedCloudinaryFile.public_id) {
        try {
          await deleteFromCloudinary(
            uploadedCloudinaryFile.public_id,
            uploadedCloudinaryFile.resource_type,
          );

          console.log(
            "Sanction letter deleted from Cloudinary after database failure",
          );
        } catch (deleteError) {
          console.error("CLOUDINARY CLEANUP ERROR:", deleteError);
        }
      }

      // ==================================================
      // STEP 28
      // DELETE CREATED LOAN CASE
      //
      // If DB case was created but later operation failed,
      // remove that incomplete case.
      // ==================================================

      if (createdCaseId) {
        try {
          await query(
            `
              DELETE FROM loan_cases
              WHERE id = ?
            `,
            [createdCaseId],
          );

          console.log("Incomplete loan case deleted:", createdCaseId);
        } catch (cleanupError) {
          console.error("LOAN CASE CLEANUP ERROR:", cleanupError);
        }
      }

      // ==================================================
      // STEP 29
      // ERROR RESPONSE
      // ==================================================

      return res.status(500).json({
        status: false,

        message: "Failed to create loan case",

        error: error.message,
      });
    }
  },
);

// ======================================================
// GET ALL LOAN CASES
//
// GET /api/loan-case/list
// ======================================================

router.get(
  "/list",

  authenticateAndAuthorize(),

  async (req, res) => {
    try {
      // ==================================================
      // STEP 1
      // GET DSA ID
      // ==================================================

      const dsaId = req.user.id;

      if (!dsaId) {
        return res.status(401).json({
          status: false,
          message: "DSA authentication information not found",
        });
      }

      // ==================================================
      // STEP 2
      // CHECK DSA ACTIVE
      // ==================================================

      const dsaResult = await query(
        `
          SELECT id, status
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
      // STEP 3
      // GET CASES
      // ==================================================

      const cases = await query(
        `
          SELECT
  lc.id,
  lc.case_number,
  lc.dsa_id,
  lc.bank_id,
  b.bank_name,

  lc.customer_name,
  lc.mobile_number,

  lc.application_number,
  lc.loan_account_number,

  lc.sanction_amount,

  lc.status,
  lc.reviewed_at,
  lc.reject_reason,
  lc.remarks,

  lc.created_at,
  lc.updated_at

FROM loan_cases lc

INNER JOIN banks b
ON lc.bank_id = b.id

WHERE lc.dsa_id = ?

ORDER BY lc.id DESC;
        `,
        [dsaId],
      );

      // ==================================================
      // STEP 4
      // GET DOCUMENTS
      // ==================================================

      const caseIds = cases.map((item) => item.id);

      let documents = [];

      if (caseIds.length > 0) {
        documents = await query(
          `
            SELECT
              id,
              case_id,
              document_type,
              original_name,
              cloudinary_public_id,
              cloudinary_url,
              secure_url,
              resource_type,
              file_format,
              file_size,
              created_at

            FROM loan_case_documents

            WHERE case_id IN (?)

            ORDER BY id DESC
          `,
          [caseIds],
        );
      }

      // ==================================================
      // STEP 5
      // ATTACH DOCUMENTS
      // ==================================================

      const result = cases.map((loanCase) => ({
        ...loanCase,

        documents: documents.filter(
          (document) => document.case_id === loanCase.id,
        ),
      }));

      // ==================================================
      // STEP 6
      // RESPONSE
      // ==================================================

      return res.json({
        status: true,

        count: result.length,

        data: result,
      });
    } catch (error) {
      console.error("GET LOAN CASES ERROR:", error);

      return res.status(500).json({
        status: false,

        message: "Failed to get loan cases",

        error: error.message,
      });
    }
  },
);
// ======================================================
// GET ALL LOAN CASES - ADMIN
//
// GET /api/loan-case/admin/all
//
// Admin can view Loan Cases created by ALL DSAs.
//
// Returns:
// - DSA details
// - Bank details
// - Loan Case details
// - Latest sanction letter document
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
      // STEP 2 - GET AUTHENTICATED USER
      // ==================================================

      const user = req.user;

      if (!user) {
        return res.status(401).json({
          status: false,
          message: "Authentication information not found",
        });
      }

      // ==================================================
      // STEP 3 - ADMIN ROLE CHECK
      // ==================================================

      const userRole = String(
        user.role || user.user_role || user.user_type || ""
      ).toLowerCase();

      if (userRole !== "admin") {
        return res.status(403).json({
          status: false,
          message: "Only admin can access all loan case details",
        });
      }

      // ==================================================
      // STEP 4 - GET ALL LOAN CASES
      // ==================================================

      const loanCaseRows = await query(
        `
        SELECT

          /* ============================================
             LOAN CASE DETAILS
             ============================================ */

          lc.id,
lc.case_number,
lc.dsa_id,
lc.bank_id,
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


          /* ============================================
             BANK DETAILS
             ============================================ */

          b.bank_name,
          b.status AS bank_status,


          /* ============================================
             DSA DETAILS
             ============================================ */

          dsa.dsa_code,
          dsa.name AS dsa_name,
          dsa.email AS dsa_email,
          dsa.status AS dsa_status,


          /* ============================================
             LATEST SANCTION LETTER
             ============================================ */

          lcd.id AS document_id,
          lcd.case_id AS document_case_id,
          lcd.document_type,
          lcd.original_name,
          lcd.cloudinary_public_id,
          lcd.cloudinary_url,
          lcd.secure_url,
          lcd.resource_type,
          lcd.file_format,
          lcd.file_size,
          lcd.created_at AS document_created_at

        FROM loan_cases lc


        /* ============================================
           BANK
           ============================================ */

        INNER JOIN banks b
          ON lc.bank_id = b.id


        /* ============================================
           DSA
           ============================================ */

        INNER JOIN dsa_users dsa
          ON lc.dsa_id = dsa.id


        /* ============================================
           LATEST LOAN CASE DOCUMENT
           ============================================ */

        LEFT JOIN loan_case_documents lcd
          ON lc.id = lcd.case_id
          AND lcd.id = (
            SELECT MAX(d2.id)
            FROM loan_case_documents d2
            WHERE d2.case_id = lc.id
          )


        /* ============================================
           ORDER
           ============================================ */

        ORDER BY lc.id DESC
        `,
      );

      // ==================================================
      // STEP 5 - FORMAT RESPONSE
      // ==================================================

      const loanCases = loanCaseRows.map((row) => {
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
          // BANK DETAILS
          // ============================================

          bank: {
            id: row.bank_id,
            bank_name: row.bank_name,
            status: row.bank_status,
          },

          // ============================================
          // LOAN CASE DETAILS
          // ============================================

          loan_case: {
            id: row.id,
            case_number: row.case_number,
            dsa_id: row.dsa_id,
            bank_id: row.bank_id,
            customer_name: row.customer_name,
            mobile_number: row.mobile_number,
            application_number: row.application_number,
            loan_account_number: row.loan_account_number,
            sanction_amount: row.sanction_amount,

            status: row.status,
            reviewed_by: row.reviewed_by,
            reviewed_at: row.reviewed_at,
            reject_reason: row.reject_reason,

            remarks: row.remarks,
            created_at: row.created_at,
            updated_at: row.updated_at,
          },
          // ============================================
          // SANCTION LETTER DOCUMENT
          // ============================================

          document: row.document_id
            ? {
                id: row.document_id,
                case_id: row.document_case_id,
                document_type: row.document_type,
                original_name: row.original_name,
                cloudinary_public_id: row.cloudinary_public_id,
                cloudinary_url: row.cloudinary_url,
                secure_url: row.secure_url,
                resource_type: row.resource_type,
                file_format: row.file_format,
                file_size: row.file_size,
                created_at: row.document_created_at,
              }
            : null,
        };
      });

      // ==================================================
      // STEP 6 - SUCCESS RESPONSE
      // ==================================================

      return res.status(200).json({
        status: true,
        message: "All DSA loan case details fetched successfully",
        total_loan_cases: loanCases.length,
        data: loanCases,
      });
    } catch (error) {
      // ==================================================
      // STEP 7 - ERROR
      // ==================================================

      console.error(
        "ADMIN GET ALL LOAN CASES ERROR:",
        error
      );

      return res.status(500).json({
        status: false,
        message: "Failed to get all DSA loan case details",
        error: error.message,
      });
    }
  }
);

// ======================================================
// GET SINGLE LOAN CASE
//
// GET /api/loan-case/:id
// ======================================================

router.get(
  "/:id",

  authenticateAndAuthorize(),

  async (req, res) => {
    try {
      // ==================================================
      // STEP 1
      // GET CASE ID
      // ==================================================

      const { id } = req.params;

      // ==================================================
      // STEP 2
      // VALIDATE CASE ID
      // ==================================================

      if (!id || !/^\d+$/.test(id) || Number(id) <= 0) {
        return res.status(400).json({
          status: false,
          message: "Invalid case id",
        });
      }

      // ==================================================
      // STEP 3
      // GET DSA ID
      // ==================================================

      const dsaId = req.user.id;

      if (!dsaId) {
        return res.status(401).json({
          status: false,
          message: "DSA authentication information not found",
        });
      }

      // ==================================================
      // STEP 4
      // CHECK DSA
      // ==================================================

      const dsaResult = await query(
        `
          SELECT id, status
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
      // STEP 5
      // GET CASE
      // IMPORTANT:
      // dsa_id condition prevents another DSA
      // from seeing this case.
      // ==================================================

      const cases = await query(
        `
          SELECT
            lc.id,
            lc.case_number,

            lc.dsa_id,

            lc.bank_id,
            b.bank_name,

            lc.customer_name,
            lc.mobile_number,

            lc.application_number,
            lc.loan_account_number,

            lc.sanction_amount,

            lc.status,
            lc.remarks,

            lc.created_at,
            lc.updated_at

          FROM loan_cases lc

          INNER JOIN banks b
            ON lc.bank_id = b.id

          WHERE lc.id = ?
          AND lc.dsa_id = ?

          LIMIT 1
        `,
        [id, dsaId],
      );

      // ==================================================
      // STEP 6
      // CASE NOT FOUND
      // ==================================================

      if (cases.length === 0) {
        return res.status(404).json({
          status: false,
          message: "Loan case not found",
        });
      }

      // ==================================================
      // STEP 7
      // GET DOCUMENTS
      // ==================================================

      const documents = await query(
        `
          SELECT
            id,
            case_id,
            document_type,
            original_name,
            cloudinary_public_id,
            cloudinary_url,
            secure_url,
            resource_type,
            file_format,
            file_size,
            created_at

          FROM loan_case_documents

          WHERE case_id = ?

          ORDER BY id DESC
        `,
        [id],
      );

      // ==================================================
      // STEP 8
      // RESPONSE
      // ==================================================

      return res.json({
        status: true,

        data: {
          case: cases[0],

          documents: documents,
        },
      });
    } catch (error) {
      console.error("GET SINGLE LOAN CASE ERROR:", error);

      return res.status(500).json({
        status: false,

        message: "Failed to get loan case",

        error: error.message,
      });
    }
  },
);
// ======================================================
// ADMIN APPROVE / REJECT LOAN CASE
// PUT /api/loan-case/admin/status/:case_id
// ======================================================

router.put(
  "/admin/status/:case_id",
  authenticateAndAuthorize(),
  async (req, res) => {
    try {
      const { case_id } = req.params;
      const { status, reject_reason } = req.body;

      // ==========================================
      // ADMIN CHECK
      // ==========================================

      const userRole = String(
        req.user.role || req.user.user_role || ""
      ).toLowerCase();

      if (userRole !== "admin") {
        return res.status(403).json({
          status: false,
          message: "Only admin can update case status."
        });
      }

      // ==========================================
      // VALID STATUS
      // ==========================================

      if (!["ACCEPTED", "REJECTED"].includes(status)) {
        return res.status(400).json({
          status: false,
          message: "Status must be ACCEPTED or REJECTED."
        });
      }

      // ==========================================
      // CHECK CASE
      // ==========================================

      const [caseResult] = await db.promise().execute(
        `
        SELECT id,status
        FROM loan_cases
        WHERE id=?
        LIMIT 1
        `,
        [case_id]
      );

      if (caseResult.length === 0) {
        return res.status(404).json({
          status: false,
          message: "Loan case not found."
        });
      }

      // Only Submitted case can be reviewed

      if (caseResult[0].status !== "SUBMITTED") {
        return res.status(400).json({
          status: false,
          message: "Only submitted cases can be reviewed."
        });
      }

      // ==========================================
      // UPDATE
      // ==========================================

      await db.promise().execute(
        `
        UPDATE loan_cases
        SET
          status=?,
          reviewed_by=?,
          reviewed_at=NOW(),
          reject_reason=?
        WHERE id=?
        `,
        [
          status,
          req.user.id,
          status === "REJECTED"
            ? (reject_reason || null)
            : null,
          case_id
        ]
      );

      // ==========================================
      // RESPONSE
      // ==========================================

      return res.json({
        status: true,
        message: `Loan case ${status.toLowerCase()} successfully.`
      });

    } catch (error) {

      console.error(error);

      return res.status(500).json({
        status: false,
        message: "Failed to update loan case status.",
        error: error.message
      });

    }
  }
);

module.exports = router;
