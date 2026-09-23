const express = require("express");
const router = express.Router();

const db = require("../db");
const multer = require("multer");

const authenticateAndAuthorize = require("../middleware/authMiddleware");

const uploadToCloudinary = require("../utils/cloudinaryUpload");
const deleteFromCloudinary = require("../utils/cloudinaryDelete");
// ======================================================
// MEMORY STORAGE
// ======================================================

const storage = multer.memoryStorage();

// ======================================================
// PDF ONLY
// ======================================================

const upload = multer({
  storage,

  limits: {
    fileSize: 5 * 1024 * 1024,
  },

  fileFilter: (req, file, cb) => {

    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Only PDF files are allowed"));
    }

    cb(null, true);

  }

});

const verificationUpload = upload.single("verification_document");
router.post(
  "/upload/:case_id",

  authenticateAndAuthorize("admin"),

  (req, res, next) => {
    verificationUpload(req, res, next);
  },

  async (req, res) => {
    let uploadedCloudinaryFile = null;

    try {
      const case_id = Number(req.params.case_id);
      const adminId = Number(req.user.id);

      if (!req.file) {
        return res.status(400).json({
          status: false,
          message: "Verification PDF is required",
        });
      }

      const [loanCase] = await db.promise().execute(
        `SELECT id, case_number
         FROM loan_cases
         WHERE id=?
         LIMIT 1`,
        [case_id],
      );

      if (loanCase.length === 0) {
        return res.status(404).json({
          status: false,
          message: "Loan case not found",
        });
      }

      const cloudinaryResult = await uploadToCloudinary(
        req.file,
        `lentfin/loan_cases/${loanCase[0].case_number}/admin-verification`,
      );

      uploadedCloudinaryFile = {
        public_id: cloudinaryResult.public_id,
        resource_type: cloudinaryResult.resource_type,
      };

      const fileFormat =
        cloudinaryResult.format ||
        req.file.originalname.split(".").pop().toLowerCase();

      const [insertResult] = await db.promise().execute(
        `INSERT INTO loan_case_verification_documents
        (
          case_id,
          uploaded_by,
          document_type,
          original_name,
          cloudinary_public_id,
          cloudinary_url,
          secure_url,
          resource_type,
          file_format,
          file_size
        )
        VALUES (?,?,?,?,?,?,?,?,?,?)`,

        [
          case_id,
          adminId,
          "VERIFICATION",
          req.file.originalname,
          cloudinaryResult.public_id,
          cloudinaryResult.url,
          cloudinaryResult.secure_url,
          cloudinaryResult.resource_type,
          fileFormat,
          req.file.size,
        ],
      );

      const [document] = await db.promise().execute(
        `SELECT *
         FROM loan_case_verification_documents
         WHERE id=?
         LIMIT 1`,

        [insertResult.insertId],
      );

      return res.status(201).json({
        status: true,
        message: "Verification document uploaded successfully",
        data: document[0],
      });
    } catch (error) {
      if (uploadedCloudinaryFile) {
        await deleteFromCloudinary(
          uploadedCloudinaryFile.public_id,
          uploadedCloudinaryFile.resource_type,
        );
      }

      console.error(error);

      return res.status(500).json({
        status: false,
        message: "Upload failed",
        error: error.message,
      });
    }
  },
);
// ======================================================
// GET VERIFICATION DOCUMENT BY CASE ID
// GET /api/admin-verification/:case_id
// ======================================================

router.get(
  "/:case_id",
  authenticateAndAuthorize("admin"),
  async (req, res) => {
    try {

      const case_id = Number(req.params.case_id);

      if (!Number.isInteger(case_id) || case_id <= 0) {
        return res.status(400).json({
          status: false,
          message: "Invalid case ID"
        });
      }

      // ==========================================
      // CHECK CASE EXISTS
      // ==========================================

      const [loanCase] = await db.promise().execute(
        `SELECT id, case_number
         FROM loan_cases
         WHERE id = ?
         LIMIT 1`,
        [case_id]
      );

      if (loanCase.length === 0) {
        return res.status(404).json({
          status: false,
          message: "Loan case not found"
        });
      }

      // ==========================================
      // GET LATEST VERIFICATION DOCUMENT
      // ==========================================

      const [documents] = await db.promise().execute(
        `SELECT
            id,
            case_id,
            uploaded_by,
            document_type,
            original_name,
            secure_url,
            file_format,
            file_size,
            created_at
         FROM loan_case_verification_documents
         WHERE case_id = ?
         ORDER BY id DESC
         LIMIT 1`,
        [case_id]
      );

      return res.status(200).json({
        status: true,
        message: "Verification document fetched successfully.",
        data: documents.length > 0 ? documents[0] : null
      });

    } catch (error) {

      console.error("GET VERIFICATION DOCUMENT ERROR:", error);

      return res.status(500).json({
        status: false,
        message: "Failed to fetch verification document.",
        error: error.message
      });

    }
  }
);
module.exports = router;