import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prismaMock, resetPrismaMock, sqlText } from "./helpers/prisma-mock.js";
import { affectsSalesMetrics, refreshSalesMetrics } from "../../src/services/analytics.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const CAT_A = "00000000-0000-4000-8000-0000000000aa";
const CAT_B = "00000000-0000-4000-8000-0000000000bb";
const tx = prismaMock as unknown as Prisma.TransactionClient;
const day = new Date("2026-10-20T15:00:00.000Z");

beforeEach(() => resetPrismaMock());

describe("sales metrics refresh", () => {
  it("locks the day, then deletes stale rows and upserts only the affected categories", async () => {
    await refreshSalesMetrics(tx, day, OWNER_ID, [CAT_B, CAT_A, CAT_B]);

    const statements = prismaMock.$executeRaw.mock.calls.map(sqlText);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("pg_advisory_xact_lock");
    expect((prismaMock.$executeRaw.mock.calls[0]![0] as { values: unknown[] }).values).toEqual([`metrics:${OWNER_ID}:2026-10-20`]);
    expect(statements[1]).toMatch(/DELETE FROM "sales_daily_metrics"[\s\S]*NOT EXISTS/);
    expect(statements[2]).toMatch(/ON CONFLICT \("day", "category_id", "is_test_data"\) DO UPDATE/);
    for (const call of prismaMock.$executeRaw.mock.calls.slice(1)) {
      expect(sqlText(call)).toContain("= ANY(");
      expect((call[0] as { values: unknown[] }).values).toContainEqual([CAT_A, CAT_B]);
    }
  });

  it("recomputes the whole day when no category list is given (fixture reset)", async () => {
    await refreshSalesMetrics(tx, day, OWNER_ID);
    const statements = prismaMock.$executeRaw.mock.calls.map(sqlText);
    expect(statements).toHaveLength(3);
    expect(statements.slice(1).join("\n")).not.toContain("= ANY(");
  });

  it("does nothing for an empty category list", async () => {
    await refreshSalesMetrics(tx, day, OWNER_ID, []);
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("treats only transitions into or out of CANCELLED as metric changes", () => {
    expect(affectsSalesMetrics("PENDING", "PROCESSING")).toBe(false);
    expect(affectsSalesMetrics("PENDING", "PENDING")).toBe(false);
    expect(affectsSalesMetrics("SHIPPED", "CANCELLED")).toBe(true);
    expect(affectsSalesMetrics("CANCELLED", "DELIVERED")).toBe(true);
  });
});
