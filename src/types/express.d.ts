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
    }
  }
}

export {};
