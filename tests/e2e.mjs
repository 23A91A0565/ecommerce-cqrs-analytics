const COMMAND_URL = process.env.COMMAND_URL || "http://localhost:8080";
const QUERY_URL = process.env.QUERY_URL || "http://localhost:8081";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function waitUntil(fn, timeoutMs = 20000, intervalMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const val = await fn();
    if (val) {
      return true;
    }
    await sleep(intervalMs);
  }
  return false;
}

async function main() {
  console.log("Creating product...");
  const productResp = await requestJson(`${COMMAND_URL}/api/products`, {
    method: "POST",
    body: JSON.stringify({
      name: "E2E Keyboard",
      category: "electronics",
      price: 100,
      stock: 20,
    }),
  });

  if (productResp.status !== 201 || !productResp.body?.productId) {
    throw new Error(`Product creation failed: ${productResp.status} ${JSON.stringify(productResp.body)}`);
  }
  const productId = productResp.body.productId;

  console.log("Creating orders...");
  const order1 = await requestJson(`${COMMAND_URL}/api/orders`, {
    method: "POST",
    body: JSON.stringify({
      customerId: 99,
      items: [{ productId, quantity: 2, price: 100 }],
    }),
  });

  const order2 = await requestJson(`${COMMAND_URL}/api/orders`, {
    method: "POST",
    body: JSON.stringify({
      customerId: 99,
      items: [{ productId, quantity: 1, price: 100 }],
    }),
  });

  if (order1.status !== 201 || order2.status !== 201) {
    throw new Error(`Order creation failed: ${order1.status}/${order2.status}`);
  }

  console.log("Waiting for eventual consistency...");
  const synced = await waitUntil(async () => {
    const sales = await requestJson(`${QUERY_URL}/api/analytics/products/${productId}/sales`);
    return sales.status === 200 && sales.body?.totalQuantitySold === 3 && sales.body?.orderCount === 2;
  });

  if (!synced) {
    throw new Error("Read model did not converge within timeout");
  }

  const sales = await requestJson(`${QUERY_URL}/api/analytics/products/${productId}/sales`);
  const categoryRevenue = await requestJson(`${QUERY_URL}/api/analytics/categories/electronics/revenue`);
  const customerLtv = await requestJson(`${QUERY_URL}/api/analytics/customers/99/lifetime-value`);
  const syncStatus = await requestJson(`${QUERY_URL}/api/analytics/sync-status`);

  console.log("Product Sales:", sales.body);
  console.log("Category Revenue:", categoryRevenue.body);
  console.log("Customer LTV:", customerLtv.body);
  console.log("Sync Status:", syncStatus.body);

  if (sales.body.totalRevenue !== 300) {
    throw new Error("Product revenue mismatch");
  }
  if (categoryRevenue.body.totalRevenue < 300) {
    throw new Error("Category revenue mismatch");
  }
  if (customerLtv.body.totalSpent < 300) {
    throw new Error("Customer LTV mismatch");
  }

  console.log("E2E test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
