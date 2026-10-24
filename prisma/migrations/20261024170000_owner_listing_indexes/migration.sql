-- Additive indexes only: product listing ordered by name per workspace (GET /api/products) and
-- category-filtered daily metrics per workspace (analytics rows/summary and the scoped metrics refresh).
-- CreateIndex
CREATE INDEX "products_owner_id_name_id_idx" ON "products"("owner_id", "name", "id");

-- CreateIndex
CREATE INDEX "sales_daily_metrics_owner_id_category_id_day_idx" ON "sales_daily_metrics"("owner_id", "category_id", "day");

