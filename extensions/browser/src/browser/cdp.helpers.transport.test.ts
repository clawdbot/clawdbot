// Exercise real authenticated browser CDP response streams and TCP cleanup.
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { fetchCdpChecked, fetchJson, fetchOk } from "./cdp.helpers.js";

const CDP_USERNAME = "openclaw";
const CDP_FIXTURE_TOKEN = "browser-cdp-transport-test";
const EXPECTED_AUTHORIZATION = `Basic ${Buffer.from(
  `${CDP_USERNAME}:${CDP_FIXTURE_TOKEN}`,
).toString("base64")}`;

type AuthenticatedCdpServer = {
  url: string;
  sockets: Set<Socket>;
  authorizations: Array<string | undefined>;
  close: () => Promise<void>;
};

async function startAuthenticatedCdpServer(params: {
  status: number;
  streaming: boolean;
}): Promise<AuthenticatedCdpServer> {
  const sockets = new Set<Socket>();
  const authorizations: Array<string | undefined> = [];
  const server: Server = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    if (request.headers.authorization !== EXPECTED_AUTHORIZATION) {
      response.writeHead(401);
      response.end();
      return;
    }

    response.writeHead(params.status, { "content-type": "application/json" });
    if (params.streaming) {
      // Keep the response body open until the actual CDP client cancels it.
      response.write('{"Browser":');
      return;
    }
    response.end(JSON.stringify({ Browser: "OpenClaw transport fixture" }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected the browser CDP fixture to bind a loopback TCP port");
  }

  return {
    url: `http://${CDP_USERNAME}:${CDP_FIXTURE_TOKEN}@127.0.0.1:${address.port}/json/version`,
    sockets,
    authorizations,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        for (const socket of sockets) {
          socket.destroy();
        }
      });
    },
  };
}

async function expectAllSocketsReleased(server: AuthenticatedCdpServer): Promise<void> {
  await vi.waitFor(
    () => {
      expect(server.sockets.size).toBe(0);
    },
    { timeout: 1_250, interval: 20 },
  );
}

describe("browser CDP authenticated HTTP transport", () => {
  it("closes every unread streaming response after concurrent status probes", async () => {
    const server = await startAuthenticatedCdpServer({ status: 200, streaming: true });
    try {
      await Promise.all(Array.from({ length: 8 }, () => fetchOk(server.url, 1_000)));

      expect(server.authorizations).toEqual(Array(8).fill(EXPECTED_AUTHORIZATION));
      await expectAllSocketsReleased(server);
    } finally {
      await server.close();
    }
  });

  it("releases an unread streaming response even when a caller clones it", async () => {
    const server = await startAuthenticatedCdpServer({ status: 200, streaming: true });
    try {
      const { response, release } = await fetchCdpChecked(server.url, 1_000);
      const clone = response.clone();
      let released = false;
      const releasing = release();
      void releasing
        .finally(() => {
          released = true;
        })
        .catch(() => {});

      expect(clone.bodyUsed).toBe(false);
      await vi.waitFor(
        () => {
          expect(released).toBe(true);
        },
        { timeout: 1_250, interval: 20 },
      );
      await releasing;

      expect(server.authorizations).toEqual([EXPECTED_AUTHORIZATION]);
      await expectAllSocketsReleased(server);
    } finally {
      await server.close();
    }
  });

  it("closes a partially consumed response while its stream reader remains locked", async () => {
    const server = await startAuthenticatedCdpServer({ status: 200, streaming: true });
    try {
      const { response, release } = await fetchCdpChecked(server.url, 1_000);
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("expected the authenticated CDP response to expose a readable stream");
      }
      const readerClosed = reader.closed.catch(() => {});
      const firstChunk = await reader.read();

      expect(firstChunk.done).toBe(false);
      expect(firstChunk.value?.byteLength).toBeGreaterThan(0);
      expect(response.bodyUsed).toBe(true);
      await release();

      expect(server.authorizations).toEqual([EXPECTED_AUTHORIZATION]);
      await expectAllSocketsReleased(server);
      await readerClosed;
    } finally {
      await server.close();
    }
  });

  it("closes an unread streaming response when a CDP request fails", async () => {
    const server = await startAuthenticatedCdpServer({ status: 503, streaming: true });
    try {
      await expect(fetchCdpChecked(server.url, 1_000)).rejects.toThrow("HTTP 503");

      expect(server.authorizations).toEqual([EXPECTED_AUTHORIZATION]);
      await expectAllSocketsReleased(server);
    } finally {
      await server.close();
    }
  });

  it("closes an unread streaming response without changing rate-limit errors", async () => {
    const server = await startAuthenticatedCdpServer({ status: 429, streaming: true });
    try {
      await expect(fetchCdpChecked(server.url, 1_000)).rejects.toThrow(/rate[ -]?limit/i);

      expect(server.authorizations).toEqual([EXPECTED_AUTHORIZATION]);
      await expectAllSocketsReleased(server);
    } finally {
      await server.close();
    }
  });

  it("preserves authenticated, fully consumed CDP JSON responses", async () => {
    const server = await startAuthenticatedCdpServer({ status: 200, streaming: false });
    try {
      await expect(fetchJson(server.url, 1_000)).resolves.toEqual({
        Browser: "OpenClaw transport fixture",
      });

      expect(server.authorizations).toEqual([EXPECTED_AUTHORIZATION]);
    } finally {
      await server.close();
    }
  });
});
