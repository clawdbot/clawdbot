// Real-transport proof: failed SSE connects cancel unread response bodies.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { describe, expect, it } from "vitest";
import { UrbitSSEClient } from "./sse-client.js";

const lookupLoopback = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("UrbitSSEClient connect-fail body cleanup", () => {
  it("cancels unread non-OK stream bodies and closes the request socket", async () => {
    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const server = createServer((request, response) => {
      request.socket.once("close", () => resolveClosed?.());
      response.writeHead(503, { "Content-Type": "text/event-stream" });
      response.write("retry: 1000\n");
    });

    const baseUrl = await listen(server);
    const client = new UrbitSSEClient(baseUrl, "urbauth-~zod=proof", {
      autoReconnect: false,
      ship: "zod",
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: lookupLoopback,
    });

    try {
      await expect(client.openStream()).rejects.toThrow(/Stream connection|503/);
      await expect(closed).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
