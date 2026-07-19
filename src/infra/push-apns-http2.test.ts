// Covers APNs HTTP/2 session and proxy behavior.
import type http2 from "node:http2";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
} from "./net/proxy/active-proxy-state.js";

type ProxyConnectTunnelParams = Parameters<
  typeof import("@openclaw/proxyline").openProxyConnectTunnel
>[0];

const {
  connectSpy,
  tunnelSpy,
  tlsConnectSpy,
  setTargetTlsEvent,
  fakeProxySocket,
  fakeRequest,
  fakeSession,
  fakeTlsSocket,
} = vi.hoisted(() => {
  class FakeEmitter {
    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    on(event: string, handler: (...args: unknown[]) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }

    once(event: string, handler: (...args: unknown[]) => void): this {
      const wrapped = (...args: unknown[]) => {
        this.off(event, wrapped);
        handler(...args);
      };
      return this.on(event, wrapped);
    }

    off(event: string, handler: (...args: unknown[]) => void): this {
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((candidate) => candidate !== handler),
      );
      return this;
    }

    removeListener(event: string, handler: (...args: unknown[]) => void): this {
      return this.off(event, handler);
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }

    reset(): void {
      this.handlers.clear();
    }
  }

  const fakeRequestLocal = Object.assign(new FakeEmitter(), {
    setEncoding: vi.fn(),
    end: vi.fn(() => {
      queueMicrotask(() => {
        const responseBody = Buffer.from(
          '{"reason":"InvalidProviderToken","detail":"split 🚀 response"}',
        );
        const emojiOffset = responseBody.indexOf(Buffer.from("🚀"));
        fakeRequestLocal.emit("response", { ":status": 403 });
        fakeRequestLocal.emit("data", responseBody.subarray(0, emojiOffset + 2));
        fakeRequestLocal.emit("data", responseBody.subarray(emojiOffset + 2));
        fakeRequestLocal.emit("end");
      });
    }),
  });
  const fakeSessionLocal = Object.assign(new FakeEmitter(), {
    closed: false,
    destroyed: false,
    close: vi.fn(() => {
      fakeSessionLocal.closed = true;
    }),
    destroy: vi.fn(() => {
      fakeSessionLocal.destroyed = true;
    }),
    request: vi.fn(() => fakeRequestLocal),
  });
  const fakeProxySocketLocal = { destroy: vi.fn() };
  const fakeTlsSocketLocal = Object.assign(new FakeEmitter(), {
    encrypted: true,
    alpnProtocol: "h2" as string | false,
    destroyed: false,
    destroy: vi.fn(),
  });
  fakeTlsSocketLocal.destroy.mockImplementation(() => {
    fakeTlsSocketLocal.destroyed = true;
  });
  let targetTlsEvent: "secureConnect" | "close" | "error" | undefined = "secureConnect";
  return {
    fakeProxySocket: fakeProxySocketLocal,
    fakeRequest: fakeRequestLocal,
    fakeSession: fakeSessionLocal,
    fakeTlsSocket: fakeTlsSocketLocal,
    connectSpy: vi.fn(() => fakeSessionLocal),
    tunnelSpy: vi.fn(async (_params: ProxyConnectTunnelParams) => fakeProxySocketLocal),
    tlsConnectSpy: vi.fn(() => {
      const event = targetTlsEvent;
      if (event) {
        queueMicrotask(() => {
          if (event === "error") {
            fakeTlsSocketLocal.emit("error", new Error("target TLS failed"));
          } else {
            fakeTlsSocketLocal.emit(event);
          }
        });
      }
      return fakeTlsSocketLocal;
    }),
    setTargetTlsEvent: (event: typeof targetTlsEvent) => {
      targetTlsEvent = event;
    },
  };
});

vi.mock("node:http2", () => ({
  default: { connect: connectSpy, constants: { NGHTTP2_CANCEL: 8 } },
  connect: connectSpy,
  constants: { NGHTTP2_CANCEL: 8 },
}));

vi.mock("node:tls", () => ({
  default: { connect: tlsConnectSpy },
  connect: tlsConnectSpy,
}));

vi.mock("@openclaw/proxyline", () => ({
  openProxyConnectTunnel: tunnelSpy,
}));

function lastTunnelCall(): ProxyConnectTunnelParams {
  const calls = tunnelSpy.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected HTTP CONNECT tunnel call");
  }
  return call[0];
}

function lastConnectCall(): [string, http2.ClientSessionOptions] {
  const calls = connectSpy.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected http2 connect call");
  }
  return call as unknown as [string, http2.ClientSessionOptions];
}

describe("connectApnsHttp2Session", () => {
  beforeEach(() => {
    vi.useRealTimers();
    connectSpy.mockClear();
    tunnelSpy.mockClear();
    tlsConnectSpy.mockClear();
    setTargetTlsEvent("secureConnect");
    fakeProxySocket.destroy.mockClear();
    fakeRequest.reset();
    fakeRequest.setEncoding.mockClear();
    fakeRequest.end.mockClear();
    fakeSession.reset();
    fakeSession.closed = false;
    fakeSession.destroyed = false;
    fakeSession.close.mockClear();
    fakeSession.destroy.mockClear();
    fakeSession.request.mockClear();
    fakeTlsSocket.reset();
    fakeTlsSocket.alpnProtocol = "h2";
    fakeTlsSocket.destroyed = false;
    fakeTlsSocket.destroy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses direct http2.connect when managed proxy is inactive", async () => {
    const { connectApnsHttp2Session } = await import("./push-apns-http2.js");

    const session = await connectApnsHttp2Session({
      authority: "https://api.sandbox.push.apple.com",
      timeoutMs: 10_000,
    });

    expect(session).toBe(fakeSession);
    expect(tunnelSpy).not.toHaveBeenCalled();
    expect(connectSpy).toHaveBeenCalledWith("https://api.sandbox.push.apple.com");
  });

  it("normalizes the default APNs HTTPS port", async () => {
    const { connectApnsHttp2Session } = await import("./push-apns-http2.js");

    await connectApnsHttp2Session({
      authority: "https://api.push.apple.com:443",
      timeoutMs: 10_000,
    });

    expect(connectSpy).toHaveBeenCalledWith("https://api.push.apple.com");
  });

  it("rejects APNs authorities with non-origin URL components", async () => {
    const { connectApnsHttp2Session, probeApnsHttp2ReachabilityViaProxy } =
      await import("./push-apns-http2.js");

    await expect(
      connectApnsHttp2Session({
        authority: "https://token@api.push.apple.com",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("Unsupported APNs authority");
    await expect(
      probeApnsHttp2ReachabilityViaProxy({
        authority: "https://api.sandbox.push.apple.com/3/device/abc",
        proxyUrl: "http://proxy.example:8080",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("Unsupported APNs authority");
  });

  it("uses an HTTP CONNECT tunnel when managed proxy is active", async () => {
    const registration = registerActiveManagedProxyUrl(new URL("https://proxy.example:8443"), {
      loopbackMode: "gateway-only",
      proxyTls: { ca: "active-proxy-ca" },
    });
    const { connectApnsHttp2Session } = await import("./push-apns-http2.js");

    const session = await connectApnsHttp2Session({
      authority: "https://api.push.apple.com",
      timeoutMs: 10_000,
    });
    stopActiveManagedProxyRegistration(registration);

    expect(session).toBe(fakeSession);
    const tunnelCall = lastTunnelCall();
    const proxyUrl = tunnelCall.proxyUrl;
    expect(proxyUrl).toBeInstanceOf(URL);
    if (!(proxyUrl instanceof URL)) {
      throw new Error("expected active managed proxy URL");
    }
    expect(proxyUrl.href).toBe("https://proxy.example:8443/");
    expect(tunnelCall.proxyTls).toEqual({ ca: "active-proxy-ca" });
    expect(tunnelCall.targetHost).toBe("api.push.apple.com");
    expect(tunnelCall.targetPort).toBe(443);
    expect(tunnelCall.timeoutMs).toBe(10_000);
    expect(tlsConnectSpy).toHaveBeenCalledWith({
      socket: fakeProxySocket,
      servername: "api.push.apple.com",
      ALPNProtocols: ["h2"],
    });
    expect(connectSpy).toHaveBeenCalledTimes(1);
    const connectCall = lastConnectCall();
    expect(connectCall[0]).toBe("https://api.push.apple.com");
    const createConnection = connectCall[1].createConnection;
    expect(typeof createConnection).toBe("function");
    expect(createConnection?.(new URL("https://api.push.apple.com"), {})).toBe(fakeTlsSocket);
  });

  it("rejects a non-h2 target tunnel without exposing proxy URL details", async () => {
    fakeTlsSocket.alpnProtocol = "http/1.1";
    const { probeApnsHttp2ReachabilityViaProxy } = await import("./push-apns-http2.js");

    const result = probeApnsHttp2ReachabilityViaProxy({
      authority: "https://api.sandbox.push.apple.com",
      proxyUrl: "http://proxy.example:8080/private?detail=opaque#fragment",
      timeoutMs: 10_000,
    });

    await expect(result).rejects.toThrow(
      "Proxy CONNECT failed via http://proxy.example:8080: APNs TLS tunnel negotiated http/1.1 instead of h2",
    );
    const proxyUrl = lastTunnelCall().proxyUrl;
    expect(proxyUrl).toBeInstanceOf(URL);
    if (!(proxyUrl instanceof URL)) {
      throw new Error("expected normalized proxy URL");
    }
    expect(proxyUrl.pathname).toBe("/");
    expect(proxyUrl.search).toBe("");
    expect(proxyUrl.hash).toBe("");
    expect(String(await result.catch((error: unknown) => error))).not.toMatch(
      /private|opaque|fragment/,
    );
    expect(fakeTlsSocket.destroy).toHaveBeenCalledOnce();
    expect(fakeProxySocket.destroy).toHaveBeenCalledOnce();
  });

  it("times out the target TLS handshake within the CONNECT deadline", async () => {
    const { connectApnsHttp2Session } = await import("./push-apns-http2.js");
    const registration = registerActiveManagedProxyUrl(new URL("http://proxy.example:8080"), {
      loopbackMode: "gateway-only",
    });
    vi.useFakeTimers();
    setTargetTlsEvent(undefined);

    const result = connectApnsHttp2Session({
      authority: "https://api.push.apple.com",
      timeoutMs: 1000,
    });
    const rejection = expect(result).rejects.toThrow(
      "Proxy CONNECT failed via http://proxy.example:8080: Proxy CONNECT timed out after 1000ms",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(tlsConnectSpy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    stopActiveManagedProxyRegistration(registration);
    expect(fakeTlsSocket.destroy).toHaveBeenCalledOnce();
    expect(fakeProxySocket.destroy).toHaveBeenCalledOnce();
  });

  it("rejects malformed proxy auth before opening the native tunnel", async () => {
    const { probeApnsHttp2ReachabilityViaProxy } = await import("./push-apns-http2.js");

    await expect(
      probeApnsHttp2ReachabilityViaProxy({
        authority: "https://api.sandbox.push.apple.com",
        proxyUrl: "http://%E0%A4%A@proxy.example:8080",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("Proxy CONNECT failed via http://proxy.example:8080: URI malformed");
    expect(tunnelSpy).not.toHaveBeenCalled();
  });

  it("caps oversized managed proxy timeouts before opening the APNs tunnel", async () => {
    const registration = registerActiveManagedProxyUrl(new URL("https://proxy.example:8443"), {
      loopbackMode: "gateway-only",
    });
    const { connectApnsHttp2Session } = await import("./push-apns-http2.js");

    await connectApnsHttp2Session({
      authority: "https://api.push.apple.com",
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });
    stopActiveManagedProxyRegistration(registration);

    expect(lastTunnelCall().timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("ignores ambient proxy env when managed proxy is inactive", async () => {
    const originalHttpsProxy = process.env["HTTPS_PROXY"];
    process.env["HTTPS_PROXY"] = "http://ambient.example:8080";
    try {
      const { connectApnsHttp2Session } = await import("./push-apns-http2.js");

      const session = await connectApnsHttp2Session({
        authority: "https://api.push.apple.com",
        timeoutMs: 10_000,
      });

      expect(session).toBe(fakeSession);
      expect(tunnelSpy).not.toHaveBeenCalled();
    } finally {
      if (originalHttpsProxy === undefined) {
        delete process.env["HTTPS_PROXY"];
      } else {
        process.env["HTTPS_PROXY"] = originalHttpsProxy;
      }
    }
  });

  it("probes APNs reachability through an explicit proxy", async () => {
    const { probeApnsHttp2ReachabilityViaProxy } = await import("./push-apns-http2.js");

    const result = await probeApnsHttp2ReachabilityViaProxy({
      authority: "https://api.sandbox.push.apple.com",
      proxyUrl: "http://proxy.example:8080",
      proxyTls: { ca: "probe-proxy-ca" },
      timeoutMs: 10_000,
    });

    expect(result).toEqual({
      status: 403,
      body: '{"reason":"InvalidProviderToken","detail":"split 🚀 response"}',
      responseHeaders: {},
    });
    expect(fakeRequest.setEncoding).not.toHaveBeenCalled();
    const tunnelCall = lastTunnelCall();
    const proxyUrl = tunnelCall.proxyUrl;
    expect(proxyUrl).toBeInstanceOf(URL);
    if (!(proxyUrl instanceof URL)) {
      throw new Error("expected explicit proxy URL");
    }
    expect(proxyUrl.href).toBe("http://proxy.example:8080/");
    expect(tunnelCall.proxyTls).toEqual({ ca: "probe-proxy-ca" });
    expect(tunnelCall?.targetHost).toBe("api.sandbox.push.apple.com");
    expect(tunnelCall?.targetPort).toBe(443);
    expect(tunnelCall?.timeoutMs).toBe(10_000);
    expect(fakeSession.request).toHaveBeenCalledWith({
      ":method": "POST",
      ":path": `/3/device/${"0".repeat(64)}`,
      authorization: "bearer intentionally.invalid.openclaw.proxy.validation",
      "apns-topic": "ai.openclaw.ios",
      "apns-push-type": "alert",
      "apns-priority": "10",
    });
    expect(fakeSession.close).toHaveBeenCalledOnce();
  });

  it("caps oversized explicit proxy probe timeouts", async () => {
    const { probeApnsHttp2ReachabilityViaProxy } = await import("./push-apns-http2.js");

    await probeApnsHttp2ReachabilityViaProxy({
      authority: "https://api.sandbox.push.apple.com",
      proxyUrl: "http://proxy.example:8080",
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(lastTunnelCall().timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("rejects non-APNs authorities", async () => {
    const { connectApnsHttp2Session, probeApnsHttp2ReachabilityViaProxy } =
      await import("./push-apns-http2.js");

    await expect(
      connectApnsHttp2Session({
        authority: "https://example.com",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("Unsupported APNs authority");
    await expect(
      probeApnsHttp2ReachabilityViaProxy({
        authority: "https://example.com",
        proxyUrl: "http://proxy.example:8080",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("Unsupported APNs authority");
  });
});
