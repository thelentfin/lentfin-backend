const { z } = require("zod");

// ======================================================
// DATE VALIDATION HELPER
// ======================================================

const isValidDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);

  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

// ======================================================
// PHASE 4 - LOAN DISBURSEMENT VALIDATION
// ======================================================

const loanDisbursementSchema = z.object({
  // ====================================================
  // CASE ID
  // ====================================================

  case_id: z.coerce
    .number({
      required_error: "Case ID is required",
      invalid_type_error: "Case ID must be a number",
    })
    .int("Case ID must be an integer")
    .positive("Case ID must be greater than 0"),

  // ====================================================
  // DISBURSEMENT TYPE
  // ====================================================

  disbursement_type: z.enum(["PART", "FULL"], {
    required_error: "Disbursement type is required",
    invalid_type_error: "Disbursement type must be PART or FULL",
  }),

  // ====================================================
  // DISBURSEMENT AMOUNT
  // ====================================================

  disbursement_amount: z.coerce
    .number({
      required_error: "Disbursement amount is required",
      invalid_type_error: "Disbursement amount must be a valid number",
    })
    .finite("Disbursement amount must be a valid number")
    .positive("Disbursement amount must be greater than 0"),

  // ====================================================
  // DISBURSEMENT DATE
  // ====================================================

  disbursement_date: z
    .string({
      required_error: "Disbursement date is required",
      invalid_type_error: "Disbursement date must be a string",
    })
    .trim()
    .refine(
      isValidDate,
      "Disbursement date must be a valid date in YYYY-MM-DD format",
    ),

  // ====================================================
  // RATE
  // ====================================================

  rate: z.coerce
    .number({
      required_error: "Rate is required",
      invalid_type_error: "Rate must be a valid number",
    })
    .finite("Rate must be a valid number")
    .nonnegative("Rate cannot be negative")
    .max(100, "Rate cannot exceed 100"),

  // ====================================================
  // PF
  // ====================================================

  pf: z.coerce
    .number({
      required_error: "PF is required",
      invalid_type_error: "PF must be a valid number",
    })
    .finite("PF must be a valid number")
    .nonnegative("PF cannot be negative"),

  // ====================================================
  // TENURE
  // ====================================================

  tenure: z.coerce
    .number({
      required_error: "Tenure is required",
      invalid_type_error: "Tenure must be a valid number",
    })
    .int("Tenure must be an integer")
    .positive("Tenure must be greater than 0"),

  // ====================================================
  // INSURANCE AMOUNT
  // ====================================================

  insurance_amount: z.coerce
    .number({
      required_error: "Insurance amount is required",
      invalid_type_error: "Insurance amount must be a valid number",
    })
    .finite("Insurance amount must be a valid number")
    .nonnegative("Insurance amount cannot be negative"),

  // ====================================================
  // CHEQUE HANDOVER DATE
  // OPTIONAL
  // ====================================================

  cheque_handover_date: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || isValidDate(value),
      "Cheque handover date must be a valid date in YYYY-MM-DD format",
    )
    .optional()
    .or(z.literal("")),

  // ====================================================
  // PDD CLEARED
  // ====================================================

  pdd_cleared: z.enum(["YES", "NO"], {
    required_error: "PDD cleared status is required",
    invalid_type_error: "PDD cleared must be YES or NO",
  }),
});

// ======================================================
// VALIDATE PHASE 4 BODY
// ======================================================

const validateLoanDisbursement = (data) => {
  return loanDisbursementSchema.safeParse(data);
};

// ======================================================
// PDD DOCUMENT VALIDATION
// ======================================================

const validatePddDocument = (file) => {
  if (!file) {
    return {
      success: false,
      message: "PDD document is required when PDD is cleared",
    };
  }

  const allowedMimeTypes = ["application/pdf", "image/jpeg", "image/png"];

  if (!allowedMimeTypes.includes(file.mimetype)) {
    return {
      success: false,
      message: "Only PDF, JPG, JPEG and PNG files are allowed",
    };
  }

  const maxFileSize = 5 * 1024 * 1024;

  if (file.size > maxFileSize) {
    return {
      success: false,
      message: "PDD document must not exceed 5 MB",
    };
  }

  return {
    success: true,
  };
};

// ======================================================
// EXPORT
// ======================================================

module.exports = {
  loanDisbursementSchema,
  validateLoanDisbursement,
  validatePddDocument,
};
