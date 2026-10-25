CREATE INDEX "sales_daily_metrics_owner_day_category_page_idx"
ON "sales_daily_metrics"("owner_id", "day" DESC, "category_id" ASC);
