# E-commerce CQRS + Event-Driven Analytics

A full containerized backend implementing CQRS and event-driven analytics with:
- Command Service (write model, transactional outbox)
- RabbitMQ broker (async event transport)
- Consumer Service (idempotent projection updates)
- Query Service (read model analytics API)
- PostgreSQL write/read databases

## Architecture

- Write model (normalized): `products`, `orders`, `order_items`, `outbox`
- Read model (denormalized/materialized tables):
  - `product_sales_view`
  - `category_metrics_view`
  - `customer_ltv_view`
  - `hourly_sales_view`
- Reliability: transactional outbox pattern
- Delivery semantics: at-least-once delivery from broker + idempotent consumer (`processed_events`)
- Consistency model: eventual consistency with lag introspection via `/api/analytics/sync-status`

See [docs/data-flow.md](docs/data-flow.md) for an architecture diagram.

## Tech Stack

- Node.js (Express)
- PostgreSQL 14
- RabbitMQ 3 (management plugin)
- Docker Compose

## Project Structure

- `docker-compose.yml`
- `.env.example`
- `submission.json`
- `command-service/`
- `consumer-service/`
- `query-service/`
- `tests/e2e.mjs`
- `docs/data-flow.md`

## One-Command Setup

```bash
docker compose up --build
```

Services:
- Command Service: `http://localhost:8080`
- Query Service: `http://localhost:8081`
- RabbitMQ Management UI: `http://localhost:15672` (guest / guest)
- Write DB: `localhost:5432`
- Read DB: `localhost:5433`

## Environment Variables

Documented in `.env.example`. Core values:
- `DATABASE_URL`
- `READ_DATABASE_URL`
- `BROKER_URL`
- `BROKER_QUEUE`
- `COMMAND_SERVICE_PORT`
- `QUERY_SERVICE_PORT`
- `OUTBOX_POLL_INTERVAL_MS`
- `OUTBOX_BATCH_SIZE`

## API

### Command Service

- `GET /health`
- `POST /api/products`
  - Body:
    ```json
    {
      "name": "string",
      "category": "string",
      "price": 100,
      "stock": 10
    }
    ```
  - Response `201`:
    ```json
    { "productId": 1 }
    ```
- `PUT /api/products/{productId}`
  - Supports partial updates to `name`, `category`, `price`, `stock`
- `POST /api/orders`
  - Body:
    ```json
    {
      "customerId": 123,
      "items": [
        { "productId": 1, "quantity": 2, "price": 100 }
      ]
    }
    ```
  - Response `201`:
    ```json
    { "orderId": 1 }
    ```

### Query Service

- `GET /health`
- `GET /api/analytics/products/{productId}/sales`
- `GET /api/analytics/categories/{category}/revenue`
- `GET /api/analytics/customers/{customerId}/lifetime-value`
- `GET /api/analytics/sync-status`

## Data Model

### Write DB (`db`)

- `products(id, name, category, price, stock, created_at, updated_at)`
- `orders(id, customer_id, total, status, created_at)`
- `order_items(id, order_id, product_id, quantity, price)`
- `outbox(id, topic, payload, created_at, published_at)`

### Read DB (`read-db`)

- `product_sales_view(product_id, total_quantity_sold, total_revenue, order_count)`
- `category_metrics_view(category_name, total_revenue, total_orders)`
- `customer_ltv_view(customer_id, total_spent, order_count, last_order_date)`
- `hourly_sales_view(hour_timestamp, total_orders, total_revenue)`
- `processed_events(event_id, processed_at)`
- `sync_state(id, last_processed_event_timestamp)`

## Event Flow

1. Command request arrives (`POST /api/products` or `POST /api/orders`).
2. Command service executes a DB transaction:
   - writes business rows to normalized tables
   - writes event row to `outbox`
3. Background outbox publisher polls unpublished rows and publishes to RabbitMQ.
4. Consumer reads events and applies idempotent updates to read-model tables.
5. Query service serves fast analytics from read-model tables.

## Idempotency Strategy

Consumer uses `processed_events(event_id)`:
- Insert `event_id` with `ON CONFLICT DO NOTHING`.
- If already present, event is acknowledged and skipped.
- This guarantees duplicate delivery does not duplicate projections.

## Verify Manually

Create product:
```bash
curl -X POST http://localhost:8080/api/products \
  -H "content-type: application/json" \
  -d '{"name":"Mouse","category":"electronics","price":25,"stock":100}'
```

Create order:
```bash
curl -X POST http://localhost:8080/api/orders \
  -H "content-type: application/json" \
  -d '{"customerId":7,"items":[{"productId":1,"quantity":2,"price":25}]}'
```

Query analytics:
```bash
curl http://localhost:8081/api/analytics/products/1/sales
curl http://localhost:8081/api/analytics/categories/electronics/revenue
curl http://localhost:8081/api/analytics/customers/7/lifetime-value
curl http://localhost:8081/api/analytics/sync-status
```

## Automated E2E Script

After `docker compose up --build`:

```bash
node tests/e2e.mjs
```

The script validates:
- Product + orders creation
- Eventual convergence of read models
- Product sales, category revenue, customer LTV, and sync status endpoints

## Notes

- This implementation uses a polling outbox publisher. For production-grade throughput and observability, CDC-based outbox (Debezium) is recommended.
- The read side is eventually consistent by design.
