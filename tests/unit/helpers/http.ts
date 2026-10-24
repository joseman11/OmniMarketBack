import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express } from "express";

export interface TestServer {
  request(method: string, path: string, init?: { headers?: Record<string, string>; body?: unknown; rawBody?: string }): Promise<{
    status: number;
    headers: Headers;
    body: unknown;
  }>;
  close(): Promise<void>;
}

/** Serves an Express app on an ephemeral local port so tests exercise the real middleware chain. */
export async function startServer(app: Express): Promise<TestServer> {
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    async request(method, path, init = {}) {
      const hasBody = init.body !== undefined || init.rawBody !== undefined;
      const response = await fetch(`${base}${path}`, {
        method,
        redirect: "manual",
        headers: { ...(hasBody ? { "Content-Type": "application/json" } : {}), ...init.headers },
        ...(hasBody ? { body: init.rawBody ?? JSON.stringify(init.body) } : {}),
      });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // Non-JSON bodies are returned as text.
      }
      return { status: response.status, headers: response.headers, body };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
