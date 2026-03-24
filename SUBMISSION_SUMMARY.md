# Submission Summary

Project: E-commerce CQRS + Event-Driven Analytics
Date: 2026-03-23
Status: Ready for submission

## Implemented Scope

- Command service (write model) with transactional outbox
- Consumer service (idempotent event processing)
- Query service (read model analytics API)
- RabbitMQ broker
- PostgreSQL write database (`db`)
- PostgreSQL read database (`read-db`)
- Full Docker Compose orchestration with health checks

## Required Artifacts

- Present: `docker-compose.yml`
- Present: `.env.example`
- Present: `submission.json`
- Present: `README.md`
- Present: `command-service/Dockerfile`
- Present: `consumer-service/Dockerfile`
- Present: `query-service/Dockerfile`
- Present: `tests/e2e.mjs`
- Present: `docs/data-flow.md`

## Core Requirement Verification (Executed)

### 1) Containerized setup and health

Executed:
- `docker compose up -d`
- `docker compose ps`

Observed:
- Services up and healthy: `db`, `read-db`, `broker`, `command-service`, `consumer-service`, `query-service`
- Command service exposed on 8080
- Query service exposed on 8081

### 2) Write-side schema

Executed (inside container):
- `psql -U user -d write_db -c "\\dt"`
- `psql -U user -d write_db -c "SELECT column_name,data_type FROM information_schema.columns WHERE table_name='outbox' ORDER BY ordinal_position;"`

Observed:
- Tables present: `products`, `orders`, `order_items`, `outbox`
- `outbox` columns present: `id`, `topic`, `payload`, `created_at`, `published_at`

### 3) Read-side materialized tables

Executed (inside container):
- `psql -U user -d read_db -c "\\dt"`
- `psql -U user -d read_db -c "SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('product_sales_view','category_metrics_view','customer_ltv_view','hourly_sales_view') ORDER BY table_name, ordinal_position;"`

Observed:
- Present: `product_sales_view`, `category_metrics_view`, `customer_ltv_view`, `hourly_sales_view`
- Required columns verified for each

### 4) End-to-end command/query flow

Executed:
- `node tests/e2e.mjs`

Observed:
- Product creation succeeds
- Order creation succeeds
- Consumer projections converge
- Product sales endpoint returns expected totals
- Category revenue endpoint returns expected totals
- Customer lifetime value endpoint returns expected totals
- Sync status endpoint returns timestamp + lag

### 5) Outbox and publishing behavior

Executed:
- `SELECT id, topic, (payload->>'eventType') AS event_type, published_at IS NOT NULL AS published FROM outbox ORDER BY created_at DESC LIMIT 8;`

Observed:
- Events present in outbox
- `eventType` values include `OrderCreated`, `ProductCreated`, `ProductUpdated`, `PriceChanged`
- Published events show `published = true`

### 6) Explicit endpoint checks with live data

Executed via PowerShell `Invoke-RestMethod`:
- `POST /api/products`
- `POST /api/orders`
- `GET /api/analytics/products/{productId}/sales`
- `GET /api/analytics/categories/{category}/revenue`
- `GET /api/analytics/customers/{customerId}/lifetime-value`
- `GET /api/analytics/sync-status`

Observed:
- All endpoint contracts returned expected JSON keys and numeric aggregates
- Sync timestamp changed after creating a new order (eventual consistency lag endpoint works)

## Notes

- Consumer idempotency implemented using `processed_events(event_id)` with `ON CONFLICT DO NOTHING`.
- Outbox publishing implemented in command service background loop with RabbitMQ confirm channel.
- `docker-compose.yml` updated to remove obsolete `version` key warning.
