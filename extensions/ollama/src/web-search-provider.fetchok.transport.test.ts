import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loopback = vi.hoisted(() => ({
  baseUrl: "",
  status: 401,
  socketClosed: undefined as Promise<void> | undefined,
  releases: [] as Array<{
    bodyIsNull: boolean;
    bodyUsed: boolean;
    socketClosedBeforeGuardRelease: boolean;
  }>,
}));

async function waitForSocketClose(closed: Promise<void> | undefined): Promise<void> {
  if (!closed) {
    throw new Error("Ollama web search test server did not receive a request");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Ollama auth-failure response was not canceled before guarded release"));
        }, 2_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (...args: Parameters<typeof actual.fetchWithSsrFGuard>) => {
      const [params] = args;
      const guarded = await actual.fetchWithSsrFGuard({
        ...params,
        policy: { allowPrivateNetwork: true },
        url: loopback.baseUrl,
      });
      return {
        ...guarded,
        release: async () => {
          let socketClosedBeforeGuardRelease = false;
          try {
            await waitForSocketClose(loopback.socketClosed);
            socketClosedBeforeGuardRelease = true;
          } finally {
            loopback.releases.push({
              bodyIsNull: guarded.response.body === null,
              bodyUsed: guarded.response.bodyUsed,
              socketClosedBeforeGuardRelease,
            });
            await guarded.release();
          }
        },
      };
    },
  };
});

const { createOllamaWebSearchProvider } = await import("./web-search-provider.js");

const RESPONSE_BODY = '{"error":"unauthorized"}';

let server: Server;
const sockets = new Set<Socket>();

beforeAll(async () => {
  server = createServer((request, response) => {
    loopback.socketClosed = new Promise<void>((resolve) => {
      request.socket.once("close", resolve);
    });
    response.writeHead(loopback.status, {
      "content-length": String(RESPONSE_BODY.length + 1_024),
      "content-type": "application/json",
    });
    response.write(RESPONSE_BODY);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  loopback.baseUrl = `http://127.0.0.1:${address.port}/api/web_search`;
});

afterAll(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(() => {
  loopback.status = 401;
  loopback.socketClosed = undefined;
  loopback.releases = [];
});

describe("ollama web search guarded fetch", () => {
  it("cancels a stalled 401 body before guarded release", async () => {
    const tool = createOllamaWebSearchProvider().createTool({ config: {} } as never);
    if (!tool) {
      throw new Error("Expected Ollama web search tool");
    }

    await expect(tool.execute({ query: "latest openclaw release" })).rejects.toThrow(
      "ollama signin",
    );

    expect(loopback.releases.length).toBeGreaterThan(0);
    for (const release of loopback.releases) {
      expect(release).toEqual({
        bodyIsNull: false,
        bodyUsed: true,
        socketClosedBeforeGuardRelease: true,
      });
    }
  });

  it("cancels a stalled 403 body before guarded release", async () => {
    loopback.status = 403;
    const tool = createOllamaWebSearchProvider().createTool({ config: {} } as never);
    if (!tool) {
      throw new Error("Expected Ollama web search tool");
    }

    await expect(tool.execute({ query: "latest openclaw release" })).rejects.toThrow("unavailable");

    expect(loopback.releases.length).toBeGreaterThan(0);
    for (const release of loopback.releases) {
      expect(release).toEqual({
        bodyIsNull: false,
        bodyUsed: true,
        socketClosedBeforeGuardRelease: true,
      });
    }
  });
});
