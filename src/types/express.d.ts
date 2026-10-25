import type { Role } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      authUser?: {
        id: string;
        email: string | null;
        name: string | null;
        image: string | null;
        role: Role;
      };
      /** True while the signed-in account has not received its starter workspace (users.onboarded_at is NULL). */
      needsStarterData?: boolean;
    }
  }
}

export {};
