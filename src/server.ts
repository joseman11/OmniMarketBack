import { config as loadEnv } from "dotenv";
import { createApp } from "./app.js";
import { getEnv } from "./config/env.js";
import { prisma } from "./db/prisma.js";

loadEnv({ quiet: true });

async function main(): Promise<void> {
  const env = getEnv();
  await prisma.$connect();
  const app = createApp();
  const server = app.listen(env.PORT, "0.0.0.0", () => {
    console.log(`OmniMarket API listening on port ${env.PORT}.`);
  });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}; closing the API.`);
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

main().catch(async (error: unknown) => {
  console.error("Could not start OmniMarket API.", error);
  await prisma.$disconnect();
  process.exit(1);
});
