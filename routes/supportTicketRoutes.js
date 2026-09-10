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
// Allowed: JPG, JPEG, PNG, PDF only | Max size: 5MB | Max files: 5
// ======================================================

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 5,
  },

  fileFilter(req, file, cb) {
    console.log("Original Name:", file.originalname);
    console.log("Mime Type:", file.mimetype);

    const allowedMime = ["image/jpeg", "image/png", "application/pdf"];

    const allowedExt = [".jpg", ".jpeg", ".png", ".pdf"];

    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedMime.includes(file.mimetype) && allowedExt.includes(ext)) {
      return cb(null, true);
    }

    return cb(new Error("Only JPG, JPEG, PNG and PDF files are allowed."));
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
      const { case_id, issue_type, description, category } = req.body;

      // Validation

      if (!case_id || !issue_type || !description) {
        await connection.rollback();

        return res.status(400).json({
          status: false,
          message: "case_id, issue_type and description are required.",
        });
      }

      // Category Validation

      const allowedCategories = ["GENERAL_SUPPORT", "CUSTOMER_APPLICATION"];

      if (!category || !allowedCategories.includes(category)) {
        await connection.rollback();

        return res.status(400).json({
          status: false,
          message:
            "Valid category is required. Allowed: GENERAL_SUPPORT or CUSTOMER_APPLICATION.",
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
  category,
  issue_type,
  description,
  status,
  created_by
)
VALUES(?,?,?,?,?,?,'OPEN',?)
        `,
        [
          case_id,
          dsaId,
          loanCase.company_id,
          category,
          issue_type,
          description,
          dsaId,
        ],
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
            <tr><td><b>Category</b></td><td>${category}</td></tr>
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
            category,
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
// ======================================================
// DSA MY TICKETS WITH DOCUMENTS
// GET /api/support-ticket/my-tickets
// ======================================================

router.get("/my-tickets", requireAuth, async (req, res) => {
  try {

    // ==================================================
    // ONLY DSA CAN ACCESS
    // ==================================================

    if (req.user.role !== "DSA") {
      return res.status(403).json({
        status: false,
        message: "Only DSA can view own tickets."
      });
    }

    // ==================================================
    // GET DSA TICKETS
    // ==================================================

    const [rows] = await db.promise().execute(
      `
      SELECT

        st.id,
        st.ticket_number,
        st.case_id,
        st.category,
        st.issue_type,
        st.description,
        st.status,
        st.created_by,
        st.created_at,
        st.updated_at,

        d.id AS dsa_id,
        d.dsa_code,
        d.name AS dsa_name,
        d.email,
        d.mobile,

        c.company_name

      FROM support_tickets st

      INNER JOIN dsa_users d
        ON st.dsa_id = d.id

      LEFT JOIN companies c
        ON d.company_id = c.id

      WHERE st.dsa_id = ?

      ORDER BY st.created_at DESC
      `,
      [req.user.id],
    );

    // ==================================================
    // GET ALL DOCUMENTS
    // ==================================================

    const ticketIds = rows.map(ticket => ticket.id);

    let attachments = [];

    if (ticketIds.length > 0) {

      const [files] = await db.promise().query(
        `
        SELECT

          id,
          ticket_id,
          file_name,
          file_url,
          file_type,
          public_id,
          created_at

        FROM support_ticket_attachments

        WHERE ticket_id IN (?)

        ORDER BY id ASC
        `,
        [ticketIds]
      );

      attachments = files;
    }

    // ==================================================
    // FINAL RESPONSE
    // ==================================================

    const data = rows.map((ticket) => ({
      ticket: {
        id: ticket.id,
        ticket_number: ticket.ticket_number,
        case_id: ticket.case_id,
        category: ticket.category,
        issue_type: ticket.issue_type,
        description: ticket.description,
        status: ticket.status,
        created_by: ticket.created_by,
        created_at: ticket.created_at,
        updated_at: ticket.updated_at,
      },

      dsa: {
        id: ticket.dsa_id,
        dsa_code: ticket.dsa_code,
        name: ticket.dsa_name,
        email: ticket.email,
        mobile: ticket.mobile,
        company_name: ticket.company_name,
      },

      attachments: attachments.filter((file) => file.ticket_id === ticket.id),
    }));

    return res.status(200).json({
      status: true,
      message: "My support tickets fetched successfully.",
      count: data.length,
      data
    });

  } catch (error) {

    console.error("MY TICKETS ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to fetch support tickets.",
      error: error.message
    });

  }

});

router.get("/all", requireAuth, async (req, res) => {
  try {
    // ===========================================
    // ROLE CHECK
    // ===========================================

    if (req.user.role !== "admin" && req.user.role !== "Corporate DSA") {
      return res.status(403).json({
        status: false,
        message: "Access denied.",
      });
    }

    // ===========================================
    // GET ALL TICKETS
    // ===========================================

    const [rows] = await db.promise().query(`
      SELECT

        st.id,
        st.ticket_number,
        st.case_id,
        st.category,
        st.issue_type,
        st.description,
        st.status,
        st.created_by,
        st.closed_by,
        st.closed_reason,
        st.closed_at,
        st.created_at,
        st.updated_at,

        d.id AS dsa_id,
        d.dsa_code,
        d.name AS dsa_name,
        d.email,
        d.mobile,

        c.company_name,

        lc.customer_name,
        lc.bank_id,

        b.bank_name

      FROM support_tickets st

      LEFT JOIN dsa_users d
        ON st.dsa_id = d.id

      LEFT JOIN companies c
        ON d.company_id = c.id

      LEFT JOIN loan_cases lc
        ON st.case_id = lc.id

      LEFT JOIN banks b
        ON lc.bank_id = b.id

      ORDER BY st.created_at DESC
    `);

    // ===========================================
    // GET ALL ATTACHMENTS
    // ===========================================

    const ticketIds = rows.map((ticket) => ticket.id);

    let attachments = [];

    if (ticketIds.length > 0) {
      const [files] = await db.promise().query(
        `
        SELECT

          id,
          ticket_id,
          file_name,
          file_url,
          file_type,
          public_id,
          created_at

        FROM support_ticket_attachments

        WHERE ticket_id IN (?)

        ORDER BY id ASC
      `,
        [ticketIds],
      );

      attachments = files;
    }

    // ===========================================
    // FINAL RESPONSE
    // ===========================================

    const data = rows.map((ticket) => ({
      ticket: {
        id: ticket.id,
        ticket_number: ticket.ticket_number,
        case_id: ticket.case_id,
        category: ticket.category,

        customer_name: ticket.customer_name,
        bank_name: ticket.bank_name,

        issue_type: ticket.issue_type,
        description: ticket.description,
        status: ticket.status,
        created_by: ticket.created_by,
        closed_by: ticket.closed_by,
        closed_reason: ticket.closed_reason,
        closed_at: ticket.closed_at,
        created_at: ticket.created_at,
        updated_at: ticket.updated_at,
      },

      dsa: {
        id: ticket.dsa_id,
        dsa_code: ticket.dsa_code,
        name: ticket.dsa_name,
        email: ticket.email,
        mobile: ticket.mobile,
        company_name: ticket.company_name,
      },

      attachments: attachments.filter((file) => file.ticket_id === ticket.id),
    }));

    return res.status(200).json({
      status: true,
      message: "All support tickets fetched successfully.",
      count: data.length,
      data,
    });
  } catch (error) {
    console.error("ALL TICKETS ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to fetch support tickets.",
      error: error.message,
    });
  }
});
// ======================================================
// DSA GET OWN TICKET BY TICKET ID WITH DOCUMENTS
// GET /api/support-ticket/my-ticket/:ticketId
// ======================================================

router.get("/my-ticket/:ticketId", requireAuth, async (req, res) => {
  try {

    // ==================================================
    // ONLY DSA CAN ACCESS
    // ==================================================

    if (req.user.role !== "DSA") {
      return res.status(403).json({
        status: false,
        message: "Only DSA can access."
      });
    }

    const { ticketId } = req.params;

    // ==================================================
    // VALIDATE TICKET ID
    // ==================================================

    if (!Number.isInteger(Number(ticketId)) || Number(ticketId) <= 0) {
      return res.status(400).json({
        status: false,
        message: "Invalid ticket ID."
      });
    }

    // ==================================================
    // GET PARTICULAR DSA OWN TICKET
    // ==================================================

    const [ticket] = await db.promise().execute(
      `
      SELECT

        st.id,
        st.ticket_number,
        st.case_id,
        st.category,
        st.issue_type,
        st.description,
        st.status,
        st.created_by,
        st.closed_by,
        st.closed_reason,
        st.closed_at,
        st.created_at,
        st.updated_at,

        d.id AS dsa_id,
        d.dsa_code,
        d.name AS dsa_name,
        d.email,
        d.mobile,

        c.company_name

      FROM support_tickets st

      INNER JOIN dsa_users d
        ON st.dsa_id = d.id

      LEFT JOIN companies c
        ON d.company_id = c.id

      WHERE st.id = ?
        AND st.dsa_id = ?

      LIMIT 1
      `,
      [ticketId, req.user.id],
    );

    if (!ticket.length) {
      return res.status(404).json({
        status: false,
        message: "Support ticket not found."
      });
    }

    // ==================================================
    // GET TICKET DOCUMENTS
    // ==================================================

    const [attachments] = await db.promise().execute(
      `
      SELECT
        id,
        ticket_id,
        file_name,
        file_url,
        file_type,
        public_id,
        created_at
      FROM support_ticket_attachments
      WHERE ticket_id = ?
      ORDER BY id ASC
      `,
      [ticketId]
    );

    // ==================================================
    // RESPONSE
    // ==================================================

    return res.status(200).json({
      status: true,
      message: "Support ticket fetched successfully.",
      data: {
        ticket: {
          id: ticket[0].id,
          ticket_number: ticket[0].ticket_number,
          case_id: ticket[0].case_id,
          category: ticket[0].category,
          issue_type: ticket[0].issue_type,
          description: ticket[0].description,
          status: ticket[0].status,
          created_by: ticket[0].created_by,
          closed_by: ticket[0].closed_by,
          closed_reason: ticket[0].closed_reason,
          closed_at: ticket[0].closed_at,
          created_at: ticket[0].created_at,
          updated_at: ticket[0].updated_at,
        },

        dsa: {
          id: ticket[0].dsa_id,
          dsa_code: ticket[0].dsa_code,
          name: ticket[0].dsa_name,
          email: ticket[0].email,
          mobile: ticket[0].mobile,
          company_name: ticket[0].company_name,
        },

        attachments,
      },
    });

  } catch (error) {

    console.error("GET TICKET ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to fetch support ticket.",
      error: error.message
    });

  }
});

// ======================================================
// RESOLVE SUPPORT TICKET
// PUT /api/support-ticket/:ticketId/resolve
// ======================================================

router.put("/:ticketId/resolve", requireAuth, async (req, res) => {
  const connection = await db.promise().getConnection();

  try {
    const { ticketId } = req.params;
    const { closed_reason } = req.body;

    // Only Corporate DSA / Admin
    if (req.user.role !== "admin" && req.user.role !== "Corporate DSA") {
      return res.status(403).json({
        status: false,
        message: "Only Corporate DSA or Admin can resolve support ticket.",
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
      [ticketId],
    );

    if (!tickets.length) {
      await connection.rollback();

      return res.status(404).json({
        status: false,
        message: "Support ticket not found.",
      });
    }

    const ticket = tickets[0];

    // Already Resolved
    if (ticket.status === "RESOLVED") {
      await connection.rollback();

      return res.status(400).json({
        status: false,
        message: "Support ticket is already RESOLVED.",
        data: {
          ticket_id: ticket.id,
          ticket_number: ticket.ticket_number,
          status: ticket.status,
        },
      });
    }

    // Resolve Ticket
    await connection.execute(
      `
      UPDATE support_tickets
      SET
        status = 'RESOLVED',
        closed_by = ?,
        closed_reason = ?,
        closed_at = NOW()
      WHERE id = ?
      `,
      [req.user.id, closed_reason.trim(), ticketId],
    );

    await connection.commit();

    // Socket.IO
    const io = req.app.get("io");

    if (io) {
      io.to("corporate").emit("dashboardUpdated", {
        type: "ticketResolved",
        ticketId: Number(ticketId),
        caseId: ticket.case_id,
      });

      io.to(`dsa_${ticket.dsa_id}`).emit("dashboardUpdated", {
        type: "ticketResolved",
        ticketId: Number(ticketId),
        caseId: ticket.case_id,
      });
    }

    return res.status(200).json({
      status: true,
      message: "Support ticket resolved successfully.",
      data: {
        ticket_id: ticket.id,
        ticket_number: ticket.ticket_number,
        case_id: ticket.case_id,
        status: "RESOLVED",
        resolved_by: req.user.id,
        resolved_reason: closed_reason.trim(),
      },
    });
  } catch (error) {
    await connection.rollback();

    console.error("RESOLVE SUPPORT TICKET ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to resolve support ticket.",
      error: error.message,
    });
  } finally {
    connection.release();
  }
});

module.exports = router;
