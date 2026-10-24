interface DecimalValue {
  toFixed(decimalPlaces?: number): string;
}

interface ProductAmounts {
  price: DecimalValue;
  cost: DecimalValue;
}

interface OrderItemAmounts {
  unitPrice: DecimalValue;
  unitCost: DecimalValue;
  product: ProductAmounts;
}

interface OrderAmounts {
  total: DecimalValue;
  margin: DecimalValue;
  items: OrderItemAmounts[];
}

export function serializeProduct<T extends ProductAmounts>(product: T) {
  return { ...product, price: product.price.toFixed(2), cost: product.cost.toFixed(2) };
}

export function serializeOrder<T extends OrderAmounts>(order: T) {
  return {
    ...order,
    total: order.total.toFixed(2),
    margin: order.margin.toFixed(2),
    items: order.items.map((item) => ({
      ...item,
      unitPrice: item.unitPrice.toFixed(2),
      unitCost: item.unitCost.toFixed(2),
      product: serializeProduct(item.product),
    })),
  };
}
