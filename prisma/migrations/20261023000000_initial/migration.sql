CREATE TYPE "Role" AS ENUM ('OPERATOR', 'ADMIN');
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED');

CREATE TABLE "users" (
  "id" UUID NOT NULL,
  "name" TEXT,
  "email" TEXT,
  "email_verified" TIMESTAMP(3),
  "image" TEXT,
  "role" "Role" NOT NULL DEFAULT 'OPERATOR',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

CREATE TABLE "accounts" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "provider_account_id" TEXT NOT NULL,
  "refresh_token" TEXT,
  "access_token" TEXT,
  "expires_at" INTEGER,
  "token_type" TEXT,
  "scope" TEXT,
  "id_token" TEXT,
  "session_state" TEXT,
  CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "accounts_provider_provider_account_id_key" ON "accounts"("provider", "provider_account_id");
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

CREATE TABLE "sessions" (
  "id" UUID NOT NULL,
  "session_token" TEXT NOT NULL,
  "user_id" UUID NOT NULL,
  "expires" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sessions_session_token_key" ON "sessions"("session_token");
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

CREATE TABLE "verification_tokens" (
  "identifier" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "expires" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "verification_tokens_identifier_token_key" ON "verification_tokens"("identifier", "token");
CREATE UNIQUE INDEX "verification_tokens_token_key" ON "verification_tokens"("token");

CREATE TABLE "customers" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "city" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "is_test_data" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "customers_email_key" ON "customers"("email");
CREATE INDEX "customers_is_test_data_idx" ON "customers"("is_test_data");

CREATE TABLE "categories" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "is_test_data" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");
CREATE INDEX "categories_is_test_data_idx" ON "categories"("is_test_data");

CREATE TABLE "products" (
  "id" UUID NOT NULL,
  "category_id" UUID NOT NULL,
  "sku" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "price" DECIMAL(12,2) NOT NULL,
  "cost" DECIMAL(12,2) NOT NULL,
  "stock" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "is_test_data" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");
CREATE INDEX "products_category_id_idx" ON "products"("category_id");
CREATE INDEX "products_is_test_data_idx" ON "products"("is_test_data");
CREATE INDEX "products_is_test_data_category_id_idx" ON "products"("is_test_data", "category_id");

CREATE TABLE "orders" (
  "id" UUID NOT NULL,
  "order_number" TEXT NOT NULL,
  "customer_id" UUID NOT NULL,
  "created_by" UUID,
  "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
  "position" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 1,
  "total" DECIMAL(12,2) NOT NULL,
  "margin" DECIMAL(12,2) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "is_test_data" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");
CREATE INDEX "orders_customer_id_idx" ON "orders"("customer_id");
CREATE INDEX "orders_status_position_idx" ON "orders"("status", "position");
CREATE INDEX "orders_created_at_idx" ON "orders"("created_at");
CREATE INDEX "orders_is_test_data_idx" ON "orders"("is_test_data");
CREATE INDEX "orders_is_test_data_status_position_idx" ON "orders"("is_test_data", "status", "position");
CREATE INDEX "orders_is_test_data_created_at_idx" ON "orders"("is_test_data", "created_at");

CREATE TABLE "order_items" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unit_price" DECIMAL(12,2) NOT NULL,
  "unit_cost" DECIMAL(12,2) NOT NULL,
  CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");
CREATE INDEX "order_items_product_id_idx" ON "order_items"("product_id");

CREATE TABLE "order_status_history" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "changed_by" UUID,
  "from_status" "OrderStatus",
  "to_status" "OrderStatus" NOT NULL,
  "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "order_status_history_order_id_changed_at_idx" ON "order_status_history"("order_id", "changed_at");

CREATE TABLE "sales_daily_metrics" (
  "day" DATE NOT NULL,
  "category_id" UUID NOT NULL,
  "is_test_data" BOOLEAN NOT NULL DEFAULT false,
  "orders_count" INTEGER NOT NULL,
  "revenue" DECIMAL(14,2) NOT NULL,
  "avg_ticket" DECIMAL(12,2) NOT NULL,
  "gross_margin" DECIMAL(14,2) NOT NULL,
  CONSTRAINT "sales_daily_metrics_pkey" PRIMARY KEY ("day", "category_id", "is_test_data")
);
CREATE INDEX "sales_daily_metrics_category_id_idx" ON "sales_daily_metrics"("category_id");
CREATE INDEX "sales_daily_metrics_is_test_data_day_idx" ON "sales_daily_metrics"("is_test_data", "day");

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales_daily_metrics" ADD CONSTRAINT "sales_daily_metrics_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
