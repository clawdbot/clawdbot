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

  it.each([
    { action: "subscribe", status: 200 },
    { action: "ack", status: 200 },
    { action: "ack", status: 503 },
  ])("closes the unread $action response with status $status", async ({ action, status }) => {
    let observedAction: string | undefined;
    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.once("end", () => {
        const [payload] = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Array<{
          action: string;
        }>;
        observedAction = payload?.action;
        request.socket.once("close", () => resolveClosed?.());
        response.writeHead(status, { "Content-Type": "application/json" });
        response.write('{"result":"streaming');
      });
    });
    const baseUrl = await listen(server);
    const client = new UrbitSSEClient(baseUrl, "urbauth-~zod=proof", {
      autoReconnect: false,
      ship: "zod",
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: lookupLoopback,
    });

    try {
      if (action === "subscribe") {
        client.isConnected = true;
        await client.subscribe({ app: "chat", path: "/inbox" });
      } else {
        const handled = client.processEvent('id: 20\ndata: {"json":{"ok":true}}');
        if (status === 200) {
          await handled;
        } else {
          await expect(handled).rejects.toThrow("Ack failed with status 503");
        }
      }

      expect(observedAction).toBe(action);
      await expect(closed).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps a successful event stream live until its owner closes the client", async () => {
    let resolveEvent: ((value: unknown) => void) | undefined;
    const delivered = new Promise<unknown>((resolve) => {
      resolveEvent = resolve;
    });
    let resolveStreamClosed: (() => void) | undefined;
    const streamClosed = new Promise<void>((resolve) => {
      resolveStreamClosed = resolve;
    });
    let streamSocket: import("node:net").Socket | undefined;
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        streamSocket = request.socket;
        streamSocket.once("close", () => resolveStreamClosed?.());
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write('id: 1\ndata: {"id":1,"json":{"message":"delivered"}}\n\n');
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"ok":true');
    });
    const baseUrl = await listen(server);
    const client = new UrbitSSEClient(baseUrl, "urbauth-~zod=proof", {
      autoReconnect: false,
      ship: "zod",
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: lookupLoopback,
    });

    try {
      await client.subscribe({
        app: "chat",
        path: "/inbox",
        event: (value) => resolveEvent?.(value),
      });
      await client.connect();

      await expect(delivered).resolves.toEqual({ message: "delivered" });
      expect(streamSocket?.destroyed).toBe(false);
      expect(client.streamRelease).toBeTypeOf("function");

      await client.close();
      await expect(streamClosed).resolves.toBeUndefined();
      expect(client.streamRelease).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
