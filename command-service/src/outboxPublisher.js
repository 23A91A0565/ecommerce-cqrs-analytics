const amqp = require("amqplib");
const { pool } = require("./db");

const brokerUrl = process.env.BROKER_URL;
const queueName = process.env.BROKER_QUEUE || "analytics.events";
const pollIntervalMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS || 1000);
const batchSize = Number(process.env.OUTBOX_BATCH_SIZE || 100);

if (!brokerUrl) {
  throw new Error("BROKER_URL is required");
}

let connection;
let channel;
let loopTimer;

async function connectBroker() {
  connection = await amqp.connect(brokerUrl);
  channel = await connection.createConfirmChannel();
  await channel.assertQueue(queueName, { durable: true });

  connection.on("close", () => {
    channel = undefined;
    connection = undefined;
  });
}

async function flushOutboxBatch() {
  if (!channel) {
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT id, topic, payload, created_at
       FROM outbox
       WHERE published_at IS NULL
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batchSize]
    );

    for (const row of result.rows) {
      const payloadBuffer = Buffer.from(JSON.stringify(row.payload));
      channel.sendToQueue(queueName, payloadBuffer, {
        persistent: true,
        contentType: "application/json",
        messageId: row.id,
        timestamp: Date.now(),
        type: row.payload.eventType || row.topic,
      });

      await client.query(
        `UPDATE outbox
         SET published_at = NOW()
         WHERE id = $1 AND published_at IS NULL`,
        [row.id]
      );
    }

    if (result.rows.length > 0) {
      await channel.waitForConfirms();
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function startPublisher() {
  loopTimer = setInterval(async () => {
    try {
      if (!channel) {
        await connectBroker();
      }
      await flushOutboxBatch();
    } catch (error) {
      console.error("Outbox publisher error:", error.message);
    }
  }, pollIntervalMs);
}

async function stopPublisher() {
  if (loopTimer) {
    clearInterval(loopTimer);
  }
  if (channel) {
    await channel.close().catch(() => undefined);
  }
  if (connection) {
    await connection.close().catch(() => undefined);
  }
}

module.exports = {
  startPublisher,
  stopPublisher,
};
