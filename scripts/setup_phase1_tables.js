require("dotenv").config();
const db = require("../db");

async function setupPhase1() {
  const connection = await db.promise().getConnection();

  try {
    console.log("🚀 Starting Phase 1 Database Setup...");

    // 1. Create `products` table
    console.log("Creating `products` table if not exists...");
    await connection.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_name VARCHAR(150) NOT NULL UNIQUE,
        status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log("✅ `products` table ready.");

    // 2. Create `bank_product_payout_options` table
    console.log("Creating `bank_product_payout_options` table if not exists...");
    await connection.query(`
      CREATE TABLE IF NOT EXISTS bank_product_payout_options (
        id INT AUTO_INCREMENT PRIMARY KEY,
        bank_id INT NOT NULL,
        product_id INT NOT NULL,
        option_label VARCHAR(150) NOT NULL DEFAULT 'Standard',
        payout_percentage DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
        remarks TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_bank_id (bank_id),
        KEY idx_product_id (product_id),
        UNIQUE KEY uq_bank_product_option (bank_id, product_id, option_label),
        CONSTRAINT fk_bppo_bank FOREIGN KEY (bank_id) REFERENCES banks (id) ON DELETE CASCADE,
        CONSTRAINT fk_bppo_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log("✅ `bank_product_payout_options` table ready.");

    // 3. Safely add nullable columns to `loan_cases` table if they do not exist
    console.log("Checking columns on `loan_cases` table...");
    const [columns] = await connection.query(`DESCRIBE loan_cases`);
    const existingFieldNames = columns.map((col) => col.Field);

    const columnsToAdd = [
      { name: "product_id", def: "INT NULL DEFAULT NULL AFTER bank_id" },
      { name: "payout_option_id", def: "INT NULL DEFAULT NULL AFTER product_id" },
      { name: "payout_percentage", def: "DECIMAL(5,2) NULL DEFAULT NULL AFTER sanction_amount" },
      { name: "calculated_commission", def: "DECIMAL(15,2) NULL DEFAULT NULL AFTER payout_percentage" },
    ];

    for (const col of columnsToAdd) {
      if (!existingFieldNames.includes(col.name)) {
        console.log(`Adding column '${col.name}' to loan_cases...`);
        await connection.query(`ALTER TABLE loan_cases ADD COLUMN ${col.name} ${col.def}`);
        console.log(`✅ Column '${col.name}' added.`);
      } else {
        console.log(`ℹ️ Column '${col.name}' already exists in loan_cases.`);
      }
    }

    console.log("🎉 Phase 1 Database Setup completed successfully with zero breaking changes!");
  } catch (error) {
    console.error("❌ Phase 1 Setup Error:", error);
    process.exit(1);
  } finally {
    connection.release();
    process.exit(0);
  }
}

setupPhase1();
