require("dotenv").config();
const db = require("../db");

async function checkAndMigrate() {
  const connection = await db.promise().getConnection();
  try {
    const [cols] = await connection.query("DESCRIBE companies");
    const colNames = cols.map((c) => c.Field);
    console.log("Current companies columns:", colNames);

    if (!colNames.includes("spot_payment_percentage")) {
      console.log("Adding spot_payment_percentage column...");
      await connection.query(
        "ALTER TABLE companies ADD COLUMN spot_payment_percentage DECIMAL(5,2) NOT NULL DEFAULT 0.85"
      );
      console.log("✅ Added spot_payment_percentage column.");
    } else {
      console.log("ℹ️ spot_payment_percentage column already exists.");
    }

    if (!colNames.includes("five_days_payment_percentage")) {
      console.log("Adding five_days_payment_percentage column...");
      await connection.query(
        "ALTER TABLE companies ADD COLUMN five_days_payment_percentage DECIMAL(5,2) NOT NULL DEFAULT 0.90"
      );
      console.log("✅ Added five_days_payment_percentage column.");
    } else {
      console.log("ℹ️ five_days_payment_percentage column already exists.");
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
