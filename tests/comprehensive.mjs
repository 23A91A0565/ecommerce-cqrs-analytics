const COMMAND_URL = "http://localhost:8080";
const QUERY_URL = "http://localhost:8081";

async function req(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "content-type": "application/json", ...opts.headers },
    ...opts,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}: ${error.message}`);
    process.exit(1);
  }
}

async function main() {
  console.log("=== CORE REQUIREMENT TESTS ===\n");

  await test("CMD-REQ1: POST /api/products creates product", async () => {
    const res = await req(`${COMMAND_URL}/api/products`, {
      method: "POST",
      body: JSON.stringify({
        name: "Test Product",
        category: "test",
        price: 50,
        stock: 100,
      }),
    });
    assert(res.status === 201, `expected 201 got ${res.status}`);
    assert(res.body.productId, "missing productId");
  });

  await test("CMD-REQ2: POST /api/orders creates order", async () => {
    const prod = await req(`${COMMAND_URL}/api/products`, {
      method: "POST",
      body: JSON.stringify({
        name: "Test Item",
        category: "test",
        price: 100,
        stock: 10,
      }),
    });
    const productId = prod.body.productId;

    const order = await req(`${COMMAND_URL}/api/orders`, {
      method: "POST",
      body: JSON.stringify({
        customerId: 123,
        items: [{ productId, quantity: 2, price: 100 }],
      }),
    });
    assert(order.status === 201, `expected 201 got ${order.status}`);
    assert(order.body.orderId, "missing orderId");
  });

  await test("CMD-REQ3: POST /api/products validation (missing name)", async () => {
    const res = await req(`${COMMAND_URL}/api/products`, {
      method: "POST",
      body: JSON.stringify({ category: "test", price: 50, stock: 100 }),
    });
    assert(res.status === 400, `expected 400 got ${res.status}`);
  });

  await test("CMD-REQ4: POST /api/orders with insufficient stock", async () => {
    const prod = await req(`${COMMAND_URL}/api/products`, {
      method: "POST",
      body: JSON.stringify({
        name: "Low Stock",
        category: "test",
        price: 50,
        stock: 1,
      }),
    });
    const productId = prod.body.productId;

    const order = await req(`${COMMAND_URL}/api/orders`, {
      method: "POST",
      body: JSON.stringify({
        customerId: 456,
        items: [{ productId, quantity: 100, price: 50 }],
      }),
    });
    assert(order.status === 400, `expected 400 got ${order.status}`);
    assert(order.body.error.includes("insufficient"), "should mention insufficient stock");
  });

  await test("QUERY-REQ1: GET /api/analytics/products/{productId}/sales", async () => {
    const prod = await req(`${COMMAND_URL}/api/products`, {
      method: "POST",
      body: JSON.stringify({
        name: "Sales Test",
        category: "test",
        price: 75,
        stock: 20,
      }),
    });
    const productId = prod.body.productId;

    await req(`${COMMAND_URL}/api/orders`, {
      method: "POST",
      body: JSON.stringify({
        customerId: 789,
        items: [{ productId, quantity: 3, price: 75 }],
      }),
    });

    await new Promise((r) => setTimeout(r, 3000));

    const sales = await req(
      `${QUERY_URL}/api/analytics/products/${productId}/sales`
    );
    assert(sales.status === 200, `expected 200 got ${sales.status}`);
    assert(typeof sales.body.totalQuantitySold === "number", "missing totalQuantitySold");
    assert(typeof sales.body.totalRevenue === "number", "missing totalRevenue");
    assert(typeof sales.body.orderCount === "number", "missing orderCount");
  });

  await test("QUERY-REQ2: GET /api/analytics/categories/{category}/revenue", async () => {
    const cat = await req(
      `${QUERY_URL}/api/analytics/categories/test/revenue`
    );
    assert(cat.status === 200, `expected 200 got ${cat.status}`);
    assert(typeof cat.body.totalRevenue === "number", "missing totalRevenue");
    assert(typeof cat.body.totalOrders === "number", "missing totalOrders");
  });

  await test("QUERY-REQ3: GET /api/analytics/customers/{customerId}/lifetime-value", async () => {
    const ltv = await req(
      `${QUERY_URL}/api/analytics/customers/789/lifetime-value`
    );
    assert(ltv.status === 200, `expected 200 got ${ltv.status}`);
    assert(typeof ltv.body.totalSpent === "number", "missing totalSpent");
    assert(typeof ltv.body.orderCount === "number", "missing orderCount");
    assert(
      ltv.body.lastOrderDate === null || typeof ltv.body.lastOrderDate === "string",
      "lastOrderDate should be null or ISO string"
    );
  });

  await test("QUERY-REQ4: GET /api/analytics/sync-status", async () => {
    const sync = await req(`${QUERY_URL}/api/analytics/sync-status`);
    assert(sync.status === 200, `expected 200 got ${sync.status}`);
    assert(
      typeof sync.body.lagSeconds === "number",
      "missing lagSeconds"
    );
    assert(
      sync.body.lastProcessedEventTimestamp === null ||
        typeof sync.body.lastProcessedEventTimestamp === "string",
      "lastProcessedEventTimestamp should be null or ISO string"
    );
  });

  await test("CMD-REQ5: PUT /api/products/{productId} updates product", async () => {
    const prod = await req(`${COMMAND_URL}/api/products`, {
      method: "POST",
      body: JSON.stringify({
        name: "Original Name",
        category: "original",
        price: 100,
        stock: 10,
      }),
    });
    const productId = prod.body.productId;

    const update = await req(
      `${COMMAND_URL}/api/products/${productId}`,
      {
        method: "PUT",
        body: JSON.stringify({ name: "Updated Name", price: 150 }),
      }
    );
    assert(update.status === 200, `expected 200 got ${update.status}`);
    assert(update.body.productId === productId, "productId mismatch");
  });

  await test("CMD-REQ6: PUT /api/products/{productId} non-existent product", async () => {
    const res = await req(
      `${COMMAND_URL}/api/products/999999`,
      {
        method: "PUT",
        body: JSON.stringify({ name: "Test" }),
      }
    );
    assert(res.status === 404, `expected 404 got ${res.status}`);
  });

  console.log(
    "\n=== ALL CORE REQUIREMENTS PASSED ===\n"
  );
}

main().catch((error) => {
  console.error("TEST SUITE FAILED:", error);
  process.exit(1);
});
