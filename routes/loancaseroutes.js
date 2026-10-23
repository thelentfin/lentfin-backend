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
// NOTIFICATIONS
// ======================================================

const { notifyAllAdmins } = require("../utils/notificationHelper");

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
// MULTER FIELDS CONFIGURATION
//
// Supports standard loans (sanction_letter) and
// Car Loans (car_photos, invoice_copy, insurance_copy, payment_advice)
// ======================================================

const loanCaseUpload = upload.fields([
  { name: "sanction_letter", maxCount: 1 },
  { name: "invoice_copy", maxCount: 1 },
  { name: "insurance_copy", maxCount: 1 },
  { name: "payment_advice", maxCount: 1 },
  { name: "car_photos", maxCount: 5 },
]);

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
    loanCaseUpload(req, res, (err) => {
      // ------------------------------------------------
      // MULTER ERROR
      // ------------------------------------------------

      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            status: false,
            message: "Uploaded file must not exceed 5 MB",
          });
        }

        if (err.code === "LIMIT_UNEXPECTED_FILE") {
          return res.status(400).json({
            status: false,
            message: `Unexpected file field: ${err.field || "unknown"}`,
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

      // Preserve req.file for standard loan cases
      if (
        req.files &&
        req.files.sanction_letter &&
        req.files.sanction_letter.length > 0
      ) {
        req.file = req.files.sanction_letter[0];
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

    let uploadedCloudinaryFiles = [];

    try {
      // ==================================================
      // CAR LOAN HANDLING
      // ==================================================
      const isCarLoan =
        req.body.is_car_loan === "1" ||
        req.body.is_car_loan === "true" ||
        req.body.is_car_loan === true;

      if (isCarLoan) {
        const {
          company_id,
          bank_id,
          customer_name,
          mobile_number,
          banker_name,
          banker_mobile,
          remarks,
          product_id,
          sub_dsa_id,
        } = req.body;

        // Validation for Car Loan fields
        if (!company_id || isNaN(Number(company_id)) || Number(company_id) <= 0) {
          return res.status(400).json({
            status: false,
            message: "Valid corporate company is required",
          });
        }

        if (!bank_id || isNaN(Number(bank_id)) || Number(bank_id) <= 0) {
          return res.status(400).json({
            status: false,
            message: "Valid bank selection is required",
          });
        }

        if (!customer_name || !customer_name.trim() || customer_name.trim().length < 2) {
          return res.status(400).json({
            status: false,
            message: "Customer full name is required (min 2 characters)",
          });
        }

        const indianMobileRegex = /^[6-9]\d{9}$/;
        if (!mobile_number || !indianMobileRegex.test(mobile_number.trim())) {
          return res.status(400).json({
            status: false,
            message: "Valid 10-digit Indian customer mobile number is required",
          });
        }

        if (!banker_name || !banker_name.trim() || banker_name.trim().length < 2) {
          return res.status(400).json({
            status: false,
            message: "Banker / Executive contact name is required",
          });
        }

        if (!banker_mobile || !indianMobileRegex.test(banker_mobile.trim())) {
          return res.status(400).json({
            status: false,
            message: "Valid 10-digit Indian banker / executive mobile number is required",
          });
        }

        // Validate document files
        const carPhotosFiles = req.files?.car_photos || [];
        if (carPhotosFiles.length === 0) {
          return res.status(400).json({
            status: false,
            message: "At least 1 car photo (front photo with number plate) is compulsory",
          });
        }

        const invoiceFile = req.files?.invoice_copy?.[0];
        if (!invoiceFile) {
          return res.status(400).json({
            status: false,
            message: "Vehicle purchase invoice copy is required",
          });
        }

        const insuranceFile = req.files?.insurance_copy?.[0];
        if (!insuranceFile) {
          return res.status(400).json({
            status: false,
            message: "Vehicle insurance policy copy is required",
          });
        }

        const adviceFile = req.files?.payment_advice?.[0] || req.files?.sanction_letter?.[0];
        if (!adviceFile) {
          return res.status(400).json({
            status: false,
            message: "Bank payment advice or sanction letter is required",
          });
        }

        // Check DSA
        const dsaId = req.user.id;
        if (!dsaId) {
          return res.status(401).json({
            status: false,
            message: "DSA authentication information not found",
          });
        }

        const dsaResult = await query(
          `SELECT id, dsa_code, name, email, status, company_id, referred_by_dsa_id
           FROM dsa_users WHERE id = ? LIMIT 1`,
          [dsaId]
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

        if (dsaResult[0].referred_by_dsa_id !== null) {
          return res.status(403).json({
            status: false,
            message: "Referral agents are view-only and cannot submit loan applications directly.",
          });
        }

        let parsedSubDsaId = null;
        if (sub_dsa_id && !isNaN(Number(sub_dsa_id))) {
          const subDsaCheck = await query(
            `SELECT id FROM dsa_users WHERE id = ? AND referred_by_dsa_id = ? AND status = 'ACTIVE' LIMIT 1`,
            [sub_dsa_id, dsaId]
          );
          if (subDsaCheck.length === 0) {
            return res.status(400).json({
              status: false,
              message: "Selected referral agent is invalid or not active under your network.",
            });
          }
          parsedSubDsaId = Number(sub_dsa_id);
        }

        // Check Company
        const companyId = Number(company_id);
        const companyResult = await query(
          `SELECT id, company_name, status FROM companies WHERE id = ? LIMIT 1`,
          [companyId]
        );
        if (companyResult.length === 0) {
          return res.status(404).json({
            status: false,
            message: "Company not found.",
          });
        }
        if (String(companyResult[0].status).toLowerCase() !== "active") {
          return res.status(400).json({
            status: false,
            message: "Selected company is inactive.",
          });
        }

        // Check Bank
        const bankId = Number(bank_id);
        const bankResult = await query(
          `SELECT id, bank_name, status FROM banks WHERE id = ? LIMIT 1`,
          [bankId]
        );
        if (bankResult.length === 0) {
          return res.status(404).json({
            status: false,
            message: "Bank not found",
          });
        }
        if (String(bankResult[0].status).toLowerCase() !== "active") {
          return res.status(400).json({
            status: false,
            message: "Selected bank is inactive",
          });
        }

        // Generate temporary case number
        const temporaryCaseNumber = `TEMP-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
        const parsedProductId = product_id && !isNaN(Number(product_id)) ? Number(product_id) : 16;

        // Insert into loan_cases
        const insertResult = await query(
          `INSERT INTO loan_cases (
             case_number, dsa_id, sub_dsa_id, company_id, bank_id,
             product_id, is_car_loan, customer_name, mobile_number,
             sanction_amount, status, remarks
           ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 0.00, 'SUBMITTED', ?)`,
          [
            temporaryCaseNumber,
            dsaId,
            parsedSubDsaId,
            companyId,
            bankId,
            parsedProductId,
            customer_name.trim(),
            mobile_number.trim(),
            remarks ? remarks.trim() : null,
          ]
        );

        createdCaseId = insertResult.insertId;
        const caseNumber = generateCaseNumber(createdCaseId);

        await query(
          `UPDATE loan_cases SET case_number = ? WHERE id = ?`,
          [caseNumber, createdCaseId]
        );

        // Upload car photos to Cloudinary
        const carPhotoUrls = [];
        for (const pFile of carPhotosFiles) {
          const uploadRes = await uploadToCloudinary(
            pFile,
            `lentfin/loan_cases/${caseNumber}/car_photos`
          );
          uploadedCloudinaryFiles.push({
            public_id: uploadRes.public_id,
            resource_type: uploadRes.resource_type,
          });
          carPhotoUrls.push(uploadRes.secure_url || uploadRes.url);
        }

        // Upload invoice copy
        const invoiceUploadRes = await uploadToCloudinary(
          invoiceFile,
          `lentfin/loan_cases/${caseNumber}/documents`
        );
        uploadedCloudinaryFiles.push({
          public_id: invoiceUploadRes.public_id,
          resource_type: invoiceUploadRes.resource_type,
        });
        const invoiceUrl = invoiceUploadRes.secure_url || invoiceUploadRes.url;

        // Upload insurance copy
        const insuranceUploadRes = await uploadToCloudinary(
          insuranceFile,
          `lentfin/loan_cases/${caseNumber}/documents`
        );
        uploadedCloudinaryFiles.push({
          public_id: insuranceUploadRes.public_id,
          resource_type: insuranceUploadRes.resource_type,
        });
        const insuranceUrl = insuranceUploadRes.secure_url || insuranceUploadRes.url;

        // Upload payment advice
        const adviceUploadRes = await uploadToCloudinary(
          adviceFile,
          `lentfin/loan_cases/${caseNumber}/documents`
        );
        uploadedCloudinaryFiles.push({
          public_id: adviceUploadRes.public_id,
          resource_type: adviceUploadRes.resource_type,
        });
        const paymentAdviceUrl = adviceUploadRes.secure_url || adviceUploadRes.url;

        // Insert into loan_case_documents for backward compatibility
        const adviceFormat =
          adviceUploadRes.format ||
          (adviceFile.originalname ? adviceFile.originalname.split(".").pop().toLowerCase() : "pdf");

        await query(
          `INSERT INTO loan_case_documents (
             case_id, document_type, original_name, cloudinary_public_id,
             cloudinary_url, secure_url, resource_type, file_format, file_size
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            createdCaseId,
            "PAYMENT_ADVICE",
            adviceFile.originalname,
            adviceUploadRes.public_id,
            adviceUploadRes.url,
            adviceUploadRes.secure_url,
            adviceUploadRes.resource_type,
            adviceFormat,
            adviceFile.size,
          ]
        );

        // Insert child record in car_loan_details table
        await query(
          `INSERT INTO car_loan_details (
             case_id, banker_name, banker_mobile, car_photos,
             invoice_copy_url, insurance_copy_url, payment_advice_url
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            createdCaseId,
            banker_name.trim(),
            banker_mobile.trim(),
            JSON.stringify(carPhotoUrls),
            invoiceUrl,
            insuranceUrl,
            paymentAdviceUrl,
          ]
        );

        // Fetch inserted case
        const createdCaseResult = await query(
          `SELECT lc.*, b.bank_name, c.company_name
           FROM loan_cases lc
           INNER JOIN banks b ON lc.bank_id = b.id
           LEFT JOIN companies c ON lc.company_id = c.id
           WHERE lc.id = ? LIMIT 1`,
          [createdCaseId]
        );

        // Notify all admins via database & notification bell
        try {
          await notifyAllAdmins({
            notificationType: "CAR_LOAN_SUBMITTED",
            title: "Car Loan Application Submitted",
            message: `${dsaResult[0]?.name || "DSA"} has submitted car loan case ${caseNumber} for customer ${customer_name.trim()}.`,
            entityType: "CAR_LOAN",
            entityId: createdCaseId,
          });
        } catch (notifErr) {
          console.error("Failed to notify admins of car loan creation:", notifErr);
        }

        // Emit Socket.IO events for live dashboard refresh & notification bell
        try {
          const io = req.app.get("io");
          if (io) {
            io.to("admin").emit("dashboardUpdated", {
              type: "loanCreated",
              caseId: createdCaseId,
            });
            io.to(`dsa_${dsaId}`).emit("dashboardUpdated", {
              type: "loanCreated",
              caseId: createdCaseId,
            });
            io.to("admin").emit("newNotification", {
              type: "CAR_LOAN_SUBMITTED",
              caseId: createdCaseId,
              title: "Car Loan Application Submitted",
              message: `${dsaResult[0]?.name || "DSA"} has submitted car loan case ${caseNumber} for customer ${customer_name.trim()}.`,
              notification_type: "CAR_LOAN_SUBMITTED",
              entity_type: "CAR_LOAN",
              entity_id: createdCaseId,
            });
          }
        } catch (socketErr) {
          console.error("Socket error on car loan creation:", socketErr);
        }

        return res.status(201).json({
          status: true,
          message: "Car loan application registered successfully",
          data: {
            case: createdCaseResult[0],
            car_loan_details: {
              banker_name: banker_name.trim(),
              banker_mobile: banker_mobile.trim(),
              car_photos: carPhotoUrls,
              invoice_copy_url: invoiceUrl,
              insurance_copy_url: insuranceUrl,
              payment_advice_url: paymentAdviceUrl,
            },
          },
        });
      }

      // ==================================================
      // STANDARD LOAN CASE (EXISTING LOGIC)
      // STEP 4
      // GET REQUEST BODY
      // ==================================================

      const {
        company_id,
        bank_id,
        customer_name,
        mobile_number,
        application_number,
        loan_account_number,
        sanction_amount,
        remarks,
        product_id,
        payout_option_id,
        sub_dsa_id,
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
       company_id,
       bank_id,
       customer_name,
       mobile_number,
       application_number,
       loan_account_number,
       sanction_amount,
       remarks,
       sub_dsa_id,
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
      company_id: validatedCompanyId,
      bank_id: validatedBankId,
      customer_name: validatedCustomerName,
      mobile_number: validatedMobileNumber,
      application_number: validatedApplicationNumber,
      loan_account_number: validatedLoanAccountNumber,
      sanction_amount: validatedSanctionAmount,
      remarks: validatedRemarks,
      sub_dsa_id: validatedSubDsaId,
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
            status,
            company_id,
            referred_by_dsa_id
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
      // CHECK DSA ACTIVE & PERMISSIONS
      // ==================================================

      if (String(dsaResult[0].status).toLowerCase() !== "active") {
        return res.status(403).json({
          status: false,
          message: "DSA account is inactive",
        });
      }

      // Referral / Sub-DSA users are view-only and cannot create loan applications
      if (dsaResult[0].referred_by_dsa_id !== null) {
        return res.status(403).json({
          status: false,
          message: "Referral agents are view-only and cannot submit loan applications directly. Please provide customer leads to your Master DSA.",
        });
      }

      // Validate sub_dsa_id belongs to this Master DSA if provided
      let parsedSubDsaId = null;
      if (validatedSubDsaId) {
        const subDsaCheck = await query(
          `SELECT id FROM dsa_users WHERE id = ? AND referred_by_dsa_id = ? AND status = 'ACTIVE' LIMIT 1`,
          [validatedSubDsaId, dsaId]
        );
        if (subDsaCheck.length === 0) {
          return res.status(400).json({
            status: false,
            message: "Selected referral agent is invalid or not active under your network.",
          });
        }
        parsedSubDsaId = validatedSubDsaId;
      }
      // ==================================================
      // STEP 9.1
      // GET COMPANY FROM DSA
      // ==================================================

     const companyId = Number(validatedCompanyId);

     if (!companyId) {
       return res.status(400).json({
         status: false,
         message: "Company is required.",
       });
     }

      // ==================================================
      // STEP 9.2
      // CHECK COMPANY EXISTS
      // ==================================================

      const companyResult = await query(
        `
    SELECT
        id,
        company_name,
        status
    FROM companies
    WHERE id = ?
    LIMIT 1
`,
        [companyId],
      );

      if (companyResult.length === 0) {
        return res.status(404).json({
          status: false,
          message: "Company not found.",
        });
      }

      // ==================================================
      // STEP 9.3
      // CHECK COMPANY ACTIVE
      // ==================================================

      if (String(companyResult[0].status).toLowerCase() !== "active") {
        return res.status(400).json({
          status: false,
          message: "Selected company is inactive.",
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
      // STEP 14b - RESOLVE SLAB RATE FROM PAYOUT OPTION
      // ==================================================

      let parsedProductId = product_id && !isNaN(Number(product_id)) ? Number(product_id) : null;
      let parsedOptionId = payout_option_id && !isNaN(Number(payout_option_id)) ? Number(payout_option_id) : null;
      let slabPercentage = null;

      if (parsedOptionId) {
        try {
          const optRows = await query(
            "SELECT payout_percentage FROM bank_product_payout_options WHERE id = ? LIMIT 1",
            [parsedOptionId]
          );
          if (optRows && optRows.length > 0) {
            slabPercentage = Number(optRows[0].payout_percentage);
          }
        } catch (e) {
          console.error("Failed to resolve payout option:", e);
        }
      }

      // ==================================================
      // STEP 15
      // INSERT LOAN CASE
      // ==================================================

      const insertResult = await query(
        `
          INSERT INTO loan_cases (
    case_number,
    dsa_id,
    sub_dsa_id,
    company_id,
    bank_id,
    product_id,
    payout_option_id,
    payout_percentage,
    customer_name,
    mobile_number,
    application_number,
    loan_account_number,
    sanction_amount,
    status,
    remarks
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          temporaryCaseNumber,
          dsaId,
          parsedSubDsaId,
          companyId,
          validatedBankId,
          parsedProductId,
          parsedOptionId,
          slabPercentage,
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
      // STEP 19 - 22
      // UPLOAD SANCTION LETTER TO CLOUDINARY (IF PROVIDED)
      // ==================================================

      if (req.file) {
        const cloudinaryResult = await uploadToCloudinary(
          req.file,
          `lentfin/loan_cases/${caseNumber}`,
        );

        // SAVE CLOUDINARY INFO FOR CLEANUP
        uploadedCloudinaryFile = {
          public_id: cloudinaryResult.public_id,
          resource_type: cloudinaryResult.resource_type,
        };

        const fileFormat =
          cloudinaryResult.format ||
          (req.file.originalname
            ? req.file.originalname.split(".").pop().toLowerCase()
            : null) ||
          "pdf";

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
      }

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
      // SOCKET.IO EVENT
      // ==================================================

      const io = req.app.get("io");

      // Admin dashboard refresh
      io.to("admin").emit("dashboardUpdated", {
        type: "loanCreated",
        caseId: createdCaseId,
      });

      // Particular DSA dashboard refresh
      io.to(`dsa_${dsaId}`).emit("dashboardUpdated", {
        type: "loanCreated",
        caseId: createdCaseId,
      });
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

      if (uploadedCloudinaryFiles && uploadedCloudinaryFiles.length > 0) {
        for (const file of uploadedCloudinaryFiles) {
          try {
            await deleteFromCloudinary(file.public_id, file.resource_type);
          } catch (deleteError) {
            console.error("CLOUDINARY CLEANUP ERROR (CAR LOAN):", deleteError);
          }
        }
      }

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
          SELECT id, status, referred_by_dsa_id
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
      // GET CASES (Filtered for Sub-DSA vs Master DSA)
      // ==================================================

      const isSubDsa = dsaResult[0].referred_by_dsa_id !== null;

      const cases = await query(
        `
          SELECT
  lc.id,
  lc.case_number,
  lc.dsa_id,
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

  lc.status,
  lc.reviewed_at,
  lc.reject_reason,
  lc.remarks,

  lc.created_at,
  lc.updated_at

FROM loan_cases lc
LEFT JOIN companies c
ON lc.company_id = c.id

INNER JOIN banks b
ON lc.bank_id = b.id

LEFT JOIN dsa_users sub_dsa
ON lc.sub_dsa_id = sub_dsa.id

WHERE ${isSubDsa ? "lc.sub_dsa_id = ?" : "lc.dsa_id = ?"}

ORDER BY lc.id DESC;
        `,
        [dsaId],
      );

      // ==================================================
      // STEP 4
      // GET DOCUMENTS & CAR LOAN DETAILS
      // ==================================================

      const caseIds = cases.map((item) => item.id);

      let documents = [];
      let carLoanMap = {};

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

        try {
          const carRows = await query(
            `SELECT * FROM car_loan_details WHERE case_id IN (?)`,
            [caseIds]
          );
          carRows.forEach((row) => {
            let parsedPhotos = [];
            try {
              parsedPhotos =
                typeof row.car_photos === "string"
                  ? JSON.parse(row.car_photos)
                  : row.car_photos || [];
            } catch (e) {
              parsedPhotos = [];
            }
            carLoanMap[row.case_id] = {
              ...row,
              car_photos: parsedPhotos,
            };
          });
        } catch (e) {
          console.error("Error fetching car_loan_details in /list:", e);
        }
      }

      // ==================================================
      // STEP 5
      // ATTACH DOCUMENTS & CAR LOAN DETAILS
      // ==================================================

      const result = cases.map((loanCase) => ({
        ...loanCase,
        is_car_loan: Boolean(loanCase.is_car_loan || carLoanMap[loanCase.id]),
        car_loan_details: carLoanMap[loanCase.id] || null,
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
lc.company_id,
lc.bank_id,
lc.customer_name,
lc.mobile_number,
lc.application_number,
lc.loan_account_number,
lc.sanction_amount,
lc.product_id,
prod.product_name,
lc.payout_option_id,
bpo.option_label,
lc.payout_percentage,
lc.calculated_commission,

lc.is_car_loan,
cld.banker_name AS car_banker_name,
cld.banker_mobile AS car_banker_mobile,
cld.car_photos AS car_photos,
cld.invoice_copy_url,
cld.insurance_copy_url,
cld.payment_advice_url,

lc.status,
lc.reviewed_by,
lc.reviewed_at,
lc.reject_reason,

lc.remarks,
lc.created_at,
lc.updated_at,
/* ============================================
   COMPANY DETAILS
   ============================================ */

c.company_name,
c.status AS company_status,

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
          dsa.mobile AS dsa_mobile,
          dsa.status AS dsa_status,

          /* ============================================
             SUB-DSA DETAILS
             ============================================ */
          sub_dsa.id AS sub_dsa_id,
          sub_dsa.dsa_code AS sub_dsa_code,
          sub_dsa.name AS sub_dsa_name,
          sub_dsa.mobile AS sub_dsa_mobile,
          sub_dsa.email AS sub_dsa_email,


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

LEFT JOIN companies c
ON lc.company_id = c.id
        /* ============================================
           BANK
           ============================================ */

        INNER JOIN banks b
          ON lc.bank_id = b.id

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
           SUB-DSA
           ============================================ */

        LEFT JOIN dsa_users sub_dsa
          ON lc.sub_dsa_id = sub_dsa.id


        /* ============================================
           CAR LOAN DETAILS
           ============================================ */

        LEFT JOIN car_loan_details cld
          ON lc.id = cld.case_id


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
            mobile: row.dsa_mobile,
            status: row.dsa_status,
          },

          sub_dsa: row.sub_dsa_id
            ? {
                id: row.sub_dsa_id,
                dsa_code: row.sub_dsa_code,
                name: row.sub_dsa_name,
                mobile: row.sub_dsa_mobile,
                email: row.sub_dsa_email,
              }
            : null,

          company: {
            id: row.company_id,
            company_name: row.company_name,
            status: row.company_status,
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
            company_id: row.company_id,
            bank_id: row.bank_id,
            customer_name: row.customer_name,
            mobile_number: row.mobile_number,
            application_number: row.application_number,
            loan_account_number: row.loan_account_number,
            sanction_amount: row.sanction_amount,
            product_id: row.product_id || null,
            product_name: row.product_name || null,
            payout_option_id: row.payout_option_id || null,
            option_label: row.option_label || null,
            payout_percentage: row.payout_percentage !== null ? Number(row.payout_percentage) : null,
            calculated_commission: row.calculated_commission !== null ? Number(row.calculated_commission) : null,

            is_car_loan: Boolean(row.is_car_loan || row.car_banker_name),
            car_loan_details:
              row.is_car_loan || row.car_banker_name
                ? {
                    banker_name: row.car_banker_name,
                    banker_mobile: row.car_banker_mobile,
                    car_photos: (() => {
                      try {
                        return typeof row.car_photos === "string"
                          ? JSON.parse(row.car_photos)
                          : row.car_photos || [];
                      } catch (e) {
                        return [];
                      }
                    })(),
                    invoice_copy_url: row.invoice_copy_url,
                    insurance_copy_url: row.insurance_copy_url,
                    payment_advice_url: row.payment_advice_url,
                  }
                : null,

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
// GET ALL CAR LOAN CASES - ADMIN
// GET /api/loan-case/admin/car-loans
// ======================================================

router.get(
  "/admin/car-loans",
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
        user.role || user.user_role || user.user_type || ""
      ).toLowerCase();

      if (userRole !== "admin") {
        return res.status(403).json({
          status: false,
          message: "Only admin can access car loan cases",
        });
      }

      const rows = await query(
        `SELECT
           lc.id,
           lc.case_number,
           lc.dsa_id,
           lc.sub_dsa_id,
           lc.company_id,
           lc.bank_id,
           lc.customer_name,
           lc.mobile_number,
           lc.application_number,
           lc.loan_account_number,
           lc.sanction_amount,
           lc.is_car_loan,
           lc.status,
           lc.reviewed_by,
           lc.reviewed_at,
           lc.reject_reason,
           lc.remarks,
           lc.created_at,
           lc.updated_at,
           c.company_name,
           b.bank_name,
           dsa.dsa_code,
           dsa.name AS dsa_name,
           dsa.email AS dsa_email,
           dsa.mobile AS dsa_mobile,
           dsa.account_holder_name AS dsa_account_holder_name,
           dsa.account_number AS dsa_account_number,
           dsa.ifsc_code AS dsa_ifsc_code,
           dsa.bank_name AS dsa_bank_name,
           dsa.pan_number AS dsa_pan_number,
           sub_dsa.id AS sub_dsa_id,
           sub_dsa.dsa_code AS sub_dsa_code,
           sub_dsa.name AS sub_dsa_name,
           sub_dsa.mobile AS sub_dsa_mobile,
           sub_dsa.account_holder_name AS sub_dsa_account_holder_name,
           sub_dsa.account_number AS sub_dsa_account_number,
           sub_dsa.ifsc_code AS sub_dsa_ifsc_code,
           sub_dsa.bank_name AS sub_dsa_bank_name,
           sub_dsa.pan_number AS sub_dsa_pan_number,
           cld.id AS cld_id,
           cld.banker_name,
           cld.banker_mobile,
           cld.car_photos,
           cld.invoice_copy_url,
           cld.insurance_copy_url,
           cld.payment_advice_url
         FROM loan_cases lc
         LEFT JOIN car_loan_details cld ON lc.id = cld.case_id
         INNER JOIN banks b ON lc.bank_id = b.id
         INNER JOIN dsa_users dsa ON lc.dsa_id = dsa.id
         LEFT JOIN companies c ON lc.company_id = c.id
         LEFT JOIN dsa_users sub_dsa ON lc.sub_dsa_id = sub_dsa.id
         WHERE lc.is_car_loan = 1 OR cld.id IS NOT NULL
         ORDER BY lc.id DESC`
      );

      const data = rows.map((row) => ({
        id: row.id,
        case_id: row.id,
        case_number: row.case_number,
        customer_name: row.customer_name,
        mobile_number: row.mobile_number,
        bank_name: row.bank_name,
        company_name: row.company_name || "—",
        status: row.status,
        reviewed_by: row.reviewed_by,
        reviewed_at: row.reviewed_at,
        reject_reason: row.reject_reason,
        remarks: row.remarks,
        created_at: row.created_at,
        dsa: {
          id: row.dsa_id,
          dsa_code: row.dsa_code,
          name: row.dsa_name,
          mobile: row.dsa_mobile,
          email: row.dsa_email,
          account_holder_name: row.dsa_account_holder_name || null,
          account_number: row.dsa_account_number || null,
          ifsc_code: row.dsa_ifsc_code || null,
          bank_name: row.dsa_bank_name || null,
          pan_number: row.dsa_pan_number || null,
        },
        sub_dsa: row.sub_dsa_id
          ? {
              id: row.sub_dsa_id,
              dsa_code: row.sub_dsa_code,
              name: row.sub_dsa_name,
              mobile: row.sub_dsa_mobile,
              account_holder_name: row.sub_dsa_account_holder_name || null,
              account_number: row.sub_dsa_account_number || null,
              ifsc_code: row.sub_dsa_ifsc_code || null,
              bank_name: row.sub_dsa_bank_name || null,
              pan_number: row.sub_dsa_pan_number || null,
            }
          : null,
        car_loan_details: {
          banker_name: row.banker_name || "—",
          banker_mobile: row.banker_mobile || "—",
          car_photos: (() => {
            try {
              return typeof row.car_photos === "string"
                ? JSON.parse(row.car_photos)
                : row.car_photos || [];
            } catch (e) {
              return [];
            }
          })(),
          invoice_copy_url: row.invoice_copy_url || null,
          insurance_copy_url: row.insurance_copy_url || null,
          payment_advice_url: row.payment_advice_url || null,
        },
      }));

      return res.status(200).json({
        status: true,
        message: "All Car Loan cases fetched successfully",
        total: data.length,
        data,
      });
    } catch (error) {
      console.error("ADMIN GET CAR LOANS ERROR:", error);
      return res.status(500).json({
        status: false,
        message: "Failed to fetch car loan cases",
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
lc.company_id,
    c.company_name,
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
LEFT JOIN companies c
ON lc.company_id = c.id
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
      // GET DOCUMENTS & CAR LOAN DETAILS
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

      let carLoanDetails = null;
      try {
        const carRows = await query(
          `SELECT * FROM car_loan_details WHERE case_id = ? LIMIT 1`,
          [id]
        );
        if (carRows.length > 0) {
          let parsedPhotos = [];
          try {
            parsedPhotos =
              typeof carRows[0].car_photos === "string"
                ? JSON.parse(carRows[0].car_photos)
                : carRows[0].car_photos || [];
          } catch (e) {
            parsedPhotos = [];
          }
          carLoanDetails = {
            ...carRows[0],
            car_photos: parsedPhotos,
          };
        }
      } catch (e) {
        console.error("Error fetching car_loan_details for single case:", e);
      }

      // ==================================================
      // STEP 8
      // RESPONSE
      // ==================================================

      return res.json({
        status: true,

        data: {
          case: {
            ...cases[0],
            is_car_loan: Boolean(cases[0].is_car_loan || carLoanDetails),
            car_loan_details: carLoanDetails,
          },

          documents: documents,
          car_loan_details: carLoanDetails,
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
        req.user.role || req.user.user_role || "",
      ).toLowerCase();

      if (userRole !== "admin") {
        return res.status(403).json({
          status: false,
          message: "Only admin can update case status.",
        });
      }

      // ==========================================
      // VALID STATUS
      // ==========================================

      if (!["ACCEPTED", "REJECTED"].includes(status)) {
        return res.status(400).json({
          status: false,
          message: "Status must be ACCEPTED or REJECTED.",
        });
      }

      // ==========================================
      // CHECK CASE
      // ==========================================

      const [caseResult] = await db.promise().execute(
        `
       SELECT
    id,
    status,
    dsa_id,
    sub_dsa_id,
    company_id
FROM loan_cases
WHERE id=?
LIMIT 1
        `,
        [case_id],
      );

      if (caseResult.length === 0) {
        return res.status(404).json({
          status: false,
          message: "Loan case not found.",
        });
      }

      // Allow both SUBMITTED and ACCEPTED cases to be reviewed/rejected

      if (!["SUBMITTED", "ACCEPTED"].includes(caseResult[0].status)) {
        return res.status(400).json({
          status: false,
          message: "Only submitted or accepted cases can be reviewed.",
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
          status === "REJECTED" ? reject_reason || null : null,
          case_id,
        ],
      );

      // If ACCEPTED, set Sub-DSA payout status to PAID in loan_case_payments
      if (status === "ACCEPTED") {
        await db.promise().execute(
          `
          UPDATE loan_case_payments
          SET sub_dsa_payout_status = 'PAID'
          WHERE case_id = ? AND sub_dsa_id IS NOT NULL
          `,
          [case_id]
        );
      }

      // ==================================================
      // SOCKET.IO EVENT
      // ==================================================

      const io = req.app.get("io");

      // Admin Dashboard
      io.to("admin").emit("dashboardUpdated", {
        type: "loanStatusChanged",
        caseId: Number(case_id),
        status,
      });

      // Master DSA Dashboard
      io.to(`dsa_${caseResult[0].dsa_id}`).emit("dashboardUpdated", {
        type: "loanStatusChanged",
        caseId: Number(case_id),
        status,
      });

      // Sub-DSA Dashboard (if applicable)
      if (caseResult[0].sub_dsa_id) {
        io.to(`dsa_${caseResult[0].sub_dsa_id}`).emit("dashboardUpdated", {
          type: "loanStatusChanged",
          caseId: Number(case_id),
          status,
          subDsaPayoutStatus: status === "ACCEPTED" ? "PAID" : "PENDING",
        });
      }

      // ==========================================
      // RESPONSE
      // ==========================================

      return res.json({
        status: true,
        message: `Loan case ${status.toLowerCase()} successfully.`,
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
