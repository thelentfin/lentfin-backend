const { z } = require("zod");

// ======================================================
// LOAN CASE VALIDATION
// ======================================================

const loanCaseSchema = z.object({
  // ====================================================
  // BANK ID
  // ====================================================

  bank_id: z.coerce
    .number({
      required_error: "Bank is required",
      invalid_type_error: "Bank ID must be a number",
    })
    .int("Bank ID must be an integer")
    .positive("Bank is required"),

  // ====================================================
  // CUSTOMER NAME
  // ====================================================

  customer_name: z
    .string({
      required_error: "Customer name is required",
      invalid_type_error: "Customer name must be a string",
    })
    .trim()
    .min(2, "Customer name must be at least 2 characters")
    .max(150, "Customer name cannot exceed 150 characters")
    .regex(
      /^[A-Za-z][A-Za-z .'-]*$/,
      "Customer name can contain only letters, spaces, dot, apostrophe and hyphen",
    ),

  // ====================================================
  // MOBILE NUMBER
  // ====================================================

  mobile_number: z
    .string({
      required_error: "Mobile number is required",
      invalid_type_error: "Mobile number must be a string",
    })
    .trim()
    .regex(
      /^[6-9]\d{9}$/,
      "Mobile number must be a valid 10 digit Indian mobile number",
    ),

  // ====================================================
  // APPLICATION NUMBER
  // OPTIONAL
  // ====================================================

  application_number: z
    .string()
    .trim()
    .max(50, "Application number cannot exceed 50 characters")
    .regex(
      /^[A-Za-z0-9/_-]*$/,
      "Application number can contain only letters, numbers, slash, underscore and hyphen",
    )
    .optional()
    .or(z.literal("")),

  // ====================================================
  // LOAN ACCOUNT NUMBER
  // OPTIONAL
  // ====================================================

  loan_account_number: z
    .string()
    .trim()
    .max(50, "Loan account number cannot exceed 50 characters")
    .regex(
      /^[A-Za-z0-9/_-]*$/,
      "Loan account number can contain only letters, numbers, slash, underscore and hyphen",
    )
    .optional()
    .or(z.literal("")),

  // ====================================================
  // SANCTION AMOUNT
  // ====================================================

  sanction_amount: z.coerce
    .number({
      required_error: "Sanction amount is required",
      invalid_type_error: "Sanction amount must be a valid number",
    })
    .finite("Sanction amount must be a valid number")
    .positive("Sanction amount must be greater than 0"),

  // ====================================================
  // REMARKS
  // OPTIONAL
  // ====================================================

  remarks: z
    .string()
    .trim()
    .max(1000, "Remarks cannot exceed 1000 characters")
    .optional()
    .or(z.literal("")),
});

// ======================================================
// VALIDATE LOAN CASE BODY
// ======================================================

const validateLoanCase = (data) => {
  return loanCaseSchema.safeParse(data);
};

// ======================================================
// SANCTION LETTER FILE VALIDATION
// ======================================================

const validateSanctionLetter = (file) => {
  // ----------------------------------------------------
  // FILE REQUIRED
  // ----------------------------------------------------

  if (!file) {
    return {
      success: false,
      message: "Sanction letter is required",
    };
  }

  // ----------------------------------------------------
  // ALLOWED MIME TYPES
  // ----------------------------------------------------

  const allowedMimeTypes = ["application/pdf", "image/jpeg", "image/png"];

  if (!allowedMimeTypes.includes(file.mimetype)) {
    return {
      success: false,
      message: "Only PDF, JPG, JPEG and PNG files are allowed",
    };
  }

  // ----------------------------------------------------
  // MAXIMUM FILE SIZE
  // ----------------------------------------------------

  const maxFileSize = 5 * 1024 * 1024;

  if (file.size > maxFileSize) {
    return {
      success: false,
      message: "Sanction letter must not exceed 5 MB",
    };
  }

  // ----------------------------------------------------
  // SUCCESS
  // ----------------------------------------------------

  return {
    success: true,
  };
};

// ======================================================
// EXPORT
// ======================================================

module.exports = {
  loanCaseSchema,
  validateLoanCase,
  validateSanctionLetter,
};
