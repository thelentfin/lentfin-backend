const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");

const db = require("../db");
const authenticateAndAuthorize = require("../middleware/authMiddleware");
const uploadToCloudinary = require("../utils/cloudinaryUpload");
const { sendEmail } = require("../utils/brevoEmail");

const requireAuth = authenticateAndAuthorize();

// ======================================================
// MULTER (FIXED)
// ======================================================

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5,
  },

  fileFilter(req, file, cb) {
    console.log("Original Name:", file.originalname);
    console.log("Mime Type:", file.mimetype);

    const allowedMime = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
      "application/octet-stream",
    ];

    const allowedExt = [".jpg", ".jpeg", ".png", ".webp", ".pdf"];

    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedMime.includes(file.mimetype) && allowedExt.includes(ext)) {
      return cb(null, true);
    }

    return cb(
      new Error("Only JPG, JPEG, PNG, WEBP and PDF files are allowed."),
    );
  },
});

// ======================================================
// CREATE SUPPORT TICKET
// POST /api/support-ticket/create
// ======================================================

router.post("/create", requireAuth, (req, res) => {
  upload.array("attachments", 5)(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
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

    const connection = await db.promise().getConnection();

    try {
      await connection.beginTransaction();

      // Only DSA

      if (req.user.role !== "DSA") {
        await connection.rollback();

        return res.status(403).json({
          status: false,
          message: "Only DSA can create support tickets.",
        });
      }

      const dsaId = req.user.id;
      const { case_id, issue_type, description } = req.body;

      // Validation

      if (!case_id || !issue_type || !description) {
        await connection.rollback();

        return res.status(400).json({
          status: false,
          message: "case_id, issue_type and description are required.",
        });
      }

      // Loan Case + DSA Details

      const [caseRows] = await connection.execute(
        `
        SELECT
          lc.id,
          lc.case_number,
          lc.customer_name,
          lc.status,
          lc.dsa_id,

          d.company_id,
          d.name,
          d.email,
          d.mobile

        FROM loan_cases lc
        INNER JOIN dsa_users d
          ON lc.dsa_id=d.id

        WHERE lc.id=?
        LIMIT 1
        `,
        [case_id],
      );

      if (!caseRows.length) {
        await connection.rollback();

        return res.status(404).json({
          status: false,
          message: "Loan case not found.",
        });
      }

      const loanCase = caseRows[0];

      // Ownership

      if (loanCase.dsa_id !== dsaId) {
        await connection.rollback();

        return res.status(403).json({
          status: false,
          message: "You can raise tickets only for your own loan cases.",
        });
      }

      // Loan already rejected

      if (loanCase.status === "REJECTED") {
        await connection.rollback();

        return res.status(400).json({
          status: false,
          message:
            "Support ticket cannot be created because this loan case is already REJECTED.",
        });
      }

      // One ticket per case lifetime

      const [existing] = await connection.execute(
        `
        SELECT
          id,
          ticket_number,
          status
        FROM support_tickets
        WHERE case_id=?
        LIMIT 1
        `,
        [case_id],
      );

      if (existing.length > 0) {
        await connection.rollback();

        return res.status(409).json({
          status: false,
          message: "Support ticket already exists for this case.",
          existing_ticket: existing[0],
        });
      }

      // Create Ticket

      const [insertResult] = await connection.execute(
        `
        INSERT INTO support_tickets
        (
          case_id,
          dsa_id,
          company_id,
          issue_type,
          description,
          status,
          created_by
        )
        VALUES(?,?,?,?,?,'OPEN',?)
        `,
        [case_id, dsaId, loanCase.company_id, issue_type, description, dsaId],
      );

      const ticketId = insertResult.insertId;

      const ticketNumber = `SUP-${new Date()
        .toISOString()
        .slice(0, 10)
        .replace(/-/g, "")}-${String(ticketId).padStart(5, "0")}`;

      await connection.execute(
        `
        UPDATE support_tickets
        SET ticket_number=?
        WHERE id=?
        `,
        [ticketNumber, ticketId],
      );

      // Upload Attachments

      const uploadedFiles = [];

      if (req.files && req.files.length) {
        for (const file of req.files) {
          const uploadResult = await uploadToCloudinary(
            file,
            "support-tickets",
          );

          await connection.execute(
            `
            INSERT INTO support_ticket_attachments
            (
              ticket_id,
              file_name,
              file_url,
              file_type,
              public_id
            )
            VALUES(?,?,?,?,?)
            `,
            [
              ticketId,
              file.originalname,
              uploadResult.secure_url,
              file.mimetype,
              uploadResult.public_id,
            ],
          );

          uploadedFiles.push({
            file_name: file.originalname,
            file_url: uploadResult.secure_url,
            file_type: file.mimetype,
          });
        }
      }

      // Corporate/Admin Email

      const [corporateRows] = await connection.execute(
        `
        SELECT id,name,email
        FROM users
        WHERE role='admin' OR role='Corporate DSA'
        LIMIT 1
        `,
      );

      if (corporateRows.length) {
        const corporate = corporateRows[0];

        await sendEmail({
          to: corporate.email,
          toName: corporate.name,
          subject: `New Support Ticket - ${ticketNumber}`,
          htmlContent: `
          <h2>New Support Ticket</h2>

          <table border="1" cellpadding="8" cellspacing="0">
            <tr><td><b>Ticket</b></td><td>${ticketNumber}</td></tr>
            <tr><td><b>Case</b></td><td>${loanCase.case_number}</td></tr>
            <tr><td><b>Customer</b></td><td>${loanCase.customer_name}</td></tr>
            <tr><td><b>DSA</b></td><td>${loanCase.name}</td></tr>
            <tr><td><b>Email</b></td><td>${loanCase.email}</td></tr>
            <tr><td><b>Mobile</b></td><td>${loanCase.mobile}</td></tr>
            <tr><td><b>Issue</b></td><td>${issue_type}</td></tr>
            <tr><td><b>Description</b></td><td>${description}</td></tr>
          </table>
          `,
        });

        await connection.execute(
          `
          INSERT INTO notifications
          (
            recipient_user_id,
            title,
            message
          )
          VALUES(?,?,?)
          `,
          [
            corporate.id,
            "New Support Ticket",
            `${ticketNumber} created for ${loanCase.case_number}`,
          ],
        );
      }

      await connection.commit();

      // Socket.IO

      const io = req.app.get("io");

      if (io) {
        io.to("corporate").emit("dashboardUpdated", {
          type: "newSupportTicket",
          ticketId,
        });

        io.to(`dsa_${dsaId}`).emit("dashboardUpdated", {
          type: "ticketCreated",
          ticketId,
        });
      }

      return res.status(201).json({
        status: true,
        message: "Support ticket created successfully.",

        data: {
          ticket: {
            ticket_id: ticketId,
            ticket_number: ticketNumber,
            status: "OPEN",
            issue_type,
            description,
            created_at: new Date(),
          },

          loan_case: {
            case_id: loanCase.id,
            case_number: loanCase.case_number,
            customer_name: loanCase.customer_name,
            status: loanCase.status,
          },

          dsa: {
            dsa_id: dsaId,
            name: loanCase.name,
            email: loanCase.email,
            mobile: loanCase.mobile,
            company_id: loanCase.company_id,
          },

          attachments: uploadedFiles,
        },
      });
    } catch (error) {
      await connection.rollback();

      console.error(error);

      return res.status(500).json({
        status: false,
        message: "Failed to create support ticket.",
        error: error.message,
      });
    } finally {
      connection.release();
    }
  });
});

// ======================================================
// DSA MY TICKETS
// GET /api/support-ticket/my-tickets
// ======================================================

router.get("/my-tickets", requireAuth, async (req, res) => {
  try {
    // Only DSA can access
    if (req.user.role !== "DSA") {
      return res.status(403).json({
        status: false,
        message: "Only DSA can view own tickets.",
      });
    }

    const [rows] = await db.promise().execute(
      `
      SELECT
        st.id,
        st.ticket_number,
        st.case_id,
        st.issue_type,
        st.description,
        st.status,
        st.created_at,
        lc.case_number,
        lc.customer_name
      FROM support_tickets st
      INNER JOIN loan_cases lc
        ON st.case_id = lc.id
      WHERE st.dsa_id = ?
      ORDER BY st.created_at DESC
      `,
      [req.user.id]
    );

    return res.status(200).json({
      status: true,
      message: "My support tickets fetched successfully.",
      count: rows.length,
      data: rows,
    });

  } catch (error) {
    console.error("MY TICKETS ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to fetch support tickets.",
      error: error.message,
    });
  }
});

// ======================================================
// CORPORATE / ADMIN ALL TICKETS
// GET /api/support-ticket/all
// ======================================================

router.get("/all", requireAuth, async (req, res) => {
  try {

    // Security Fix
    if (
      req.user.role !== "admin" &&
      req.user.role !== "Corporate DSA"
    ) {
      return res.status(403).json({
        status: false,
        message: "Access denied.",
      });
    }

    const [rows] = await db.promise().query(`
      SELECT
        st.*,
        lc.case_number,
        lc.customer_name,
        d.name AS dsa_name
      FROM support_tickets st
      LEFT JOIN loan_cases lc
        ON st.case_id = lc.id
      LEFT JOIN dsa_users d
        ON st.dsa_id = d.id
      ORDER BY st.created_at DESC
    `);

    return res.status(200).json({
      status: true,
      count: rows.length,
      data: rows,
    });

  } catch (error) {
    console.error("ALL TICKETS ERROR:", error);

    return res.status(500).json({
      status: false,
      message: error.message,
    });
  }
});

// ======================================================
// CLOSE SUPPORT TICKET
// PUT /api/support-ticket/:ticketId/close
// ======================================================

router.put("/:ticketId/close", requireAuth, async (req, res) => {
  const connection = await db.promise().getConnection();

  try {
    const { ticketId } = req.params;
    const { closed_reason } = req.body;

    // Only Corporate DSA / Admin
    if (
      req.user.role !== "admin" &&
      req.user.role !== "Corporate DSA"
    ) {
      return res.status(403).json({
        status: false,
        message: "Only Corporate DSA or Admin can close support ticket.",
      });
    }

    // Validate Ticket ID
    if (!Number.isInteger(Number(ticketId)) || Number(ticketId) <= 0) {
      return res.status(400).json({
        status: false,
        message: "Invalid ticket ID.",
      });
    }

    // Validate Reason
    if (!closed_reason || !closed_reason.trim()) {
      return res.status(400).json({
        status: false,
        message: "closed_reason is required.",
      });
    }

    await connection.beginTransaction();

    // Find Ticket
    const [tickets] = await connection.execute(
      `
      SELECT
        id,
        ticket_number,
        case_id,
        dsa_id,
        status
      FROM support_tickets
      WHERE id = ?
      LIMIT 1
      `,
      [ticketId]
    );

    if (!tickets.length) {
      await connection.rollback();

      return res.status(404).json({
        status: false,
        message: "Support ticket not found.",
      });
    }

    const ticket = tickets[0];

    // Already Closed
    if (ticket.status === "CLOSED") {
      await connection.rollback();

      return res.status(400).json({
        status: false,
        message: "Support ticket is already CLOSED.",
        data: {
          ticket_id: ticket.id,
          ticket_number: ticket.ticket_number,
          status: ticket.status,
        },
      });
    }

    // Close Ticket
    await connection.execute(
      `
      UPDATE support_tickets
      SET
        status = 'CLOSED',
        closed_by = ?,
        closed_reason = ?,
        closed_at = NOW()
      WHERE id = ?
      `,
      [
        req.user.id,
        closed_reason.trim(),
        ticketId,
      ]
    );

    await connection.commit();

    // Socket.IO
    const io = req.app.get("io");

    if (io) {
      io.to("corporate").emit("dashboardUpdated", {
        type: "ticketClosed",
        ticketId: Number(ticketId),
        caseId: ticket.case_id,
      });

      io.to(`dsa_${ticket.dsa_id}`).emit("dashboardUpdated", {
        type: "ticketClosed",
        ticketId: Number(ticketId),
        caseId: ticket.case_id,
      });
    }

    return res.status(200).json({
      status: true,
      message: "Support ticket closed successfully.",
      data: {
        ticket_id: ticket.id,
        ticket_number: ticket.ticket_number,
        case_id: ticket.case_id,
        status: "CLOSED",
        closed_by: req.user.id,
        closed_reason: closed_reason.trim(),
      },
    });

  } catch (error) {
    await connection.rollback();

    console.error("CLOSE SUPPORT TICKET ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to close support ticket.",
      error: error.message,
    });
  } finally {
    connection.release();
  }
});

// ======================================================
// TICKET DETAILS
// GET /api/support-ticket/:ticketId
// ======================================================

router.get("/:ticketId", requireAuth, async (req, res) => {
  try {

    const { ticketId } = req.params;

    // Validate Ticket ID
    if (!Number.isInteger(Number(ticketId)) || Number(ticketId) <= 0) {
      return res.status(400).json({
        status: false,
        message: "Invalid ticket ID.",
      });
    }

    const [ticket] = await db.promise().execute(
      `
      SELECT
        st.*,
        lc.case_number,
        lc.customer_name
      FROM support_tickets st
      LEFT JOIN loan_cases lc
        ON st.case_id = lc.id
      WHERE st.id = ?
      LIMIT 1
      `,
      [ticketId]
    );

    if (ticket.length === 0) {
      return res.status(404).json({
        status: false,
        message: "Ticket not found.",
      });
    }

    // DSA can view only own ticket
    if (
      req.user.role === "DSA" &&
      ticket[0].dsa_id !== req.user.id
    ) {
      return res.status(403).json({
        status: false,
        message: "Access denied.",
      });
    }

    const [attachments] = await db.promise().execute(
      `
      SELECT
        id,
        ticket_id,
        file_name,
        file_url,
        file_type,
        public_id
      FROM support_ticket_attachments
      WHERE ticket_id = ?
      ORDER BY id ASC
      `,
      [ticketId]
    );

    return res.status(200).json({
      status: true,
      data: {
        ...ticket[0],
        attachments,
      },
    });

  } catch (error) {
    console.error("TICKET DETAILS ERROR:", error);

    return res.status(500).json({
      status: false,
      message: error.message,
    });
  }
});

// ======================================================
// EXPORT ROUTER
// ======================================================

module.exports = router;