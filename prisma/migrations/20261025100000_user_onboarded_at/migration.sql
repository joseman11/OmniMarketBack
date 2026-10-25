-- Additive and nullable: NULL means the account has not received its starter workspace yet.
ALTER TABLE "users" ADD COLUMN "onboarded_at" TIMESTAMP(3);
