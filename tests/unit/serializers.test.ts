import { describe, expect, it } from "vitest";
import { serializeOrder, serializeProduct } from "../../src/domain/serializers.js";

const decimal = (value: string) => ({ toFixed: () => value });

describe("API serializers", () => {
  it("serializes product decimals as fixed two-decimal strings", () => {
    const product = {
      id: "product-1",
      name: "Taza",
      price: decimal("120.00"),
      cost: decimal("45.00"),
    };

    expect(serializeProduct(product)).toEqual({
      id: "product-1",
      name: "Taza",
      price: "120.00",
      cost: "45.00",
    });
  });

  it("serializes order totals, line snapshots, and nested product amounts", () => {
    const order = {
      id: "order-1",
      total: decimal("240.00"),
      margin: decimal("150.00"),
      items: [{
        quantity: 2,
        unitPrice: decimal("120.00"),
        unitCost: decimal("45.00"),
        product: {
          id: "product-1",
          name: "Taza",
          price: decimal("125.00"),
          cost: decimal("50.00"),
        },
      }],
    };

    expect(serializeOrder(order)).toEqual({
      id: "order-1",
      total: "240.00",
      margin: "150.00",
      items: [{
        quantity: 2,
        unitPrice: "120.00",
        unitCost: "45.00",
        product: { id: "product-1", name: "Taza", price: "125.00", cost: "50.00" },
      }],
    });
  });
});
