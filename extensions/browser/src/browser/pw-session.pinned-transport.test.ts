// Browser tests cover pinned Playwright CDP transport behavior.
import { createServer } from "node:http";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import * as chromeModule from "./chrome.js";
import { pwAi } from "./pw-ai.js";

const { registerManagedProxyBrowserCdpBypassMock } = vi.hoisted(() => ({
  registerManagedProxyBrowserCdpBypassMock: vi.fn<(url: string) => (() => void) | undefined>(
    () => undefined,
  ),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime-internal", () => ({
  registerManagedProxyBrowserCdpBypass: registerManagedProxyBrowserCdpBypassMock,
}));

const { closePlaywrightBrowserConnection, listPagesViaPlaywright } = pwAi;

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketEndpointSpy = vi.spyOn(chromeModule, "getChromeWebSocketEndpoint");
const TEST_CDP_WS_MAX_PAYLOAD_BYTES = 1024 * 1024;

function webSocketMessageToString(data: import("ws").Data): string {
  return typeof data === "string" ? data : rawDataToString(data);
}

function makeBrowser(
  targetId: string,
  url: string,
): { browser: import("playwright-core").Browser } {
  const page = {
    on: vi.fn(),
    context: () => context,
    title: vi.fn(async () => `title:${targetId}`),
    url: vi.fn(() => url),
  } as unknown as import("playwright-core").Page;

  const context: import("playwright-core").BrowserContext = {
    pages: () => [page],
    on: vi.fn(),
    newCDPSession: vi.fn(async () => ({
      send: vi.fn(async (method: string) =>
        method === "Target.getTargetInfo"
          ? { targetInfo: { targetId, title: `title:${targetId}` } }
          : {},
      ),
      detach: vi.fn(async () => {}),
    })),
  } as unknown as import("playwright-core").BrowserContext;

  const browser = {
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn(async () => {}),
  } as unknown as import("playwright-core").Browser;

  return { browser };
}

function pinnedLoopbackLookup() {
  return ((_hostname: string, options: unknown, callback?: unknown) => {
    const cb = typeof options === "function" ? options : callback;
    if (typeof cb === "function") {
      cb(null, "127.0.0.1", 4);
    }
  }) as never;
}

afterEach(async () => {
  connectOverCdpSpy.mockReset();
  getChromeWebSocketEndpointSpy.mockReset();
  registerManagedProxyBrowserCdpBypassMock.mockReset();
  registerManagedProxyBrowserCdpBypassMock.mockImplementation(() => undefined);
  await closePlaywrightBrowserConnection().catch(() => {});
});

describe("pw-session pinned Playwright transport", () => {
  it("connects guarded Playwright CDP through the pinned WebSocket transport", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => {
      server.once("listening", () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    const cdpUrl = `ws://127.0.0.1:${port}/devtools/browser/test`;
    const requestHeaders: Array<Record<string, string | string[] | undefined>> = [];
    server.on("connection", (socket, request) => {
      requestHeaders.push(request.headers);
      socket.addEventListener("message", (event) => {
        const msg = JSON.parse(webSocketMessageToString(event.data)) as { id?: number };
        socket.send(JSON.stringify({ id: msg.id, result: { ok: true } }));
      });
    });
    getChromeWebSocketEndpointSpy.mockResolvedValue({
      url: cdpUrl,
      lookup: pinnedLoopbackLookup(),
    });
    const browser = makeBrowser("A", "https://example.com");
    connectOverCdpSpy.mockImplementationOnce((async (transportArg: unknown) => {
      expect(typeof transportArg).not.toBe("string");
      const transport = transportArg as import("playwright-core").ConnectOverCDPTransport;
      let delivered = false;
      const message = new Promise<object>((resolve) => {
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Playwright's ConnectOverCDPTransport contract uses an onmessage property.
        transport.onmessage = (value) => {
          delivered = true;
          resolve(value);
        };
      });
      transport.send({ id: 7, method: "Browser.getVersion" });
      expect(delivered).toBe(false);
      await expect(message).resolves.toStrictEqual({ id: 7, result: { ok: true } });
      transport.close();
      return browser.browser;
    }) as never);

    try {
      const pages = await listPagesViaPlaywright({ cdpUrl, ssrfPolicy: {} });

      expect(pages.map((page) => page.targetId)).toStrictEqual(["A"]);
      expect(connectOverCdpSpy).toHaveBeenCalledTimes(1);
      expect(requestHeaders[0]?.["user-agent"]).toContain("Playwright/");
      expect(requestHeaders[0]?.["sec-websocket-extensions"]).toContain("permessage-deflate");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("follows same-authority redirects in the pinned Playwright CDP transport", async () => {
    const server = createServer();
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: TEST_CDP_WS_MAX_PAYLOAD_BYTES,
    });
    const redirectedUpgradePaths: string[] = [];
    wss.on("connection", (socket) => {
      socket.addEventListener("message", (event) => {
        const msg = JSON.parse(webSocketMessageToString(event.data)) as { id?: number };
        socket.send(JSON.stringify({ id: msg.id, result: { ok: true } }));
      });
    });
    server.on("upgrade", (request, socket, head) => {
      if (request.url === "/start") {
        socket.write(
          "HTTP/1.1 302 Found\r\nLocation: /devtools/browser/redirected\r\nConnection: close\r\n\r\n",
        );
        socket.destroy();
        return;
      }
      redirectedUpgradePaths.push(request.url ?? "");
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not expose a TCP port");
    }
    const cdpUrl = `ws://127.0.0.1:${address.port}/start`;
    getChromeWebSocketEndpointSpy.mockResolvedValue({
      url: cdpUrl,
      lookup: pinnedLoopbackLookup(),
    });
    const browser = makeBrowser("A", "https://example.com");
    connectOverCdpSpy.mockImplementationOnce((async (transportArg: unknown) => {
      const transport = transportArg as import("playwright-core").ConnectOverCDPTransport;
      const message = new Promise<object>((resolve) => {
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Playwright's ConnectOverCDPTransport contract uses an onmessage property.
        transport.onmessage = (value) => resolve(value);
      });
      transport.send({ id: 8, method: "Browser.getVersion" });
      await expect(message).resolves.toStrictEqual({ id: 8, result: { ok: true } });
      transport.close();
      return browser.browser;
    }) as never);

    try {
      await expect(listPagesViaPlaywright({ cdpUrl, ssrfPolicy: {} })).resolves.toEqual([
        expect.objectContaining({ targetId: "A" }),
      ]);
      expect(redirectedUpgradePaths).toStrictEqual(["/devtools/browser/redirected"]);
    } finally {
      await new Promise<void>((resolve) => {
        wss.close(() => {
          server.close(() => resolve());
        });
      });
    }
  });

  it("closes the pinned Playwright transport on malformed CDP JSON", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => {
      server.once("listening", () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    const cdpUrl = `ws://127.0.0.1:${port}/devtools/browser/test`;
    const serverSocket = new Promise<import("ws").WebSocket>((resolve) => {
      server.on("connection", (socket) => resolve(socket));
    });
    getChromeWebSocketEndpointSpy.mockResolvedValue({
      url: cdpUrl,
      lookup: pinnedLoopbackLookup(),
    });
    const browser = makeBrowser("A", "https://example.com");
    connectOverCdpSpy.mockImplementationOnce((async (transportArg: unknown) => {
      const transport = transportArg as import("playwright-core").ConnectOverCDPTransport;
      const closed = new Promise<string | undefined>((resolve) => {
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Playwright's ConnectOverCDPTransport contract uses an onclose property.
        transport.onclose = (reason) => resolve(reason);
      });
      (await serverSocket).send("{not-json");
      await expect(closed).resolves.toBe("CDP socket closed");
      return browser.browser;
    }) as never);

    try {
      await expect(listPagesViaPlaywright({ cdpUrl, ssrfPolicy: {} })).resolves.toEqual([
        expect.objectContaining({ targetId: "A" }),
      ]);
      expect(connectOverCdpSpy).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("delivers queued CDP messages before reporting pinned transport closure", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => {
      server.once("listening", () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    const cdpUrl = `ws://127.0.0.1:${port}/devtools/browser/test`;
    const serverSocket = new Promise<import("ws").WebSocket>((resolve) => {
      server.on("connection", (socket) => resolve(socket));
    });
    getChromeWebSocketEndpointSpy.mockResolvedValue({
      url: cdpUrl,
      lookup: pinnedLoopbackLookup(),
    });
    const browser = makeBrowser("A", "https://example.com");
    connectOverCdpSpy.mockImplementationOnce((async (transportArg: unknown) => {
      const transport = transportArg as import("playwright-core").ConnectOverCDPTransport;
      const events: string[] = [];
      const message = new Promise<void>((resolve) => {
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Playwright's ConnectOverCDPTransport contract uses an onmessage property.
        transport.onmessage = () => {
          events.push("message");
          resolve();
        };
      });
      const closed = new Promise<void>((resolve) => {
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Playwright's ConnectOverCDPTransport contract uses an onclose property.
        transport.onclose = () => {
          events.push("close");
          resolve();
        };
      });
      const socket = await serverSocket;
      socket.send(JSON.stringify({ id: 1, result: { ok: true } }));
      socket.close();

      await message;
      await closed;
      expect(events).toStrictEqual(["message", "close"]);
      return browser.browser;
    }) as never);

    try {
      await expect(listPagesViaPlaywright({ cdpUrl, ssrfPolicy: {} })).resolves.toEqual([
        expect.objectContaining({ targetId: "A" }),
      ]);
      expect(connectOverCdpSpy).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("closes the pinned Playwright transport when message delivery fails", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => {
      server.once("listening", () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    const cdpUrl = `ws://127.0.0.1:${port}/devtools/browser/test`;
    const serverSocket = new Promise<import("ws").WebSocket>((resolve) => {
      server.on("connection", (socket) => resolve(socket));
    });
    getChromeWebSocketEndpointSpy.mockResolvedValue({
      url: cdpUrl,
      lookup: pinnedLoopbackLookup(),
    });
    const browser = makeBrowser("A", "https://example.com");
    connectOverCdpSpy.mockImplementationOnce((async (transportArg: unknown) => {
      const transport = transportArg as import("playwright-core").ConnectOverCDPTransport;
      const closed = new Promise<string | undefined>((resolve) => {
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Playwright's ConnectOverCDPTransport contract uses an onclose property.
        transport.onclose = (reason) => resolve(reason);
      });
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Playwright's ConnectOverCDPTransport contract uses an onmessage property.
      transport.onmessage = () => {
        throw new Error("handler failed");
      };
      (await serverSocket).send(JSON.stringify({ id: 1, result: {} }));
      await expect(closed).resolves.toContain("handler failed");
      return browser.browser;
    }) as never);

    try {
      await expect(listPagesViaPlaywright({ cdpUrl, ssrfPolicy: {} })).resolves.toEqual([
        expect.objectContaining({ targetId: "A" }),
      ]);
      expect(connectOverCdpSpy).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("propagates pinned WebSocket protocol errors through transport closure", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => {
      server.once("listening", () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    const cdpUrl = `ws://127.0.0.1:${port}/devtools/browser/test`;
    const serverSocket = new Promise<import("ws").WebSocket>((resolve) => {
      server.on("connection", (socket) => resolve(socket));
    });
    getChromeWebSocketEndpointSpy.mockResolvedValue({
      url: cdpUrl,
      lookup: pinnedLoopbackLookup(),
    });
    const browser = makeBrowser("A", "https://example.com");
    connectOverCdpSpy.mockImplementationOnce((async (transportArg: unknown) => {
      const transport = transportArg as import("playwright-core").ConnectOverCDPTransport;
      const closed = new Promise<string | undefined>((resolve) => {
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Playwright's ConnectOverCDPTransport contract uses an onclose property.
        transport.onclose = (reason) => resolve(reason);
      });
      const socket = await serverSocket;
      const rawSocket = Reflect.get(socket, "_socket") as { write(data: Buffer): void };
      // Send an invalid reserved opcode so the real ws client emits an error.
      rawSocket.write(Buffer.from([0x83, 0x00]));
      await expect(closed).resolves.toContain("Invalid WebSocket frame");
      return browser.browser;
    }) as never);

    try {
      await expect(listPagesViaPlaywright({ cdpUrl, ssrfPolicy: {} })).resolves.toEqual([
        expect.objectContaining({ targetId: "A" }),
      ]);
      expect(connectOverCdpSpy).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
