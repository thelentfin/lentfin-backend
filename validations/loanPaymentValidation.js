const { z } = require("zod");

// ======================================================
// PHASE 6 - PAYMENT VALIDATION
// ======================================================

// ======================================================
// FIXED PAYMENT OPTIONS
// ======================================================

const PAYMENT_OPTIONS = {
  SPOT_48_HOURS: 0.85,
  AFTER_5_DAYS: 0.9,
};

// ======================================================
// PHASE 6 PAYMENT SCHEMA
// ======================================================

const loanPaymentSchema = z.object({
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
  // PAYMENT OPTION
  // ====================================================

  payment_option: z.enum(["SPOT_48_HOURS", "AFTER_5_DAYS"], {
    required_error: "Payment option is required",
    invalid_type_error: "Payment option must be SPOT_48_HOURS or AFTER_5_DAYS",
  }),
});

// ======================================================
// VALIDATE PHASE 6 BODY
// ======================================================

const validateLoanPayment = (data) => {
  return loanPaymentSchema.safeParse(data);
};

// ======================================================
// GET PAYMENT PERCENTAGE
// ======================================================

const getPaymentPercentage = (paymentOption) => {
  return PAYMENT_OPTIONS[paymentOption] || null;
};

// ======================================================
// CALCULATE PAYMENT AMOUNT
// ======================================================

const calculatePaymentAmount = (loanAmount, paymentPercentage) => {
  const amount = (Number(loanAmount) * Number(paymentPercentage)) / 100;

  return Number(amount.toFixed(2));
};

// ======================================================
// EXPORT
// ======================================================

module.exports = {
  PAYMENT_OPTIONS,
  loanPaymentSchema,
  validateLoanPayment,
  getPaymentPercentage,
  calculatePaymentAmount,
};
