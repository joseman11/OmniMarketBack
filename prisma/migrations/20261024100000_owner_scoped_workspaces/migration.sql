-- Each account owns an isolated workspace: customers, catalog, orders and metrics are scoped by owner_id.

-- AddColumn (nullable until existing rows are backfilled)
ALTER TABLE "categories" ADD COLUMN "owner_id" UUID;
ALTER TABLE "customers" ADD COLUMN "owner_id" UUID;
ALTER TABLE "orders" ADD COLUMN "owner_id" UUID;
ALTER TABLE "products" ADD COLUMN "owner_id" UUID;
ALTER TABLE "sales_daily_metrics" ADD COLUMN "owner_id" UUID;

-- Backfill: audit fixtures belong to the test administrator; every pre-existing real row was part of the
-- single shared workspace, so it moves as a whole to the first real administrator (or first real user).
DO $$
DECLARE
  test_owner CONSTANT UUID := '00000000-0000-4000-8000-000000000001';
  legacy_owner UUID;
BEGIN
  SELECT "id" INTO legacy_owner
  FROM "users"
  WHERE "id" <> test_owner
  ORDER BY ("role" = 'ADMIN') DESC, "created_at" ASC, "id" ASC
  LIMIT 1;

  UPDATE "categories" SET "owner_id" = CASE WHEN "is_test_data" THEN test_owner ELSE legacy_owner END;
  UPDATE "customers" SET "owner_id" = CASE WHEN "is_test_data" THEN test_owner ELSE legacy_owner END;
  UPDATE "products" SET "owner_id" = CASE WHEN "is_test_data" THEN test_owner ELSE legacy_owner END;
  UPDATE "orders" SET "owner_id" = CASE WHEN "is_test_data" THEN test_owner ELSE legacy_owner END;
  UPDATE "sales_daily_metrics" m SET "owner_id" = c."owner_id" FROM "categories" c WHERE c."id" = m."category_id";
END $$;

ALTER TABLE "categories" ALTER COLUMN "owner_id" SET NOT NULL;
ALTER TABLE "customers" ALTER COLUMN "owner_id" SET NOT NULL;
ALTER TABLE "orders" ALTER COLUMN "owner_id" SET NOT NULL;
ALTER TABLE "products" ALTER COLUMN "owner_id" SET NOT NULL;
ALTER TABLE "sales_daily_metrics" ALTER COLUMN "owner_id" SET NOT NULL;

-- Uniqueness is now per workspace
DROP INDEX "categories_name_key";
DROP INDEX "categories_slug_key";
DROP INDEX "customers_email_key";
DROP INDEX "products_sku_key";

CREATE UNIQUE INDEX "categories_owner_id_name_key" ON "categories"("owner_id", "name");
CREATE UNIQUE INDEX "categories_owner_id_slug_key" ON "categories"("owner_id", "slug");
CREATE UNIQUE INDEX "customers_owner_id_email_key" ON "customers"("owner_id", "email");
CREATE UNIQUE INDEX "products_owner_id_sku_key" ON "products"("owner_id", "sku");
CREATE INDEX "orders_owner_id_status_position_idx" ON "orders"("owner_id", "status", "position");
CREATE INDEX "orders_owner_id_created_at_idx" ON "orders"("owner_id", "created_at");
CREATE INDEX "products_owner_id_category_id_idx" ON "products"("owner_id", "category_id");
CREATE INDEX "sales_daily_metrics_owner_id_day_idx" ON "sales_daily_metrics"("owner_id", "day");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "categories" ADD CONSTRAINT "categories_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_daily_metrics" ADD CONSTRAINT "sales_daily_metrics_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
