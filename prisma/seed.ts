import { config as loadEnv } from "dotenv";
import { prisma } from "../src/db/prisma.js";
import { resetTestData } from "../src/services/test-fixtures.js";

loadEnv({ quiet: true });

async function main(): Promise<void> {
  const seeded = await resetTestData(prisma);
  console.log(`Seeded OmniMarket fixtures: ${seeded.orders} orders, ${seeded.products} products.`);
}

main()
  .catch((error: unknown) => {
    console.error("Seed failed.", error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
