const express = require("express");
const router = express.Router();

const db = require("../db");
const authenticateAndAuthorize = require("../middleware/authMiddleware");

// ======================================================
// AUTH
// (any logged-in role can access - change if needed)
// ======================================================

const requireAuth = authenticateAndAuthorize();

// ======================================================
// 1. ADD SM & ASM DETAILS FOR A LOAN CASE
// POST /api/loan-case-sm-asm/add
//
// Body:
// {
//   "case_id": 1,
//   "sm_name": "Ravi Shah",
//   "sm_mobile_number": "9876543210",
//   "sm_email": "ravi@example.com",
//   "asm_name": "Amit Patel",
//   "asm_mobile_number": "9876500000",
//   "asm_email": "amit@example.com"
// }
// ======================================================

router.post("/add", requireAuth, async (req, res) => {
  try {
    const {
      case_id,
      sm_name,
      sm_mobile_number,
      sm_email,
      asm_name,
      asm_mobile_number,
      asm_email,
    } = req.body;

    // ==================================================
    // VALIDATION
    // ==================================================

    if (!case_id) {
      return res.status(400).json({
        status: false,
        message: "case_id is required.",
      });
    }

    if (
      !sm_name ||
      !sm_name.trim() ||
      !sm_mobile_number ||
      !sm_mobile_number.trim()
    ) {
      return res.status(400).json({
        status: false,
        message: "SM name and mobile number are required.",
      });
    }

    if (
      !asm_name ||
      !asm_name.trim() ||
      !asm_mobile_number ||
      !asm_mobile_number.trim()
    ) {
      return res.status(400).json({
        status: false,
        message: "ASM name and mobile number are required.",
      });
    }

    // ==================================================
    // CHECK LOAN CASE EXISTS
    // ==================================================

    const [existingCase] = await db.promise().execute(
      `
      SELECT id
      FROM loan_cases
      WHERE id = ?
      LIMIT 1
      `,
      [case_id],
    );

    if (existingCase.length === 0) {
      return res.status(404).json({
        status: false,
        message: "Loan case not found.",
      });
    }

    // ==================================================
    // CHECK IF SM/ASM ALREADY ADDED FOR THIS CASE
    // ==================================================

    const [existingDetails] = await db.promise().execute(
      `
      SELECT id
      FROM loan_case_sm_asm_details
      WHERE case_id = ?
      LIMIT 1
      `,
      [case_id],
    );

    if (existingDetails.length > 0) {
      return res.status(409).json({
        status: false,
        message: "SM and ASM details already added for this loan case.",
      });
    }

    // ==================================================
    // INSERT SM
    // ==================================================

    await db.promise().execute(
      `
      INSERT INTO loan_case_sm_asm_details
      (case_id, role, name, mobile_number, email)
      VALUES (?, 'SM', ?, ?, ?)
      `,
      [
        case_id,
        sm_name.trim(),
        sm_mobile_number.trim(),
        sm_email ? sm_email.trim() : null,
      ],
    );

    // ==================================================
    // INSERT ASM
    // ==================================================

    await db.promise().execute(
      `
      INSERT INTO loan_case_sm_asm_details
      (case_id, role, name, mobile_number, email)
      VALUES (?, 'ASM', ?, ?, ?)
      `,
      [
        case_id,
        asm_name.trim(),
        asm_mobile_number.trim(),
        asm_email ? asm_email.trim() : null,
      ],
    );

    // ==================================================
    // GET INSERTED RECORDS
    // ==================================================

    const [newDetails] = await db.promise().execute(
      `
      SELECT
        id,
        case_id,
        role,
        name,
        mobile_number,
        email,
        created_at,
        updated_at
      FROM loan_case_sm_asm_details
      WHERE case_id = ?
      ORDER BY id ASC
      `,
      [case_id],
    );

    return res.status(201).json({
      status: true,
      message: "SM and ASM details added successfully.",
      data: newDetails,
    });
  } catch (error) {
    console.error("ADD SM ASM ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to add SM and ASM details.",
      error: error.message,
    });
  }
});

// ======================================================
// 2. GET SM & ASM DETAILS BY CASE ID
// GET /api/loan-case-sm-asm/:case_id
// ======================================================

router.get("/:case_id", requireAuth, async (req, res) => {
  try {
    const { case_id } = req.params;

    // ==================================================
    // VALIDATE CASE ID
    // ==================================================

    if (!Number.isInteger(Number(case_id)) || Number(case_id) <= 0) {
      return res.status(400).json({
        status: false,
        message: "Invalid case ID.",
      });
    }

    // ==================================================
    // GET DETAILS
    // ==================================================

    const [details] = await db.promise().execute(
      `
      SELECT
        id,
        case_id,
        role,
        name,
        mobile_number,
        email,
        created_at,
        updated_at
      FROM loan_case_sm_asm_details
      WHERE case_id = ?
      ORDER BY role ASC
      `,
      [case_id],
    );

    if (details.length === 0) {
      return res.status(404).json({
        status: false,
        message: "No SM/ASM details found for this loan case.",
      });
    }

    return res.status(200).json({
      status: true,
      message: "SM and ASM details fetched successfully.",
      data: details,
    });
  } catch (error) {
    console.error("GET SM ASM ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to fetch SM and ASM details.",
      error: error.message,
    });
  }
});

// ======================================================
// 3. GET ALL SM & ASM DETAILS (ALL CASES)
// GET /api/loan-case-sm-asm/list/all
// ======================================================

router.get("/list/all", requireAuth, async (req, res) => {
  try {
    const [details] = await db.promise().execute(
      `
      SELECT
        id,
        case_id,
        role,
        name,
        mobile_number,
        email,
        created_at,
        updated_at
      FROM loan_case_sm_asm_details
      ORDER BY case_id DESC, role ASC
      `,
    );

    return res.status(200).json({
      status: true,
      message: "SM and ASM details fetched successfully.",
      count: details.length,
      data: details,
    });
  } catch (error) {
    console.error("GET ALL SM ASM ERROR:", error);

    return res.status(500).json({
      status: false,
      message: "Failed to fetch SM and ASM details.",
      error: error.message,
    });
  }
});

module.exports = router;
