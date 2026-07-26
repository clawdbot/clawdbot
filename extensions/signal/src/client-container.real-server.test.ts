// Real-behavior proof (real sockets, real undici fetch, real timers): a live HTTP
// endpoint that sends headers and then stalls or slow-drips its body must be bounded
// by the request deadline, not only by the per-chunk idle guard. This exercises the
// production containerRpcRequest -> containerRestRequest -> readSignalRestText path
// without mocking fetch, unlike the fake-timer unit tests.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { containerRpcRequest } from "./client-container.js";

type StartedServer = { baseUrl: string; close: () => Promise<void> };

const running: StartedServer[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.close();
  }
});

async function startServer(handler: http.RequestListener): Promise<StartedServer> {
  const server = http.createServer(handler);
  server.on("clientError", () => {});
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const started: StartedServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  running.push(started);
  return started;
}

describe("signal REST real-server deadline", () => {
  it("aborts a slow-drip body that never idles, at the request deadline", async () => {
    // Drip a byte every 50ms: below the 300ms idle guard, so only the total request
    // deadline can stop it. This is the exact slow-drip case the fix bounds.
    let dripCount = 0;
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      const drip = setInterval(() => {
        try {
          dripCount += 1;
          res.write(" ");
        } catch {
          clearInterval(drip);
        }
      }, 50);
      res.on("close", () => clearInterval(drip));
    });

    const startedAt = Date.now();
    await expect(
      containerRpcRequest("version", undefined, { baseUrl: server.baseUrl, timeoutMs: 300 }),
    ).rejects.toThrow(/Signal REST request timed out|stalled/);
    const elapsedMs = Date.now() - startedAt;

    // Multiple chunks arrived below the idle threshold, yet the absolute deadline
    // still bounded the call. Without it, this response would continue indefinitely.
    expect(dripCount).toBeGreaterThan(1);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("aborts a response whose body stalls immediately after headers", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      // Never ends the body.
    });

    const startedAt = Date.now();
    await expect(
      containerRpcRequest("version", undefined, { baseUrl: server.baseUrl, timeoutMs: 300 }),
    ).rejects.toThrow(/Signal REST (request timed out|response body stalled)/);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("returns the parsed body when it completes within the deadline", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ versions: ["v1"], build: 2 }));
    });

    const result = await containerRpcRequest<{ versions?: string[]; build?: number }>(
      "version",
      undefined,
      { baseUrl: server.baseUrl, timeoutMs: 1_000 },
    );
    expect(result).toEqual({ versions: ["v1"], build: 2 });
  });
});
