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

const dsaUpload = upload.any();
// ======================================================
// DSA SIGNUP
// ======================================================
// IFSC LOOKUP PROXY (Public)
// GET /api/dsa/ifsc/:code or GET /api/ifsc/:code
// ======================================================

router.get(["/dsa/ifsc/:code", "/ifsc/:code"], async (req, res) => {
  try {
    const rawCode = (req.params.code || "").trim().toUpperCase();
    const ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;

    if (!ifscRegex.test(rawCode)) {
      return res.status(400).json({
        success: false,
        message: "Invalid IFSC code format",
      });
    }

    const response = await fetch(`https://ifsc.razorpay.com/${rawCode}`, {
      signal: AbortSignal.timeout(6000),
    });

    if (!response.ok) {
      if (response.status === 404) {
        return res.status(404).json({
          success: false,
          message: "IFSC code not found",
        });
      }
      return res.status(response.status).json({
        success: false,
        message: "Failed to fetch IFSC details",
      });
    }

    const data = await response.json();

    // Intelligent branch name resolution & formatting
    let rawBranch = (data.BRANCH || "").trim();
    const rawCentre = (data.CENTRE || "").trim();
    const rawDist = (data.DISTRICT || "").trim();
    const rawCity = (data.CITY || "").trim();

    // If branch is literally "BRANCH", "MAIN", "MAIN BRANCH" or empty, fallback to CENTRE or DISTRICT
    if (
      !rawBranch ||
      /^branch$/i.test(rawBranch) ||
      /^main$/i.test(rawBranch) ||
      /^main branch$/i.test(rawBranch)
    ) {
      rawBranch = rawCentre || rawDist || rawCity || "Main Branch";
    }

    // Fix merged words without spaces (e.g. ICICI "MUMBAINARIMAN POINT" -> "Mumbai - Nariman Point")
    if (
      rawCentre &&
      rawBranch.toUpperCase().startsWith(rawCentre.toUpperCase())
    ) {
      const charAfter = rawBranch[rawCentre.length];
      if (charAfter && /[A-Za-z]/.test(charAfter)) {
        rawBranch =
          rawCentre + " - " + rawBranch.slice(rawCentre.length).trim();
      }
    }

    // Clean up commas and spaces
    let resolvedBranch = rawBranch
      .replace(/\s*,\s*/g, ", ")
      .replace(/\s+/g, " ")
      .trim();

    // Title Case formatting for elegant display
    if (
      resolvedBranch === resolvedBranch.toUpperCase() &&
      resolvedBranch.length > 2
    ) {
      resolvedBranch = resolvedBranch
        .toLowerCase()
        .split(" ")
        .map((word) => {
          if (!word) return "";
          if (["and", "of", "the", "in", "at"].includes(word)) return word;
          return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join(" ");
    }

    return res.json({
      success: true,
      data: {
        bank: data.BANK || "",
        branch: resolvedBranch || data.BRANCH || "",
        city: data.CITY || "",
        state: data.STATE || "",
        address: data.ADDRESS || "",
        ifsc: data.IFSC || rawCode,
      },
    });
  } catch (error) {
    console.error("IFSC lookup error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Internal error looking up IFSC code",
    });
  }
});
//1st api
// ======================================================
// 1. DSA SIGNUP REQUEST (PUBLIC)
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

      // ==================================================
      // NORMALIZE PARTNERS FROM FORMDATA
      // ==================================================

      let partners = [];

      try {
        const partnerMap = {};

        // ----------------------------------------------
        // 1. Read form-data fields
        // partners[0][name]
        // partners[1][name]
        // partners[2][name]
        // ----------------------------------------------

        Object.keys(req.body).forEach((key) => {
          const match = key.match(/^partners\[(\d+)\]\[(.+)\]$/);

          if (!match) return;

          const index = Number(match[1]);
          const field = match[2];

          if (!partnerMap[index]) {
            partnerMap[index] = {};
          }

          partnerMap[index][field] = req.body[key];
        });

        // ----------------------------------------------
        // 2. Convert object to array
        // ----------------------------------------------

        partners = Object.values(partnerMap).sort(
          (a, b) => Number(a.partner_number) - Number(b.partner_number),
        );

        // ----------------------------------------------
        // 3. Backward compatibility
        // If partners JSON field is used
        // ----------------------------------------------

        if (partners.length === 0 && req.body.partners) {
          if (typeof req.body.partners === "string") {
            partners = JSON.parse(req.body.partners);
          } else if (Array.isArray(req.body.partners)) {
            partners = req.body.partners;
          } else {
            partners = Object.values(req.body.partners);
          }
        }
      } catch (error) {
        console.error("PARTNERS NORMALIZATION ERROR:", error);

        return res.status(400).json({
          status: false,
          message: "Invalid partners data",
        });
      }
      // ==================================================
      // NORMALIZE DIRECTORS FROM FORMDATA
      // ==================================================

      let directors = [];

      try {
        if (req.body.directors) {
          if (typeof req.body.directors === "string") {
            directors = JSON.parse(req.body.directors);
          } else if (Array.isArray(req.body.directors)) {
            directors = req.body.directors;
          } else {
            directors = Object.values(req.body.directors);
          }
        }

        if (directors.length === 0) {
          const directorMap = {};

          Object.keys(req.body).forEach((key) => {
            const match = key.match(/^directors\[(\d+)\]\[(.+)\]$/);

            if (!match) return;

            const index = Number(match[1]);
            const field = match[2];

            if (!directorMap[index]) directorMap[index] = {};

            directorMap[index][field] = req.body[key];
          });

          directors = Object.values(directorMap).sort(
            (a, b) => Number(a.director_number) - Number(b.director_number),
          );
        }
      } catch {
        return res.status(400).json({
          status: false,
          message: "Invalid directors data",
        });
      }

      // ==================================================
      // ZOD VALIDATION
      // ==================================================

      const validation = dsaSignupSchema.safeParse({
        ...req.body,
        partners,
        directors,
      });

      if (!validation.success) {
        return res.status(400).json({
          status: false,
          message: "Validation failed",
          errors: validation.error.flatten().fieldErrors,
        });
      }

      const data = validation.data;
      // ==================================================
      // GENERATE UNIQUE REFERRAL CODE
      // ==================================================

      let referralCode = null;

      const referralBase =
        data.name
          .replace(/[^a-zA-Z0-9]/g, "")
          .toUpperCase()
          .slice(0, 8) || "DSA";

      let referralCodeExists = true;

      while (referralCodeExists) {
        const randomNumber = Math.floor(1000 + Math.random() * 9000);

        referralCode = `${referralBase}${randomNumber}`;

        const referralCheckQuery = `
    SELECT id
    FROM dsa_signup_requests
    WHERE referral_code = ?

    UNION

    SELECT id
    FROM dsa_users
    WHERE referral_code = ?
  `;

        const referralCheckResult = await query(referralCheckQuery, [
          referralCode,
          referralCode,
        ]);

        referralCodeExists = referralCheckResult.length > 0;
      }
      // ==================================================
      // 2. GET FILES
      // ==================================================

      // ==================================================
      // 2. GET FILES (Dynamic Upload)
      // ==================================================

      const uploadedFiles = {};

      // upload.any() array ne object ma convert karse
      (req.files || []).forEach((file) => {
        uploadedFiles[file.fieldname] = file;
      });

      // Helper
      const hasFile = (fieldName) => {
        return !!uploadedFiles[fieldName];
      };
      // ==================================================
      // 3. CONSTITUTION-WISE DOCUMENT VALIDATION
      // ==================================================

      let requiredDocuments = [];

      switch (data.constitution_type) {
        case "Individual":
          requiredDocuments = [
            "photo_file",
            "pan_file",
            "aadhaar_file",
            "bank_file",
          ];
          break;

        case "Proprietorship":
          requiredDocuments = [
            "photo_file",
            "pan_file",
            "aadhaar_file",
            "bank_file",
          ];
          break;

        case "Partnership/LLP":
          requiredDocuments = [
            "bank_file",
            "firm_pan_file",
            "partnership_deed_file",
          ];
          break;

        case "Private Limited":
          requiredDocuments = [
            "photo_file",
            "pan_file",
            "aadhaar_file",
            "bank_file",
            "firm_pan_file",
            "gst_file",
          ];

          break;

        default:
          return res.status(400).json({
            status: false,
            message: "Invalid constitution type",
          });
      }

      const missingDocuments = requiredDocuments.filter(
        (field) => !hasFile(field),
      );
      // ======================================================
      // PRIVATE LIMITED DIRECTOR DOCUMENT VALIDATION
      // PAN + AADHAAR + PASSPORT
      // ======================================================

      if (data.constitution_type === "Private Limited") {
        for (const director of directors) {
          const directorDocuments = [
            `director_${director.director_number}_pan`,
            `director_${director.director_number}_aadhaar`,
            `director_${director.director_number}_passport`,
          ];

          for (const fieldName of directorDocuments) {
            if (!hasFile(fieldName)) {
              missingDocuments.push(fieldName);
            }
          }
        }
      }

      // ======================================================
      // PRIVATE LIMITED
      // INCORPORATION OR MOA OR AOA
      // ======================================================

      if (data.constitution_type === "Private Limited") {
        const hasCompanyDocument =
          hasFile("incorporation_certificate_file") ||
          hasFile("moa_file") ||
          hasFile("aoa_file");

        if (!hasCompanyDocument) {
          missingDocuments.push(
            "incorporation_certificate_file OR moa_file OR aoa_file",
          );
        }
      }

      if (missingDocuments.length > 0) {
        return res.status(400).json({
          status: false,
          message: "Required documents are missing",
          missing: missingDocuments,
        });
      }
      // ==================================================
      // 4. CHECK COMPANY
      // ==================================================

      //   const companyQuery = `
      //   SELECT id
      //   FROM companies
      //   WHERE id = ?
      //   AND status = 'Active'
      // `;

      //   const companyResult = await query(companyQuery, [data.company_id]);

      //   if (companyResult.length === 0) {
      //     return res.status(400).json({
      //       status: false,
      //       message: "Invalid or inactive company",
      //     });
      //   }

      //   // ==================================================
      //   // 5. CHECK LOCATION
      //   // ==================================================

      //   const locationQuery = `
      //   SELECT id
      //   FROM locations
      //   WHERE id = ?
      //   AND company_id = ?
      //   AND status = 'Active'
      // `;

      //   const locationResult = await query(locationQuery, [
      //     data.location_id,
      //     data.company_id,
      //   ]);

      //   if (locationResult.length === 0) {
      //     return res.status(400).json({
      //       status: false,
      //       message: "Invalid location for selected company",
      //     });
      //   }

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
        name,
        firm_name,
    referral_code,
        email,
        mobile,
        pan_number,
        aadhaar_number,
        gst_number,
        constitution_type,
        dsa_location,
          msme_number,
        account_holder_name,
        account_number,
        ifsc_code,
        bank_name,
        branch_name,
        status
      )
      VALUES (
         ?, ?,?,?, ?, ?, ?, ?, ?, ?,?, ?, ?,?, ?, ?, 'PENDING'
      )
    `;

      const requestValues = [
        // data.company_id,
        // data.company_name || null,

        // data.location_id,
        // data.location || null,

        data.name,
        data.firm_name?.trim() || null,

        // ==================================================
        // AUTO-GENERATED REFERRAL CODE
        // ==================================================

        referralCode,
        data.email,
        data.mobile,

        data.pan_number || null,
        data.aadhaar_number || null,
        data.gst_number || null,

        data.constitution_type || null,
        // NEW DSA LOCATION
        data.dsa_location || null,
        // MSME NUMBER
        data.msme_number || null,

        data.account_holder_name || null,
        data.account_number || null,
        data.ifsc_code || null,
        data.bank_name || null,
        data.branch_name || null,
      ];

      const requestResult = await query(insertRequestQuery, requestValues);

      const requestId = requestResult.insertId;
      // ==================================================
      // SAVE DIRECTORS (ONLY FOR PRIVATE LIMITED)
      // ==================================================

      const savedDirectors = [];

      for (const director of directors) {
        const directorResult = await query(
          `
    INSERT INTO dsa_signup_directors
    (
      request_id,
      director_number,
      name,
      email,
      mobile,
      pan_number,
      aadhaar_number
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
          [
            requestId,
            director.director_number,
            director.name,
            director.email || null,
            director.mobile || null,
            director.pan_number || null,
            director.aadhaar_number || null,
          ],
        );

        savedDirectors.push({
          ...director,
          director_id: directorResult.insertId,
        });
      }
      // ======================================================
      // SAVE PRIVATE LIMITED DIRECTOR DOCUMENTS
      // ======================================================

      if (data.constitution_type === "Private Limited") {
        const directorDocumentTypes = [
          {
            suffix: "pan",
            type: "PAN",
          },
          {
            suffix: "aadhaar",
            type: "AADHAAR",
          },
          {
            suffix: "passport",
            type: "PASSPORT",
          },
        ];

        for (const director of savedDirectors) {
          for (const doc of directorDocumentTypes) {
            const fieldName = `director_${director.director_number}_${doc.suffix}`;

            const file = uploadedFiles[fieldName];

            // If document not uploaded, skip

            if (!file) {
              continue;
            }

            // ==================================================
            // UPLOAD TO CLOUDINARY
            // ==================================================

            const cloudinaryResult = await uploadToCloudinary(
              file.buffer,
              file.originalname,
              `lentfin/dsa/signup/directors/${requestId}`,
            );

            // ==================================================
            // FILE FORMAT
            // ==================================================

            const fileFormat =
              cloudinaryResult.format ||
              (file.originalname
                ? file.originalname.split(".").pop().toLowerCase()
                : null) ||
              null;

            // ==================================================
            // SAVE DIRECTOR DOCUMENT
            // ==================================================

            await query(
              `
  INSERT INTO dsa_signup_director_documents
  (
    director_id,
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
                director.director_id,
                doc.type,
                file.originalname,
                cloudinaryResult.public_id,
                cloudinaryResult.url,
                cloudinaryResult.secure_url,
                cloudinaryResult.resource_type,
                fileFormat,
                file.size,
              ],
            );
          }
        }
      }
      // ==================================================
      // 8.1 SAVE PARTNERS (ONLY FOR PARTNERSHIP)
      // ==================================================

      const savedPartners = [];

      if (data.constitution_type === "Partnership/LLP" && partners.length > 0) {
        for (const partner of partners) {
          const partnerResult = await query(
            `INSERT INTO dsa_signup_partners (
        request_id,
        partner_number,
        name,
        email,
        mobile,
        pan_number,
        aadhaar_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              requestId,
              partner.partner_number,
              partner.name,
              partner.email || null,
              partner.mobile || null,
              partner.pan_number || null,
              partner.aadhaar_number || null,
            ],
          );

          savedPartners.push({
            ...partner,
            partner_id: partnerResult.insertId,
          });
        }
        // ==================================================
        // SAVE PARTNER DOCUMENTS
        // ONLY FOR PARTNERSHIP / LLP
        // ==================================================

        if (
          data.constitution_type === "Partnership/LLP" &&
          savedPartners.length > 0
        ) {
          const partnerDocumentMap = {
            photo: "PHOTO",
            pan: "PAN",
            aadhaar: "AADHAAR",
          };

          // ----------------------------------------------
          // LOOP ALL PARTNERS
          // ----------------------------------------------

          for (const partner of savedPartners) {
            // --------------------------------------------
            // LOOP PHOTO / PAN / AADHAAR
            // --------------------------------------------

            for (const [field, documentType] of Object.entries(
              partnerDocumentMap,
            )) {
              const fieldName = `partner_${partner.partner_number}_${field}`;

              const file = uploadedFiles[fieldName];

              // File not uploaded
              if (!file) {
                continue;
              }

              console.log("Uploading partner document:", fieldName);

              // ------------------------------------------
              // UPLOAD TO CLOUDINARY
              // ------------------------------------------

              const uploaded = await uploadToCloudinary(
                file.buffer,
                file.originalname,
                `lentfin/dsa/signup/partners/${requestId}`,
              );

              // ------------------------------------------
              // SAVE DOCUMENT METADATA
              // ------------------------------------------

              await query(
                `INSERT INTO dsa_signup_partner_documents (
          partner_id,
          document_type,
          original_name,
          cloudinary_public_id,
          cloudinary_url,
          secure_url,
          resource_type,
          file_format,
          file_size
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  partner.partner_id,
                  documentType,
                  file.originalname,
                  uploaded.public_id,
                  uploaded.url,
                  uploaded.secure_url,
                  uploaded.resource_type,
                  uploaded.format ||
                    (file.originalname
                      ? file.originalname.split(".").pop().toLowerCase()
                      : null),
                  file.size,
                ],
              );

              console.log(
                `Partner ${partner.partner_number} ${documentType} saved`,
              );
            }
          }
        }
      }

      // ==================================================
      // 9. DOCUMENT TYPE MAP
      // ==================================================

      const documentMap = {
        photo_file: "PHOTO",

        pan_file: "PAN",

        aadhaar_file: "AADHAAR",

        bank_file: "BANK_DOCUMENT",

        firm_pan_file: "FIRM_PAN",

        partnership_deed_file: "PARTNERSHIP_DEED",

        gst_file: "GST",

        udyam_file: "UDYAM",

        incorporation_certificate_file: "INCORPORATION_CERTIFICATE",

        moa_file: "MOA",

        aoa_file: "AOA",
        msme_certificate_file: "MSME_CERTIFICATE",
      };

      // ==================================================
      // 10. UPLOAD DOCUMENTS TO CLOUDINARY
      // ==================================================

      for (const [fieldName, documentType] of Object.entries(documentMap)) {
        if (!uploadedFiles[fieldName]) continue;

        const uploaded = await uploadToCloudinary(
          uploadedFiles[fieldName].buffer,
          uploadedFiles[fieldName].originalname,
          `lentfin/dsa/signup/${requestId}`,
        );

        await query(
          `INSERT INTO dsa_signup_documents (
      request_id,
      document_type,
      original_name,
      cloudinary_public_id,
      cloudinary_url,
      secure_url,
      resource_type,
      file_format,
      file_size
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            requestId,
            documentType,
            uploadedFiles[fieldName].originalname,
            uploaded.public_id,
            uploaded.url,
            uploaded.secure_url,
            uploaded.resource_type,
            uploaded.format,
            uploadedFiles[fieldName].size,
          ],
        );
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
  <strong>Firm Name:</strong>
  ${data.firm_name || "-"}
</p>
<p>
  <strong>Referral Code:</strong>
  ${referralCode}
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
          referral_code: referralCode,
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
           r.firm_name,
  r.referral_code,
          r.email,
          r.mobile,
          r.status,
          r.created_at,
          r.constitution_type,
r.dsa_location,
r.msme_number,
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
           cloudinary_url,
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
      // 2.1 GET ALL PARTNERS FOR PENDING REQUESTS
      // ==============================================

      const partnerSql = `
  SELECT
    id,
    request_id,
    partner_number,
    name,
    email,
    mobile,
    pan_number,
    aadhaar_number,
    created_at
  FROM dsa_signup_partners
  WHERE request_id IN (?)
  ORDER BY partner_number ASC
`;

      let partners = [];

      const partnershipRequestIds = requests
        .filter((r) => r.constitution_type === "Partnership/LLP")
        .map((r) => r.id);

      if (partnershipRequestIds.length > 0) {
        partners = await query(partnerSql, [partnershipRequestIds]);
      }

      // ==============================================
      // 2.2 GET ALL PARTNER DOCUMENTS
      // ==============================================

      const partnerIds = partners.map((p) => p.id);

      let partnerDocuments = [];

      if (partnerIds.length > 0) {
        const partnerDocumentSql = `
    SELECT
      id,
      partner_id,
      document_type,
      original_name,
      secure_url,
       cloudinary_url,
      resource_type,
      file_format,
      file_size,
      created_at
    FROM dsa_signup_partner_documents
    WHERE partner_id IN (?)
    ORDER BY id ASC
  `;

        partnerDocuments = await query(partnerDocumentSql, [partnerIds]);
      }
      // ==============================================
      // 2.3 GET ALL DIRECTORS FOR PRIVATE LIMITED
      // ==============================================

      const privateRequestIds = requests
        .filter((r) => r.constitution_type === "Private Limited")
        .map((r) => r.id);

      let directors = [];

      if (privateRequestIds.length > 0) {
        const directorSql = `
    SELECT
      id,
      request_id,
      director_number,
      name,
      email,
      mobile,
      pan_number,
      aadhaar_number,
      created_at
    FROM dsa_signup_directors
    WHERE request_id IN (?)
    ORDER BY director_number ASC
  `;

        directors = await query(directorSql, [privateRequestIds]);
      }
      // ==============================================
      // 2.4 GET ALL DIRECTOR DOCUMENTS
      // ==============================================

      const directorIds = directors.map((director) => director.id);

      let directorDocuments = [];

      if (directorIds.length > 0) {
        const directorDocumentSql = `
    SELECT
      id,
      director_id,
      document_type,
      original_name,
      cloudinary_url,
      secure_url,
      resource_type,
      file_format,
      file_size,
      created_at
    FROM dsa_signup_director_documents
    WHERE director_id IN (?)
    ORDER BY id ASC
  `;

        directorDocuments = await query(directorDocumentSql, [directorIds]);
      }
      // ==============================================
      // 3. MAP DOCUMENTS & PARTNERS TO REQUEST
      // ==============================================

      const result = requests.map((request) => {
        const requestPartners = partners
          .filter((partner) => partner.request_id === request.id)
          .map((partner) => ({
            ...partner,
            documents: partnerDocuments.filter(
              (doc) => doc.partner_id === partner.id,
            ),
          }));

        return {
          ...request,

          documents: documents.filter(
            (document) => document.request_id === request.id,
          ),

          partners: requestPartners,
          directors: directors
            .filter((director) => director.request_id === request.id)
            .map((director) => ({
              ...director,

              documents: directorDocuments.filter(
                (document) => document.director_id === director.id,
              ),
            })),
        };
      });

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
// GET SINGLE DSA REQUEST DETAILS
//
// GET /api/dsa/corporate/request/:id
// ======================================================

router.get(
  "/corporate/request/:id",
  authenticateAndAuthorize(),
  async (req, res) => {
    try {
      const { id } = req.params;

      // ======================================================
      // 1. REQUEST DETAILS
      // ======================================================

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

      // ======================================================
      // REQUEST NOT FOUND
      // ======================================================

      if (requestResult.length === 0) {
        return res.status(404).json({
          status: false,
          message: "DSA signup request not found",
        });
      }

      const request = requestResult[0];

      // ======================================================
      // 2. MAIN DSA DOCUMENTS
      //
      // Example:
      // PHOTO
      // PAN
      // AADHAAR
      // BANK_DOCUMENT
      // FIRM_PAN
      // UDYAM
      // GST
      // MSME_CERTIFICATE
      // etc.
      // ======================================================

      const documentSql = `
        SELECT
          id,
          request_id,
          document_type,
          original_name,
          cloudinary_url,
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

      // ======================================================
      // 3. PARTNERS
      //
      // ONLY FOR Partnership/LLP
      // ======================================================

      let partners = [];

      if (request.constitution_type === "Partnership/LLP") {
        // ----------------------------------------------------
        // 3.1 GET PARTNER DETAILS
        // ----------------------------------------------------

        const partnerSql = `
          SELECT
            id,
            request_id,
            partner_number,
            name,
            email,
            mobile,
            pan_number,
            aadhaar_number,
            created_at

          FROM dsa_signup_partners

          WHERE request_id = ?

          ORDER BY partner_number ASC
        `;

        partners = await query(partnerSql, [id]);

        // ----------------------------------------------------
        // 3.2 GET DOCUMENTS FOR EACH PARTNER
        // ----------------------------------------------------

        for (const partner of partners) {
          const partnerDocumentSql = `
            SELECT
              id,
              partner_id,
              document_type,
              original_name,
              cloudinary_url,
              secure_url,
              resource_type,
              file_format,
              file_size,
              created_at

            FROM dsa_signup_partner_documents

            WHERE partner_id = ?

            ORDER BY id ASC
          `;

          partner.documents = await query(partnerDocumentSql, [partner.id]);
        }
      }

      // ======================================================
      // 4. DIRECTORS
      //
      // ONLY FOR Private Limited
      // ======================================================

      let directors = [];

      if (request.constitution_type === "Private Limited") {
        // ----------------------------------------------------
        // 4.1 GET DIRECTOR DETAILS
        // ----------------------------------------------------

        const directorSql = `
          SELECT
            id,
            request_id,
            director_number,
            name,
            email,
            mobile,
            pan_number,
            aadhaar_number,
            created_at

          FROM dsa_signup_directors

          WHERE request_id = ?

          ORDER BY director_number ASC
        `;

        directors = await query(directorSql, [id]);

        // ----------------------------------------------------
        // 4.2 GET DOCUMENTS FOR EACH DIRECTOR
        // ----------------------------------------------------

        for (const director of directors) {
          const directorDocumentSql = `
            SELECT
              id,
              director_id,
              document_type,
              original_name,
              cloudinary_url,
              secure_url,
              resource_type,
              file_format,
              file_size,
              created_at

            FROM dsa_signup_director_documents

            WHERE director_id = ?

            ORDER BY id ASC
          `;

          director.documents = await query(directorDocumentSql, [director.id]);
        }
      }

      // ======================================================
      // 5. FINAL RESPONSE
      // ======================================================

      return res.json({
        status: true,

        data: {
          // --------------------------------------------------
          // REQUEST
          // --------------------------------------------------

          request: {
            ...request,

            // These are already coming from r.*
            // but explicitly available:
            dsa_location: request.dsa_location,
            msme_number: request.msme_number,
          },

          // --------------------------------------------------
          // MAIN DOCUMENTS
          // --------------------------------------------------

          documents,

          // --------------------------------------------------
          // PARTNERS
          // --------------------------------------------------

          partners,

          // --------------------------------------------------
          // DIRECTORS
          // --------------------------------------------------

          directors,
        },
      });
    } catch (error) {
      console.error("GET SINGLE DSA REQUEST ERROR:", error);

      return res.status(500).json({
        status: false,
        message: "Database error",
        error: error.message,
      });
    }
  },
);

// ======================================================
// REJECT DSA REQUEST
//
// PUT /api/corporate/request/:id/reject
//
// FLOW:
//
// 1. Authenticate Corporate DSA / Admin
// 2. Validate reviewer
// 3. Validate rejection reason
// 4. Get DSA signup request
// 5. Check request is PENDING
// 6. Get reviewer details
// 7. Delete main DSA documents from Cloudinary
// 8. Delete Partnership/LLP partner documents
// 9. Delete Private Limited director documents
// 10. Delete related DB records
// 11. Update request as REJECTED
// 12. Send rejection email
// 13. Send Socket.IO event
// 14. Return success
//
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
          firm_name,
    referral_code,
          email,
          mobile,
          status,
          constitution_type,
          dsa_location,
          msme_number
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
      // 6. DELETE MAIN DSA DOCUMENTS
      //
      // dsa_signup_documents
      //
      // This includes:
      // PHOTO
      // PAN
      // AADHAAR
      // BANK_DOCUMENT
      // FIRM_PAN
      // UDYAM
      // GST
      // MSME_CERTIFICATE
      // etc.
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
      // DELETE MAIN DOCUMENTS FROM CLOUDINARY
      // ==================================================

      for (const document of documents) {
        if (!document.cloudinary_public_id) {
          continue;
        }

        await deleteFromCloudinary(
          document.cloudinary_public_id,
          document.resource_type || "image",
        );
      }

      // ==================================================
      // 7. PARTNERSHIP / LLP DOCUMENT CLEANUP
      // ==================================================

      if (request.constitution_type === "Partnership/LLP") {
        // ----------------------------------------------
        // GET ALL SIGNUP PARTNERS
        // ----------------------------------------------

        const signupPartners = await query(
          `
            SELECT
              id
            FROM dsa_signup_partners
            WHERE request_id = ?
          `,
          [id],
        );

        // ----------------------------------------------
        // DELETE PARTNER DOCUMENTS FROM CLOUDINARY
        // ----------------------------------------------

        for (const partner of signupPartners) {
          const partnerDocuments = await query(
            `
              SELECT
                cloudinary_public_id,
                resource_type
              FROM dsa_signup_partner_documents
              WHERE partner_id = ?
            `,
            [partner.id],
          );

          for (const document of partnerDocuments) {
            if (!document.cloudinary_public_id) {
              continue;
            }

            await deleteFromCloudinary(
              document.cloudinary_public_id,
              document.resource_type || "image",
            );
          }
        }

        // ----------------------------------------------
        // DELETE PARTNER DOCUMENT DB RECORDS
        // ----------------------------------------------

        if (signupPartners.length > 0) {
          await query(
            `
              DELETE FROM dsa_signup_partner_documents
              WHERE partner_id IN (
                SELECT id
                FROM dsa_signup_partners
                WHERE request_id = ?
              )
            `,
            [id],
          );
        }

        // ----------------------------------------------
        // DELETE PARTNER DETAILS
        // ----------------------------------------------

        await query(
          `
            DELETE FROM dsa_signup_partners
            WHERE request_id = ?
          `,
          [id],
        );
      }

      // ==================================================
      // 8. PRIVATE LIMITED DIRECTOR CLEANUP
      //
      // NEW LOGIC
      //
      // dsa_signup_directors
      //        ↓
      // dsa_signup_director_documents
      //
      // Documents:
      // PAN
      // AADHAAR
      // PASSPORT
      // ==================================================

      if (request.constitution_type === "Private Limited") {
        // ----------------------------------------------
        // GET ALL SIGNUP DIRECTORS
        // ----------------------------------------------

        const signupDirectors = await query(
          `
            SELECT
              id
            FROM dsa_signup_directors
            WHERE request_id = ?
          `,
          [id],
        );

        // ----------------------------------------------
        // DELETE DIRECTOR DOCUMENTS
        // FROM CLOUDINARY
        // ----------------------------------------------

        for (const director of signupDirectors) {
          const directorDocuments = await query(
            `
                SELECT
                  cloudinary_public_id,
                  resource_type
                FROM dsa_signup_director_documents
                WHERE director_id = ?
              `,
            [director.id],
          );

          // --------------------------------------------
          // DELETE EACH DIRECTOR DOCUMENT
          // --------------------------------------------

          for (const document of directorDocuments) {
            if (!document.cloudinary_public_id) {
              continue;
            }

            await deleteFromCloudinary(
              document.cloudinary_public_id,
              document.resource_type || "image",
            );
          }
        }

        // ----------------------------------------------
        // DELETE DIRECTOR DOCUMENT DB RECORDS
        // ----------------------------------------------

        if (signupDirectors.length > 0) {
          await query(
            `
              DELETE FROM dsa_signup_director_documents
              WHERE director_id IN (
                SELECT id
                FROM dsa_signup_directors
                WHERE request_id = ?
              )
            `,
            [id],
          );
        }

        // ----------------------------------------------
        // DELETE DIRECTOR DETAILS
        // ----------------------------------------------

        await query(
          `
            DELETE FROM dsa_signup_directors
            WHERE request_id = ?
          `,
          [id],
        );
      }

      // ==================================================
      // 9. DELETE MAIN DOCUMENT RECORDS FROM DATABASE
      // ==================================================

      await query(
        `
          DELETE FROM dsa_signup_documents
          WHERE request_id = ?
        `,
        [id],
      );

      // ==================================================
      // 10. UPDATE REQUEST AS REJECTED
      //
      // dsa_location / msme_number remain stored
      // because we are only changing status here.
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
      // 11. SEND REJECTION EMAIL
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
                  and has been
                  <strong>REJECTED</strong>.
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
    Firm Name
  </td>

  <td
    style="
      padding:12px;
      border:1px solid #eeeeee;
    "
  >
    ${request.firm_name || "-"}
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
      // 12. SOCKET.IO EVENT
      // ==================================================

      const io = req.app.get("io");

      // ----------------------------------------------
      // ADMIN DASHBOARD
      // ----------------------------------------------

      io.to("admin").emit("dashboardUpdated", {
        type: "dsaRequestRejected",
        requestId: request.id,
      });

      // ----------------------------------------------
      // CORPORATE DASHBOARD
      // ----------------------------------------------

      io.to("corporate").emit("dashboardUpdated", {
        type: "dsaRequestRejected",
        requestId: request.id,
      });

      // ==================================================
      // 13. FINAL RESPONSE
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
      console.error("DSA REJECTION ERROR:", error);

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
// FLOW:
//
// 1. Validate reviewer
// 2. Get signup request
// 3. Check request is PENDING
// 4. Check Corporate DSA/Admin
// 5. Generate DSA code
// 6. Generate temporary password
// 7. Hash temporary password
// 8. VERIFY HASH BEFORE DB INSERT
// 9. Start transaction
// 10. Create DSA user
// 11. VERIFY STORED DB HASH AGAIN
// 12. Copy directors
// 13. Copy director documents
// 14. Copy partners
// 15. Copy partner documents
// 16. Copy main DSA documents
// 17. Update signup request
// 18. Insert audit log
// 19. Commit
// 20. Send login credentials email
// 21. Socket.IO event
// 22. Response
//
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
      // HELPER FOR TRANSACTION QUERIES
      // ==================================================

      const connectionQuery = (sql, params = []) => {
        return new Promise((resolve, reject) => {
          connection.query(sql, params, (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          });
        });
      };

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
        LIMIT 1
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
        LIMIT 1
      `;

      const reviewerResult = await query(reviewerSql, [verified_by]);

      if (reviewerResult.length === 0) {
        return res.status(400).json({
          status: false,
          message: "Invalid Corporate DSA",
        });
      }

      const reviewer = reviewerResult[0];

      if (reviewer.status !== "Active") {
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
      // 8. IMPORTANT PASSWORD SANITY CHECK
      //
      // Verify generated password matches generated hash
      // BEFORE inserting into database.
      // ==================================================

      const generatedPasswordCheck = await bcrypt.compare(
        temporaryPassword,
        hashedPassword,
      );

      if (!generatedPasswordCheck) {
        throw new Error(
          "Generated temporary password does not match generated bcrypt hash",
        );
      }

      console.log("DSA PASSWORD GENERATION CHECK:", {
        hashLength: hashedPassword.length,
        hashPrefix: hashedPassword.substring(0, 4),
        passwordMatch: generatedPasswordCheck,
      });

      // ==================================================
      // 9. GET MYSQL CONNECTION
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
      // 10. START TRANSACTION
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
      // 11. CHECK EMAIL DUPLICATE
      // ==================================================

      const existingDsa = await connectionQuery(
        `
          SELECT
            id,
            email,
            mobile
          FROM dsa_users
          WHERE email = ?
             OR mobile = ?
          LIMIT 1
        `,
        [request.email, request.mobile],
      );

      if (existingDsa.length > 0) {
        const existing = existingDsa[0];

        throw Object.assign(
          new Error("DSA already exists with this email or mobile"),
          {
            code: "ER_DUP_ENTRY",
          },
        );
      }

      // ==================================================
      // 12. INSERT FINAL DSA USER
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
            firm_name,
    referral_code,
          email,
          mobile,
          password,
          pan_number,
          aadhaar_number,
          gst_number,
          constitution_type,
          dsa_location,
          msme_number,
          account_holder_name,
          account_number,
          ifsc_code,
          bank_name,
          branch_name,
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
        request.firm_name || null,
        request.referral_code || null,
        request.email,
        request.mobile,

        // IMPORTANT:
        // Store bcrypt hash, NOT plain password.
        hashedPassword,

        request.pan_number,
        request.aadhaar_number,
        request.gst_number,

        request.constitution_type,

        request.dsa_location,

        request.msme_number,

        request.account_holder_name,
        request.account_number,
        request.ifsc_code,
        request.bank_name || null,
        request.branch_name || null,

        verified_by,
      ];

      const dsaResult = await connectionQuery(insertDsaSql, insertDsaValues);

      const dsaId = dsaResult.insertId;

      // ==================================================
      // 13. CRITICAL PASSWORD VERIFICATION
      //
      // Read password back from DB and compare against
      // temporaryPassword.
      //
      // If this fails:
      // - rollback
      // - no email
      // - no fake login credentials
      // ==================================================

      const storedPasswordResult = await connectionQuery(
        `
            SELECT
              id,
              email,
              password,
              LENGTH(password) AS password_length
            FROM dsa_users
            WHERE id = ?
            LIMIT 1
          `,
        [dsaId],
      );

      if (storedPasswordResult.length === 0) {
        throw new Error(
          "DSA user was created but password record could not be read",
        );
      }

      const storedDsa = storedPasswordResult[0];

      console.log("DSA STORED PASSWORD CHECK:", {
        dsaId: storedDsa.id,
        email: storedDsa.email,
        hashLength: storedDsa.password_length,
        hashPrefix: storedDsa.password
          ? storedDsa.password.substring(0, 4)
          : null,
      });

      // --------------------------------------------------
      // CHECK STORED HASH
      // --------------------------------------------------

      const storedPasswordMatch = await bcrypt.compare(
        temporaryPassword,
        storedDsa.password,
      );

      console.log("DSA FINAL PASSWORD CHECK:", {
        dsaId,
        email: storedDsa.email,
        hashLength: storedDsa.password_length,
        passwordMatch: storedPasswordMatch,
      });

      if (!storedPasswordMatch) {
        throw new Error(
          "CRITICAL: Temporary password does not match password stored in database",
        );
      }

      // ==================================================
      // 14. COPY PRIVATE LIMITED DIRECTORS
      // ==================================================

      if (request.constitution_type === "Private Limited") {
        // ----------------------------------------------
        // GET SIGNUP DIRECTORS
        // ----------------------------------------------

        const signupDirectors = await connectionQuery(
          `
              SELECT
                id,
                director_number,
                name,
                email,
                mobile,
                pan_number,
                aadhaar_number
              FROM dsa_signup_directors
              WHERE request_id = ?
              ORDER BY director_number ASC
            `,
          [id],
        );

        // ----------------------------------------------
        // MAP:
        //
        // signup director ID
        //        ↓
        // final director ID
        // ----------------------------------------------

        const directorIdMap = {};

        // ----------------------------------------------
        // COPY DIRECTOR DETAILS
        // ----------------------------------------------

        for (const director of signupDirectors) {
          const directorResult = await connectionQuery(
            `
                INSERT INTO dsa_directors
                (
                  dsa_id,
                  director_number,
                  name,
                  email,
                  mobile,
                  pan_number,
                  aadhaar_number
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `,
            [
              dsaId,
              director.director_number,
              director.name,
              director.email || null,
              director.mobile || null,
              director.pan_number || null,
              director.aadhaar_number || null,
            ],
          );

          directorIdMap[director.id] = directorResult.insertId;
        }

        // ----------------------------------------------
        // COPY DIRECTOR DOCUMENTS
        // ----------------------------------------------

        for (const director of signupDirectors) {
          const finalDirectorId = directorIdMap[director.id];

          const directorDocuments = await connectionQuery(
            `
                SELECT
                  id,
                  director_id,
                  document_type,
                  original_name,
                  cloudinary_public_id,
                  cloudinary_url,
                  secure_url,
                  resource_type,
                  file_format,
                  file_size
                FROM dsa_signup_director_documents
                WHERE director_id = ?
                ORDER BY id ASC
              `,
            [director.id],
          );

          for (const document of directorDocuments) {
            await connectionQuery(
              `
                INSERT INTO dsa_director_documents
                (
                  director_id,
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
                finalDirectorId,
                document.document_type,
                document.original_name,
                document.cloudinary_public_id,
                document.cloudinary_url,
                document.secure_url,
                document.resource_type,
                document.file_format,
                document.file_size,
              ],
            );
          }
        }
      }

      // ==================================================
      // 15. COPY PARTNERSHIP / LLP PARTNERS
      // ==================================================

      if (request.constitution_type === "Partnership/LLP") {
        const signupPartners = await connectionQuery(
          `
              SELECT *
              FROM dsa_signup_partners
              WHERE request_id = ?
              ORDER BY partner_number ASC
            `,
          [id],
        );

        // ----------------------------------------------
        // MAP:
        //
        // signup partner ID
        //        ↓
        // final partner ID
        // ----------------------------------------------

        const partnerIdMap = {};

        // ----------------------------------------------
        // COPY PARTNER DETAILS
        // ----------------------------------------------

        for (const partner of signupPartners) {
          const partnerResult = await connectionQuery(
            `
                INSERT INTO dsa_partner_details
                (
                  dsa_id,
                  partner_number,
                  name,
                  email,
                  mobile,
                  pan_number,
                  aadhaar_number
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `,
            [
              dsaId,
              partner.partner_number,
              partner.name,
              partner.email || null,
              partner.mobile || null,
              partner.pan_number || null,
              partner.aadhaar_number || null,
            ],
          );

          partnerIdMap[partner.id] = partnerResult.insertId;
        }

        // ----------------------------------------------
        // COPY PARTNER DOCUMENTS
        // ----------------------------------------------

        for (const partner of signupPartners) {
          const partnerDocuments = await connectionQuery(
            `
                SELECT *
                FROM dsa_signup_partner_documents
                WHERE partner_id = ?
                ORDER BY id ASC
              `,
            [partner.id],
          );

          for (const doc of partnerDocuments) {
            await connectionQuery(
              `
                INSERT INTO dsa_partner_documents
                (
                  partner_id,
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
                partnerIdMap[partner.id],
                doc.document_type,
                doc.original_name,
                doc.cloudinary_public_id,
                doc.cloudinary_url,
                doc.secure_url,
                doc.resource_type,
                doc.file_format,
                doc.file_size,
              ],
            );
          }
        }
      }

      // ==================================================
      // 16. GET SIGNUP DOCUMENTS
      // ==================================================

      const documents = await connectionQuery(
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
            ORDER BY id ASC
          `,
        [id],
      );

      // ==================================================
      // 17. COPY MAIN DOCUMENTS
      //
      // Cloudinary file remains unchanged.
      // Same public_id is referenced in dsa_documents.
      //
      // Includes MSME_CERTIFICATE if uploaded.
      // ==================================================

      for (const document of documents) {
        await connectionQuery(
          `
            INSERT INTO dsa_documents
            (
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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
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
        );
      }

      // ==================================================
      // 18. UPDATE SIGNUP REQUEST
      // ==================================================

      const updateRequestResult = await connectionQuery(
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
      );

      if (updateRequestResult.affectedRows !== 1) {
        throw new Error("DSA signup request could not be marked as VERIFIED");
      }

      // ==================================================
      // 19. INSERT AUDIT LOG
      // ==================================================

      await connectionQuery(
        `
          INSERT INTO dsa_audit_logs
          (
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
      );

      // ==================================================
      // 20. COMMIT TRANSACTION
      //
      // IMPORTANT:
      // Password was already tested against DB before
      // reaching this point.
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
      // 21. RELEASE CONNECTION
      // ==================================================

      connection.release();
      connection = null;

      // ==================================================
      // 22. SEND LOGIN CREDENTIALS EMAIL
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
                <title>
                  LentFin DSA Account Verified
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
                    box-shadow:
                      0 2px 10px
                      rgba(0,0,0,0.08);
                  "
                >

                  <h2 style="color:#222;">
                    DSA Account Verified Successfully
                  </h2>

                  <p>
                    Hello
                    <strong>
                      ${request.name}
                    </strong>,
                  </p>

                  <p>
                    Your DSA registration request
                    has been successfully verified
                    by the LentFin Corporate DSA team.
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
  <td style="padding:12px;border:1px solid #eeeeee;font-weight:bold;">
    Referral Code
  </td>

  <td style="padding:12px;border:1px solid #eeeeee;">
    ${request.referral_code || "-"}
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
                      border-left:
                        4px solid #f97316;
                      border-radius:6px;
                    "
                  >

                    <strong>
                      Important:
                    </strong>

                    <p>
                      This is a temporary password.
                      Please login and change your
                      password immediately after your
                      first login.
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
                      Use your registered email address
                      and temporary password to login
                      to the LentFin DSA portal.
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
      // 23. SOCKET.IO EVENT
      // ==================================================

      const io = req.app.get("io");

      // ----------------------------------------------
      // ADMIN
      // ----------------------------------------------

      io.to("admin").emit("dashboardUpdated", {
        type: "dsaVerified",
        dsaId,
      });

      // ----------------------------------------------
      // CORPORATE
      // ----------------------------------------------

      io.to("corporate").emit("dashboardUpdated", {
        type: "dsaVerified",
        dsaId,
      });

      // ----------------------------------------------
      // DSA
      // ----------------------------------------------

      io.to(`dsa_${dsaId}`).emit("accountVerified", {
        dsaId,
      });

      // ==================================================
      // 24. FINAL RESPONSE
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

          must_change_password: true,

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
        } catch (rollbackError) {
          console.error("ROLLBACK ERROR:", rollbackError);
        }

        connection.release();

        connection = null;
      }

      console.error("DSA VERIFICATION ERROR:", error);

      // ==================================================
      // DUPLICATE ERROR
      // ==================================================

      if (error.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          status: false,
          message: "DSA already exists with this email, mobile or DSA code",
        });
      }

      // ==================================================
      // PASSWORD VERIFICATION ERROR
      // ==================================================

      if (
        error.message &&
        error.message.includes("Temporary password does not match")
      ) {
        return res.status(500).json({
          status: false,
          message:
            "DSA account creation stopped because password verification failed.",
        });
      }

      // ==================================================
      // GENERAL ERROR
      // ==================================================

      return res.status(500).json({
        status: false,
        message: "DSA verification failed",
        error: error.message,
      });
    }
  },
);

// ======================================================
// GET ALL VERIFIED DSA USERS
//
// GET /api/dsa/users
// ======================================================

router.get("/users", authenticateAndAuthorize(), async (req, res) => {
  try {
    // ==================================================
    // 1. GET ALL DSA USERS
    // ==================================================

    const dsaSql = `
        SELECT
          d.id,
          d.source_request_id,
          d.dsa_code,

          -- COMPANY
          d.company_id,
          COALESCE(
            d.company_name,
            c.company_name
          ) AS company_name,

          -- LOCATION
          d.location_id,
          COALESCE(
            d.location,
            l.location_name
          ) AS location,

          -- DSA LOCATION
          d.dsa_location,

          -- BASIC DETAILS
          d.name,
          d.firm_name,
d.referral_code,
          d.email,
          d.mobile,

          -- KYC DETAILS
          d.pan_number,
          d.aadhaar_number,
          d.gst_number,

          -- MSME NUMBER
          d.msme_number,

          -- CONSTITUTION
          d.constitution_type,

          -- BANK DETAILS
          d.account_holder_name,
          d.account_number,
          d.ifsc_code,
          d.bank_name,
          d.branch_name,

          -- AUTH / STATUS
          d.role,
          d.status,
          d.must_change_password,

          -- VERIFICATION
          d.verified_by,
          d.verified_at,

          -- TIMESTAMPS
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
    // COMMON DSA IDS
    // ==================================================

    const dsaIds = dsaUsers.map((dsa) => dsa.id);

    const dsaPlaceholders = dsaIds.map(() => "?").join(",");

    // ==================================================
    // 3. GET ALL MAIN DSA DOCUMENTS
    // ==================================================

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

        WHERE dsa_id IN (${dsaPlaceholders})

        ORDER BY id ASC
      `;

    const documents = await query(documentSql, dsaIds);

    // ==================================================
    // 3.1 GET ALL VERIFIED PARTNERS
    // ONLY PARTNERSHIP / LLP
    // ==================================================

    let partnerDetails = [];

    const partnershipDsaIds = dsaUsers
      .filter((dsa) => dsa.constitution_type === "Partnership/LLP")
      .map((dsa) => dsa.id);

    if (partnershipDsaIds.length > 0) {
      const partnershipPlaceholders = partnershipDsaIds
        .map(() => "?")
        .join(",");

      const partnerSql = `
          SELECT
            id,
            dsa_id,
            partner_number,
            name,
            email,
            mobile,
            pan_number,
            aadhaar_number,
            created_at

          FROM dsa_partner_details

          WHERE dsa_id IN (${partnershipPlaceholders})

          ORDER BY dsa_id ASC, partner_number ASC
        `;

      partnerDetails = await query(partnerSql, partnershipDsaIds);
    }

    // ==================================================
    // 3.2 GET ALL PARTNER DOCUMENTS
    // ==================================================

    let partnerDocuments = [];

    const partnerIds = partnerDetails.map((partner) => partner.id);

    if (partnerIds.length > 0) {
      const partnerPlaceholders = partnerIds.map(() => "?").join(",");

      const partnerDocumentSql = `
          SELECT
            id,
            partner_id,
            document_type,
            original_name,

            cloudinary_public_id,
            cloudinary_url,
            secure_url,

            resource_type,
            file_format,
            file_size,

            created_at

          FROM dsa_partner_documents

          WHERE partner_id IN (${partnerPlaceholders})

          ORDER BY id ASC
        `;

      partnerDocuments = await query(partnerDocumentSql, partnerIds);
    }

    // ==================================================
    // 3.3 GET ALL VERIFIED DIRECTORS
    // ONLY PRIVATE LIMITED
    // ==================================================

    let directorDetails = [];

    const privateDsaIds = dsaUsers
      .filter((dsa) => dsa.constitution_type === "Private Limited")
      .map((dsa) => dsa.id);

    if (privateDsaIds.length > 0) {
      const directorPlaceholders = privateDsaIds.map(() => "?").join(",");

      const directorSql = `
          SELECT
            id,
            dsa_id,
            director_number,
            name,
            email,
            mobile,
            pan_number,
            aadhaar_number,
            created_at

          FROM dsa_directors

          WHERE dsa_id IN (${directorPlaceholders})

          ORDER BY dsa_id ASC, director_number ASC
        `;

      directorDetails = await query(directorSql, privateDsaIds);
    }

    // ==================================================
    // 3.4 GET ALL DIRECTOR DOCUMENTS
    //
    // PAN
    // AADHAAR
    // PASSPORT
    // ==================================================

    let directorDocuments = [];

    const directorIds = directorDetails.map((director) => director.id);

    if (directorIds.length > 0) {
      const directorPlaceholders = directorIds.map(() => "?").join(",");

      const directorDocumentSql = `
          SELECT
            id,
            director_id,
            document_type,
            original_name,

            cloudinary_public_id,
            cloudinary_url,
            secure_url,

            resource_type,
            file_format,
            file_size,

            created_at

          FROM dsa_director_documents

          WHERE director_id IN (${directorPlaceholders})

          ORDER BY id ASC
        `;

      directorDocuments = await query(directorDocumentSql, directorIds);
    }

    // ==================================================
    // 4. MAP MAIN DSA DOCUMENTS
    // ==================================================

    const documentsMap = {};

    for (const document of documents) {
      if (!documentsMap[document.dsa_id]) {
        documentsMap[document.dsa_id] = [];
      }

      documentsMap[document.dsa_id].push(document);
    }

    // ==================================================
    // 4.1 MAP PARTNER DOCUMENTS
    // ==================================================

    const partnerDocumentMap = {};

    for (const document of partnerDocuments) {
      if (!partnerDocumentMap[document.partner_id]) {
        partnerDocumentMap[document.partner_id] = [];
      }

      partnerDocumentMap[document.partner_id].push(document);
    }

    // ==================================================
    // 4.2 MAP PARTNERS WITH DSA
    // ==================================================

    const partnersMap = {};

    for (const partner of partnerDetails) {
      // Add partner documents
      partner.documents = partnerDocumentMap[partner.id] || [];

      if (!partnersMap[partner.dsa_id]) {
        partnersMap[partner.dsa_id] = [];
      }

      partnersMap[partner.dsa_id].push(partner);
    }

    // ==================================================
    // 4.3 MAP DIRECTOR DOCUMENTS
    // ==================================================

    const directorDocumentMap = {};

    for (const document of directorDocuments) {
      if (!directorDocumentMap[document.director_id]) {
        directorDocumentMap[document.director_id] = [];
      }

      directorDocumentMap[document.director_id].push(document);
    }

    // ==================================================
    // 4.4 MAP DIRECTORS WITH DSA
    // ==================================================

    const directorsMap = {};

    for (const director of directorDetails) {
      // Add director documents
      director.documents = directorDocumentMap[director.id] || [];

      if (!directorsMap[director.dsa_id]) {
        directorsMap[director.dsa_id] = [];
      }

      directorsMap[director.dsa_id].push(director);
    }

    // ==================================================
    // 5. FINAL DATA
    // ==================================================

    const finalData = dsaUsers.map((dsa) => ({
      ...dsa,

      // ----------------------------------------------
      // MAIN DSA DOCUMENTS
      // ----------------------------------------------

      documents: documentsMap[dsa.id] || [],

      // ----------------------------------------------
      // PARTNERS
      // Partnership/LLP only
      // ----------------------------------------------

      partners: partnersMap[dsa.id] || [],

      // ----------------------------------------------
      // DIRECTORS
      // Private Limited only
      // ----------------------------------------------

      directors: directorsMap[dsa.id] || [],
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
});

module.exports = router;
