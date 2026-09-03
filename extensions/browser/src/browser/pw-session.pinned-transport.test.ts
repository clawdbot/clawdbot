// Browser tests cover managed Playwright CDP transport behavior.
import { createServer } from "node:http";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import * as chromeModule from "./chrome.js";
import { pwAi } from "./pw-ai.js";
import { connectOverCdpTransport } from "./pw-session-cdp-transport.js";

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

describe("pw-session Playwright CDP transport", () => {
  it("keeps HTTP fallback managed while releasing only root contextless non-browser targets", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => {
      server.once("listening", () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    const cdpUrl = `http://127.0.0.1:${port}`;
    const transportUrl = `ws://127.0.0.1:${port}/devtools/browser/test`;
    const serverSocket = new Promise<import("ws").WebSocket>((resolve) => {
      server.on("connection", (socket) => resolve(socket));
    });
    const commands: Array<{ id: number; method: string; params?: unknown; sessionId?: string }> =
      [];
    const resumeCommands: Array<{ id: number; sessionId?: string }> = [];
    server.on("connection", (socket) => {
      socket.addEventListener("message", (event) => {
        const command = JSON.parse(
          webSocketMessageToString(event.data),
        ) as (typeof commands)[number];
        commands.push(command);
        if (command.method === "Runtime.runIfWaitingForDebugger") {
          resumeCommands.push(command);
          return;
        }
        socket.send(JSON.stringify({ id: command.id, result: {} }));
      });
    });
    getChromeWebSocketEndpointSpy
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ url: transportUrl });
    const browser = makeBrowser("A", "https://example.com");
    let transport: import("playwright-core").ConnectOverCDPTransport | undefined;
    connectOverCdpSpy.mockImplementationOnce((async (transportArg: unknown) => {
      expect(typeof transportArg).not.toBe("string");
      transport = transportArg as import("playwright-core").ConnectOverCDPTransport;
      return browser.browser;
    }) as never);

    try {
      await expect(listPagesViaPlaywright({ cdpUrl })).resolves.toEqual([
        expect.objectContaining({ targetId: "A" }),
      ]);
      if (!transport) {
        throw new Error("missing Playwright CDP transport");
      }
      const delivered: object[] = [];
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Playwright's ConnectOverCDPTransport contract uses an onmessage property.
      transport.onmessage = (message) => delivered.push(message);
      const socket = await serverSocket;
      const contextlessTargetTypes = [
        "worker",
        "shared_worker",
        "service_worker",
        "worklet",
        "shared_storage_worklet",
        "auction_worklet",
        "other",
        "page",
        "iframe",
      ];
      for (const [index, type] of contextlessTargetTypes.entries()) {
        socket.send(
          JSON.stringify({
            method: "Target.attachedToTarget",
            params: {
              sessionId: `contextless-session-${index}`,
              targetInfo: { targetId: `contextless-target-${index}`, type },
              waitingForDebugger: true,
            },
          }),
        );
      }
      const forwardedTargetInfos = [
        { type: "browser" },
        { type: "page", browserContextId: "default-context" },
        { type: "other", browserContextId: "default-context" },
        { type: "service_worker", browserContextId: "default-context" },
      ];
      const forwardedTargets = [
        ...forwardedTargetInfos.map((targetInfo) => ({
          targetInfo,
          sessionId: undefined,
          waitingForDebugger: true,
        })),
        ...["worker", "iframe"].flatMap((type) =>
          [true, false].map((waitingForDebugger) => ({
            targetInfo: { type },
            sessionId: "parent-session",
            waitingForDebugger,
          })),
        ),
      ].map(({ targetInfo, sessionId, waitingForDebugger }, index) => ({
        method: "Target.attachedToTarget",
        sessionId,
        params: {
          sessionId: `forwarded-session-${index}`,
          targetInfo: { targetId: `forwarded-target-${index}`, ...targetInfo },
          waitingForDebugger,
        },
      }));
      for (const event of forwardedTargets) {
        socket.send(JSON.stringify(event));
      }

      await vi.waitFor(() => {
        expect(delivered).toEqual(forwardedTargets);
      });
      await vi.waitFor(() => {
        expect(commands).toHaveLength(contextlessTargetTypes.length);
      });
      expect(commands).toEqual(
        contextlessTargetTypes.map((_type, index) =>
          expect.objectContaining({
            id: expect.any(Number),
            method: "Runtime.runIfWaitingForDebugger",
            sessionId: `contextless-session-${index}`,
          }),
        ),
      );
      const firstResume = resumeCommands[0];
      if (!firstResume) {
        throw new Error("missing first contextless-target resume command");
      }
      socket.send(JSON.stringify({ id: firstResume.id, result: {} }));
      await vi.waitFor(() => {
        expect(commands).toHaveLength(contextlessTargetTypes.length + 1);
      });
      expect(commands.at(-1)).toEqual(
        expect.objectContaining({
          method: "Target.detachFromTarget",
          params: { sessionId: "contextless-session-0" },
        }),
      );
      for (const command of resumeCommands.slice(1)) {
        socket.send(JSON.stringify({ id: command.id, result: {} }));
      }
      await vi.waitFor(() => {
        expect(commands).toHaveLength(contextlessTargetTypes.length * 2);
      });
      expect(commands.slice(contextlessTargetTypes.length + 1)).toEqual(
        contextlessTargetTypes.slice(1).map((_type, index) =>
          expect.objectContaining({
            method: "Target.detachFromTarget",
            params: { sessionId: `contextless-session-${index + 1}` },
          }),
        ),
      );
      const socketClosed = new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      });
      transport.close();
      await socketClosed;
      expect(delivered).toEqual(forwardedTargets);
      expect(commands).toHaveLength(contextlessTargetTypes.length * 2);
    } finally {
      transport?.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("keeps contextless-target cleanup and close acknowledgement on a prepared transport", async () => {
    const commands: object[] = [];
    const closeWire = vi.fn();
    const wire: import("playwright-core").ConnectOverCDPTransport = {
      send: (message) => commands.push(message),
      close: closeWire,
    };
    const browser = makeBrowser("A", "https://example.com");
    connectOverCdpSpy.mockImplementationOnce((async (value: unknown) => {
      const transport = value as import("playwright-core").ConnectOverCDPTransport;
      const delivered: object[] = [];
      let closed = false;
      Object.assign(transport, {
        onmessage: (message: object) => delivered.push(message),
        onclose: () => {
          closed = true;
        },
      });
      wire.onmessage?.({
        method: "Target.attachedToTarget",
        params: {
          sessionId: "worker-session",
          targetInfo: { targetId: "worker", type: "worker" },
        },
      });
      expect(commands).toEqual([
        expect.objectContaining({ method: "Runtime.runIfWaitingForDebugger" }),
      ]);
      const resume = commands[0] as { id: number };
      wire.onmessage?.({ id: resume.id, result: {} });
      expect(commands[1]).toMatchObject({
        method: "Target.detachFromTarget",
        params: { sessionId: "worker-session" },
      });
      expect(delivered).toEqual([]);
      transport.close();
      expect(closeWire).toHaveBeenCalledOnce();
      expect(closed).toBe(false);
      wire.onclose?.("cleanup acknowledged");
      await vi.waitFor(() => expect(closed).toBe(true));
      return browser.browser;
    }) as never);
    await connectOverCdpTransport("http://127.0.0.1:18799", {
      timeout: 1000,
      headers: {},
      preparedTransport: wire,
    });
  });

  it("suppresses a root contextless target that has no session id without closing", async () => {
    const commands: object[] = [];
    const closeWire = vi.fn();
    const wire: import("playwright-core").ConnectOverCDPTransport = {
      send: (message) => commands.push(message),
      close: closeWire,
    };
    const browser = makeBrowser("A", "https://example.com");
    connectOverCdpSpy.mockImplementationOnce((async (value: unknown) => {
      const transport = value as import("playwright-core").ConnectOverCDPTransport;
      const delivered: object[] = [];
      Object.assign(transport, {
        onmessage: (message: object) => delivered.push(message),
        onclose: vi.fn(),
      });
      wire.onmessage?.({
        method: "Target.attachedToTarget",
        params: {
          targetInfo: { targetId: "sessionless-worker", type: "service_worker" },
          waitingForDebugger: true,
        },
      });
      const followup = { id: 42, result: { ok: true } };
      wire.onmessage?.(followup);
      expect(commands).toEqual([]);
      await vi.waitFor(() => expect(delivered).toEqual([followup]));
      expect(closeWire).not.toHaveBeenCalled();
      return browser.browser;
    }) as never);
    await connectOverCdpTransport("http://127.0.0.1:18799", {
      timeout: 1000,
      headers: {},
      preparedTransport: wire,
    });
  });

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
