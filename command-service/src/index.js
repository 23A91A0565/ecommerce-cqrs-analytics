const express = require("express");
const { initSchema, pool } = require("./db");
const { startPublisher, stopPublisher } = require("./outboxPublisher");

const port = Number(process.env.PORT || 8080);
const app = express();
app.use(express.json());

function toMoney(value) {
  return Number(Number(value).toFixed(2));
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch (error) {
    res.status(503).json({ status: "error", message: error.message });
  }
});

app.post("/api/products", async (req, res) => {
  const { name, category, price, stock } = req.body || {};

  if (!name || typeof name !== "string") {
    return badRequest(res, "name is required");
  }
  if (!category || typeof category !== "string") {
    return badRequest(res, "category is required");
  }
  if (typeof price !== "number" || price < 0) {
    return badRequest(res, "price must be a non-negative number");
  }
  if (!Number.isInteger(stock) || stock < 0) {
    return badRequest(res, "stock must be a non-negative integer");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const insertProduct = await client.query(
      `INSERT INTO products(name, category, price, stock)
       VALUES($1, $2, $3, $4)
       RETURNING id`,
      [name, category, toMoney(price), stock]
    );

    const productId = insertProduct.rows[0].id;
    const eventPayload = {
      eventType: "ProductCreated",
      eventId: null,
      productId,
      name,
      category,
      price: toMoney(price),
      stock,
      timestamp: new Date().toISOString(),
    };

    await client.query(
      `INSERT INTO outbox(topic, payload)
       VALUES($1, $2::jsonb)`,
      ["product-events", JSON.stringify(eventPayload)]
    );

    await client.query("COMMIT");
    return res.status(201).json({ productId });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ error: "failed to create product" });
  } finally {
    client.release();
  }
});

app.put("/api/products/:productId", async (req, res) => {
  const productId = Number(req.params.productId);
  if (!Number.isInteger(productId) || productId <= 0) {
    return badRequest(res, "productId must be a positive integer");
  }

  const allowedKeys = ["name", "category", "price", "stock"];
  const updates = {};
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
      updates[key] = req.body[key];
    }
  }

  if (Object.keys(updates).length === 0) {
    return badRequest(res, "at least one field must be provided");
  }

  if (updates.name !== undefined && typeof updates.name !== "string") {
    return badRequest(res, "name must be a string");
  }
  if (updates.category !== undefined && typeof updates.category !== "string") {
    return badRequest(res, "category must be a string");
  }
  if (updates.price !== undefined && (typeof updates.price !== "number" || updates.price < 0)) {
    return badRequest(res, "price must be a non-negative number");
  }
  if (updates.stock !== undefined && (!Number.isInteger(updates.stock) || updates.stock < 0)) {
    return badRequest(res, "stock must be a non-negative integer");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existingResult = await client.query(
      "SELECT id, name, category, price, stock FROM products WHERE id = $1 FOR UPDATE",
      [productId]
    );

    if (existingResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "product not found" });
    }

    const existing = existingResult.rows[0];
    const next = {
      name: updates.name ?? existing.name,
      category: updates.category ?? existing.category,
      price: updates.price !== undefined ? toMoney(updates.price) : Number(existing.price),
      stock: updates.stock ?? existing.stock,
    };

    await client.query(
      `UPDATE products
       SET name = $1, category = $2, price = $3, stock = $4, updated_at = NOW()
       WHERE id = $5`,
      [next.name, next.category, next.price, next.stock, productId]
    );

    const nowIso = new Date().toISOString();
    await client.query(
      `INSERT INTO outbox(topic, payload)
       VALUES($1, $2::jsonb)`,
      [
        "product-events",
        JSON.stringify({
          eventType: "ProductUpdated",
          productId,
          before: {
            name: existing.name,
            category: existing.category,
            price: Number(existing.price),
            stock: existing.stock,
          },
          after: next,
          timestamp: nowIso,
        }),
      ]
    );

    if (updates.price !== undefined && Number(existing.price) !== next.price) {
      await client.query(
        `INSERT INTO outbox(topic, payload)
         VALUES($1, $2::jsonb)`,
        [
          "product-events",
          JSON.stringify({
            eventType: "PriceChanged",
            productId,
            oldPrice: Number(existing.price),
            newPrice: next.price,
            timestamp: nowIso,
          }),
        ]
      );
    }

    await client.query("COMMIT");
    return res.status(200).json({ productId });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ error: "failed to update product" });
  } finally {
    client.release();
  }
});

app.post("/api/orders", async (req, res) => {
  const { customerId, items } = req.body || {};

  if (!Number.isInteger(customerId) || customerId <= 0) {
    return badRequest(res, "customerId must be a positive integer");
  }
  if (!Array.isArray(items) || items.length === 0) {
    return badRequest(res, "items must be a non-empty array");
  }

  for (const item of items) {
    if (!Number.isInteger(item.productId) || item.productId <= 0) {
      return badRequest(res, "each item.productId must be a positive integer");
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      return badRequest(res, "each item.quantity must be a positive integer");
    }
    if (typeof item.price !== "number" || item.price < 0) {
      return badRequest(res, "each item.price must be a non-negative number");
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const uniqueProductIds = [...new Set(items.map((i) => i.productId))];
    const productRows = await client.query(
      `SELECT id, name, category, price, stock
       FROM products
       WHERE id = ANY($1::int[])
       FOR UPDATE`,
      [uniqueProductIds]
    );

    const productMap = new Map(productRows.rows.map((p) => [p.id, p]));
    if (productMap.size !== uniqueProductIds.length) {
      throw new Error("one or more products do not exist");
    }

    const consolidated = new Map();
    for (const item of items) {
      const current = consolidated.get(item.productId) || { ...item };
      if (current !== item) {
        current.quantity += item.quantity;
      }
      consolidated.set(item.productId, current);
    }

    for (const [productId, item] of consolidated.entries()) {
      const product = productMap.get(productId);
      if (product.stock < item.quantity) {
        throw new Error(`insufficient stock for product ${productId}`);
      }
    }

    const orderTotal = toMoney(
      items.reduce((sum, item) => sum + item.price * item.quantity, 0)
    );

    const orderResult = await client.query(
      `INSERT INTO orders(customer_id, total, status)
       VALUES($1, $2, $3)
       RETURNING id, created_at`,
      [customerId, orderTotal, "CREATED"]
    );

    const orderId = orderResult.rows[0].id;
    const createdAt = new Date(orderResult.rows[0].created_at).toISOString();

    for (const item of items) {
      await client.query(
        `INSERT INTO order_items(order_id, product_id, quantity, price)
         VALUES($1, $2, $3, $4)`,
        [orderId, item.productId, item.quantity, toMoney(item.price)]
      );

      await client.query(
        `UPDATE products
         SET stock = stock - $1, updated_at = NOW()
         WHERE id = $2`,
        [item.quantity, item.productId]
      );
    }

    const eventItems = items.map((item) => {
      const product = productMap.get(item.productId);
      return {
        productId: item.productId,
        quantity: item.quantity,
        price: toMoney(item.price),
        category: product.category,
      };
    });

    await client.query(
      `INSERT INTO outbox(topic, payload)
       VALUES($1, $2::jsonb)`,
      [
        "order-events",
        JSON.stringify({
          eventType: "OrderCreated",
          orderId,
          customerId,
          items: eventItems,
          total: orderTotal,
          timestamp: createdAt,
        }),
      ]
    );

    await client.query("COMMIT");
    return res.status(201).json({ orderId });
  } catch (error) {
    await client.query("ROLLBACK");
    const message = error.message.includes("insufficient stock") || error.message.includes("do not exist")
      ? error.message
      : "failed to create order";
    const statusCode = message === "failed to create order" ? 500 : 400;
    return res.status(statusCode).json({ error: message });
  } finally {
    client.release();
  }
});

async function start() {
  try {
    await initSchema();
    startPublisher();

    app.listen(port, () => {
      console.log(`command-service listening on ${port}`);
    });
  } catch (error) {
    console.error("command-service failed to start:", error);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down command-service...`);
  await stopPublisher();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start();
