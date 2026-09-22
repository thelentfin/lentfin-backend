const cloudinary = require("../config/cloudinary");

// ======================================================
// DELETE FILE FROM CLOUDINARY
// ======================================================

const deleteFromCloudinary = async (publicId, resourceType = "image") => {
  try {
    if (!publicId) {
      throw new Error("Cloudinary public_id is required");
    }

    console.log("======================================");
    console.log("CLOUDINARY DELETE START");
    console.log("======================================");
    console.log("Public ID:", publicId);
    console.log("Resource Type:", resourceType);

    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
      invalidate: true,
    });

    console.log("Cloudinary Result:", result);

    if (result.result !== "ok" && result.result !== "not found") {
      throw new Error(`Cloudinary delete failed: ${result.result}`);
    }

    console.log("======================================");
    console.log("CLOUDINARY DELETE SUCCESS");
    console.log("======================================");

    return result;
  } catch (error) {
    console.error("======================================");
    console.error("CLOUDINARY DELETE FAILED");
    console.error("======================================");
    console.error(error);

    throw error;
  }
};

module.exports = deleteFromCloudinary;
