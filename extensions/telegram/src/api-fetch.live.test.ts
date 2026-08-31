import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchTelegramChatId } from "./api-fetch.js";

describe("fetchTelegramChatId live HTTP behavior", () => {
  const sockets = new Set<Socket>();

  afterEach(() => {
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
  });

  it("closes a stalled non-success getChat response body", async () => {
    let stalledResponse: ServerResponse | undefined;
    let markResponseClosed: () => void = () => undefined;
    const responseClosed = new Promise<void>((resolve) => {
      markResponseClosed = resolve;
    });
    const server = createServer((_req, res) => {
      stalledResponse = res;
      res.on("close", markResponseClosed);
      res.writeHead(503, { "content-type": "text/plain" });
      res.write("service unavailable");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let captureSettled = false;
    const captureFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const capture = response.clone();
      void capture
        .arrayBuffer()
        .catch(() => undefined)
        .finally(() => {
          captureSettled = true;
        });
      return response;
    };

    try {
      await expect(
        fetchTelegramChatId({ token: "abc", chatId: "@user", apiRoot, fetchImpl: captureFetch }),
      ).resolves.toBeNull();
      await expect(
        Promise.race([
          responseClosed.then(() => "closed"),
          new Promise<string>((resolve) => {
            setTimeout(() => resolve("stalled"), 1_000);
          }),
        ]),
      ).resolves.toBe("closed");
      await expect.poll(() => captureSettled, { timeout: 1_000 }).toBe(true);
    } finally {
      stalledResponse?.destroy();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
