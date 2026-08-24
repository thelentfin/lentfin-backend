// ======================================================
// config/cloudinary.js
// ======================================================

const cloudinary = require("cloudinary").v2;

// ------------------------------------------------------
// SAFETY CHECK: FAIL FAST IF ENV VARS ARE MISSING
// ------------------------------------------------------

const requiredEnvVars = [
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
];

const missingVars = requiredEnvVars.filter((key) => !process.env[key]);

if (missingVars.length > 0) {
  console.error("======================================");
  console.error("CLOUDINARY CONFIG ERROR");
  console.error("======================================");
  console.error("Missing environment variables:", missingVars.join(", "));
  console.error(
    "Check your .env file and make sure dotenv is loaded BEFORE this file is required.",
  );
  console.error("======================================");
}

// ------------------------------------------------------
// CONFIGURE CLOUDINARY
// ------------------------------------------------------

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// ------------------------------------------------------
// EXPORT THE CONFIGURED CLOUDINARY OBJECT
// (must export "cloudinary" itself, NOT the return value
// of cloudinary.config(), and NOT require("cloudinary")
// without ".v2")
// ------------------------------------------------------

module.exports = cloudinary;
