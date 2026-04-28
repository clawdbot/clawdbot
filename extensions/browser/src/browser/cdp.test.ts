import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { rawDataToString } from "../infra/ws.js";
import "../test-support/browser-security.mock.js";
import {
  isDirectCdpWebSocketEndpoint,
  isWebSocketUrl,
  parseBrowserHttpUrl as parseHttpUrl,
} from "./cdp.helpers.js";
import { createTargetViaCdp, evaluateJavaScript, normalizeCdpWsUrl, snapshotAria } from "./cdp.js";
import {
  BROWSER_ENDPOINT_BLOCKED_MESSAGE,
  BROWSER_NAVIGATION_BLOCKED_MESSAGE,
  BrowserCdpEndpointBlockedError,
  BrowserValidationError,
  toBrowserErrorResponse,
} from "./errors.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";

describe("cdp", () => {
  let httpServer: ReturnType<typeof createServer> | null = null;
  let wsServer: WebSocketServer | null = null;

  const startWsServer = async () => {
    wsServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wsServer?.once("listening", resolve));
    return (wsServer.address() as { port: number }).port;
  };

  const startWsServerWithMessages = async (
    onMessage: (
      msg: { id?: number; method?: string; params?: Record<string, unknown> },
      socket: WebSocket,
    ) => void,
  ) => {
    const wsPort = await startWsServer();
    if (!wsServer) {
      throw new Error("ws server not initialized");
    }
    wsServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(rawDataToString(data)) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
        };
        onMessage(msg, socket);
        if (msg.method === "Target.attachToTarget") {
          socket.send(JSON.stringify({ id: msg.id, result: { sessionId: "S1" } }));
        } else if (
          msg.method === "Target.detachFromTarget" ||
          msg.method === "Page.enable" ||
          msg.method === "Runtime.enable" ||
          msg.method === "Network.enable" ||
          msg.method === "DOM.enable" ||
          msg.method === "Accessibility.enable" ||
          msg.method === "Runtime.runIfWaitingForDebugger"
        ) {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
        }
      });
    });
    return wsPort;
  };

  const startVersionHttpServer = async (versionBody: Record<string, unknown>) => {
    httpServer = createServer((req, res) => {
      if (req.url === "/json/version") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(versionBody));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    await new Promise<void>((resolve) => httpServer?.listen(0, "127.0.0.1", resolve));
    return (httpServer.address() as { port: number }).port;
  };

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => {
      if (!httpServer) {
        return resolve();
      }
      httpServer.close(() => resolve());
      httpServer = null;
    });
    await new Promise<void>((resolve) => {
      if (!wsServer) {
        return resolve();
      }
      wsServer.close(() => resolve());
      wsServer = null;
    });
  });

  it("creates a target via the browser websocket", async () => {
    const methods: string[] = [];
    const wsPort = await startWsServerWithMessages((msg, socket) => {
      if (msg.method) {
        methods.push(msg.method);
      }
      if (msg.method !== "Target.createTarget") {
        return;
      }
      socket.send(
        JSON.stringify({
          id: msg.id,
          result: { targetId: "TARGET_123" },
        }),
      );
    });

    const httpPort = await startVersionHttpServer({
      webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/browser/TEST`,
    });

    const created = await createTargetViaCdp({
      cdpUrl: `http://127.0.0.1:${httpPort}`,
      url: "https://example.com",
    });

    expect(created.targetId).toBe("TARGET_123");
    expect(methods).toEqual(
      expect.arrayContaining([
        "Target.createTarget",
        "Target.attachToTarget",
        "Page.enable",
        "Runtime.enable",
        "Network.enable",
        "DOM.enable",
        "Accessibility.enable",
        "Runtime.runIfWaitingForDebugger",
        "Target.detachFromTarget",
      ]),
    );
  });

  it("creates a target via direct WebSocket URL (skips /json/version)", async () => {
    const wsPort = await startWsServerWithMessages((msg, socket) => {
      if (msg.method !== "Target.createTarget") {
        return;
      }
      socket.send(
        JSON.stringify({
          id: msg.id,
          result: { targetId: "TARGET_WS_DIRECT" },
        }),
      );
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const created = await createTargetViaCdp({
        cdpUrl: `ws://127.0.0.1:${wsPort}/devtools/browser/TEST`,
        url: "https://example.com",
      });

      expect(created.targetId).toBe("TARGET_WS_DIRECT");
      // /json/version should NOT have been called — direct WS skips HTTP discovery
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("honors configured HTTP discovery timeouts when creating a target", async () => {
    const wsPort = await startWsServerWithMessages((msg, socket) => {
      if (msg.method !== "Target.createTarget") {
        return;
      }
      socket.send(JSON.stringify({ id: msg.id, result: { targetId: "TARGET_SLOW" } }));
    });

    httpServer = createServer((req, res) => {
      if (req.url === "/json/version") {
        setTimeout(() => {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/browser/SLOW`,
            }),
          );
        }, 120);
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    await new Promise<void>((resolve) => httpServer?.listen(0, "127.0.0.1", resolve));
    const httpPort = (httpServer.address() as AddressInfo).port;

    await expect(
      createTargetViaCdp({
        cdpUrl: `http://127.0.0.1:${httpPort}`,
        url: "https://example.com",
        timeouts: { httpTimeoutMs: 20 },
      }),
    ).rejects.toThrow();
  });

  it("honors configured WebSocket handshake timeouts when creating a target", async () => {
    wsServer = new WebSocketServer({ noServer: true });
    httpServer = createServer();
    const heldSockets: Duplex[] = [];
    httpServer.on("upgrade", (_req, socket) => {
      heldSockets.push(socket);
      // Hold the TCP connection open without completing the WebSocket handshake.
    });
    await new Promise<void>((resolve) => httpServer?.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as AddressInfo).port;

    try {
      await expect(
        createTargetViaCdp({
          cdpUrl: `ws://127.0.0.1:${port}/devtools/browser/SLOW`,
          url: "https://example.com",
          timeouts: { handshakeTimeoutMs: 20 },
        }),
      ).rejects.toThrow();
    } finally {
      for (const socket of heldSockets) {
        socket.destroy();
      }
    }
  });

  it("preserves query params when connecting via direct WebSocket URL", async () => {
    let receivedHeaders: Record<string, string> = {};
    const wsPort = await startWsServer();
    if (!wsServer) {
      throw new Error("ws server not initialized");
    }
    wsServer.on("headers", (headers, req) => {
      receivedHeaders = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v)]),
      );
    });
    wsServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(rawDataToString(data)) as { id?: number; method?: string };
        if (msg.method === "Target.createTarget") {
          socket.send(JSON.stringify({ id: msg.id, result: { targetId: "T_QP" } }));
        }
      });
    });

    const created = await createTargetViaCdp({
      cdpUrl: `ws://127.0.0.1:${wsPort}/devtools/browser/TEST?apiKey=secret123`,
      url: "https://example.com",
    });
    expect(created.targetId).toBe("T_QP");
    // The WebSocket upgrade request should have been made to the URL with the query param
    expect(receivedHeaders.host).toBe(`127.0.0.1:${wsPort}`);
  });

  it("enforces SSRF policy on the navigation target URL before any CDP connection attempt", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await expect(
        createTargetViaCdp({
          cdpUrl: "ws://127.0.0.1:9222",
          url: "http://127.0.0.1:8080",
        }),
      ).rejects.toBeInstanceOf(SsrFBlockedError);
      // SSRF check happens before any connection attempt
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("blocks private navigation targets by default", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await expect(
        createTargetViaCdp({
          cdpUrl: "http://127.0.0.1:9222",
          url: "http://127.0.0.1:8080",
        }),
      ).rejects.toBeInstanceOf(SsrFBlockedError);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("blocks hostname navigation targets when strict SSRF policy is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await expect(
        createTargetViaCdp({
          cdpUrl: "http://127.0.0.1:9222",
          url: "https://example.com",
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        }),
      ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("blocks unsupported non-network navigation URLs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await expect(
        createTargetViaCdp({
          cdpUrl: "http://127.0.0.1:9222",
          url: "file:///etc/passwd",
        }),
      ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("allows private navigation targets when explicitly configured", async () => {
    const wsPort = await startWsServerWithMessages((msg, socket) => {
      if (msg.method !== "Target.createTarget") {
        return;
      }
      expect(msg.params?.url).toBe("http://127.0.0.1:8080");
      socket.send(
        JSON.stringify({
          id: msg.id,
          result: { targetId: "TARGET_LOCAL" },
        }),
      );
    });

    const httpPort = await startVersionHttpServer({
      webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/browser/TEST`,
    });

    const created = await createTargetViaCdp({
      cdpUrl: `http://127.0.0.1:${httpPort}`,
      url: "http://127.0.0.1:8080",
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(created.targetId).toBe("TARGET_LOCAL");
  });

  it("blocks cross-host websocket pivots returned by /json/version in strict SSRF mode", async () => {
    const httpPort = await startVersionHttpServer({
      webSocketDebuggerUrl: "ws://169.254.169.254:9222/devtools/browser/PIVOT",
    });

    await expect(
      createTargetViaCdp({
        cdpUrl: `http://127.0.0.1:${httpPort}`,
        url: "https://93.184.216.34",
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["127.0.0.1"],
        },
      }),
    ).rejects.toBeInstanceOf(BrowserCdpEndpointBlockedError);
  });

  it("blocks the initial /json/version fetch when the cdpUrl host is outside strict SSRF policy", async () => {
    await expect(
      createTargetViaCdp({
        cdpUrl: "http://169.254.169.254:9222",
        url: "https://93.184.216.34",
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["127.0.0.1"],
        },
      }),
    ).rejects.toBeInstanceOf(BrowserCdpEndpointBlockedError);
  });

  it("blocks direct websocket cdp urls outside strict SSRF policy", async () => {
    await expect(
      createTargetViaCdp({
        cdpUrl: "ws://169.254.169.254:9222/devtools/browser/PIVOT",
        url: "https://93.184.216.34",
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["127.0.0.1"],
        },
      }),
    ).rejects.toBeInstanceOf(BrowserCdpEndpointBlockedError);
  });

  it("evaluates javascript via CDP", async () => {
    const wsPort = await startWsServerWithMessages((msg, socket) => {
      if (msg.method === "Runtime.enable") {
        socket.send(JSON.stringify({ id: msg.id, result: {} }));
        return;
      }
      if (msg.method === "Runtime.evaluate") {
        expect(msg.params?.expression).toBe("1+1");
        socket.send(
          JSON.stringify({
            id: msg.id,
            result: { result: { type: "number", value: 2 } },
          }),
        );
      }
    });

    const res = await evaluateJavaScript({
      wsUrl: `ws://127.0.0.1:${wsPort}`,
      expression: "1+1",
    });

    expect(res.result.type).toBe("number");
    expect(res.result.value).toBe(2);
  });

  it("fails when /json/version omits webSocketDebuggerUrl for an HTTP cdpUrl", async () => {
    const httpPort = await startVersionHttpServer({});
    await expect(
      createTargetViaCdp({
        cdpUrl: `http://127.0.0.1:${httpPort}`,
        url: "https://example.com",
      }),
    ).rejects.toThrow("CDP /json/version missing webSocketDebuggerUrl");
  });

  it("falls back to direct WS connection when /json/version is unavailable for a bare ws:// cdpUrl", async () => {
    // Simulates a Browserless/Browserbase-style provider: the cdpUrl IS a
    // WebSocket root (no /devtools/ path) but there is no HTTP /json/version
    // endpoint. The WS server accepts Target.createTarget directly.
    const wsPort = await startWsServerWithMessages((msg, socket) => {
      if (msg.method === "Target.createTarget") {
        socket.send(JSON.stringify({ id: msg.id, result: { targetId: "WS_FALLBACK" } }));
      }
    });
    // No HTTP server on this port — discovery will fail, triggering the fallback.
    const created = await createTargetViaCdp({
      cdpUrl: `ws://127.0.0.1:${wsPort}`,
      url: "https://example.com",
    });
    expect(created.targetId).toBe("WS_FALLBACK");
  });

  it("falls back to direct WS connection when discovered Browserless endpoint rejects commands", async () => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/json/version")) {
        const addr = server.address() as AddressInfo;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/e/bad`,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      if (req.url?.startsWith("/e/bad")) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });
    wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(rawDataToString(data)) as {
          id?: number;
          method?: string;
        };
        if (msg.method === "Target.createTarget") {
          socket.send(JSON.stringify({ id: msg.id, result: { targetId: "ROOT_FALLBACK" } }));
        } else if (msg.method === "Target.attachToTarget") {
          socket.send(JSON.stringify({ id: msg.id, result: { sessionId: "S1" } }));
        } else if (
          msg.method === "Target.detachFromTarget" ||
          msg.method === "Page.enable" ||
          msg.method === "Runtime.enable" ||
          msg.method === "Network.enable" ||
          msg.method === "DOM.enable" ||
          msg.method === "Accessibility.enable" ||
          msg.method === "Runtime.runIfWaitingForDebugger"
        ) {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const addr = server.address() as AddressInfo;
      const created = await createTargetViaCdp({
        cdpUrl: `ws://127.0.0.1:${addr.port}?token=abc`,
        url: "https://example.com",
      });
      expect(created.targetId).toBe("ROOT_FALLBACK");
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("captures an aria snapshot via CDP", async () => {
    const wsPort = await startWsServerWithMessages((msg, socket) => {
      if (msg.method === "Accessibility.enable") {
        socket.send(JSON.stringify({ id: msg.id, result: {} }));
        return;
      }
      if (msg.method === "Accessibility.getFullAXTree") {
        socket.send(
          JSON.stringify({
            id: msg.id,
            result: {
              nodes: [
                {
                  nodeId: "1",
                  role: { value: "RootWebArea" },
                  name: { value: "" },
                  childIds: ["2"],
                },
                {
                  nodeId: "2",
                  role: { value: "button" },
                  name: { value: "OK" },
                  backendDOMNodeId: 42,
                  childIds: [],
                },
              ],
            },
          }),
        );
      }
    });

    const snap = await snapshotAria({ wsUrl: `ws://127.0.0.1:${wsPort}` });
    expect(snap.nodes.length).toBe(2);
    expect(snap.nodes[0]?.role).toBe("RootWebArea");
    expect(snap.nodes[1]?.role).toBe("button");
    expect(snap.nodes[1]?.name).toBe("OK");
    expect(snap.nodes[1]?.backendDOMNodeId).toBe(42);
    expect(snap.nodes[1]?.depth).toBe(1);
  });

  it("normalizes loopback websocket URLs for remote CDP hosts", () => {
    const normalized = normalizeCdpWsUrl(
      "ws://127.0.0.1:9222/devtools/browser/ABC",
      "http://example.com:9222",
    );
    expect(normalized).toBe("ws://example.com:9222/devtools/browser/ABC");
  });

  it("propagates auth and query params onto normalized websocket URLs", () => {
    const normalized = normalizeCdpWsUrl(
      "ws://127.0.0.1:9222/devtools/browser/ABC",
      "https://user:pass@example.com?token=abc",
    );
    expect(normalized).toBe("wss://user:pass@example.com/devtools/browser/ABC?token=abc");
  });

  it("rewrites localhost absolute-form websocket URLs for remote CDP hosts", () => {
    const normalized = normalizeCdpWsUrl(
      "ws://localhost.:9222/devtools/browser/ABC",
      "https://user:pass@example.com?token=abc",
    );
    expect(normalized).toBe("wss://user:pass@example.com/devtools/browser/ABC?token=abc");
  });

  it("normalizes loopback websocket aliases to the configured CDP loopback host", () => {
    const normalized = normalizeCdpWsUrl(
      "ws://localhost.:18800/devtools/browser/ABC",
      "http://127.0.0.1:18800",
    );
    expect(normalized).toBe("ws://127.0.0.1:18800/devtools/browser/ABC");
  });

  it("rewrites 0.0.0.0 wildcard bind address to remote CDP host", () => {
    const normalized = normalizeCdpWsUrl(
      "ws://0.0.0.0:3000/devtools/browser/ABC",
      "http://192.168.1.202:18850?token=secret",
    );
    expect(normalized).toBe("ws://192.168.1.202:18850/devtools/browser/ABC?token=secret");
  });

  it("rewrites :: wildcard bind address to remote CDP host", () => {
    const normalized = normalizeCdpWsUrl(
      "ws://[::]:3000/devtools/browser/ABC",
      "http://192.168.1.202:18850",
    );
    expect(normalized).toBe("ws://192.168.1.202:18850/devtools/browser/ABC");
  });

  it("keeps existing websocket query params when appending remote CDP query params", () => {
    const normalized = normalizeCdpWsUrl(
      "ws://127.0.0.1:9222/devtools/browser/ABC?session=1&token=ws-token",
      "http://127.0.0.1:9222?token=cdp-token&apiKey=abc",
    );
    expect(normalized).toBe(
      "ws://127.0.0.1:9222/devtools/browser/ABC?session=1&token=ws-token&apiKey=abc",
    );
  });

  it("rewrites wildcard bind addresses to secure remote CDP hosts without clobbering websocket params", () => {
    const normalized = normalizeCdpWsUrl(
      "ws://0.0.0.0:3000/devtools/browser/ABC?session=1&token=ws-token",
      "https://user:pass@example.com:9443?token=cdp-token&apiKey=abc",
    );
    expect(normalized).toBe(
      "wss://user:pass@example.com:9443/devtools/browser/ABC?session=1&token=ws-token&apiKey=abc",
    );
  });

  it("upgrades ws to wss when CDP uses https", () => {
    const normalized = normalizeCdpWsUrl(
      "ws://production-sfo.browserless.io",
      "https://production-sfo.browserless.io?token=abc",
    );
    expect(normalized).toBe("wss://production-sfo.browserless.io/?token=abc");
  });
});

describe("browser error mapping", () => {
  it("maps blocked browser targets to conflict responses", () => {
    const err = new Error(
      "Browser target is unavailable after SSRF policy blocked its navigation.",
    );
    err.name = "BlockedBrowserTargetError";

    expect(toBrowserErrorResponse(err)).toEqual({
      status: 409,
      message: "Browser target is unavailable after SSRF policy blocked its navigation.",
    });
  });

  it("preserves BrowserError mappings", () => {
    expect(toBrowserErrorResponse(new BrowserValidationError("bad input"))).toEqual({
      status: 400,
      message: "bad input",
    });
  });

  it("sanitizes navigation-target SSRF policy errors without leaking raw policy details", () => {
    expect(
      toBrowserErrorResponse(
        new SsrFBlockedError("Blocked hostname or private/internal/special-use IP address"),
      ),
    ).toEqual({
      status: 400,
      message: BROWSER_NAVIGATION_BLOCKED_MESSAGE,
    });
  });

  it("maps CDP endpoint policy blocks to a distinct endpoint-scoped message", () => {
    expect(toBrowserErrorResponse(new BrowserCdpEndpointBlockedError())).toEqual({
      status: 400,
      message: BROWSER_ENDPOINT_BLOCKED_MESSAGE,
    });
  });
});

describe("isWebSocketUrl", () => {
  it("returns true for ws:// URLs", () => {
    expect(isWebSocketUrl("ws://127.0.0.1:9222")).toBe(true);
    expect(isWebSocketUrl("ws://example.com/devtools/browser/ABC")).toBe(true);
  });

  it("returns true for wss:// URLs", () => {
    expect(isWebSocketUrl("wss://connect.example.com")).toBe(true);
    expect(isWebSocketUrl("wss://connect.example.com?apiKey=abc")).toBe(true);
  });

  it("returns false for http:// and https:// URLs", () => {
    expect(isWebSocketUrl("http://127.0.0.1:9222")).toBe(false);
    expect(isWebSocketUrl("https://production-sfo.browserless.io?token=abc")).toBe(false);
  });

  it("returns false for invalid or non-URL strings", () => {
    expect(isWebSocketUrl("not-a-url")).toBe(false);
    expect(isWebSocketUrl("")).toBe(false);
    expect(isWebSocketUrl("ftp://example.com")).toBe(false);
  });
});

describe("isDirectCdpWebSocketEndpoint", () => {
  it("returns true for ws/wss URLs with a /devtools/<kind>/<id> path", () => {
    expect(isDirectCdpWebSocketEndpoint("ws://127.0.0.1:9222/devtools/browser/ABC")).toBe(true);
    expect(isDirectCdpWebSocketEndpoint("ws://127.0.0.1:9222/devtools/page/42")).toBe(true);
    expect(isDirectCdpWebSocketEndpoint("wss://connect.example.com/devtools/browser/xyz")).toBe(
      true,
    );
    expect(
      isDirectCdpWebSocketEndpoint("wss://connect.example.com/devtools/browser/xyz?token=secret"),
    ).toBe(true);
  });

  it("returns false for bare ws/wss URLs without a /devtools/ path (needs discovery)", () => {
    // Reproduces the configuration shape reported in #68027.
    expect(isDirectCdpWebSocketEndpoint("ws://127.0.0.1:9222")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("ws://127.0.0.1:9222/")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("wss://browserless.example")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("wss://browserless.example/?token=abc")).toBe(false);
  });

  it("returns false for ws URLs whose path is not /devtools/*", () => {
    expect(isDirectCdpWebSocketEndpoint("ws://127.0.0.1:9222/json/version")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("ws://127.0.0.1:9222/devtools")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("ws://127.0.0.1:9222/devtools/")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("ws://127.0.0.1:9222/other/path")).toBe(false);
  });

  it("returns false for http/https URLs, invalid URLs, and empty strings", () => {
    expect(isDirectCdpWebSocketEndpoint("http://127.0.0.1:9222/devtools/browser/ABC")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("https://host/devtools/browser/ABC")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("not-a-url")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("")).toBe(false);
  });
});

describe("parseHttpUrl with WebSocket protocols", () => {
  it("accepts wss:// URLs and defaults to port 443", () => {
    const result = parseHttpUrl("wss://connect.example.com?apiKey=abc", "test");
    expect(result.parsed.protocol).toBe("wss:");
    expect(result.port).toBe(443);
    expect(result.normalized).toContain("wss://connect.example.com");
  });

  it("accepts ws:// URLs and defaults to port 80", () => {
    const result = parseHttpUrl("ws://127.0.0.1/devtools", "test");
    expect(result.parsed.protocol).toBe("ws:");
    expect(result.port).toBe(80);
  });

  it("preserves explicit ports in wss:// URLs", () => {
    const result = parseHttpUrl("wss://connect.example.com:8443/path", "test");
    expect(result.port).toBe(8443);
  });

  it("still accepts http:// and https:// URLs", () => {
    const http = parseHttpUrl("http://127.0.0.1:9222", "test");
    expect(http.port).toBe(9222);
    const https = parseHttpUrl("https://browserless.example?token=abc", "test");
    expect(https.port).toBe(443);
  });

  it("rejects unsupported protocols", () => {
    expect(() => parseHttpUrl("ftp://example.com", "test")).toThrow("must be http(s) or ws(s)");
    expect(() => parseHttpUrl("file:///etc/passwd", "test")).toThrow("must be http(s) or ws(s)");
  });
});
const proxyEnvKeys = [
  "ALL_PROXY",
  "all_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
] as const;

beforeEach(() => {
  for (const key of proxyEnvKeys) {
    vi.stubEnv(key, "");
  }
});
