require("dotenv").config();
const db = require("../db");

async function checkAndMigrate() {
  const connection = await db.promise().getConnection();
  try {
    const [cols] = await connection.query("DESCRIBE companies");
    const colNames = cols.map((c) => c.Field);
    console.log("Current companies columns:", colNames);

    if (!colNames.includes("standard_payment_days")) {
      console.log("Adding standard_payment_days column...");
      await connection.query(
        "ALTER TABLE companies ADD COLUMN standard_payment_days INT NOT NULL DEFAULT 5"
      );
      console.log("✅ Added standard_payment_days column.");
    } else {
      console.log("ℹ️ standard_payment_days column already exists.");
    }

    const [updatedCols] = await connection.query("DESCRIBE companies");
    console.log("Updated companies columns:", updatedCols.map((c) => c.Field));
  } catch (err) {
    console.error("Migration error:", err);
    process.exit(1);
  } finally {
    connection.release();
    process.exit(0);
  }
}

checkAndMigrate();
