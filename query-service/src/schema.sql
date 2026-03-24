CREATE TABLE IF NOT EXISTS product_sales_view (
  product_id INTEGER PRIMARY KEY,
  total_quantity_sold BIGINT NOT NULL DEFAULT 0,
  total_revenue NUMERIC(14, 2) NOT NULL DEFAULT 0,
  order_count BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS category_metrics_view (
  category_name VARCHAR(100) PRIMARY KEY,
  total_revenue NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_orders BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customer_ltv_view (
  customer_id INTEGER PRIMARY KEY,
  total_spent NUMERIC(14, 2) NOT NULL DEFAULT 0,
  order_count BIGINT NOT NULL DEFAULT 0,
  last_order_date TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS hourly_sales_view (
  hour_timestamp TIMESTAMPTZ PRIMARY KEY,
  total_orders BIGINT NOT NULL DEFAULT 0,
  total_revenue NUMERIC(14, 2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_processed_event_timestamp TIMESTAMPTZ NULL
);

INSERT INTO sync_state(id, last_processed_event_timestamp)
VALUES(1, NULL)
ON CONFLICT (id) DO NOTHING;
