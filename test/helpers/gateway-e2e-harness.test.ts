// Gateway E2E harness tests cover helper server and probe behavior.
import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectGatewayStatusClient, postJson } from "./gateway-e2e-harness.js";

const gatewayClientState = vi.hoisted(() => ({
  clients: [] as Array<{ stopped: boolean }>,
}));

vi.mock("../../src/gateway/client.js", () => ({
  GatewayClient: class {
    stopped = false;

    constructor() {
      gatewayClientState.clients.push(this);
    }

    start() {}

    stop() {
      this.stopped = true;
    }
  },
}));

let server: Server | undefined;

afterEach(async () => {
  gatewayClientState.clients.length = 0;
  if (!server) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  server = undefined;
});

async function listen(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not get a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("postJson", () => {
  it("times out stalled Gateway HTTP helpers", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"ok":');
    });

    await expect(postJson(`${baseUrl}/stall`, {}, undefined, { timeoutMs: 25 })).rejects.toThrow(
      "timed out after 25ms",
    );
  });

  it("uses a wall-clock timeout instead of an idle socket timeout", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const interval = setInterval(() => {
        res.write(" ");
      }, 5);
      res.on("close", () => {
        clearInterval(interval);
      });
    });

    await expect(postJson(`${baseUrl}/slow`, {}, undefined, { timeoutMs: 30 })).rejects.toThrow(
      "timed out after 30ms",
    );
  });

  it("rejects oversized Gateway HTTP helper responses", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: "x".repeat(128) }));
    });

    await expect(
      postJson(`${baseUrl}/large`, {}, undefined, { maxResponseBytes: 32 }),
    ).rejects.toThrow("response exceeded 32 bytes");
  });
});

describe("connectGatewayStatusClient", () => {
  it("stops a client when the status hello times out", async () => {
    const inst = {
      homeDir: "",
      name: "timeout",
      port: 1,
      gatewayToken: "token",
    } as Parameters<typeof connectGatewayStatusClient>[0];

    await expect(connectGatewayStatusClient(inst, 1)).rejects.toThrow(
      "timeout waiting for status client hello for timeout",
    );
    expect(gatewayClientState.clients).toHaveLength(1);
    expect(gatewayClientState.clients[0]?.stopped).toBe(true);
  });
});
