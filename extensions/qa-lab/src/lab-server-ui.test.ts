// Qa Lab tests cover lab server ui plugin behavior.
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net, { type NetConnectOpts, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectContentType,
  missingUiHtml,
  proxyUpgradeRequest,
  resolveUiAssetVersion,
  tryResolveUiAsset,
} from "./lab-server-ui.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("qa-lab server ui helpers", () => {
  it("detects basic UI asset content types", () => {
    expect(detectContentType("index.html")).toBe("text/html; charset=utf-8");
    expect(detectContentType("styles.css")).toBe("text/css; charset=utf-8");
    expect(detectContentType("main.js")).toBe("text/javascript; charset=utf-8");
    expect(detectContentType("icon.svg")).toBe("image/svg+xml");
  });

  it("renders the missing-ui placeholder html", () => {
    expect(missingUiHtml()).toContain("QA Lab UI not built");
    expect(missingUiHtml()).toContain("pnpm qa:lab:build");
  });

  it("hashes built UI assets and changes when bundle contents change", async () => {
    const uiDistDir = await mkdtemp(path.join(os.tmpdir(), "qa-lab-ui-dist-"));
    cleanups.push(async () => {
      await rm(uiDistDir, { recursive: true, force: true });
    });
    await writeFile(
      path.join(uiDistDir, "index.html"),
      "<!doctype html><html><head><title>QA Lab</title></head><body><div id='app'></div></body></html>",
      "utf8",
    );

    const version1 = resolveUiAssetVersion(uiDistDir);
    expect(version1).toMatch(/^[0-9a-f]{12}$/);

    await writeFile(
      path.join(uiDistDir, "index.html"),
      "<!doctype html><html><head><title>QA Lab Updated</title></head><body><div id='app'></div></body></html>",
      "utf8",
    );

    const version2 = resolveUiAssetVersion(uiDistDir);
    expect(version2).toMatch(/^[0-9a-f]{12}$/);
    expect(version2).not.toBe(version1);
  });

  it("never resolves sibling files outside the UI dist root", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "qa-lab-ui-boundary-"));
    cleanups.push(async () => {
      await rm(rootDir, { recursive: true, force: true });
    });
    const uiDistDir = path.join(rootDir, "dist");
    const siblingDir = path.join(rootDir, "dist-other");
    await mkdir(uiDistDir, { recursive: true });
    await mkdir(siblingDir, { recursive: true });
    await writeFile(
      path.join(uiDistDir, "index.html"),
      "<!doctype html><html><body>bundle-root</body></html>",
      "utf8",
    );
    await writeFile(path.join(siblingDir, "secret.txt"), "sibling-secret", "utf8");

    expect(tryResolveUiAsset("/", uiDistDir, rootDir)).toBe(path.join(uiDistDir, "index.html"));
    expect(tryResolveUiAsset("/../dist-other/secret.txt", uiDistDir, rootDir)).toBeNull();
  });

  it("rejects malformed percent-encoded UI asset paths", async () => {
    const uiDistDir = await mkdtemp(path.join(os.tmpdir(), "qa-lab-ui-malformed-"));
    cleanups.push(async () => {
      await rm(uiDistDir, { recursive: true, force: true });
    });
    await writeFile(
      path.join(uiDistDir, "index.html"),
      "<!doctype html><html><body>bundle-root</body></html>",
      "utf8",
    );

    expect(tryResolveUiAsset("/%E0%A4", uiDistDir, uiDistDir)).toBeNull();
  });
});

const UPGRADE_RESPONSE = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n\r\n";
const BAD_GATEWAY_RESPONSE = "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n";
const GATEWAY_TIMEOUT_RESPONSE = "HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n";

const TEST_TLS_OPTIONS = {
  ciphers: "aNULL:@SECLEVEL=0",
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.2",
} as const;

function trackServer<T extends Server>(server: T): T {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
  return server;
}

async function listenLoopback(server: Server, host = "127.0.0.1"): Promise<number> {
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("loopback server did not expose a TCP port");
  }
  return address.port;
}

async function openBrowserPair(): Promise<{ browser: Socket; proxySocket: Socket }> {
  let resolveProxySocket!: (socket: Socket) => void;
  const proxySocketPromise = new Promise<Socket>((resolve) => {
    resolveProxySocket = resolve;
  });
  const server = trackServer(
    net.createServer({ allowHalfOpen: true }, (socket) => resolveProxySocket(socket)),
  );
  const port = await listenLoopback(server);
  const browser = net.connect({ host: "127.0.0.1", port });
  await once(browser, "connect");
  const proxySocket = await proxySocketPromise;
  cleanups.push(async () => {
    browser.destroy();
    proxySocket.destroy();
  });
  return { browser, proxySocket };
}

function buildUpgradeRequest() {
  return {
    httpVersion: "1.1",
    method: "GET",
    rawHeaders: ["Host", "ignored.local", "Connection", "Upgrade", "Upgrade", "websocket"],
    url: "/control-ui/socket?client=qa",
  };
}

function runUpgradeProxy(params: { proxySocket: Socket; target: URL }) {
  proxyUpgradeRequest({
    req: buildUpgradeRequest() as never,
    socket: params.proxySocket,
    head: Buffer.alloc(0),
    target: params.target,
  });
}

async function readUntil(socket: Socket, marker: string, timeoutMs = 2_000): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let body = "";
    const timer = setTimeout(() => finish(new Error(`timed out waiting for ${marker}`)), timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) {
        reject(error);
      } else {
        resolve(body);
      }
    };
    const onData = (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.includes(marker)) {
        finish();
      }
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error(`socket closed before ${marker}`));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function readToEnd(socket: Socket, timeoutMs = 2_000): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let body = "";
    const timer = setTimeout(
      () => finish(new Error("timed out waiting for socket end")),
      timeoutMs,
    );
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) {
        reject(error);
      } else {
        resolve(body);
      }
    };
    const onData = (chunk: Buffer) => {
      body += chunk.toString("utf8");
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("socket closed before a clean end"));
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function collectUpgradeRequest(socket: Socket, resolve: (request: string) => void) {
  let request = "";
  socket.on("data", (chunk) => {
    request += chunk.toString("utf8");
    if (!request.includes("\r\n\r\n")) {
      return;
    }
    resolve(request);
    socket.write(UPGRADE_RESPONSE);
  });
}

describe("proxyUpgradeRequest loopback transport", () => {
  it("forwards HTTP upgrades after TCP connect and clears the opening timeout", async () => {
    let resolveRequest!: (request: string) => void;
    const requestPromise = new Promise<string>((resolve) => {
      resolveRequest = resolve;
    });
    const upstreamServer = trackServer(
      net.createServer((socket) => collectUpgradeRequest(socket, resolveRequest)),
    );
    const upstreamPort = await listenLoopback(upstreamServer);
    const { browser, proxySocket } = await openBrowserPair();
    const setTimeoutSpy = vi.spyOn(net.Socket.prototype, "setTimeout");
    const removeListenerSpy = vi.spyOn(net.Socket.prototype, "removeListener");
    const responsePromise = readUntil(browser, "\r\n\r\n");

    runUpgradeProxy({
      proxySocket,
      target: new URL(`http://127.0.0.1:${upstreamPort}`),
    });

    await expect(requestPromise).resolves.toContain("GET /socket?client=qa HTTP/1.1");
    await expect(responsePromise).resolves.toBe(UPGRADE_RESPONSE);
    expect(setTimeoutSpy).toHaveBeenCalledWith(10_000);
    expect(setTimeoutSpy).toHaveBeenCalledWith(0);
    expect(removeListenerSpy.mock.calls.some(([event]) => event === "timeout")).toBe(true);
  });

  it("forwards HTTPS upgrades only after the TLS handshake and clears the opening timeout", async () => {
    const connectTls = tls.connect;
    vi.spyOn(tls, "connect").mockImplementation(((options: tls.ConnectionOptions) =>
      connectTls({
        ...options,
        ...TEST_TLS_OPTIONS,
        rejectUnauthorized: false,
      })) as typeof tls.connect);

    let resolveRequest!: (request: string) => void;
    const requestPromise = new Promise<string>((resolve) => {
      resolveRequest = resolve;
    });
    const upstreamServer = trackServer(
      tls.createServer(TEST_TLS_OPTIONS, (socket) => collectUpgradeRequest(socket, resolveRequest)),
    );
    const upstreamPort = await listenLoopback(upstreamServer, "localhost");
    const { browser, proxySocket } = await openBrowserPair();
    const setTimeoutSpy = vi.spyOn(net.Socket.prototype, "setTimeout");
    const removeListenerSpy = vi.spyOn(net.Socket.prototype, "removeListener");
    const responsePromise = readUntil(browser, "\r\n\r\n");

    runUpgradeProxy({
      proxySocket,
      target: new URL(`https://localhost:${upstreamPort}`),
    });

    await expect(requestPromise).resolves.toContain("GET /socket?client=qa HTTP/1.1");
    await expect(responsePromise).resolves.toBe(UPGRADE_RESPONSE);
    expect(setTimeoutSpy).toHaveBeenCalledWith(10_000);
    expect(setTimeoutSpy).toHaveBeenCalledWith(0);
    expect(removeListenerSpy.mock.calls.some(([event]) => event === "timeout")).toBe(true);
  });

  it("returns a flushed 504 and closes both sockets when TLS stays silent after TCP connect", async () => {
    let resolveUpstream!: (socket: Socket) => void;
    const upstreamPromise = new Promise<Socket>((resolve) => {
      resolveUpstream = resolve;
    });
    const upstreamServer = trackServer(
      net.createServer((socket) => {
        socket.resume();
        resolveUpstream(socket);
      }),
    );
    const upstreamPort = await listenLoopback(upstreamServer, "localhost");
    const { browser, proxySocket } = await openBrowserPair();
    const setTimeoutSpy = vi.spyOn(net.Socket.prototype, "setTimeout");
    const endSpy = vi.spyOn(proxySocket, "end");
    const responsePromise = readToEnd(browser, 14_000);

    runUpgradeProxy({
      proxySocket,
      target: new URL(`https://localhost:${upstreamPort}`),
    });

    const upstreamSocket = await upstreamPromise;
    const upstreamClosed = once(upstreamSocket, "close");
    await expect(responsePromise).resolves.toBe(GATEWAY_TIMEOUT_RESPONSE);
    await upstreamClosed;
    expect(setTimeoutSpy).toHaveBeenCalledWith(10_000);
    expect(endSpy).toHaveBeenCalledWith(GATEWAY_TIMEOUT_RESPONSE, expect.any(Function));
    expect(upstreamSocket.destroyed).toBe(true);
    expect(proxySocket.destroyed).toBe(true);
  }, 16_000);

  it("closes a connecting upstream exactly once when the browser sends EOF", async () => {
    const upstreamServer = trackServer(net.createServer());
    const upstreamPort = await listenLoopback(upstreamServer);
    const { browser, proxySocket } = await openBrowserPair();
    const upstream = new net.Socket();
    const destroySpy = vi.spyOn(upstream, "destroy");
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    vi.spyOn(net, "connect").mockImplementationOnce(((options: NetConnectOpts) => {
      connectTimer = setTimeout(() => {
        if (!upstream.destroyed) {
          upstream.connect(options);
        }
      }, 50);
      return upstream;
    }) as typeof net.connect);
    cleanups.push(async () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
      }
      upstream.destroy();
    });
    const proxyEnded = once(proxySocket, "end");

    runUpgradeProxy({
      proxySocket,
      target: new URL(`http://127.0.0.1:${upstreamPort}`),
    });
    browser.end();

    await proxyEnded;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it("returns a flushed 502 when the upstream resets before its upgrade response", async () => {
    const upstreamServer = trackServer(
      net.createServer((socket) => {
        socket.once("data", () => socket.resetAndDestroy());
      }),
    );
    const upstreamPort = await listenLoopback(upstreamServer);
    const { browser, proxySocket } = await openBrowserPair();
    const endSpy = vi.spyOn(proxySocket, "end");
    const responsePromise = readToEnd(browser);

    runUpgradeProxy({
      proxySocket,
      target: new URL(`http://127.0.0.1:${upstreamPort}`),
    });

    await expect(responsePromise).resolves.toBe(BAD_GATEWAY_RESPONSE);
    expect(endSpy).toHaveBeenCalledWith(BAD_GATEWAY_RESPONSE, expect.any(Function));
    expect(proxySocket.destroyed).toBe(true);
  });

  it("returns a flushed 502 when the upstream connection is refused", async () => {
    const refusedServer = net.createServer();
    const refusedPort = await listenLoopback(refusedServer);
    await new Promise<void>((resolve) => {
      refusedServer.close(() => resolve());
    });
    const { browser, proxySocket } = await openBrowserPair();
    const endSpy = vi.spyOn(proxySocket, "end");
    const responsePromise = readToEnd(browser);

    runUpgradeProxy({
      proxySocket,
      target: new URL(`http://127.0.0.1:${refusedPort}`),
    });

    await expect(responsePromise).resolves.toBe(BAD_GATEWAY_RESPONSE);
    expect(endSpy).toHaveBeenCalledWith(BAD_GATEWAY_RESPONSE, expect.any(Function));
    expect(proxySocket.destroyed).toBe(true);
  });
});
