const cloudinary = require("../config/cloudinary");
const streamifier = require("streamifier");

const uploadToCloudinary = (file, folder) => {
  return new Promise((resolve, reject) => {
    try {
      // ======================================
      // FILE VALIDATION
      // ======================================

      if (!file) {
        return reject(new Error("File not received"));
      }

      console.log("======================================");
      console.log("CLOUDINARY UPLOAD START");
      console.log("======================================");
      console.log("File Name:", file.originalname);
      console.log("MIME Type:", file.mimetype);
      console.log("File Size:", file.size);
      console.log("Folder:", folder);

      // ======================================
      // BUFFER VALIDATION
      // ======================================

      if (!file.buffer) {
        return reject(new Error("File buffer is missing."));
      }

      // ArrayBuffer → Buffer
      const buffer = Buffer.isBuffer(file.buffer)
        ? file.buffer
        : Buffer.from(file.buffer);

      console.log("Buffer Size:", buffer.length);

      // ======================================
      // RESOURCE TYPE
      // ======================================

      const resourceType = "auto";

      // ======================================
      // CLOUDINARY STREAM
      // ======================================

      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: resourceType,
          use_filename: true,
          unique_filename: true,
          overwrite: false,
        },
        (error, result) => {
          if (error) {
            console.log("======================================");
            console.log("CLOUDINARY UPLOAD FAILED");
            console.log("======================================");
            console.log(error);

            return reject(error);
          }

          console.log("======================================");
          console.log("CLOUDINARY UPLOAD SUCCESS");
          console.log("======================================");
          console.log("Public ID:", result.public_id);
          console.log("Secure URL:", result.secure_url);

          resolve(result);
        },
      );

      // ======================================
      // PIPE BUFFER TO CLOUDINARY
      // ======================================

      streamifier.createReadStream(buffer).pipe(uploadStream);
    } catch (err) {
      reject(err);
    }
  });
};

module.exports = uploadToCloudinary;
