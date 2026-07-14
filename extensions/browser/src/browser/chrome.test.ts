// Browser tests cover chrome plugin behavior.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { rawDataToString } from "../infra/ws.js";
import { diagnoseChromeCdp, formatChromeCdpDiagnostic } from "./chrome.diagnostics.js";
import {
  parseBrowserMajorVersion,
  resolveGoogleChromeExecutableForPlatform,
} from "./chrome.executables.js";
import {
  getChromeWebSocketUrl,
  isChromeCdpOwnedByPid,
  isChromeCdpReady,
  isChromeReachable,
  ManagedChromeCleanupError,
  stopOpenClawChrome,
} from "./chrome.js";
import { BrowserCdpEndpointBlockedError } from "./errors.js";

const CHROME_TEST_WS_MAX_PAYLOAD_BYTES = 1024 * 1024;

type StopChromeTarget = Parameters<typeof stopOpenClawChrome>[0];
type ChromeCdpDiagnostic = Awaited<ReturnType<typeof diagnoseChromeCdp>>;

function expectFailedChromeCdpDiagnostic(
  diagnostic: ChromeCdpDiagnostic,
): Extract<ChromeCdpDiagnostic, { ok: false }> {
  if (diagnostic.ok) {
    throw new Error("Expected failed Chrome CDP diagnostic");
  }
  return diagnostic;
}

function expectReadyChromeCdpDiagnostic(
  diagnostic: ChromeCdpDiagnostic,
): Extract<ChromeCdpDiagnostic, { ok: true }> {
  if (!diagnostic.ok) {
    throw new Error("Expected ready Chrome CDP diagnostic");
  }
  return diagnostic;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withMockChromeCdpServer(params: {
  wsPath: string;
  onConnection?: (wss: WebSocketServer) => void;
  run: (baseUrl: string) => Promise<void>;
}) {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/json/version")) {
      const addr = server.address() as AddressInfo;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}${params.wsPath}`,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: CHROME_TEST_WS_MAX_PAYLOAD_BYTES });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith(params.wsPath)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  params.onConnection?.(wss);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  try {
    const addr = server.address() as AddressInfo;
    await params.run(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

async function stopChromeWithProc(proc: ReturnType<typeof makeChromeTestProc>, timeoutMs: number) {
  await stopOpenClawChrome(
    {
      pid: proc.pid,
      proc,
      cdpPort: 12345,
    } as unknown as StopChromeTarget,
    timeoutMs,
  );
}

function makeChromeTestProc(
  overrides?: Partial<{
    killed: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    exitOnSignal: NodeJS.Signals | false;
  }>,
) {
  const proc = Object.assign(new EventEmitter(), {
    pid: process.pid,
    killed: overrides?.killed ?? false,
    exitCode: overrides?.exitCode ?? null,
    signalCode: overrides?.signalCode ?? null,
    kill: vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      proc.killed = true;
      if ((overrides?.exitOnSignal ?? "SIGTERM") === signal) {
        proc.signalCode = signal;
        proc.emit("exit", null, signal);
      }
      return true;
    }),
  });
  return proc;
}

describe("browser chrome helpers", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports reachability based on /json/version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools" })),
    );
    await expect(isChromeReachable("http://127.0.0.1:12345", 50)).resolves.toBe(true);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 500)));
    await expect(isChromeReachable("http://127.0.0.1:12345", 50)).resolves.toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    await expect(isChromeReachable("http://127.0.0.1:12345", 50)).resolves.toBe(false);
  });

  it("diagnoses /json/version responses that omit the websocket URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ Browser: "Chrome/Mock" })));

    const diagnostic = expectFailedChromeCdpDiagnostic(
      await diagnoseChromeCdp("http://127.0.0.1:12345", 50, 50),
    );
    expect(diagnostic.code).toBe("missing_websocket_debugger_url");
    expect(diagnostic.cdpUrl).toBe("http://127.0.0.1:12345");
  });

  it("preserves invalid-json diagnostics for bounded /json/version reads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{", {
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const diagnostic = expectFailedChromeCdpDiagnostic(
      await diagnoseChromeCdp("http://127.0.0.1:12345", 50, 50),
    );
    expect(diagnostic.code).toBe("invalid_json");
  });

  it("allows loopback CDP probes while still blocking non-loopback private targets in strict SSRF mode", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools" }))
      .mockRejectedValue(new Error("should not be called"));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      isChromeReachable("http://127.0.0.1:12345", 50, {
        dangerouslyAllowPrivateNetwork: false,
      }),
    ).resolves.toBe(true);
    await expect(
      isChromeReachable("http://169.254.169.254:12345", 50, {
        dangerouslyAllowPrivateNetwork: false,
      }),
    ).resolves.toBe(false);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("blocks cross-host websocket pivots returned by /json/version in strict SSRF mode", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/json/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            webSocketDebuggerUrl: "ws://169.254.169.254:9222/devtools/browser/pivot",
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });

    try {
      const addr = server.address() as AddressInfo;
      await expect(
        getChromeWebSocketUrl(`http://127.0.0.1:${addr.port}`, 1000, {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["127.0.0.1"],
        }),
      ).rejects.toBeInstanceOf(BrowserCdpEndpointBlockedError);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("keeps authenticated trailing-slash discovery inside the guarded fetch path", async () => {
    const requests: Array<{ authorization: string | undefined; url: string | undefined }> = [];
    const authorization = `Basic ${Buffer.from("browser-user:browser-password").toString("base64")}`;
    const server = createServer((req, res) => {
      requests.push({ authorization: req.headers.authorization, url: req.url });
      if (req.url === "/json/version/" && req.headers.authorization === authorization) {
        const addr = server.address() as AddressInfo;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/browser/authenticated`,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });

    try {
      const addr = server.address() as AddressInfo;
      const credentialedUrl = `http://browser-user:browser-password@127.0.0.1:${addr.port}`;
      await expect(isChromeReachable(credentialedUrl, 1000)).resolves.toBe(true);
      expect(requests).toEqual([
        { authorization, url: "/json/version" },
        { authorization, url: "/json/version/" },
      ]);
      requests.length = 0;
      await expect(getChromeWebSocketUrl(credentialedUrl, 1000)).resolves.toBe(
        `ws://browser-user:browser-password@127.0.0.1:${addr.port}/devtools/browser/authenticated`,
      );
      expect(requests).toEqual([
        { authorization, url: "/json/version" },
        { authorization, url: "/json/version/" },
      ]);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("reports cdpReady only when Browser.getVersion command succeeds", async () => {
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/health",
      onConnection: (wss) => {
        wss.on("connection", (ws) => {
          ws.on("message", (raw) => {
            let message: { id?: unknown; method?: unknown } | null;
            try {
              const text =
                typeof raw === "string"
                  ? raw
                  : Buffer.isBuffer(raw)
                    ? raw.toString("utf8")
                    : Array.isArray(raw)
                      ? Buffer.concat(raw).toString("utf8")
                      : Buffer.from(raw).toString("utf8");
              message = JSON.parse(text) as { id?: unknown; method?: unknown };
            } catch {
              return;
            }
            if (message?.method === "Browser.getVersion" && message.id === 1) {
              ws.send(
                JSON.stringify({
                  id: 1,
                  result: { product: "Chrome/Mock" },
                }),
              );
            }
          });
        });
      },
      run: async (baseUrl) => {
        await expect(isChromeCdpReady(baseUrl, 300, 400)).resolves.toBe(true);
      },
    });
  });

  it("reports cdpReady false when websocket opens but command channel is stale", async () => {
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/stale",
      // Simulate a stale command channel: WS opens but never responds to commands.
      onConnection: (wss) => wss.on("connection", (_ws) => {}),
      run: async (baseUrl) => {
        await expect(isChromeCdpReady(baseUrl, 300, 5)).resolves.toBe(false);
      },
    });
  });

  it("diagnoses stale websocket command channels with the discovered websocket URL", async () => {
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/stale-diagnostic",
      onConnection: (wss) => wss.on("connection", (_ws) => {}),
      run: async (baseUrl) => {
        const diagnostic = expectFailedChromeCdpDiagnostic(
          await diagnoseChromeCdp(baseUrl, 300, 50),
        );
        expect(diagnostic.code).toBe("websocket_health_command_timeout");
        expect(diagnostic.wsUrl).toMatch(/\/devtools\/browser\/stale-diagnostic$/);
      },
    });
  });

  it("formats diagnostics with redacted CDP credentials", () => {
    const formatted = formatChromeCdpDiagnostic({
      ok: false,
      code: "websocket_handshake_failed",
      cdpUrl: "https://user:pass@browserless.example.com?token=supersecret123",
      wsUrl: "wss://user:pass@browserless.example.com/devtools/browser/1?token=supersecret123",
      message: "connect ECONNREFUSED browserless.example.com",
      elapsedMs: 12,
    });

    expect(formatted).toContain("websocket_handshake_failed");
    expect(formatted).toContain("https://browserless.example.com/?token=***");
    expect(formatted).toContain("wss://browserless.example.com/devtools/browser/1?token=***");
    expect(formatted).not.toContain("user");
    expect(formatted).not.toContain("pass");
    expect(formatted).not.toContain("supersecret123");
  });

  it.each(["fetch failed: other side closed", "fetch failed: read ECONNRESET"])(
    "adds a WSL2 portproxy hint for empty HTTP CDP replies: %s",
    (message) => {
      const formatted = formatChromeCdpDiagnostic({
        ok: false,
        code: "http_unreachable",
        cdpUrl: "http://172.30.144.1:9222",
        message,
        elapsedMs: 12,
      });

      expect(formatted).toContain("netsh interface portproxy show all");
      expect(formatted).toContain("svchost/iphlpsvc owns");
      expect(formatted).toContain("127.0.0.1:9222 -> 127.0.0.1:9222");
      expect(formatted).toContain("falls back to [::1] only when the IPv4 bind fails");
      expect(formatted).toContain("v4tov6");
    },
  );

  it("surfaces Windows listener checks from a real empty-reply CDP probe", async () => {
    // A broken portproxy accepts the WSL-side socket and closes it without an
    // HTTP body. The host checks must survive the full probe/format path.
    const portproxy = createTcpServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      portproxy.listen(0, "127.0.0.1", () => resolve());
      portproxy.once("error", reject);
    });
    try {
      const addr = portproxy.address() as AddressInfo;
      const diagnostic = expectFailedChromeCdpDiagnostic(
        await diagnoseChromeCdp(`http://127.0.0.1:${addr.port}`, 500, 50),
      );
      expect(diagnostic.code).toBe("http_unreachable");
      const formatted = formatChromeCdpDiagnostic(diagnostic);
      expect(formatted).toContain("netstat -ano");
      expect(formatted).toContain("v4tov6");
      expect(formatted).not.toContain("Chrome 136");
    } finally {
      await new Promise<void>((resolve) => {
        portproxy.close(() => resolve());
      });
    }
  });

  it("probes direct ws:// CDP URLs (with /devtools/ path) via handshake instead of HTTP", async () => {
    // A direct WS endpoint like ws://host/devtools/browser/<uuid> is already
    // the handshake target — isChromeReachable must NOT hit /json/version.
    const fetchSpy = vi.fn().mockRejectedValue(new Error("should not be called"));
    vi.stubGlobal("fetch", fetchSpy);
    // No WS server listening → handshake fails → not reachable
    await expect(isChromeReachable("ws://127.0.0.1:19999/devtools/browser/ABC", 50)).resolves.toBe(
      false,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to HTTP /json/version discovery for a bare ws:// CDP URL (issue #68027)", async () => {
    // A user-supplied cdpUrl of `ws://host:port` without a /devtools/ path
    // points at Chrome's debug root; Chrome only accepts WS upgrades on the
    // specific path returned by `GET /json/version`. The reachability probe
    // must normalise the ws scheme to http for discovery, not attempt a
    // handshake at the bare root.
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/DISCOVERED",
      run: async (baseUrl) => {
        const url = new URL(baseUrl);
        const wsOnlyBase = `ws://${url.host}`;
        await expect(isChromeReachable(wsOnlyBase, 300)).resolves.toBe(true);
        await expect(getChromeWebSocketUrl(wsOnlyBase, 300)).resolves.toBe(
          `ws://${url.host}/devtools/browser/DISCOVERED`,
        );
      },
    });
  });

  it("uses HTTP discovery before readiness checks for a bare ws:// CDP URL", async () => {
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/READY",
      onConnection: (wss) => {
        wss.on("connection", (ws) => {
          ws.on("message", (raw) => {
            const message = JSON.parse(rawDataToString(raw)) as { id?: number; method?: string };
            if (message.method === "Browser.getVersion" && message.id === 1) {
              ws.send(
                JSON.stringify({
                  id: 1,
                  result: { product: "Chrome/Mock" },
                }),
              );
            }
          });
        });
      },
      run: async (baseUrl) => {
        const url = new URL(baseUrl);
        const wsOnlyBase = `ws://${url.host}?token=abc`;
        await expect(isChromeCdpReady(wsOnlyBase, 300, 400)).resolves.toBe(true);
        const diagnostic = expectReadyChromeCdpDiagnostic(
          await diagnoseChromeCdp(wsOnlyBase, 300, 400),
        );
        expect(diagnostic.wsUrl).toBe(`ws://${url.host}/devtools/browser/READY?token=abc`);
      },
    });
  });

  it("falls back to the bare WebSocket root when discovered Browserless endpoint rejects readiness", async () => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/json/version")) {
        const addr = server.address() as AddressInfo;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            Browser: "Browserless/Mock",
            webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/e/bad`,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: CHROME_TEST_WS_MAX_PAYLOAD_BYTES,
    });
    server.on("upgrade", (req, socket, head) => {
      if (req.url?.startsWith("/e/bad")) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const message = JSON.parse(rawDataToString(raw)) as { id?: number; method?: string };
        if (message.method === "Browser.getVersion" && message.id === 1) {
          ws.send(
            JSON.stringify({
              id: 1,
              result: {
                product: "Browserless/Mock",
                userAgent: "Browserless Mock UA",
              },
            }),
          );
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    try {
      const addr = server.address() as AddressInfo;
      const wsOnlyBase = `ws://127.0.0.1:${addr.port}?token=abc`;
      await expect(isChromeCdpReady(wsOnlyBase, 300, 400)).resolves.toBe(true);
      const diagnostic = expectReadyChromeCdpDiagnostic(
        await diagnoseChromeCdp(wsOnlyBase, 300, 400),
      );
      expect(diagnostic.wsUrl).toBe(wsOnlyBase);
      expect(diagnostic.browser).toBe("Browserless/Mock");
    } finally {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("reports unreachable when a bare ws:// CDP URL points at a server with no /json/version and refuses WS", async () => {
    // Negative counterpart to the #68027 happy path — a bare ws URL
    // pointed at a port that neither serves /json/version nor accepts
    // WS upgrades must resolve false without hanging.
    const fetchSpy = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchSpy);
    // Port 19998 is not listening; the WS fallback probe will also fail.
    await expect(isChromeReachable("ws://127.0.0.1:19998", 50)).resolves.toBe(false);
    // fetch() must have been invoked — HTTP discovery is always tried first.
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("falls back to a direct WS probe when /json/version is unavailable for a bare ws:// URL", async () => {
    // Covers the WS-fallback path in isChromeReachable: /json/version returns
    // nothing (simulated by empty response) but the WS socket IS accepting
    // connections (Browserless/Browserbase-style provider).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({})), // empty — no webSocketDebuggerUrl
    );
    // A real WS server accepts the handshake.
    const wss = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      maxPayload: CHROME_TEST_WS_MAX_PAYLOAD_BYTES,
    });
    await new Promise<void>((resolve) => {
      wss.once("listening", () => resolve());
    });
    const port = (wss.address() as AddressInfo).port;
    try {
      await expect(isChromeReachable(`ws://127.0.0.1:${port}`, 500)).resolves.toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    }
  });

  it("falls back to a direct WS readiness check when /json/version has no debugger URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));
    const wss = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      maxPayload: CHROME_TEST_WS_MAX_PAYLOAD_BYTES,
    });
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const message = JSON.parse(rawDataToString(raw)) as { id?: number; method?: string };
        if (message.method === "Browser.getVersion" && message.id === 1) {
          ws.send(
            JSON.stringify({
              id: 1,
              result: {
                product: "Browserless/Mock",
                userAgent: "Browserless Mock UA",
              },
            }),
          );
        }
      });
    });
    await new Promise<void>((resolve) => {
      wss.once("listening", () => resolve());
    });
    const port = (wss.address() as AddressInfo).port;
    try {
      await expect(isChromeCdpReady(`ws://127.0.0.1:${port}`, 500, 500)).resolves.toBe(true);
      const diagnostic = expectReadyChromeCdpDiagnostic(
        await diagnoseChromeCdp(`ws://127.0.0.1:${port}`, 500, 500),
      );
      expect(diagnostic.wsUrl).toBe(`ws://127.0.0.1:${port}`);
      expect(diagnostic.browser).toBe("Browserless/Mock");
      expect(diagnostic.userAgent).toBe("Browserless Mock UA");
    } finally {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    }
  });

  it("returns the original ws:// URL from getChromeWebSocketUrl when /json/version provides no debugger URL", async () => {
    // Covers the getChromeWebSocketUrl WS-fallback: discovery succeeds but
    // webSocketDebuggerUrl is absent — the original URL is returned as-is.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));
    await expect(getChromeWebSocketUrl("ws://127.0.0.1:12345", 50)).resolves.toBe(
      "ws://127.0.0.1:12345",
    );
  });

  it("verifies the exact managed browser pid through CDP SystemInfo", async () => {
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/process-owner",
      onConnection: (wss) => {
        wss.on("connection", (ws) => {
          ws.on("message", (data) => {
            const req = JSON.parse(rawDataToString(data)) as { id: number; method: string };
            expect(req.method).toBe("SystemInfo.getProcessInfo");
            ws.send(
              JSON.stringify({
                id: req.id,
                result: { processInfo: [{ type: "browser", id: 44001 }] },
              }),
            );
          });
        });
      },
      run: async (baseUrl) => {
        await expect(isChromeCdpOwnedByPid(baseUrl, 44001, 100)).resolves.toBe(true);
        await expect(isChromeCdpOwnedByPid(baseUrl, 44002, 100)).resolves.toBe(false);
      },
    });
  });

  it("does not mistake ChildProcess.killed for process exit", async () => {
    const proc = makeChromeTestProc({ killed: true });
    await stopChromeWithProc(proc, 10);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each([
    { label: "exited", proc: makeChromeTestProc({ exitCode: 0 }) },
    { label: "signaled", proc: makeChromeTestProc({ signalCode: "SIGTERM" }) },
  ])("does not close a reused CDP port after the tracked process has $label", async ({ proc }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await stopChromeWithProc(proc, 10);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("stopOpenClawChrome sends SIGTERM and returns once CDP is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const proc = makeChromeTestProc();
    await stopChromeWithProc(proc, 10);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("stopOpenClawChrome asks Chrome to close gracefully before sending a signal", async () => {
    let closeRequested = false;
    const proc = makeChromeTestProc({ exitOnSignal: false });
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/graceful-stop",
      onConnection: (wss) => {
        wss.on("connection", (ws) => {
          ws.on("message", (data) => {
            const req = JSON.parse(rawDataToString(data)) as { id: number; method: string };
            if (req.method === "SystemInfo.getProcessInfo") {
              ws.send(
                JSON.stringify({
                  id: req.id,
                  result: { processInfo: [{ type: "browser", id: proc.pid }] },
                }),
              );
              return;
            }
            expect(req.method).toBe("Browser.close");
            closeRequested = true;
            proc.exitCode = 0;
            proc.emit("exit", 0, null);
            ws.send(JSON.stringify({ id: req.id, result: {} }));
          });
        });
      },
      run: async (baseUrl) => {
        const browserWsUrl = `${baseUrl.replace("http://", "ws://")}/devtools/browser/graceful-stop`;
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            if (closeRequested) {
              throw new Error("down");
            }
            return jsonResponse({ webSocketDebuggerUrl: browserWsUrl });
          }),
        );
        await stopChromeWithProc(proc, 20);

        expect(closeRequested).toBe(true);
        expect(proc.kill).not.toHaveBeenCalled();
      },
    });
  });

  it("stopOpenClawChrome escalates when graceful close leaves CDP reachable", async () => {
    const proc = makeChromeTestProc({ exitOnSignal: "SIGKILL" });
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/stuck-stop",
      onConnection: (wss) => {
        wss.on("connection", (ws) => {
          ws.on("message", (data) => {
            const req = JSON.parse(rawDataToString(data)) as { id: number; method: string };
            if (req.method === "SystemInfo.getProcessInfo") {
              ws.send(
                JSON.stringify({
                  id: req.id,
                  result: { processInfo: [{ type: "browser", id: proc.pid }] },
                }),
              );
              return;
            }
            expect(req.method).toBe("Browser.close");
            ws.send(JSON.stringify({ id: req.id, result: {} }));
          });
        });
      },
      run: async (baseUrl) => {
        const browserWsUrl = `${baseUrl.replace("http://", "ws://")}/devtools/browser/stuck-stop`;
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => jsonResponse({ webSocketDebuggerUrl: browserWsUrl })),
        );
        await stopChromeWithProc(proc, 1);
        expect(proc.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
        expect(proc.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      },
    });
  });

  it("returns the exact child when shutdown cannot prove process exit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const proc = makeChromeTestProc({ exitOnSignal: false });

    const error = await stopChromeWithProc(proc, 1).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ManagedChromeCleanupError);
    expect(error).toMatchObject({ running: { pid: proc.pid, proc } });
    expect(proc.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(proc.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("does not close a replacement browser that reused the managed CDP port", async () => {
    const methods: string[] = [];
    const proc = makeChromeTestProc();
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/replacement",
      onConnection: (wss) => {
        wss.on("connection", (ws) => {
          ws.on("message", (data) => {
            const req = JSON.parse(rawDataToString(data)) as { id: number; method: string };
            methods.push(req.method);
            ws.send(
              JSON.stringify({
                id: req.id,
                result: { processInfo: [{ type: "browser", id: proc.pid + 1 }] },
              }),
            );
          });
        });
      },
      run: async (baseUrl) => {
        const browserWsUrl = `${baseUrl.replace("http://", "ws://")}/devtools/browser/replacement`;
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => jsonResponse({ webSocketDebuggerUrl: browserWsUrl })),
        );

        await stopChromeWithProc(proc, 10);

        expect(methods).toEqual(["SystemInfo.getProcessInfo"]);
        expect(proc.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      },
    });
  });
});

describe("chrome executables", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses odd dotted browser version tokens using the last match", () => {
    expect(parseBrowserMajorVersion("Chromium 3.0/1.2.3")).toBe(1);
  });

  it("returns null when no dotted version token exists", () => {
    expect(parseBrowserMajorVersion("no version here")).toBeNull();
  });

  it("classifies beta Linux Google Chrome builds as canary", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return String(candidate) === "/usr/bin/google-chrome-beta";
    });

    expect(resolveGoogleChromeExecutableForPlatform("linux")).toEqual({
      kind: "canary",
      path: "/usr/bin/google-chrome-beta",
    });
  });

  it("classifies unstable Linux Google Chrome builds as canary", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return String(candidate) === "/usr/bin/google-chrome-unstable";
    });

    expect(resolveGoogleChromeExecutableForPlatform("linux")).toEqual({
      kind: "canary",
      path: "/usr/bin/google-chrome-unstable",
    });
  });

  it("finds Linux Google Chrome under /opt", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return String(candidate) === "/opt/google/chrome/chrome";
    });

    expect(resolveGoogleChromeExecutableForPlatform("linux")).toEqual({
      kind: "chrome",
      path: "/opt/google/chrome/chrome",
    });
  });
});
