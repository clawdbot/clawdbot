// Browser tests cover cdp.helpers.internal plugin behavior.
import http, { createServer } from "node:http";
import type { Socket } from "node:net";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { toErrorObject } from "../infra/errors.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const sleepWithAbortMock = vi.hoisted(() =>
  vi.fn<(delayMs: number, signal?: AbortSignal, options?: { ref?: boolean }) => void>(),
);
const { registerManagedProxyBrowserCdpBypassMock } = vi.hoisted(() => ({
  registerManagedProxyBrowserCdpBypassMock: vi.fn<(url: string) => (() => void) | undefined>(
    () => undefined,
  ),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    sleepWithAbort: (...args: Parameters<typeof actual.sleepWithAbort>) => {
      const pending = actual.sleepWithAbort(...args);
      sleepWithAbortMock(...args);
      return pending;
    },
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime-internal", () => ({
  registerManagedProxyBrowserCdpBypass: registerManagedProxyBrowserCdpBypassMock,
}));

import { SsrFBlockedError } from "../infra/net/ssrf.js";
import {
  assertCdpEndpointAllowed,
  fetchCdpChecked,
  fetchJson,
  openCdpWebSocket,
  withCdpSocket,
} from "./cdp.helpers.js";
import { BrowserCdpEndpointBlockedError } from "./errors.js";

/**
 * Targets the non-URL-helper code paths in cdp.helpers.ts:
 *   - assertCdpEndpointAllowed invalid-protocol throw
 *   - fetchCdpChecked 429 rate-limit + double-release guard
 *   - createCdpSender message routing (non-number id, unknown id, error body)
 *   - createCdpSender 'error' event + pending rejection
 *   - withCdpSocket open-error / fn-throw / close error-close paths
 */

async function startWsServer() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => {
    wss.once("listening", () => resolve());
  });
  const port = (wss.address() as { port: number }).port;
  return { wss, port, url: `ws://127.0.0.1:${port}/devtools/browser/TEST` };
}

describe("cdp.helpers internal", () => {
  let wss: WebSocketServer | null = null;

  afterEach(async () => {
    fetchWithSsrFGuardMock.mockReset();
    sleepWithAbortMock.mockClear();
    registerManagedProxyBrowserCdpBypassMock.mockReset();
    registerManagedProxyBrowserCdpBypassMock.mockImplementation(() => undefined);
    if (wss) {
      await new Promise<void>((resolve) => {
        wss?.close(() => resolve());
      });
      wss = null;
    }
  });

  function requireGuardedFetchRequest() {
    const [call] = fetchWithSsrFGuardMock.mock.calls;
    if (!call) {
      throw new Error("expected guarded CDP fetch call");
    }
    const [request] = call;
    return request;
  }

  describe("assertCdpEndpointAllowed", () => {
    it("throws on non-http/https/ws/wss protocols under any SSRF policy", async () => {
      await expect(
        assertCdpEndpointAllowed("ftp://example.com/cdp", {
          dangerouslyAllowPrivateNetwork: false,
        }),
      ).rejects.toThrow(/Invalid CDP URL protocol: ftp/);
    });

    it("no-ops when no policy is supplied, regardless of protocol", async () => {
      await expect(assertCdpEndpointAllowed("ftp://example.com/cdp")).resolves.toBeUndefined();
    });

    it("uses the raw ssrfPolicy path for non-loopback hosts", async () => {
      // Non-loopback public host: hits the else branch of the loopback
      // ternary in assertCdpEndpointAllowed. Using a well-known public IP
      // under a permissive policy so the SSRF pin resolves without a DNS
      // mock.
      await expect(
        assertCdpEndpointAllowed("http://93.184.216.34:443/cdp", {
          allowPrivateNetwork: true,
        }),
      ).resolves.toMatchObject({
        addresses: ["93.184.216.34"],
        hostname: "93.184.216.34",
      });
    });
  });

  describe("fetchCdpChecked", () => {
    it("maps HTTP 429 responses into the browser rate-limit error", async () => {
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: { ok: false, status: 429 } as unknown as Response,
        release: vi.fn(async () => {}),
      });
      await expect(
        fetchCdpChecked("http://127.0.0.1:9222/json/version", 250, undefined, {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["127.0.0.1"],
        }),
      ).rejects.toThrow(/rate[ -]?limit/i);
    });

    it("is idempotent when release() is awaited more than once", async () => {
      const release = vi.fn(async () => {});
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: { ok: true, status: 200 } as unknown as Response,
        release,
      });
      const { release: guardedRelease } = await fetchCdpChecked(
        "http://127.0.0.1:9222/json/version",
        250,
        undefined,
        { dangerouslyAllowPrivateNetwork: false, allowedHostnames: ["127.0.0.1"] },
      );
      await guardedRelease();
      await guardedRelease();
      // The underlying release must be invoked exactly once.
      expect(release).toHaveBeenCalledTimes(1);
    });

    it("releases the guarded fetch even when cancelling the unread response fails", async () => {
      const cancel = vi.fn(async () => {
        throw new Error("fixture response cancellation failed");
      });
      const release = vi.fn(async () => {});
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: {
          ok: true,
          status: 200,
          bodyUsed: false,
          body: { cancel },
        } as unknown as Response,
        release,
      });

      const { release: guardedRelease } = await fetchCdpChecked(
        "http://127.0.0.1:9222/json/version",
        250,
        undefined,
        { dangerouslyAllowPrivateNetwork: false, allowedHostnames: ["127.0.0.1"] },
      );

      await expect(guardedRelease()).resolves.toBeUndefined();
      expect(cancel).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(cancel.mock.invocationCallOrder[0]!).toBeLessThan(
        release.mock.invocationCallOrder[0]!,
      );
    });

    it("registers a managed-proxy bypass for the exact sanitized fetch URL", async () => {
      const release = vi.fn();
      registerManagedProxyBrowserCdpBypassMock.mockReturnValueOnce(release);
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: { ok: true, status: 200 } as unknown as Response,
        release: vi.fn(async () => {}),
      });

      const { release: guardedRelease } = await fetchCdpChecked(
        "http://openclaw:secret@127.0.0.1:9222/json/version",
        250,
        undefined,
        { dangerouslyAllowPrivateNetwork: false, allowedHostnames: ["127.0.0.1"] },
      );

      expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledWith(
        "http://127.0.0.1:9222/json/version",
      );
      expect(release).toHaveBeenCalledOnce();
      await guardedRelease();
    });

    it("converts SSRF-blocked errors from the underlying fetch into a browser-scoped error", async () => {
      fetchWithSsrFGuardMock.mockRejectedValueOnce(new SsrFBlockedError("blocked by policy"));
      await expect(
        fetchCdpChecked("http://127.0.0.1:9222/json/version", 250, undefined, {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["127.0.0.1"],
        }),
      ).rejects.toBeInstanceOf(BrowserCdpEndpointBlockedError);
    });

    it("maps non-429 HTTP failures into a generic HTTP error", async () => {
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: { ok: false, status: 503 } as unknown as Response,
        release: vi.fn(async () => {}),
      });
      await expect(
        fetchJson("http://127.0.0.1:9222/json/version", 250, undefined, {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["127.0.0.1"],
        }),
      ).rejects.toThrow(/HTTP 503/);
    });

    it("uses the caller-supplied policy for non-loopback hosts", async () => {
      // Hits the else branch of the isLoopbackHost ternary inside
      // withNoProxyForCdpUrl plus the left-hand side of the
      // `ssrfPolicy ?? { allowPrivateNetwork: true }` coalescing.
      const release = vi.fn(async () => {});
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: { ok: true, status: 200 } as unknown as Response,
        release,
      });
      await fetchCdpChecked("http://93.184.216.34:9222/json/version", 250, undefined, {
        allowPrivateNetwork: true,
      });
      const request = requireGuardedFetchRequest();
      expect(request?.policy?.allowPrivateNetwork).toBe(true);
    });

    it("falls back to a permissive private-network policy when none is supplied on a non-loopback host", async () => {
      // Hits the right-hand side of the `ssrfPolicy ?? { allowPrivateNetwork: true }` default.
      const release = vi.fn(async () => {});
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: { ok: true, status: 200 } as unknown as Response,
        release,
      });
      await fetchCdpChecked("http://93.184.216.34:9222/json/version", 250);
      const request = requireGuardedFetchRequest();
      expect(request?.policy).toEqual({ allowPrivateNetwork: true });
    });
  });

  describe("createCdpSender (via withCdpSocket)", () => {
    function pinnedLookupMock() {
      return vi.fn((hostname: string, options: unknown, callback?: unknown) => {
        const cb = typeof options === "function" ? options : callback;
        if (typeof cb === "function") {
          if (typeof options === "object" && options !== null && "all" in options) {
            cb(null, [{ address: "127.0.0.1", family: 4 }]);
            return undefined as never;
          }
          cb(null, "127.0.0.1", 4);
        }
        return undefined as never;
      });
    }

    it("uses a per-connection agent for pinned WebSocket handshakes", async () => {
      const server = await startWsServer();
      wss = server.wss;
      const lookup = pinnedLookupMock();
      const globalCreateConnection = vi
        .spyOn(http.globalAgent, "createConnection")
        .mockImplementation(() => {
          throw new Error("global agent must not be used for pinned CDP sockets");
        });
      server.wss.on("connection", (socket) => {
        socket.close();
      });

      try {
        const ws = openCdpWebSocket(`ws://cdp-pinned.test:${server.port}/devtools/browser/TEST`, {
          lookup: lookup as never,
        });
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", reject);
        });

        expect(lookup).toHaveBeenCalled();
        expect(globalCreateConnection).not.toHaveBeenCalled();
        ws.close();
      } finally {
        globalCreateConnection.mockRestore();
      }
    });

    it.each([
      { playwrightTransportDefaults: false, expectedMaxPayload: 100 * 1024 * 1024 },
      { playwrightTransportDefaults: true, expectedMaxPayload: 256 * 1024 * 1024 },
    ])(
      "uses the expected payload limit when Playwright transport defaults are $playwrightTransportDefaults",
      async ({ playwrightTransportDefaults, expectedMaxPayload }) => {
        const server = await startWsServer();
        wss = server.wss;
        const ws = openCdpWebSocket(server.url, { playwrightTransportDefaults });

        try {
          await new Promise<void>((resolve, reject) => {
            ws.once("open", resolve);
            ws.once("error", reject);
          });
          const receiver = Reflect.get(ws, "_receiver") as object | undefined;
          const maxPayload = receiver ? Reflect.get(receiver, "_maxPayload") : undefined;

          expect(maxPayload).toBe(expectedMaxPayload);
        } finally {
          ws.close();
        }
      },
    );

    it("preserves IPv6 hostnames in pinned WebSocket agent checks", async () => {
      const server = new WebSocketServer({ port: 0, host: "::1" });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("listening", () => resolve());
          server.once("error", reject);
        });
      } catch {
        return;
      }
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("IPv6 test server did not expose a TCP port");
      }
      server.on("connection", (socket) => {
        socket.close();
      });
      const lookup = vi.fn((_hostname: string, options: unknown, callback?: unknown) => {
        const cb = typeof options === "function" ? options : callback;
        if (typeof cb === "function") {
          if (typeof options === "object" && options !== null && "all" in options) {
            cb(null, [{ address: "::1", family: 6 }]);
            return undefined as never;
          }
          cb(null, "::1", 6);
        }
        return undefined as never;
      });

      try {
        const ws = openCdpWebSocket(`ws://[::1]:${address.port}/devtools/browser/TEST`, {
          lookup: lookup as never,
        });
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", reject);
        });

        ws.close();
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    });

    it("blocks pinned WebSocket redirects before connecting to a new authority", async () => {
      const redirectServer = http.createServer();
      const targetServer = http.createServer();
      let targetConnections = 0;
      targetServer.on("connection", () => {
        targetConnections += 1;
      });
      await new Promise<void>((resolve) => {
        targetServer.listen(0, "127.0.0.1", () => resolve());
      });
      const targetAddress = targetServer.address();
      if (!targetAddress || typeof targetAddress === "string") {
        throw new Error("target server did not expose a TCP port");
      }
      redirectServer.on("upgrade", (_request, socket) => {
        socket.write(
          `HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:${targetAddress.port}/devtools/browser/redirected\r\nConnection: close\r\n\r\n`,
        );
        socket.destroy();
      });
      await new Promise<void>((resolve) => {
        redirectServer.listen(0, "127.0.0.1", () => resolve());
      });
      const redirectAddress = redirectServer.address();
      if (!redirectAddress || typeof redirectAddress === "string") {
        throw new Error("redirect server did not expose a TCP port");
      }
      const ws = openCdpWebSocket(
        `ws://cdp-pinned.test:${redirectAddress.port}/devtools/browser/start`,
        {
          lookup: pinnedLookupMock() as never,
          playwrightTransportDefaults: true,
        },
      );

      try {
        const error = await new Promise<Error>((resolve, reject) => {
          ws.once("open", () => reject(new Error("redirect unexpectedly opened")));
          ws.once("error", (err) => resolve(err instanceof Error ? err : new Error(String(err))));
        });
        expect(error.message).toContain("CDP WebSocket redirect changed authority");
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
        expect(targetConnections).toBe(0);
      } finally {
        ws.close();
        await new Promise<void>((resolve) => {
          redirectServer.close(() => {
            targetServer.close(() => resolve());
          });
        });
      }
    });

    it("ignores messages with a non-numeric id", async () => {
      const server = await startWsServer();
      wss = server.wss;
      let received = 0;
      server.wss.on("connection", (socket) => {
        socket.on("message", (raw) => {
          received += 1;
          const text = rawDataToString(raw);
          const msg = JSON.parse(text) as { id?: number; method?: string };
          // First emit a noise message with a non-number id (should be ignored),
          // then a garbage-json payload (hits the outer catch), then the real
          // response so the caller resolves.
          socket.send(JSON.stringify({ id: "oops", method: "unrelated" }));
          socket.send("not-json");
          socket.send(JSON.stringify({ id: msg.id, result: { echoed: msg.method } }));
        });
      });

      const result = await withCdpSocket<{ echoed: string | undefined }>(
        server.url,
        async (send) => (await send("Test.ping")) as { echoed: string | undefined },
      );
      expect(result.echoed).toBe("Test.ping");
      expect(received).toBe(1);
    });

    it("ignores responses whose id does not match any pending call", async () => {
      const server = await startWsServer();
      wss = server.wss;
      server.wss.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const msg = JSON.parse(rawDataToString(raw)) as { id?: number; method?: string };
          // Stranger id with no pending entry — must be silently dropped.
          socket.send(JSON.stringify({ id: 99999, result: {} }));
          socket.send(JSON.stringify({ id: msg.id, result: { ok: true } }));
        });
      });
      const result = await withCdpSocket<{ ok: boolean }>(
        server.url,
        async (send) => (await send("Test.ping")) as { ok: boolean },
      );
      expect(result.ok).toBe(true);
    });

    it("propagates CDP error-body messages as rejections to the caller", async () => {
      const server = await startWsServer();
      wss = server.wss;
      server.wss.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const msg = JSON.parse(rawDataToString(raw)) as { id?: number };
          socket.send(
            JSON.stringify({
              id: msg.id,
              error: { message: "boom from cdp" },
            }),
          );
        });
      });
      await expect(
        withCdpSocket(server.url, async (send) => {
          await send("Test.failing");
        }),
      ).rejects.toThrow(/boom from cdp/);
    });

    it("rejects in-flight pending calls when the socket closes mid-call", async () => {
      const server = await startWsServer();
      wss = server.wss;
      let callbackCount = 0;
      let connectionCount = 0;
      server.wss.on("connection", (socket) => {
        connectionCount += 1;
        socket.on("message", () => {
          // Defer close so the pending entry is definitely registered.
          setImmediate(() => socket.close());
        });
      });
      await expect(
        withCdpSocket(
          server.url,
          async (send) => {
            callbackCount += 1;
            await send("Test.willClose");
          },
          { handshakeRetries: 2, handshakeRetryDelayMs: 1, handshakeMaxRetryDelayMs: 1 },
        ),
      ).rejects.toThrow(/CDP socket closed/);
      expect(callbackCount).toBe(1);
      expect(connectionCount).toBe(1);
    });

    it("retries websocket failures before any CDP command is sent", async () => {
      let rejectedHandshakes = 0;
      wss = new WebSocketServer({
        port: 0,
        host: "127.0.0.1",
        verifyClient: (_info, cb) => {
          if (rejectedHandshakes === 0) {
            rejectedHandshakes += 1;
            cb(false, 503, "try later");
            return;
          }
          cb(true);
        },
      });
      await new Promise<void>((resolve) => {
        wss?.once("listening", () => resolve());
      });
      const port = (wss.address() as { port: number }).port;
      let callbackCount = 0;
      wss.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const msg = JSON.parse(rawDataToString(raw)) as { id?: number; method?: string };
          socket.send(JSON.stringify({ id: msg.id, result: { echoed: msg.method } }));
        });
      });

      const result = await withCdpSocket<{ echoed?: string }>(
        `ws://127.0.0.1:${port}/devtools/browser/TEST`,
        async (send) => {
          callbackCount += 1;
          return (await send("Test.afterOpen")) as { echoed?: string };
        },
        { handshakeRetries: 2, handshakeRetryDelayMs: 1, handshakeMaxRetryDelayMs: 1 },
      );

      expect(result.echoed).toBe("Test.afterOpen");
      expect(rejectedHandshakes).toBe(1);
      expect(callbackCount).toBe(1);
    });

    it("aborts an authenticated 503 handshake retry before opening another socket", async () => {
      const controller = new AbortController();
      const expectedAuthorization = `Basic ${Buffer.from("openclaw:cdp-abort-test").toString("base64")}`;
      let rejectedHandshakes = 0;
      wss = new WebSocketServer({
        port: 0,
        host: "127.0.0.1",
        verifyClient: (info, callback) => {
          if (info.req.headers.authorization !== expectedAuthorization) {
            callback(false, 401, "authentication required");
            return;
          }
          rejectedHandshakes += 1;
          callback(false, 503, "try later");
        },
      });
      await new Promise<void>((resolve) => {
        wss?.once("listening", resolve);
      });
      const port = (wss.address() as { port: number }).port;
      const pending = withCdpSocket(
        `ws://openclaw:cdp-abort-test@127.0.0.1:${port}/devtools/browser/TEST`,
        async () => "unexpected command",
        {
          handshakeRetries: 3,
          handshakeRetryDelayMs: 2_000,
          handshakeMaxRetryDelayMs: 2_000,
          signal: controller.signal,
        },
      );
      await vi.waitFor(() =>
        expect(sleepWithAbortMock).toHaveBeenCalledWith(expect.any(Number), controller.signal),
      );
      controller.abort(new Error("browser request cancelled"));

      await expect(
        Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("CDP cancellation did not stop handshake retry backoff")),
              300,
            );
            timeout.unref?.();
          }),
        ]),
      ).rejects.toThrow("browser request cancelled");
      expect(rejectedHandshakes).toBe(1);
    });

    it("closes an authenticated CDP socket when its opening handshake is aborted", async () => {
      const controller = new AbortController();
      const server = createServer();
      const sockets = new Set<Socket>();
      const expectedAuthorization = `Basic ${Buffer.from("openclaw:cdp-abort-test").toString("base64")}`;
      let resolveUpgrade: (() => void) | undefined;
      const upgradeStarted = new Promise<void>((resolve) => {
        resolveUpgrade = resolve;
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("end", () => socket.destroy());
        socket.once("close", () => sockets.delete(socket));
      });
      server.on("upgrade", (request, socket) => {
        if (request.headers.authorization !== expectedAuthorization) {
          socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          return;
        }
        // Keep the authenticated TCP socket open without sending an upgrade.
        socket.resume();
        resolveUpgrade?.();
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const port = (server.address() as { port: number }).port;

      try {
        const pending = withCdpSocket(
          `ws://openclaw:cdp-abort-test@127.0.0.1:${port}/devtools/browser/TEST`,
          async () => "unexpected command",
          { handshakeTimeoutMs: 2_000, handshakeRetries: 0, signal: controller.signal },
        );
        await upgradeStarted;
        controller.abort(new Error("browser request cancelled"));

        await expect(
          Promise.race([
            pending,
            new Promise<never>((_resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error("CDP cancellation did not stop the opening handshake")),
                300,
              );
              timeout.unref?.();
            }),
          ]),
        ).rejects.toThrow("browser request cancelled");
        await vi.waitFor(() => expect(sockets.size).toBe(0));
      } finally {
        for (const socket of sockets) {
          socket.destroy();
        }
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });

    it("does not retry rate-limited websocket handshakes", async () => {
      let rejectedHandshakes = 0;
      wss = new WebSocketServer({
        port: 0,
        host: "127.0.0.1",
        verifyClient: (_info, cb) => {
          rejectedHandshakes += 1;
          cb(false, 429, "too many requests");
        },
      });
      await new Promise<void>((resolve) => {
        wss?.once("listening", () => resolve());
      });
      const port = (wss.address() as { port: number }).port;

      await expect(
        withCdpSocket(
          `ws://127.0.0.1:${port}/devtools/browser/TEST`,
          async (send) => {
            await send("Test.neverRuns");
          },
          { handshakeRetries: 2, handshakeRetryDelayMs: 1, handshakeMaxRetryDelayMs: 1 },
        ),
      ).rejects.toThrow(/429/);
      expect(rejectedHandshakes).toBe(1);
    });

    it("rejects and closes the socket when a CDP command exceeds its timeout", async () => {
      const server = await startWsServer();
      wss = server.wss;
      let closed = false;
      server.wss.on("connection", (socket) => {
        socket.on("message", () => {
          // Intentionally leave the command unanswered.
        });
        socket.on("close", () => {
          closed = true;
        });
      });

      await expect(
        withCdpSocket(
          server.url,
          async (send) => {
            await send("Page.captureScreenshot");
          },
          { commandTimeoutMs: 5 },
        ),
      ).rejects.toThrow(/CDP command Page\.captureScreenshot timed out after 5ms/);
      await vi.waitFor(() => expect(closed).toBe(true));
    });
  });

  describe("withCdpSocket", () => {
    it("rejects and rethrows when the WebSocket fails to open", async () => {
      // Port 1 on 127.0.0.1 is reserved and will reliably refuse connections,
      // triggering the open-error branch synchronously.
      await expect(
        withCdpSocket("ws://127.0.0.1:1/devtools/browser/NO", async () => {
          return "unreachable";
        }),
      ).rejects.toThrow(/ECONNREFUSED|CDP socket closed/);
    });

    it("wraps a non-Error callback throw before closing the socket", async () => {
      // `fn` is user-supplied and may throw a non-Error. Exercise the
      // `err instanceof Error ? err : new Error(String(err))` wrap in the
      // fn-throw catch branch.
      const server = await startWsServer();
      wss = server.wss;
      server.wss.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const msg = JSON.parse(rawDataToString(raw)) as { id?: number };
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
        });
      });
      await expect(
        withCdpSocket(server.url, async (send) => {
          await send("Test.ok");
          const rejectRawString = () =>
            Promise.reject(toErrorObject("raw-string-from-callback", "Non-Error rejection"));
          return rejectRawString();
        }),
      ).rejects.toThrow(/raw-string-from-callback/);
    });

    it("rethrows callback errors and still closes the socket cleanly", async () => {
      const server = await startWsServer();
      wss = server.wss;
      server.wss.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const msg = JSON.parse(rawDataToString(raw)) as { id?: number };
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
        });
      });
      await expect(
        withCdpSocket(server.url, async (send) => {
          await send("Test.ok");
          throw new Error("callback boom");
        }),
      ).rejects.toThrow(/callback boom/);
    });
  });

  describe("createCdpSender error/close event forwarding", () => {
    beforeEach(() => {
      // Ensure a fresh mock registry each scenario.
    });

    it("rejects pending calls when the ws emits an error event", async () => {
      const server = await startWsServer();
      wss = server.wss;
      server.wss.on("connection", (socket) => {
        socket.on("message", () => {
          // Emit a synthetic error event on the server-side socket. The
          // client-side ws will see the abrupt close and surface an error.
          socket.terminate();
        });
      });
      await expect(
        withCdpSocket(server.url, async (send) => {
          await send("Test.boom");
        }),
      ).rejects.toThrow(/CDP socket closed|WebSocket was closed/i);
    });

    // The non-Error branch of the `err instanceof Error ? ... : new Error(String(err))`
    // guard is defensive: node's `ws` library always emits Error instances
    // on the 'error' event. Triggering the non-Error branch in a test
    // requires synthetically emitting on the client socket, which the
    // library then treats as an unhandled error event and hangs the
    // suite. The branch is c8-ignored in the source file with an
    // accompanying justification.
  });

  it("moves WebSocket URL userinfo into the Authorization header", async () => {
    const server = await startWsServer();
    wss = server.wss;
    const authorization = new Promise<string | undefined>((resolve) => {
      server.wss.once("connection", (socket, request) => {
        resolve(request.headers.authorization);
        socket.close();
      });
    });
    const credentialedUrl = server.url.replace("ws://", "ws://alice:p%40ss@");
    const ws = openCdpWebSocket(credentialedUrl, { handshakeTimeoutMs: 500 });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    expect(ws.url).toBe(server.url);
    expect(await authorization).toBe(`Basic ${Buffer.from("alice:p@ss").toString("base64")}`);
    ws.close();
  });
});

describe("openCdpWebSocket option handling", () => {
  it("clamps a non-finite handshakeTimeoutMs to the default", () => {
    // Exercises the Number.isFinite false side of the handshake-timeout
    // ternary in openCdpWebSocket.
    const url = "ws://127.0.0.1:1/devtools/browser/X";
    const ws = openCdpWebSocket(url, {
      handshakeTimeoutMs: Number.NaN,
    });
    expect(ws.url).toBe(url);
    // Ensure we don't leak the socket even though we never await it.
    ws.once("error", () => {});
    ws.close();
  });

  it("honours an explicit, finite handshakeTimeoutMs", () => {
    // Exercises the truthy side of the handshake-timeout ternary: both
    // typeof === "number" AND Number.isFinite must be true.
    const url = "ws://127.0.0.1:1/devtools/browser/X";
    const ws = openCdpWebSocket(url, {
      handshakeTimeoutMs: 500,
    });
    expect(ws.url).toBe(url);
    ws.once("error", () => {});
    ws.close();
  });

  it("registers a managed-proxy bypass for the exact websocket URL during construction", () => {
    const release = vi.fn();
    registerManagedProxyBrowserCdpBypassMock.mockReturnValueOnce(release);
    const url = "ws://127.0.0.1:1/devtools/browser/X";
    const ws = openCdpWebSocket(url, {
      handshakeTimeoutMs: 500,
    });

    expect(ws.url).toBe(url);
    expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledWith(url);
    expect(release).toHaveBeenCalledOnce();
    ws.once("error", () => {});
    ws.close();
  });

  it("registers websocket managed-proxy bypass without URL credentials", () => {
    const release = vi.fn();
    registerManagedProxyBrowserCdpBypassMock.mockReturnValueOnce(release);
    const ws = openCdpWebSocket("ws://user:secret@127.0.0.1:1/devtools/browser/X", {
      handshakeTimeoutMs: 500,
    });

    expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledWith(
      "ws://127.0.0.1:1/devtools/browser/X",
    );
    expect(ws.url).toBe("ws://127.0.0.1:1/devtools/browser/X");
    expect(release).toHaveBeenCalledOnce();
    ws.once("error", () => {});
    ws.close();
  });

  it("omits the direct-loopback agent for non-loopback targets", () => {
    // Exercises the falsy side of `agent ? { agent } : {}` — the loopback
    // agent helper returns undefined for non-loopback hosts.
    const url = "ws://93.184.216.34:9222/devtools/browser/X";
    const ws = openCdpWebSocket(url);
    expect(ws.url).toBe(url);
    ws.once("error", () => {});
    ws.close();
  });

  it("injects custom headers when opts.headers is a non-empty object", () => {
    // Exercises the truthy side of `Object.keys(headers).length ? ... : {}`.
    const url = "ws://127.0.0.1:1/devtools/browser/X";
    const ws = openCdpWebSocket(url, {
      headers: { "X-Custom": "abc" },
    });
    expect(ws.url).toBe(url);
    ws.once("error", () => {});
    ws.close();
  });

  it("uses a pinned lookup for websocket connections", async () => {
    const server = await startWsServer();
    try {
      const url = server.url.replace("127.0.0.1", "cdp.test.local");
      const lookup = vi.fn((hostname: string, options: unknown, callback?: unknown) => {
        const cb = typeof options === "function" ? options : callback;
        expect(hostname).toBe("cdp.test.local");
        if (typeof cb === "function") {
          const wantsAll =
            typeof options === "object" && options !== null && (options as { all?: boolean }).all;
          if (wantsAll) {
            cb(null, [{ address: "127.0.0.1", family: 4 }]);
            return;
          }
          cb(null, "127.0.0.1", 4);
        }
      });

      const ws = openCdpWebSocket(url, {
        handshakeTimeoutMs: 500,
        lookup: lookup as never,
      });

      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });

      expect(lookup).toHaveBeenCalled();
      ws.close();
    } finally {
      await new Promise<void>((resolve) => {
        server.wss.close(() => resolve());
      });
    }
  });

  it("forwards pinned lookup options through withCdpSocket", async () => {
    const server = await startWsServer();
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(rawDataToString(data)) as { id?: number };
        socket.send(JSON.stringify({ id: msg.id, result: { ok: true } }));
      });
    });
    try {
      const url = server.url.replace("127.0.0.1", "cdp.test.local");
      const lookup = vi.fn((hostname: string, options: unknown, callback?: unknown) => {
        const cb = typeof options === "function" ? options : callback;
        expect(hostname).toBe("cdp.test.local");
        if (typeof cb === "function") {
          const wantsAll =
            typeof options === "object" && options !== null && (options as { all?: boolean }).all;
          if (wantsAll) {
            cb(null, [{ address: "127.0.0.1", family: 4 }]);
            return;
          }
          cb(null, "127.0.0.1", 4);
        }
      });

      const result = await withCdpSocket(url, async (send) => await send("Browser.getVersion"), {
        handshakeTimeoutMs: 500,
        handshakeRetries: 0,
        lookup: lookup as never,
      });

      expect(result).toStrictEqual({ ok: true });
      expect(lookup).toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => {
        server.wss.close(() => resolve());
      });
    }
  });
});
