const { Pool } = require("pg");

const writeDb = new Pool({
  connectionString: "postgresql://user:password@localhost:5432/write_db",
});
const readDb = new Pool({
  connectionString: "postgresql://user:password@localhost:5433/read_db",
});

async function checkSchema() {
  console.log("=== WRITE DATABASE SCHEMA ===\n");

  const writeTableQuery = `
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `;

  const writeRes = await writeDb.query(writeTableQuery);
  console.log("Tables in write_db:");
  for (const row of writeRes.rows) {
    console.log(`  - ${row.table_name}`);
  }

  const requiredWriteTables = ["products", "orders", "order_items", "outbox"];
  for (const table of requiredWriteTables) {
    const exists = writeRes.rows.some((r) => r.table_name === table);
    console.log(`  ${exists ? "✓" : "✗"} ${table}`);
  }

  console.log("\nOutbox table columns:");
  const outboxCols = await writeDb.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'outbox' ORDER BY ordinal_position;`
  );
  for (const col of outboxCols.rows) {
    console.log(`  - ${col.column_name}: ${col.data_type}`);
  }

  console.log("\n=== READ DATABASE SCHEMA ===\n");

  const readTableQuery = `
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `;

  const readRes = await readDb.query(readTableQuery);
  console.log("Tables in read_db:");
  for (const row of readRes.rows) {
    console.log(`  - ${row.table_name}`);
  }

  const requiredReadTables = [
    "product_sales_view",
    "category_metrics_view",
    "customer_ltv_view",
    "hourly_sales_view",
    "processed_events",
    "sync_state",
  ];
  for (const table of requiredReadTables) {
    const exists = readRes.rows.some((r) => r.table_name === table);
    console.log(`  ${exists ? "✓" : "✗"} ${table}`);
  }

  console.log("\nProduct Sales View columns:");
  const productSalesCols = await readDb.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'product_sales_view' ORDER BY ordinal_position;`
  );
  for (const col of productSalesCols.rows) {
    console.log(`  - ${col.column_name}: ${col.data_type}`);
  }

  await writeDb.end();
  await readDb.end();

  console.log("\n=== DATABASE SCHEMA VALIDATION COMPLETE ===");
}

checkSchema().catch((error) => {
  console.error("Schema check failed:", error.message);
  process.exit(1);
});
