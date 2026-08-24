const cloudinary = require("../config/cloudinary");

const deleteFromCloudinary = async (
  publicId,
  resourceType = "image"
) => {
  if (!publicId) {
    throw new Error("Cloudinary public_id is required");
  }

  console.log("======================================");
  console.log("CLOUDINARY DELETE START");
  console.log("======================================");

  console.log("Public ID:", publicId);
  console.log("Resource Type:", resourceType);

  const result = await cloudinary.uploader.destroy(
    publicId,
    {
      resource_type: resourceType,
    }
  );

  console.log("Cloudinary Delete Result:", result);

  if (
    result.result !== "ok" &&
    result.result !== "not found"
  ) {
    throw new Error(
      `Cloudinary delete failed for ${publicId}`
    );
  }

  console.log("======================================");
  console.log("CLOUDINARY DELETE SUCCESS");
  console.log("======================================");

  return result;
};

module.exports = deleteFromCloudinary;