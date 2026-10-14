require("dotenv").config();
const db = require("../db");

async function migrate() {
  const connection = await db.promise().getConnection();
  try {
    console.log("Checking loan_case_disbursement_tranches table...");
    
    await connection.query(`
      CREATE TABLE IF NOT EXISTS loan_case_disbursement_tranches (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        case_id INT UNSIGNED NOT NULL,
        tranche_number INT NOT NULL DEFAULT 1,
        amount DECIMAL(15,2) NOT NULL,
        disbursement_date DATE NOT NULL,
        cheque_reference VARCHAR(100) NULL,
        remarks TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_disb_case (case_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log("✅ loan_case_disbursement_tranches table verified / created successfully.");
  } catch (err) {
    console.error("❌ Migration error:", err);
    process.exit(1);
  } finally {
    connection.release();
    process.exit(0);
  }
}

migrate();
