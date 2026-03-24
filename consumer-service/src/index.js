const fs = require("fs");
const path = require("path");
const amqp = require("amqplib");
const { Pool } = require("pg");

const brokerUrl = process.env.BROKER_URL;
const queueName = process.env.BROKER_QUEUE || "analytics.events";
const readDatabaseUrl = process.env.READ_DATABASE_URL;

if (!brokerUrl) {
  throw new Error("BROKER_URL is required");
}
if (!readDatabaseUrl) {
  throw new Error("READ_DATABASE_URL is required");
}

const pool = new Pool({ connectionString: readDatabaseUrl });

async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
}

function asNumber(v) {
  return Number(Number(v).toFixed(2));
}

async function processOrderCreated(client, event) {
  const orderItems = Array.isArray(event.items) ? event.items : [];

  for (const item of orderItems) {
    const revenue = asNumber(item.price * item.quantity);
    await client.query(
      `INSERT INTO product_sales_view(product_id, total_quantity_sold, total_revenue, order_count)
       VALUES($1, $2, $3, 1)
       ON CONFLICT (product_id)
       DO UPDATE SET
         total_quantity_sold = product_sales_view.total_quantity_sold + EXCLUDED.total_quantity_sold,
         total_revenue = product_sales_view.total_revenue + EXCLUDED.total_revenue,
         order_count = product_sales_view.order_count + 1`,
      [item.productId, item.quantity, revenue]
    );
  }

  const categoryAccumulator = new Map();
  for (const item of orderItems) {
    const revenue = asNumber(item.price * item.quantity);
    const previous = categoryAccumulator.get(item.category) || { revenue: 0, hasOrder: false };
    previous.revenue = asNumber(previous.revenue + revenue);
    previous.hasOrder = true;
    categoryAccumulator.set(item.category, previous);
  }

  for (const [category, aggregate] of categoryAccumulator.entries()) {
    await client.query(
      `INSERT INTO category_metrics_view(category_name, total_revenue, total_orders)
       VALUES($1, $2, 1)
       ON CONFLICT (category_name)
       DO UPDATE SET
         total_revenue = category_metrics_view.total_revenue + EXCLUDED.total_revenue,
         total_orders = category_metrics_view.total_orders + 1`,
      [category, aggregate.revenue]
    );
  }

  await client.query(
    `INSERT INTO customer_ltv_view(customer_id, total_spent, order_count, last_order_date)
     VALUES($1, $2, 1, $3)
     ON CONFLICT (customer_id)
     DO UPDATE SET
       total_spent = customer_ltv_view.total_spent + EXCLUDED.total_spent,
       order_count = customer_ltv_view.order_count + 1,
       last_order_date = GREATEST(customer_ltv_view.last_order_date, EXCLUDED.last_order_date)`,
    [event.customerId, asNumber(event.total), event.timestamp]
  );

  await client.query(
    `INSERT INTO hourly_sales_view(hour_timestamp, total_orders, total_revenue)
     VALUES(date_trunc('hour', $1::timestamptz), 1, $2)
     ON CONFLICT (hour_timestamp)
     DO UPDATE SET
       total_orders = hourly_sales_view.total_orders + 1,
       total_revenue = hourly_sales_view.total_revenue + EXCLUDED.total_revenue`,
    [event.timestamp, asNumber(event.total)]
  );
}

async function processProductCreated(client, event) {
  await client.query(
    `INSERT INTO product_sales_view(product_id, total_quantity_sold, total_revenue, order_count)
     VALUES($1, 0, 0, 0)
     ON CONFLICT (product_id) DO NOTHING`,
    [event.productId]
  );
}

async function applyEvent(client, eventType, event) {
  if (eventType === "OrderCreated") {
    await processOrderCreated(client, event);
    return;
  }
  if (eventType === "ProductCreated") {
    await processProductCreated(client, event);
  }
}

function updateReadinessFile() {
  try {
    fs.writeFileSync("/tmp/consumer_ready", `${Date.now()}`);
  } catch (error) {
    console.error("failed to write readiness file", error.message);
  }
}

async function start() {
  await initSchema();

  const connection = await amqp.connect(brokerUrl);
  const channel = await connection.createChannel();

  await channel.assertQueue(queueName, { durable: true });
  channel.prefetch(20);

  channel.consume(queueName, async (msg) => {
    if (!msg) {
      return;
    }

    const eventId = msg.properties.messageId || "";
    let event;

    try {
      event = JSON.parse(msg.content.toString("utf8"));
    } catch (error) {
      console.error("Invalid message payload, dropping message", error.message);
      channel.ack(msg);
      return;
    }

    if (!eventId) {
      console.error("message missing messageId, dropping message");
      channel.ack(msg);
      return;
    }

    const eventType = event.eventType;
    const eventTimestamp = event.timestamp || new Date().toISOString();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const idempotency = await client.query(
        `INSERT INTO processed_events(event_id)
         VALUES($1)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [eventId]
      );

      if (idempotency.rowCount === 0) {
        await client.query("ROLLBACK");
        channel.ack(msg);
        return;
      }

      await applyEvent(client, eventType, event);

      await client.query(
        `UPDATE sync_state
         SET last_processed_event_timestamp =
           CASE
             WHEN last_processed_event_timestamp IS NULL THEN $1::timestamptz
             ELSE GREATEST(last_processed_event_timestamp, $1::timestamptz)
           END
         WHERE id = 1`,
        [eventTimestamp]
      );

      await client.query("COMMIT");
      channel.ack(msg);
      updateReadinessFile();
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("failed to process event", eventType, error.message);
      channel.nack(msg, false, true);
    } finally {
      client.release();
    }
  });

  updateReadinessFile();
  console.log("consumer-service started");

  const close = async () => {
    await channel.close().catch(() => undefined);
    await connection.close().catch(() => undefined);
    await pool.end();
    process.exit(0);
  };

  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

start().catch((error) => {
  console.error("consumer-service failed to start", error);
  process.exit(1);
});
