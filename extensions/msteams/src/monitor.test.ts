import { once } from "node:events";
import type { Server } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";
import { applyMSTeamsWebhookTimeouts } from "./webhook-timeouts.js";

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function waitForSlowBodySocketClose(port: number, timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const startedAt = Date.now();
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.write("POST /api/messages HTTP/1.1\r\n");
      socket.write("Host: localhost\r\n");
      socket.write("Content-Type: application/json\r\n");
      socket.write("Content-Length: 1048576\r\n");
      socket.write("\r\n");
      socket.write('{"type":"message"');
    });
    socket.on("error", () => {
      // ECONNRESET is expected once the server drops the socket.
    });
    const failTimer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`socket stayed open for ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on("close", () => {
      clearTimeout(failTimer);
      resolve(Date.now() - startedAt);
    });
  });
}

describe("msteams monitor webhook hardening", () => {
  it("applies default timeouts and header clamp", async () => {
    const app = express();
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      applyMSTeamsWebhookTimeouts(server);

      expect(server.timeout).toBe(30_000);
      expect(server.requestTimeout).toBe(30_000);
      expect(server.headersTimeout).toBe(15_000);
    } finally {
      await closeServer(server);
    }
  });

  it("applies explicit webhook timeout values", async () => {
    const app = express();
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      applyMSTeamsWebhookTimeouts(server, {
        inactivityTimeoutMs: 3210,
        requestTimeoutMs: 6543,
        headersTimeoutMs: 9876,
      });

      expect(server.timeout).toBe(3210);
      expect(server.requestTimeout).toBe(6543);
      expect(server.headersTimeout).toBe(6543);
    } finally {
      await closeServer(server);
    }
  });

  it("clamps headers timeout when explicit value exceeds request timeout", async () => {
    const app = express();
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      applyMSTeamsWebhookTimeouts(server, {
        inactivityTimeoutMs: 12_000,
        requestTimeoutMs: 9_000,
        headersTimeoutMs: 15_000,
      });

      expect(server.timeout).toBe(12_000);
      expect(server.requestTimeout).toBe(9_000);
      expect(server.headersTimeout).toBe(9_000);
    } finally {
      await closeServer(server);
    }
  });

  it("drops slow-body webhook requests within configured inactivity timeout", async () => {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use((_req, res, _next) => {
      res.status(401).end("unauthorized");
    });
    app.post("/api/messages", (_req, res) => {
      res.end("ok");
    });

    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      applyMSTeamsWebhookTimeouts(server, {
        inactivityTimeoutMs: 400,
        requestTimeoutMs: 1500,
        headersTimeoutMs: 1500,
      });

      const port = (server.address() as AddressInfo).port;
      const closedMs = await waitForSlowBodySocketClose(port, 3000);
      expect(closedMs).toBeLessThan(2500);
    } finally {
      await closeServer(server);
    }
  });
});
