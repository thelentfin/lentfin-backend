const jwt = require("jsonwebtoken");
require("dotenv").config();

const JWT_SECRET = process.env.JWT_SECRET;

function authenticateAndAuthorize(...allowedRoles) {
  return (req, res, next) => {
    try {
      const authHeader = req.headers["authorization"];
      const token = authHeader && authHeader.split(" ")[1];

      if (!token) {
        return res.status(401).json({ message: "Access denied. No token provided." });
      }

      jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
          return res.status(403).json({ message: "Invalid or expired token." });
        }

        // attach decoded user info
        req.user = user;

        // If specific roles are passed, check them
        if (allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
          return res.status(403).json({ message: "Access denied. Insufficient permissions." });
        }

        next();
      });
    } catch (error) {
      return res.status(500).json({ message: "Authentication error", error: error.message });
    }
  };
}

module.exports = authenticateAndAuthorize;
