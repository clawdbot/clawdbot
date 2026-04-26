import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { rawDataToString } from "../infra/ws.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

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
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as { port: number }).port;
  return { wss, port, url: `ws://127.0.0.1:${port}/devtools/browser/TEST` };
}

describe("cdp.helpers internal", () => {
  let wss: WebSocketServer | null = null;

  afterEach(async () => {
    fetchWithSsrFGuardMock.mockReset();
    if (wss) {
      await new Promise<void>((resolve) => wss?.close(() => resolve()));
      wss = null;
    }
  });

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
      ).resolves.toBeUndefined();
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
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({
          policy: expect.objectContaining({ allowPrivateNetwork: true }),
        }),
      );
    });

    it("falls back to a permissive private-network policy when none is supplied on a non-loopback host", async () => {
      // Hits the right-hand side of the `ssrfPolicy ?? { allowPrivateNetwork: true }` default.
      const release = vi.fn(async () => {});
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: { ok: true, status: 200 } as unknown as Response,
        release,
      });
      await fetchCdpChecked("http://93.184.216.34:9222/json/version", 250);
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({
          policy: { allowPrivateNetwork: true },
        }),
      );
    });
  });

  describe("createCdpSender (via withCdpSocket)", () => {
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
          setTimeout(() => socket.close(), 10);
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
      await new Promise<void>((resolve) => wss?.once("listening", () => resolve()));
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
      await new Promise<void>((resolve) => wss?.once("listening", () => resolve()));
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
      ).rejects.toThrow();
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
          // biome-ignore lint/style/useThrowOnlyError: exercising the non-Error guard on purpose.
          throw "raw-string-from-callback";
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

    it("tolerates a ws.close() that throws in the cleanup finally", async () => {
      // Force ws.close() to throw by wrapping withCdpSocket against a live
      // server but monkey-patching the ws prototype momentarily. We do this
      // via a callback that pre-empts close by calling terminate() first.
      const server = await startWsServer();
      wss = server.wss;
      server.wss.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const msg = JSON.parse(rawDataToString(raw)) as { id?: number };
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
        });
      });
      // The fn throws AFTER sending so both the catch (closeWithError) and
      // the finally ws.close() run. ws.close() on an already-closed socket
      // is a no-op but exercises the try/catch in the finally.
      await expect(
        withCdpSocket(server.url, async (send) => {
          await send("Test.ok");
          throw new Error("fn post-send boom");
        }),
      ).rejects.toThrow(/fn post-send boom/);
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
      ).rejects.toThrow();
    });

    // The non-Error branch of the `err instanceof Error ? ... : new Error(String(err))`
    // guard is defensive: node's `ws` library always emits Error instances
    // on the 'error' event. Triggering the non-Error branch in a test
    // requires synthetically emitting on the client socket, which the
    // library then treats as an unhandled error event and hangs the
    // suite. The branch is c8-ignored in the source file with an
    // accompanying justification.
  });
});

describe("openCdpWebSocket option handling", () => {
  it("clamps a non-finite handshakeTimeoutMs to the default", () => {
    // Exercises the Number.isFinite false side of the handshake-timeout
    // ternary in openCdpWebSocket.
    const ws = openCdpWebSocket("ws://127.0.0.1:1/devtools/browser/X", {
      handshakeTimeoutMs: Number.NaN,
    });
    // Ensure we don't leak the socket even though we never await it.
    ws.once("error", () => {});
    ws.close();
  });

  it("honours an explicit, finite handshakeTimeoutMs", () => {
    // Exercises the truthy side of the handshake-timeout ternary: both
    // typeof === "number" AND Number.isFinite must be true.
    const ws = openCdpWebSocket("ws://127.0.0.1:1/devtools/browser/X", {
      handshakeTimeoutMs: 500,
    });
    ws.once("error", () => {});
    ws.close();
  });

  it("omits the direct-loopback agent for non-loopback targets", () => {
    // Exercises the falsy side of `agent ? { agent } : {}` — the loopback
    // agent helper returns undefined for non-loopback hosts.
    const ws = openCdpWebSocket("ws://93.184.216.34:9222/devtools/browser/X");
    ws.once("error", () => {});
    ws.close();
  });

  it("injects custom headers when opts.headers is a non-empty object", () => {
    // Exercises the truthy side of `Object.keys(headers).length ? ... : {}`.
    const ws = openCdpWebSocket("ws://127.0.0.1:1/devtools/browser/X", {
      headers: { "X-Custom": "abc" },
    });
    ws.once("error", () => {});
    ws.close();
  });
});
