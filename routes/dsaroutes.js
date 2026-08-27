const express = require("express");
const router = express.Router();

const db = require("../db");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const multer = require("multer");

const authenticateAndAuthorize = require("../middleware/authMiddleware");
const uploadToCloudinary = require("../utils/cloudinaryUpload");
const deleteFromCloudinary = require("../utils/cloudinaryDelete");
const { dsaSignupSchema } = require("../validations/dsaValidation");
const { sendEmail } = require("../utils/brevoEmail");
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
// FILE UPLOAD CONFIGURATION
// Allowed: PDF, JPG, JPEG, PNG
// Maximum: 5 MB
// ======================================================

const upload = multer({
  storage,

  limits: {
    fileSize: 5 * 1024 * 1024,
  },

  fileFilter: (req, file, cb) => {
    const allowedTypes = ["application/pdf", "image/jpeg", "image/png"];

    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error("Only PDF, JPG and PNG files are allowed"));
    }

    cb(null, true);
  },
});

// ======================================================
// DSA DOCUMENT UPLOAD FIELDS
//
// card_file              = Basic PAN Card
// aadhaar_file           = Aadhaar Card
// passport_file          = Passport
// msme_file              = MSME Certificate
// gst_file               = GST Certificate
// partnership_deed_file  = Partnership Deed
// pan_file               = Partnership PAN Card
// ======================================================

const dsaUpload = upload.fields([
  {
    name: "card_file",
    maxCount: 1,
  },

  {
    name: "aadhaar_file",
    maxCount: 1,
  },

  {
    name: "passport_file",
    maxCount: 1,
  },

  {
    name: "msme_file",
    maxCount: 1,
  },

  {
    name: "gst_file",
    maxCount: 1,
  },

  {
    name: "partnership_deed_file",
    maxCount: 1,
  },

  {
    name: "pan_file",
    maxCount: 1,
  },
]);
// ======================================================
// DSA SIGNUP
//
// POST /api/dsa/signup
//
// Creates:
// 1. dsa_signup_requests
// 2. dsa_signup_documents
//
// Does NOT create dsa_users.
// ======================================================

router.post(
  "/signup",

  // ==================================================
  // MULTER FILE VALIDATION
  // ==================================================

  (req, res, next) => {
    dsaUpload(req, res, (err) => {
      // ----------------------------------------------
      // MULTER ERROR
      // ----------------------------------------------

      if (err instanceof multer.MulterError) {
        // FILE SIZE > 5 MB
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            status: false,
            message: "Each document must not exceed 5 MB",
          });
        }

        return res.status(400).json({
          status: false,
          message: err.message,
        });
      }

      // ----------------------------------------------
      // FILE TYPE ERROR
      // ----------------------------------------------

      if (err) {
        return res.status(400).json({
          status: false,
          message: err.message,
        });
      }

      next();
    });
  },

  // ==================================================
  // SIGNUP CONTROLLER
  // ==================================================

  async (req, res) => {
    try {
      // ==================================================
      // 1. ZOD VALIDATION
      // ==================================================

      const validation = dsaSignupSchema.safeParse(req.body);

      if (!validation.success) {
        return res.status(400).json({
          status: false,
          message: "Validation failed",
          errors: validation.error.flatten().fieldErrors,
        });
      }

      const data = validation.data;

      // ==================================================
      // 2. GET FILES
      // ==================================================

      const files = req.files || {};

      // ==================================================
      // HELPER
      // ==================================================

      const hasFile = (fieldName) => {
        return files[fieldName] && files[fieldName].length > 0;
      };

      // ==================================================
      // 3.1 BASIC DOCUMENTS
      // ALWAYS REQUIRED
      // ==================================================

      const basicRequiredDocuments = [
        "card_file", // Basic PAN Card
        "aadhaar_file", // Aadhaar
        "passport_file", // Passport
      ];

      for (const documentName of basicRequiredDocuments) {
        if (!hasFile(documentName)) {
          return res.status(400).json({
            status: false,
            message: `${documentName} is required`,
          });
        }
      }

      // ==================================================
      // 3.2 GST + MSME
      // REQUIRED ONLY WHEN GST NUMBER IS ENTERED
      // ==================================================

      if (data.gst_number && data.gst_number.trim() !== "") {
        // -----------------------------------------------
        // GST CERTIFICATE
        // -----------------------------------------------

        if (!hasFile("gst_file")) {
          return res.status(400).json({
            status: false,
            message: "GST certificate is required when GST number is provided",
          });
        }

        // -----------------------------------------------
        // MSME CERTIFICATE
        // -----------------------------------------------

        if (!hasFile("msme_file")) {
          return res.status(400).json({
            status: false,
            message: "MSME certificate is required when GST number is provided",
          });
        }
      }

      // ==================================================
      // 3.3 PARTNERSHIP DOCUMENTS
      // REQUIRED ONLY FOR PARTNERSHIP
      // ==================================================

      if (data.constitution_type === "Partnership") {
        // -----------------------------------------------
        // PARTNERSHIP DEED
        // -----------------------------------------------

        if (!hasFile("partnership_deed_file")) {
          return res.status(400).json({
            status: false,
            message:
              "Partnership deed is required for Partnership constitution",
          });
        }

        // -----------------------------------------------
        // PARTNERSHIP PAN CARD
        // -----------------------------------------------

        if (!hasFile("pan_file")) {
          return res.status(400).json({
            status: false,
            message:
              "Partnership PAN card is required for Partnership constitution",
          });
        }
      }
      // ==================================================
      // 4. CHECK COMPANY
      // ==================================================

      const companyQuery = `
      SELECT id
      FROM companies
      WHERE id = ?
      AND status = 'Active'
    `;

      const companyResult = await query(companyQuery, [data.company_id]);

      if (companyResult.length === 0) {
        return res.status(400).json({
          status: false,
          message: "Invalid or inactive company",
        });
      }

      // ==================================================
      // 5. CHECK LOCATION
      // ==================================================

      const locationQuery = `
      SELECT id
      FROM locations
      WHERE id = ?
      AND company_id = ?
      AND status = 'Active'
    `;

      const locationResult = await query(locationQuery, [
        data.location_id,
        data.company_id,
      ]);

      if (locationResult.length === 0) {
        return res.status(400).json({
          status: false,
          message: "Invalid location for selected company",
        });
      }

      // ==================================================
      // 6. CHECK EXISTING DSA
      // ==================================================

      const existingDsaQuery = `
      SELECT id
      FROM dsa_users
      WHERE email = ?
      OR mobile = ?
    `;

      const existingDsa = await query(existingDsaQuery, [
        data.email,
        data.mobile,
      ]);

      if (existingDsa.length > 0) {
        return res.status(409).json({
          status: false,
          message: "DSA already exists with this email or mobile",
        });
      }

      // ==================================================
      // 7. CHECK EXISTING PENDING REQUEST
      // ==================================================

      const pendingQuery = `
      SELECT id
      FROM dsa_signup_requests
      WHERE
        (email = ? OR mobile = ?)
        AND status = 'PENDING'
    `;

      const pendingResult = await query(pendingQuery, [
        data.email,
        data.mobile,
      ]);

      if (pendingResult.length > 0) {
        return res.status(409).json({
          status: false,
          message:
            "A DSA verification request is already pending for this email or mobile",
        });
      }

      // ==================================================
      // 8. INSERT SIGNUP REQUEST
      //
      // NOTE: company_name and location are TEXT fields
      // (denormalized snapshot alongside company_id /
      // location_id) and were MISSING from this query,
      // which is why they were never saved to the DB.
      // ==================================================

      const insertRequestQuery = `
      INSERT INTO dsa_signup_requests (
        company_id,
        company_name,
        location_id,
        location,
        name,
        email,
        mobile,
        pan_number,
        aadhaar_number,
        gst_number,
        constitution_type,
        account_holder_name,
        account_number,
        ifsc_code,
        status
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING'
      )
    `;

      const requestValues = [
        data.company_id,
        data.company_name || null,

        data.location_id,
        data.location || null,

        data.name,
        data.email,
        data.mobile,

        data.pan_number || null,
        data.aadhaar_number || null,
        data.gst_number || null,

        data.constitution_type || null,

        data.account_holder_name || null,
        data.account_number || null,
        data.ifsc_code || null,
      ];

      const requestResult = await query(insertRequestQuery, requestValues);

      const requestId = requestResult.insertId;

      // ==================================================
      // 9. DOCUMENT TYPE MAP
      // ==================================================

      const documentMap = {
        card_file: "CARD",
        aadhaar_file: "AADHAAR",
        passport_file: "PASSPORT",
        msme_file: "MSME",
        gst_file: "GST",
        partnership_deed_file: "PARTNERSHIP_DEED",
        pan_file: "PAN",
      };

      // ==================================================
      // 10. UPLOAD DOCUMENTS TO CLOUDINARY
      // ==================================================

      for (const fieldName of Object.keys(documentMap)) {
        if (!files[fieldName] || files[fieldName].length === 0) {
          continue;
        }

        const file = files[fieldName][0];

        // ==============================================
        // UPLOAD TO CLOUDINARY
        // ==============================================

        const cloudinaryResult = await uploadToCloudinary(
          file,
          `lentfin/dsa/signup/${requestId}`,
        );

        // Determine file format
        const fileFormat =
          cloudinaryResult.format ||
          (file.originalname
            ? file.originalname.split(".").pop().toLowerCase()
            : null) ||
          "pdf";
        // ==============================================
        // SAVE DOCUMENT DETAILS
        // ==============================================

        const documentQuery = `
        INSERT INTO dsa_signup_documents (
          request_id,
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
      `;

        await query(documentQuery, [
          requestId,
          documentMap[fieldName],
          file.originalname,
          cloudinaryResult.public_id,
          cloudinaryResult.url,
          cloudinaryResult.secure_url,
          cloudinaryResult.resource_type,
          fileFormat,
          file.size,
        ]);
      }
      // ======================================================
      // 11. SEND CORPORATE DSA EMAIL NOTIFICATION
      // ======================================================

      try {
        // ----------------------------------------------
        // GET ACTIVE CORPORATE DSA / ADMIN USERS
        // ----------------------------------------------

        const adminQuery = `
    SELECT
      id,
      name,
      email,
      role
    FROM users
    WHERE role = 'admin'
    AND status = 'Active'
  `;

        const adminUsers = await query(adminQuery);

        // ----------------------------------------------
        // CHECK ADMIN EXISTS
        // ----------------------------------------------

        if (adminUsers.length === 0) {
          // No active Corporate DSA / Admin found
        } else {
          // ============================================
          // INSERT ONLY ONE NOTIFICATION ROW (BROADCAST)
          //
          // recipient_user_id = NULL means "visible to
          // ALL active admins". This runs ONCE here,
          // OUTSIDE the email-sending loop below, so no
          // matter how many admins exist (1, 3, 10...)
          // only ONE row gets inserted into the
          // notifications table for this signup request.
          // ============================================

          const notificationInsertQuery = `
            INSERT INTO notifications (
              recipient_user_id,
              notification_type,
              title,
              message,
              entity_type,
              entity_id
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `;

          await query(notificationInsertQuery, [
            null, // NULL = broadcast, shown to all admins
            "DSA_SIGNUP_REQUEST",
            "New DSA Verification Request",
            `${data.name} has submitted a new DSA signup request.`,
            "dsa_signup_request",
            requestId,
          ]);

          // --------------------------------------------
          // SEND EMAIL TO ALL ACTIVE ADMINS
          // --------------------------------------------

          for (const admin of adminUsers) {
            const emailResult = await sendEmail({
              to: admin.email,
              toName: admin.name,

              subject: `New DSA Verification Request #${requestId}`,

              htmlContent: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <title>New DSA Verification Request</title>
          </head>

          <body style="
            margin:0;
            padding:0;
            background:#f5f7fb;
            font-family:Arial, sans-serif;
          ">

            <div style="
              max-width:650px;
              margin:30px auto;
              background:#ffffff;
              border-radius:10px;
              padding:30px;
            ">

              <h2 style="
                margin-top:0;
                color:#222;
              ">
                New DSA Verification Request
              </h2>

              <p>
                Hello ${admin.name},
              </p>

              <p>
                A new DSA verification request has been submitted
                and is waiting for Corporate DSA verification.
              </p>

              <hr>

              <h3>DSA Details</h3>

              <p>
                <strong>Request ID:</strong>
                ${requestId}
              </p>

              <p>
                <strong>Name:</strong>
                ${data.name}
              </p>

              <p>
                <strong>Email:</strong>
                ${data.email}
              </p>

              <p>
                <strong>Mobile:</strong>
                ${data.mobile}
              </p>

              <p>
                <strong>Status:</strong>
                <span style="color:#d97706;">
                  PENDING
                </span>
              </p>

              <hr>

              <p>
                Please login to the Corporate DSA dashboard
                and review the submitted documents.
              </p>

              <div style="
                margin-top:25px;
                padding:15px;
                background:#f3f4f6;
                border-radius:8px;
              ">
                <strong>Action Required:</strong>
                <br>
                Please verify or reject this DSA request
                from the Corporate DSA dashboard.
              </div>

              <br>

              <p>
                Regards,<br>
                <strong>LentFin Team</strong>
              </p>

            </div>

          </body>
          </html>
        `,
            });

            if (!emailResult.success) {
              // Failed to send DSA notification email to admin
            }
          }
        }
      } catch (emailError) {
        // ----------------------------------------------
        // EMAIL FAILURE SHOULD NOT FAIL DSA SIGNUP
        // (LOGGED so notification-insert failures are
        // visible instead of silently disappearing)
        // ----------------------------------------------
        console.error("NOTIFICATION / EMAIL ERROR:", emailError);
      }
      // ==================================================
      // SOCKET.IO EVENT
      // ==================================================

      const io = req.app.get("io");

      // Admin dashboard refresh
      io.to("admin").emit("dashboardUpdated", {
        type: "dsaSignupRequest",
        requestId,
      });

      // Corporate dashboard refresh
      io.to("corporate").emit("dashboardUpdated", {
        type: "dsaSignupRequest",
        requestId,
      });

      // Live notification
      io.to("admin").emit("newNotification", {
        type: "DSA_SIGNUP_REQUEST",
        requestId,
      });

      io.to("corporate").emit("newNotification", {
        type: "DSA_SIGNUP_REQUEST",
        requestId,
      });
      // ==================================================
      // 12. SUCCESS RESPONSE
      // ==================================================

      return res.status(201).json({
        status: true,

        message:
          "DSA signup request submitted successfully. Waiting for Corporate DSA verification.",

        data: {
          request_id: requestId,
          status: "PENDING",
        },
      });
    } catch (error) {
      return res.status(500).json({
        status: false,
        message: "Something went wrong while submitting DSA signup request",
        error: error.message,
      });
    }
  },
);

// ======================================================
// GET ALL PENDING DSA REQUESTS
//
// GET /api/dsa/corporate/requests
// ======================================================

router.get(
  "/corporate/requests",
  authenticateAndAuthorize(),
  async (req, res) => {
    try {
      // ==============================================
      // 1. GET ALL PENDING REQUESTS
      // ==============================================

      const sql = `
        SELECT
          r.id,
          r.name,
          r.email,
          r.mobile,
          r.status,
          r.created_at,

          r.company_name AS request_company_name,
          r.location AS request_location,

          c.company_name,
          l.location_name

        FROM dsa_signup_requests r

        LEFT JOIN companies c
          ON r.company_id = c.id

        LEFT JOIN locations l
          ON r.location_id = l.id

        WHERE r.status = 'PENDING'

        ORDER BY r.id DESC
      `;

      const requests = await query(sql);

      if (requests.length === 0) {
        return res.json({
          status: true,
          count: 0,
          data: [],
        });
      }

      // ==============================================
      // 2. GET DOCUMENTS FOR ALL REQUESTS IN ONE QUERY
      // ==============================================

      const requestIds = requests.map((r) => r.id);

      const documentSql = `
        SELECT
          id,
          request_id,
          document_type,
          original_name,
          secure_url,
          resource_type,
          file_format,
          file_size,
          created_at

        FROM dsa_signup_documents

        WHERE request_id IN (?)

        ORDER BY id ASC
      `;

      const documents = await query(documentSql, [requestIds]);

      // ==============================================
      // 3. MAP DOCUMENTS TO THEIR RESPECTIVE REQUEST
      // ==============================================

      const result = requests.map((request) => ({
        ...request,
        documents: documents.filter(
          (document) => document.request_id === request.id,
        ),
      }));

      return res.json({
        status: true,
        count: result.length,
        data: result,
      });
    } catch (error) {
      return res.status(500).json({
        status: false,
        message: "Database error",
      });
    }
  },
);

// ======================================================
// GET SINGLE DSA REQUEST
//
// GET /api/dsa/corporate/request/:id
// ======================================================

router.get(
  "/corporate/request/:id",
  authenticateAndAuthorize(),
  async (req, res) => {
    try {
      const { id } = req.params;

      // ==============================================
      // REQUEST DETAILS
      // ==============================================

      const requestSql = `
        SELECT
          r.*,

          c.company_name AS master_company_name,
          l.location_name AS master_location_name

        FROM dsa_signup_requests r

        LEFT JOIN companies c
          ON r.company_id = c.id

        LEFT JOIN locations l
          ON r.location_id = l.id

        WHERE r.id = ?
      `;

      const requestResult = await query(requestSql, [id]);

      if (requestResult.length === 0) {
        return res.status(404).json({
          status: false,
          message: "DSA signup request not found",
        });
      }

      // ==============================================
      // DOCUMENTS
      // ==============================================

      const documentSql = `
        SELECT
          id,
          request_id,
          document_type,
          original_name,
          secure_url,
          resource_type,
          file_format,
          file_size,
          created_at

        FROM dsa_signup_documents

        WHERE request_id = ?

        ORDER BY id ASC
      `;

      const documents = await query(documentSql, [id]);

      return res.json({
        status: true,

        data: {
          request: requestResult[0],
          documents,
        },
      });
    } catch (error) {
      return res.status(500).json({
        status: false,
        message: "Database error",
      });
    }
  },
);


// ======================================================
// REJECT DSA REQUEST
//
// PUT /api/corporate/request/:id/reject
//
// Flow:
// 1. Authenticate Corporate DSA / Admin
// 2. Validate reviewer
// 3. Validate rejection reason
// 4. Get DSA signup request
// 5. Check request is PENDING
// 6. Get reviewer details
// 7. Delete Cloudinary documents + DB records
// 8. Update request as REJECTED
// 9. Send rejection email to DSA applicant
// 10. Return success response
// ======================================================

router.put(
  "/corporate/request/:id/reject",
  authenticateAndAuthorize(),
  async (req, res) => {
    try {
      const { id } = req.params;

      const { reviewed_by, rejection_reason } = req.body;

      // ==================================================
      // 1. VALIDATE REVIEWER
      // ==================================================

      if (!reviewed_by) {
        return res.status(400).json({
          status: false,
          message: "reviewed_by is required",
        });
      }

      // ==================================================
      // 2. VALIDATE REJECTION REASON
      // ==================================================

      if (!rejection_reason || rejection_reason.trim().length < 5) {
        return res.status(400).json({
          status: false,
          message: "Rejection reason is required",
        });
      }

      // ==================================================
      // 3. GET DSA SIGNUP REQUEST
      // ==================================================

      const requestSql = `
        SELECT
          id,
          name,
          email,
          mobile,
          status
        FROM dsa_signup_requests
        WHERE id = ?
      `;

      const requestResult = await query(requestSql, [id]);

      // ==================================================
      // REQUEST NOT FOUND
      // ==================================================

      if (requestResult.length === 0) {
        return res.status(404).json({
          status: false,
          message: "DSA request not found",
        });
      }

      const request = requestResult[0];

      // ==================================================
      // 4. ONLY PENDING REQUEST CAN BE REJECTED
      // ==================================================

      if (request.status !== "PENDING") {
        return res.status(400).json({
          status: false,
          message: `Request is already ${request.status}`,
        });
      }

      // ==================================================
      // 5. GET REVIEWER / CORPORATE DSA DETAILS
      // ==================================================

      const reviewerSql = `
        SELECT
          id,
          name,
          email,
          role,
          status
        FROM users
        WHERE id = ?
      `;

      const reviewerResult = await query(reviewerSql, [reviewed_by]);

      // ==================================================
      // REVIEWER NOT FOUND
      // ==================================================

      if (reviewerResult.length === 0) {
        return res.status(400).json({
          status: false,
          message: "Invalid Corporate DSA reviewer",
        });
      }

      const reviewer = reviewerResult[0];

      // ==================================================
      // CHECK REVIEWER ACTIVE
      // ==================================================

      if (reviewer.status !== "Active") {
        return res.status(403).json({
          status: false,
          message: "Corporate DSA reviewer account is inactive",
        });
      }

      // ==================================================
      // 7. GET SIGNUP DOCUMENTS
      // ==================================================

      const documents = await query(
        `
          SELECT
            id,
            cloudinary_public_id,
            resource_type
          FROM dsa_signup_documents
          WHERE request_id = ?
        `,
        [id],
      );

      // ==================================================
      // 8. DELETE DOCUMENTS FROM CLOUDINARY
      // ==================================================

      for (const document of documents) {
        if (!document.cloudinary_public_id) {
          continue;
        }

        await deleteFromCloudinary(
          document.cloudinary_public_id,
          document.resource_type,
        );
      }

      // ==================================================
      // DELETE DOCUMENT RECORDS FROM DATABASE
      // ==================================================

      await query(
        `
          DELETE FROM dsa_signup_documents
          WHERE request_id = ?
        `,
        [id],
      );

      // ==================================================
      // 6. UPDATE REQUEST
      // ==================================================

      const updateSql = `
        UPDATE dsa_signup_requests
        SET
          status = 'REJECTED',
          rejection_reason = ?,
          reviewed_by = ?,
          reviewed_at = NOW()
        WHERE id = ?
        AND status = 'PENDING'
      `;

      const updateResult = await query(updateSql, [
        rejection_reason.trim(),
        reviewed_by,
        id,
      ]);

      // ==================================================
      // CHECK UPDATE
      // ==================================================

      if (updateResult.affectedRows === 0) {
        return res.status(400).json({
          status: false,
          message: "Request could not be rejected",
        });
      }

      // ==================================================
      // 8. SEND REJECTION EMAIL TO DSA APPLICANT
      // ==================================================

      let emailSent = false;
      let emailMessageId = null;
      let emailError = null;

      try {
        const emailResult = await sendEmail({
          to: request.email,
          toName: request.name,

          subject: `LentFin DSA Request Rejected #${request.id}`,

          htmlContent: `
            <!DOCTYPE html>

            <html>

            <head>
              <meta charset="UTF-8">

              <title>
                DSA Request Rejected
              </title>
            </head>

            <body
              style="
                margin:0;
                padding:0;
                background:#f4f6f8;
                font-family:Arial,Helvetica,sans-serif;
              "
            >

              <div
                style="
                  max-width:650px;
                  margin:30px auto;
                  background:#ffffff;
                  border-radius:12px;
                  padding:35px;
                  box-shadow:0 2px 10px rgba(0,0,0,0.08);
                "
              >

                <h2
                  style="
                    color:#dc2626;
                    margin-top:0;
                  "
                >
                  DSA Registration Request Rejected
                </h2>

                <p>
                  Hello
                  <strong>${request.name}</strong>,
                </p>

                <p>
                  Your DSA registration request has been
                  reviewed by the LentFin Corporate DSA team
                  and has been <strong>REJECTED</strong>.
                </p>

                <hr>

                <h3>
                  Request Details
                </h3>

                <table
                  style="
                    width:100%;
                    border-collapse:collapse;
                  "
                >

                  <tr>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                        font-weight:bold;
                      "
                    >
                      Request ID
                    </td>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                      "
                    >
                      ${request.id}
                    </td>

                  </tr>

                  <tr>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                        font-weight:bold;
                      "
                    >
                      DSA Name
                    </td>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                      "
                    >
                      ${request.name}
                    </td>

                  </tr>

                  <tr>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                        font-weight:bold;
                      "
                    >
                      Registered Email
                    </td>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                      "
                    >
                      ${request.email}
                    </td>

                  </tr>

                  <tr>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                        font-weight:bold;
                      "
                    >
                      Status
                    </td>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                        color:#dc2626;
                        font-weight:bold;
                      "
                    >
                      REJECTED
                    </td>

                  </tr>

                  <tr>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                        font-weight:bold;
                      "
                    >
                      Rejected By
                    </td>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                      "
                    >
                      ${reviewer.name}
                    </td>

                  </tr>

                  <tr>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                        font-weight:bold;
                      "
                    >
                      Reviewer Email
                    </td>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                      "
                    >
                      ${reviewer.email}
                    </td>

                  </tr>

                </table>

                <div
                  style="
                    margin-top:25px;
                    padding:18px;
                    background:#fef2f2;
                    border-left:4px solid #dc2626;
                    border-radius:6px;
                  "
                >

                  <strong>
                    Rejection Reason
                  </strong>

                  <p
                    style="
                      margin-bottom:0;
                      color:#444;
                    "
                  >
                    ${rejection_reason.trim()}
                  </p>

                </div>

                <div
                  style="
                    margin-top:25px;
                    padding:15px;
                    background:#f3f4f6;
                    border-radius:8px;
                  "
                >

                  <strong>
                    What should you do?
                  </strong>

                  <p>
                    Please review the rejection reason above
                    and contact the LentFin support team if
                    you require further clarification.
                  </p>

                </div>

                <hr>

                <p
                  style="
                    color:#666;
                    font-size:14px;
                  "
                >
                  If you believe this rejection was made in
                  error, please contact the LentFin support team.
                </p>

                <p>
                  Regards,
                  <br>
                  <strong>
                    LentFin Team
                  </strong>
                </p>

              </div>

            </body>

            </html>
          `,
        });

        // ==================================================
        // CHECK BREVO RESPONSE
        // ==================================================

        if (emailResult && emailResult.success === true) {
          emailSent = true;

          emailMessageId = emailResult.messageId || null;
        } else {
          emailSent = false;

          emailError = emailResult?.error || "Unknown email sending error";
        }
      } catch (emailSendError) {
        emailSent = false;

        emailError = emailSendError.message;
      }

      // ==================================================
      // SOCKET.IO EVENT
      // ==================================================

      const io = req.app.get("io");

      // Remove pending request from admin/corporate dashboard
      io.to("admin").emit("dashboardUpdated", {
        type: "dsaRequestRejected",
        requestId: request.id,
      });

      io.to("corporate").emit("dashboardUpdated", {
        type: "dsaRequestRejected",
        requestId: request.id,
      });
      // ==================================================
      // 9. FINAL RESPONSE
      // ==================================================

      return res.json({
        status: true,

        message: emailSent
          ? "DSA signup request rejected successfully. Rejection email sent to registered email."
          : "DSA signup request rejected successfully, but rejection email could not be sent.",

        data: {
          request_id: request.id,

          status: "REJECTED",

          rejected_by: {
            id: reviewer.id,
            name: reviewer.name,
            email: reviewer.email,
          },

          rejection_reason: rejection_reason.trim(),

          email_sent: emailSent,

          email_message_id: emailMessageId,

          email_error: emailError,
        },
      });
    } catch (error) {
      return res.status(500).json({
        status: false,
        message: "DSA rejection failed",
        error: error.message,
      });
    }
  },
);
// ======================================================
// VERIFY DSA REQUEST
//
// PUT /api/dsa/corporate/request/:id/verify
//
// Creates final dsa_users account
// Copies signup documents to dsa_documents
// Sends login credentials to DSA email
// ======================================================

router.put(
  "/corporate/request/:id/verify",
  authenticateAndAuthorize(),
  async (req, res) => {
    let connection = null;

    try {
      const { id } = req.params;
      const { verified_by } = req.body;

      // ==================================================
      // 1. VALIDATE VERIFIED BY
      // ==================================================

      if (!verified_by) {
        return res.status(400).json({
          status: false,
          message: "verified_by is required",
        });
      }

      // ==================================================
      // 2. GET DSA SIGNUP REQUEST
      // ==================================================

      const requestSql = `
        SELECT *
        FROM dsa_signup_requests
        WHERE id = ?
      `;

      const requestResult = await query(requestSql, [id]);

      if (requestResult.length === 0) {
        return res.status(404).json({
          status: false,
          message: "DSA signup request not found",
        });
      }

      const request = requestResult[0];

      // ==================================================
      // 3. ONLY PENDING REQUEST CAN BE VERIFIED
      // ==================================================

      if (request.status !== "PENDING") {
        return res.status(400).json({
          status: false,
          message: `Request is already ${request.status}`,
        });
      }

      // ==================================================
      // 4. CHECK CORPORATE DSA / ADMIN
      // ==================================================

      const reviewerSql = `
        SELECT
          id,
          name,
          email,
          role,
          status
        FROM users
        WHERE id = ?
      `;

      const reviewer = await query(reviewerSql, [verified_by]);

      if (reviewer.length === 0) {
        return res.status(400).json({
          status: false,
          message: "Invalid Corporate DSA",
        });
      }

      if (reviewer[0].status !== "Active") {
        return res.status(403).json({
          status: false,
          message: "Corporate DSA account is inactive",
        });
      }

      // ==================================================
      // 5. GENERATE DSA CODE
      // ==================================================

      const dsaCode = `DSA-${String(id).padStart(5, "0")}`;

      // ==================================================
      // 6. GENERATE TEMPORARY PASSWORD
      // ==================================================

      const temporaryPassword = `Dsa@${Date.now().toString().slice(-6)}`;

      // ==================================================
      // 7. HASH PASSWORD
      // ==================================================

      const hashedPassword = await bcrypt.hash(temporaryPassword, 12);

      // ==================================================
      // 8. GET MYSQL CONNECTION
      // ==================================================

      connection = await new Promise((resolve, reject) => {
        db.getConnection((err, conn) => {
          if (err) {
            return reject(err);
          }

          resolve(conn);
        });
      });

      // ==================================================
      // 9. START TRANSACTION
      // ==================================================

      await new Promise((resolve, reject) => {
        connection.beginTransaction((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      // ==================================================
      // 10. INSERT FINAL DSA USER
      // ==================================================

      const insertDsaSql = `
        INSERT INTO dsa_users (
          source_request_id,
          dsa_code,
          company_id,
          company_name,
          location_id,
              location,
          name,
          email,
          mobile,
          password,
          pan_number,
          aadhaar_number,
          gst_number,
          constitution_type,
          account_holder_name,
          account_number,
          ifsc_code,
          role,
          status,
          must_change_password,
          verified_by,
          verified_at
        )
        VALUES (
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          'DSA',
          'Active',
          1,
          ?,
          NOW()
        )
      `;

      const insertDsaValues = [
        id,
        dsaCode,

        request.company_id,
        request.company_name,
        request.location_id,
        request.location,
        request.name,
        request.email,
        request.mobile,

        hashedPassword,

        request.pan_number,
        request.aadhaar_number,
        request.gst_number,

        request.constitution_type,

        request.account_holder_name,
        request.account_number,
        request.ifsc_code,

        verified_by,
      ];

      const dsaResult = await new Promise((resolve, reject) => {
        connection.query(insertDsaSql, insertDsaValues, (err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        });
      });

      const dsaId = dsaResult.insertId;

      // ==================================================
      // 11. GET SIGNUP DOCUMENTS
      // ==================================================

      const documents = await query(
        `
          SELECT
            id,
            document_type,
            original_name,
            cloudinary_public_id,
            cloudinary_url,
            secure_url,
            resource_type,
            file_format,
            file_size
          FROM dsa_signup_documents
          WHERE request_id = ?
        `,
        [id],
      );

      // ==================================================
      // 12. COPY DOCUMENTS TO FINAL DSA DOCUMENT TABLE
      // (Cloudinary files are KEPT — not deleted — because
      // dsa_documents still references the same public_id)
      // ==================================================

      for (const document of documents) {
        const documentInsertSql = `
          INSERT INTO dsa_documents (
            dsa_id,
            document_type,
            original_name,
            cloudinary_public_id,
            cloudinary_url,
            secure_url,
            resource_type,
            file_format,
            file_size
          )
          VALUES (
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?
          )
        `;

        await new Promise((resolve, reject) => {
          connection.query(
            documentInsertSql,
            [
              dsaId,
              document.document_type,
              document.original_name,
              document.cloudinary_public_id,
              document.cloudinary_url,
              document.secure_url,
              document.resource_type,
              document.file_format,
              document.file_size,
            ],
            (err, result) => {
              if (err) {
                reject(err);
              } else {
                resolve(result);
              }
            },
          );
        });
      }

      // ==================================================
      // 13. UPDATE SIGNUP REQUEST
      // ==================================================

      await new Promise((resolve, reject) => {
        connection.query(
          `
            UPDATE dsa_signup_requests
            SET
              status = 'VERIFIED',
              reviewed_by = ?,
              reviewed_at = NOW()
            WHERE id = ?
            AND status = 'PENDING'
          `,
          [verified_by, id],
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          },
        );
      });

      // ==================================================
      // 14. INSERT AUDIT LOG
      // ==================================================

      await new Promise((resolve, reject) => {
        connection.query(
          `
            INSERT INTO dsa_audit_logs (
              dsa_id,
              request_id,
              action,
              performed_by,
              performed_role,
              remarks
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `,
          [
            dsaId,
            id,
            "DSA_VERIFIED",
            verified_by,
            "Corporate DSA",
            "DSA verified and account created",
          ],
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          },
        );
      });

      // ==================================================
      // 15. COMMIT TRANSACTION
      // ==================================================

      await new Promise((resolve, reject) => {
        connection.commit((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      // ==================================================
      // 16. RELEASE CONNECTION
      // ==================================================

      connection.release();
      connection = null;

      // ==================================================
      // 17. SEND LOGIN CREDENTIALS EMAIL
      // ==================================================

      let emailSent = false;
      let emailMessageId = null;
      let emailError = null;

      try {
        const emailResult = await sendEmail({
          to: request.email,
          toName: request.name,

          subject: "LentFin DSA Account Verified",

          htmlContent: `
            <!DOCTYPE html>

            <html>

            <head>
              <meta charset="UTF-8">
              <title>LentFin DSA Account Verified</title>
            </head>

            <body
              style="
                margin:0;
                padding:0;
                background:#f4f6f8;
                font-family:Arial,Helvetica,sans-serif;
              "
            >

              <div
                style="
                  max-width:650px;
                  margin:30px auto;
                  background:#ffffff;
                  border-radius:12px;
                  padding:35px;
                  box-shadow:0 2px 10px rgba(0,0,0,0.08);
                "
              >

                <h2 style="color:#222;">
                  DSA Account Verified Successfully
                </h2>

                <p>
                  Hello
                  <strong>${request.name}</strong>,
                </p>

                <p>
                  Your DSA registration request has been successfully
                  verified by the LentFin Corporate DSA team.
                </p>

                <hr>

                <h3>
                  Your Login Credentials
                </h3>

                <table
                  style="
                    width:100%;
                    border-collapse:collapse;
                  "
                >

                  <tr>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                        font-weight:bold;
                      "
                    >
                      DSA Code
                    </td>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                      "
                    >
                      ${dsaCode}
                    </td>

                  </tr>


                  <tr>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                        font-weight:bold;
                      "
                    >
                      Login Email
                    </td>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                      "
                    >
                      ${request.email}
                    </td>

                  </tr>


                  <tr>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                        font-weight:bold;
                      "
                    >
                      Temporary Password
                    </td>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                      "
                    >
                      <strong>
                        ${temporaryPassword}
                      </strong>
                    </td>

                  </tr>


                  <tr>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                        font-weight:bold;
                      "
                    >
                      Account Status
                    </td>

                    <td
                      style="
                        padding:12px;
                        border:1px solid #eeeeee;
                        color:#16a34a;
                        font-weight:bold;
                      "
                    >
                      ACTIVE
                    </td>

                  </tr>

                </table>


                <div
                  style="
                    margin-top:25px;
                    padding:15px;
                    background:#fff7ed;
                    border-left:4px solid #f97316;
                    border-radius:6px;
                  "
                >

                  <strong>
                    Important:
                  </strong>

                  <p>
                    This is a temporary password.
                    Please login and change your password
                    immediately after your first login.
                  </p>

                </div>


                <div
                  style="
                    margin-top:25px;
                    padding:15px;
                    background:#f3f4f6;
                    border-radius:8px;
                  "
                >

                  <strong>
                    Login Details
                  </strong>

                  <p>
                    Use your registered email address and
                    temporary password to login to the
                    LentFin DSA portal.
                  </p>

                </div>


                <hr>

                <p
                  style="
                    color:#666;
                    font-size:14px;
                  "
                >
                  If you did not request this account,
                  please contact the LentFin support team.
                </p>


                <p>
                  Regards,
                  <br>
                  <strong>
                    LentFin Team
                  </strong>
                </p>

              </div>

            </body>

            </html>
          `,
        });

        // ==============================================
        // CHECK BREVO RESPONSE
        // ==============================================

        if (emailResult && emailResult.success === true) {
          emailSent = true;

          emailMessageId = emailResult.messageId || null;
        } else {
          emailSent = false;

          emailError = emailResult?.error || "Unknown email sending error";
        }
      } catch (emailSendError) {
        emailSent = false;

        emailError = emailSendError.message;
      }
      // ==================================================
      // SOCKET.IO EVENT
      // ==================================================

      const io = req.app.get("io");

      // Admin dashboard
      io.to("admin").emit("dashboardUpdated", {
        type: "dsaVerified",
        dsaId,
      });

      // Corporate dashboard
      io.to("corporate").emit("dashboardUpdated", {
        type: "dsaVerified",
        dsaId,
      });

      // New DSA can receive future updates
      io.to(`dsa_${dsaId}`).emit("accountVerified", {
        dsaId,
      });

      // ==================================================
      // 18. SUCCESS RESPONSE
      // ==================================================

      return res.json({
        status: true,

        message: emailSent
          ? "DSA verified successfully. Login credentials sent to registered email."
          : "DSA verified successfully, but credential email could not be sent.",

        data: {
          dsa_id: dsaId,

          dsa_code: dsaCode,

          email: request.email,

          status: "Active",

          email_sent: emailSent,

          email_message_id: emailMessageId,

          email_error: emailError,
        },
      });
    } catch (error) {
      // ==================================================
      // ROLLBACK
      // ==================================================

      if (connection) {
        try {
          await new Promise((resolve) => {
            connection.rollback(() => {
              resolve();
            });
          });
        } catch (rollbackError) {}

        connection.release();

        connection = null;
      }

      // ==================================================
      // DUPLICATE ERROR
      // ==================================================

      if (error.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          status: false,

          message: "DSA already exists with this email, mobile or DSA code",
        });
      }

      return res.status(500).json({
        status: false,

        message: "DSA verification failed",

        error: error.message,
      });
    }
  },
);



// ======================================================
// GET ALL DSA USERS WITH DOCUMENTS
//
// GET /api/dsa/users
//
// Returns:
// 1. dsa_users complete details
// 2. company details
// 3. location details
// 4. bank details
// 5. dsa_documents details
//
// Password is NEVER returned.
// ======================================================

router.get(
  "/users",
  authenticateAndAuthorize(),
  async (req, res) => {
    try {
      // ==================================================
      // 1. GET ALL DSA USERS
      // ==================================================

      const dsaSql = `
        SELECT
          d.id,
          d.source_request_id,
          d.dsa_code,

          d.company_id,
          COALESCE(d.company_name, c.company_name) AS company_name,

          d.location_id,
          COALESCE(d.location, l.location_name) AS location,

          d.name,
          d.email,
          d.mobile,

          d.pan_number,
          d.aadhaar_number,
          d.gst_number,

          d.constitution_type,

          d.account_holder_name,
          d.account_number,
          d.ifsc_code,

          d.role,
          d.status,
          d.must_change_password,

          d.verified_by,
          d.verified_at,

          d.created_at,
          d.updated_at

        FROM dsa_users d

        LEFT JOIN companies c
          ON d.company_id = c.id

        LEFT JOIN locations l
          ON d.location_id = l.id

        WHERE d.role = 'DSA'

        ORDER BY d.id DESC
      `;

      const dsaUsers = await query(dsaSql);


      // ==================================================
      // 2. IF NO DSA FOUND
      // ==================================================

      if (dsaUsers.length === 0) {
        return res.status(200).json({
          status: true,
          count: 0,
          data: [],
        });
      }


      // ==================================================
      // 3. GET ALL DOCUMENTS
      // ==================================================

      const dsaIds = dsaUsers.map((dsa) => dsa.id);

      const placeholders = dsaIds.map(() => "?").join(",");

      const documentSql = `
        SELECT
          id,
          dsa_id,
          document_type,
          original_name,

          cloudinary_public_id,
          cloudinary_url,
          secure_url,

          resource_type,
          file_format,
          file_size,

          created_at

        FROM dsa_documents

        WHERE dsa_id IN (${placeholders})

        ORDER BY id ASC
      `;

      const documents = await query(
        documentSql,
        dsaIds
      );


      // ==================================================
      // 4. MAP DOCUMENTS WITH DSA
      // ==================================================

      const documentsMap = {};

      for (const document of documents) {
        if (!documentsMap[document.dsa_id]) {
          documentsMap[document.dsa_id] = [];
        }

        documentsMap[document.dsa_id].push(document);
      }


      // ==================================================
      // 5. ADD DOCUMENTS TO EACH DSA
      // ==================================================

      const finalData = dsaUsers.map((dsa) => ({
        ...dsa,

        documents: documentsMap[dsa.id] || [],
      }));


      // ==================================================
      // 6. SUCCESS RESPONSE
      // ==================================================

      return res.status(200).json({
        status: true,
        count: finalData.length,
        data: finalData,
      });

    } catch (error) {
      console.error("GET ALL DSA USERS ERROR:", error);

      return res.status(500).json({
        status: false,
        message: "Failed to fetch DSA users",
        error: error.message,
      });
    }
  }
);
// ======================================================
// DSA LOGIN
//
// POST /api/dsa/login
//
// IMPORTANT:
// This endpoint is ONLY for DSA users.
// Admin users from the `users` table cannot login here.
// ======================================================

// router.post("/dsa/login", async (req, res) => {
//   try {
//     const { email, password } = req.body;

//     // ==================================================
//     // STEP 1 - VALIDATE INPUT
//     // ==================================================

//     if (!email || !password) {
//       return res.status(400).json({
//         status: false,
//         message: "Email and password are required",
//       });
//     }

//     // ==================================================
//     // STEP 2 - GET ONLY DSA USER
//     // ==================================================

//     const dsaResult = await query(
//       `
//       SELECT *
//       FROM dsa_users
//       WHERE email = ?
//       AND role = 'DSA'
//       LIMIT 1
//       `,
//       [email]
//     );

//     // ==================================================
//     // STEP 3 - DSA NOT FOUND
//     // ==================================================

//     if (dsaResult.length === 0) {
//       return res.status(401).json({
//         status: false,
//         message: "Invalid DSA credentials",
//       });
//     }

//     const dsa = dsaResult[0];

//     // ==================================================
//     // STEP 4 - CHECK ACCOUNT STATUS
//     // ==================================================

//     if (String(dsa.status).toLowerCase() !== "active") {
//       return res.status(403).json({
//         status: false,
//         message: `Your DSA account is ${dsa.status}`,
//       });
//     }

//     // ==================================================
//     // STEP 5 - VERIFY PASSWORD
//     // ==================================================

//     const passwordMatch = await bcrypt.compare(password, dsa.password);

//     if (!passwordMatch) {
//       return res.status(401).json({
//         status: false,
//         message: "Invalid DSA credentials",
//       });
//     }

//     // ==================================================
//     // STEP 6 - CREATE JWT TOKEN
//     // ==================================================

//     const token = jwt.sign(
//       {
//         id: dsa.id,
//         role: "DSA",
//         username: (dsa.name || "").split(" ")[0],
//       },
//       process.env.JWT_SECRET,
//       {
//         expiresIn: "7h",
//       }
//     );

//     // ==================================================
//     // STEP 7 - SUCCESS RESPONSE
//     // ==================================================

//     return res.status(200).json({
//       status: true,
//       id: dsa.id,
//       role: "DSA",
//       name: dsa.name,
//       username: (dsa.name || "").split(" ")[0],
//       email: dsa.email,
//       token,
//       must_change_password: Boolean(dsa.must_change_password),
//       message: "DSA Login Success",
//     });
//   } catch (error) {
//     console.error("DSA LOGIN ERROR:", error);

//     return res.status(500).json({
//       status: false,
//       message: "Login failed",
//     });
//   }
// });



module.exports = router;