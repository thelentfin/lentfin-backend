require("dotenv").config();
const path = require("path");
const xlsx = require("../../lentfin-frontend/node_modules/xlsx-js-style");
const db = require("../db");

// Configuration
const EXCEL_FILE_PATH = "D:\\Digiva\\Lentfin Documents\\Slab Book Secured Sept 2026.xlsx";
const SHEET_NAME = "Slab Book";

function cleanLabel(raw) {
  let l = raw
    .replace(/[-=:\s\t–—]+$/g, "")
    .replace(/^[-=:\s\t–—]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!l || l.toLowerCase() === "flat" || l.toLowerCase() === "on sanctioned") {
    return "Standard";
  }
  return l;
}

/**
 * Parse an Excel cell value into one or more payout options
 * Rules:
 * 1. PF amounts/clauses are completely discarded as requested ("dont consider pf amount").
 * 2. Multi-value cells (e.g. "1.50% ; STSL - 1.70%") split into selectable options.
 * 3. Empty or dash cells default to Inactive with 0.00%.
 * 4. "Refer Sheet" defaults to Inactive with remarks.
 */
function parseCellOptions(cellVal) {
  if (cellVal === null || cellVal === undefined || cellVal === "") {
    return [{ label: "Standard", rate: 0.0, status: "Inactive", remarks: null }];
  }

  // Pure numeric value (e.g., 0.01 = 1%, 0.015 = 1.5%)
  if (typeof cellVal === "number") {
    const rate = Math.round(cellVal * 10000) / 100;
    return [{
      label: "Standard",
      rate,
      status: rate > 0 ? "Active" : "Inactive",
      remarks: null
    }];
  }

  const rawStr = String(cellVal).trim();

  // Dashes or empty string
  if (rawStr === "-" || rawStr === "--" || rawStr === "") {
    return [{ label: "Standard", rate: 0.0, status: "Inactive", remarks: null }];
  }

  // "Refer Sheet"
  if (/refer\s*sheet/i.test(rawStr)) {
    return [{ label: "Standard", rate: 0.0, status: "Inactive", remarks: "Refer Sheet" }];
  }

  // Split multi-line or semicolon separated values
  const parts = rawStr.split(/[;\n\r]+/).map((p) => p.trim()).filter(Boolean);
  const options = [];

  for (const part of parts) {
    // Ignore lines that are ONLY about PF conditions (e.g. "(The above payouts are subject to 2% PF)")
    if (/(?:minimum\s*PF|subject\s*to\s*\d+%?\s*PF|builder\s*cases\s*only)/i.test(part) &&
        !/\d+(?:\.\d+)?%/.test(part.replace(/PF\s*[-=]?\s*\d+%?/gi, ""))) {
      continue;
    }

    // Discard any PF clauses from the text
    const cleaned = part
      .replace(/(?:minimum\s*PF|subject\s*to\s*\d+%?\s*PF|PF\s*[-=:]?\s*\d+(?:\.\d+)?%?|\b\d+(?:\.\d+)?%\s*of\s*PF\b|\(|\))/gi, "")
      .trim();

    // Match the percentage number
    const match = cleaned.match(/(\d+(?:\.\d+)?)\s*%/);
    if (match) {
      const rate = parseFloat(match[1]);
      let labelRaw = cleaned.replace(/(\d+(?:\.\d+)?)\s*%/, "");
      const label = cleanLabel(labelRaw);

      options.push({
        label,
        rate,
        status: rate > 0 ? "Active" : "Inactive",
        remarks: part.trim(),
      });
    }
  }

  // If no percentage was matched (e.g. descriptive text without fixed %)
  if (options.length === 0) {
    return [{
      label: "Standard",
      rate: 0.0,
      status: "Inactive",
      remarks: rawStr,
    }];
  }

  // Deduplicate options with identical labels for the same cell
  const uniqueOptions = [];
  const seenLabels = new Set();
  for (const opt of options) {
    let finalLabel = opt.label;
    if (seenLabels.has(finalLabel.toLowerCase())) {
      finalLabel = `${finalLabel} (${opt.rate}%)`;
    }
    seenLabels.add(finalLabel.toLowerCase());
    uniqueOptions.push({ ...opt, label: finalLabel });
  }

  return uniqueOptions;
}

async function runImport() {
  const connection = await db.promise().getConnection();

  try {
    console.log("=================================================");
    console.log("🚀 STARTING PHASE 2: EXCEL IMPORT");
    console.log(`📁 File: ${EXCEL_FILE_PATH}`);
    console.log("=================================================");

    const workbook = xlsx.readFile(EXCEL_FILE_PATH);
    const sheet = workbook.Sheets[SHEET_NAME];
    if (!sheet) {
      throw new Error(`Sheet "${SHEET_NAME}" not found in workbook!`);
    }

    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    if (rows.length < 2) {
      throw new Error("Sheet has insufficient rows!");
    }

    const headerRow = rows[0];
    console.log("📋 Header columns found:", headerRow);

    // Standardize 14 Product names from columns 1 to 14
    const productDefinitions = [];
    for (let c = 1; c <= 14; c++) {
      let rawName = String(headerRow[c] || "").trim();
      if (!rawName) continue;

      // Clean known typos from header
      if (/credit\s*card/i.test(rawName) && /lacr/i.test(rawName)) {
        rawName = "Loan Against Credit Card (LACR)";
      } else if (/working\s*capital/i.test(rawName)) {
        rawName = "Working Capital / OD";
      } else if (/gold\s*loan/i.test(rawName)) {
        rawName = "Gold Loan";
      }

      productDefinitions.push({ colIndex: c, name: rawName });
    }

    console.log(`\n📦 Step 1: Syncing ${productDefinitions.length} Master Products...`);
    const productMap = new Map(); // name.toLowerCase() -> id

    for (const prod of productDefinitions) {
      const [existing] = await connection.query(
        "SELECT id, product_name FROM products WHERE LOWER(product_name) = LOWER(?) LIMIT 1",
        [prod.name]
      );

      let productId;
      if (existing.length > 0) {
        productId = existing[0].id;
      } else {
        const [insertRes] = await connection.query(
          "INSERT INTO products (product_name, status) VALUES (?, 'Active')",
          [prod.name]
        );
        productId = insertRes.insertId;
        console.log(`  ➕ Added product: ${prod.name} (ID: ${productId})`);
      }
      productMap.set(prod.name.toLowerCase(), productId);
    }
    console.log(`✅ All ${productDefinitions.length} products synced.`);

    console.log("\n🏦 Step 2: Syncing Banks & Payout Options...");

    // Cache existing banks to preserve IDs and avoid duplicates
    const [existingBanks] = await connection.query("SELECT id, bank_name FROM banks");
    const bankMap = new Map(); // lowerCaseName -> id
    for (const b of existingBanks) {
      bankMap.set(b.bank_name.trim().toLowerCase(), b.id);
    }

    let banksCreated = 0;
    let banksExisting = 0;
    let totalOptionsUpserted = 0;
    let activeOptionsCount = 0;

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const bankName = String(row[0] || "").trim();
      if (!bankName) continue;

      // Check if bank exists (case-insensitive)
      let bankId = bankMap.get(bankName.toLowerCase());
      if (!bankId) {
        const [bankRes] = await connection.query(
          "INSERT INTO banks (bank_name, status) VALUES (?, 'Active')",
          [bankName]
        );
        bankId = bankRes.insertId;
        bankMap.set(bankName.toLowerCase(), bankId);
        banksCreated++;
      } else {
        banksExisting++;
      }

      // Loop through the 14 products for this bank
      for (const prod of productDefinitions) {
        const productId = productMap.get(prod.name.toLowerCase());
        const cellVal = row[prod.colIndex];
        const options = parseCellOptions(cellVal);

        for (const opt of options) {
          await connection.query(
            `INSERT INTO bank_product_payout_options
             (bank_id, product_id, option_label, payout_percentage, status, remarks)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
             payout_percentage = VALUES(payout_percentage),
             status = VALUES(status),
             remarks = VALUES(remarks)`,
            [
              bankId,
              productId,
              opt.label,
              opt.rate,
              opt.status,
              opt.remarks || null,
            ]
          );
          totalOptionsUpserted++;
          if (opt.status === "Active") activeOptionsCount++;
        }
      }
    }

    console.log("\n=================================================");
    console.log("🎉 PHASE 2 IMPORT FINISHED SUCCESSFULLY!");
    console.log("=================================================");
    console.log(`🏦 Banks Processed:         ${rows.length - 1}`);
    console.log(`   - Existing Preserved:    ${banksExisting}`);
    console.log(`   - New Banks Created:     ${banksCreated}`);
    console.log(`📦 Master Products Synced:  ${productDefinitions.length}`);
    console.log(`⚙️  Total Options Upserted:  ${totalOptionsUpserted}`);
    console.log(`   - Active Options:        ${activeOptionsCount}`);
    console.log(`   - Inactive (Dash/Refer): ${totalOptionsUpserted - activeOptionsCount}`);
    console.log("=================================================\n");

  } catch (err) {
    console.error("❌ Phase 2 Import Error:", err);
    process.exit(1);
  } finally {
    connection.release();
    process.exit(0);
  }
}

runImport();
