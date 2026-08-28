/* @vitest-environment jsdom */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchCatalogIconBlobUrl,
  fetchLinkFaviconBlobUrl,
  fetchPluginIconBlobUrl,
} from "./icon-loader.ts";

const auth = {
  settings: { token: "test-token" },
};

function imageResponse(): Response {
  return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

async function listenOnLoopback(server: Server): Promise<string> {
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

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await closed;
}

function useLoopbackFetch(baseUrl: string): void {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return nativeFetch(new URL(requestUrl, baseUrl), init);
  });
}

function rejectedResponse(status: number, cancel: () => Promise<void>): Response {
  return {
    body: { cancel },
    bodyUsed: false,
    ok: false,
    status,
  } as unknown as Response;
}

describe("catalog icon loader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads plugin and wire-provided catalog icons through same-origin proxy routes", async () => {
    const NativeUrl = URL;
    const createObjectURL = vi
      .fn()
      .mockReturnValueOnce("blob:plugin-icon")
      .mockReturnValueOnce("blob:catalog-icon")
      .mockReturnValueOnce("blob:link-favicon");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi.fn().mockImplementation(async () => imageResponse());
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const common = {
      auth,
      resourceBasePath: "/openclaw",
      gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
      signal: new AbortController().signal,
    };

    await expect(fetchPluginIconBlobUrl({ ...common, pluginId: "firecrawl" })).resolves.toBe(
      "blob:plugin-icon",
    );
    const iconUrl = "https://cdn.example.test/provider.svg";
    await expect(fetchCatalogIconBlobUrl({ ...common, iconUrl })).resolves.toBe(
      "blob:catalog-icon",
    );
    await expect(
      fetchLinkFaviconBlobUrl({ ...common, hostname: "docs.example.com" }),
    ).resolves.toBe("blob:link-favicon");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/openclaw/__openclaw__/plugin-icon/firecrawl",
      `/openclaw/__openclaw__/catalog-icon/${encodeURIComponent(iconUrl)}`,
      "/openclaw/__openclaw__/link-favicon/docs.example.com",
    ]);
    expect(
      fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
    ).toEqual(["Bearer test-token", "Bearer test-token", "Bearer test-token"]);
    expect(fetchMock.mock.calls.some(([url]) => url === iconUrl)).toBe(false);
  });

  it("refuses proxy loading when the configured gateway is cross-origin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(
      fetchCatalogIconBlobUrl({
        auth,
        resourceBasePath: "",
        gatewayUrl: "wss://remote.example.test",
        iconUrl: "https://cdn.example.test/provider.svg",
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes streaming auth failures before retrying and returning", async () => {
    let requestCount = 0;
    const closedResponses = new Set<number>();
    const server = createServer((request, response) => {
      const requestIndex = requestCount++;
      request.socket.once("close", () => closedResponses.add(requestIndex));
      response.writeHead(requestIndex === 0 ? 401 : 404, {
        "content-type": "text/plain",
      });
      response.write("stream remains open");
    });
    const baseUrl = await listenOnLoopback(server);
    useLoopbackFetch(baseUrl);

    try {
      await expect(
        fetchPluginIconBlobUrl({
          auth: {
            hello: { auth: { deviceToken: "stale-device-token" } },
            settings: { token: "fallback-token" },
          },
          resourceBasePath: "",
          gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
          pluginId: "streaming-errors",
          signal: new AbortController().signal,
        }),
      ).resolves.toBeNull();

      expect(requestCount).toBe(2);
      await vi.waitFor(() => expect(closedResponses).toEqual(new Set([0, 1])), {
        timeout: 1_000,
      });
    } finally {
      await closeServer(server);
    }
  });

  it("closes a streaming response rejected by MIME type", async () => {
    let socketClosed = false;
    const server = createServer((request, response) => {
      request.socket.once("close", () => {
        socketClosed = true;
      });
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("not an icon");
    });
    const baseUrl = await listenOnLoopback(server);
    useLoopbackFetch(baseUrl);

    try {
      await expect(
        fetchPluginIconBlobUrl({
          auth,
          resourceBasePath: "",
          gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
          pluginId: "wrong-mime",
          signal: new AbortController().signal,
        }),
      ).resolves.toBeNull();

      await vi.waitFor(() => expect(socketClosed).toBe(true), { timeout: 1_000 });
    } finally {
      await closeServer(server);
    }
  });

  it("does not wait for a stalled response cancellation before auth fallback", async () => {
    let resolveCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    const cancel = vi.fn(() => cancellation);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rejectedResponse(401, cancel))
      .mockResolvedValueOnce(rejectedResponse(404, cancel));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(
      fetchPluginIconBlobUrl({
        auth: {
          hello: { auth: { deviceToken: "stale-device-token" } },
          settings: { token: "fallback-token" },
        },
        resourceBasePath: "",
        gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
        pluginId: "stalled-cancellation",
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(2);
    resolveCancellation();
  });
});
