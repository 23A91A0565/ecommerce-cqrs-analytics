const fs = require("fs");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");

const readDatabaseUrl = process.env.READ_DATABASE_URL;
const port = Number(process.env.PORT || 8081);

if (!readDatabaseUrl) {
  throw new Error("READ_DATABASE_URL is required");
}

const pool = new Pool({ connectionString: readDatabaseUrl });

async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
}

const app = express();

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ status: "ok" });
  } catch (error) {
    res.status(503).json({ status: "error", message: error.message });
  }
});

app.get("/api/analytics/products/:productId/sales", async (req, res) => {
  const productId = Number(req.params.productId);
  if (!Number.isInteger(productId) || productId <= 0) {
    return res.status(400).json({ error: "productId must be a positive integer" });
  }

  const result = await pool.query(
    `SELECT product_id, total_quantity_sold, total_revenue, order_count
     FROM product_sales_view
     WHERE product_id = $1`,
    [productId]
  );

  const row = result.rows[0];
  return res.status(200).json({
    productId,
    totalQuantitySold: row ? Number(row.total_quantity_sold) : 0,
    totalRevenue: row ? Number(row.total_revenue) : 0,
    orderCount: row ? Number(row.order_count) : 0,
  });
});

app.get("/api/analytics/categories/:category/revenue", async (req, res) => {
  const category = req.params.category;

  const result = await pool.query(
    `SELECT category_name, total_revenue, total_orders
     FROM category_metrics_view
     WHERE category_name = $1`,
    [category]
  );

  const row = result.rows[0];
  return res.status(200).json({
    category,
    totalRevenue: row ? Number(row.total_revenue) : 0,
    totalOrders: row ? Number(row.total_orders) : 0,
  });
});

app.get("/api/analytics/customers/:customerId/lifetime-value", async (req, res) => {
  const customerId = Number(req.params.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return res.status(400).json({ error: "customerId must be a positive integer" });
  }

  const result = await pool.query(
    `SELECT customer_id, total_spent, order_count, last_order_date
     FROM customer_ltv_view
     WHERE customer_id = $1`,
    [customerId]
  );

  const row = result.rows[0];
  return res.status(200).json({
    customerId,
    totalSpent: row ? Number(row.total_spent) : 0,
    orderCount: row ? Number(row.order_count) : 0,
    lastOrderDate: row && row.last_order_date ? new Date(row.last_order_date).toISOString() : null,
  });
});

app.get("/api/analytics/sync-status", async (req, res) => {
  const result = await pool.query(
    `SELECT last_processed_event_timestamp
     FROM sync_state
     WHERE id = 1`
  );

  const timestamp = result.rows[0]?.last_processed_event_timestamp || null;
  let lagSeconds = 0;
  let isoTimestamp = null;

  if (timestamp) {
    const lastProcessed = new Date(timestamp);
    isoTimestamp = lastProcessed.toISOString();
    lagSeconds = Math.max(0, Math.floor((Date.now() - lastProcessed.getTime()) / 1000));
  }

  return res.status(200).json({
    lastProcessedEventTimestamp: isoTimestamp,
    lagSeconds,
  });
});

async function start() {
  try {
    await initSchema();
    app.listen(port, () => {
      console.log(`query-service listening on ${port}`);
    });
  } catch (error) {
    console.error("query-service failed to start:", error);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down query-service...`);
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start();
