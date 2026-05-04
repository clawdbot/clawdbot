import * as net from "node:net";
import * as tls from "node:tls";

export type HttpConnectTunnelParams = {
  proxyUrl: URL;
  targetHost: string;
  targetPort: number;
  timeoutMs?: number;
};

const MAX_CONNECT_RESPONSE_HEADER_BYTES = 16 * 1024;

type ProxySocket = net.Socket | tls.TLSSocket;
type ConnectResponseBuffer = Buffer;

type ProxyConnectReadResult =
  | {
      kind: "incomplete";
      responseBuffer: ConnectResponseBuffer;
    }
  | {
      kind: "complete";
      responseBuffer: ConnectResponseBuffer;
      statusLine: string;
      tunneledBytes: ConnectResponseBuffer | undefined;
    };

function redactProxyUrl(proxyUrl: URL): string {
  try {
    return proxyUrl.origin;
  } catch {
    return "<invalid proxy URL>";
  }
}

function resolveProxyHost(proxy: URL): string {
  return (proxy.hostname || proxy.host).replace(/^\[|\]$/g, "");
}

function resolveProxyPort(proxy: URL): number {
  if (proxy.port) {
    return Number(proxy.port);
  }
  return proxy.protocol === "https:" ? 443 : 80;
}

function resolveProxyAuthorization(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) {
    return undefined;
  }
  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function formatTunnelFailure(proxyUrl: URL, err: unknown): Error {
  return new Error(
    `Proxy CONNECT failed via ${redactProxyUrl(proxyUrl)}: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
}

function writeConnectRequest(socket: net.Socket, proxy: URL, target: string): void {
  const headers = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`, "Proxy-Connection: Keep-Alive"];
  const authorization = resolveProxyAuthorization(proxy);
  if (authorization) {
    headers.push(`Proxy-Authorization: ${authorization}`);
  }
  socket.write([...headers, "", ""].join("\r\n"));
}

function assertConnectHeaderBytesWithinLimit(size: number): void {
  if (size > MAX_CONNECT_RESPONSE_HEADER_BYTES) {
    throw new Error(
      `Proxy CONNECT response headers exceeded ${MAX_CONNECT_RESPONSE_HEADER_BYTES} bytes`,
    );
  }
}

function readProxyConnectResponse(
  responseBuffer: ConnectResponseBuffer,
  chunk: ConnectResponseBuffer,
): ProxyConnectReadResult {
  const nextBuffer = Buffer.concat([responseBuffer, chunk]);
  const headerEnd = nextBuffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    assertConnectHeaderBytesWithinLimit(nextBuffer.length);
    return { kind: "incomplete", responseBuffer: nextBuffer };
  }

  const bodyOffset = headerEnd + 4;
  assertConnectHeaderBytesWithinLimit(bodyOffset);

  const responseHeader = nextBuffer.subarray(0, bodyOffset).toString("latin1");
  const statusLine = responseHeader.split("\r\n", 1)[0] ?? "";
  const tunneledBytes =
    nextBuffer.length > bodyOffset ? nextBuffer.subarray(bodyOffset) : undefined;
  return {
    kind: "complete",
    responseBuffer: nextBuffer,
    statusLine,
    tunneledBytes,
  };
}

function isSuccessfulConnectStatusLine(statusLine: string): boolean {
  return /^HTTP\/1\.[01] 2\d\d\b/.test(statusLine);
}

function connectToProxy(proxy: URL): ProxySocket {
  const proxyHost = resolveProxyHost(proxy);
  const connectOptions = {
    host: proxyHost,
    port: resolveProxyPort(proxy),
  };
  if (proxy.protocol === "https:") {
    return tls.connect({
      ...connectOptions,
      servername: proxyHost,
      ALPNProtocols: ["http/1.1"],
    });
  }
  return net.connect(connectOptions);
}

class HttpConnectTunnelAttempt {
  private proxySocket: ProxySocket | undefined;
  private targetTlsSocket: tls.TLSSocket | undefined;
  private timeout: NodeJS.Timeout | undefined;
  private settled = false;
  private responseBuffer: ConnectResponseBuffer = Buffer.alloc(0);

  constructor(
    private readonly params: HttpConnectTunnelParams,
    private readonly proxy: URL,
    private readonly resolve: (socket: tls.TLSSocket) => void,
    private readonly reject: (reason?: unknown) => void,
  ) {}

  public start(): void {
    try {
      this.startTimeout();
      this.proxySocket = connectToProxy(this.proxy);
      this.proxySocket.once(
        this.proxy.protocol === "https:" ? "secureConnect" : "connect",
        this.onProxyConnected,
      );
      this.proxySocket.on("data", this.onProxyData);
      this.proxySocket.once("end", this.onProxyClosedBeforeConnect);
      this.proxySocket.once("error", this.fail);
      this.proxySocket.once("close", this.onProxyClosedBeforeConnect);
    } catch (err) {
      this.fail(err);
    }
  }

  private startTimeout(): void {
    const timeoutMs = this.params.timeoutMs;
    if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      this.timeout = setTimeout(() => {
        this.fail(new Error(`Proxy CONNECT timed out after ${Math.trunc(timeoutMs)}ms`));
      }, Math.trunc(timeoutMs));
    }
  }

  private clearTimer(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
  }

  private cleanupProxyListeners(): void {
    const socket = this.proxySocket;
    if (!socket) {
      return;
    }
    socket.off("data", this.onProxyData);
    socket.off("end", this.onProxyClosedBeforeConnect);
    socket.off("error", this.fail);
    socket.off("close", this.onProxyClosedBeforeConnect);
    socket.off("connect", this.onProxyConnected);
    socket.off("secureConnect", this.onProxyConnected);
  }

  private cleanupTargetTlsListeners(): void {
    const socket = this.targetTlsSocket;
    if (!socket) {
      return;
    }
    socket.off("secureConnect", this.onTargetSecureConnect);
    socket.off("error", this.fail);
    socket.off("close", this.onTargetTlsClosedBeforeSecureConnect);
  }

  private readonly fail = (err: unknown): void => {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.clearTimer();
    this.cleanupProxyListeners();
    this.cleanupTargetTlsListeners();
    this.targetTlsSocket?.destroy();
    this.proxySocket?.destroy();
    this.reject(formatTunnelFailure(this.params.proxyUrl, err));
  };

  private succeed(socket: tls.TLSSocket): void {
    if (this.settled) {
      socket.destroy();
      return;
    }
    this.settled = true;
    this.clearTimer();
    this.cleanupProxyListeners();
    this.cleanupTargetTlsListeners();
    this.resolve(socket);
  }

  private readonly onProxyConnected = (): void => {
    const socket = this.proxySocket;
    if (!socket) {
      this.fail(new Error("Proxy socket missing after connect"));
      return;
    }
    const target = `${this.params.targetHost}:${this.params.targetPort}`;
    try {
      writeConnectRequest(socket, this.proxy, target);
    } catch (err) {
      this.fail(err);
    }
  };

  private readonly onProxyData = (chunk: Buffer): void => {
    let result: ProxyConnectReadResult;
    try {
      result = readProxyConnectResponse(this.responseBuffer, chunk);
    } catch (err) {
      this.fail(err);
      return;
    }

    this.responseBuffer = result.responseBuffer;
    if (result.kind === "incomplete") {
      return;
    }

    const socket = this.proxySocket;
    if (!socket) {
      this.fail(new Error("Proxy socket missing after CONNECT response"));
      return;
    }
    if (result.tunneledBytes) {
      socket.unshift(result.tunneledBytes);
    }
    if (!isSuccessfulConnectStatusLine(result.statusLine)) {
      this.fail(new Error(result.statusLine || "Proxy returned an invalid CONNECT response"));
      return;
    }

    this.cleanupProxyListeners();
    this.startTargetTls(socket);
  };

  private startTargetTls(socket: ProxySocket): void {
    try {
      this.targetTlsSocket = tls.connect({
        socket,
        servername: this.params.targetHost,
        ALPNProtocols: ["h2"],
      });
      this.targetTlsSocket.once("secureConnect", this.onTargetSecureConnect);
      this.targetTlsSocket.once("error", this.fail);
      this.targetTlsSocket.once("close", this.onTargetTlsClosedBeforeSecureConnect);
    } catch (err) {
      this.fail(err);
    }
  }

  private readonly onTargetSecureConnect = (): void => {
    const socket = this.targetTlsSocket;
    if (!socket) {
      this.fail(new Error("APNs TLS socket missing after secureConnect"));
      return;
    }
    if (socket.alpnProtocol !== "h2") {
      const negotiated = socket.alpnProtocol || "no ALPN protocol";
      this.fail(new Error(`APNs TLS tunnel negotiated ${negotiated} instead of h2`));
      return;
    }
    this.succeed(socket);
  };

  private readonly onTargetTlsClosedBeforeSecureConnect = (): void => {
    this.fail(new Error("APNs TLS tunnel closed before secureConnect"));
  };

  private readonly onProxyClosedBeforeConnect = (): void => {
    this.fail(new Error("Proxy closed before CONNECT response"));
  };
}

export async function openHttpConnectTunnel(
  params: HttpConnectTunnelParams,
): Promise<tls.TLSSocket> {
  const proxy = new URL(params.proxyUrl.href);
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
    throw new Error(`Unsupported proxy protocol for APNs HTTP/2 CONNECT tunnel: ${proxy.protocol}`);
  }

  return await new Promise<tls.TLSSocket>((resolve, reject) => {
    new HttpConnectTunnelAttempt(params, proxy, resolve, reject).start();
  });
}
