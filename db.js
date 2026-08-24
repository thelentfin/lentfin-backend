const mysql = require("mysql2");

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Test connection
db.getConnection((err, connection) => {
  if (err) {
    console.error("❌ Database connection failed:", err);
  } else {
    console.log("✅ Connected to MySQL database");
    connection.release();
  }
});

// Keep database alive every 5 minutes
setInterval(() => {
  db.query("SELECT 1", (err) => {
    if (err) {
      console.error("Keep alive query failed:", err);
    } else {
      console.log("⏱️ Database keep-alive ping sent");
    }
  });
}, 5 * 60 * 1000);

module.exports = db;