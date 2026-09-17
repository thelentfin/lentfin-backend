const { z } = require("zod");
// ======================================================
// PARTNER VALIDATION
// ======================================================
//new added partner schema for partnership constitution type
const partnerSchema = z.object({
  partner_number: z.coerce.number().int().min(2),

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
    // tamara badha current fields
    company_id: z.coerce.number().int().positive("Company is required"),
    company_name: z.string().trim().min(1).max(200),

    location_id: z.coerce.number().int().positive("Location is required"),
    location: z.string().trim().min(1).max(150),

    name: z.string().trim().min(2).max(150),

    email: z.string().trim().email().max(150),

    mobile: z
      .string()
      .trim()
      .regex(/^[6-9]\d{9}$/),

    pan_number: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/)
      .optional()
      .or(z.literal("")),

    aadhaar_number: z
      .string()
      .trim()
      .regex(/^\d{12}$/)
      .optional()
      .or(z.literal("")),

    gst_number: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z0-9]$/)
      .optional()
      .or(z.literal("")),

    constitution_type: z
      .enum([
        "Individual",
        "Proprietorship",
        "Partnership/LLP",
        "Private Limited",
      ])
      .optional()
      .or(z.literal("")),

    partners: z.array(partnerSchema).optional(),
    directors: z.array(directorSchema).optional(),
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
  .superRefine((data, ctx) => {
    // ======================================================
    // PARTNERSHIP VALIDATION
    // ======================================================

    if (data.constitution_type === "Partnership/LLP") {
      if (!data.partners || data.partners.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["partners"],
          message: "At least one partner is required.",
        });
      }
    }

    // ======================================================
    // INDIVIDUAL / PROPRIETORSHIP
    // ======================================================

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

    // ======================================================
    // PRIVATE LIMITED
    // ======================================================

    if (data.constitution_type === "Private Limited") {
      // GST REQUIRED

      if (!data.gst_number || data.gst_number.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["gst_number"],
          message: "GST Number is required for Private Limited.",
        });
      }

      // MINIMUM ONE DIRECTOR REQUIRED

      if (!data.directors || data.directors.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["directors"],
          message: "At least one director is required.",
        });
      }
      if (data.partners && data.partners.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["partners"],
          message: "Partners are not allowed for Private Limited.",
        });
      }
    }
    // ======================================================
// DIRECTORS ONLY FOR PRIVATE LIMITED
// ======================================================

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
