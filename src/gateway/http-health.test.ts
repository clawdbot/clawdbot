import { describe, expect, it, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHealthEndpointsHandler } from "./http-health.js";
import type { ResolvedGatewayAuth } from "./auth.js";

const mockAuth: ResolvedGatewayAuth = {
  mode: "token",
  token: "test-token-123",
  allowTailscale: false,
};

function createTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
) {
  const server = createServer(async (req, res) => {
    const handled = await handler(req, res);
    if (!handled) {
      res.statusCode = 404;
      res.end("Not Found");
    }
  });
  return server;
}

async function startServer(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

async function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

describe("http-health", () => {
  let server: Server;
  let baseUrl: string;

  afterEach(async () => {
    if (server) {
      await stopServer(server);
    }
  });

  describe("GET /health", () => {
    it("returns 200 with healthy status when enabled", async () => {
      const handler = createHealthEndpointsHandler({
        config: { enabled: true },
        resolvedAuth: mockAuth,
      });
      server = createTestServer(handler);
      baseUrl = await startServer(server);

      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("healthy");
      expect(body.version).toBeDefined();
      expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(body.timestamp).toBeDefined();
    });

    it("returns 404 when disabled", async () => {
      const handler = createHealthEndpointsHandler({
        config: { enabled: false },
        resolvedAuth: mockAuth,
      });
      server = createTestServer(handler);
      baseUrl = await startServer(server);

      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(404);
    });

    it("respects custom basePath", async () => {
      const handler = createHealthEndpointsHandler({
        config: { enabled: true, basePath: "/api/v1" },
        resolvedAuth: mockAuth,
      });
      server = createTestServer(handler);
      baseUrl = await startServer(server);

      // Original path should 404
      const res1 = await fetch(`${baseUrl}/health`);
      expect(res1.status).toBe(404);

      // Custom path should work
      const res2 = await fetch(`${baseUrl}/api/v1/health`);
      expect(res2.status).toBe(200);
    });
  });

  describe("GET /ready", () => {
    it("returns 200 when healthy", async () => {
      const handler = createHealthEndpointsHandler({
        config: { enabled: true },
        resolvedAuth: mockAuth,
      });
      server = createTestServer(handler);
      baseUrl = await startServer(server);

      const res = await fetch(`${baseUrl}/ready`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("healthy");
    });
  });

  describe("GET /health/deep", () => {
    it("returns 401 without auth when deepAuthRequired is true", async () => {
      const handler = createHealthEndpointsHandler({
        config: { enabled: true, deepAuthRequired: true },
        resolvedAuth: mockAuth,
      });
      server = createTestServer(handler);
      baseUrl = await startServer(server);

      const res = await fetch(`${baseUrl}/health/deep`);
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 200 with valid auth", async () => {
      const handler = createHealthEndpointsHandler({
        config: { enabled: true, deepAuthRequired: true },
        resolvedAuth: mockAuth,
      });
      server = createTestServer(handler);
      baseUrl = await startServer(server);

      const res = await fetch(`${baseUrl}/health/deep`, {
        headers: {
          Authorization: `Bearer ${mockAuth.token}`,
        },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBeDefined();
      expect(body.checks).toBeDefined();
    });

    it("returns 200 without auth when deepAuthRequired is false", async () => {
      const handler = createHealthEndpointsHandler({
        config: { enabled: true, deepAuthRequired: false },
        resolvedAuth: mockAuth,
      });
      server = createTestServer(handler);
      baseUrl = await startServer(server);

      const res = await fetch(`${baseUrl}/health/deep`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.checks).toBeDefined();
    });
  });

  describe("response format", () => {
    it("includes Cache-Control: no-store header", async () => {
      const handler = createHealthEndpointsHandler({
        config: { enabled: true },
        resolvedAuth: mockAuth,
      });
      server = createTestServer(handler);
      baseUrl = await startServer(server);

      const res = await fetch(`${baseUrl}/health`);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("includes Content-Type: application/json header", async () => {
      const handler = createHealthEndpointsHandler({
        config: { enabled: true },
        resolvedAuth: mockAuth,
      });
      server = createTestServer(handler);
      baseUrl = await startServer(server);

      const res = await fetch(`${baseUrl}/health`);
      expect(res.headers.get("Content-Type")).toContain("application/json");
    });
  });
});
