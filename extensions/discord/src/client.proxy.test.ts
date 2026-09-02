// Discord tests cover client.proxy plugin behavior.
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscordRestClient } from "./client.js";
import { createDiscordRequestClient } from "./proxy-request-client.js";

const makeProxyFetchMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/fetch-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/fetch-runtime")>(
    "openclaw/plugin-sdk/fetch-runtime",
  );
  makeProxyFetchMock.mockImplementation((proxyUrl: string) => {
    if (proxyUrl === "bad-proxy") {
      throw new Error("bad proxy");
    }
    return actual.makeProxyFetch(proxyUrl);
  });
  return {
    ...actual,
    makeProxyFetch: makeProxyFetchMock,
  };
});

describe("createDiscordRestClient proxy support", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    makeProxyFetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("injects a custom fetch into RequestClient when a Discord proxy is configured", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://127.0.0.1:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      customFetch?: typeof fetch;
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://127.0.0.1:8080");
    expect(requestClient.options?.fetch).toBe(makeProxyFetchMock.mock.results[0]?.value);
    expect(requestClient.customFetch).toBe(requestClient.options?.fetch);
  });

  it("accepts configured DNS proxy hosts", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://mitm-proxy:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      customFetch?: typeof fetch;
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://mitm-proxy:8080");
    expect(requestClient.options?.fetch).toBe(makeProxyFetchMock.mock.results[0]?.value);
    expect(requestClient.customFetch).toBe(requestClient.options?.fetch);
  });

  it("accepts configured HTTPS proxy hosts", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "https://proxy.example:8443",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      customFetch?: typeof fetch;
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).toHaveBeenCalledWith("https://proxy.example:8443");
    expect(requestClient.options?.fetch).toBe(makeProxyFetchMock.mock.results[0]?.value);
    expect(requestClient.customFetch).toBe(requestClient.options?.fetch);
  });

  it("accepts configured proxy URLs with credentials", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://user:secret@mitm-proxy:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://user:secret@mitm-proxy:8080");
    expect(requestClient.options?.fetch).toBe(makeProxyFetchMock.mock.results[0]?.value);
  });

  it("accepts arbitrary configured DNS proxy hosts", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://proxy.test:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(requestClient.options?.fetch).toBe(makeProxyFetchMock.mock.results[0]?.value);
  });

  it("does not inject fetch when no proxy is configured", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(requestClient.options?.fetch).toBeUndefined();
  });

  it("falls back to direct fetch when the Discord proxy URL is invalid", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "bad-proxy",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).not.toHaveBeenCalledWith("bad-proxy");
    expect(requestClient.options?.fetch).toBeUndefined();
  });

  it("accepts configured non-loopback IP proxy URLs", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://10.0.0.10:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://10.0.0.10:8080");
    expect(requestClient.options?.fetch).toBe(makeProxyFetchMock.mock.results[0]?.value);
  });

  it("accepts IPv6 loopback Discord proxy URLs", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://[::1]:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://[::1]:8080");
    expect(requestClient.options?.fetch).toBe(makeProxyFetchMock.mock.results[0]?.value);
  });

  it("serializes multipart media with undici-compatible FormData for proxy fetches", async () => {
    let resolveReceived!: (value: { contentType: string | undefined; body: string }) => void;
    let rejectReceived!: (reason?: unknown) => void;
    const receivedPromise = new Promise<{
      contentType: string | undefined;
      body: string;
    }>((resolve, reject) => {
      resolveReceived = resolve;
      rejectReceived = reject;
    });
    const target = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("error", rejectReceived);
      req.on("end", () => {
        resolveReceived({
          contentType: req.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Connection", "close");
        res.end(JSON.stringify({ id: "message-id", channel_id: "channel-id" }));
      });
    });
    const proxy = http.createServer();
    const tunnelSockets = new Set<Duplex>();
    target.on("error", rejectReceived);
    proxy.on("error", rejectReceived);
    // Undici's ProxyAgent tunnels HTTP targets with CONNECT. Pipe the tunnel so
    // this test exercises the production proxy fetch and its FormData rebuild.
    proxy.on("connect", (req, clientSocket, head) => {
      trackSocket(tunnelSockets, clientSocket);
      if (!req.url) {
        rejectReceived(new Error("proxy CONNECT request missing target"));
        clientSocket.destroy();
        return;
      }
      const targetUrl = new URL(`http://${req.url}`);
      const targetSocket = net.connect(Number(targetUrl.port), targetUrl.hostname, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) {
          targetSocket.write(head);
        }
        clientSocket.pipe(targetSocket);
        targetSocket.pipe(clientSocket);
      });
      trackSocket(tunnelSockets, targetSocket);
      targetSocket.on("error", rejectReceived);
      clientSocket.on("error", rejectReceived);
    });

    try {
      const targetPort = await listenOnLoopback(target, "target");
      const proxyPort = await listenOnLoopback(proxy, "proxy");
      const cfg = {
        channels: {
          discord: {
            token: "Bot test-token",
            proxy: `http://127.0.0.1:${proxyPort}`,
          },
        },
      } as OpenClawConfig;
      const proxyRest = createDiscordRestClient({ cfg }).rest as unknown as {
        options?: { fetch?: typeof fetch };
      };
      const proxyFetch = proxyRest.options?.fetch;
      if (!proxyFetch) {
        throw new Error("expected Discord proxy fetch");
      }
      const rest = createDiscordRequestClient("test-token", {
        baseUrl: `http://127.0.0.1:${targetPort}`,
        fetch: proxyFetch,
        queueRequests: false,
      });
      const [received] = await Promise.all([
        receivedPromise,
        rest.post("/channels/123/messages", {
          body: {
            content: "with image",
            files: [{ data: Buffer.from("png-data"), name: "image.png" }],
          },
        }),
      ]);

      expect(received.contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(received.body).toContain('name="files[0]"; filename="image.png"');
      expect(received.body).toContain('name="payload_json"');
      expect(received.body).toContain('"attachments":[{"id":0,"filename":"image.png"}]');
    } finally {
      for (const socket of tunnelSockets) {
        socket.destroy();
      }
      await Promise.all([closeServer(target), closeServer(proxy)]);
    }
  });
});

function trackSocket(sockets: Set<Duplex>, socket: Duplex): void {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
}

async function listenOnLoopback(server: http.Server, label: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error(`failed to bind ${label} test server`);
  }
  return address.port;
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
