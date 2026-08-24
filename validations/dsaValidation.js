const { z } = require("zod");

// ======================================================
// DSA SIGNUP VALIDATION
// ======================================================

const dsaSignupSchema = z.object({
  // ====================================================
  // COMPANY
  // ====================================================

  company_id: z.coerce.number().int().positive("Company is required"),

  company_name: z
    .string()
    .trim()
    .min(1, "Company name is required")
    .max(200, "Company name cannot exceed 200 characters"),

  // ====================================================
  // LOCATION
  // ====================================================

  location_id: z.coerce.number().int().positive("Location is required"),

  location: z
    .string()
    .trim()
    .min(1, "Location is required")
    .max(150, "Location cannot exceed 150 characters"),

  // ====================================================
  // NAME
  // ====================================================

  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(150, "Name cannot exceed 150 characters"),

  // ====================================================
  // EMAIL
  // ====================================================

  email: z
    .string()
    .trim()
    .email("Invalid email address")
    .max(150, "Email cannot exceed 150 characters"),

  // ====================================================
  // MOBILE
  // ====================================================

  mobile: z
    .string()
    .trim()
    .regex(
      /^[6-9]\d{9}$/,
      "Mobile number must be a valid 10 digit Indian mobile number",
    ),

  // ====================================================
  // PAN NUMBER
  // ====================================================

  pan_number: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "Invalid PAN number")
    .optional()
    .or(z.literal("")),

  // ====================================================
  // AADHAAR NUMBER
  // ====================================================

  aadhaar_number: z
    .string()
    .trim()
    .regex(/^\d{12}$/, "Aadhaar number must contain exactly 12 digits")
    .optional()
    .or(z.literal("")),

  // ====================================================
  // GST NUMBER
  //
  // OPTIONAL
  //
  // If GST number is entered:
  // gst_file + msme_file are required
  // ====================================================

  gst_number: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z0-9]$/, "Invalid GST number")
    .optional()
    .or(z.literal("")),

  // ====================================================
  // CONSTITUTION TYPE
  //
  // Partnership:
  // partnership_deed + firm_pan_file required
  // ====================================================

  constitution_type: z
    .enum(["Individual", "Proprietorship", "Partnership"])
    .optional()
    .or(z.literal("")),

  // ====================================================
  // ACCOUNT HOLDER NAME
  // ====================================================

  account_holder_name: z
    .string()
    .trim()
    .max(150, "Account holder name cannot exceed 150 characters")
    .optional()
    .or(z.literal("")),

  // ====================================================
  // ACCOUNT NUMBER
  // ====================================================

  account_number: z
    .string()
    .trim()
    .regex(/^\d{9,18}$/, "Invalid bank account number")
    .optional()
    .or(z.literal("")),

  // ====================================================
  // IFSC CODE
  // ====================================================

  ifsc_code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Invalid IFSC code")
    .optional()
    .or(z.literal("")),
});

// ======================================================
// EXPORT
// ======================================================

module.exports = {
  dsaSignupSchema,
};
