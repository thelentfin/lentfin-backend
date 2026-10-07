require("dotenv").config();
const db = require("../db");

async function migrate() {
  const connection = await db.promise().getConnection();
  try {
    console.log("Checking loan_case_payments columns...");
    const [cols] = await connection.query("DESCRIBE loan_case_payments");
    const colNames = cols.map((c) => c.Field);

    if (!colNames.includes("corporate_received_amount")) {
      console.log("Adding corporate_received_amount column...");
      await connection.query(
        "ALTER TABLE loan_case_payments ADD COLUMN corporate_received_amount DECIMAL(15,2) NOT NULL DEFAULT 0.00 AFTER corporate_amount"
      );
      console.log("✅ Added corporate_received_amount column.");
    } else {
      console.log("ℹ️ corporate_received_amount column already exists.");
    }

    console.log("Updating corporate_payment_status ENUM...");
    await connection.query(
      "ALTER TABLE loan_case_payments MODIFY COLUMN corporate_payment_status ENUM('PENDING', 'PARTIAL', 'RECEIVED') NOT NULL DEFAULT 'PENDING'"
    );
    console.log("✅ corporate_payment_status ENUM updated to ('PENDING', 'PARTIAL', 'RECEIVED').");

    console.log("🎉 Recovery columns setup completed!");
  } catch (err) {
    console.error("❌ Migration error:", err);
    process.exit(1);
  } finally {
    connection.release();
    process.exit(0);
  }
}

migrate();
