const { z } = require("zod");

// ======================================================
// PARTNER VALIDATION
// ======================================================
// Partner details are OPTIONAL for Partnership/LLP.
// BUT if partner details are provided,
// all partner fields must be valid.

const partnerSchema = z.object({
  partner_number: z.coerce.number().int().min(1),

  name: z.string().trim().min(2).max(150),

  email: z.string().trim().email(),

  mobile: z
    .string()
    .trim()
    .regex(/^[6-9]\d{9}$/),

  pan_number: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/),

  aadhaar_number: z
    .string()
    .trim()
    .regex(/^\d{12}$/),
});

// ======================================================
// DIRECTOR VALIDATION
// ======================================================
// Director is REQUIRED for Private Limited.
// Each director must have valid details.

const directorSchema = z.object({
  director_number: z.coerce.number().int().min(1),

  name: z.string().trim().min(2).max(150),

  email: z.string().trim().email(),

  mobile: z
    .string()
    .trim()
    .regex(/^[6-9]\d{9}$/),

  pan_number: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/),

  aadhaar_number: z
    .string()
    .trim()
    .regex(/^\d{12}$/),
});

// ======================================================
// DSA SIGNUP VALIDATION
// ======================================================

const dsaSignupSchema = z
  .object({
    // ==================================================
    // BASIC DSA DETAILS
    // ==================================================

    name: z.string().trim().min(2).max(150),

    email: z.string().trim().email().max(150),

    mobile: z
      .string()
      .trim()
      .regex(/^[6-9]\d{9}$/),

    // ==================================================
    // PAN
    // ==================================================

    pan_number: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/)
      .optional()
      .or(z.literal("")),

    // ==================================================
    // AADHAAR
    // ==================================================

    aadhaar_number: z
      .string()
      .trim()
      .regex(/^\d{12}$/)
      .optional()
      .or(z.literal("")),

    // ==================================================
    // GST
    // ==================================================

    gst_number: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z0-9]$/)
      .optional()
      .or(z.literal("")),

    // ==================================================
    // CONSTITUTION TYPE
    // ==================================================

    constitution_type: z
      .enum([
        "Individual",
        "Proprietorship",
        "Partnership/LLP",
        "Private Limited",
      ])
      .optional()
      .or(z.literal("")),

    // ==================================================
    // DSA LOCATION
    // ==================================================

    dsa_location: z
      .string()
      .trim()
      .min(1, "DSA Location is required")
      .max(150, "DSA Location must not exceed 150 characters"),

    // ==================================================
    // MSME NUMBER
    // ==================================================
    // MSME number is OPTIONAL.

    msme_number: z
      .string()
      .trim()
      .max(50, "MSME Number must not exceed 50 characters")
      .optional()
      .or(z.literal("")),

    // ==================================================
    // PARTNERS
    // ==================================================
    // Partnership/LLP ma partner OPTIONAL che.
    //
    // Jo partners array aave:
    //   → each partner must pass partnerSchema
    //
    // Jo partners array na aave:
    //   → valid
    //
    // Jo partners = [] hoy:
    //   → valid

    partners: z.array(partnerSchema).optional(),

    // ==================================================
    // DIRECTORS
    // ==================================================
    // Private Limited ma minimum 1 director
    // superRefine ma check thase.

    directors: z.array(directorSchema).optional(),

    // ==================================================
    // BANK DETAILS
    // ==================================================

    account_holder_name: z
      .string()
      .trim()
      .max(150)
      .optional()
      .or(z.literal("")),

    account_number: z
      .string()
      .trim()
      .regex(/^\d{9,18}$/)
      .optional()
      .or(z.literal("")),

    ifsc_code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/)
      .optional()
      .or(z.literal("")),

    bank_name: z.string().trim().max(150).optional().or(z.literal("")),

    branch_name: z.string().trim().max(150).optional().or(z.literal("")),
  })

  // ====================================================
  // CONDITIONAL VALIDATION
  // ====================================================

  .superRefine((data, ctx) => {
    // ==================================================
    // PARTNERSHIP / LLP
    // ==================================================
    // IMPORTANT:
    // Partner is OPTIONAL.
    //
    // Therefore:
    //
    // partners = undefined → VALID
    // partners = []        → VALID
    // partners = [partner] → VALID if partnerSchema passes
    //
    // NO "At least one partner is required" error.

    if (data.constitution_type === "Partnership/LLP") {
      // No compulsory partner validation here.
      // If partner details are provided,
      // partnerSchema automatically validates them.
    }

    // ==================================================
    // INDIVIDUAL / PROPRIETORSHIP
    // ==================================================
    // Partners are NOT allowed.

    if (
      data.constitution_type === "Individual" ||
      data.constitution_type === "Proprietorship"
    ) {
      if (data.partners && data.partners.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["partners"],
          message: "Partners are not allowed.",
        });
      }
    }

    // ==================================================
    // PRIVATE LIMITED
    // ==================================================

    if (data.constitution_type === "Private Limited") {
      // ----------------------------------------------
      // GST REQUIRED
      // ----------------------------------------------

      if (!data.gst_number || data.gst_number.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["gst_number"],
          message: "GST Number is required for Private Limited.",
        });
      }

      // ----------------------------------------------
      // MINIMUM ONE DIRECTOR REQUIRED
      // ----------------------------------------------

      if (!data.directors || data.directors.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["directors"],
          message: "At least one director is required.",
        });
      }

      // ----------------------------------------------
      // PARTNERS NOT ALLOWED
      // ----------------------------------------------

      if (data.partners && data.partners.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["partners"],
          message: "Partners are not allowed for Private Limited.",
        });
      }
    }

    // ==================================================
    // DIRECTORS ONLY FOR PRIVATE LIMITED
    // ==================================================

    if (
      data.constitution_type !== "Private Limited" &&
      data.directors &&
      data.directors.length > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["directors"],
        message: "Directors are allowed only for Private Limited.",
      });
    }
  });

// ======================================================
// EXPORT
// ======================================================

module.exports = {
  dsaSignupSchema,
};

