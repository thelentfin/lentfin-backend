const cloudinary = require("../config/cloudinary");
const streamifier = require("streamifier");

const uploadToCloudinary = (file, folder) => {
  return new Promise((resolve, reject) => {
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

    // ------------------------------------------
    // RESOURCE TYPE
    // ------------------------------------------

    let resourceType = "auto";

    console.log("Resource Type:", resourceType);

    // ------------------------------------------
    // CLOUDINARY UPLOAD
    // ------------------------------------------

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: folder,
        resource_type: resourceType,

        use_filename: true,
        unique_filename: true,
      },

      (error, result) => {
        if (error) {
          console.error("======================================");

          console.error("CLOUDINARY UPLOAD FAILED");

          console.error("======================================");

          console.error("HTTP CODE:", error.http_code);
          console.error("ERROR CODE:", error.code);
          console.error("ERROR MESSAGE:", error.message);
          console.error("FULL ERROR:", error);

          return reject(error);
        }

        console.log("======================================");

        console.log("CLOUDINARY UPLOAD SUCCESS");

        console.log("======================================");

        console.log("Public ID:", result.public_id);

        console.log("URL:", result.url);

        console.log("Secure URL:", result.secure_url);

        console.log("Resource Type:", result.resource_type);

        console.log("Format:", result.format);

        console.log("======================================");

        resolve(result);
      },
    );

    // ------------------------------------------
    // SEND BUFFER
    // ------------------------------------------

    streamifier.createReadStream(file.buffer).pipe(uploadStream);
  });
};

module.exports = uploadToCloudinary;
