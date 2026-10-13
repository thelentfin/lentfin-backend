require("dotenv").config();
const db = require("../db");

async function checkAndMigrate() {
  const connection = await db.promise().getConnection();
  try {
    console.log("Checking loan_cases columns...");
    const [loanCaseCols] = await connection.query("DESCRIBE loan_cases");
    const lcColNames = loanCaseCols.map((c) => c.Field);

    // 1. loan_cases: sub_dsa_id
    if (!lcColNames.includes("sub_dsa_id")) {
      console.log("Adding sub_dsa_id to loan_cases...");
      await connection.query(
        "ALTER TABLE loan_cases ADD COLUMN sub_dsa_id INT NULL DEFAULT NULL AFTER dsa_id"
      );
      console.log("✅ Added sub_dsa_id to loan_cases.");
    } else {
      console.log("ℹ️ sub_dsa_id already exists in loan_cases.");
    }

    console.log("Checking loan_case_payments columns...");
    const [paymentCols] = await connection.query("DESCRIBE loan_case_payments");
    const pColNames = paymentCols.map((c) => c.Field);

    // 2. loan_case_payments: sub_dsa columns
    if (!pColNames.includes("sub_dsa_id")) {
      console.log("Adding sub_dsa_id to loan_case_payments...");
      await connection.query(
        "ALTER TABLE loan_case_payments ADD COLUMN sub_dsa_id INT NULL DEFAULT NULL AFTER payment_amount"
      );
      console.log("✅ Added sub_dsa_id to loan_case_payments.");
    } else {
      console.log("ℹ️ sub_dsa_id already exists in loan_case_payments.");
    }

    if (!pColNames.includes("sub_dsa_percentage")) {
      console.log("Adding sub_dsa_percentage to loan_case_payments...");
      await connection.query(
        "ALTER TABLE loan_case_payments ADD COLUMN sub_dsa_percentage DECIMAL(5,2) NULL DEFAULT NULL AFTER sub_dsa_id"
      );
      console.log("✅ Added sub_dsa_percentage to loan_case_payments.");
    } else {
      console.log("ℹ️ sub_dsa_percentage already exists in loan_case_payments.");
    }

    if (!pColNames.includes("sub_dsa_amount")) {
      console.log("Adding sub_dsa_amount to loan_case_payments...");
      await connection.query(
        "ALTER TABLE loan_case_payments ADD COLUMN sub_dsa_amount DECIMAL(15,2) NULL DEFAULT NULL AFTER sub_dsa_percentage"
      );
      console.log("✅ Added sub_dsa_amount to loan_case_payments.");
    } else {
      console.log("ℹ️ sub_dsa_amount already exists in loan_case_payments.");
    }

    if (!pColNames.includes("dsa_override_percentage")) {
      console.log("Adding dsa_override_percentage to loan_case_payments...");
      await connection.query(
        "ALTER TABLE loan_case_payments ADD COLUMN dsa_override_percentage DECIMAL(5,2) NULL DEFAULT NULL AFTER sub_dsa_amount"
      );
      console.log("✅ Added dsa_override_percentage to loan_case_payments.");
    } else {
      console.log("ℹ️ dsa_override_percentage already exists in loan_case_payments.");
    }

    if (!pColNames.includes("dsa_override_amount")) {
      console.log("Adding dsa_override_amount to loan_case_payments...");
      await connection.query(
        "ALTER TABLE loan_case_payments ADD COLUMN dsa_override_amount DECIMAL(15,2) NULL DEFAULT NULL AFTER dsa_override_percentage"
      );
      console.log("✅ Added dsa_override_amount to loan_case_payments.");
    } else {
      console.log("ℹ️ dsa_override_amount already exists in loan_case_payments.");
    }

    if (!pColNames.includes("sub_dsa_payout_status")) {
      console.log("Adding sub_dsa_payout_status to loan_case_payments...");
      await connection.query(
        "ALTER TABLE loan_case_payments ADD COLUMN sub_dsa_payout_status ENUM('PENDING','PAID','HOLD') NOT NULL DEFAULT 'PENDING' AFTER dsa_override_amount"
      );
      console.log("✅ Added sub_dsa_payout_status to loan_case_payments.");
    } else {
      console.log("ℹ️ sub_dsa_payout_status already exists in loan_case_payments.");
    }

    console.log("🎉 All database schema checks completed successfully.");
  } catch (err) {
    console.error("Migration error:", err);
    process.exit(1);
  } finally {
    connection.release();
    process.exit(0);
  }
}

checkAndMigrate();
