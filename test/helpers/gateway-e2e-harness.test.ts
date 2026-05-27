import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { postJson } from "./gateway-e2e-harness.js";

let server: Server | undefined;

afterEach(async () => {
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

async function listen(handler: Parameters<typeof createServer>[0]): Promise<string> {
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
