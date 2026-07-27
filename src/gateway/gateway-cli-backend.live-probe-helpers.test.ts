/**
 * Tests for live-probe helpers that validate the CLI MCP loopback backend.
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createTcpServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyCliCronMcpLoopbackPreflight } from "./gateway-cli-backend.live-probe-helpers.js";
import {
  clearActiveMcpLoopbackRuntimeByOwnerToken,
  setActiveMcpLoopbackRuntime,
} from "./mcp-http.loopback-runtime.js";

const ownerToken = "test-owner-token";

function activateLoopbackRuntime(port: number): void {
  setActiveMcpLoopbackRuntime({
    port,
    ownerToken,
    nonOwnerToken: "test-non-owner-token",
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  return address.port;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function preflightParams(env: NodeJS.ProcessEnv = {}) {
  return {
    sessionKey: "session-key",
    port: 12345,
    token: "gateway-token",
    env,
  };
}

describe("gateway CLI backend live probe helpers", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken);
  });

  it("reads loopback JSON-RPC responses without invoking cron verification when cron is absent", async () => {
    const methods: string[] = [];
    const server = createHttpServer((request, response) => {
      void (async () => {
        const body = JSON.parse(await readRequestBody(request)) as {
          id?: unknown;
          method?: string;
        };
        if (body.method) {
          methods.push(body.method);
        }
        if (body.method === "notifications/initialized") {
          response.writeHead(202);
          response.end();
          return;
        }
        writeJson(response, 200, {
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: body.method === "tools/list" ? { tools: [] } : {},
        });
      })();
    });
    const port = await listen(server);
    activateLoopbackRuntime(port);
    try {
      await expect(verifyCliCronMcpLoopbackPreflight(preflightParams())).rejects.toThrow(
        "mcp loopback tools/list did not expose cron",
      );
      expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    } finally {
      server.close();
    }
  });

  it("bounds loopback JSON-RPC calls when the server accepts connections but never responds", async () => {
    const sockets = new Set<Socket>();
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", () => {});
    });
    const port = await listen(server);
    activateLoopbackRuntime(port);
    const startedAt = Date.now();
    try {
      await expect(
        verifyCliCronMcpLoopbackPreflight(
          preflightParams({ OPENCLAW_MCP_LOOPBACK_PROBE_TIMEOUT_MS: "100" }),
        ),
      ).rejects.toThrow(/aborted|AbortError/iu);
      expect(Date.now() - startedAt).toBeLessThan(2_500);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
    }
  });

  it("caps loopback JSON-RPC response bodies", async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("x".repeat(256));
    });
    const port = await listen(server);
    activateLoopbackRuntime(port);
    try {
      await expect(
        verifyCliCronMcpLoopbackPreflight(
          preflightParams({ OPENCLAW_MCP_LOOPBACK_PROBE_MAX_BODY_BYTES: "64" }),
        ),
      ).rejects.toThrow("mcp loopback response body exceeded 64 bytes");
    } finally {
      server.close();
    }
  });

  it("preserves the byte-limit diagnostic when body cancellation rejects", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    const cancel = vi.fn(() => {
      throw new Error("loopback body cancellation failed");
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    activateLoopbackRuntime(12345);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await expect(
        verifyCliCronMcpLoopbackPreflight(
          preflightParams({ OPENCLAW_MCP_LOOPBACK_PROBE_MAX_BODY_BYTES: "64" }),
        ),
      ).rejects.toThrow("mcp loopback response body exceeded 64 bytes");
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandledRejections).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      expect(process.listeners("unhandledRejection")).not.toContain(onUnhandledRejection);
    }
  });

  it("still propagates loopback response read errors and releases the reader lock", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("loopback response read failed"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    activateLoopbackRuntime(12345);

    await expect(verifyCliCronMcpLoopbackPreflight(preflightParams())).rejects.toThrow(
      "loopback response read failed",
    );
    expect(body.locked).toBe(false);
  });
});
