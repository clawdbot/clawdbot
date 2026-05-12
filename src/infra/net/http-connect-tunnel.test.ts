import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeSocket extends EventEmitter {
  public readonly writes: string[] = [];
  public readonly unshifted: Buffer[] = [];
  public destroyed = false;
  public writable = true;
  public readonly alpnProtocol: string | false;
  public readonly emitSecureConnectOnConnect: boolean;

  constructor(
    private readonly response?: string,
    options: { alpnProtocol?: string | false; emitSecureConnectOnConnect?: boolean } = {},
  ) {
    super();
    this.alpnProtocol = options.alpnProtocol ?? "h2";
    this.emitSecureConnectOnConnect = options.emitSecureConnectOnConnect ?? true;
  }

  write(data: string): void {
    this.writes.push(data);
    const response = this.response;
    if (response !== undefined) {
      queueMicrotask(() => this.emit("data", Buffer.from(response, "latin1")));
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.writable = false;
    this.emit("close");
  }

  unshift(data: Buffer): void {
    this.unshifted.push(data);
  }
}

const {
  netConnectSpy,
  tlsConnectSpy,
  setNextNetSocket,
  setNextProxyTlsSocket,
  setNextTargetTlsSocket,
} = vi.hoisted(() => {
  let nextNetSocket: FakeSocket | undefined;
  let nextProxyTlsSocket: FakeSocket | undefined;
  let nextTargetTlsSocket: FakeSocket | undefined;

  return {
    setNextNetSocket: (socket: FakeSocket) => {
      nextNetSocket = socket;
    },
    setNextProxyTlsSocket: (socket: FakeSocket) => {
      nextProxyTlsSocket = socket;
    },
    setNextTargetTlsSocket: (socket: FakeSocket) => {
      nextTargetTlsSocket = socket;
    },
    netConnectSpy: vi.fn(() => {
      if (!nextNetSocket) {
        throw new Error("nextNetSocket not set");
      }
      const socket = nextNetSocket;
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    }),
    tlsConnectSpy: vi.fn((options: { socket?: FakeSocket }) => {
      if (options.socket) {
        if (!nextTargetTlsSocket) {
          throw new Error("nextTargetTlsSocket not set");
        }
        const socket = nextTargetTlsSocket;
        if (socket.emitSecureConnectOnConnect) {
          queueMicrotask(() => socket.emit("secureConnect"));
        }
        return socket;
      }
      if (!nextProxyTlsSocket) {
        throw new Error("nextProxyTlsSocket not set");
      }
      const socket = nextProxyTlsSocket;
      queueMicrotask(() => socket.emit("secureConnect"));
      return socket;
    }),
  };
});

vi.mock("node:net", () => ({
  connect: netConnectSpy,
}));

vi.mock("node:tls", () => ({
  connect: tlsConnectSpy,
}));

function requireFirstTlsConnectOptions(): unknown {
  const [call] = tlsConnectSpy.mock.calls;
  if (!call) {
    throw new Error("expected TLS connect call");
  }
  return call[0];
}

describe("openHttpConnectTunnel", () => {
  beforeEach(() => {
    vi.useRealTimers();
    netConnectSpy.mockClear();
    tlsConnectSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens an HTTP CONNECT tunnel through the configured proxy", async () => {
    const proxySocket = new FakeSocket("HTTP/1.1 200 Connection Established\r\n\r\n");
    const targetTlsSocket = new FakeSocket();
    setNextNetSocket(proxySocket);
    setNextTargetTlsSocket(targetTlsSocket);
    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    const result = await openHttpConnectTunnel({
      proxyUrl: new URL("http://proxy.example:8080"),
      targetHost: "api.push.apple.com",
      targetPort: 443,
      timeoutMs: 10_000,
    });

    expect(result).toBe(targetTlsSocket);
    expect(netConnectSpy).toHaveBeenCalledWith({ host: "proxy.example", port: 8080 });
    expect(proxySocket.writes[0]).toBe(
      [
        "CONNECT api.push.apple.com:443 HTTP/1.1",
        "Host: api.push.apple.com:443",
        "Proxy-Connection: Keep-Alive",
        "",
        "",
      ].join("\r\n"),
    );
    expect(tlsConnectSpy).toHaveBeenLastCalledWith({
      socket: proxySocket,
      servername: "api.push.apple.com",
      ALPNProtocols: ["h2"],
    });
  });

  it("supports HTTPS proxy URLs", async () => {
    const proxySocket = new FakeSocket("HTTP/1.1 200 Connection Established\r\n\r\n");
    const targetTlsSocket = new FakeSocket();
    setNextProxyTlsSocket(proxySocket);
    setNextTargetTlsSocket(targetTlsSocket);
    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    await openHttpConnectTunnel({
      proxyUrl: new URL("https://proxy.example:8443"),
      targetHost: "api.sandbox.push.apple.com",
      targetPort: 443,
    });

    expect(requireFirstTlsConnectOptions()).toEqual({
      host: "proxy.example",
      port: 8443,
      servername: "proxy.example",
      ALPNProtocols: ["http/1.1"],
    });
    expect(tlsConnectSpy).toHaveBeenLastCalledWith({
      socket: proxySocket,
      servername: "api.sandbox.push.apple.com",
      ALPNProtocols: ["h2"],
    });
  });

  it("sends basic proxy authorization and redacts credentials when CONNECT fails", async () => {
    const proxySocket = new FakeSocket("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    setNextNetSocket(proxySocket);
    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    await expect(
      openHttpConnectTunnel({
        proxyUrl: new URL("http://user:secret@proxy.example:8080"),
        targetHost: "api.push.apple.com",
        targetPort: 443,
      }),
    ).rejects.toThrow(
      "Proxy CONNECT failed via http://proxy.example:8080: HTTP/1.1 407 Proxy Authentication Required",
    );
    expect(proxySocket.writes[0]).toContain(
      `Proxy-Authorization: Basic ${Buffer.from("user:secret").toString("base64")}`,
    );
    expect(proxySocket.destroyed).toBe(true);
  });

  it("redacts proxy URL query and fragment values when CONNECT fails", async () => {
    const proxySocket = new FakeSocket("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    setNextNetSocket(proxySocket);
    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    let caught: unknown;
    try {
      await openHttpConnectTunnel({
        proxyUrl: new URL("http://user:secret@proxy.example:8080/?token=hidden#fragment"),
        targetHost: "api.push.apple.com",
        targetPort: 443,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) {
      throw new Error("expected CONNECT failure");
    }
    expect(caught.message).toBe(
      "Proxy CONNECT failed via http://proxy.example:8080: HTTP/1.1 407 Proxy Authentication Required",
    );
    expect(caught.message).not.toContain("secret");
    expect(caught.message).not.toContain("hidden");
    expect(caught.message).not.toContain("fragment");
  });

  it("rejects malformed proxy credentials through the normal cleanup path", async () => {
    const proxySocket = new FakeSocket();
    setNextNetSocket(proxySocket);
    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    await expect(
      openHttpConnectTunnel({
        proxyUrl: new URL("http://%E0%A4%A@proxy.example:8080"),
        targetHost: "api.push.apple.com",
        targetPort: 443,
      }),
    ).rejects.toThrow("Proxy CONNECT failed via http://proxy.example:8080: URI malformed");
    expect(proxySocket.destroyed).toBe(true);
  });

  it("caps unterminated CONNECT response headers", async () => {
    const proxySocket = new FakeSocket(`HTTP/1.1 200 ${"a".repeat(17 * 1024)}`);
    setNextNetSocket(proxySocket);
    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    await expect(
      openHttpConnectTunnel({
        proxyUrl: new URL("http://proxy.example:8080"),
        targetHost: "api.push.apple.com",
        targetPort: 443,
      }),
    ).rejects.toThrow(
      "Proxy CONNECT failed via http://proxy.example:8080: Proxy CONNECT response headers exceeded 16384 bytes",
    );
    expect(proxySocket.destroyed).toBe(true);
  });

  it("waits for APNs TLS secureConnect before resolving", async () => {
    const proxySocket = new FakeSocket("HTTP/1.1 200 Connection Established\r\n\r\n");
    const targetTlsSocket = new FakeSocket(undefined, { emitSecureConnectOnConnect: false });
    setNextNetSocket(proxySocket);
    setNextTargetTlsSocket(targetTlsSocket);
    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    let resolved = false;
    const tunnel = openHttpConnectTunnel({
      proxyUrl: new URL("http://proxy.example:8080"),
      targetHost: "api.push.apple.com",
      targetPort: 443,
    }).then((socket) => {
      resolved = true;
      return socket;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(resolved).toBe(false);

    targetTlsSocket.emit("secureConnect");

    await expect(tunnel).resolves.toBe(targetTlsSocket);
  });

  it("rejects APNs TLS tunnels that do not negotiate h2", async () => {
    const proxySocket = new FakeSocket("HTTP/1.1 200 Connection Established\r\n\r\n");
    const targetTlsSocket = new FakeSocket(undefined, { alpnProtocol: "http/1.1" });
    setNextNetSocket(proxySocket);
    setNextTargetTlsSocket(targetTlsSocket);
    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    await expect(
      openHttpConnectTunnel({
        proxyUrl: new URL("http://proxy.example:8080"),
        targetHost: "api.push.apple.com",
        targetPort: 443,
      }),
    ).rejects.toThrow(
      "Proxy CONNECT failed via http://proxy.example:8080: APNs TLS tunnel negotiated http/1.1 instead of h2",
    );
    expect(targetTlsSocket.destroyed).toBe(true);
  });

  it("rejects and destroys the proxy socket when CONNECT times out", async () => {
    const proxySocket = new FakeSocket();
    setNextNetSocket(proxySocket);
    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    await expect(
      openHttpConnectTunnel({
        proxyUrl: new URL("http://proxy.example:8080"),
        targetHost: "api.push.apple.com",
        targetPort: 443,
        timeoutMs: 1,
      }),
    ).rejects.toThrow(
      "Proxy CONNECT failed via http://proxy.example:8080: Proxy CONNECT timed out after 1ms",
    );
    expect(proxySocket.destroyed).toBe(true);
  });
});
